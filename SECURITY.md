# Security notes — eCash Live

This document records the defensive measures baked into the HTML file and
the conventions you need to follow when editing it.

## Threat model

The app is a static, client-side dashboard. It does **not** hold or transmit
any private keys, seed phrases, or wallet credentials, and the code refuses
to accept any such input. The main risks worth defending against are:

1. **HTML injection / XSS** via chronik-supplied data (token tickers, names,
   addresses, OP_RETURN message bodies). An attacker can publish a malicious
   token genesis transaction for ~$1 of XEC and laces its ticker with HTML.
2. **Supply chain compromise** of third-party JavaScript libraries the page
   imports.
3. **Third-party privacy leakage** via fonts/CDNs that see every user's IP
   and User-Agent.

## What's in place

### Output escaping
* `escapeHtml()` is used on every chronik-derived string that flows into
  `innerHTML` (tickers, names, addresses, OP_RETURN content, txids in
  attributes).
* Addresses that drive `href`/`title` attributes go through
  `escapeHtml()` even though they're upstream-validated by
  `validateEcashAddress()`, as defense-in-depth.

### Token icon rendering
* `tokenIconHtml()` enforces a strict `^[0-9a-f]{64}$` hex check on
  `tokenId` before building the CDN URL.
* No inline `onerror=` handler. A single delegated `error` listener on
  `document` (capture phase) handles fallback for any `<img data-token-icon>`.
  This means the page can run under a CSP that forbids inline handlers.

### Content Security Policy
A `<meta http-equiv="Content-Security-Policy">` tag in `<head>` pins:

* `script-src 'self' 'sha256-...'` — only the inline module whose hash
  matches the pinned value can run. Update with `./update-csp-hash.sh`
  every time you edit the script.
* `connect-src` — explicit whitelist, HTTP + WebSocket for each host: the
  five public chronik nodes, this project's own `chronik1.ecashlive.net`,
  `api.ecashlive.net` (the Worker in `worker-api/`), and
  `api.coingecko.com`. To add your own VPS chronik subdomain, edit the
  meta tag (instructions are in the surrounding comment).
* `img-src` — `'self'`, `data:` (for SVG fallback icons), and
  `icons.etokens.cash` (token thumbnails).
* `font-src 'self'`, `style-src 'self' 'unsafe-inline'`, plus
  `base-uri 'none'` and `form-action 'none'` for hardening.
* `default-src 'none'` so anything not explicitly allowed is blocked.

> **Why some scripts are hash-pinned and others are not.** `script-src` carries
> both `'self'` and one `sha256-`. The hash exists because an *inline* script has
> no URL to match against, so without it the policy would have to allow
> `'unsafe-inline'` — which is what makes the pinning worth the maintenance.
> Same-origin **files** (`vendor/door.js`, `vendor/companion/echan.js`,
> `vendor/companion/mediacenter.js`) are covered by `'self'` and are not hashed;
> an attacker who can overwrite a file in this repo has already won, so a hash
> would add nothing there. Note this is not a relaxation: `'self'` has always
> been in the policy.

> **`frame-ancestors 'none'` is present in the meta tag but has NO effect.**
> Per the CSP spec a `<meta http-equiv>` policy ignores `frame-ancestors`
> (along with `report-uri` and `sandbox`) — those are honoured only as a real
> HTTP response header. GitHub Pages cannot set response headers, so the site
> currently has **no clickjacking protection**. The directive is left in place
> so it starts working the moment the site is served through something that can
> emit headers; until then, do not count it as a mitigation. This is a known,
> accepted gap, not an oversight.

### Self-hosted vendor libraries
`vendor/chronik-client.js`, `vendor/qrcode-generator.js`,
`vendor/qrcode.js`, and `vendor/cashtab-connect.js` are bundled locally —
no runtime imports from `esm.sh`, `cdn.jsdelivr.net`, or `unpkg.com`. See
`VENDOR.md` for the rebuild procedure. `vendor/txparse.js` and
`vendor/door.js` are this project's own code, not third-party.

`cashtab-connect.js` talks to the Cashtab browser extension by
`postMessage` only. It therefore needs no `connect-src` entry, and the
page never sees a key, a seed phrase, or a signature — it hands Cashtab a
`bip21` URI and Cashtab decides what to do with it.

### Self-hosted fonts
Space Grotesk and Fira Code are served from `vendor/fonts/`. No requests
to `fonts.googleapis.com` or `fonts.gstatic.com` — Google never sees
visitor IPs.

### URL helpers
`explorerTx`, `explorerBlock`, and `explorerAddr` apply
`encodeURIComponent` to their input, so a hypothetical chronik response
containing `"` or `<` cannot smuggle attributes into the resulting `href`.

### Lifecycle hygiene
* `setInterval`s for stats and tx cleanup pause when the tab is hidden
  and resume on `visibilitychange`.
* `pagehide` closes both the main and chat WebSockets cleanly.

### What is stored in your browser
There are no cookies, no analytics, and no session identifiers. Everything
below is `localStorage` on the site's own origin, is read only by the page
that wrote it, and is **never transmitted anywhere** — there is no backend
to send it to.

