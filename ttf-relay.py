# =============================================================================
# ttf-relay.py v1.5.2
#
# Tails Bitcoin ABC's debug.log, parses Avalanche pre-consensus events,
# computes TTF (time-to-final) for each transaction, and broadcasts the
# results over a WebSocket server. The web frontend at ecashlive.net
# subscribes to this feed to display node-precise TTF values instead of
# the client-side approximation (which includes WebSocket and propagation
# latency).
#
# v1.5.2 changes:
#   1. TTF daily rollup. At 00:02 UTC each day, the relay reads the prior
#      day's lines from ttf.log audit and writes a one-line JSONL summary
#      to ttf-daily.jsonl: samples, TPS, mean, p10/50/90, min, max.
#      ~150B/day = <1MB after a decade. Enables /ecashlive_status month/year
#      with TTF history. Self-healing back-fill on startup.
#   2. Restored WS traffic logging (was present in v1.4, lost during
#      v1.5 / v1.5.1 patches). Every connect/disconnect → ws-traffic.log
#      with sha256(daily_salt || ip)[:16]. Raw IPs never on disk.
#
# v1.5.1 change: persisted ring carries a `hist_lo_ms` sentinel; load_json
# starts fresh whenever _HIST_LO_MS differs from the value on disk. In v1.5
# (and earlier), changing _HIST_LO_MS would silently corrupt percentiles —
# bin counts on disk meant ranges based on the OLD floor, but were
# interpreted with the NEW floor, mixing two distributions in the same ring.
# Mean stayed correct (it uses ttf_sum/count, not bins) which made the
# corruption hard to spot. This sentinel makes any future floor change
# self-healing: one 24h refill, then back to a clean ring.
#
# v1.5 change: _hist_percentile() now does linear interpolation WITHIN the
# bin containing the target sample, instead of returning the bin's upper
# edge. The previous upper-edge method introduced a fixed +3-10% bias (it
# always rounded a percentile up to the bin ceiling); the new method places
# the percentile proportionally between lower and upper edge based on how
# many samples fall before it within the bin. Same O(bins) cost, same
# counts on disk — only the snapshot-time formula changes. Persisted ring
# is unchanged, no migration needed; first stats frame after restart will
# read 3-10% lower (closer to truth) on the same underlying data. Verified
# against a synthetic dataset matching live traffic (mean ~4.5s, 1800
# samples): P10/P50/P90 errors shrank from +218/+174/+544ms to <+50ms each.
#
# v1.4 changes:
#   1. WS traffic log. Every client connect/disconnect is appended to
#      ws-traffic.log (line-JSON) with a privacy-preserving identifier:
#      sha256(daily_salt || remote_ip)[:16]. The salt regenerates at UTC
#      midnight, so unique-visitor counts work intra-day but cannot be
#      linked across days. Raw IPs never touch disk. Consumed by the
#      Telegram bot's /ecashlive_status command.
#   2. P10 histogram fix. _HIST_LO_MS raised 200 → 1000 so the floor bin
#      sits below — not above — the protocol's ~1.34s theoretical
#      minimum. Without this the P10 percentile resolved to a bin upper
#      edge well below the physical floor (a histogram artifact, not a
#      real reading). The persisted ring detects this geometry change
#      via load_json and starts fresh; 24h refill, no migration needed.
#
# v1.3 change: stats frame now emits `ttfP10Ms` in addition to P50/P90/mean.
# Rationale: P10 sits near the protocol's 1.34s theoretical floor (134 polls
# × 10ms event loop) and is the strongest "how close real traffic gets to the
# floor" number to publish. Together P10/P50/P90 describe floor/typical/tail
# — full distribution shape, no number hidden. No schema break: existing
# clients ignore the new field, persisted ring (ttf-stats.json) is unchanged.
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
#                                        # lookup T_added, compute TTF as an
#                                        # honest microsecond subtraction
#                    ↓
#              event_queue (asyncio)     # pub/sub: one reader, N clients
#                    ↓
#              broadcaster() → all WS clients
#                                        # also appends to ttf.log for audit
#
# Precision (v1.2):
#   bitcoind runs with logtimemicros=1, so every debug.log timestamp carries a
#   6-digit microsecond fraction (…T16:02:46.123456Z). Both T_added and T_final
#   are read at that resolution, so TTF is now a direct, honest subtraction —
#   no quantization, no synthetic jitter. This replaces the v1.1 "debias"
#   machinery, which fabricated a sub-second value to paper over whole-second
#   log timestamps (mean error ~420ms measured on live traffic before the
#   switch — see ttf-compare.py).
#
#   compute_ttf_ms() is therefore trivial: (T_final − T_added) in ms. The only
#   value it drops is a negative diff (out-of-order lines, log rotation, clock
#   skew). Per design decision, we emit the raw precise value with no low floor
#   (option b): a sub-second-implausible reading is preferable to a fabricated
#   "realistic" one, and the histogram/percentiles absorb the rare outlier.
#
#   RE_TS still matches the OLD whole-second format too (the µs fraction is an
#   optional group), so the relay degrades gracefully if logtimemicros is ever
#   turned back off — it just loses sub-second resolution, it doesn't break.
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
    "/home/mikazuki/.bitcoin/debug.log"))

