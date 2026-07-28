// Pure card-building logic, kept free of Workers/chronik APIs so it can be unit
// tested in plain Node. index.js owns the I/O; this file owns what the card SAYS.

export const TXID_RE = /^[0-9a-f]{64}$/;
export const FLOW_URL = 'https://ecashlive.net/flow/';
export const SITE = 'https://ecashlive.net';

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
 * HONESTY — mirrors the /flow/?tx= receipt contract verbatim
 * (flow/index.html maybeOpenSharedTx):
 *   final = isFinal || block.height ;  block = block.height || null ;  ttf = ALWAYS null
 * The Worker did not witness the transaction live, so it can never state a
 * time-to-finality. It states only what chronik returned, and OMITS anything it
 * does not know rather than guessing.
 *
 * SECURITY — no chain-supplied free text ever reaches the card. Message bodies
 * and token tickers are attacker-controlled (SECURITY.md: a token can be minted
 * with a chosen ticker for ~$1), and an unfurl renders under the eCash Live
 * brand in someone else's feed. So the card describes the transaction — kind,
 * amount, state — and never quotes its contents.
 */
export function buildCard(txid, tx, chainInfo){
  const kind = kindOf(tx);
  const amount = tx ? fmtXec(tx.valueXec) : null;
  const isFinal = !!(chainInfo && (chainInfo.isFinal || (chainInfo.block && chainInfo.block.height)));
  const block = (chainInfo && chainInfo.block && chainInfo.block.height) || null;

  // Title: lead with the amount when there is one, else the kind.
  const title = (kind === 'pay' && amount) ? amount
              : (amount && kind !== 'msg' && kind !== 'powr') ? (KIND_LABEL[kind] + ' · ' + amount)
              : KIND_LABEL[kind];

  const bits = [];
  bits.push(isFinal ? 'Final — irreversible.' : 'Waiting to finalize.');
  if (block != null) bits.push('Block ' + nf.format(block) + '.');
  bits.push(isFinal
    ? 'On eCash this takes about two seconds, with no confirmations to wait for.'
    : 'On eCash this takes about two seconds.');

  return {
    kind,
    title: title + ' · eCash',
    description: bits.join(' '),
    canonical: FLOW_URL + '?tx=' + txid,
    txid,
  };
}

// Card for a txid chronik does not know (bad or expired link). Still honest:
// it says exactly that, and still lets the visitor into Flow.
export function buildNotFoundCard(txid){
  return {
    kind: 'unknown',
    title: 'Transaction not found · eCash',
    description: 'This transaction could not be found on the eCash network. It may have been replaced before it was mined.',
    canonical: FLOW_URL,
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
  const t = esc(card.title), d = esc(card.description), href = esc(card.canonical);
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<link rel="canonical" href="${href}">
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="eCash Live">
<meta property="og:url" content="${href}">
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
<meta http-equiv="refresh" content="0; url=${href}">
<body style="background:#08080F;color:#F4F5FF;font:14px system-ui,sans-serif;padding:24px">
<p>${t}</p>
<p><a href="${href}" style="color:#01A0E0">Open in eCash Flow →</a></p>
<script>location.replace(${JSON.stringify(card.canonical)});</script>
</body>`;
}
