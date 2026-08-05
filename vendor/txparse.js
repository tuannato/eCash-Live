// =============================================================================
// vendor/txparse.js — shared eCash transaction-understanding module (ESM)
// =============================================================================
// The "most expensive knowledge in the repo" (OP_RETURN protocol parsing +
// Agora BUY/LIST/RELIST/CANCEL classification + ALP/SLP-NFT price recovery,
// corpus-verified over 13 days / 6,174 Agora txs) extracted VERBATIM from
// index.html's inline module so more than one page can consume it.
//
// Debt-repayment strategy (FLOW_DESIGN.md direction g): the Flow lite interface
// (/flow/) is the FIRST consumer. The neo dashboard (index.html) keeps its own
// inline copy untouched for now — switching neo over to this module is a
// separate, later release so there is ZERO regression risk while the module
// stabilizes. That means the logic below is deliberately DUPLICATED with
// index.html today; when neo adopts this file, delete the inline copy there.
//
// PURE ONLY. No DOM, no `state`, no rendering, no network. `parseTransactionCore`
// is `parseTransaction` (index.html) with exactly two things removed:
//   1. the `__ecBus.emit('bigtx', …)` side effect (a neo companion signal), and
//   2. the async `tryFetchTokenInfo` token-icon enrichment closure (which is
//      DOM/network coupled). Consumers do their own token-info enrichment using
//      `tx.token.tokenId` when/if they render token cards.
// Everything else is copied byte-for-byte to stay faithful to the corpus proof.
//
// Keep in sync with index.html until neo adopts this module. Any change to the
// Agora/price/OP_RETURN logic in one place MUST be mirrored in the other.
// =============================================================================

// ---- LOKAD prefixes (4 bytes hex) — source: ecash-herald constants/lokad.js ----
export const LOKAD = {
  CASHTAB_MSG:    '00746162',  // \x00tab — Cashtab Msg
  CASHTAB_ENC:    '6361736d',  // casm — encrypted Cashtab (legacy)
  ALIAS:          '2e786563',  // .xec — Alias registration
  AIRDROP:        '64726f70',  // drop — Token airdrop
  AGORA:          '41475230',  // AGR0
  ECASHCHAT_TX:   '63686174',  // chat — eCashChat message
  ECASHCHAT_AUTH: '61757468',  // auth — eCashChat authentication
  PAYBUTTON:      '50415900',  // PAY\x00 — PayButton tx
  PAYWALL:        '70617977',  // payw — Paywall tx
  CASHFUSION:     '46555a00',  // FUZ\x00 — CashFusion
  ARTICLE:        '626c6f67',  // blog — Article/Blog reply
  POWR:           '504f5752',  // POWR — Proof of Writing (proofofwriting.com)
};

// =============================================================================
// MESSAGE_LOKADS — the LOKAD ids whose branch below can return a non-null
// `text`, i.e. the only ids worth walking when searching for something a human
// wrote. Everything else costs full tx-object bandwidth to fetch and yields
// nothing searchable.
//
// IN (6), with the field each one's text comes from:
//   00746162  Cashtab Msg   msgText
//   2e786563  Alias         aliasName
//   64726f70  Airdrop       note
//   63686174  eCashChat     reply / post / body
//   50415900  PayButton     data payload
//   626c6f67  Article       title
//
// Alias and PayButton were BOTH unreachable until 2026-08-04b: their specs
// mandate a bare OP_0 version field, readAllPushes stops at the first bare
// opcode, and so neither branch ever saw a push. The parity harness below is
// what caught it — it is the whole reason this table is checked rather than
// trusted. Both branches now use readScriptItems and keep positions; see them
// for the details, including PayButton's second, previously masked, field-order
// bug. **neo's inline copy still carries both bugs** and is fixed by adopting
// this file, not by patching it a second time.
//
// OUT (6), textless by construction — do NOT "optimise" them back in:
//   6361736d  Cashtab Encrypted  no plaintext exists
//   41475230  Agora              covenant data; the branch returns null
//   61757468  eCashChat Auth     no text
//   70617977  Paywall            no text
//   46555a00  CashFusion         no text
//   504f5752  Proof of Writing   content is OFF chain; the script holds hashes
// (SLP 534c5000 / ALP 534c5032 are token markers, also textless.)
//
// THIS TABLE IS DECLARED, NOT DERIVED — and that is deliberate. Deriving it at
// runtime was tried and does not work: a probe payload only satisfies the
// Cashtab branch, while Alias needs a bare OP_0 version byte, Airdrop a 32-byte
// tokenId, eCashChat an action push and Article a title push, so a naive probe
// reports those four as textless and silently shrinks the search. Instead the
// table lives next to LOKAD and a harness asserts it still matches the branches
// using a realistic payload per protocol, so drift fails a test rather than
// quietly narrowing coverage.
//
// NOT COVERED BY ANY LOKAD, and therefore not reachable through the index: the
// plain-text fallback at the end of parseOpReturn (a bare `OP_RETURN <text>`
// whose first push is not exactly 4 bytes, so chronik cannot index it) and
// memo.cash (2-byte prefix). Those are found only in the live stream. Disclose
// that in the coverage line; never let it read as "no results".
// =============================================================================
export const MESSAGE_LOKADS = [
  LOKAD.CASHTAB_MSG,
  LOKAD.ALIAS,
  LOKAD.AIRDROP,
  LOKAD.ECASHCHAT_TX,
  LOKAD.PAYBUTTON,
  LOKAD.ARTICLE,
];

// POWR action opcodes (bare OP_1..OP_9 following the bare OP_0 version byte).
export const POWR_ACTIONS = {
  0x51: 'post', 0x52: 'reply', 0x53: 'quote', 0x54: 'repost', 0x55: 'like',
  0x56: 'publish', 0x57: 'unlock', 0x58: 'auth', 0x59: 'handle',
};

// Display names for the OP_RETURN decode section + protocol-aware tx-flow label.
export const LOKAD_NAMES = {
  '00746162': 'Cashtab Msg',
  '6361736d': 'Cashtab Encrypted',
  '2e786563': 'Alias',
  '64726f70': 'Airdrop',
  '41475230': 'Agora',
  '63686174': 'eCashChat',
  '61757468': 'eCashChat Auth',
  '50415900': 'PayButton',
  '70617977': 'Paywall',
  '46555a00': 'CashFusion',
  '626c6f67': 'Article',
  '504f5752': 'Proof of Writing',
  '534c5000': 'SLP',
  '534c5032': 'ALP',
};