# Audit log of every emitted TTF sample. Rotates automatically once it hits
# ~10MB (handled by logrotate, not by this script — see install docs).
TTF_LOG_PATH = Path(os.environ.get(
    "TTF_AUDIT_LOG",
    "/home/mikazuki/ttf-relay/ttf.log"))

# Daily rollup of TTF/TPS stats (v1.5.2). One JSONL line per UTC day, written
# at 00:02 UTC. Schema: date, samples, tps, ttf_{mean,p10,p50,p90,min,max}_ms.
# Built by re-reading the prior day's lines from ttf.log audit, so it's
# self-healing: if a midnight is missed, next run back-fills the gap from
# audit data still on disk. Cost: ~150 bytes/day = ~55KB/year. Feeds the
# bot's /ecashlive_status month/year window with real TTF history.
TTF_DAILY_LOG_PATH = Path(os.environ.get(
    "TTF_DAILY_LOG",
    "/home/mikazuki/ttf-relay/ttf-daily.jsonl"))

# WS traffic log (v1.4 / restored in v1.5.2). One JSON line per
# connect/disconnect. The bot's /ecashlive_status command parses this. We log
# a hashed IP, never the raw address — the salt regenerates at UTC midnight
# (see _ws_ip_hash), so the log supports intra-day unique counts but cannot
# be cross-day linked.
WS_TRAFFIC_LOG_PATH = Path(os.environ.get(
    "TTF_WS_TRAFFIC_LOG",
    "/home/mikazuki/ttf-relay/ws-traffic.log"))

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
# Stats-ring configuration (v1.2.5).
#
# We expose a rolling 24h aggregate of TPS and TTF to the frontend bottom bar.
# A raw 24h deque of every finalized tx would scale with TPS (hundreds of
# thousands of entries at sustained load) — violating our "constant memory
# regardless of TPS" rule. Instead we keep a FIXED ring of short time buckets
# and accumulate counters per bucket. Memory is then bounded by the bucket
# count, NOT by throughput: O(1) per tx, O(buckets) per broadcast.
#
# 10s buckets over 24h = 8640 slots. The window slides one bucket every 10s,
# so the 24h figure rolls off continuously (1/8640th per step) instead of
# dropping a block of history at once. At broadcast we additionally apply
# fractional edge weighting to the oldest partial bucket so the 24h total is
# perfectly continuous rather than stepping every 10s.
STATS_BUCKET_SEC = 10
STATS_WINDOW_SEC = 86_400                       # 24h
STATS_RING_BUCKETS = STATS_WINDOW_SEC // STATS_BUCKET_SEC   # 8640

# How often we broadcast a fresh `stats` frame to all clients. 5s reads as
# ~live in the bar while costing one tiny JSON fan-out per interval.
STATS_BROADCAST_SEC = 5

# How often we persist the ring to disk. A 24h stat is fragile across relay
# restarts (deploys, reboots) — without persistence the bar would read empty
# for up to 24h after every restart while the ring refills. One small write
# per minute is negligible disk I/O and makes restarts seamless.
STATS_PERSIST_SEC = 60
STATS_PERSIST_PATH = Path(os.environ.get(
    "TTF_STATS_PATH",
    "/home/mikazuki/ttf-relay/ttf-stats.json"))

