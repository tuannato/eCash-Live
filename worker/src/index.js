// eCash Live — share-card Worker (P3 Stage 1)
//
// GET https://s.ecashlive.net/<txid>
//   → crawlers: HTML whose og:* describe THAT transaction
//   → people:   immediate redirect to https://ecashlive.net/flow/?tx=<txid>
//
// This exists because GitHub Pages serves identical HTML for every ?tx= and
// crawlers do not run JS, so a shared receipt could never unfurl as itself
// (documented in flow/index.html's head comment).
//
// It reuses the SAME parser the page uses (vendor/txparse.js) against the SAME
// chronik nodes, so the card and the receipt cannot disagree about a
// transaction — "two doors, one truth" applied to a third surface.

import { ChronikClient } from '../../vendor/chronik-client.js';
import { parseTransactionCore } from '../../vendor/txparse.js';
import { TXID_RE, FLOW_URL, buildCard, buildNotFoundCard, renderHtml } from './card.js';

// Same order and reasoning as flow/index.html: chronik.e.cash first (official,
// and the only one guaranteed to serve browsers), chronik1.ecashlive.net LAST
// because it is the relay node. Server-side there is no CORS constraint, but
// keeping the order identical means the Worker and the page see the same data
// from the same places.
const CHRONIK_NODES = [
  'https://chronik.e.cash',
  'https://chronik-native1.fabien.cash',
  'https://chronik-native2.fabien.cash',
  'https://chronik-native3.fabien.cash',
  'https://chronik.pay2stay.com',
];

// Bump when the card's wording or markup changes — it is part of the cache key,
// so a change takes effect immediately instead of waiting out the 24h TTL.
const CARD_VERSION = 3;   // v3: real TTF from the relay when it witnessed the tx

// The relay's own measurement, by txid. It DID witness the transaction and timed
// it against the node's microsecond log, so serving that is honest — unlike the
// Worker inventing one. Unknown (not witnessed / evicted / relay restarted) is
// answered 404 and the card simply omits the duration.
const RELAY_TTF = 'https://chronik1.ecashlive.net/ttf/';

const FETCH_TIMEOUT_MS = 4000;   // a crawler will not wait; fail to a plain card
const CACHE_FINAL_S    = 86400;  // a finalized tx never changes again
const CACHE_PENDING_S  = 15;     // still in the mempool — re-check soon
const CACHE_MISSING_S  = 30;     // unknown txid: might just be propagating

/** The relay's measured TTF for a txid, or null. Never blocks the card: a slow
 *  or missing relay just means the duration is left out. */
async function fetchRelayTtf(txid) {
  try {
    const r = await fetch(RELAY_TTF + txid, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;                       // 404 = not witnessed; say nothing
    const j = await r.json();
    const ms = j && j.ttfMs;
    return (typeof ms === 'number' && ms > 0 && ms < 3600000) ? ms : null;
  } catch { return null; }
}

/** Try each node in turn. Returns the raw chronik tx object, or null. */
async function fetchTx(txid) {
  for (const url of CHRONIK_NODES) {
    try {
      const chronik = new ChronikClient([url]);
      const d = await Promise.race([
        chronik.tx(txid),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), FETCH_TIMEOUT_MS)),
      ]);
      if (d && d.txid) return d;
    } catch {
      // Try the next node. A 404 and a dead node are indistinguishable here on
      // purpose: only after every node has failed do we call it not-found, so a
      // single unhealthy node can never turn a real tx into "not found".
    }
  }
  return null;
}

function htmlResponse(body, maxAge) {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      // Real response headers — the thing a <meta> CSP cannot do. Cheap here
      // because this Worker serves only its own tiny self-contained page.
      'content-security-policy':
        "default-src 'none'; img-src https://ecashlive.net; style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);
    const txid = decodeURIComponent(url.pathname.slice(1)).trim().toLowerCase();

    // Anything that is not a txid is not a share link — send them to Flow.
    // Gating on the hex/length shape (same regex the page uses) also means a
    // path can never be interpolated into the page.
    if (!TXID_RE.test(txid)) return Response.redirect(FLOW_URL, 302);

    // Edge cache: a finalized transaction is immutable, so this collapses
    // repeated unfurls of a popular link to one chronik read.
    //
    // CARD_VERSION is part of the key. A finalized card is cached for 24h, so
    // without it a wording fix would keep serving the OLD card for a day after
    // deploy — observed exactly that while testing the state-in-title change.
    // Bump CARD_VERSION whenever buildCard()/renderHtml() output changes.
    const cache = caches.default;
    const cacheKey = new Request(url.origin + '/' + txid + '?_v=' + CARD_VERSION, { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let card, maxAge;
    try {
      const d = await fetchTx(txid);
      if (!d) {
        card = buildNotFoundCard(txid);
        maxAge = CACHE_MISSING_S;
      } else {
        // Same parse as the page. If it throws, fall back to a card with no
        // per-tx claims rather than emitting something we did not verify.
        let tx = null;
        try { tx = parseTransactionCore(d); } catch { tx = null; }
        // Fetched in parallel with nothing else pending, and optional by design.
        const ttfMs = await fetchRelayTtf(txid);
        card = buildCard(txid, tx, d, ttfMs);
        // A mined tx is immutable -> cache hard. A final-but-unmined one WILL
        // gain a block shortly, so keep it short and let the card follow.
        maxAge = card.state === 'final-mined' ? CACHE_FINAL_S : CACHE_PENDING_S;
      }
    } catch {
      // Total failure must still land the human in Flow rather than 500.
      return Response.redirect(FLOW_URL + '?tx=' + txid, 302);
    }

    const res = htmlResponse(renderHtml(card), maxAge);
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
