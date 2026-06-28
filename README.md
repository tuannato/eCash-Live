# eCash Live

Real-time visualizer of every transaction, block, and on-chain message on the
eCash (XEC) network — Avalanche **pre-consensus** (transaction finality in ~3s)
and **post-consensus** (block finality) shown side by side.

**Live:** <https://ecashlive.net>  ·  **Repo:** <https://github.com/tuannato/eCash-Live>

-----

## What it does

- **Live transaction feed** — every mempool tx as it arrives, with token icons,
  amounts, and sender/recipient flow.
- **Pre-consensus TTF** — measures time-to-finality for each transaction. Shows a
  client-side estimate ("perceived") immediately and silently upgrades it in place
  to a precise value when a backend measurement lands.
- **Block chain view** — blocks animating through mined → polling → final as
  Avalanche post-consensus locks them.
- **On-chain messages** — OP_RETURN content, Agora listings/buys/cancels, eToken
  (SLP/ALP) transfers, and encrypted-message markers.
- **1:1 chat** — read a wallet's on-chain message history by address.
- **Watchlist** — track addresses with friendly labels.
- **Tip jar** — send XEC via a generated BIP21 QR.
- **eChan companion** — a deterministic, offline character that narrates live
  network activity from the stats feed (no LLM at runtime).

-----

## Architecture

The frontend is a **single self-contained `index.html`** (~21,500 lines: HTML +
inline CSS + one inline ES module) — no build step, no runtime third-party scripts.
It talks directly to public eCash **Chronik** indexer nodes over HTTP + WebSocket
for the live transaction, block, and message feeds.

Node-precise finality timing is supplied by a small backend service that the app
subscribes to over WebSocket: the browser shows an immediate client-side TTF
estimate, then upgrades it in place to the precise value when the backend
measurement arrives. The backend's own deployment is out of scope for this
repository.

| Layer            | Where                                              |
|------------------|----------------------------------------------------|
| Web app          | `index.html` + `vendor/` (served by GitHub Pages)  |
| DNS / CDN proxy  | Cloudflare (DNS-only — does not modify content)    |
| Indexer          | Public eCash Chronik nodes                          |

### eChan companion (`vendor/companion/`)

A deterministic in-page character that reacts to the live feed via a small event
bus. Dialog lives in `seed.json` (base) + 16 `seed.<lang>.json` translations;
sprites in `sprites/`. It runs **outside** the page's CSP-hashed module and never
calls a network LLM.

-----

## Repository layout

```
index.html              # the entire web app (HTML + inline CSS + inline ES module)
update-csp-hash.sh      # regenerates the inline-module SHA-256 in the CSP meta tag
project-index.py        # regenerates PROJECT_INDEX.md (navigation map of the codebase)
CNAME                   # custom-domain mapping for GitHub Pages (ecashlive.net)
site.webmanifest        # PWA manifest
favicon.ico, icon-*.png # app icons + share card
README.md SECURITY.md VENDOR.md
ECASH_TECHNICAL.md      # protocol concepts + how this repo consumes them

vendor/                 # self-hosted libraries + fonts (no CDN at runtime)
  chronik-client.js     #   eCash indexer client (chronik-client 3.7.0)
  qrcode-generator.js   #   QR factory (chat BIP21)
  qrcode.js             #   QR rendering (tip jar)
  fonts.css + fonts/    #   Space Grotesk + Fira Code (woff2 subsets)
  i18n/                 #   UI string translations (15 languages)
  companion/            #   eChan companion
    echan.js echan.css  #     logic + styling (loaded outside the CSP module)
    seed*.json          #     dialog templates (base + 16 translations)
    sprites/            #     emotion frames + manifest.json
  mediacenter/          #   media center (lessons + cards)
```

-----

## Development

No toolchain, framework, or bundler is required — edit `index.html` and reload.

```bash
# Serve locally from the repo root (any static server works)
python3 -m http.server 8000
# open http://localhost:8000
```

### Custom Chronik endpoint

Append `?endpoint=https://your-node.example.com` to the URL (comma-separate for
multiple). The endpoint must also be on the CSP `connect-src` allow-list in the page
header — see the comment beside that list near the top of `index.html`. Hosts not
pre-listed are blocked at runtime by design.

### Useful URL params

| Param        | Effect                       |
|--------------|------------------------------|
| `?endpoint=` | Override the Chronik node(s) |

-----

## Editing checklist (CSP hash)

The inline module is pinned by a SHA-256 hash in the CSP meta tag. **Any edit to
the `<script type="module">` block requires regenerating it**, or the browser
refuses to run the script and the page renders blank.

```bash
# 1. Edit index.html
# 2. Syntax-check the inline module. NOTE: `node --check <(...)` and
#    `node --check /dev/stdin` FAIL on Node >= ~20 (it re-opens the pipe path).
#    Extract to a real temp file first:
python3 - <<'PY' > /tmp/_module.mjs
import re; html=open('index.html',encoding='utf-8').read()
import sys; sys.stdout.write(re.search(r'<script[^>]*type="module"[^>]*>(.*?)</script>',html,re.DOTALL).group(1))
PY
node --check /tmp/_module.mjs

# 3. Regenerate the CSP hash (idempotent; rewrites the sha256-... token):
./update-csp-hash.sh index.html

# 4. Commit + push. GitHub Pages serves the file as-is; hard-refresh to bust cache.
```

> If the page renders blank after an edit, the integrity hash is stale — re-run
> `update-csp-hash.sh` and reload (DevTools console will show a CSP violation).

-----

## Deploy

Pushing to the repo's default branch deploys the web app via **GitHub Pages**.
**Cloudflare** sits in front as **DNS-only** (no content rewrite). Do **not** enable
Cloudflare's auto-injected security headers — they would ship a competing CSP that
conflicts with the one in the meta tag.

-----

## Conventions

- **Single entry point for state** — TTF samples are only ever mutated through
  `pushTtfSample`; keep it that way so the upgrade logic stays consistent.
- **Bounded memory** — every cache, set, and sample buffer has a hard cap. Prefer
  O(1) approaches; flag anything that grows with throughput.
- **Self-hosted everything** — no runtime imports from public CDNs and no
  third-party fonts. Rebuild vendored assets per `VENDOR.md`.
- **Dense comments** — explain *why*, referencing the decision behind the code.
- **Secrets** — never commit tokens or keys; the app holds no private keys and
  refuses wallet credentials by design.

See **SECURITY.md** for the full editor conventions and **VENDOR.md** for the
dependency rebuild procedure.

-----

## Tech & data sources

- **eCash / Chronik** — indexer client (`chronik-client` 3.7.0) and live feeds
- **CoinGecko** — XEC/USD price (`api.coingecko.com`)
- Fonts: Space Grotesk, Fira Code (self-hosted)

## Links

- eCash homepage — <https://e.cash>
- eCash / Avalanche protocol docs — <https://avalanche.cash>
- Block explorer — <https://explorer.e.cash>