# Histogram bins for percentile (p50/p90) estimation. We can't store every
# raw TTF value (would scale with TPS), so each bucket keeps a small fixed
# histogram and we derive percentiles by merging histograms at broadcast.
# Log-spaced 200ms .. 60s matches the realistic TTF range (the protocol floor
# is ~1.34s — 128 rounds at the 10ms event-loop cadence — so the 200ms low
# edge already sits comfortably below any plausible reading) and gives fine
# resolution where it matters (the 1-3s mode) without wasting bins on the
# long tail. Precise values below the low edge fall in bin 0; that's fine.
import math as _math
_HIST_LO_MS = 200
_HIST_HI_MS = 60_000
_HIST_BIN_COUNT = 40
# Precompute log-spaced upper edges once. bin index for a value is found by
# bisect over these edges — O(log bins), trivial.
_HIST_EDGES = [
    _HIST_LO_MS * (_HIST_HI_MS / _HIST_LO_MS) ** (i / _HIST_BIN_COUNT)
    for i in range(1, _HIST_BIN_COUNT + 1)
]


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
# Log line parsers. We care about exactly two event types (shown here with the
# logtimemicros=1 microsecond fraction):
#
#   2026-05-18T16:02:46.502431Z Chronik: transaction <txid> added to mempool
#   2026-05-18T16:02:48.913004Z [avalanche] Avalanche finalized tx <txid>
#
# The "finalized by pre-consensus" line that follows is redundant — same
# txid, same instant, so we ignore it.
# -----------------------------------------------------------------------------
# The .NNNNNN fraction is an OPTIONAL capture group so this same regex also
# matches the legacy whole-second format (logtimemicros off). m.group(2) is
# None in that case and parse_log_timestamp falls back to integer seconds.
RE_TS = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z")
RE_ADDED = re.compile(
    r"Chronik: transaction ([0-9a-f]{64}) added to mempool")
RE_FINAL = re.compile(
    r"\[avalanche\] Avalanche finalized tx ([0-9a-f]{64})")


def parse_log_timestamp(line):
    """Extract Unix-epoch seconds from a bitcoind log line as a float carrying
    the microsecond fraction. Returns None if the line doesn't start with the
    expected timestamp format. The log is in UTC ('Z' suffix).

    Defensive on both formats (migration-legacy): if logtimemicros is off the
    fraction group is absent and we return whole seconds as a float, so
    downstream arithmetic is identical — it just loses sub-second resolution."""
    m = RE_TS.match(line)
    if not m:
        return None
    # Parse "2026-05-18T16:02:46" as UTC. calendar.timegm is the Python
    # idiom for "convert struct_time-treated-as-UTC to Unix epoch seconds"
    # since time.mktime treats input as local time.
    import calendar
    base = calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S"))
    frac = m.group(2)
    if frac is None:
        return float(base)
    # Right-pad to 6 digits so a short fraction scales correctly ("123" is
    # 123000us, not 123us). ABC always emits 6 digits; stay defensive anyway.
    return base + int(frac.ljust(6, "0")) / 1_000_000.0


def parse_line(line):
    """Return (event_type, txid, ts_seconds_float) or None if no event matched.
    event_type is 'added' or 'final'. ts carries the microsecond fraction."""
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
pending = OrderedDict()  # txid → ts_added (float, seconds w/ us fraction)


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
def compute_ttf_ms(ts_added, ts_final):
    """Compute TTF in milliseconds as an honest microsecond subtraction.

    With logtimemicros=1 both timestamps already carry sub-second resolution
    (see the "Precision" note in the file header), so there is nothing to
    debias — TTF is simply the elapsed wall-clock between the two log events.

    Option (b), per design decision: emit the RAW precise value; the only thing
    we drop is a negative diff. A negative means the "added" line came after the
    "finalized" line in epoch terms — out-of-order reads, a rotated log we
    joined mid-stream, or clock skew — none of which yield a meaningful TTF.

    We deliberately do NOT impose a low floor. The protocol floor is ~1.34s
    (128 rounds at the 10ms event loop), so a sub-second reading is physically
    implausible and, if it ever appears, is more useful surfaced as a real
    outlier than silently rewritten to a "realistic" number. The 24h
    histogram/percentiles absorb the occasional outlier without distortion.

    Returns a float rounded to 0.1ms. Sub-ms precision is not claimed —
    measurement/scheduling noise dominates well above the log's us resolution —
    but 0.1ms keeps the value clean for the audit log and the frontend.
    """
    diff_sec = ts_final - ts_added
    if diff_sec < 0:
        return None
    return round(diff_sec * 1000.0, 1)


