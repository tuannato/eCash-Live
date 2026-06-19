#!/usr/bin/env python3
"""
ecash_bot.py — Telegram bot quản lý node eCash (Bitcoin ABC)
Có thể tái sử dụng cho nhiều VPS — config trong .ecash_bot_config.json

Lệnh hỗ trợ (đặt prefix tùy ý qua config):
  /<prefix>_status   — Trạng thái chi tiết node
  /<prefix>_restart  — Restart node (yêu cầu password)
  /<prefix>_stop     — Stop node (yêu cầu password)
  /<prefix>_start    — Start node (yêu cầu password)
  /<prefix>_update   — Update node (yêu cầu password)
  /<prefix>_logs     — Xem log
  /<prefix>_help     — Danh sách lệnh
  /cancel            — Hủy thao tác đang chờ password

Tự động alert khi node down/up.
"""

import os
import re
import sys
import json
import time
import hmac
import hashlib
import logging
import asyncio
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

try:
    from telegram import Update, BotCommand
    from telegram.constants import ParseMode
    from telegram.ext import (
        Application, CommandHandler, MessageHandler,
        ContextTypes, filters
    )
    import requests
except ImportError:
    print("Cần cài: pip3 install python-telegram-bot requests --break-system-packages")
    sys.exit(1)

# ─── CONFIG ───────────────────────────────────────────────────
CONFIG_FILE = Path.home() / ".ecash_bot_config.json"

DEFAULT_CONFIG = {
    "bot_token": "YOUR_BOT_TOKEN_HERE",
    "allowed_user_ids": [123456789],
    "alert_chat_id": 123456789,
    "check_interval_seconds": 300,
    "command_prefix": "node1",
    "node_name": "eCash Node #1",

    # Password để xác thực lệnh nguy hiểm (sẽ hash khi load)
    "password": "CHANGE_THIS_PASSWORD",
    "password_timeout_seconds": 60,
    "password_session_minutes": 10,
    "max_password_attempts": 3,
    "lockout_minutes": 15,

    "paths": {
        "bitcoind": "/home/mikazuki/bitcoin-abc/bin/bitcoind",
        "bitcoin_cli": "/home/mikazuki/bitcoin-abc/bin/bitcoin-cli",
        "datadir": "/home/mikazuki/.bitcoin",
        "auto_update_script": "/home/mikazuki/auto_update.sh",
        # v1.4: TTF relay + web traffic monitoring
        "ttf_stats": "/home/mikazuki/ttf-relay/ttf-stats.json",
        "ws_traffic_log": "/home/mikazuki/ttf-relay/ws-traffic.log",
        "nginx_access_log": "/var/log/nginx/access.log",
        # daily rollup the bot writes itself at UTC midnight (gives year stats
        # despite nginx logrotate keeping only ~14 days)
        "traffic_daily_log": "/home/mikazuki/ttf-relay/traffic-daily.jsonl",
        # v1.5.2: relay's TTF daily rollup (1 line/day with samples, TPS,
        # mean, p10/50/90, min, max). Bot reads it for window 30d/year.
        "ttf_daily_log": "/home/mikazuki/ttf-relay/ttf-daily.jsonl",
    },
    "ports": {"chronik": 8331, "rpc": 8332},
    "systemd_service": "bitcoind",
    "ttf_relay_service": "ttf-relay",
    "ecashlive_command_prefix": "ecashlive",  # /ecashlive_status, /ecashlive_help
}

if not CONFIG_FILE.exists():
    print(f"❌ Không tìm thấy {CONFIG_FILE}\nTạo file mẫu với nội dung:\n")
    print(json.dumps(DEFAULT_CONFIG, indent=2))
    sys.exit(1)

with open(CONFIG_FILE) as f:
    CONFIG = json.load(f)


def merge_config(default, user):
    result = default.copy()
    for k, v in user.items():
        if isinstance(v, dict) and k in result and isinstance(result[k], dict):
            result[k] = merge_config(result[k], v)
        else:
            result[k] = v
    return result


CONFIG = merge_config(DEFAULT_CONFIG, CONFIG)

BOT_TOKEN = CONFIG["bot_token"]
ALLOWED_USER_IDS = set(CONFIG["allowed_user_ids"])
ALERT_CHAT_ID = CONFIG.get("alert_chat_id")
CHECK_INTERVAL = CONFIG.get("check_interval_seconds", 300)
PREFIX = CONFIG["command_prefix"].strip().lower()
NODE_NAME = CONFIG.get("node_name", "eCash Node")

# Password - hash bằng SHA-256 để không giữ plaintext trong RAM
_PASS = CONFIG["password"].encode()
PASSWORD_HASH = hashlib.sha256(_PASS).hexdigest()
del _PASS  # xóa plaintext khỏi memory
PASSWORD_TIMEOUT = CONFIG.get("password_timeout_seconds", 60)
SESSION_MINUTES = CONFIG.get("password_session_minutes", 10)
MAX_ATTEMPTS = CONFIG.get("max_password_attempts", 3)
LOCKOUT_MINUTES = CONFIG.get("lockout_minutes", 15)

# Paths
BITCOIND = CONFIG["paths"]["bitcoind"]
BITCOIN_CLI = CONFIG["paths"]["bitcoin_cli"]
DATADIR = CONFIG["paths"]["datadir"]
AUTO_UPDATE = CONFIG["paths"]["auto_update_script"]
DEBUG_LOG = f"{DATADIR}/debug.log"
CHRONIK_PORT = CONFIG["ports"]["chronik"]
RPC_PORT = CONFIG["ports"]["rpc"]
SYSTEMD_SERVICE = CONFIG["systemd_service"]

# v1.4: TTF relay + web traffic
TTF_STATS_PATH = CONFIG["paths"]["ttf_stats"]
WS_TRAFFIC_LOG = CONFIG["paths"]["ws_traffic_log"]
NGINX_ACCESS_LOG = CONFIG["paths"]["nginx_access_log"]
TRAFFIC_DAILY_LOG = CONFIG["paths"]["traffic_daily_log"]
TTF_DAILY_LOG = CONFIG["paths"].get(
    "ttf_daily_log", "/home/mikazuki/ttf-relay/ttf-daily.jsonl")
TTF_RELAY_SERVICE = CONFIG.get("ttf_relay_service", "ttf-relay")
# v1.5.6: feed-stall alert threshold. The relay persists ttf-stats.json every
# ~60s; if the node is up but the file hasn't been touched in this long, the
# 24h feed has stalled (relay crash, perms, etc. — debug.log truncation is
# now self-healing). Generous to avoid false positives during a brief restart.
RELAY_STALL_SEC = CONFIG.get("relay_stall_seconds", 300)
ECASHLIVE_PREFIX = CONFIG.get("ecashlive_command_prefix", "ecashlive").strip().lower()

TELEGRAM_MAX_LEN = 4000

logging.basicConfig(
    format='[%(asctime)s] %(levelname)s — %(message)s',
    level=logging.INFO
)
logger = logging.getLogger("ecash_bot")

# v1.5.3: silence httpx + telegram-bot loggers. They log every getUpdates
# POST at INFO level, and the URL contains the bot token. Even though our
# journal is admin-only, having the token sprayed into systemd-journald
# every 10 seconds was a real leak vector in past audits. WARNING is
# enough — real errors (HTTP 5xx, network failures) still surface.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)

# ─── STATE ────────────────────────────────────────────────────
# user_id → {"action": "restart", "asked_at": timestamp, "data": {...}}
PENDING_AUTH = {}

# user_id → {"verified_at": timestamp} (session sau khi nhập đúng password)
ACTIVE_SESSIONS = {}

# user_id → {"failed_count": N, "lockout_until": timestamp}
FAILED_ATTEMPTS = {}


# ─── HELPERS ──────────────────────────────────────────────────
def run_cmd(cmd, timeout=30):
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True,
            text=True, timeout=timeout
        )
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except subprocess.TimeoutExpired:
        return "", "Timeout", -1
    except Exception as e:
        return "", str(e), -1


def cli(args, timeout=15):
    out, _, rc = run_cmd(f"{BITCOIN_CLI} -datadir={DATADIR} {args}", timeout)
    return out if rc == 0 else None


def is_authorized(user_id: int) -> bool:
    return user_id in ALLOWED_USER_IDS


def is_locked_out(user_id: int):
    """Kiểm tra user có đang bị khóa do nhập sai password không."""
    info = FAILED_ATTEMPTS.get(user_id)
    if not info:
        return False, 0
    if info.get("lockout_until", 0) > time.time():
        remaining = int(info["lockout_until"] - time.time())
        return True, remaining
    return False, 0


def has_active_session(user_id: int) -> bool:
    """Kiểm tra user còn session hợp lệ không (đã nhập đúng password gần đây)."""
    info = ACTIVE_SESSIONS.get(user_id)
    if not info:
        return False
    elapsed = time.time() - info["verified_at"]
    if elapsed > SESSION_MINUTES * 60:
        ACTIVE_SESSIONS.pop(user_id, None)
        return False
    return True


