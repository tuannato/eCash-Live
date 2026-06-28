# eCash Live — Technical Reference

How the eCash / Avalanche protocol concepts this project depends on actually work,
**and how this codebase consumes each one**, anchored to `file:line`.

> **Two reference docs, different jobs.** This file maps protocol concept → *this
> repo's* consumption. For the canonical, source-verified bitcoin-abc constants
> (finalization score 128, 10 ms event loop, stake/proof rules, message names, etc.)
> see **`internal/eCash_Avalanche_Technical_Reference.md`** — it is verified against
> bitcoin-abc `master` and is the authority for raw numbers. This file does **not**
> duplicate those tables; it links to them and focuses on consumption.
>
> Anchors verified 2026-06-24 against `index.html` v1.3.6 (module 7573–21004) and
> `ttf-relay.py` v1.5.6. Module line numbers drift on every web edit — re-confirm.

---

## 1. Avalanche pre-consensus & post-consensus (finality)

**Protocol.** eCash is Nakamoto Proof-of-Work with an **Avalanche** BFT overlay for
fast finality. Nodes repeatedly poll a stake-weighted random sample of peers and
accumulate per-item confidence; an item is **finalized** when confidence reaches
`AVALANCHE_FINALIZATION_SCORE = 128`. With the 10 ms event loop the theoretical
floor is ~1.34 s; real-world finality is **~2–3 s**.
- **Pre-consensus** votes on **transactions** (mainnet 2025-11-15) → a finalized tx
  cannot be double-spent.
- **Post-consensus** votes on **blocks** (mainnet 2022-09-14) → ~1-block,
  seconds-scale, reorg-proof finality.
(Full constants + corrections: `internal/eCash_Avalanche_Technical_Reference.md`.)

**How this repo consumes it.**
- The relay observes pre-consensus finality directly from the node's log: it pairs
  `Chronik: transaction <txid> added to mempool` with `[avalanche] Avalanche
  finalized tx <txid>` (`ttf-relay.py:330-333`, parsing `360`). The TTF metric *is*
  the elapsed time of pre-consensus for that tx.
- The browser observes the same lifecycle through Chronik's WebSocket: it sees a tx
  appear (mempool) and later a `TX_FINALIZED`/finalization signal, and derives a
  *perceived* TTF (`processNewTx` `index.html:10328`; finalize handling
  `~9411-9431`).
- **Post-consensus** drives the block view: blocks animate mined → polling → final
  as Avalanche locks them; block-finalized is emitted to the companion
  (`__ecBus.emit('blockfinal', …)` `index.html:9949`).
- The ~1.34 s floor is a design anchor for the relay histogram: bins start at
  `_HIST_LO_MS = 1000` so the floor bin sits just below the physical minimum and no
  resolution is wasted below it (`ttf-relay.py:274-285`).

---

## 2. Chronik indexer + chronik-client

**Protocol.** Chronik is a Rust-native indexer built into the Bitcoin ABC node. It
serves chain data plus full **SLP / ALP token state** over a unified HTTP +
WebSocket API, so wallets get address-history, token-aware UTXOs, and live tx
streams without re-parsing the chain (`index.html:6685,6702`). `chronik-client` is
the JS client library.

**How this repo consumes it.**
- The client is **self-hosted** at `vendor/chronik-client.js` (chronik-client
  **3.7.0**, see `VENDOR.md`) — no runtime CDN import. Instantiated with the fallback
  endpoint list: `new ChronikClient(CHRONIK_URLS)` (`index.html:9135`).
- `CHRONIK_URLS` (`index.html:7595`, list `7599-7604`) = `chronik.e.cash`, three
  `chronik-native*.fabien.cash`, `chronik.pay2stay.com/xec`, and the self-hosted
  `chronik1.ecashlive.net`. A `?endpoint=` URL param overrides it (`7595`); on
  startup the list is latency-probed and reordered (`~20108-20164`).
- Every host must also be in the CSP `connect-src` allowlist (`index.html:35-41`) or
  it is blocked at runtime — a deliberate anti-hijack measure (`SECURITY.md`).
- Connection health is surfaced to the companion (`__ecBus.emit('chronik', {up})`
  `index.html:9987/9993`).

Cross-check the client API against upstream `Bitcoin-ABC/bitcoin-abc`
(`modules/chronik-client`) — do not recall it from memory.

---

## 3. TTF (time-to-finality) — as THIS project computes it

This is the project's signature metric and the most invariant-heavy subsystem. There
are **two distinct numbers per transaction**, and they must never be collapsed.

### 3a. Node-precise TTF (the relay)
- bitcoind runs with `logtimemicros=1`, so every `debug.log` timestamp carries a
  6-digit microsecond fraction. TTF is then an **honest subtraction**:
  `compute_ttf_ms = (T_final − T_added)` in ms (`ttf-relay.py:399`). The only value
  dropped is a negative diff (out-of-order/rotation/skew) (`422-424`). No "debias",
  no synthetic floor — a sub-floor reading is surfaced as a real outlier, not
  rewritten (design note `404-419`).
- The relay tails the log resiliently: self-healing across inode rotation
  (`is_first_open`, `ttf-relay.py:892-894`) **and** in-place truncation
  (`size < last_size → seek(0)`, `920-924`).