def _hist_bin(ttf_ms):
    """Return the histogram bin index for a TTF value. Linear scan is fine —
    only 40 edges, called once per finalized tx. Values above the top edge
    land in the last bin (saturating); that's acceptable since the realistic
    ceiling is already 60s."""
    for i, edge in enumerate(_HIST_EDGES):
        if ttf_ms <= edge:
            return i
    return _HIST_BIN_COUNT - 1


def _hist_percentile(hist, total, pct):
    """Estimate a percentile from a merged histogram via linear interpolation
    within the bin that contains the target sample (v1.5).

    Algorithm:
      1. target = pct × total — index of the percentile sample
      2. Walk bins, accumulating count. When cumulative crosses `target`,
         that's the bin containing the percentile.
      3. Linearly place the target within the bin: fraction = how far
         (target − cum_before) is across this bin's `c` samples.
      4. Return lower_edge + fraction × (upper_edge − lower_edge).

    Why not just the upper edge (v1.4 method)?
      Upper-edge always rounds the percentile UP to the bin ceiling, giving
      a fixed +3-10% bias on every reading (bigger on the right tail where
      bins are wider). Linear interpolation assumes samples are uniformly
      distributed within a bin — true on average, exact when the bin spans
      a small fraction of the distribution width. Verified against synthetic
      data matching real traffic (mean ~4.5s, 1800 samples): errors shrank
      from hundreds of ms to <50ms.

    Edge cases:
      - total ≤ 0           → None (no samples yet)
      - last (saturating) bin → return _HIST_HI_MS (can't interpolate past
                                the ceiling)
      - bin 0 (sub-floor)   → lower_edge = 0 by convention (sub-1s samples
                                are physically implausible; treating bin 0
                                as [0, _HIST_EDGES[0]] is the natural choice)
    """
    if total <= 0:
        return None
    target = pct * total
    cum = 0
    for i, c in enumerate(hist):
        if c == 0:
            continue
        cum_before = cum
        cum += c
        if cum >= target:
            # Lower edge: previous bin's upper edge, or 0 for bin 0.
            lower = _HIST_EDGES[i - 1] if i > 0 else 0.0
            upper = _HIST_EDGES[i] if i < len(_HIST_EDGES) else _HIST_HI_MS
            # Position within the bin: (target - already_counted) / count_here
            frac = (target - cum_before) / c
            frac = max(0.0, min(1.0, frac))  # numerical safety
            return lower + frac * (upper - lower)
    # All counts exhausted without hitting target → return high ceiling.
    return _HIST_HI_MS


