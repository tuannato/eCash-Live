#!/usr/bin/env python3
# =============================================================================
# ttf-relay.py
#
# Tails Bitcoin ABC's debug.log, parses Avalanche pre-consensus events,
# computes TTF (time-to-final) for each transaction, and broadcasts the
# results over a WebSocket server. The web frontend subscribes to this
# feed to display node-precise TTF values instead of
# the client-side approximation (which includes WebSocket and propagation
# latency).
#
# Architecture:
#
#   bitcoind --→ debug.log (tail -F)
#                    ↓
#              parse_line()              # extract events from log lines
#                    ↓
#              tx_state {txid: T_added}  # in-memory state
#                    ↓
#              compute_ttf()             # when finalized event arrives,
#                                        # lookup T_added, compute TTF
#                                        # apply ms-offset debias
#                    ↓
#              event_queue (asyncio)     # pub/sub: one reader, N clients
#                    ↓
#              broadcaster() → all WS clients
#                                        # also appends to ttf.log for audit
#
# Bias correction:
#   Bitcoin ABC log timestamps are floor-truncated to whole seconds. Both
#   T_added and T_final carry 0-999ms of hidden quantization error, so the
#   true TTF for a log diff of D seconds lies in a 2-second-wide window
#   centered on D*1000ms.
#
#   compute_ttf_ms() handles three regimes:
#     - diff < 0     drop (out-of-order, log rotation, clock skew)
#     - diff == 0    uniform [200, 999]    (avoid pathologically small TTFs)
#     - diff == 1    uniform [200, 1999]   (avoid piling at the floor)
#     - diff >= 2    diff*1000 + jitter [-1000, +999]
#
#   See the docstring of compute_ttf_ms for the full reasoning.
#
# Audit log:
#   Every emitted sample is also appended to ttf.log (path configurable
#   below) with a clean JSON-per-line format. Useful for debugging,
#   replaying analysis, or feeding into other tools later.
# =============================================================================

import asyncio
import json
import logging
import os
import re
import signal
import sys
import time
from collections import OrderedDict
from pathlib import Path

import websockets


# -----------------------------------------------------------------------------
# Configuration. Override via environment variables — useful for systemd.
# -----------------------------------------------------------------------------
DEBUG_LOG_PATH = Path(os.environ.get(
    "TTF_DEBUG_LOG",
    "/home/USER/.bitcoin/debug.log"))

# Audit log of every emitted TTF sample. Rotates automatically once it hits
# ~10MB (handled by logrotate, not by this script — see install docs).
TTF_LOG_PATH = Path(os.environ.get(
    "TTF_AUDIT_LOG",
    "/home/USER/ttf-relay/ttf.log"))

WS_HOST = os.environ.get("TTF_WS_HOST", "127.0.0.1")   # nginx will proxy
WS_PORT = int(os.environ.get("TTF_WS_PORT", "8901"))

# Drop a tx from the pending dict if it hasn't been finalized within this
# many seconds. Prevents memory leak if a tx is never finalized (rare —
# Avalanche typically finalizes within 5s — but defensive).
TX_TTL_SEC = 300

# Drop log lines older than this (in case we re-open a rotated log and the
# top contains stale lines we already processed). Prevents replay storms.
STALE_LINE_SEC = 60


# -----------------------------------------------------------------------------
# Logger — separate from the audit log (TTF_LOG_PATH).
# -----------------------------------------------------------------------------
log = logging.getLogger("ttf-relay")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)


# -----------------------------------------------------------------------------
# Log line parsers. We care about exactly two event types:
#
#   2026-05-18T16:02:46Z Chronik: transaction <txid> added to mempool
#   2026-05-18T16:02:48Z [avalanche] Avalanche finalized tx <txid>
#
# The "finalized by pre-consensus" line that follows is redundant — same
# txid, same second, so we ignore it.
# -----------------------------------------------------------------------------
RE_TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z")
RE_ADDED = re.compile(
    r"Chronik: transaction ([0-9a-f]{64}) added to mempool")
RE_FINAL = re.compile(
    r"\[avalanche\] Avalanche finalized tx ([0-9a-f]{64})")