// ---- Display-only token name/ticker/url overrides ----
export const TOKEN_DISPLAY_OVERRIDES = {
  // Firma
  '0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0': {
    tokenName: 'Firma Alpha', tokenTicker: 'FIRMA α', url: 'firmaprotocol.com',
  },
};

export function applyTokenOverride(tokenId, o) {
  const ov = tokenId && TOKEN_DISPLAY_OVERRIDES[tokenId];
  if (!ov || !o) return o;
  if (ov.tokenName)   o.name   = ov.tokenName;
  if (ov.tokenTicker) o.ticker = ov.tokenTicker;
  if (ov.url)         o.url    = ov.url;
  return o;
}

// ---- hex → utf8 ----
export function hexToUtf8(hex) {
  try {
    if (!hex || hex.length % 2 !== 0) return '';
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (e) {
    return '';
  }
}

// =============================================================================
// CashAddr encoder — standalone (no third-party dependency)
// Spec: https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md
// Converts an output script (hex) into an "ecash:q..." / "ecash:p..." address.
// Handles P2PKH (76a914<20>88ac) and P2SH (a914<20>87). null for others.
// Test vector: ecash:qpadrekpz6gjd8w0zfedmtqyld0r2j4qmuthccqd8d
//   (hash160 = 7ad1e6c11691269dcf1272ddac04fb5e354aa0df).
// =============================================================================
const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CASHADDR_PREFIX = 'ecash';
const _CASHADDR_GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function _cashaddrPolymod(values) {
  let chk = 1n;
  for (const v of values) {
    const top = chk >> 35n;
    chk = ((chk & 0x07ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= _CASHADDR_GEN[i];
    }
  }
  return chk ^ 1n;
}

function _cashaddrConvertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || (value >> fromBits) !== 0) return null;
    acc = ((acc << fromBits) | value) & 0xffffff; // 24-bit safe accumulator
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad && bits > 0) out.push((acc << (toBits - bits)) & maxv);
  return out;
}

function _cashaddrEncode(typeBits, hash20Bytes) {
  // version byte: msb reserved 0; next 4 bits type (P2PKH=0, P2SH=1); last 3 bits size (0=20bytes)
  const versionByte = (typeBits & 0x07) << 3;
  const payload = [versionByte, ...hash20Bytes];
  const payload5 = _cashaddrConvertBits(payload, 8, 5, true);
  if (!payload5) return null;
  const prefixValues = [];
  for (let i = 0; i < CASHADDR_PREFIX.length; i++) prefixValues.push(CASHADDR_PREFIX.charCodeAt(i) & 0x1f);
  const checksumInput = [...prefixValues, 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0];
  const polymod = _cashaddrPolymod(checksumInput);
  const checksum = [];
  for (let i = 0; i < 8; i++) {
    checksum.push(Number((polymod >> BigInt(5 * (7 - i))) & 31n));
  }
  let result = CASHADDR_PREFIX + ':';
  for (const v of payload5) result += CASHADDR_CHARSET[v];
  for (const v of checksum) result += CASHADDR_CHARSET[v];
  return result;
}

// Public entry: hex output script -> "ecash:q..." string or null for non-standard scripts
export function encodeOutputScript(scriptHex) {
  if (!scriptHex || typeof scriptHex !== 'string') return null;
  const h = scriptHex.toLowerCase();
  try {
    let typeBits, hash160Hex;
    // P2PKH: 76 a9 14 <20 bytes hash160> 88 ac  (50 hex chars total)
    if (h.length === 50 && h.startsWith('76a914') && h.endsWith('88ac')) {
      typeBits = 0;
      hash160Hex = h.slice(6, 6 + 40);
    }
    // P2SH: a9 14 <20 bytes hash160> 87  (46 hex chars total)
    else if (h.length === 46 && h.startsWith('a914') && h.endsWith('87')) {
      typeBits = 1;
      hash160Hex = h.slice(4, 4 + 40);
    } else {
      return null;
    }
    if (hash160Hex.length !== 40) return null;
    const hashBytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) hashBytes[i] = parseInt(hash160Hex.substr(i * 2, 2), 16);
    return _cashaddrEncode(typeBits, hashBytes);
  } catch (e) {
    return null;
  }
}

// Public entry: validate an eCash CashAddr by verifying its BCH checksum (not just
// the charset). Accepts "ecash:q…"/"ecash:p…" or the bare body (ecash: assumed).
// Returns true only for a well-formed P2PKH/P2SH address (34 payload + 8 checksum
// symbols) whose polymod checks out — so a single mistyped character is rejected.
export function validateCashAddress(addr) {
  if (typeof addr !== 'string') return false;
  let s = addr.trim().toLowerCase();
  if (s.startsWith(CASHADDR_PREFIX + ':')) s = s.slice(CASHADDR_PREFIX.length + 1);
  if (s.length !== 42) return false;                 // 34 payload + 8 checksum symbols
  const payload5 = [];
  for (const ch of s) {
    const v = CASHADDR_CHARSET.indexOf(ch);
    if (v < 0) return false;                          // out-of-charset char
    payload5.push(v);
  }
  const prefixValues = [];
  for (let i = 0; i < CASHADDR_PREFIX.length; i++) prefixValues.push(CASHADDR_PREFIX.charCodeAt(i) & 0x1f);
  // _cashaddrPolymod returns (chk ^ 1); a valid full payload+checksum → 0.
  return _cashaddrPolymod([...prefixValues, 0, ...payload5]) === 0n;
}