| Namespace | Holds |
|---|---|
| `ecash-live:*`, `ecash-live-*` | dashboard UI state: view, watchlist, chat draft, radar and icon toggles, price unit |
| `ecashlive:flow:*` | Flow UI state: theme, watchlist, narrator mute, first-visit flags |
| `ecashlive.echan.*` | companion state: visits, position, mute, a small stats ring |
| `ecashlive.lang` | language, shared by both doors |
| `ecashlive:pref` | which door you land on — see below |

No private key, seed phrase, or password is ever accepted or stored. Two
entries do hold a **public** eCash address you supplied — `ecashlive:flow:myaddr`
(your own wallet, used to recognise your transactions in the stream) and the
watchlists (addresses you chose to follow). They are personal in the sense that
they tie this browser to on-chain activity you care about, so they are worth
knowing about even though they are public data and stay on your device. Flow's
watchlist panel has a **My wallet ✕** control that clears the address, and it
writes an explicit empty value rather than deleting the key, so the dashboard's
one-way seed cannot quietly restore it on the next visit.

`ecashlive:pref` is the only entry that changes what you are served: it records
`flow` or `pro` and decides which door opens when you visit the site root. It is
set by your own click on either gateway, by `?door=flow` / `?door=pro`, or — for
a visitor with no history here — once, automatically, to `flow`. The rule lives
in `vendor/door.js`, shared verbatim by both pages so they cannot disagree about
it.

### Tip-jar address protection
The recipient address for the tip jar is held in a module-scoped `const`
plus `Object.defineProperty(globalThis, ..., {writable:false,
configurable:false})`, so a later reassignment cannot take effect. (This
is cosmetic against full XSS; the real defense is the CSP above.)

> **The paired integrity check no longer reaches the UI.** Every 5 s it
> compares the global against the literal and, on a mismatch, logs and hides
> `#tip-btn` — an element that was **removed** in v1.7.2, when the footer
> coffee button became the Flow gateway and tipping moved to the eChan
> quick-action (`window.__ecOpenTip`). So the detection still runs and still
> logs, but the "refuse to render" half is a no-op: the dialog stays
> reachable. Recorded here rather than quietly deleted because the fix is a
> real change (point the guard at `openTipDialog`), not a doc edit. The
> `defineProperty` lock above is unaffected and is the part that actually
> protects the address.

## Editing the file

Workflow for every release:

```bash
# 1. Edit index.html
# 2. If you edited anything inside the inline <script type="module"> block:
./update-csp-hash.sh index.html
# 3. Commit and push. GitHub Pages serves the file as-is; Cloudflare is
#    purely a DNS/CDN proxy in front and does not modify content.
```

**Do not** enable Cloudflare's auto-injected security headers — they would
ship a competing CSP that conflicts with the one in the meta tag. Keep CSP
ownership inside the HTML.

If the page renders blank after an edit, the most likely cause is a stale
script hash. Open DevTools → Console; you'll see a CSP violation message
naming the inline script. Run `update-csp-hash.sh` and reload.

## Known limitations

* CSP `style-src` allows `'unsafe-inline'` because the file contains many
  `<style>` blocks and inline `style="..."` attributes. Refactoring this
  to a strict CSP-compliant model would require extracting hundreds of
  inline styles to CSS classes — not done.
* `?endpoint=` URL parameter accepts custom chronik endpoints, but the
  CSP `connect-src` whitelist will block any host not pre-listed in the
  meta tag. This is intentional: it prevents a malicious link from
  pointing your page at a hostile chronik mirror.
* **Token icons go through `api.ecashlive.net`** (a Cloudflare Worker in
  this repo, `worker-api/`), so in the normal case `icons.etokens.cash` sees
  that Worker rather than each visitor. The Worker forwards no visitor
  headers upstream.
* **Price is still fetched directly from `api.coingecko.com`.** The proxy
  exists but CoinGecko's free API answers 429 to it — Cloudflare Workers
  egress from IPs shared by thousands of other Workers, well past the
  anonymous rate limit (measured in production). Proxying price would cost
  every visitor a wasted round-trip and buy nothing. It can be re-enabled
  with a CoinGecko API key on the Worker. Of the two, the icon CDN was the
  more revealing leak anyway: it exposes *which tokens* a visitor views,
  whereas every visitor asks the price the same question.
* **The icon gain is conditional, not absolute.** The pages deliberately
  keep the direct CDN as a fallback, so `icons.etokens.cash` remains in
  `img-src` and a visitor's browser WILL contact it directly whenever the
  Worker is unreachable. That trade was made
  knowingly: availability over privacy, the same rule the relay lives by —
  a sibling service going down must not degrade the page. Do not describe
  this as "these hosts are never contacted"; the accurate claim is "not
  contacted while the proxy is healthy".
* When the direct path is used, `icons.etokens.cash` can again correlate
  which tokens a visitor's IP is looking at, and `api.coingecko.com` sees
  the IP and User-Agent. On the dashboard the icons toggle avoids the
  requests entirely; **Flow has no such toggle** (it deliberately ships
  fewer controls).
* No third-party **code** or fonts ever load, on any path. These are
  **data** requests only.
* Proof of Writing titles are fetched through the same Worker
  (`/powr/<txid>`). That text is written by strangers, so the Worker strips
  bidi/zero-width characters and hard-caps its length, and the page renders
  it via `textContent`, never `innerHTML`.
