// eCash Live — API Worker (P3 Stage 2)
//
//   GET /price                      -> XEC/USD, proxied + cached
//   GET /icon/<size>/<tokenId>.png  -> token icon, proxied + cached
//   GET /powr/<txid>                -> Proof of Writing title, scraped + cached
//
// WHY this exists — privacy. Today every visitor's browser calls
// api.coingecko.com directly every 120s, and icons.etokens.cash sees each
// visitor's IP *and which tokens they are looking at* (disclosed in SECURITY.md,
// with no opt-out in Flow). Routed through here, those third parties see this
// Worker instead of the audience.
//
// IMPORTANT — the pages keep the DIRECT hosts as a fallback (owner's decision),
// so `api.coingecko.com` and `icons.etokens.cash` REMAIN in their CSP and the
// privacy gain is conditional: in the normal case they see nothing, but if this
// Worker is unreachable the page silently goes direct and they see the visitor
// again. That trade buys full functionality during an outage instead of a
// degraded page, which is the same rule ttf-relay.py already lives by. SECURITY.md
// states it in exactly these terms — do not upgrade the claim to "never".
//
// It is a SIBLING SERVICE: if it dies, the pages must still work.
//
// Deliberately SEPARATE from the share Worker (s.ecashlive.net): this one is hit
// by every visitor on every page load, that one only when a link is unfurled.
// Different traffic profile, and a problem here must not take share cards down.

const ORIGIN_ALLOW = ['https://ecashlive.net', 'https://www.ecashlive.net'];

const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=ecash&vs_currencies=usd';
const ICON_HOST = 'https://icons.etokens.cash';
const POWR_HOST = 'https://proofofwriting.com';

const HEX64 = /^[0-9a-f]{64}$/;
const ICON_SIZES = new Set(['32', '64', '128', '256', '512']);   // allowlist, not free-form

const CACHE_PRICE_S = 60;      // page polls every 120s; one origin read per minute
const CACHE_ICON_S  = 604800;  // a token's icon does not change
const CACHE_POWR_S  = 3600;
const CACHE_FAIL_S  = 30;      // negative caching, so a miss storm can't hammer upstream
const UPSTREAM_TIMEOUT_MS = 4000;

/** CORS only for the fetch() endpoints. <img> does not need it. */
function corsFor(request) {
  const o = request.headers.get('origin');
  return (o && ORIGIN_ALLOW.includes(o)) ? { 'access-control-allow-origin': o, 'vary': 'Origin' } : {};
}

// NOTE: deliberately NO CORS headers here. This response goes into the shared
// edge cache and the cache key is the URL only, so baking in an Origin-specific
// header serves one caller's CORS decision to everyone. Observed exactly that:
// the first request had no Origin, and the cached CORS-less copy then blocked
// the page. CORS is re-attached per request in withCors(), on both paths.
function json(body, maxAge) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}
/** Re-attach per-request CORS to a (possibly cached) response. */
function withCors(res, request) {
  const cors = corsFor(request);
  if (!Object.keys(cors).length) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

async function upstream(url, init) {
  return await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    // Never forward the visitor's headers upstream — that would defeat the whole
    // point of proxying. Only this Worker's identity goes out.
    headers: { 'user-agent': 'ecashlive-api (+https://ecashlive.net)', ...(init && init.headers) },
  });
}

/* ------------------------------------------------------------------ /price */
// Returns CoinGecko's exact shape so the page's parser (j.ecash.usd) is unchanged.
async function handlePrice() {
  // `reason` is surfaced in the error payload on purpose: a bare "unavailable"
  // told us nothing when the upstream started failing only from Cloudflare's
  // egress IPs (it worked fine from a laptop). Low-sensitivity endpoint, and an
  // error that explains itself is worth far more than one that doesn't.
  let reason = 'no-response', status = 0;
  try {
    const r = await upstream(COINGECKO);
    status = r.status;
    if (r.ok) {
      const j = await r.json();
      const p = j && j.ecash && j.ecash.usd;
      if (typeof p === 'number' && p > 0) return json({ ecash: { usd: p } }, CACHE_PRICE_S);
      reason = 'unexpected-shape';
    } else {
      reason = 'upstream-' + r.status;
    }
  } catch (e) {
    reason = 'threw:' + String((e && e.name) || e).slice(0, 40);
  }
  // Honest failure: say nothing rather than serve a stale or invented price.
  // The page already renders "—" when this is missing, and falls back to calling
  // CoinGecko directly first.
  return json({ error: 'unavailable', reason, status }, CACHE_FAIL_S);
}

