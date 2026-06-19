# CLAUDE.md — eCash Live

Single source of truth for AI-assisted work on this repo. Claude Code reads
this file automatically every session. Keep it current: update the **Version
ledger** and **Footguns** on every release.

---

## 0. Golden working rules (read first, every session)

1. **Plan → confirm → code.** Before any code change, state planned
   *kept / changed / removed* bullets + affected files/line ranges, then STOP
   for confirmation. Never code first then ask. Use Plan mode for anything
   non-trivial.
2. **Scope discipline.** Implement ONLY the change requested. Never delete,
   refactor, or "clean up" anything outside the ask — even if it looks unused.
   If something seems removable, LIST it and ask.
3. **No unverified removal.** Before concluding "nothing uses X / X is dead",
   grep X across the ENTIRE repo (index.html, ecash_bot.py, ttf-relay.py,
   vendor/companion/echan.js, vendor/companion/seed*.json), not just the file
   being edited. State which files were searched. No full-scan evidence → no
   removal.
4. **Verify before asserting.** For any "why / what mechanism" question, read
   the code and cite specific file:line BEFORE concluding. Don't guess then
   correct. If unverified, say "need to check".
5. **Classify every change** as (a) bug fix, (b) behavior change, or
   (c) feature enable/disable. Wiring/un-wiring a data path is (b)/(c) and
   always needs confirmation — never call it a bug fix.
6. **Test boundary math before shipping.** Any comparison against a window
   edge, cap, threshold, or off-by-one-prone bound: run a numeric check of the
   EXTREME inputs (empty, full, exactly-at-edge, one-past-edge) and show the
   result. Compute a derived quantity's real attainable max/min before
   comparing it to a constant.
7. **"Compiles" is not "works".** `py_compile` / `node --check` only prove
   syntax. Exercise logic with a tiny inline harness (inputs → expected
   outputs) and show the output before claiming correctness.
8. **Relay and bot duplicate math.** `ttf-relay.py` and `ecash_bot.py` both
   compute percentiles + warmup/coverage. Any change to one MUST be mirrored
   in the other — both are in this repo now, so grep and verify BOTH.
9. **Secrets.** Never print or commit real tokens, chat IDs, or passwords.
   `ecash_bot.py` holds only PLACEHOLDER defaults (`YOUR_BOT_TOKEN_HERE`,
   `123456789`, `CHANGE_THIS_PASSWORD`); the real values live in
   `~/.ecash_bot_config.json` on the VPS, which is OUTSIDE the repo and
   git-ignored. Never add that file. Before committing bot changes, grep the
   staged diff for a real Telegram token `[0-9]{8,10}:[A-Za-z0-9_-]{35}`.

---

## 1. What this project is

A live eCash (XEC) transaction dashboard at **https://ecashlive.net**.
- **Web** (`index.html` + `/vendor/`): GitHub Pages, repo
  `github.com/tuannato/eCash-Live`, DNS via Cloudflare (DNS-only, no content
  rewrite). No build step, no runtime third-party scripts.
- **Relay** (`ttf-relay.py`): asyncio service on the VPS. Tails bitcoind
  `debug.log`, pairs each tx's *added-to-mempool* + *Avalanche-finalized*
  events, computes a debiased TTF, broadcasts over WebSocket. Also writes a
  JSON-per-line audit log.
- **Bot** (`ecash_bot.py`): Telegram node-ops bot on the VPS. Status +
  password-gated restart/stop/start/update. Reads the relay's persisted stats
  file (not the WS).
- **eChan** (`vendor/companion/`): a companion "character" in the web UI that
  narrates network activity from the feed.

### Repository layout
```
index.html                      # entire web app (HTML+CSS+inline ES module)
ttf-relay.py                    # WebSocket TTF relay (deployed to VPS by pull)
ecash_bot.py                    # Telegram bot (code only; config is off-repo)
update-csp-hash.sh              # CSP hash regenerator for index.html
CNAME, favicon.ico, icon-*.png, site.webmanifest
README.md, SECURITY.md, VENDOR.md, CLAUDE.md
.gitignore                      # ignores .env + bot config + runtime files
vendor/
  chronik-client.js             # self-hosted chronik client
  qrcode.js, qrcode-generator.js
  fonts/ + fonts.css
  i18n/                         # UI translations: de es fr fil id ja ko pt-BR
                                #   ru th tr uk vi zh-CN zh-TW (15)
  companion/
    echan.js                    # eChan companion logic
    echan.css                   # NOTE: perms were -rw------- (600). GitHub
                                #   Pages / the web server must be able to READ
                                #   it or the companion 403s. Verify perms.
    seed.json + seed.<lang>.json  # eChan dialog templates (17 langs)
    sprites/                    # echan_*.webp emotion frames + manifest.json
```
`ecash_bot.py` runs on the VPS at `/home/mikazuki/ecash_bot.py`; it is tracked
here for versioning + relay↔bot mirror checks, but deployed manually (copy +
restart `ecash-bot`). Its config `~/.ecash_bot_config.json` is NOT in the repo.