- Per emitted sample it sends `{type:'ttf', txid, ttfMs, source:'node-precise', …}`
  over WebSocket (`964-970`) and appends a JSON-per-line audit log (`973`).

### 3b. Perceived TTF (the browser)
- The page measures finality on its own clock from Chronik WS events, which includes
  WebSocket + propagation latency — so it is shown immediately but treated as
  provisional (`processNewTx` `index.html:10328`; perceived push in the WS finalize
  path `~9429-9431`).

### 3c. The upgrade pipeline (Architecture D — late correction)
- **`pushTtfSample` is the only mutator** of `state.ttfSamples` (`index.html:7919`).
  Skip-or-upgrade: one sample per txid, node-precise replaces perceived, never the
  reverse (`7937-7945`). The node-precise feed handler routes through it (`8858`).
- The perceived value shows a spinner for `TTF_UPGRADE_WINDOW_MS = 3000`
  (`7902/7966`); when the node-precise value arrives within the window it replaces
  in place. Indicators: spinner only while connected + in-window
  (`hasPendingNodePreciseWait` `7998`), eye only when the feed is down (`8128`).
- Wake-safety guards (`_ttfAnchorSpansSleep` `7987`; captured-`finalizedAtMs`
  resolve `~7799-7843`; `TTF_SANITY_MAX_MS = 3_600_000` skew backstop `7870`)
  prevent the mobile-background replay from inflating TTF.
- `state.ttfSamples` is hard-capped at 200 (`7949`); only node-precise is emitted to
  the companion (`7935`).
(Full invariant list with rationale: `CLAUDE.md` §4.)

### 3d. 24h aggregate + percentiles (the relay stats ring)
- A fixed ring of 8640 ten-second buckets (`STATS_BUCKET_SEC=10`,
  `STATS_WINDOW_SEC=86400`, `ttf-relay.py:257-259`) accumulates counters per bucket —
  **O(buckets), independent of TPS** (`StatsRing` `502`, `record` O(1) `539`).
- Percentiles come from a merged per-bucket histogram via **linear interpolation
  within the containing bin** (`_hist_percentile` `ttf-relay.py:438`) — the v1.5 fix
  that removed a +3–10% upper-edge bias. P10≈protocol floor, P50≈typical,
  P90≈trust tail (`625-631`).
- `snapshot()` (`549`) emits the `stats` frame (`681-700`); during warmup it omits
  all 24h fields and sends only progress (`674-679`) so a partial window never reads
  as "24h". Coverage is epoch-based (`now − epoch_ts`), monotonic, density-independent
  (`650-664`).
- The frame feeds the bottom bar and (9 fields) the eChan companion
  (`index.html:9035` → `echan.js:2188`). The bot reads the persisted `ttf-stats.json`
  for `/ecashlive_status` (the relay duplicates this percentile/warmup math in
  `ecash_bot.py:438-591` — keep them mirrored).

---

## 4. eToken (SLP / ALP) & on-chain data relevant to the feed

**Protocol.** eCash carries token metadata and arbitrary data in `OP_RETURN`
outputs. **SLP** (V1 fungible, NFT1 GROUP/CHILD) and **ALP** are the token
standards; Chronik decodes them so clients see typed token entries rather than raw
script. **Agora** is a covenant-based on-chain DEX whose listings/buys/cancels are
identified by an `AGR0` marker in script.

**How this repo consumes it.**
- **Token rendering:** Chronik supplies `tokenId`, protocol, ticker, decimals; the
  feed formats quantities/prices from them (`~10952-10973`). Icons load from
  `icons.etokens.cash` (`TOKEN_ICON_BASE` `index.html:8171`), gated by a strict
  `^[0-9a-f]{64}$` tokenId check in `tokenIconHtml` (`8252`) and the CSP `img-src`
  allowlist (`34`). A fallback SVG renders inline so a blocked/down CDN never breaks
  the UI.
- **Agora detection:** done by inspecting inputs/outputs for the `AGR0` marker to
  classify LIST / BUY / CANCEL (`~10656-10855`); NFT list price is extracted from the
  covenant inputScript / OP_RETURN (`~10725-10795`).
- **OP_RETURN messages:** parsed from outputs and surfaced as on-chain messages /
  chat (`~10502-10869`); emitted to the companion (`__ecBus.emit('onchainmsg', …)`
  `index.html:12703`; fusion `12701`).
- **Security:** every chronik-derived string (tickers, names, addresses, OP_RETURN
  bodies) is `escapeHtml()`-escaped before `innerHTML` — an attacker can mint a token
  with HTML in its ticker for ~$1 of XEC (`SECURITY.md`).

**Units.** 1 XEC = 100 satoshis (2 decimals). In bitcoin-abc `COIN = 100,000,000
satoshis = 1,000,000 XEC` — see `internal/eCash_Avalanche_Technical_Reference.md`
for the stake-threshold arithmetic that trips people up.

---

## 5. References

- eCash / Avalanche protocol docs — <https://avalanche.cash>
- Bitcoin ABC source (canonical) — <https://github.com/Bitcoin-ABC/bitcoin-abc>
  (`modules/chronik-client`, `src/avalanche/…`)
- Block explorer — <https://explorer.e.cash>
- eCash homepage — <https://e.cash>
- In-repo: `internal/eCash_Avalanche_Technical_Reference.md` (verified constants),
  `CLAUDE.md` (invariants + workflow), `SECURITY.md` (threat model).