// =============================================================================
// Agora AgoraPartial inline price recovery (ALP list/relist)
// priceNanoSatsPerAtom ≈ 1e9·atomsScale·2^(8·numSatsTrunc) / (scaledPerSat·2^(8·numAtomsTrunc))
// =============================================================================
export function agoraPartialPriceNanoSats(scriptHex) {
  const MARKER = '41475230' + '07' + '5041525449414c';   // AGR0 + push(7) + "PARTIAL"
  const midx = scriptHex.indexOf(MARKER);
  if (midx < 0 || (midx % 2) !== 0) return null;
  const off = midx / 2 + MARKER.length / 2;               // byte offset past the marker
  const readLE = (o, n) => {
    const h = scriptHex.slice(o * 2, o * 2 + n * 2);
    if (h.length !== n * 2) return null;
    let v = 0n;
    for (let i = h.length - 2; i >= 0; i -= 2) v = (v << 8n) | BigInt(parseInt(h.slice(i, i + 2), 16));
    return v;
  };
  try {
    const numAtomsTrunc = readLE(off, 1);
    const numSatsTrunc  = readLE(off + 1, 1);
    const atomsScale    = readLE(off + 2, 8);
    const scaledPerSat  = readLE(off + 10, 8);
    const makerPk = scriptHex.slice((off + 30) * 2, (off + 30) * 2 + 66);
    // Reject anything that isn't a real AgoraPartial ad (guards a stray marker match).
    if (numAtomsTrunc == null || numSatsTrunc == null || atomsScale == null || scaledPerSat == null) return null;
    if (numAtomsTrunc > 7n || numSatsTrunc > 7n || atomsScale <= 0n || scaledPerSat <= 0n) return null;
    if (makerPk.length !== 66 || !['02', '03', '04'].includes(makerPk.slice(0, 2))) return null;
    const num = 1000000000n * atomsScale * (1n << (8n * numSatsTrunc));
    const den = scaledPerSat * (1n << (8n * numAtomsTrunc));
    if (den === 0n) return null;
    return num / den;
  } catch { return null; }
}

// =============================================================================
// Bare-opcode-aware script-item walker (POWR branch + raw OP_RETURN decode).
// NOTE: this is the top-level walker; `readAllPushes` (nested in parseOpReturn)
// deliberately STOPS at the first bare opcode and several legacy protocol
// branches depend on that — DO NOT merge them.
// Returns { items, truncated }:
//   { kind: 'push', hex, len } — 0x01-0x4b direct, 0x4c/0x4d/0x4e PUSHDATA1/2/4
//   { kind: 'op',   hex, op  } — OP_0, OP_1NEGATE, OP_1..OP_16, anything else
// =============================================================================
export function readScriptItems(hex, maxItems = 32) {
  const items = [];
  let truncated = false;
  let p = (hex || '').toLowerCase();
  if (p.length % 2 !== 0) return { items, truncated: true };
  while (p.length >= 2) {
    if (items.length >= maxItems) { truncated = true; break; }
    const b = parseInt(p.slice(0, 2), 16);
    if (Number.isNaN(b)) { truncated = true; break; }
    let len = -1, start = 0;
    if (b >= 0x01 && b <= 0x4b) { len = b; start = 2; }
    else if (b === 0x4c || b === 0x4d || b === 0x4e) {
      start = b === 0x4c ? 4 : b === 0x4d ? 6 : 10;
      if (p.length < start) { truncated = true; break; }
      const lenHex = b === 0x4c ? p.slice(2, 4)
                   : b === 0x4d ? p.slice(4, 6) + p.slice(2, 4)
                   : p.slice(8, 10) + p.slice(6, 8) + p.slice(4, 6) + p.slice(2, 4);
      len = parseInt(lenHex, 16);
      if (Number.isNaN(len)) { truncated = true; break; }
    }
    if (len >= 0) {
      if (p.length - start < len * 2) { truncated = true; break; }
      items.push({ kind: 'push', hex: p.slice(start, start + len * 2), len });
      p = p.slice(start + len * 2);
    } else {
      items.push({ kind: 'op', hex: p.slice(0, 2), op: b });
      p = p.slice(2);
    }
  }
  return { items, truncated };
}

// =============================================================================
// encodePush(hex) — wrap a payload in the smallest push opcode that fits.
// Only used by parseEmpp below. OP_RETURN is capped at 223 bytes on eCash, so
// PUSHDATA1 is the largest form reachable in practice; PUSHDATA2 is kept as a
// backstop so a non-standard oversized fragment degrades instead of corrupting.
// =============================================================================
// The single printable-text rule. Hoisted so the eMPP fragment path below and
// the top-level plain-text fallback cannot drift into two different ideas of
// what counts as writing.
const PRINTABLE_TEXT = /^[\x20-\x7e\u00A0-\uFFFF]+$/;
// Every LOKAD ID this parser has a branch for, plus the two token markers.
const KNOWN_LOKADS = new Set([...Object.values(LOKAD), '534c5000', '534c5032']);

function encodePush(hex) {
  const len = hex.length / 2;
  if (len <= 0x4b) return len.toString(16).padStart(2, '0') + hex;
  if (len <= 0xff) return '4c' + len.toString(16).padStart(2, '0') + hex;
  const lo = (len & 0xff).toString(16).padStart(2, '0');
  const hi = ((len >> 8) & 0xff).toString(16).padStart(2, '0');
  return '4d' + lo + hi + hex;
}

// =============================================================================
// parseEmpp(restHex) — decode an eMPP OP_RETURN body (everything after 6a 50).
//
// eMPP (doc/standards/empp.md) is `OP_RETURN OP_RESERVED <push0> <push1> ...`,
// one push per protocol fragment. Each payload begins with a RAW 4-byte LOKAD
// ID — NOT a nested push op — followed by protocol-defined bytes. Verified
// against 9 real chain txs: push.len is exactly 4 + the UTF-8 byte length of
// the message, with no inner length prefix anywhere.
//
// WHY THIS RE-WRAPS A SCRIPT INSTEAD OF CALLING THE BRANCHES DIRECTLY.
// The protocol branches live inside parseOpReturn and read its locals
// (afterId, firstPushHex, pushLen, firstPushIsId). Extracting them would touch
// all eleven — the highest-regression edit available in this file. Instead each
// fragment is re-wrapped as `6a <push>`, which parseOpReturn already handles as
// its "non-standard inline form": firstPushIsId is false for any push that is
// not exactly 4 bytes, so lokad becomes the first 4 bytes and the remainder is
// the payload. That is byte-for-byte the eMPP layout, so the existing branches
// read it correctly with ZERO changes to them.
//
// The recursion is exactly one level deep: a synthesized script starts with a
// push opcode (0x01-0x4d), never OP_RESERVED, so it can never re-enter here.
// =============================================================================
function parseEmpp(restHex) {
  const { items, truncated } = readScriptItems(restHex);
  // Spec validity: a bare opcode, an empty push, or a malformed/oversized tail
  // invalidates the WHOLE OP_RETURN — not merely the offending fragment.
  if (truncated || !items.length) return null;
  for (const it of items) {
    if (it.kind !== 'push' || it.len === 0) return null;
  }
  let fallback = null;
  for (const it of items) {
    // A fragment shorter than the 4-byte LOKAD ID cannot name a protocol. Skip
    // it rather than invalidating the script: the 4-byte prefix is a
    // recommendation in the spec, not a validity rule.
    if (it.len < 4) continue;
    let m;
    const lok = it.hex.slice(0, 8).toLowerCase();
    if (KNOWN_LOKADS.has(lok)) {
      m = parseOpReturn('6a' + encodePush(it.hex));
    } else {
      // Unknown protocol. Re-wrapping would send the whole fragment through the
      // top-level plain-text fallback, which reads the payload AND the 4-byte id
      // as one string — so an eMPP note under an unrecognised id rendered as
      // "WXZZsome payload text", presenting protocol machinery as something a
      // person wrote, and putting it in the search haystack too.
      const text = hexToUtf8(it.hex.slice(8));
      m = (text && PRINTABLE_TEXT.test(text) && text.length > 2)
        ? msg('broadcast', text, text)
        : null;
    }
    if (!m) continue;
    // Prefer the first fragment carrying real on-chain text. A tx pairing a
    // textless protocol with a written message (the common ALP-send + note
    // shape) must surface the note, or the writing stays unfindable — which is
    // the exact defect this function exists to fix.
    if (m.text) return m;
    if (!fallback) fallback = m;
  }
  return fallback;
}