/* ------------------------------------------------------------------- /icon */
// /icon/<size>/<tokenId>.png -> icons.etokens.cash/<size>/<tokenId>.png
async function handleIcon(parts) {
  const [, size, file] = parts;                       // ['icon', '128', '<id>.png']
  if (!ICON_SIZES.has(size)) return new Response('Bad size', { status: 404 });
  const id = String(file || '').replace(/\.png$/i, '').toLowerCase();
  if (!HEX64.test(id)) return new Response('Bad token id', { status: 404 });
  try {
    const r = await upstream(`${ICON_HOST}/${size}/${id}.png`);
    if (!r.ok) return new Response('Not found', { status: 404, headers: { 'cache-control': `public, max-age=${CACHE_FAIL_S}` } });
    return new Response(r.body, {
      headers: {
        'content-type': r.headers.get('content-type') || 'image/png',
        'cache-control': `public, max-age=${CACHE_ICON_S}, s-maxage=${CACHE_ICON_S}, immutable`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  } catch {
    // The page's delegated error listener swaps in its inline SVG badge.
    return new Response('Upstream failed', { status: 502, headers: { 'cache-control': `public, max-age=${CACHE_FAIL_S}` } });
  }
}

/* ------------------------------------------------------------------- /powr */
// Unblocks the v1.5.9 rejection: proofofwriting.com serves the post's og:* but no
// CORS header, so the browser could never read it. Server-side there is no CORS.
export function extractOg(html) {
  const pick = (prop) => {
    // Tolerate attribute order and single/double quotes.
    const re = new RegExp(
      '<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']|' +
      '<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i');
    const m = re.exec(html);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
  };
  return { title: pick('og:title'), description: pick('og:description') };
}

// POWR text is written by strangers and will render inside the eCash Live UI, so
// it is scrubbed and hard-capped here as well as escaped at the render site.
const BIDI_RANGES = [[0x200b,0x200f],[0x202a,0x202e],[0x2060,0x2064],[0x2066,0x2069],
                     [0xfeff,0xfeff],[0x0000,0x0008],[0x000b,0x000c],[0x000e,0x001f],[0x007f,0x007f]];
const BIDI_CTRL = new RegExp('[' + BIDI_RANGES.map(r =>
  String.fromCharCode(r[0]) + '-' + String.fromCharCode(r[1])).join('') + ']', 'g');
export function sanitize(s, max) {
  let out = String(s == null ? '' : s).replace(BIDI_CTRL, '').replace(/\s+/g, ' ').trim();
  // Undo the HTML entities that og content arrives with, then re-cap.
  out = out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
           .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
  out = out.replace(BIDI_CTRL, '');
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + '…';
  return out;
}

async function handlePowr(parts) {
  const txid = String(parts[1] || '').toLowerCase();
  if (!HEX64.test(txid)) return json({ error: 'bad txid' }, CACHE_FAIL_S);
  try {
    const r = await upstream(`${POWR_HOST}/feed/${txid}`);
    if (!r.ok) return json({ error: 'not found' }, CACHE_FAIL_S);
    const html = (await r.text()).slice(0, 200000);   // bound the parse
    const og = extractOg(html);
    const title = sanitize(og.title, 120);
    const excerpt = sanitize(og.description, 200);
    if (!title && !excerpt) return json({ error: 'no content' }, CACHE_FAIL_S);
    return json({ title, excerpt }, CACHE_POWR_S);
  } catch {
    return json({ error: 'unavailable' }, CACHE_FAIL_S);
  }
}

/* ----------------------------------------------------------------- router */
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'access-control-max-age': '86400', 'access-control-allow-methods': 'GET', ...corsFor(request) },
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    const cache = caches.default;
    const key = new Request(url.origin + url.pathname, { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return withCors(hit, request);

    let res;
    switch (parts[0]) {
      case 'price': res = await handlePrice(); break;
      case 'icon':  res = await handleIcon(parts); break;
      case 'powr':  res = await handlePowr(parts); break;
      default:      return new Response('Not found', { status: 404 });
    }

    // Only cache what succeeded well enough to be worth reusing; failures carry
    // their own short TTL and are cached too so a miss storm cannot amplify.
    if (res.status === 200 || res.status === 404) ctx.waitUntil(cache.put(key, res.clone()));
    return withCors(res, request);
  },
};