# -----------------------------------------------------------------------------
# StatsRing — fixed-size ring of time buckets for the rolling 24h aggregate.
#
# Each bucket covers STATS_BUCKET_SEC seconds and stores only counters, never
# individual tx, so memory is O(buckets) and INDEPENDENT of TPS. The bucket a
# given timestamp maps to is `(ts // bucket_sec) % ring_len`; we stamp each
# bucket with the absolute bucket index it currently represents so we can
# detect and lazily reset a slot that has wrapped around (i.e. holds data from
# ~24h ago) on first touch — no separate eviction loop needed.
#
# snapshot() derives TPS, p50/p90 and mean for the whole window, applying
# fractional edge weighting to the oldest partial bucket so the 24h figure is
# continuous rather than stepping every bucket boundary.
# -----------------------------------------------------------------------------
class StatsRing:
    def __init__(self, bucket_sec=STATS_BUCKET_SEC, ring_len=STATS_RING_BUCKETS):
        self.bucket_sec = bucket_sec
        self.ring_len = ring_len
        # Each slot: dict with absolute bucket index `idx` (-1 = empty),
        # count, ttf_sum (ms), and a fixed histogram for percentiles.
        self.slots = [self._empty(-1) for _ in range(ring_len)]

    @staticmethod
    def _empty(abs_idx):
        return {
            "idx": abs_idx,
            "count": 0,
            "ttf_sum": 0,
            "hist": [0] * _HIST_BIN_COUNT,
        }

    def _abs_bucket(self, ts):
        return int(ts // self.bucket_sec)

    def _slot_for(self, abs_idx):
        """Return the slot that should hold abs_idx, lazily resetting it if it
        currently holds a stale (wrapped) bucket."""
        pos = abs_idx % self.ring_len
        slot = self.slots[pos]
        if slot["idx"] != abs_idx:
            # Slot belongs to a different (older) absolute bucket — recycle it.
            slot = self._empty(abs_idx)
            self.slots[pos] = slot
        return slot

    def record(self, ttf_ms, now):
        """O(1) — accumulate one finalized tx into its time bucket."""
        abs_idx = self._abs_bucket(now)
        slot = self._slot_for(abs_idx)
        slot["count"] += 1
        slot["ttf_sum"] += int(ttf_ms)
        slot["hist"][_hist_bin(ttf_ms)] += 1

    def snapshot(self, now):
        """O(buckets) — aggregate the live 24h window into display stats.

        Fractional edge weighting: the oldest bucket still inside the 24h
        horizon is usually only PARTIALLY inside it. We weight that bucket's
        contribution by the fraction still in-window so the totals don't step
        when a bucket rolls off. Counts become fractional for TPS purposes
        (fine — TPS is a rate), but for the histogram/percentiles we keep
        integer counts (weighting individual bins fractionally would be
        noise); the edge bucket is a single bucket out of 8640, so its
        rounding effect on percentiles is negligible.
        """
        cur_abs = self._abs_bucket(now)
        oldest_abs = cur_abs - self.ring_len + 1
        window_start_ts = now - STATS_WINDOW_SEC

        total_count = 0.0          # fractional, for TPS
        int_count = 0              # integer, for mean/percentiles
        ttf_sum = 0
        merged_hist = [0] * _HIST_BIN_COUNT

        for slot in self.slots:
            a = slot["idx"]
            if a < oldest_abs or a > cur_abs or slot["count"] == 0:
                continue
            bucket_start_ts = a * self.bucket_sec
            bucket_end_ts = bucket_start_ts + self.bucket_sec
            # Fractional weight for the partially-in-window edge bucket.
            if bucket_end_ts <= window_start_ts:
                continue
            if bucket_start_ts < window_start_ts:
                frac = (bucket_end_ts - window_start_ts) / self.bucket_sec
                frac = max(0.0, min(1.0, frac))
            else:
                frac = 1.0
            total_count += slot["count"] * frac
            int_count += slot["count"]
            ttf_sum += slot["ttf_sum"]
            for i, c in enumerate(slot["hist"]):
                merged_hist[i] += c

        tps = total_count / STATS_WINDOW_SEC if STATS_WINDOW_SEC else 0.0
        mean = (ttf_sum / int_count) if int_count else None
        # P10/P50/P90 = floor/typical/tail. P10 sits near the protocol's 1.34s
        # theoretical minimum (134 polls × 10ms event loop) and is the headline
        # "how close real traffic gets to the floor" number; P90 is the
        # credibility/trust tail; P50 is the typical user experience.
        p10 = _hist_percentile(merged_hist, int_count, 0.10)
        p50 = _hist_percentile(merged_hist, int_count, 0.50)
        p90 = _hist_percentile(merged_hist, int_count, 0.90)

        return {
            "tps": round(tps, 4),
            "ttfP10Ms": round(p10) if p10 is not None else None,
            "ttfP50Ms": round(p50) if p50 is not None else None,
            "ttfP90Ms": round(p90) if p90 is not None else None,
            "ttfMeanMs": round(mean) if mean is not None else None,
            "sampleCount": int_count,
            "windowSec": STATS_WINDOW_SEC,
        }

    # --- persistence -----------------------------------------------------
    def to_json(self):
        """Serialize only non-empty slots to keep the file small.

        Includes a `hist_lo_ms` sentinel so load_json can detect a changed
        histogram geometry across versions and start fresh rather than
        misinterpret bins (samples are stored as bin indices; if the
        edges change, the same index means a different range — silent
        corruption otherwise, as observed in the v1.4→v1.5 transition)."""
        return {
            "bucket_sec": self.bucket_sec,
            "ring_len": self.ring_len,
            "hist_lo_ms": _HIST_LO_MS,
            "slots": [s for s in self.slots if s["idx"] >= 0 and s["count"] > 0],
        }

    def load_json(self, data, now):
        """Restore from a previously persisted ring, dropping any bucket that
        is now older than the 24h window. Defensive against a changed
        bucket_sec/ring_len/hist_lo_ms between versions — if any differ, we
        start fresh rather than misalign the ring or misinterpret histogram
        bins (the latter caused silent percentile corruption in v1.5)."""
        if not isinstance(data, dict):
            return
        if (data.get("bucket_sec") != self.bucket_sec
                or data.get("ring_len") != self.ring_len
                or data.get("hist_lo_ms") != _HIST_LO_MS):
            log.warning("stats ring geometry changed, starting fresh")
            return
        cur_abs = self._abs_bucket(now)
        oldest_abs = cur_abs - self.ring_len + 1
        restored = 0
        for slot in data.get("slots", []):
            a = slot.get("idx", -1)
            if a < oldest_abs or a > cur_abs:
                continue  # outside the live window now
            hist = slot.get("hist") or [0] * _HIST_BIN_COUNT
            if len(hist) != _HIST_BIN_COUNT:
                continue  # bin layout changed — skip this slot
            self.slots[a % self.ring_len] = {
                "idx": a,
                "count": int(slot.get("count", 0)),
                "ttf_sum": int(slot.get("ttf_sum", 0)),
                "hist": [int(x) for x in hist],
            }
            restored += 1
        log.info(f"stats ring restored {restored} live buckets from disk")


# Module-level ring instance — fed by log_reader, read by stats_broadcaster.
stats_ring = StatsRing()


def persist_stats_ring():
    """Atomically write the ring to disk (write-temp-then-rename) so a crash
    mid-write can't corrupt the file. Called every STATS_PERSIST_SEC and once
    on shutdown."""
    try:
        tmp = STATS_PERSIST_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(stats_ring.to_json()))
        tmp.replace(STATS_PERSIST_PATH)
    except Exception as e:
        log.warning(f"stats persist failed: {e}")