export function parseFirstPush(hex) {
  if (!hex || hex.length < 2) return null;
  const firstByte = parseInt(hex.slice(0, 2), 16);
  let pushLen, start;
  if (firstByte === 0x4c) { pushLen = parseInt(hex.slice(2, 4), 16); start = 4; }
  else if (firstByte > 0 && firstByte <= 75) { pushLen = firstByte; start = 2; }
  else return null;
  return hexToUtf8(hex.slice(start, start + pushLen * 2));
}

// =============================================================================
// msg() — build a message object. THE only place these three fields are set.
//
//   content   what the UI shows. Often a parser-composed label, sometimes with
//             real on-chain text decorated into it ('alias: "vn"'). Never change
//             an existing value here: neo, Flow and the share-card Worker all
//             render from it, so a change moves render paths in three places.
//   text      what a human actually wrote ON CHAIN, raw and undecorated, or
//             null when nothing was. This is the ONLY field a search may look
//             at. A label nobody wrote must never be matchable: searching
//             "chat" has to miss the string 'eCashChat message'.
//   synthetic true when `content` is parser-composed rather than verbatim
//             on-chain text. It describes the PROVENANCE OF content, not the
//             presence of text: the two are independent. 'alias: "vn"' is
//             synthetic (we wrote the quotes and the word "alias") even though
//             its text is the real 'vn'; an Agora label is synthetic even when a
//             chat OP_RETURN rode along and its text was carried across.
//
// The invariant is `synthetic === (content !== text)` and it holds for every
// branch below — a label always differs from what was written, verbatim text
// always equals it, and a null text can never equal a content string. Assert it
// in any harness that touches this file.
// =============================================================================
function msg(type, content, text, extra) {
  const t = text ? text : null;
  const m = { type, content, text: t, synthetic: content !== t };
  if (extra) Object.assign(m, extra);
  return m;
}