def verify_password(plaintext: str) -> bool:
    """So sánh password an toàn (constant-time)."""
    incoming = hashlib.sha256(plaintext.encode()).hexdigest()
    return hmac.compare_digest(incoming, PASSWORD_HASH)


def auth_check(func):
    """Decorator: chỉ cho phép user_id được khai báo."""
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user_id = update.effective_user.id
        username = update.effective_user.username or "unknown"
        if not is_authorized(user_id):
            logger.warning(f"⛔ Unauthorized: {username} ({user_id})")
            await update.message.reply_text("⛔ Bạn không có quyền dùng bot này.")
            return
        return await func(update, context)
    return wrapper


def escape_html(s: str) -> str:
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


async def send_long(update: Update, text: str, parse_mode=ParseMode.HTML):
    if len(text) <= TELEGRAM_MAX_LEN:
        await update.message.reply_text(text, parse_mode=parse_mode)
        return

    lines = text.split("\n")
    chunks, current = [], ""
    for line in lines:
        if len(current) + len(line) + 1 > TELEGRAM_MAX_LEN:
            chunks.append(current)
            current = line + "\n"
        else:
            current += line + "\n"
    if current:
        chunks.append(current)

    for i, chunk in enumerate(chunks, 1):
        prefix = f"📄 <b>Phần {i}/{len(chunks)}</b>\n\n" if len(chunks) > 1 else ""
        await update.message.reply_text(prefix + chunk, parse_mode=parse_mode)
        await asyncio.sleep(0.3)


# ─── PASSWORD WORKFLOW ────────────────────────────────────────
def require_password(action_name: str):
    """Decorator: lệnh nguy hiểm yêu cầu password trước khi thực thi.

    Logic:
      1. Đã có session → cho chạy luôn (trong 10 phút sau khi nhập password)
      2. Chưa có session → đặt PENDING_AUTH, yêu cầu nhập password
      3. User trả lời bằng password → kiểm tra → nếu đúng thì chạy action
    """
    def decorator(func):
        async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
            user_id = update.effective_user.id

            # Auth user_id trước
            if not is_authorized(user_id):
                await update.message.reply_text("⛔ Bạn không có quyền.")
                return

            # Check lockout
            locked, remaining = is_locked_out(user_id)
            if locked:
                await update.message.reply_text(
                    f"🔒 Bạn đang bị khóa do nhập sai password nhiều lần.\n"
                    f"Thử lại sau <b>{remaining}</b> giây.",
                    parse_mode=ParseMode.HTML
                )
                return

            # Đã có session → chạy luôn
            if has_active_session(user_id):
                logger.info(f"User {user_id} chạy '{action_name}' (session active)")
                return await func(update, context)

            # Chưa có session → yêu cầu password
            PENDING_AUTH[user_id] = {
                "action": action_name,
                "asked_at": time.time(),
                "func": func,
                "update": update,
                "context": context
            }
            await update.message.reply_text(
                f"🔐 Lệnh <b>{action_name}</b> yêu cầu xác thực.\n\n"
                f"Vui lòng gửi password (sẽ tự xóa sau khi xử lý).\n"
                f"⏰ Hết hạn sau <b>{PASSWORD_TIMEOUT}</b> giây.\n"
                f"❌ Hủy: /cancel",
                parse_mode=ParseMode.HTML
            )
        return wrapper
    return decorator


async def handle_password_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Xử lý mọi text message — kiểm tra xem có phải password reply không."""
    user_id = update.effective_user.id

    if not is_authorized(user_id):
        return

    pending = PENDING_AUTH.get(user_id)
    if not pending:
        # Không có pending → bỏ qua text message thường
        return

    # Check timeout
    elapsed = time.time() - pending["asked_at"]
    if elapsed > PASSWORD_TIMEOUT:
        PENDING_AUTH.pop(user_id, None)
        await update.message.reply_text(
            "⏰ Đã hết thời gian nhập password. Hãy gửi lại lệnh."
        )
        return

    # Lấy password và xóa message gốc ngay (bảo mật)
    password = update.message.text
    try:
        await update.message.delete()
    except Exception:
        pass

    # Verify
    if verify_password(password):
        # Reset failed counter
        FAILED_ATTEMPTS.pop(user_id, None)

        # Tạo session
        ACTIVE_SESSIONS[user_id] = {"verified_at": time.time()}

        action = pending["action"]
        func = pending["func"]
        original_update = pending["update"]
        original_context = pending["context"]
        PENDING_AUTH.pop(user_id, None)

        logger.info(f"✅ User {user_id} verified for '{action}'")
        await update.message.reply_text(
            f"✅ Xác thực thành công.\n"
            f"Đang thực thi: <b>{action}</b>\n"
            f"<i>Session valid trong {SESSION_MINUTES} phút.</i>",
            parse_mode=ParseMode.HTML
        )
        # Chạy action gốc
        await func(original_update, original_context)
    else:
        # Sai password — tăng counter
        info = FAILED_ATTEMPTS.get(user_id, {"failed_count": 0})
        info["failed_count"] = info.get("failed_count", 0) + 1
        FAILED_ATTEMPTS[user_id] = info

        remaining = MAX_ATTEMPTS - info["failed_count"]
        if remaining <= 0:
            # Lockout
            info["lockout_until"] = time.time() + LOCKOUT_MINUTES * 60
            info["failed_count"] = 0
            FAILED_ATTEMPTS[user_id] = info
            PENDING_AUTH.pop(user_id, None)
            logger.warning(f"🔒 User {user_id} locked out for {LOCKOUT_MINUTES}m")
            await update.message.reply_text(
                f"🔒 Sai password quá nhiều lần.\n"
                f"Bạn bị khóa <b>{LOCKOUT_MINUTES}</b> phút.",
                parse_mode=ParseMode.HTML
            )
        else:
            await update.message.reply_text(
                f"❌ Sai password. Còn <b>{remaining}</b> lần thử.\n"
                f"Hủy: /cancel",
                parse_mode=ParseMode.HTML
            )


@auth_check
async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id in PENDING_AUTH:
        action = PENDING_AUTH.pop(user_id)["action"]
        await update.message.reply_text(f"❌ Đã hủy lệnh <b>{action}</b>.",
                                        parse_mode=ParseMode.HTML)
    else:
        await update.message.reply_text("Không có lệnh nào đang chờ.")


@auth_check
async def cmd_logout(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Xóa session đang active — buộc nhập password lại."""
    user_id = update.effective_user.id
    if user_id in ACTIVE_SESSIONS:
        ACTIVE_SESSIONS.pop(user_id)
        await update.message.reply_text("🔓 Đã logout. Lệnh nguy hiểm sẽ yêu cầu password lại.")
    else:
        await update.message.reply_text("Bạn không có session nào đang active.")


# ─── ECASHLIVE ANALYTICS (v1.4) ───────────────────────────────
#
# Three data sources, three different signals:
#
#   ttf-stats.json     — TTF/TPS percentiles from the relay's persisted ring
#                        (24h rolling, refreshes every 60s on disk).
#   ws-traffic.log     — line-JSON connect/disconnect events. Hashed IPs only
#                        (salt rotates daily) — supports intra-day unique
#                        counts; cross-day unique = sum of per-day uniques,
#                        slightly overestimated by repeat visitors (acceptable
#                        tradeoff for the privacy property).
#   nginx access.log   — chronik1.ecashlive.net API traffic (chronik queries).
#                        Default `combined` format. We read it tail-first so
#                        a busy day doesn't make the bot scan from the start.
#
# Longer-than-14d windows: nginx rotates daily, keeps ~14d. To answer month/
# year queries the bot writes a daily rollup at UTC midnight (one JSONL line
# per day in traffic_daily_log). Year stats = read 365 lines, cheap.
#
# All file reads are best-effort: missing/permission-denied files yield
# explicit "?" markers in the report rather than raising.

import gzip
from collections import defaultdict

# Histogram constants — KEEP IN SYNC with ttf-relay.py (v1.5.6 raised the
# floor 200 -> 1000). Bot recomputes percentiles from persisted bucket
# histograms instead of waiting for a live WS frame. If you change these in
# the relay, mirror the change here.
_HIST_LO_MS = 1000
_HIST_HI_MS = 60_000
_HIST_BIN_COUNT = 40
_HIST_EDGES = [
    _HIST_LO_MS * (_HIST_HI_MS / _HIST_LO_MS) ** (i / _HIST_BIN_COUNT)
    for i in range(1, _HIST_BIN_COUNT + 1)
]


def _hist_percentile(hist, total, pct):
    """Match the relay's v1.5 histogram percentile (linear interpolation
    within the containing bin). Single source of numerical truth: same
    formula, same edges → same answer as the website. See ttf-relay.py
    v1.5 docstring for the algorithm rationale."""
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
            lower = _HIST_EDGES[i - 1] if i > 0 else 0.0
            upper = _HIST_EDGES[i] if i < len(_HIST_EDGES) else _HIST_HI_MS
            frac = (target - cum_before) / c
            frac = max(0.0, min(1.0, frac))
            return lower + frac * (upper - lower)
    return _HIST_HI_MS


