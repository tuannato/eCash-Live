// Pure card-building logic, kept free of Workers/chronik APIs so it can be unit
// tested in plain Node. index.js owns the I/O; this file owns what the card SAYS.

export const TXID_RE = /^[0-9a-f]{64}$/;
export const FLOW_URL = 'https://ecashlive.net/flow/';
export const SITE = 'https://ecashlive.net';
export const SHARE_URL = 'https://s.ecashlive.net/';

// Same scrub as Flow (BIDI_RANGES there): direction overrides and invisibles are
// a RENDERING attack, not an escaping one, so they must be removed rather than
// encoded. Codepoints, never literal characters, so this source stays reviewable.
const BIDI_RANGES = [[0x200b,0x200f],[0x202a,0x202e],[0x2060,0x2064],[0x2066,0x2069],
                     [0xfeff,0xfeff],[0x0000,0x0008],[0x000b,0x000c],[0x000e,0x001f],[0x007f,0x007f]];
const BIDI_CTRL = new RegExp('[' + BIDI_RANGES.map(r =>
  String.fromCharCode(r[0]) + '-' + String.fromCharCode(r[1])).join('') + ']', 'g');
export function clean(s){ return String(s == null ? '' : s).replace(BIDI_CTRL, ''); }
export function esc(s){
  return clean(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const nf = new Intl.NumberFormat('en-US');
export function fmtXec(n){
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return nf.format(Math.round(n)) + ' XEC';
}
export function shortId(id){ return id ? id.slice(0, 8) + '…' + id.slice(-6) : ''; }

// Mirrors Flow's txKind() precedence exactly (agora > token > message > pay) so
// the card and the page label the same transaction the same way.
export function kindOf(tx){
  if (tx && tx.agora && tx.agora.detected) return 'trade';
  if (tx && tx.token) return 'token';
  if (tx && tx.message) return (tx.message.type === 'powr') ? 'powr' : 'msg';
  return 'pay';
}

const KIND_LABEL = {
  pay:   'A payment on eCash',
  msg:   'An on-chain message',
  powr:  'A Proof of Writing post',
  token: 'A token transfer',
  trade: 'An Agora trade',
};

/**
 * Build the per-transaction card copy.
 *
 * HONESTY — chain state mirrors the /flow/?tx= receipt contract verbatim
 * (flow/index.html maybeOpenSharedTx):
 *   final = isFinal || block.height ;  block = block.height || null
 * Anything unknown is OMITTED, never guessed.
 *
 * `ttfMs` is the RELAY's own measurement, passed in by index.js. The Worker
 * still never invents a duration — but the relay genuinely witnessed the
 * transaction and timed it against the node's microsecond log, so relaying that
 * measurement is honest. It is the same number the live page shows. When the
 * relay has no record (never witnessed, evicted from its bounded table, or
 * restarted) the duration is simply left out, exactly as before.
 *
 * SECURITY — no chain-supplied free text ever reaches the card. Message bodies
 * and token tickers are attacker-controlled (SECURITY.md: a token can be minted
 * with a chosen ticker for ~$1), and an unfurl renders under the eCash Live
 * brand in someone else's feed. So the card describes the transaction — kind,
 * amount, state — and never quotes its contents.
 */
export function buildCard(txid, tx, chainInfo, ttfMs){
  const kind = kindOf(tx);
  const amount = tx ? fmtXec(tx.valueXec) : null;
  const isFinal = !!(chainInfo && (chainInfo.isFinal || (chainInfo.block && chainInfo.block.height)));
  const block = (chainInfo && chainInfo.block && chainInfo.block.height) || null;

  // The STATE must ride in the title. X renders the title only — no description —
  // so a title of just "32,433 XEC" told an X reader nothing about finality, which
  // is the entire point of sharing the link. Verified against a real unfurl.
  const lead = (kind === 'pay' && amount) ? amount
             : (amount && kind !== 'msg' && kind !== 'powr') ? (KIND_LABEL[kind] + ' · ' + amount)
             : KIND_LABEL[kind];
  // The relay's own measurement, when it witnessed this transaction. It timed
  // the node's microsecond log, so this is the same number the live page shows,
  // not a reconstruction. Absent (never witnessed, evicted, or the relay
  // restarted) simply means the duration is left out — the card has always been
  // allowed to say less, never to guess.
  const secs = (typeof ttfMs === 'number' && ttfMs > 0 && ttfMs < 3600000)
    ? (ttfMs / 1000).toFixed(1).replace(/\.0$/, '') + 's' : null;
  const finalWord = secs ? ('final in ' + secs) : 'final';
  const stateTag = !isFinal ? 'settling'
                 : (block == null) ? (finalWord + ', not yet in a block')
                 : (finalWord + ' · block ' + nf.format(block));
  const title = lead + ' · ' + stateTag;

  // Three distinct states, not two. "Final but not yet mined" is the one that
  // actually demonstrates eCash: Avalanche settles the transaction while the next
  // block is still minutes away, so for that whole window the money is
  // irreversible without being in any block. Flow already relies on this state
  // existing (runReconcile's isFinal-only branch); the card used to fold it into
  // plain "Final" and threw the story away.
  //
  // NO FIXED DURATION. Earlier copy claimed "about two seconds", but the measured
  // live 24h median is ~3.1s and it moves. The Worker has no access to the relay
  // stats, so any number it hardcodes drifts away from the truth — the same class
  // of error as the old flat FAST_TTF_MAX_MS brag. "In seconds" is what the site's
  // own hero says (hero.body3) and is defensible at any plausible median.
  const bits = [];
  if (!isFinal) {
    bits.push('Not final yet — still settling on the eCash network.');
  } else if (block == null) {
    bits.push(secs
      ? ('Already final and irreversible after ' + secs + ' — and not in a block yet.')
      : 'Already final and irreversible — and not in a block yet.',
      'Avalanche settled it; the next block is still minutes away.');
  } else {
    bits.push('Final and irreversible, mined into block ' + nf.format(block) + '.',
      secs
        ? ('It was already settled ' + secs + ' after being sent, before this block existed.')
        : 'It was already settled seconds after being sent, before this block existed.');
  }

  return {
    kind,
    // Explicit state, so callers never have to string-match the copy. The cache
    // TTL used to be decided by description.startsWith('Final') — which silently
    // depended on wording and broke the moment the copy was reworded.
    state: !isFinal ? 'pending' : (block == null ? 'final-unmined' : 'final-mined'),
    ttfMs: secs ? ttfMs : null,
    title,
    description: bits.join(' '),
    // selfUrl = this page's own identity (og:url / canonical). It MUST be the
    // share URL: pointing it at /flow/ told Facebook and Telegram "the real page
    // is over there", so they walked to the static page and used ITS og tags.
    selfUrl: SHARE_URL + txid,
    // goto = where a PERSON is sent, via JS only.
    goto: FLOW_URL + '?tx=' + txid,
    txid,
  };
}

// Card for a txid chronik does not know (bad or expired link). Still honest:
// it says exactly that, and still lets the visitor into Flow.
export function buildNotFoundCard(txid){
  return {
    kind: 'unknown',
    state: 'missing',
    title: 'Transaction not found · eCash',
    description: 'This transaction could not be found on the eCash network. It may have been replaced before it was mined.',
    selfUrl: SHARE_URL + txid,
    goto: FLOW_URL,
    txid,
  };
}

/**
 * The page a share link serves.
 *
 * Crawlers do not run JS, so they read the og:* tags and stop. People get
 * redirected into Flow immediately — location.replace() so the share URL does
 * not land in their history as a dead end. The <noscript> link keeps it usable
 * with JS disabled.
 *
 * og:image stays the site-wide static card. A per-transaction IMAGE needs a
 * renderer (WASM + paid CPU limits) and is deliberately out of scope here.
 */
export function renderHtml(card){
  const t = esc(card.title), d = esc(card.description);
  const self = esc(card.selfUrl), go = esc(card.goto);
  // og:url and canonical are SELF-REFERENTIAL on purpose. Verified live: pointing
  // them at /flow/ made Facebook and Telegram follow through and unfurl the static
  // page's tags instead of this transaction's (X ignored them and worked). There
  // is also deliberately NO <meta http-equiv="refresh"> — crawlers do not run JS
  // but they DO follow meta refresh, which was the third thing walking them away.
  // People are redirected by script only; the visible link covers JS-off.
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<link rel="canonical" href="${self}">
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="eCash Live">
<meta property="og:url" content="${self}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${SITE}/og-card.jpg">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="eCash Flow — a live stream of eCash transactions becoming final in seconds.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${SITE}/og-card.jpg">
<body style="background:#08080F;color:#F4F5FF;font:14px system-ui,sans-serif;padding:24px">
<p>${t}</p>
<p><a href="${go}" style="color:#01A0E0">Open in eCash Flow →</a></p>
<script>location.replace(${JSON.stringify(card.goto)});</script>
</body>`;
}