---

## 2. Version ledger (UPDATE ON EVERY RELEASE)

- **ttf-relay**: v1.5.6
- **index.html**: v1.3.6  (`data-version` + `version-tip`, ~line 6594)
- **ecash_bot**: kept in sync with relay (no independent version string)
- **`_HIST_LO_MS` = 1000** in BOTH `ttf-relay.py` and `ecash_bot.py` (mirror!)

---

## 3. Architecture & data flow

```
bitcoind debug.log ─tail─► ttf-relay.py ─WS(ws://127.0.0.1:8901)─► nginx /ttf-feed ─► index.html
                                │                                                        │
                                └─ persists ttf-stats.json ─► ecash_bot.py (/status)     └─ __ecBus.emit('stats') ─► vendor/companion/echan.js
```
index.html also talks directly to public Chronik nodes (HTTP+WS) for the tx/
block/message feeds; the TTF relay only supplies finality timing.

### TTF relay invariants (do not violate)
- `pushTtfSample` is THE single entry point for `state.ttfSamples` mutations.
- skip-or-upgrade: each txid contributes 1 sample max, node-precise wins.
- Architecture D (late-correction, no buffering): samples flow immediately;
  `tx.ttfPendingUpgradeUntil` drives the spinner.
- race-finalized 999ms placeholder NEVER enters `state.ttfSamples`.
- Eye indicator only when feed disconnected/never-connected; spinner ⟳ only
  when feed connected AND in the 3s upgrade window.

---

## 4. The stats frame contract

Relay `snapshot()` emits a JSON `stats` frame in two shapes:

**Normal** (`warmup:false`) — the 24h aggregate:
`tps, ttfP10Ms, ttfP50Ms, ttfP90Ms, ttfMeanMs, sampleCount, windowSec,
tpsPeak24h, pctFinalUnder3s, tpsNow, ttfP50NowMs, coverageSec` + `currentClients`
(spliced at broadcast).

**Warmup** (`warmup:true`) — ONLY `{warmup, coverageSec, windowSec}` +
`currentClients`. All 24h fields omitted on purpose (see Footguns). Frontend
renders "—".

### eChan wiring — index.html MUST forward 9 fields
`echan.js liveVars()` reads: `tps, ttfP50Ms, tpsPeak24h, sampleCount,
ttfP10Ms, ttfP90Ms, pctFinalUnder3s, tpsNow, ttfP50NowMs`. The
`__ecBus.emit('stats', {...})` in index.html (~line 9028) must forward all 9.
Dropping any silently disables its ambient dialog lines (`fillTemplate`
returns null on a missing `{var}` → the line is skipped, no error).

---

## 5. Footguns (real bugs we hit — do not repeat)

- **tpsNow / ttfP50NowMs are NOT dead.** eChan consumes them (cadence pacing +
  liveTpsNow/liveTtfNow ambient lines). Relay emits them only in the
  non-warmup frame. DO NOT remove from the relay. (Removed once on a single-
  file grep — wrong; they live in echan.js.)
- **eChan speech volume is governed by `contentTick` cadence, NOT stats frame
  rate.** 5s frames never speak; `recordStats()` only updates state + edge
  detection. Forwarding more stats fields does NOT cause spam.
- **Warmup coverage is EPOCH-based** (`now - epoch_ts`, persisted), NOT derived
  from sample/bucket positions. Do not "simplify" back to oldest-sample — that
  reintroduces low-TPS flicker AND the off-by-one below.
- **Ring window edge off-by-one.** Oldest in-window bucket START is
  `(ring_len-1)*bucket_sec` = 86390s, one bucket short of the 86400s window.
  Any "spans the full window" test needs a ONE-BUCKET tolerance
  (`coverage < WINDOW - bucket_sec`), else the gate never flips.
