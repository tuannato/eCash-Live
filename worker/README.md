# share-card Worker (P3 Stage 1)

Serves `https://s.ecashlive.net/<txid>` — a per-transaction unfurl card for
crawlers, and an immediate redirect into Flow for people.

## Why this exists

GitHub Pages serves byte-identical HTML for every `?tx=<txid>`, and crawlers do
not run JavaScript. So a shared receipt could never unfurl as *itself* — the
limitation is documented in `flow/index.html`'s head comment. Sharing a receipt
is Flow's most natural growth vector, and it was the one thing static hosting
genuinely could not do.

## Why a subdomain and not a proxy

`ecashlive.net` **stays DNS-only**. Cloudflare never sits in front of ordinary
visitors, sees none of their traffic, and cannot touch the CSP-pinned pages.
`s.ecashlive.net` is the only proxied hostname.

This Worker is a *sibling service*, held to the same rule as `ttf-relay.py`: if
it is down, nothing on the main site breaks. A share link stops unfurling nicely;
the `/flow/?tx=` receipt it points at keeps working, and links already shared
keep resolving because `?tx=` is unchanged.

## What it guarantees

**Honesty** — mirrors the `?tx=` receipt contract verbatim
(`flow/index.html` → `maybeOpenSharedTx`):

| | |
|---|---|
| `final` | `isFinal \|\| block.height` |
| `block` | `block.height`, else omitted entirely |
| **TTF** | **always absent** — the Worker did not witness the transaction, so it can never state one |

Anything unknown is **omitted**, never guessed. It reuses `vendor/txparse.js` —
the same parser the page uses, against the same chronik nodes in the same order —
so the card and the receipt cannot disagree about a transaction.

**Security** — no chain-supplied free text ever reaches the card. Message bodies
and token tickers are attacker-controlled (a token can be minted with a chosen
ticker for ~$1, per `SECURITY.md`), and an unfurl renders under the eCash Live
brand in someone else's feed. The card therefore describes the transaction —
kind, amount, state — and never quotes its contents. The path is gated on
`^[0-9a-f]{64}$` before anything is interpolated.

## The card must be self-referential (learned in production)

The first deploy unfurled correctly on X but showed Flow's *static* tags on
Facebook and Telegram. Three things in the page were pointing crawlers away:

```html
<link rel="canonical" href=".../flow/?tx=…">        <!-- "the real page is over there" -->
<meta property="og:url" content=".../flow/?tx=…">   <!-- the card's identity -->
<meta http-equiv="refresh" content="0; url=…">      <!-- crawlers DO follow this -->
```

Facebook and Telegram obeyed all three, walked to `/flow/`, and unfurled the
static page. X ignored them, which is why it looked fine.

So: **`og:url` and `canonical` point at the share URL itself**, and there is
**no meta refresh** — crawlers do not run JavaScript, but they do follow a meta
refresh. People are redirected by `location.replace()` only, with the visible
link as the JS-off fallback. Do not "restore" either of these.

## Deploy

```bash
npm install -g wrangler     # or use npx wrangler
wrangler login
cd worker && wrangler deploy
```

Then add DNS for `s` on `ecashlive.net`. That record is the **only** one that
should be proxied (orange cloud) — leave the apex DNS-only.

## Verify after deploying

```bash
# 1. a real, finalized txid -> per-tx og:title, and NO seconds anywhere
curl -s https://s.ecashlive.net/<txid> | grep -E 'og:(title|description)'

# 2. an unknown txid -> honest "not found", no invented amount
curl -s https://s.ecashlive.net/0000000000000000000000000000000000000000000000000000000000000000 | grep og:title

# 3. a non-txid path -> 302 into Flow
curl -sI https://s.ecashlive.net/nonsense | head -2

# 4. a human lands on the receipt
#    open the URL in a browser: it should replace itself with /flow/?tx=<txid>
```

Then unfurl-test a real link on the platforms that matter (Telegram, X,
Slack/Discord) — each caches aggressively, so test with a fresh txid.

## Not in scope here

Per-transaction `og:image`. That needs image generation at the edge (a WASM
renderer and the paid CPU tier); the card currently uses the site-wide static
`og-card.jpg`. Text-only unfurls already carry the per-tx facts.