def read_ttf_stats():
    """Re-aggregate the persisted ring into TPS/percentiles/mean/sampleCount.
    Returns a dict, or {'error': str} if the file is missing/broken/stale.

    Why not just trust the last broadcast frame? We don't have one — the bot
    has no WS connection. Re-aggregating from disk gives the bot identical
    numbers to the website without any live coupling. Cost: O(buckets) on
    each /node1_status — flat regardless of TPS, microseconds in practice.
    """
    try:
        st = os.stat(TTF_STATS_PATH)
        age_sec = int(time.time() - st.st_mtime)
        with open(TTF_STATS_PATH) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"error": "file missing"}
    except Exception as e:
        return {"error": f"read failed: {e}"}

    bucket_sec = data.get("bucket_sec")
    ring_len = data.get("ring_len")
    if not bucket_sec or not ring_len:
        return {"error": "malformed (no geometry)"}

    now = time.time()
    cur_abs = int(now // bucket_sec)
    window_sec = bucket_sec * ring_len
    oldest_abs = cur_abs - ring_len + 1
    window_start_ts = now - window_sec

    total_count = 0.0   # fractional (TPS)
    int_count = 0        # integer (mean/percentiles)
    ttf_sum = 0
    merged_hist = [0] * _HIST_BIN_COUNT
    # v1.5.4: collect per-minute counts for peak-TPS computation. Same
    # logic as relay's snapshot() — 6 buckets (60s) form one minute.
    minute_counts = {}
    # v1.5.6: oldest in-window bucket holding data → coverage / warmup,
    # mirroring the relay's snapshot() gating so /status agrees with the web.
    oldest_data_start = None

    for slot in data.get("slots", []):
        a = slot.get("idx", -1)
        if a < oldest_abs or a > cur_abs or slot.get("count", 0) == 0:
            continue
        bucket_start_ts = a * bucket_sec
        bucket_end_ts = bucket_start_ts + bucket_sec
        if bucket_end_ts <= window_start_ts:
            continue
        if bucket_start_ts < window_start_ts:
            frac = (bucket_end_ts - window_start_ts) / bucket_sec
            frac = max(0.0, min(1.0, frac))
        else:
            frac = 1.0
        c = int(slot.get("count", 0))
        total_count += c * frac
        int_count += c
        if oldest_data_start is None or bucket_start_ts < oldest_data_start:
            oldest_data_start = bucket_start_ts
        ttf_sum += int(slot.get("ttf_sum", 0))
        hist = slot.get("hist") or []
        for i, v in enumerate(hist[:_HIST_BIN_COUNT]):
            merged_hist[i] += int(v)
        # Group into minute bucket (60s / bucket_sec buckets per minute).
        # For bucket_sec=10 this is 6 buckets per minute.
        buckets_per_min = max(1, 60 // bucket_sec)
        minute_idx = a // buckets_per_min
        minute_counts[minute_idx] = minute_counts.get(minute_idx, 0) + c

    # v1.5.4: derived metrics. Same formulas as relay/snapshot() so a
    # /node1_status report matches what the live web feed shows.
    tps_peak = (max(minute_counts.values()) / 60.0) if minute_counts else 0.0
    # pctFinalUnder3s: cumulative count in bins fully below 3000ms.
    # _HIST_EDGES (bot copy) is the same log-spaced grid as relay; recompute
    # the cutoff bin count locally rather than rely on a wire constant.
    pct_under_3s_limit = 3000.0
    pct_bin_cutoff = sum(1 for e in _HIST_EDGES if e <= pct_under_3s_limit)
    if int_count > 0:
        under_3s = sum(merged_hist[:pct_bin_cutoff])
        pct_under_3s = under_3s / int_count
    else:
        pct_under_3s = None

    # v1.5.6: warmup gating — mirror relay snapshot() exactly so /status
    # agrees with the web. Coverage is wall-time since the ring epoch (now -
    # epoch_ts), capped at the window; monotonic, so no low-TPS flicker.
    # epoch_ts priority matches the relay's load_json: explicit field if data
    # present, else seed from the oldest in-window bucket (older files), else
    # None. One-bucket tolerance + int_count==0 gate, same as the relay.
    ep = data.get("epoch_ts")
    if int_count == 0:
        epoch_ts = None
    elif isinstance(ep, (int, float)):
        epoch_ts = float(ep)
    elif oldest_data_start is not None:
        epoch_ts = float(oldest_data_start)
    else:
        epoch_ts = None
    if epoch_ts is None:
        coverage_sec = 0
    else:
        coverage_sec = int(min(float(window_sec), max(0.0, now - epoch_ts)))
    warmup = (int_count == 0 or coverage_sec < window_sec - bucket_sec)

    return {
        "age_sec": age_sec,
        "window_sec": window_sec,
        "warmup": warmup,
        "coverage_sec": coverage_sec,
        "samples": int_count,
        "tps": total_count / window_sec if window_sec else 0.0,
        "mean_ms": (ttf_sum / int_count) if int_count else None,
        "p10_ms": _hist_percentile(merged_hist, int_count, 0.10),
        "p50_ms": _hist_percentile(merged_hist, int_count, 0.50),
        "p90_ms": _hist_percentile(merged_hist, int_count, 0.90),
        # v1.5.4 additions. currentClients is written to the file by the
        # relay's persist_stats_ring(); the other two are computed here
        # from the same ring data (bot doesn't need to wait for newer
        # relay schema — works against any v1.5.x file that has slots/hist).
        "current_clients": data.get("currentClients"),
        "tps_peak_24h": tps_peak,
        "pct_under_3s": pct_under_3s,
    }


def read_ws_traffic(since_ts):
    """Scan ws-traffic.log for connect events after `since_ts`. Returns
    {connects, unique_hashes, peak_concurrent, sessions_sec_total,
     sessions_sec_count} so the caller can compute averages.

    Sessions: we pair each connect with the next disconnect of the same hash.
    Connects without a disconnect (still active, or session crosses midnight
    and hash rotates) are counted but excluded from the avg-session number,
    which is reported as "avg over closed sessions only."
    """
    res = {
        "connects": 0,
        "unique_hashes": 0,
        "peak_concurrent": 0,
        "avg_session_sec": None,
    }
    try:
        if not os.path.exists(WS_TRAFFIC_LOG):
            res["error"] = "log file missing (relay not yet emitting?)"
            return res
        unique = set()
        open_conn = {}        # iph → ts_connect
        closed_durations = []
        peak = 0
        with open(WS_TRAFFIC_LOG) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("ts", 0) < since_ts:
                    continue
                ev = rec.get("event")
                iph = rec.get("iph", "")
                ts = rec.get("ts", 0)
                active = rec.get("active", 0)
                if active > peak:
                    peak = active
                if ev == "connect":
                    res["connects"] += 1
                    unique.add(iph)
                    open_conn[iph] = ts
                elif ev == "disconnect":
                    start = open_conn.pop(iph, None)
                    if start is not None:
                        closed_durations.append(ts - start)
        res["unique_hashes"] = len(unique)
        res["peak_concurrent"] = peak
        if closed_durations:
            res["avg_session_sec"] = sum(closed_durations) / len(closed_durations)
    except Exception as e:
        res["error"] = f"parse failed: {e}"
    return res


# Lightweight tokenizer for the nginx `combined` format:
#   $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes
#   "$http_referer" "$http_user_agent"
_RE_NGINX = re.compile(
    r'^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d+) (\S+) "([^"]*)" "([^"]*)"'
)

# Heuristic bot detection on User-Agent. Conservative — only flags clearly
# non-human agents. Real abuse detection lives elsewhere; this is just for
# a "bot share" headline.
_RE_BOT_UA = re.compile(
    r'(bot|crawler|spider|scraper|wget|curl|python-requests|go-http-client'
    r'|java/|httpx|libwww|facebookexternalhit|slurp|bingpreview)',
    re.IGNORECASE
)


def _open_log(path):
    """Open a log file, handling .gz transparently. Returns a text iterator."""
    if path.endswith(".gz"):
        return gzip.open(path, "rt", errors="replace")
    return open(path, errors="replace")


def _nginx_log_paths():
    """All access logs in scope (live + rotated). Sorted oldest-first so a
    full read covers logrotate's retention window in chronological order."""
    base = NGINX_ACCESS_LOG
    out = []
    # Most distros: access.log.14.gz, .13.gz, ..., .2.gz, .1, access.log
    d = os.path.dirname(base) or "."
    name = os.path.basename(base)
    try:
        for fn in os.listdir(d):
            if fn.startswith(name + ".") or fn == name:
                out.append(os.path.join(d, fn))
    except (FileNotFoundError, PermissionError):
        return [base]
    # Sort: gz first (older), then .N numerics descending, current last.
    def key(p):
        n = os.path.basename(p)
        if n == name:
            return (2, 0)
        try:
            num = int(n.split(".")[-2 if n.endswith(".gz") else -1])
        except ValueError:
            return (1, 0)
        return (0 if n.endswith(".gz") else 1, -num)
    out.sort(key=key)
    return out


def read_nginx_access(since_ts):
    """Scan nginx access.log(s) for entries after `since_ts`. Returns
    {hits, unique_ips, bot_share, status_4xx, status_5xx, top_paths,
     top_uas}. Reads gz-rotated files transparently.

    Performance: for the 24h case we should only need access.log + maybe
    .1, totalling a few MB. For 365d we read everything in scope; that's
    rarely larger than ~100MB total on this VPS and only triggered on
    an explicit /ecashlive_status year invocation. Still seconds-fast.
    """
    res = {"hits": 0, "unique_ips": 0, "bot_share": 0.0,
           "status_4xx": 0, "status_5xx": 0, "top_paths": [], "top_uas": []}
    try:
        ip_set = set()
        bot_hits = 0
        path_counts = defaultdict(int)
        ua_counts = defaultdict(int)
        # nginx default time fmt: 30/May/2026:09:42:18 +0000
        import calendar
        mons = {m: i for i, m in enumerate(
            ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], 1)}

        def parse_time(s):
            # "30/May/2026:09:42:18 +0000"
            try:
                d, mon, ymd = s.split(" ")[0].split("/")
                y, hms = ymd.split(":", 1)
                hh, mm, ss = hms.split(":")
                return calendar.timegm((int(y), mons[mon], int(d),
                                        int(hh), int(mm), int(ss), 0, 0, 0))
            except Exception:
                return 0

        for path in _nginx_log_paths():
            try:
                with _open_log(path) as f:
                    for line in f:
                        m = _RE_NGINX.match(line)
                        if not m:
                            continue
                        ts = parse_time(m.group(2))
                        if ts < since_ts:
                            continue
                        res["hits"] += 1
                        ip_set.add(m.group(1))
                        req = m.group(3).split(" ")
                        url_path = req[1] if len(req) > 1 else "?"
                        status = int(m.group(4))
                        ua = m.group(7)
                        path_counts[url_path] += 1
                        ua_counts[ua] += 1
                        if 400 <= status < 500:
                            res["status_4xx"] += 1
                        elif status >= 500:
                            res["status_5xx"] += 1
                        if _RE_BOT_UA.search(ua):
                            bot_hits += 1
            except (PermissionError, FileNotFoundError):
                continue
        res["unique_ips"] = len(ip_set)
        if res["hits"]:
            res["bot_share"] = bot_hits / res["hits"]
        res["top_paths"] = sorted(path_counts.items(), key=lambda x: -x[1])[:5]
        res["top_uas"] = sorted(ua_counts.items(), key=lambda x: -x[1])[:3]
    except Exception as e:
        res["error"] = f"parse failed: {e}"
    return res


def read_daily_rollup(days):
    """Aggregate the last `days` entries from traffic_daily_log. Returns the
    summed totals — the file is one JSONL row per UTC day, written by the
    daily_rollup_task below."""
    out = {"days_read": 0, "hits": 0, "unique_ips_sum": 0,
           "ws_connects": 0, "ws_unique_sum": 0,
           "status_4xx": 0, "status_5xx": 0, "bot_hits": 0}
    try:
        if not os.path.exists(TRAFFIC_DAILY_LOG):
            out["error"] = "rollup not yet started (waiting for first UTC midnight)"
            return out
        rows = []
        with open(TRAFFIC_DAILY_LOG) as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
        for r in rows[-days:]:
            out["days_read"] += 1
            out["hits"] += r.get("nginx_hits", 0)
            # Unique IPs: we can only sum daily uniques — true cross-day
            # unique would need raw IPs, which we deliberately don't keep
            # past the rotation horizon. Slightly overestimated, labelled
            # as such in the report.
            out["unique_ips_sum"] += r.get("nginx_unique_ips", 0)
            out["ws_connects"] += r.get("ws_connects", 0)
            out["ws_unique_sum"] += r.get("ws_unique_hashes", 0)
            out["status_4xx"] += r.get("status_4xx", 0)
            out["status_5xx"] += r.get("status_5xx", 0)
            out["bot_hits"] += r.get("bot_hits", 0)
    except Exception as e:
        out["error"] = f"read failed: {e}"
    return out


def read_ttf_daily(days):
    """Read the last `days` lines from the relay's ttf-daily.jsonl and return
    aggregated TTF/TPS statistics. Returns dict with:
      days_read, total_samples, total_tps_weighted (avg TPS across days),
      ttf_mean_ms (weighted by samples per day),
      ttf_min_ms / ttf_max_ms (true min/max across all days)

    Weighted-mean rationale: each day's `ttf_mean_ms` is itself an average
    of N samples, so the multi-day mean is Σ(daily_mean × daily_samples) /
    Σ(daily_samples) — exact equivalent of computing mean over all samples
    combined, without needing the raw audit log.

    TPS aggregation (updated for relay v1.5.3): each row carries
    `coverage_sec` = actual observation span for that day. Multi-day TPS
    is Σsamples / Σcoverage_sec — correct even if the relay had downtime
    on some days. Rows from relay v1.5.2 or earlier lack `coverage_sec`;
    we fall back to 86400 for them (the old assumed-uptime semantics).

    Percentiles across days are NOT exposed: combining daily percentiles
    (e.g., averaging the P50s) is statistically wrong. To get accurate
    multi-day percentiles we'd need samples themselves, not summaries.
    The dashboard headline is mean + sample count anyway."""
    out = {"days_read": 0, "total_samples": 0, "ttf_mean_ms": None,
           "ttf_min_ms": None, "ttf_max_ms": None, "avg_tps": None}
    try:
        if not os.path.exists(TTF_DAILY_LOG):
            out["error"] = "rollup not yet started (waiting for first UTC midnight)"
            return out
        rows = []
        with open(TTF_DAILY_LOG) as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
        rows = rows[-days:]
        sum_n = 0
        sum_mean_x_n = 0
        sum_coverage = 0
        for r in rows:
            n = r.get("samples", 0)
            if n <= 0:
                continue
            out["days_read"] += 1
            sum_n += n
            sum_mean_x_n += r.get("ttf_mean_ms", 0) * n
            # v1.5.3-aware: prefer coverage_sec; fall back to 86400 for
            # rows produced by v1.5.2 or earlier where the field is absent.
            sum_coverage += r.get("coverage_sec", 86400)
            mn = r.get("ttf_min_ms")
            mx = r.get("ttf_max_ms")
            if mn is not None and (out["ttf_min_ms"] is None or mn < out["ttf_min_ms"]):
                out["ttf_min_ms"] = mn
            if mx is not None and (out["ttf_max_ms"] is None or mx > out["ttf_max_ms"]):
                out["ttf_max_ms"] = mx
        out["total_samples"] = sum_n
        if sum_n > 0:
            out["ttf_mean_ms"] = sum_mean_x_n / sum_n
        if sum_coverage > 0:
            # True aggregate TPS = total samples / total observation time.
            # This is the correct way to combine rates from periods of
            # different lengths; arithmetic mean of per-day TPS would
            # over-weight short (downtime) days.
            out["avg_tps"] = sum_n / sum_coverage
    except Exception as e:
        out["error"] = f"read failed: {e}"
    return out


async def daily_rollup_task():
    """Run forever. At UTC midnight (+ 2 min slack so logrotate finishes
    first), aggregate the prior day from nginx access.log and ws-traffic.log
    and append one JSONL line to traffic_daily_log. This is how we answer
    /ecashlive_status month/year despite nginx keeping only ~14 days.

    Robust: if a midnight is missed (bot down, exception), the next run
    detects the gap via the last line's `date` field and back-fills.
    """
    Path(TRAFFIC_DAILY_LOG).parent.mkdir(parents=True, exist_ok=True)

    def last_rolled_date():
        try:
            with open(TRAFFIC_DAILY_LOG) as f:
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

    def write_day(day_start_ts, day_str):
        # Read the 24h window starting at day_start_ts.
        # We use _ng / _ws subset of the existing scanners with a fixed window.
        # Cheap re-scan; cost is amortized over a day.
        next_day_ts = day_start_ts + 86400
        ng_total = {"hits": 0, "unique_ips": set(), "status_4xx": 0,
                    "status_5xx": 0, "bot_hits": 0}
        ws_total = {"connects": 0, "unique_hashes": set()}
        import calendar
        mons = {m: i for i, m in enumerate(
            ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], 1)}
        # nginx
        for p in _nginx_log_paths():
            try:
                with _open_log(p) as f:
                    for line in f:
                        m = _RE_NGINX.match(line)
                        if not m:
                            continue
                        try:
                            d, mon, ymd = m.group(2).split(" ")[0].split("/")
                            y, hms = ymd.split(":", 1)
                            hh, mm, ss = hms.split(":")
                            ts = calendar.timegm((int(y), mons[mon], int(d),
                                                  int(hh), int(mm), int(ss),
                                                  0, 0, 0))
                        except Exception:
                            continue
                        if ts < day_start_ts or ts >= next_day_ts:
                            continue
                        ng_total["hits"] += 1
                        ng_total["unique_ips"].add(m.group(1))
                        st = int(m.group(4))
                        if 400 <= st < 500:
                            ng_total["status_4xx"] += 1
                        elif st >= 500:
                            ng_total["status_5xx"] += 1
                        if _RE_BOT_UA.search(m.group(7)):
                            ng_total["bot_hits"] += 1
            except (PermissionError, FileNotFoundError):
                continue
        # ws-traffic
        try:
            with open(WS_TRAFFIC_LOG) as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    ts = rec.get("ts", 0)
                    if ts < day_start_ts or ts >= next_day_ts:
                        continue
                    if rec.get("event") == "connect":
                        ws_total["connects"] += 1
                        ws_total["unique_hashes"].add(rec.get("iph", ""))
        except FileNotFoundError:
            pass

        row = {
            "date": day_str,
            "nginx_hits": ng_total["hits"],
            "nginx_unique_ips": len(ng_total["unique_ips"]),
            "status_4xx": ng_total["status_4xx"],
            "status_5xx": ng_total["status_5xx"],
            "bot_hits": ng_total["bot_hits"],
            "ws_connects": ws_total["connects"],
            "ws_unique_hashes": len(ws_total["unique_hashes"]),
        }
        with open(TRAFFIC_DAILY_LOG, "a") as f:
            f.write(json.dumps(row) + "\n")
        logger.info(f"daily rollup written for {day_str}")

    # Catch up on any missed days at startup.
    try:
        from datetime import timezone
        today_utc = datetime.now(timezone.utc).date()
        last = last_rolled_date()
        if last:
            from datetime import date
            last_d = date.fromisoformat(last)
        else:
            # First run ever: backfill yesterday only.
            last_d = today_utc - timedelta(days=2)
        d = last_d + timedelta(days=1)
        from datetime import datetime as _datetime
        while d < today_utc:
            day_start = int(_datetime(d.year, d.month, d.day,
                                       tzinfo=timezone.utc).timestamp())
            write_day(day_start, d.isoformat())
            d += timedelta(days=1)
    except Exception as e:
        logger.warning(f"rollup startup catch-up failed: {e}")

    # Steady-state loop.
    from datetime import timezone, datetime as _datetime
    while True:
        now_utc = datetime.now(timezone.utc)
        # Next UTC midnight + 2 min slack so logrotate has finished.
        tomorrow = (now_utc + timedelta(days=1)).date()
        next_run = _datetime(tomorrow.year, tomorrow.month, tomorrow.day,
                              0, 2, 0, tzinfo=timezone.utc)
        sleep_sec = max(60, (next_run - now_utc).total_seconds())
        await asyncio.sleep(sleep_sec)
        try:
            yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1))
            day_start = int(_datetime(yesterday.year, yesterday.month,
                                       yesterday.day,
                                       tzinfo=timezone.utc).timestamp())
            write_day(day_start, yesterday.isoformat())
        except Exception as e:
            logger.warning(f"daily rollup failed: {e}")