// =============================================================================
// parseOpReturn(hex) — decode an OP_RETURN output script into a message object
// { type, content, text, synthetic, ... }. Returns null when nothing
// surfaceable is found.
// =============================================================================
export function parseOpReturn(hex) {
  if (!hex || !hex.startsWith('6a')) return null;
  const data = hex.slice(2);
  if (data.length < 8) return null;

  // eMPP: OP_RETURN OP_RESERVED <push>... — a multi-protocol OP_RETURN. It needs
  // its own walker because OP_RESERVED (0x50) is not a length-prefixed push, so
  // the dispatch below — which reads a push length out of this very byte —
  // cannot describe it. Before this branch existed, 0x50 was > 75 and every eMPP
  // tx fell straight through to the `return null` at the end of that dispatch,
  // leaving a note attached to a token send invisible in both doors.
  if (data.startsWith('50')) return parseEmpp(data.slice(2));

  let firstByte = parseInt(data.slice(0, 2), 16);
  let pushLen, push1Start;
  if (firstByte === 0x4c) {
    pushLen = parseInt(data.slice(2, 4), 16);
    push1Start = 4;
  } else if (firstByte === 0x4d) {
    // OP_PUSHDATA2 - little endian
    pushLen = parseInt(data.slice(4, 6) + data.slice(2, 4), 16);
    push1Start = 6;
  } else if (firstByte > 0 && firstByte <= 75) {
    pushLen = firstByte;
    push1Start = 2;
  } else {
    return null;
  }

  const firstPushHex = data.slice(push1Start, push1Start + pushLen * 2);
  if (firstPushHex.length < 8) return null;

  // For most LOKAD protocols the first push IS the 4-byte protocol identifier.
  const firstPushIsId = (pushLen === 4);
  const lokad = firstPushIsId ? firstPushHex.toLowerCase() : firstPushHex.slice(0, 8).toLowerCase();
  const afterId = firstPushIsId ? data.slice(push1Start + pushLen * 2) : null;

  // Helper: read consecutive pushes from a hex remainder. STOPS at first bare
  // opcode by design (Cashtab msg joining + Alias bare-OP_0 version depend on it).
  function readAllPushes(remHex) {
    const pushes = [];
    let p = remHex;
    while (p && p.length >= 2) {
      const b = parseInt(p.slice(0, 2), 16);
      let len, start;
      if (b === 0x4c) { len = parseInt(p.slice(2, 4), 16); start = 4; }
      else if (b === 0x4d) { len = parseInt(p.slice(4, 6) + p.slice(2, 4), 16); start = 6; }
      else if (b > 0 && b <= 75) { len = b; start = 2; }
      else break;
      const piece = p.slice(start, start + len * 2);
      pushes.push(piece);
      p = p.slice(start + len * 2);
    }
    return pushes;
  }

  if (lokad === LOKAD.CASHTAB_MSG) {
    if (firstPushIsId) {
      // Standard form: 04 <00746162> <push> <utf8 msg>
      const pushes = readAllPushes(afterId);
      const msgText = pushes.map(hexToUtf8).filter(Boolean).join(' ');
      return msg('cashtab', msgText || 'Cashtab message', msgText);
    }
    // Non-standard inline form: first push contains id+msg
    const msgText = hexToUtf8(firstPushHex.slice(8));
    return msg('cashtab', msgText || 'Cashtab message', msgText);
  }
  if (lokad === LOKAD.CASHTAB_ENC) {
    // Encrypted: there is no plaintext on chain, so there is nothing to search.
    return msg('encrypted', 'Encrypted Cashtab message', null);
  }
  if (lokad === LOKAD.ALIAS) {
    // Alias: <04 2e786563> <OP_0 version> <01-15 alias> <15 cashaddr-payload>
    //
    // The version is a BARE OP_0 — doc/standards/ecash-alias.md: "A push of a
    // version number. Must be pushed as OP_0." readAllPushes stops dead at the
    // first bare opcode (by design, §6), so it returned [] here and the alias
    // name was NEVER extracted from a spec-conformant registration. Use the
    // bare-opcode-aware walker instead and keep positions: an opcode becomes an
    // empty slot rather than vanishing, so the alias stays at index 1 where the
    // spec puts it. readAllPushes itself is untouched — five other branches
    // depend on its stop-at-opcode behaviour.
    const pushes = afterId
      ? readScriptItems(afterId).items.map((i) => (i.kind === 'push' ? i.hex : ''))
      : [];
    let aliasName = '';
    for (let i = 0; i < pushes.length && i < 3; i++) {
      const txt = hexToUtf8(pushes[i]);
      if (/^[a-z0-9]+$/.test(txt) && txt.length >= 1 && txt.length <= 21) {
        aliasName = txt; break;
      }
    }
    // content keeps the decoration; text carries the raw alias someone chose.
    return msg('alias', aliasName ? `alias: "${aliasName}"` : 'alias registration', aliasName);
  }
  if (lokad === LOKAD.AIRDROP) {
    // Airdrop: <04 drop> <20 tokenId> [<push> msg]
    const pushes = afterId ? readAllPushes(afterId) : [];
    let label = 'Token airdrop', note = '';
    if (pushes.length >= 2) {
      const m = pushes.slice(1).map(hexToUtf8).filter(Boolean).join(' ');
      if (m) { label = 'Airdrop · ' + m; note = m; }
    }
    return msg('airdrop', label, note);
  }
  // Agora covenants put AGR0 in the inputScript, NOT an OP_RETURN — let the
  // inputScript-based detection in parseTransactionCore synthesize the message.
  if (lokad === LOKAD.AGORA) {
    return null;
  }
  if (lokad === LOKAD.ECASHCHAT_TX) {
    // eCashChat: <04 chat> <push action> <push payload...>
    const pushes = afterId ? readAllPushes(afterId) : [];
    if (pushes.length === 0) return msg('broadcast', 'eCashChat message', null);
    const action = hexToUtf8(pushes[0]);
    if (action === 'hash' && pushes[2]) {
      const reply = hexToUtf8(pushes[2]);
      return msg('broadcast', reply || 'eCashChat reply', reply);
    }
    if (action === 'post' && pushes[1]) {
      const post = hexToUtf8(pushes[1]);
      return msg('broadcast', post || 'eCashChat post', post);
    }
    if (action === 'pass' && pushes[1]) {
      return msg('encrypted', 'Encrypted eCashChat message', null);
    }
    if (pushes[1]) {
      const body = hexToUtf8(pushes[1]);
      if (body) return msg('cashtab', body, body);
    }
    const body0 = hexToUtf8(pushes[0]);
    return msg('cashtab', body0 || 'eCashChat message', body0);
  }
  if (lokad === LOKAD.ECASHCHAT_AUTH) {
    return msg('encrypted', 'eCashChat auth', null);
  }
  if (lokad === LOKAD.PAYBUTTON) {
    // PayButton: <04 PAY\x00> <OP_0 version> <data> <nonce>
    //
    // TWO bugs were fixed here together, the second only visible once the first
    // was gone. (1) The version is a BARE OP_0 — doc/standards/paybutton.md:
    // "The version must be pushed as OP_0" — so readAllPushes stopped at it and
    // returned [], exactly as in the Alias branch above. (2) The field order is
    // version, DATA, nonce, not version, nonce, data, so index 2 was the nonce.
    // Positions must be preserved rather than filtered: the spec signifies an
    // EMPTY data payload with another OP_0, and dropping opcodes would slide the
    // nonce into the data slot (its example 3 is exactly that case).
    const pushes = afterId
      ? readScriptItems(afterId).items.map((i) => (i.kind === 'push' ? i.hex : ''))
      : [];
    const data2 = pushes[1] ? hexToUtf8(pushes[1]) : '';
    // data2 is merchant-supplied and often machine-generated (order ids), but it
    // IS on chain and somebody put it there — searchable, per the same rule that
    // keeps the plain-text fallback below.
    return msg('broadcast', data2 ? `PayButton: ${data2}` : 'PayButton tx', data2);
  }
  if (lokad === LOKAD.PAYWALL) {
    return msg('broadcast', 'Paywall payment', null);
  }
  if (lokad === LOKAD.CASHFUSION) {
    return msg('broadcast', 'CashFusion shuffle', null);
  }
  if (lokad === LOKAD.ARTICLE) {
    const pushes = afterId ? readAllPushes(afterId) : [];
    const title = pushes[0] ? hexToUtf8(pushes[0]) : '';
    // The article BODY is off chain; the title is not, so only the title is text.
    return msg('broadcast', title ? `Article: ${title.slice(0, 80)}` : 'eCashChat article', title);
  }
  if (lokad === LOKAD.POWR) {
    // Proof of Writing — content is OFF-chain (sha256 hashes only). Uses BARE
    // opcodes after the lokad push, so only readScriptItems can parse it.
    // POWR's readable content lives OFF chain — the script carries only sha256
    // hashes and a UUID nonce. Those are identifiers, not text, so every POWR
    // message has null text no matter how specific its label gets.
    const generic = msg('powr', 'Proof of Writing activity', null);
    const { items, truncated } = readScriptItems(afterId);
    if (truncated || items.length < 2) return generic;
    if (items[0].kind !== 'op' || items[0].op !== 0x00) return generic; // version byte
    const action = items[1].kind === 'op' ? POWR_ACTIONS[items[1].op] : null;
    if (!action) return generic;
    const payload = items.slice(2);
    const hash32 = (it) => (it && it.kind === 'push' && /^[0-9a-f]{64}$/.test(it.hex)) ? it.hex : null;
    const short = (h) => h.slice(0, 8) + '…' + h.slice(-4);
    const powr = { action };
    let content = null;
    if (action === 'post' || action === 'publish') {
      const h = hash32(payload[0]);
      if (h && payload.length === 1) { powr.contentHash = h; content = `${action} · ${short(h)}`; }
    } else if (action === 'reply' || action === 'quote') {
      const t = hash32(payload[0]), h = hash32(payload[1]);
      if (t && h && payload.length === 2) { powr.targetTxid = t; powr.contentHash = h; content = `${action} → ${short(t)} · ${short(h)}`; }
    } else if (action === 'repost' || action === 'like') {
      const t = hash32(payload[0]);
      if (t && payload.length === 1) { powr.targetTxid = t; content = `${action} → ${short(t)}`; }
    } else if (action === 'unlock') {
      if (payload.length === 0) content = 'unlock';
    } else {
      // auth / handle — one 36-byte ASCII UUID nonce push
      const it = payload[0];
      const nonce = (it && it.kind === 'push' && it.len === 36) ? hexToUtf8(it.hex) : '';
      if (payload.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nonce)) {
        powr.nonce = nonce; content = `${action} · ${nonce}`;
      }
    }
    return content ? msg('powr', content, null, { powr }) : generic;
  }
  // SLP/ALP token markers - skip (handled via tokenEntries)
  if (lokad === '534c5000' || lokad === '534c5032') return null;
  // EMPP marker (Extended Multi-Push Protocol — starts with 0x50)
  if (firstPushHex.startsWith('50') && !firstPushIsId) return null;

  // Memo.cash protocol (starts with 6d, push directly without 4-byte id)
  if (firstPushHex.startsWith('6d') && !firstPushIsId) {
    const action = firstPushHex.slice(0, 4);
    if (action === '6d02') {
      const remaining = data.slice(push1Start + pushLen * 2);
      const post = parseFirstPush(remaining);
      return msg('broadcast', post || 'Memo post', post);
    }
    return msg('broadcast', 'Memo action', null);
  }

  // Otherwise try to interpret as plain text (no recognized protocol id).
  // This branch is why search must NOT be narrowed to known lokad ids: an
  // OP_RETURN belonging to no protocol we know still carries something a person
  // wrote, and a lokad-keyed scan would report "no results" for text it never
  // looked at. content === text here, so it is the one branch that is never
  // synthetic by construction.
  const text = hexToUtf8(firstPushHex);
  if (text && PRINTABLE_TEXT.test(text) && text.length > 2) {
    return msg('broadcast', text, text);
  }
  return null;
}

