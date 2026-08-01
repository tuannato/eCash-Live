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
// The relay's own daily rollup, served read-only by nginx on the relay host.
// One JSONL line per UTC day since 2026-05-31: date, samples, tps, and
// ttf_{mean,p10,p50,p90,min,max}_ms. ~150 bytes/day.
const DAILY_URL = 'https://chronik1.ecashlive.net/ttf-daily.jsonl';

const HEX64 = /^[0-9a-f]{64}$/;
const ICON_SIZES = new Set(['32', '64', '128', '256', '512']);   // allowlist, not free-form

// Bump when a response SHAPE changes: cached entries live up to an hour, so
// without this the old {title,excerpt} payload would keep being served.
const API_VERSION = 3;   // v3: /history gained the per-day `series`
                         // v2: /powr returns {author} only, never the post body

const CACHE_PRICE_S = 60;      // page polls every 120s; one origin read per minute
const CACHE_ICON_S  = 604800;  // a token's icon does not change
const CACHE_POWR_S  = 3600;
const CACHE_HIST_S  = 3600;   // the rollup only changes once a day, at 00:02 UTC
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
// `size` and `id` arrive already validated and normalized by routeOf().
async function handleIcon({ size, id }) {
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
// Returns the AUTHOR HANDLE ONLY — never the post body.
//
// Measured against four real POWR transactions, and the result is why:
//   post    -> og:title "@AI_SATOSHI on Proof Of Writing", og:description = real text
//   publish -> og:title "Proof Of Writing",  og:description = THEIR MARKETING COPY
//   like    -> og:title "Proof Of Writing",  og:description = the same marketing copy
//   reply   -> og:title "ecash:qzv…cfr2 on Proof Of Writing", og:description "0.0.00005784"
//
// Only one of four carried usable content; two carried "Pay with eCash to unlock
// the full story", i.e. running their advertising inside eCash Live. So the body
// is dropped entirely — there is no code path by which it can reach the UI.
//
// What is left is small, stable and honest: WHO wrote it. WHAT it says stays
// behind the existing "Read ↗" deep-link, which sends the reader to them rather
// than reproducing them. POWR content is off-chain, so eCash Live asserting it
// would also sit badly with "honest numbers, or no numbers".
export function extractAuthor(html) {
  const pick = (prop) => {
    const re = new RegExp(
      '<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']|' +
      '<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i');
    const m = re.exec(html);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
  };
  const title = pick('og:title') || '';
  // "<who> on Proof Of Writing" — a bare "Proof Of Writing" means no author.
  const m = /^(.+?)\s+on\s+Proof\s*Of\s*Writing\s*$/i.exec(title);
  if (!m) return '';
  const who = m[1].trim();
  if (!who) return '';
  if (/^proof\s*of\s*writing$/i.test(who)) return '';   // generic
  if (/^ecash:/i.test(who)) return '';                    // a raw address is not a handle
  return who;
}

// Handles are chosen by strangers, so scrub and hard-cap even though the page
// renders this via textContent.
const BIDI_RANGES = [[0x200b,0x200f],[0x202a,0x202e],[0x2060,0x2064],[0x2066,0x2069],
                     [0xfeff,0xfeff],[0x0000,0x0008],[0x000b,0x000c],[0x000e,0x001f],[0x007f,0x007f]];
const BIDI_CTRL = new RegExp('[' + BIDI_RANGES.map(r =>
  String.fromCharCode(r[0]) + '-' + String.fromCharCode(r[1])).join('') + ']', 'g');
export function sanitize(s, max) {
  let out = String(s == null ? '' : s).replace(BIDI_CTRL, '').replace(/\s+/g, ' ').trim();
  out = out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
           .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
  out = out.replace(BIDI_CTRL, '');
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + '\u2026';
  return out;
}

// `txid` arrives already validated and lower-cased by routeOf().
async function handlePowr({ txid }) {
  try {
    const r = await upstream(`${POWR_HOST}/feed/${txid}`);
    if (!r.ok) return json({ error: 'not found' }, CACHE_FAIL_S);
    const html = (await r.text()).slice(0, 200000);   // bound the parse
    const author = sanitize(extractAuthor(html), 40);
    if (!author) return json({ error: 'no author' }, CACHE_FAIL_S);
    return json({ author }, CACHE_POWR_S);
  } catch {
    return json({ error: 'unavailable' }, CACHE_FAIL_S);
  }
}