def load_stats_ring():
    """Load the ring from disk on startup if present. Best-effort."""
    try:
        if STATS_PERSIST_PATH.exists():
            data = json.loads(STATS_PERSIST_PATH.read_text())
            stats_ring.load_json(data, time.time())
    except Exception as e:
        log.warning(f"stats load failed: {e}")


# -----------------------------------------------------------------------------
# WS traffic accounting (v1.4, restored in v1.5.2). Privacy-by-design: hash
# remote IPs with a salt that regenerates at UTC midnight, so unique-IP counts
# work within a day but the hash cannot link across days. No raw IPs ever
# touch disk.
# -----------------------------------------------------------------------------
import hashlib as _hashlib
import secrets as _secrets
from datetime import datetime as _dt, timezone as _tz

_ws_salt = _secrets.token_bytes(32)
_ws_salt_day = _dt.now(_tz.utc).date()


def _ws_ip_hash(remote_addr):
    """Hash a (ip, port) tuple (websockets passes that as ws.remote_address)
    to a 16-hex-char identifier using today's salt. Rotates salt at UTC
    midnight on first call after the day changes."""
    global _ws_salt, _ws_salt_day
    today = _dt.now(_tz.utc).date()
    if today != _ws_salt_day:
        _ws_salt = _secrets.token_bytes(32)
        _ws_salt_day = today
        log.info("ws-traffic: rotated daily IP salt")
    ip = remote_addr[0] if isinstance(remote_addr, tuple) else str(remote_addr)
    return _hashlib.sha256(_ws_salt + ip.encode()).hexdigest()[:16]


def _ws_traffic_write(event_type, ip_hash, total_clients):
    """Append one JSON line to ws-traffic.log. Best-effort — a write failure
    must not break the WS handler, so we swallow exceptions with a warning."""
    try:
        rec = {
            "ts": int(time.time()),
            "event": event_type,    # "connect" | "disconnect"
            "iph": ip_hash,         # 16-hex-char hash of (today_salt || ip)
            "active": total_clients,
        }
        with WS_TRAFFIC_LOG_PATH.open("a", buffering=1) as f:
            f.write(json.dumps(rec) + "\n")
    except Exception as e:
        log.warning(f"ws-traffic write failed: {e}")


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

            # Feed the rolling 24h aggregate (v1.2.5). O(1) — accumulates into
            # the current time bucket; does not scale with TPS.
            stats_ring.record(ttf_ms, time.time())

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