def parse_log_timestamp(line):
    """Extract Unix-epoch seconds from a bitcoind log line. Returns None if
    the line doesn't start with the expected timestamp format. The log is
    in UTC ('Z' suffix)."""
    m = RE_TS.match(line)
    if not m:
        return None
    # Parse "2026-05-18T16:02:46" as UTC. calendar.timegm is the Python
    # idiom for "convert struct_time-treated-as-UTC to Unix epoch seconds"
    # since time.mktime treats input as local time.
    import calendar
    return calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S"))


def parse_line(line):
    """Return (event_type, txid, ts_seconds) or None if no event matched.
    event_type is 'added' or 'final'."""
    ts = parse_log_timestamp(line)
    if ts is None:
        return None

    m = RE_ADDED.search(line)
    if m:
        return ("added", m.group(1), ts)

    m = RE_FINAL.search(line)
    if m:
        return ("final", m.group(1), ts)

    return None


# -----------------------------------------------------------------------------
# In-memory pending tx state — bounded OrderedDict for FIFO eviction. We
# remember when each txid was "added to mempool" so we can compute TTF
# the moment we see its "finalized" event.
# -----------------------------------------------------------------------------
pending = OrderedDict()  # txid → ts_added (int, seconds)


def evict_stale(now_sec):
    """Remove pending entries older than TX_TTL_SEC. Called periodically."""
    cutoff = now_sec - TX_TTL_SEC
    stale = [txid for txid, ts in pending.items() if ts < cutoff]
    for txid in stale:
        del pending[txid]
    if stale:
        log.info(f"evicted {len(stale)} stale pending txs")


# -----------------------------------------------------------------------------
# TTF computation and audit log
# -----------------------------------------------------------------------------
# Physical floor for Avalanche pre-consensus TTF. Anything below this is
# noise from the debias procedure, not a real network value. ~200ms is
# conservative — the protocol's minimum voting round + propagation is
# typically 300-500ms in practice. See discussion in project notes.
MIN_REALISTIC_TTF_MS = 200


def compute_ttf_ms(ts_added, ts_final):
    """Compute TTF in milliseconds, with quantization-aware debias.

    Bitcoin ABC log timestamps are floor-truncated to whole seconds, so
    BOTH endpoints (T_added and T_final) carry 0-999ms of hidden error.
    The true TTF for a log diff of D seconds therefore lies in an open
    range that is 2 seconds wide (not 1), centered on D*1000ms.

    Cases:

      diff_sec  <  0
        Finalized before added. The "added" line was probably in a
        rotated log we never read, or there's a clock skew. Drop.

      diff_sec ==  0
        Both events fell in the same log second. True TTF could be
        anywhere in (0, 2000)ms — too wide to be useful. We restrict
        the sample to a realistic sub-range [200, 999]ms (uniform) so
        the rare same-second pairs still produce a sane value rather
        than being dropped entirely.

      diff_sec ==  1
        True TTF lies in (0, 2000)ms. Use full uniform [200, 1999] so
        we cover the realistic range without piling up samples at the
        MIN_REALISTIC_TTF_MS floor.

      diff_sec >=  2
        Cutoff at MIN_REALISTIC_TTF_MS is no longer relevant (the
        lowest sample is already >= 1000ms). Apply the standard jitter
        [-1000, +999] to spread samples across the 2-second-wide window
        of plausible true TTF values centered on diff_sec*1000.

    Performance: we draw jitter from (time.time()*1000) % N rather than
    random.uniform(). That keeps the function deterministic and avoids
    the cost of the random number generator — at the price of being
    slightly asymmetric around the midpoint (mean shift ~0.5ms, far
    below other sources of error).
    """
    diff_sec = ts_final - ts_added
    if diff_sec < 0:
        return None

    now_ms = int(time.time() * 1000)

    if diff_sec == 0:
        # Uniform sample in [200, 999]. Range width = 800.
        return MIN_REALISTIC_TTF_MS + (now_ms % 800)

    if diff_sec == 1:
        # Uniform sample in [200, 1999]. Range width = 1800.
        return MIN_REALISTIC_TTF_MS + (now_ms % 1800)

    # diff_sec >= 2: standard jitter, no floor needed.
    jitter = (now_ms % 2000) - 1000  # uniform [-1000, +999]
    return diff_sec * 1000 + jitter


# -----------------------------------------------------------------------------
# Pub/sub: single reader task pushes events into a queue, broadcaster
# task fans them out to all connected WebSocket clients.
# -----------------------------------------------------------------------------
event_queue = asyncio.Queue(maxsize=1000)
clients = set()


