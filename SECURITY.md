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
* `connect-src` — explicit whitelist of the five public chronik nodes
  plus `api.coingecko.com`. To add your own VPS chronik subdomain, edit
  the meta tag (instructions are in the surrounding comment).
* `img-src` — `'self'`, `data:` (for SVG fallback icons), and
  `icons.etokens.cash` (token thumbnails).
* `font-src 'self'`, `style-src 'self' 'unsafe-inline'`, plus
  `base-uri 'none'` and `form-action 'none'` for hardening.
* `default-src 'none'` so anything not explicitly allowed is blocked.

> **`frame-ancestors 'none'` is present in the meta tag but has NO effect.**
> Per the CSP spec a `<meta http-equiv>` policy ignores `frame-ancestors`
> (along with `report-uri` and `sandbox`) — those are honoured only as a real
> HTTP response header. GitHub Pages cannot set response headers, so the site
> currently has **no clickjacking protection**. The directive is left in place
> so it starts working the moment the site is served through something that can
> emit headers; until then, do not count it as a mitigation. This is a known,
> accepted gap, not an oversight.

### Self-hosted vendor libraries
`vendor/chronik-client.js`, `vendor/qrcode-generator.js`, and
`vendor/qrcode.js` are bundled locally — no runtime imports from
`esm.sh`, `cdn.jsdelivr.net`, or `unpkg.com`. See `VENDOR.md` for the
rebuild procedure.

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

### Tip-jar address protection
The recipient address for the tip jar is held in a module-scoped `const`
plus `Object.defineProperty(globalThis, ..., {writable:false,
configurable:false})`. A 5-second integrity check hides the tip button
if either is tampered with. (This is cosmetic against full XSS; the
real defense is the CSP above.)

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