- **debug.log truncation is self-healing** in `tail_log` (`size < last_size →
  seek(0)`). A daily cron (`auto_update.sh`, 03:00) can truncate it in place
  (same inode); the inode-only rotation check could not catch that — fixed in
  v1.5.6. No auditd.
- **`StartLimitIntervalSec`** belongs in `[Unit]`, not `[Service]`, in
  `ttf-relay.service` (currently misplaced → systemd ignores it; harmless).

---

## 6. CSP workflow (index.html only)

The CSP meta pins the inline module's SHA-256. ANY edit to the inline
`<script type="module">` invalidates it → page renders blank if not updated.
After editing index.html:
1. `node --check` on the extracted module (syntax).
2. `./update-csp-hash.sh index.html` (idempotent; updates the `sha256-...`
   token in the CSP meta).
3. Note the new hash in the change summary.
All external resources are self-hosted under `/vendor/`. No CDNs.

---

## 7. Deploy procedures (VPS: user `mikazuki`, host `vmi3249022`, Debian 13)

### Paths (actual)
- bitcoind log: `/home/mikazuki/.bitcoin/debug.log`
- relay: `/home/mikazuki/ttf-relay/ttf-relay.py`; stats `ttf-stats.json`;
  audit `ttf.log`; daily `ttf-daily.jsonl`
- bot: `/home/mikazuki/ecash_bot.py`; config `~/.ecash_bot_config.json`
- services: `bitcoind`, `ttf-relay`, `ecash-bot`, `nginx`
- bot command prefix: `tuannato1`; eCashLive read prefix: `ecashlive`

### Web (index.html + vendor)
Edit → `node --check` module → `./update-csp-hash.sh index.html` →
`git commit` → `git push`. GitHub Pages auto-deploys; hard-refresh to bust
cache.

### Relay
```
cp .../ttf-relay.py .../ttf-relay.py.bak.$(date +%F)
python3 -m py_compile ttf-relay.py && echo OK
sudo systemctl restart ttf-relay
journalctl -u ttf-relay -n 15 --no-pager
```

### Bot (NEVER overwrite ~/.ecash_bot_config.json)
```
cp /home/mikazuki/ecash_bot.py /home/mikazuki/ecash_bot.py.bak.$(date +%F)
python3 -m py_compile /home/mikazuki/ecash_bot.py && echo OK
sudo systemctl restart ecash-bot
journalctl -u ecash-bot -n 15 --no-pager
```
Only ONE bot instance per token (Telegram singleton). Never run
`python3 ecash_bot.py` by hand while the service is up.

---

## 8. eCash protocol / library work

For Chronik, ecash-lib, Agora, Cashtab, token/wallet flows:
- Use the **ecashskill** pack (community, alitayin): `/plugins` → install
  `ecashskill@ecashskill` (marketplace
  `github.com/alitayin/ecashskill`). Consult its SKILL.md instead of recalling
  APIs from memory.
- Cross-check important claims against upstream
  `github.com/Bitcoin-ABC/bitcoin-abc` (chronik-client:
  `modules/chronik-client`). Protocol docs: https://avalanche.cash.
- ecashskill is NOT official — verify critical claims upstream.

---

## 9. eChan content (dialog) edits

Dialog lines live in `vendor/companion/seed.json` (base) + 16
`seed.<lang>.json` translations. A line edit usually means touching MULTIPLE
language files — do not edit only `seed.json`. UI strings (not dialog) live in
`vendor/i18n/<lang>.json`. Sprites/emotions: `vendor/companion/sprites/` +
`manifest.json`.

---

## 10. Repo hygiene

- Commit small and often; each logical change = one commit. `git revert` /
  Claude Code rewind are the safety net (not `.bak` files).
- Keep a session focused on one task; `/clear` between unrelated tasks.
- `.gitignore` covers `.env`, `~/.ecash_bot_config.json` patterns, and relay
  runtime files (`ttf-stats.json`, `ttf.log`, `ttf-daily.jsonl`). Never commit
  secrets or runtime artifacts.
- `index.html` at ~21k lines is a standing risk (every web edit re-hashes the
  whole module). Long-term: extract the module to a self-hosted `/vendor/`
  file — incrementally, with git, never in one shot.
