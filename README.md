# eCash Live

Real-time visualizer of every transaction, block, and on-chain message on the
eCash (XEC) network — Avalanche **pre-consensus** (transaction finality in ~3s)
and **post-consensus** (block finality) shown side by side.

**Live:** <https://ecashlive.net>

-----

## What it does

- **Live transaction feed** — every mempool tx as it arrives, with token icons,
  amounts, and sender/recipient flow.
- **Pre-consensus TTF** — measures time-to-finality for each transaction. Uses a
  node-precise feed when available and falls back to a client-side estimate
  otherwise, upgrading in place when the precise value lands.
- **Block chain view** — blocks animating through mined → polling → final as
  Avalanche post-consensus locks them.
- **On-chain messages** — OP_RETURN content, Agora listings/buys/cancels, and
  encrypted message markers.
- **1:1 chat** — read a wallet’s on-chain message history by address.
- **Watchlist** — track addresses with friendly labels.
- **Tip jar** — send XEC via a generated BIP21 QR.

-----

## Architecture

The frontend is a **single self-contained `index.html`** — one inline ES module,
no build step, no runtime third-party scripts. It talks directly to public
Chronik indexer nodes over HTTP + WebSocket and to an optional self-hosted node.

```
  Chronik nodes ──(HTTP + WS)──┐
                               ├──→  index.html  ──→  browser UI
  TTF relay (WS) ──────────────┘
```

|Layer          |Where                                          |
|---------------|-----------------------------------------------|
|Web app        |`index.html` (served by GitHub Pages)          |
|DNS / CDN proxy|Cloudflare (DNS only — does not modify content)|
|Indexer        |Public Chronik nodes + self-hosted node        |
|TTF feed       |`ttf-relay.py` on the VPS                      |

### TTF relay (`ttf-relay.py`)

A small asyncio service that tails Bitcoin ABC’s debug log, pairs each
transaction’s *added-to-mempool* and *Avalanche-finalized* events, computes a
debiased time-to-finality, and broadcasts the result over WebSocket to the web
app. Every emitted sample is also written to a JSON-per-line audit log.

-----

## Repository layout

```
index.html              # the entire web app (HTML + CSS + inline ES module)
ttf-relay.py            # WebSocket TTF relay (runs on the VPS)
site.webmanifest        # PWA manifest
icon32 / icon180 /
icon192 / icon512.png   # app icons
CNAME                   # custom-domain mapping for GitHub Pages
vendor/                 # self-hosted libraries + fonts (no CDN at runtime)
  chronik-client.js     #   eCash indexer client
  qrcode-generator.js   #   QR factory (chat BIP21)
  qrcode.js             #   QR rendering (tip jar)
  fonts.css + fonts/    #   Space Grotesk + Fira Code (woff2 subsets)
SECURITY.md             # security conventions for editors
VENDOR.md               # how to rebuild the vendored libraries/fonts
```

-----

## Development

No toolchain, framework, or bundler is required for normal work — edit
`index.html` and reload.

```bash
# Serve locally from the repo root (any static server works)
python3 -m http.server 8000
# open http://localhost:8000
```

### Custom Chronik endpoint

Append `?endpoint=https://your-node.example.com` to the URL (comma-separate for
multiple). The endpoint must be on the connection allow-list in the page header;
see the comment beside that list in `index.html` for how to add one.

### Useful URL params

|Param       |Effect                      |
|------------|----------------------------|
|`?endpoint=`|Override the Chronik node(s)|

-----

## Editing checklist

The inline module is pinned by an integrity hash in the page header. **Any edit
to the script block requires regenerating it**, or the page will refuse to run:

```bash
# 1. Edit index.html
# 2. If you touched anything inside the inline <script type="module"> block:
./update-csp-hash.sh index.html
# 3. Quick sanity check, then commit + push:
node --check <(sed -n '/<script type="module">/,/<\/script>/p' index.html)
```

GitHub Pages serves the file as-is; pushing to the default branch deploys.

> Tip: if the page renders blank after an edit, the integrity hash is stale —
> re-run `update-csp-hash.sh` and reload.

-----

## Conventions

- **Single entry point for state** — TTF samples are only ever mutated through
  `pushTtfSample`; keep it that way so the upgrade logic stays consistent.
- **Bounded memory** — every cache, set, and sample buffer has a hard cap.
  Prefer O(1) approaches; flag anything that grows with throughput.
- **Self-hosted everything** — no runtime imports from public CDNs and no
  third-party fonts. Rebuild vendored assets per `VENDOR.md`.
- **Dense comments** — explain *why*, referencing the decision behind the code.
- **Secrets** — never commit tokens or keys; the app holds no private keys and
  refuses wallet credentials by design.

See **SECURITY.md** for the full set of editor conventions and **VENDOR.md** for
the dependency rebuild procedure.

-----

## Tech & data sources

- **eCash / Chronik** — indexer client and live feeds
- **Bitcoin ABC** — node software providing the Avalanche events the relay reads
- **CoinGecko** — XEC/USD price
- Fonts: Space Grotesk, Fira Code (self-hosted)

## Links

- eCash homepage — <https://e.cash>
- eCash protocol docs — <https://avalanche.cash>
- Block explorer — <https://explorer.e.cash>