def _fmt_ms(ms):
    if ms is None:
        return "—"
    return f"{ms/1000:.2f}s"


def _fmt_age(sec):
    if sec < 60:
        return f"{sec}s"
    if sec < 3600:
        return f"{sec//60}m{sec%60:02d}s"
    return f"{sec//3600}h{(sec%3600)//60}m"


# ─── BUILD STATUS REPORT ──────────────────────────────────────
def build_status_report() -> str:
    lines = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines.append(f"📊 <b>{NODE_NAME} Status</b>")
    lines.append(f"<i>{now}</i>\n")

    # 1. Tiến trình
    lines.append("━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("🔧 <b>1. TIẾN TRÌNH NODE</b>")
    out, _, rc = run_cmd("pgrep -f 'bitcoin-abc/bin/bitcoind'")
    if rc == 0 and out:
        pid = out.split('\n')[0]
        uptime, _, _ = run_cmd(f"ps -o etime= -p {pid}")
        cpu, _, _ = run_cmd(f"ps -o %cpu= -p {pid}")
        rss, _, _ = run_cmd(f"ps -o rss= -p {pid}")
        try:
            ram_mb = int(rss.strip()) / 1024
            lines.append(f"  ✅ Đang chạy")
            lines.append(f"  • PID    : <code>{pid}</code>")
            lines.append(f"  • Uptime : <code>{uptime.strip()}</code>")
            lines.append(f"  • CPU    : <code>{cpu.strip()}%</code>")
            lines.append(f"  • RAM    : <code>{ram_mb:,.0f} MB</code>")
        except Exception:
            lines.append(f"  ✅ Đang chạy (PID: {pid})")
    else:
        lines.append("  ❌ <b>NODE KHÔNG CHẠY!</b>")
        return "\n".join(lines)

    # 2. Phiên bản
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("📦 <b>2. PHIÊN BẢN</b>")
    ver_out, _, _ = run_cmd(f"{BITCOIND} --version")
    m = re.search(r'(\d+\.\d+\.\d+)', ver_out)
    current_ver = m.group(1) if m else "unknown"
    lines.append(f"  • Đang dùng: <code>v{current_ver}</code>")
    try:
        r = requests.get("https://download.bitcoinabc.org/", timeout=8)
        versions = re.findall(r'href="(\d+\.\d+\.\d+)/?"', r.text)
        if versions:
            latest = sorted(versions, key=lambda v: tuple(map(int, v.split('.'))))[-1]
            if latest == current_ver:
                lines.append(f"  ✅ Bản <b>MỚI NHẤT</b>")
            else:
                lines.append(f"  ⚠️ Có bản mới: <b>v{latest}</b>")
                lines.append(f"  → /{PREFIX}_update")
    except Exception:
        lines.append("  ⚠️ Không kiểm tra được bản mới")

    # 3. Blockchain
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("⛓ <b>3. BLOCKCHAIN</b>")
    chain_info = cli("getblockchaininfo")
    if chain_info:
        try:
            data = json.loads(chain_info)
            blocks = data.get("blocks", 0)
            headers = data.get("headers", 0)
            progress = data.get("verificationprogress", 0) * 100
            ibd = data.get("initialblockdownload", True)
            lines.append(f"  • Chain : <code>{data.get('chain', '?')}</code>")
            lines.append(f"  • Blocks: <code>{blocks:,}</code> / <code>{headers:,}</code>")
            if ibd:
                lines.append(f"  ⚠️ Đang sync: <code>{progress:.4f}%</code>")
            else:
                lines.append(f"  ✅ Sync 100% ({progress:.4f}%)")
        except Exception as e:
            lines.append(f"  ⚠️ Lỗi parse: {e}")
    else:
        lines.append("  ❌ RPC không phản hồi")

    # 4. Chronik
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("🔍 <b>4. CHRONIK</b>")
    out, _, rc = run_cmd(f"ss -tlnp 2>/dev/null | grep ':{CHRONIK_PORT}'")
    if rc == 0 and out:
        lines.append(f"  ✅ Port {CHRONIK_PORT}: lắng nghe")
    else:
        lines.append(f"  ❌ Port {CHRONIK_PORT}: KHÔNG lắng nghe")
    code, _, _ = run_cmd(
        f'curl -sf -o /dev/null -w "%{{http_code}}" --max-time 5 '
        f'http://127.0.0.1:{CHRONIK_PORT}/blockchain-info'
    )
    if code.strip() == "200":
        lines.append(f"  ✅ Chronik API: HTTP 200")
    else:
        lines.append(f"  ⚠️ Chronik API: HTTP {code.strip() or 'no response'}")

    # 5. Avalanche
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("⚡ <b>5. AVALANCHE</b>")
    avax = cli("getavalancheinfo")
    if avax:
        try:
            data = json.loads(avax)
            ready = data.get("ready_to_poll", False)
            net = data.get("network", {})
            lines.append(f"  • Ready: {'✅' if ready else '⚠️'} {ready}")
            lines.append(f"  • Proofs: <code>{net.get('proof_count', 0)}</code> "
                         f"(conn: {net.get('connected_proof_count', 0)})")
            lines.append(f"  • Peers : <code>{net.get('node_count', 0)}</code>")
        except Exception as e:
            lines.append(f"  ⚠️ Lỗi: {e}")
    else:
        lines.append("  ❌ Không lấy được info")

    # 6. Mạng
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("🌐 <b>6. KẾT NỐI MẠNG</b>")
    peers = cli("getconnectioncount")
    net_info = cli("getnetworkinfo")
    if peers:
        lines.append(f"  • Peers tổng: <code>{peers}</code>")
    if net_info:
        try:
            data = json.loads(net_info)
            lines.append(f"  • In/Out: <code>{data.get('connections_in', 0)}</code>/"
                         f"<code>{data.get('connections_out', 0)}</code>")
        except Exception:
            pass

    # 7. Mempool
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("💰 <b>7. MEMPOOL</b>")
    mp = cli("getmempoolinfo")
    if mp:
        try:
            data = json.loads(mp)
            mb = data.get("bytes", 0) / 1048576
            lines.append(f"  • Tx: <code>{data.get('size', 0):,}</code> ({mb:.2f} MB)")
        except Exception:
            pass

    # 8. Disk
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("💾 <b>8. DISK</b>")
    du, _, _ = run_cmd(f"du -sh {DATADIR}")
    if du:
        lines.append(f"  • Datadir: <code>{du.split()[0]}</code>")
    df, _, _ = run_cmd(f"df -h {DATADIR} | awk 'NR==2{{print $4 \" free / \" $2}}'")
    if df:
        lines.append(f"  • Disk  : <code>{df}</code>")

    # 9. Systemd
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("⚙️ <b>9. SYSTEMD</b>")
    out, _, _ = run_cmd(f"systemctl is-active {SYSTEMD_SERVICE}")
    icon = "✅" if out == "active" else "⚠️"
    lines.append(f"  {icon} {SYSTEMD_SERVICE}.service: <code>{out}</code>")
    out, _, _ = run_cmd(f"systemctl is-active {SYSTEMD_SERVICE}-recover 2>/dev/null")
    if out:
        lines.append(f"  • {SYSTEMD_SERVICE}-recover: <code>{out}</code>")

    # 10. TTF Relay (v1.4) — replaces the old "5 dòng log cuối" section.
    # Quick health-check the node-precise TTF feed; full traffic stats live
    # in the separate /ecashlive_status command.
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("📡 <b>10. TTF RELAY</b>")
    rstate, _, _ = run_cmd(f"systemctl is-active {TTF_RELAY_SERVICE}")
    ricon = "✅" if rstate == "active" else "❌"
    lines.append(f"  {ricon} {TTF_RELAY_SERVICE}.service: <code>{rstate or '?'}</code>")
    s = read_ttf_stats()
    if "error" in s:
        lines.append(f"  ⚠️ stats: <code>{escape_html(s['error'])}</code>")
    else:
        # `age` flags a stalled persistence loop (relay alive but not writing).
        # >120s = something wrong; relay persists every 60s by design.
        age = s["age_sec"]
        age_icon = "✅" if age <= 90 else "⚠️"
        lines.append(f"  {age_icon} stats file: <code>{_fmt_age(age)}</code> ago")
        lines.append(f"  • samples 24h: <code>{s['samples']:,}</code>")
        lines.append(f"  • TPS (24h)  : <code>{s['tps']:.3f}</code>")
        # v1.5.4: peak TPS / fast-lane / online — same as /ecashlive_status.
        if s.get("tps_peak_24h") is not None:
            lines.append(
                f"  • peak TPS   : <code>{s['tps_peak_24h']:.3f}</code>"
            )
        lines.append(
            f"  • TTF p10/50/90: <code>{_fmt_ms(s['p10_ms'])}</code> / "
            f"<code>{_fmt_ms(s['p50_ms'])}</code> / "
            f"<code>{_fmt_ms(s['p90_ms'])}</code>"
        )
        lines.append(f"  • TTF mean   : <code>{_fmt_ms(s['mean_ms'])}</code>")
        if s.get("pct_under_3s") is not None:
            pct = s["pct_under_3s"] * 100
            pct_str = "100%" if pct >= 99.95 else f"{pct:.1f}%"
            lines.append(f"  • &lt;3s rate  : <code>{pct_str}</code>")
        if s.get("current_clients") is not None:
            cc = int(s["current_clients"])
            lines.append(f"  • online now : <code>{cc}</code>")

    return "\n".join(lines)


# ─── HANDLERS ─────────────────────────────────────────────────
@auth_check
async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("⏳ Đang lấy thông tin...")
    try:
        report = build_status_report()
        await msg.delete()
        await send_long(update, report)
    except Exception as e:
        logger.exception("Error in cmd_status")
        await msg.edit_text(f"❌ Lỗi: <code>{escape_html(str(e))}</code>",
                            parse_mode=ParseMode.HTML)


@require_password("RESTART NODE")
async def cmd_restart(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🔄 Đang restart...")
    out, err, rc = run_cmd(f"sudo systemctl restart {SYSTEMD_SERVICE}", timeout=180)
    if rc == 0:
        await asyncio.sleep(15)
        check, _, _ = run_cmd(f"systemctl is-active {SYSTEMD_SERVICE}")
        if check == "active":
            await update.message.reply_text("✅ Restart thành công")
        else:
            await update.message.reply_text(
                f"⚠️ Status: <code>{check}</code>", parse_mode=ParseMode.HTML
            )
    else:
        await update.message.reply_text(
            f"❌ <code>{escape_html(err or out)}</code>",
            parse_mode=ParseMode.HTML
        )


@require_password("STOP NODE")
async def cmd_stop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("⏹ Đang stop...")
    out, err, rc = run_cmd(f"sudo systemctl stop {SYSTEMD_SERVICE}", timeout=180)
    if rc == 0:
        await update.message.reply_text("✅ Node đã stop")
    else:
        await update.message.reply_text(
            f"❌ <code>{escape_html(err)}</code>", parse_mode=ParseMode.HTML
        )


@require_password("START NODE")
async def cmd_start_node(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("▶️ Đang start...")
    out, err, rc = run_cmd(f"sudo systemctl start {SYSTEMD_SERVICE}", timeout=180)
    if rc == 0:
        await asyncio.sleep(15)
        await update.message.reply_text(f"✅ Đã start (kiểm tra /{PREFIX}_status)")
    else:
        await update.message.reply_text(
            f"❌ <code>{escape_html(err)}</code>", parse_mode=ParseMode.HTML
        )


@require_password("UPDATE NODE")
async def cmd_update(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "📥 Đang chạy auto_update.sh...\n<i>Có thể mất vài phút.</i>",
        parse_mode=ParseMode.HTML
    )
    if not Path(AUTO_UPDATE).exists():
        await update.message.reply_text(
            f"❌ Không tìm thấy <code>{AUTO_UPDATE}</code>",
            parse_mode=ParseMode.HTML
        )
        return
    out, err, rc = run_cmd(f"bash {AUTO_UPDATE}", timeout=1800)
    output = (out + "\n" + err).strip()
    if len(output) > 3500:
        output = "...\n" + output[-3500:]
    status = "✅ Update hoàn tất" if rc == 0 else f"⚠️ rc={rc}"
    await send_long(update, f"{status}\n\n<pre>{escape_html(output)}</pre>")


@auth_check
async def cmd_logs(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Send the last N lines of bitcoind's debug.log to the user.

    v1.5.3 fix: previously this wrapped the entire tail output in a single
    <pre>...</pre> and passed it to send_long(), which splits on line
    boundaries with no awareness of HTML tag pairing. If output exceeded
    Telegram's 4096-char limit (typical at n=50+), the first chunk opened
    <pre> without closing it and the second closed it without opening —
    Telegram replied "can't find end tag corresponding to start tag pre"
    and the bot threw BadRequest, going silent from the user's POV.

    Fix: split into chunks BEFORE wrapping, give each chunk its own complete
    <pre>...</pre> envelope. Also surface tail's stderr/rc on failure
    instead of swallowing them, so "command times out" looks different
    from "log empty"."""
    n = 30
    if context.args:
        try:
            n = min(int(context.args[0]), 200)
        except ValueError:
            pass

    out, err, rc = run_cmd(f"tail -n {n} {DEBUG_LOG}")
    if rc != 0:
        await update.message.reply_text(
            f"❌ <code>tail</code> failed (rc={rc}): "
            f"<code>{escape_html(err or 'no stderr')}</code>",
            parse_mode=ParseMode.HTML
        )
        return
    if not out:
        await update.message.reply_text("⚠️ Log rỗng")
        return

    # Telegram caps messages at 4096 chars. We reserve room for the header
    # (~80 chars), the <pre></pre> wrapper (~11 chars), and a safety margin
    # for HTML-entity expansion in escape_html (& → &amp; etc.). 3500 leaves
    # plenty for all of that.
    CHUNK_LIMIT = 3500
    escaped = escape_html(out)
    lines = escaped.split("\n")
    chunks, current = [], ""
    for line in lines:
        # +1 for the rejoined newline. If a single line is itself longer
        # than CHUNK_LIMIT (unlikely from bitcoind, but defensively), it
        # still gets its own chunk; Telegram may then complain, but at
        # least the <pre> tags will be matched within that chunk.
        if len(current) + len(line) + 1 > CHUNK_LIMIT and current:
            chunks.append(current)
            current = line + "\n"
        else:
            current += line + "\n"
    if current:
        chunks.append(current)

    total = len(chunks)
    for i, chunk in enumerate(chunks, 1):
        header = (f"<b>📝 Log ({n} dòng cuối) — Phần {i}/{total}:</b>\n\n"
                  if total > 1 else
                  f"<b>📝 Log ({n} dòng cuối):</b>\n\n")
        await update.message.reply_text(
            header + f"<pre>{chunk}</pre>",
            parse_mode=ParseMode.HTML
        )
        await asyncio.sleep(0.3)


@auth_check
async def cmd_ecashlive_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Report TTF relay + web traffic stats. Default window 24h; argument
    selects 24h/7d/30d/year. Windows past 14d read from the daily rollup file
    (nginx logrotate keeps ~14d, so longer windows are unavailable from raw
    logs by design — see daily_rollup_task)."""
    window = "24h"
    if context.args:
        w = context.args[0].lower()
        if w in ("24h", "7d", "30d", "year"):
            window = w
    msg = await update.message.reply_text(f"⏳ Đang tổng hợp ({window})...")
    try:
        report = build_ecashlive_report(window)
        await msg.delete()
        await send_long(update, report)
    except Exception as e:
        logger.exception("ecashlive_status failed")
        await msg.edit_text(
            f"❌ Lỗi: <code>{escape_html(str(e))}</code>",
            parse_mode=ParseMode.HTML
        )


@auth_check
async def cmd_ecashlive_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (
        f"<b>🌐 ecashlive.net Monitor</b>\n\n"
        f"/{ECASHLIVE_PREFIX}_status [window] — báo cáo TTF relay + web traffic\n"
        f"  window: <code>24h</code> (mặc định) | <code>7d</code> | "
        f"<code>30d</code> | <code>year</code>\n\n"
        f"<i>24h/7d: đọc trực tiếp từ ws-traffic.log + nginx access.log "
        f"(nginx giữ ~14d).\n"
        f"30d/year: đọc từ daily rollup (1 dòng/ngày, ghi lúc 00:02 UTC).</i>"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


def build_ecashlive_report(window):
    """Build the report body. window: '24h' | '7d' | '30d' | 'year'."""
    secs_map = {"24h": 86400, "7d": 7*86400, "30d": 30*86400, "year": 365*86400}
    win_sec = secs_map[window]
    now_utc = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    out = []
    out.append(f"🌐 <b>ecashlive.net — {window}</b>")
    out.append(f"<i>{now_utc}</i>\n")

    # ── TTF Relay state ───────────────────────────────────────────
    out.append("━━━━━━━━━━━━━━━━━━━━━━━")
    out.append("📡 <b>TTF RELAY</b>")
    rstate, _, _ = run_cmd(f"systemctl is-active {TTF_RELAY_SERVICE}")
    ricon = "✅" if rstate == "active" else "❌"
    out.append(f"  {ricon} service: <code>{rstate or '?'}</code>")
    # uptime via systemctl
    upt_out, _, _ = run_cmd(
        f"systemctl show {TTF_RELAY_SERVICE} -p ActiveEnterTimestamp --value")
    if upt_out:
        out.append(f"  • since: <code>{escape_html(upt_out.strip())}</code>")

    s = read_ttf_stats()
    if "error" in s:
        out.append(f"  ⚠️ stats: <code>{escape_html(s['error'])}</code>")
    else:
        age = s["age_sec"]
        age_icon = "✅" if age <= 90 else "⚠️"
        out.append(f"  {age_icon} stats file age: <code>{_fmt_age(age)}</code>")
        if s.get("warmup"):
            cov_h = s.get("coverage_sec", 0) / 3600
            win_h = s.get("window_sec", 86400) / 3600
            out.append(
                f"  ⏳ warming up: <code>{cov_h:.1f}h / {win_h:.0f}h</code>")
            out.append(f"  • samples so far: <code>{s['samples']:,}</code>")
            out.append(
                "  <i>24h metrics hidden until the ring covers a full day "
                "(fresh start / floor change / long downtime)</i>"
            )
        else:
            out.append(
                f"  • samples (24h ring): <code>{s['samples']:,}</code>")
            out.append(f"  • TPS: <code>{s['tps']:.3f}</code>")
            # v1.5.4: peak TPS — max per-minute averaged rate within 24h. A
            # single-second spike doesn't dominate this number.
            if s.get("tps_peak_24h") is not None:
                out.append(
                    f"  • peak TPS (24h): "
                    f"<code>{s['tps_peak_24h']:.3f}</code>"
                )
            out.append(
                f"  • TTF p10/50/90: <code>{_fmt_ms(s['p10_ms'])}</code> / "
                f"<code>{_fmt_ms(s['p50_ms'])}</code> / "
                f"<code>{_fmt_ms(s['p90_ms'])}</code>"
            )
            out.append(f"  • TTF mean: <code>{_fmt_ms(s['mean_ms'])}</code>")
            # v1.5.4: "fast lane" rate — share of tx finalized in <3s.
            if s.get("pct_under_3s") is not None:
                pct = s["pct_under_3s"] * 100
                # 100.0% rendered as "100%" (no decimal), else 1 decimal.
                pct_str = "100%" if pct >= 99.95 else f"{pct:.1f}%"
                out.append(f"  • % finalized &lt; 3s: <code>{pct_str}</code>")
            out.append(
                f"  <i>p10 ≈ floor (proto min ~1.34s), "
                f"p50 = typical, p90 = tail</i>"
            )
        # online now: live client count from the file (relay writes
        # len(clients) on each persist). Shown in both warmup and normal
        # states. Older relay versions omit it; get(..., None) is back-compat.
        if s.get("current_clients") is not None:
            cc = int(s["current_clients"])
            out.append(f"  • online now: <code>{cc}</code>")

    # v1.5.2: For window > 24h, read TTF history from ttf-daily.jsonl
    # (one row per UTC day, written by relay's daily_rollup_task). Mean is
    # weighted by samples/day. Percentiles across days deliberately omitted
    # (combining daily P50s isn't statistically equivalent to true multi-day
    # P50 — would need raw audit, which logrotate prunes after 14 days).
    if window != "24h":
        days = {"7d": 7, "30d": 30, "year": 365}[window]
        ttd = read_ttf_daily(days)
        if ttd.get("error"):
            out.append(
                f"  <i>TTF history ({window}): "
                f"<code>{escape_html(ttd['error'])}</code></i>"
            )
        elif ttd["days_read"] == 0:
            out.append(
                f"  <i>TTF history ({window}): chưa có ngày nào có data</i>"
            )
        else:
            out.append(f"  <b>TTF history (last {ttd['days_read']}d):</b>")
            out.append(
                f"  • samples (Σ): <code>{ttd['total_samples']:,}</code>"
            )
            out.append(f"  • avg TPS: <code>{ttd['avg_tps']:.3f}</code>")
            out.append(
                f"  • mean TTF (weighted): "
                f"<code>{_fmt_ms(ttd['ttf_mean_ms'])}</code>"
            )
            out.append(
                f"  • min / max TTF: "
                f"<code>{_fmt_ms(ttd['ttf_min_ms'])}</code> / "
                f"<code>{_fmt_ms(ttd['ttf_max_ms'])}</code>"
            )
            out.append(
                "  <i>Percentiles không tổng hợp đa ngày (cần raw samples).</i>"
            )

    # ── Web traffic ───────────────────────────────────────────────
    out.append("\n━━━━━━━━━━━━━━━━━━━━━━━")
    out.append(f"🌐 <b>WEB TRAFFIC ({window})</b>")

    # For 24h/7d we read raw logs; for 30d/year we read the rollup file.
    use_rollup = window in ("30d", "year")
    if use_rollup:
        days = 30 if window == "30d" else 365
        r = read_daily_rollup(days)
        if r.get("error"):
            out.append(f"  ⚠️ rollup: <code>{escape_html(r['error'])}</code>")
            out.append(
                "  <i>Cần đợi rollup task chạy lúc 00:02 UTC. "
                "Trong khi đó dùng /{}_status 7d.</i>".format(ECASHLIVE_PREFIX)
            )
        else:
            out.append(f"  <b>Cộng dồn {r['days_read']}d:</b>")
            out.append(f"  • nginx hits: <code>{r['hits']:,}</code>")
            out.append(
                f"  • unique IPs (Σ daily): "
                f"<code>{r['unique_ips_sum']:,}</code>"
            )
            out.append(f"  • bot hits: <code>{r['bot_hits']:,}</code>")
            if r["hits"]:
                out.append(
                    f"  • bot share: "
                    f"<code>{100*r['bot_hits']/r['hits']:.1f}%</code>"
                )
            out.append(
                f"  • errors 4xx/5xx: <code>{r['status_4xx']:,}</code> / "
                f"<code>{r['status_5xx']:,}</code>"
            )
            out.append(f"  <b>WS feed (ecashlive.net visitors):</b>")
            out.append(f"  • connects: <code>{r['ws_connects']:,}</code>")
            out.append(
                f"  • unique hashes (Σ daily): "
                f"<code>{r['ws_unique_sum']:,}</code>"
            )
            out.append(
                "  <i>Σ daily slightly overestimates true unique "
                "(salt rotates daily — privacy tradeoff).</i>"
            )
    else:
        since = int(time.time()) - win_sec
        ng = read_nginx_access(since)
        out.append("  <b>chronik1 API (nginx):</b>")
        if ng.get("error"):
            out.append(f"  ⚠️ <code>{escape_html(ng['error'])}</code>")
        else:
            out.append(f"  • hits: <code>{ng['hits']:,}</code>")
            out.append(f"  • unique IPs: <code>{ng['unique_ips']:,}</code>")
            out.append(
                f"  • bot share: <code>{100*ng['bot_share']:.1f}%</code>")
            out.append(
                f"  • errors 4xx/5xx: <code>{ng['status_4xx']:,}</code> / "
                f"<code>{ng['status_5xx']:,}</code>"
            )
            if ng["top_paths"]:
                top = ", ".join(
                    f"{escape_html(p[:30])}({c})" for p, c in ng["top_paths"][:3])
                out.append(f"  • top paths: <code>{top}</code>")

        ws = read_ws_traffic(since)
        out.append("  <b>WS feed (ecashlive.net visitors):</b>")
        if ws.get("error"):
            out.append(f"  ⚠️ <code>{escape_html(ws['error'])}</code>")
        else:
            out.append(f"  • connects: <code>{ws['connects']:,}</code>")
            out.append(
                f"  • unique hashes: <code>{ws['unique_hashes']:,}</code> "
                f"(privacy-hashed, daily salt)")
            out.append(
                f"  • peak concurrent: <code>{ws['peak_concurrent']}</code>")
            if ws["avg_session_sec"] is not None:
                out.append(
                    f"  • avg session: <code>"
                    f"{_fmt_age(int(ws['avg_session_sec']))}</code>"
                )

    return "\n".join(out)


@auth_check
async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (
        f"<b>🤖 {NODE_NAME} Bot</b>\n\n"
        f"<b>Lệnh đọc (không cần password):</b>\n"
        f"/{PREFIX}_status — Trạng thái chi tiết\n"
        f"/{PREFIX}_logs [N] — N dòng log cuối\n"
        f"/{PREFIX}_help — Lệnh này\n\n"
        f"<b>Lệnh nguy hiểm (yêu cầu password):</b>\n"
        f"/{PREFIX}_restart — Restart node\n"
        f"/{PREFIX}_stop — Stop node\n"
        f"/{PREFIX}_start — Start node\n"
        f"/{PREFIX}_update — Cập nhật version\n\n"
        f"<b>Khác:</b>\n"
        f"/cancel — Hủy lệnh đang chờ password\n"
        f"/logout — Hủy session, buộc nhập password lại\n\n"
        f"<i>📌 Sau khi nhập đúng password, "
        f"session active trong <b>{SESSION_MINUTES}</b> phút.\n"
        f"📌 Sai password <b>{MAX_ATTEMPTS}</b> lần → khóa <b>{LOCKOUT_MINUTES}</b> phút.\n"
        f"📌 Bot kiểm tra node mỗi {CHECK_INTERVAL//60} phút và alert nếu down.</i>"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


# ─── MONITORING ───────────────────────────────────────────────
async def monitor_task(application: Application):
    last_state = "unknown"
    last_relay = "unknown"
    while True:
        await asyncio.sleep(CHECK_INTERVAL)
        try:
            _, _, rc1 = run_cmd("pgrep -f 'bitcoin-abc/bin/bitcoind'", timeout=5)
            rpc = cli("getblockchaininfo", timeout=10)
            current = "up" if (rc1 == 0 and rpc) else "down"

            if last_state == "unknown":
                last_state = current
                logger.info(f"Monitor initial: {current}")
                continue

            if current != last_state:
                ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                if current == "down":
                    msg = (
                        f"🚨 <b>{NODE_NAME} DOWN!</b>\n\n<i>{ts}</i>\n\n"
                        f"Process: {'✅' if rc1 == 0 else '❌'}\n"
                        f"RPC    : {'✅' if rpc else '❌'}\n\n"
                        f"/{PREFIX}_status — chi tiết\n"
                        f"/{PREFIX}_restart — khởi động lại"
                    )
                else:
                    msg = f"✅ <b>{NODE_NAME} UP trở lại</b>\n\n<i>{ts}</i>"

                if ALERT_CHAT_ID:
                    await application.bot.send_message(
                        chat_id=ALERT_CHAT_ID, text=msg, parse_mode=ParseMode.HTML
                    )
                logger.info(f"State change: {last_state} → {current}")
                last_state = current

            # v1.5.6: lightweight, auditd-free TTF-feed health. Two cheap
            # probes the bot already knows how to do — service state + stats
            # file mtime. Only meaningful while the node is up (no node → no
            # tx → a quiet feed is expected, not a fault).
            relay_now = "unknown"
            if current == "up":
                rstate, _, _ = run_cmd(
                    f"systemctl is-active {TTF_RELAY_SERVICE}", timeout=5)
                relay_ok = (rstate == "active")
                if relay_ok:
                    try:
                        age = time.time() - os.stat(TTF_STATS_PATH).st_mtime
                        if age > RELAY_STALL_SEC:
                            relay_ok = False
                    except OSError:
                        relay_ok = False
                relay_now = "ok" if relay_ok else "stalled"

            if relay_now != "unknown":
                if last_relay == "unknown":
                    last_relay = relay_now
                    logger.info(f"Relay monitor initial: {relay_now}")
                elif relay_now != last_relay:
                    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    if relay_now == "stalled":
                        msg = (
                            f"⚠️ <b>{NODE_NAME} TTF feed STALLED</b>\n\n"
                            f"<i>{ts}</i>\n\n"
                            f"Service: <code>{rstate or '?'}</code>\n"
                            f"stats file im &gt; {RELAY_STALL_SEC}s\n\n"
                            f"/{PREFIX}_status — chi tiết"
                        )
                    else:
                        msg = (
                            f"✅ <b>{NODE_NAME} TTF feed OK trở lại</b>\n\n"
                            f"<i>{ts}</i>"
                        )
                    if ALERT_CHAT_ID:
                        await application.bot.send_message(
                            chat_id=ALERT_CHAT_ID, text=msg,
                            parse_mode=ParseMode.HTML
                        )
                    logger.info(f"Relay state change: {last_relay} → {relay_now}")
                    last_relay = relay_now
        except Exception as e:
            logger.exception(f"Monitor error: {e}")


async def post_init(application: Application):
    commands = [
        BotCommand(f"{PREFIX}_status", "Trạng thái chi tiết node"),
        BotCommand(f"{PREFIX}_restart", "Restart node (cần password)"),
        BotCommand(f"{PREFIX}_stop", "Stop node (cần password)"),
        BotCommand(f"{PREFIX}_start", "Start node (cần password)"),
        BotCommand(f"{PREFIX}_update", "Update version (cần password)"),
        BotCommand(f"{PREFIX}_logs", "Xem log gần nhất"),
        BotCommand(f"{PREFIX}_help", "Hướng dẫn"),
        BotCommand(f"{ECASHLIVE_PREFIX}_status",
                   "Traffic + TTF relay (24h/7d/30d/year)"),
        BotCommand(f"{ECASHLIVE_PREFIX}_help", "Hướng dẫn ecashlive"),
        BotCommand("cancel", "Hủy lệnh đang chờ password"),
        BotCommand("logout", "Hủy session"),
    ]
    await application.bot.set_my_commands(commands)
    asyncio.create_task(monitor_task(application))
    # v1.4: daily rollup so /ecashlive_status month/year has data past nginx
    # logrotate's ~14d retention. Runs immediately to back-fill any missed
    # days, then sleeps until UTC midnight + 2 min.
    asyncio.create_task(daily_rollup_task())
    logger.info(f"Bot ready. Prefix: '{PREFIX}'. Monitor mỗi {CHECK_INTERVAL}s.")
    if ALERT_CHAT_ID:
        try:
            await application.bot.send_message(
                chat_id=ALERT_CHAT_ID,
                text=f"🤖 <b>{NODE_NAME} Bot online</b>\n"
                     f"<i>Prefix lệnh: <code>{PREFIX}</code></i>",
                parse_mode=ParseMode.HTML
            )
        except Exception as e:
            logger.warning(f"Cannot send startup notification: {e}")


# ─── MAIN ─────────────────────────────────────────────────────
def main():
    logger.info(f"Starting bot for {NODE_NAME} (prefix='{PREFIX}')...")
    app = Application.builder().token(BOT_TOKEN).post_init(post_init).build()

    # Đăng ký lệnh với prefix động
    app.add_handler(CommandHandler(f"{PREFIX}_status", cmd_status))
    app.add_handler(CommandHandler(f"{PREFIX}_restart", cmd_restart))
    app.add_handler(CommandHandler(f"{PREFIX}_stop", cmd_stop))
    app.add_handler(CommandHandler(f"{PREFIX}_start", cmd_start_node))
    app.add_handler(CommandHandler(f"{PREFIX}_update", cmd_update))
    app.add_handler(CommandHandler(f"{PREFIX}_logs", cmd_logs))
    app.add_handler(CommandHandler(f"{PREFIX}_help", cmd_help))

    # v1.4: ecashlive monitoring commands
    app.add_handler(CommandHandler(
        f"{ECASHLIVE_PREFIX}_status", cmd_ecashlive_status))
    app.add_handler(CommandHandler(
        f"{ECASHLIVE_PREFIX}_help", cmd_ecashlive_help))

    # Lệnh chung (không prefix)
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CommandHandler("logout", cmd_logout))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("start", cmd_help))

    # Handler cho text message (để xử lý nhập password)
    app.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND, handle_password_input
    ))

    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