// =============================================================================
// parseTransactionCore(txData) — chronik tx → structured app tx object.
// PURE version of index.html's parseTransaction: no bigtx bus emit, no async
// token-icon enrichment. Consumers enrich tx.token via tx.token.tokenId and
// handle any big-tx signal themselves (check tx.valueXec).
// =============================================================================
export function parseTransactionCore(txData) {
  const tx = {
    id: txData.txid,
    inputs: (txData.inputs || []).length,
    outputs: (txData.outputs || []).length,
    size: txData.size || 0,
    firstSeenLocal: Date.now(),
    firstSeen: txData.timeFirstSeen ? Number(txData.timeFirstSeen) * 1000 : Date.now(),
    state: 'pending',
    confidence: 0,
    raw: txData,
  };

  // ---- Compute amounts (XEC and token) ----
  // Actual *sent* amount, not gross output sum: subtract change outputs (those
  // going back to an input address) and OP_RETURN carriers. Fall back to gross
  // for self-spend / consolidation so the row isn't 0.
  const inputAddrSet = new Set();
  for (const inp of (txData.inputs || [])) {
    let script = inp.outputScript;
    if (!script && inp.prevOut && inp.prevOut.outputScript) script = inp.prevOut.outputScript;
    if (!script) continue;
    try {
      const a = encodeOutputScript(script);
      if (a) inputAddrSet.add(a);
    } catch {}
  }

  // XEC totals
  let totalSats = 0n;
  let sentSats = 0n;
  for (const o of (txData.outputs || [])) {
    let v = 0n;
    try { v = BigInt(o.sats || o.value || 0); } catch {}
    totalSats += v;
    const script = o.outputScript || '';
    if (script.startsWith('6a')) continue; // OP_RETURN data carrier
    let addr = null;
    try { addr = encodeOutputScript(script); } catch {}
    if (addr && inputAddrSet.has(addr)) continue; // change back to an input addr
    sentSats += v;
  }
  if (sentSats === 0n) sentSats = totalSats;

  tx.totalOutXec = Number(totalSats) / 100;  // gross
  tx.valueXec    = Number(sentSats) / 100;   // headline "sent" amount
  // NOTE: neo emits __ecBus.emit('bigtx', …) here when valueXec >= 100M. Omitted
  // in the shared core; consumers that want that signal check tx.valueXec.

  // Calculate fee (sum inputs - sum outputs). null when input sats are missing.
  let inSats = 0n;
  let hasAllInputSats = true;
  for (const i of (txData.inputs || [])) {
    const v = i.sats ?? i.value;
    if (v === undefined || v === null) { hasAllInputSats = false; break; }
    try { inSats += BigInt(v); } catch { hasAllInputSats = false; break; }
  }
  if (hasAllInputSats && (txData.inputs || []).length > 0) {
    const feeBig = inSats - totalSats;
    tx.fee = (feeBig >= 0n) ? Number(feeBig) : null; // coinbase → negative → null
  } else {
    tx.fee = null;
  }

  // Detect token data
  if (txData.tokenEntries && txData.tokenEntries.length > 0) {
    const entry = txData.tokenEntries[0];
    tx.token = {
      tokenId: entry.tokenId,
      groupTokenId: entry.groupTokenId || null,
      type: entry.tokenType?.protocol || entry.tokenType?.type || 'UNKNOWN',
      action: entry.txType || 'TRANSFER',
      isInvalid: entry.isInvalid,
    };
    applyTokenOverride(tx.token.tokenId, tx.token);
    // Sum token amounts (exclude change outputs, same as XEC above).
    let tokenAmount = 0n;
    let tokenTotalOut = 0n;
    for (const o of (txData.outputs || [])) {
      if (!o.token || o.token.tokenId !== entry.tokenId) continue;
      let v = 0n;
      try { v = BigInt(o.token.atoms || o.token.amount || 0); } catch {}
      tokenTotalOut += v;
      let addr = null;
      try { addr = encodeOutputScript(o.outputScript || ''); } catch {}
      if (addr && inputAddrSet.has(addr)) continue;
      tokenAmount += v;
    }
    if (tokenAmount === 0n) tokenAmount = tokenTotalOut;
    tx.token.amount = tokenAmount.toString();
    tx.token.totalOut = tokenTotalOut.toString();

    if (entry.txType === 'GENESIS') tx.token.action = 'GENESIS';
    else if (entry.txType === 'MINT') tx.token.action = 'MINT';
    else if (entry.txType === 'BURN') tx.token.action = 'BURN';
    // NOTE: neo does async fetchTokenInfo(tx.token.tokenId) enrichment here.
    // Consumers do that themselves; the shared core sets only the base fields.
  }

  // ============ Agora detection (verified against real chain data) ============
  // AGR0 marker = '41475230' + push(7) + VARIANT ('PARTIAL' fungible / 'ONESHOT' NFT).
  // The marker is embedded deep in the covenant redeemScript when SPENT, so we
  // .includes() the whole input hex (24-hex-char marker → negligible false-positive).
  const AGR0_PARTIAL_MARKER = '41475230' + '07' + '5041525449414c';   // 24 hex chars
  const AGR0_ONESHOT_MARKER = '41475230' + '07' + '4f4e4553484f54';   // 24 hex chars
  const AGORA_DUST_SATS = 546;  // dust floor; a relist/cancel pays no one above this
  tx.agora = null;
  try {
    const inputs = txData.inputs || [];
    const outputs = txData.outputs || [];
    const inputLen = inputs.length;
    const getScript = (inp) => (inp && (inp.inputScript || inp.scriptSig || '')) || '';
    const opRet0 = (outputs[0] && outputs[0].outputScript) || '';
    const opRet0IsOpReturn = opRet0.startsWith('6a');
    const op0HasPartial = opRet0IsOpReturn && opRet0.includes(AGR0_PARTIAL_MARKER);
    const op0HasOneshot = opRet0IsOpReturn && opRet0.includes(AGR0_ONESHOT_MARKER);

    // First input whose unlocking script contains an AGR0 marker = covenant spent.
    let covenantInputIdx = -1;
    let covenantVariant = null;   // 'oneshot' / 'partial'
    for (let i = 0; i < inputLen; i++) {
      const s = getScript(inputs[i]);
      if (s.includes(AGR0_PARTIAL_MARKER)) { covenantInputIdx = i; covenantVariant = 'partial'; break; }
      if (s.includes(AGR0_ONESHOT_MARKER)) { covenantInputIdx = i; covenantVariant = 'oneshot'; break; }
    }

    // Count P2SH outputs (`a914<20-byte-hash>87`). Any P2SH output implies a
    // covenant is being CREATED (LIST detection + BUY-partial remainder).
    let p2shOutputCount = 0;
    for (const o of outputs) {
      const s = o.outputScript || '';
      if (s.startsWith('a914') && s.endsWith('87') && s.length === 46) p2shOutputCount++;
    }

    // Maker payment: the external XEC an ACCEPT pays the seller. Its presence is
    // what distinguishes a real BUY from a seller-side relist/cancel.
    let makerPaymentSats = 0;
    for (const o of outputs) {
      const s = o.outputScript || '';
      if (s.startsWith('6a')) continue;                                          // OP_RETURN
      if (s.startsWith('a914') && s.endsWith('87') && s.length === 46) continue; // P2SH covenant
      const v = Number(o.sats || o.value || 0);
      if (v <= AGORA_DUST_SATS) continue;
      let addr = null;
      try { addr = encodeOutputScript(s); } catch {}
      if (addr && inputAddrSet.has(addr)) continue;                              // change to an input addr
      if (v > makerPaymentSats) makerPaymentSats = v;
    }

    // -------- SPEND: covenant is being spent → BUY / RELIST / CANCEL --------
    if (covenantInputIdx >= 0) {
      const isOneshot = covenantVariant === 'oneshot';

      if (makerPaymentSats > AGORA_DUST_SATS) {
        const buyerPaidXec = makerPaymentSats / 100;

        // NFT BUY: try to extract the LISTED price from the covenant inputScript.
        let listedPriceSats = 0;
        if (isOneshot) {
          const covScript = getScript(inputs[covenantInputIdx]);
          const markerIdx = covScript.indexOf(AGR0_ONESHOT_MARKER);
          if (markerIdx >= 0) {
            const candidates = [
              markerIdx + 24, markerIdx + 26, markerIdx + 28,
              markerIdx + 30, markerIdx + 32,
            ];
            for (const off of candidates) {
              const hex = covScript.slice(off, off + 16);
              if (!hex || hex.length !== 16) continue;
              try {
                const beHex = hex.match(/../g).reverse().join('');
                const v = Number(BigInt('0x' + beHex));
                if (v > 0 && v < 1e16) {
                  if (v === makerPaymentSats) { listedPriceSats = v; break; }
                  if (!listedPriceSats) listedPriceSats = v;
                }
              } catch {}
            }
          }
        }

        // Quantity bought (F2 fix): covenant input atoms − remainder covenant atoms.
        let boughtAtoms = 0n;
        if (isOneshot) {
          boughtAtoms = 1n;
        } else if (tx.token && tx.token.tokenId) {
          let covInAtoms = 0n, remainderAtoms = 0n;
          const covIn = inputs[covenantInputIdx];
          if (covIn && covIn.token && covIn.token.tokenId === tx.token.tokenId) {
            try { covInAtoms = BigInt(covIn.token.atoms || covIn.token.amount || 0); } catch {}
          }
          for (const o of outputs) {
            if (!o.token || o.token.tokenId !== tx.token.tokenId) continue;
            const s = o.outputScript || '';
            if (s.startsWith('a914') && s.endsWith('87')) {
              try { remainderAtoms += BigInt(o.token.atoms || o.token.amount || 0); } catch {}
            }
          }
          boughtAtoms = covInAtoms - remainderAtoms;
          if (boughtAtoms < 0n) boughtAtoms = 0n;
        }
        let priceSatsPerToken = null;
        if (isOneshot) {
          priceSatsPerToken = listedPriceSats || makerPaymentSats || null;
        }
        tx.agora = {
          detected: true,
          side: 'buy',
          kind: isOneshot ? 'oneshot' : 'partial',
          label: isOneshot ? 'Agora Purchase (NFT)' : 'Agora Purchase (token)',
          tokenAmountAtoms: boughtAtoms.toString(),
          priceSatsPerToken,
          priceXecTotal: buyerPaidXec,
          isPartialFill: p2shOutputCount > 0,
        };
      } else {
        // No maker payment → not a purchase. Token → fresh P2SH covenant:
        // SLP list surfaces here (no OP_RETURN listing); ALP covenant→covenant is
        // a re-spend → RELIST. Token → seller wallet → CANCEL.
        const isSlp = !!(tx.token && (tx.token.type || '').toUpperCase().startsWith('SLP'));
        let tokenToP2sh = false;
        let movedAtoms = 0n;
        if (isOneshot) {
          movedAtoms = 1n;
          tokenToP2sh = p2shOutputCount > 0;
        } else if (tx.token && tx.token.tokenId) {
          let p2shAtoms = 0n, walletAtoms = 0n;
          for (const o of outputs) {
            if (!o.token || o.token.tokenId !== tx.token.tokenId) continue;
            const s = o.outputScript || '';
            let a = 0n;
            try { a = BigInt(o.token.atoms || o.token.amount || 0); } catch {}
            if (s.startsWith('a914') && s.endsWith('87')) { tokenToP2sh = true; p2shAtoms += a; }
            else walletAtoms += a;
          }
          movedAtoms = tokenToP2sh ? p2shAtoms : walletAtoms;
        }
        const spendSide = tokenToP2sh ? (isSlp ? 'list' : 'relist') : 'cancel';
        // SLP NFT (oneshot) list price: byte 82 (u64 LE) of the covenant scriptSig.
        let nftPriceSats = null;
        if (spendSide === 'list' && isOneshot && covenantInputIdx >= 0) {
          const covScript = getScript(inputs[covenantInputIdx]);
          const hex = covScript.slice(164, 180);          // bytes 82..90
          if (hex.length === 16) {
            try {
              const v = Number(BigInt('0x' + hex.match(/../g).reverse().join('')));
              if (v > 0 && v < 1e16) nftPriceSats = v;
            } catch {}
          }
        }
        // ALP RELIST asking price: recovered inline from the fresh OP_RETURN
        // AgoraPartial ad (same math as LIST; relist ⇒ ALP-only, never oneshot).
        let relistPriceXecTotal = null;
        if (spendSide === 'relist' && !isOneshot && op0HasPartial && movedAtoms > 0n) {
          const nsat = agoraPartialPriceNanoSats(opRet0);
          if (nsat != null && nsat > 0n) {
            const rt = Number(movedAtoms) * Number(nsat) / 1e11;
            if (Number.isFinite(rt) && rt > 0) relistPriceXecTotal = rt;
          }
        }
        tx.agora = {
          detected: true,
          side: spendSide,
          kind: isOneshot ? 'oneshot' : 'partial',
          label: spendSide === 'list'
            ? (isOneshot ? 'Agora Listed (NFT)' : 'Agora Listed (token)')
            : spendSide === 'relist'
              ? (isOneshot ? 'Agora Relist (NFT)' : 'Agora Relist (token)')
              : (isOneshot ? 'Agora Cancel (NFT)' : 'Agora Cancel (token)'),
          tokenAmountAtoms: movedAtoms.toString(),
          priceSatsPerToken: nftPriceSats,
          priceXecTotal: nftPriceSats != null ? nftPriceSats / 100 : relistPriceXecTotal,
        };
      }
    }
    // -------- LIST (no AGR0 in inputs, OP_RETURN has marker + P2SH output) --------
    else if ((op0HasPartial || op0HasOneshot) && p2shOutputCount > 0) {
      const isOneshot = op0HasOneshot;
      let listedAtoms = 0n;
      if (isOneshot) {
        listedAtoms = 1n;
      } else if (tx.token && tx.token.tokenId) {
        for (const o of outputs) {
          if (!o.token || o.token.tokenId !== tx.token.tokenId) continue;
          const s = o.outputScript || '';
          if (!(s.startsWith('a914') && s.endsWith('87'))) continue;
          try { listedAtoms += BigInt(o.token.atoms || o.token.amount || 0); } catch {}
        }
      }
      // ALP partial listings carry AgoraPartial params inline → recover price.
      let listPriceXecTotal = null;
      if (!isOneshot && op0HasPartial && listedAtoms > 0n) {
        const nsat = agoraPartialPriceNanoSats(opRet0);
        if (nsat != null && nsat > 0n) {
          const t = Number(listedAtoms) * Number(nsat) / 1e11;
          if (Number.isFinite(t) && t > 0) listPriceXecTotal = t;
        }
      }
      tx.agora = {
        detected: true,
        side: 'list',
        kind: isOneshot ? 'oneshot' : 'partial',
        label: isOneshot ? 'Agora Listed (NFT)' : 'Agora Listed (token)',
        tokenAmountAtoms: listedAtoms.toString(),
        priceSatsPerToken: null,
        priceXecTotal: listPriceXecTotal,
      };
    }
  } catch (e) {
    // Non-fatal: leave tx.agora = null.
    if (typeof console !== 'undefined') console.error('[txparse] agora-detect error:', e);
  }

  // Parse OP_RETURN messages from outputs
  for (const o of (txData.outputs || [])) {
    if (o.outputScript && o.outputScript.startsWith('6a')) {
      const parsed = parseOpReturn(o.outputScript);
      if (parsed) { tx.message = parsed; break; }
    }
  }

  // Agora detection wins for the feed: surface as the appropriate synthetic
  // message even if the tx also carries a chat-style OP_RETURN.
  if (tx.agora) {
    let synthType = 'agora-list';
    if (tx.agora.side === 'buy') synthType = 'agora-buy';
    else if (tx.agora.side === 'cancel') synthType = 'agora-cancel';
    else if (tx.agora.side === 'relist') synthType = 'agora-relist';
    else synthType = 'agora-list';
    // This overwrite discards a chat-style OP_RETURN the tx may also carry — the
    // Agora label is what the feed should SHOW. But discarding the text too would
    // make real on-chain writing unfindable and report it as "no match" rather
    // than "not looked at", so it is carried across. content is unchanged, so no
    // render path moves; only `text` survives the overwrite.
    const carried = tx.message && tx.message.text ? tx.message.text : null;
    tx.message = msg(synthType, tx.agora.label || 'Agora interaction', carried);
  }

  return tx;
}
