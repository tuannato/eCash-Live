# API Worker (P3 Stage 2)

`https://api.ecashlive.net` — proxies the two third parties the pages used to
call directly, plus Proof of Writing titles.

| Route | Replaces | Cache |
|---|---|---|
| `/price` | *(built, but NOT used — see below)* | 60s |
| `/icon/<size>/<tokenId>.png` | `icons.etokens.cash` | 7d |
| `/powr/<txid>` | *(new)* — unblocks the v1.5.9 rejection | 1h |

## Why

`icons.etokens.cash` could see each visitor's IP **and which tokens they were
looking at** (SECURITY.md documents this, and Flow has no icons toggle to opt
out). Routed through here, it sees this Worker instead.

**`/price` is deployed but the pages do not use it.** CoinGecko's free API
answers **429** to this Worker: Cloudflare egresses from IPs shared by thousands
of other Workers, far past the anonymous rate limit. Measured in production —
the endpoint reports `{"reason":"upstream-429"}`. Routing price through it would
cost every visitor a wasted round-trip and buy nothing, so `flow/index.html`
calls CoinGecko directly, exactly as before Stage 2.

To enable it: get a CoinGecko **Demo** API key (free, own quota), add it as a
Worker secret, send it as `x-cg-demo-api-key`, and point `PRICE_URL` in
`flow/index.html` back at `/price`. Of the two third parties this was the less
revealing one anyway — everyone asks the price the same question, while the icon
CDN learns *which tokens you look at*.

POWR keeps its content off-chain and serves the title in `og:*` without a CORS
header, so the browser could never read it — v1.5.9 rejected the feature for
exactly that reason. Server-side there is no CORS.

## The fallback is deliberate

The pages try this Worker **first** and fall back to the direct hosts if it is
unreachable (owner's decision: availability over privacy, the same rule
`ttf-relay.py` lives by). Consequences, stated plainly:

* `api.coingecko.com` and `icons.etokens.cash` **stay in the pages' CSP**.
* The privacy gain is "not contacted while the proxy is healthy", **not**
  "never contacted". SECURITY.md says it in those words — do not upgrade it.
* Nothing here is load-bearing: price falls back to direct then to `—`, icons
  fall back to direct then to the inline SVG badge, POWR falls back to the
  generic "Proof of Writing" label.

## Separate from `worker/` on purpose

`worker/` (share cards) is hit only when a link is unfurled. This one is hit by
every visitor on every page load. Different traffic profile, and a problem here
must not take share cards down.

## Deploy

```bash
cd worker-api && npx wrangler deploy
```

`api` is the second (and only other) proxied hostname. The apex `ecashlive.net`
stays DNS-only.

## Verify after deploying

```bash
curl -s https://api.ecashlive.net/price
curl -s -D- -o /dev/null -H 'Origin: https://ecashlive.net' https://api.ecashlive.net/price | grep -i access-control
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://api.ecashlive.net/icon/64/<tokenId>.png
curl -s -o /dev/null -w '%{http_code}\n' https://api.ecashlive.net/icon/999/<tokenId>.png   # 404, size allowlist
```

CORS must echo `https://ecashlive.net` and **must not** appear for other
origins — including on a cache hit (it is applied per request, never baked into
the cached body).