async def stats_broadcaster():
    """Periodically broadcast the rolling 24h aggregate and persist the ring.

    Two cadences on one timer:
      - every STATS_BROADCAST_SEC: push a `stats` frame to all clients
      - every STATS_PERSIST_SEC:   atomically persist the ring to disk

    The snapshot is O(buckets) (~8640 tiny dicts) and runs once per 5s, so
    its cost is microseconds — flat regardless of TPS.
    """
    last_persist = time.time()
    while True:
        await asyncio.sleep(STATS_BROADCAST_SEC)
        now = time.time()
        snap = stats_ring.snapshot(now)
        frame = {"type": "stats", "emittedAt": int(now * 1000), **snap}
        if clients:
            try:
                event_queue.put_nowait(frame)
            except asyncio.QueueFull:
                log.warning("event_queue full, dropping stats frame")
        if now - last_persist >= STATS_PERSIST_SEC:
            persist_stats_ring()
            last_persist = now


async def handle_client(ws):
    """Register a new WebSocket client and hold the connection until close."""
    log.info(f"client connected: {ws.remote_address}, total={len(clients)+1}")
    clients.add(ws)
    # v1.5.2: account this connection for /ecashlive_status traffic stats.
    # Done after the add so `active` reflects the post-add count, matching
    # disconnect (which records post-remove). IP is hashed with daily salt.
    iph = _ws_ip_hash(ws.remote_address)
    _ws_traffic_write("connect", iph, len(clients))
    try:
        # Send a hello so the client knows the feed is alive
        await ws.send(json.dumps({"type": "hello", "version": 1}))
        # Send one immediate stats snapshot so a freshly-loaded page shows
        # the 24h figures right away instead of waiting up to 5s for the
        # next broadcast tick.
        try:
            now = time.time()
            snap = stats_ring.snapshot(now)
            await ws.send(json.dumps(
                {"type": "stats", "emittedAt": int(now * 1000), **snap}))
        except Exception as e:
            log.warning(f"initial stats send failed: {e}")
        # Keep alive — clients don't send anything, just receive.
        async for _ in ws:
            pass
    except websockets.ConnectionClosed:
        pass
    finally:
        clients.discard(ws)
        log.info(f"client disconnected, total={len(clients)}")
        _ws_traffic_write("disconnect", iph, len(clients))