/* ---------------------------------------------------------------- /history */
// A rolling 30-day median, computed ONCE here so both doors show the same
// number and neither has to re-implement the maths (the parity rule).
//
// Why this figure at all: a live spot reading invites "you are showing a lucky
// moment". A 30-day median from the node's own audit trail cannot be cherry
// picked, and nobody else can publish it — no explorer measures finality.
//
// Honesty: computed only from days the relay actually recorded. Fewer days than
// asked for is reported as `days`, never padded; too few and the page shows
// nothing rather than a figure built on a handful of samples.
const HIST_MIN_DAYS = 7;
export function summarizeDaily(text, window) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r.ttf_p50_ms === 'number' && r.ttf_p50_ms > 0 && typeof r.date === 'string') rows.push(r);
    } catch { /* skip a malformed line rather than fail the whole series */ }
  }
  if (rows.length < HIST_MIN_DAYS) return null;
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const recent = rows.slice(-window);
  const p50 = recent.map(r => r.ttf_p50_ms).sort((a, b) => a - b);
  const mid = p50.length % 2
    ? p50[(p50.length - 1) / 2]
    : Math.round((p50[p50.length / 2 - 1] + p50[p50.length / 2]) / 2);
  const samples = recent.reduce((a, r) => a + (typeof r.samples === 'number' ? r.samples : 0), 0);

  // The per-day series (v3). The relay has been writing p10/p50/p90/max/tps per
  // day since the rollup existed; until now only the median of the medians came
  // out, so the shape of the distribution — which is the interesting part — was
  // collected and never shown.
  //
  // Honesty rules, same as the aggregate above:
  //   - only days the relay actually recorded appear. A gap in the series IS a
  //     gap in the record; it is never filled in, and a consumer that draws a
  //     line must break it rather than interpolate across a day we did not
  //     measure.
  //   - a field missing from an older row is null, never a substituted value.
  //   - dates stay as recorded (UTC, YYYY-MM-DD) — no reformatting to a locale
  //     the reader might read as a different day.
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const series = recent.map((r) => ({
    date: r.date,
    p10Ms: num(r.ttf_p10_ms),
    p50Ms: num(r.ttf_p50_ms),
    p90Ms: num(r.ttf_p90_ms),
    maxMs: num(r.ttf_max_ms),
    samples: num(r.samples),
    tps: num(r.tps),
  }));

  return {
    days: recent.length,
    medianTtfMs: mid,
    samples,
    from: recent[0].date,
    to: recent[recent.length - 1].date,
    series,
  };
}

// `days` is the window already clamped by historyWindow() — the SAME function
// the cache key uses, so the key and the answer can never describe different
// windows.
async function handleHistory({ days }) {
  try {
    const r = await upstream(DAILY_URL);
    if (!r.ok) return json({ error: 'unavailable' }, CACHE_FAIL_S);
    const out = summarizeDaily(await r.text(), days);
    if (!out) return json({ error: 'not enough history' }, CACHE_FAIL_S);
    return json(out, CACHE_HIST_S);
  } catch {
    return json({ error: 'unavailable' }, CACHE_FAIL_S);
  }
}

/* ---------------------------------------------------------------- routing */
// The edge cache key is built from the CANONICAL route, never from the raw URL.
//
// It used to be `url.pathname + '?' + url.searchParams.toString()`, which left
// TWO ways to miss the cache on every single request — each one costing a fresh
// upstream fetch, with no rate limit anywhere in front of it:
//
//   /price?x=<random>   no handler except /history reads a query parameter, yet
//                       every distinct query string was a distinct key.
//   /price/<random>     the router dispatches on parts[0] alone, so any suffix
//                       reached the same handler under a different pathname.
//
// That is not theoretical here: handlePrice's own comment records CoinGecko
// already failing from Cloudflare's shared egress pool, and /history reads the
// relay host — so the second vector pointed at our own measurement box, the one
// asset in this project that cannot be rebuilt if a day of it is lost.
//
// Two rules keep it closed:
//   1. Validate FIRST. An invalid request 404s without touching the cache, so a
//      stream of junk can neither reach upstream nor fill the cache with
//      negative entries.
//   2. The key carries only what the handler actually reads, in normalized
//      form. /history?days=abc, ?days=0 and ?days=30 all resolve to one entry.
//
// historyWindow() is shared by the key and the handler on purpose: if they ever
// disagreed, the cache would serve one window's answer under another's key.
export function historyWindow(url) {
  const n = parseInt(url.searchParams.get('days') || '30', 10) || 30;
  return Math.min(Math.max(n, 7), 365);
}

/** Canonical route, or null when nothing legitimate matches. */
export function routeOf(url, parts) {
  switch (parts[0]) {
    case 'price':
      return parts.length === 1 ? { name: 'price', path: '/price' } : null;

    case 'icon': {
      if (parts.length !== 3) return null;
      const size = parts[1];
      const id = String(parts[2]).replace(/\.png$/i, '').toLowerCase();
      if (!ICON_SIZES.has(size) || !HEX64.test(id)) return null;
      return { name: 'icon', path: `/icon/${size}/${id}`, size, id };
    }

    case 'powr': {
      if (parts.length !== 2) return null;
      const txid = String(parts[1]).toLowerCase();
      if (!HEX64.test(txid)) return null;
      return { name: 'powr', path: `/powr/${txid}`, txid };
    }

    case 'history': {
      if (parts.length !== 1) return null;
      const days = historyWindow(url);
      return { name: 'history', path: '/history', params: { days: String(days) }, days };
    }

    default:
      return null;
  }
}

/** Stable cache key for a canonical route. Insertion order is fixed, so the
 *  same route always serializes to the same string. */
export function cacheKeyUrl(origin, route) {
  const u = new URL(origin + route.path);
  u.searchParams.set('_v', String(API_VERSION));
  for (const [k, v] of Object.entries(route.params || {})) u.searchParams.set(k, v);
  return u.toString();
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

    // Validate before the cache is involved at all (rule 1 above).
    const route = routeOf(url, parts);
    if (!route) return new Response('Not found', { status: 404 });

    const cache = caches.default;
    const key = new Request(cacheKeyUrl(url.origin, route), { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return withCors(hit, request);

    let res;
    switch (route.name) {
      case 'price':   res = await handlePrice(); break;
      case 'icon':    res = await handleIcon(route); break;
      case 'powr':    res = await handlePowr(route); break;
      case 'history': res = await handleHistory(route); break;
    }

    // Only cache what succeeded well enough to be worth reusing; failures carry
    // their own short TTL and are cached too so a miss storm cannot amplify.
    if (res.status === 200 || res.status === 404) ctx.waitUntil(cache.put(key, res.clone()));
    return withCors(res, request);
  },
};