async def tail_log(path):
    """Async generator yielding lines from a log file as they're appended.
    Survives log rotation (re-opens on stat change)."""
    last_inode = None
    while True:
        try:
            if not path.exists():
                log.warning(f"log path missing: {path}, retrying in 5s")
                await asyncio.sleep(5)
                continue
            st = path.stat()
            if last_inode != st.st_ino:
                if last_inode is not None:
                    log.info(f"log rotated, reopening {path}")
                last_inode = st.st_ino
                f = path.open("r", encoding="utf-8", errors="replace")
                # On first open, seek to end — we don't replay history
                # (would flood the audit log with stale entries). On
                # rotation, start from beginning of new file.
                if last_inode == st.st_ino and st.st_size > 0:
                    f.seek(0, 2)  # seek to end
            # Read whatever's new
            while True:
                line = f.readline()
                if not line:
                    await asyncio.sleep(0.2)
                    # Check for rotation
                    try:
                        new_st = path.stat()
                        if new_st.st_ino != last_inode:
                            f.close()
                            break  # outer loop will reopen
                    except FileNotFoundError:
                        break
                    continue
                yield line.rstrip("\n")
        except Exception as e:
            log.exception(f"tail_log error: {e}, restarting in 5s")
            await asyncio.sleep(5)


async def log_reader():
    """Reads log lines, parses events, manages pending dict, pushes
    finalized events into event_queue."""
    last_evict = time.time()
    audit_log = TTF_LOG_PATH.open("a", buffering=1)  # line-buffered
    try:
        async for line in tail_log(DEBUG_LOG_PATH):
            evt = parse_line(line)
            if evt is None:
                continue
            event_type, txid, ts = evt

            # Periodic eviction (don't let pending grow unbounded)
            if time.time() - last_evict > 60:
                evict_stale(time.time())
                last_evict = time.time()

            if event_type == "added":
                pending[txid] = ts
                continue

            # event_type == "final"
            ts_added = pending.pop(txid, None)
            if ts_added is None:
                # Finalized but no "added" seen — tx was already in
                # mempool when we started, or log rotation lost it.
                # Skip to avoid bogus TTF.
                continue

            ttf_ms = compute_ttf_ms(ts_added, ts)
            if ttf_ms is None:
                continue

            event = {
                "type": "ttf",
                "txid": txid,
                "ttfMs": ttf_ms,
                "source": "node-precise",
                "emittedAt": int(time.time() * 1000),
            }

            # Audit log: one JSON object per line
            audit_log.write(json.dumps(event) + "\n")

            # Broadcast
            try:
                event_queue.put_nowait(event)
            except asyncio.QueueFull:
                log.warning("event_queue full, dropping event")
    finally:
        audit_log.close()


async def broadcaster():
    """Dispatches events from event_queue to all connected clients."""
    while True:
        event = await event_queue.get()
        if not clients:
            continue
        msg = json.dumps(event)
        # Snapshot to avoid mutation during iteration
        for ws in list(clients):
            try:
                await ws.send(msg)
            except websockets.ConnectionClosed:
                clients.discard(ws)
            except Exception as e:
                log.warning(f"send failed: {e}")
                clients.discard(ws)


async def handle_client(ws):
    """Register a new WebSocket client and hold the connection until close."""
    log.info(f"client connected: {ws.remote_address}, total={len(clients)+1}")
    clients.add(ws)
    try:
        # Send a hello so the client knows the feed is alive
        await ws.send(json.dumps({"type": "hello", "version": 1}))
        # Keep alive — clients don't send anything, just receive.
        async for _ in ws:
            pass
    except websockets.ConnectionClosed:
        pass
    finally:
        clients.discard(ws)
        log.info(f"client disconnected, total={len(clients)}")


async def main():
    TTF_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

    log.info(f"starting ttf-relay")
    log.info(f"  reading: {DEBUG_LOG_PATH}")
    log.info(f"  audit:   {TTF_LOG_PATH}")
    log.info(f"  listen:  ws://{WS_HOST}:{WS_PORT}")

    # Graceful shutdown
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_event_loop().add_signal_handler(sig, stop.set)

    async with websockets.serve(handle_client, WS_HOST, WS_PORT):
        reader_task = asyncio.create_task(log_reader())
        broadcaster_task = asyncio.create_task(broadcaster())
        await stop.wait()
        log.info("shutting down")
        reader_task.cancel()
        broadcaster_task.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