async def daily_rollup_task():
    """Once a day at 00:02 UTC, summarize the prior day's TTF samples into
    one JSONL line in ttf-daily.jsonl. Source = ttf.log audit (not the
    ring), so missed midnights are recoverable as long as the audit log
    still has the day in question.

    Schema per line:
      {"date":"YYYY-MM-DD", "samples":N, "tps":float,
       "ttf_mean_ms":int, "ttf_p10_ms":int, "ttf_p50_ms":int,
       "ttf_p90_ms":int, "ttf_min_ms":int, "ttf_max_ms":int}

    Self-healing: on startup, reads the last `date` in ttf-daily.jsonl and
    back-fills every full UTC day between then and yesterday. First-run
    with no rollup file just back-fills yesterday.

    Sleeps until next 00:02 UTC + small jitter (avoids exact-second tie
    with logrotate at 00:00 UTC if both run on this host).
    """
    from datetime import datetime, timezone, date, timedelta

    def parse_audit_for_day(day):
        """Read ttf.log + rotated backups, return list of ttfMs ints for
        samples emitted on `day` (UTC). audit format = one JSON object per
        line containing "ttfMs" and "emittedAt" (epoch ms). Skips
        unreadable lines defensively."""
        day_start_ms = int(datetime(day.year, day.month, day.day,
                                    tzinfo=timezone.utc).timestamp() * 1000)
        next_day_ms = day_start_ms + 86_400_000
        samples = []
        # Glob for audit + rotated. logrotate produces ttf.log, ttf.log.1,
        # ttf.log.2.gz, ... — we read everything in that family.
        import glob
        import gzip
        candidates = sorted(glob.glob(str(TTF_LOG_PATH) + "*"))
        for path in candidates:
            try:
                opener = gzip.open if path.endswith(".gz") else open
                with opener(path, "rt", errors="replace") as f:
                    for line in f:
                        if '"ttfMs"' not in line:
                            continue
                        try:
                            rec = json.loads(line)
                        except Exception:
                            continue
                        ts = rec.get("emittedAt", 0)
                        if ts < day_start_ms or ts >= next_day_ms:
                            continue
                        ttf = rec.get("ttfMs")
                        if isinstance(ttf, (int, float)) and ttf > 0:
                            samples.append(float(ttf))
            except FileNotFoundError:
                continue
            except Exception as e:
                log.warning(f"audit read failed for {path}: {e}")
        return samples

    def summarize(samples):
        """Compute mean + percentiles + min/max from raw samples. Sorted
        once, exact percentiles by nearest-rank — no histogram bias, no
        binning. n=2700/day is trivial to sort."""
        if not samples:
            return None
        samples.sort()
        n = len(samples)

        def pct(p):
            # nearest-rank percentile: index = ceil(p * n) - 1
            i = max(0, min(n - 1, int(p * n)))
            return int(samples[i])
        return {
            "samples": n,
            "tps": round(n / 86400.0, 5),
            "ttf_mean_ms": int(sum(samples) / n),
            "ttf_p10_ms": pct(0.10),
            "ttf_p50_ms": pct(0.50),
            "ttf_p90_ms": pct(0.90),
            "ttf_min_ms": int(samples[0]),
            "ttf_max_ms": int(samples[-1]),
        }

    def write_day(day):
        """Compute + append one rollup line for `day`. No-op if no samples
        (relay down all day, or first install)."""
        samples = parse_audit_for_day(day)
        summary = summarize(samples)
        if summary is None:
            log.info(f"daily rollup: no samples for {day.isoformat()}, skipped")
            return
        row = {"date": day.isoformat(), **summary}
        with TTF_DAILY_LOG_PATH.open("a", buffering=1) as f:
            f.write(json.dumps(row) + "\n")
        log.info(f"daily rollup wrote {day.isoformat()}: "
                 f"n={summary['samples']} mean={summary['ttf_mean_ms']}ms")

    def last_rolled_date():
        """Most recent `date` value in ttf-daily.jsonl, or None if empty/
        missing. Used to detect gaps for back-fill."""
        try:
            with TTF_DAILY_LOG_PATH.open() as f:
                last = None
                for line in f:
                    last = line
                if last:
                    return json.loads(last).get("date")
        except FileNotFoundError:
            return None
        except Exception:
            return None
        return None

    # ---- startup back-fill ----
    try:
        today_utc = datetime.now(timezone.utc).date()
        last = last_rolled_date()
        if last:
            from datetime import date as _date
            start = _date.fromisoformat(last) + timedelta(days=1)
        else:
            # First run ever: just back-fill yesterday.
            start = today_utc - timedelta(days=1)
        d = start
        while d < today_utc:
            write_day(d)
            d += timedelta(days=1)
    except Exception as e:
        log.warning(f"daily rollup startup back-fill failed: {e}")

    # ---- steady-state: wake at 00:02 UTC each day ----
    while True:
        now_utc = datetime.now(timezone.utc)
        tomorrow = (now_utc + timedelta(days=1)).date()
        next_run = datetime(tomorrow.year, tomorrow.month, tomorrow.day,
                            0, 2, 0, tzinfo=timezone.utc)
        sleep_sec = max(60.0, (next_run - now_utc).total_seconds())
        await asyncio.sleep(sleep_sec)
        try:
            yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
            write_day(yesterday)
        except Exception as e:
            log.warning(f"daily rollup failed: {e}")


async def main():
    TTF_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATS_PERSIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    TTF_DAILY_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    WS_TRAFFIC_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

    log.info(f"starting ttf-relay")
    log.info(f"  reading: {DEBUG_LOG_PATH}")
    log.info(f"  audit:   {TTF_LOG_PATH}")
    log.info(f"  stats:   {STATS_PERSIST_PATH}")
    log.info(f"  daily:   {TTF_DAILY_LOG_PATH}")
    log.info(f"  ws-log:  {WS_TRAFFIC_LOG_PATH}")
    log.info(f"  listen:  ws://{WS_HOST}:{WS_PORT}")

    # Restore the 24h ring from disk so the stats bar isn't empty for 24h
    # after a restart. Drops any bucket already outside the live window.
    load_stats_ring()

    # Graceful shutdown
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_event_loop().add_signal_handler(sig, stop.set)

    async with websockets.serve(handle_client, WS_HOST, WS_PORT):
        reader_task = asyncio.create_task(log_reader())
        broadcaster_task = asyncio.create_task(broadcaster())
        stats_task = asyncio.create_task(stats_broadcaster())
        rollup_task = asyncio.create_task(daily_rollup_task())
        await stop.wait()
        log.info("shutting down")
        reader_task.cancel()
        broadcaster_task.cancel()
        stats_task.cancel()
        rollup_task.cancel()
        # Final persist so we don't lose the last <60s of buckets on a clean
        # restart/deploy.
        persist_stats_ring()
        log.info("stats ring persisted on shutdown")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
