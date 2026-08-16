// Frozen neo inline parser + helpers as they stood immediately before P0 B2
// (neo adopts vendor/txparse.js). Evidence only — do not "improve".
// test-parser-parity.mjs and test-helper-parity.mjs import this as the
// pre-swap neo side once index.html no longer defines these names.
// Extracted verbatim from index.html on 2026-08-16, before the B2 edit.

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

export const POWR_ACTIONS = {
  0x51: 'post', 0x52: 'reply', 0x53: 'quote', 0x54: 'repost', 0x55: 'like',
  0x56: 'publish', 0x57: 'unlock', 0x58: 'auth', 0x59: 'handle',
};

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

export const TOKEN_DISPLAY_OVERRIDES = {
  // Firma
  '0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0': {
    url: 'firma.cash',
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

export function parseFirstPush(hex) {
  if (!hex || hex.length < 2) return null;
  const firstByte = parseInt(hex.slice(0, 2), 16);
  let pushLen, start;
  if (firstByte === 0x4c) { pushLen = parseInt(hex.slice(2, 4), 16); start = 4; }
  else if (firstByte > 0 && firstByte <= 75) { pushLen = firstByte; start = 2; }
  else return null;
  return hexToUtf8(hex.slice(start, start + pushLen * 2));
}

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
    // Reject anything that isn't a real AgoraPartial ad (guards a stray marker
    // match): trunc bytes 0..7, positive scale factors, a plausible pubkey.
    if (numAtomsTrunc == null || numSatsTrunc == null || atomsScale == null || scaledPerSat == null) return null;
    if (numAtomsTrunc > 7n || numSatsTrunc > 7n || atomsScale <= 0n || scaledPerSat <= 0n) return null;
    if (makerPk.length !== 66 || !['02', '03', '04'].includes(makerPk.slice(0, 2))) return null;
    // priceNanoSatsPerAtom ≈ 1e9·atomsScale·2^(8·numSatsTrunc) / (scaledPerSat·2^(8·numAtomsTrunc))
    const num = 1000000000n * atomsScale * (1n << (8n * numSatsTrunc));
    const den = scaledPerSat * (1n << (8n * numAtomsTrunc));
    if (den === 0n) return null;
    return num / den;
  } catch { return null; }
}

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

export const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export const CASHADDR_PREFIX = 'ecash';

export const _CASHADDR_GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

export function _cashaddrPolymod(values) {
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

export function _cashaddrConvertBits(data, fromBits, toBits, pad) {
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

export function _cashaddrEncode(typeBits, hash20Bytes) {
  // version byte: most-significant bit reserved 0; next 4 bits type (P2PKH=0, P2SH=1); last 3 bits size (0=20bytes)
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

export function parseOpReturn(hex) {
  if (!hex || !hex.startsWith('6a')) return null;
  const data = hex.slice(2);
  if (data.length < 8) return null;

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

  // For most LOKAD protocols the first push IS the 4-byte protocol identifier
  // (per https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/op_return-prefix-guideline.md).
  // The protocol-specific payload sits in the second push onward.
  const firstPushIsId = (pushLen === 4);
  const lokad = firstPushIsId ? firstPushHex.toLowerCase() : firstPushHex.slice(0, 8).toLowerCase();
  const afterId = firstPushIsId ? data.slice(push1Start + pushLen * 2) : null;

  // Helper: read consecutive pushes from a hex remainder
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
      return { type: 'cashtab', content: msgText || 'Cashtab message' };
    }
    // Non-standard inline form: first push contains id+msg
    const msgText = hexToUtf8(firstPushHex.slice(8));
    return { type: 'cashtab', content: msgText || 'Cashtab message' };
  }
  if (lokad === LOKAD.CASHTAB_ENC) {
    return { type: 'encrypted', content: 'Encrypted Cashtab message' };
  }
  if (lokad === LOKAD.ALIAS) {
    // Alias: <04 2e786563> <00 version> <01-15 alias> <15 cashaddr-payload>
    const pushes = afterId ? readAllPushes(afterId) : [];
    // pushes[0]=version (often empty since OP_0), pushes[1]=alias name, pushes[2]=payload
    let aliasName = '';
    for (let i = 0; i < pushes.length && i < 3; i++) {
      const txt = hexToUtf8(pushes[i]);
      if (/^[a-z0-9]+$/.test(txt) && txt.length >= 1 && txt.length <= 21) {
        aliasName = txt; break;
      }
    }
    return { type: 'alias', content: aliasName ? `alias: "${aliasName}"` : 'alias registration' };
  }
  if (lokad === LOKAD.AIRDROP) {
    // Airdrop: <04 drop> <20 tokenId> [<push> msg]
    const pushes = afterId ? readAllPushes(afterId) : [];
    let msg = 'Token airdrop';
    // pushes[0] should be 32-byte tokenId, pushes[1+] = optional msg
    if (pushes.length >= 2) {
      const m = pushes.slice(1).map(hexToUtf8).filter(Boolean).join(' ');
      if (m) msg = 'Airdrop · ' + m;
    }
    return { type: 'airdrop', content: msg };
  }
  // Note: Agora covenants put the AGR0 marker in the **inputScript** of the
  // covenant input, NOT in an OP_RETURN. The agora detection happens in
  // scrubTx(parseTransaction()) above by inspecting inputs[0]/inputs[1] inputScripts.
  // If we ever see AGR0 as a LOKAD prefix in OP_RETURN it's an unrelated
  // protocol or a misuse — return a generic 'broadcast' so it still surfaces
  // somewhere instead of getting silently dropped.
  if (lokad === LOKAD.AGORA) {
    return null; // let the inputScript-based agora detection synthesize the message
  }
  if (lokad === LOKAD.ECASHCHAT_TX) {
    // eCashChat: <04 chat> <push action> <push payload...>
    const pushes = afterId ? readAllPushes(afterId) : [];
    if (pushes.length === 0) return { type: 'broadcast', content: 'eCashChat message' };
    const action = hexToUtf8(pushes[0]);
    if (action === 'hash' && pushes[2]) {
      const reply = hexToUtf8(pushes[2]);
      return { type: 'broadcast', content: reply || 'eCashChat reply' };
    }
    if (action === 'post' && pushes[1]) {
      const post = hexToUtf8(pushes[1]);
      return { type: 'broadcast', content: post || 'eCashChat post' };
    }
    if (action === 'pass' && pushes[1]) {
      return { type: 'encrypted', content: 'Encrypted eCashChat message' };
    }
    // Generic chat-typed message — second push is the utf-8 message
    if (pushes[1]) {
      const msg = hexToUtf8(pushes[1]);
      if (msg) return { type: 'cashtab', content: msg };
    }
    const msg = hexToUtf8(pushes[0]);
    return { type: 'cashtab', content: msg || 'eCashChat message' };
  }
  if (lokad === LOKAD.ECASHCHAT_AUTH) {
    return { type: 'encrypted', content: 'eCashChat auth' };
  }
  if (lokad === LOKAD.PAYBUTTON) {
    // PayButton: <04 PAY\x00> <push version> <push nonce> <push data>
    const pushes = afterId ? readAllPushes(afterId) : [];
    const data = pushes[2] ? hexToUtf8(pushes[2]) : '';
    return { type: 'broadcast', content: data ? `PayButton: ${data}` : 'PayButton tx' };
  }
  if (lokad === LOKAD.PAYWALL) {
    return { type: 'broadcast', content: 'Paywall payment' };
  }
  if (lokad === LOKAD.CASHFUSION) {
    return { type: 'broadcast', content: 'CashFusion shuffle' };
  }
  if (lokad === LOKAD.ARTICLE) {
    const pushes = afterId ? readAllPushes(afterId) : [];
    const title = pushes[0] ? hexToUtf8(pushes[0]) : '';
    return { type: 'broadcast', content: title ? `Article: ${title.slice(0, 80)}` : 'eCashChat article' };
  }
  if (lokad === LOKAD.POWR) {
    // Proof of Writing (proofofwriting.com) — Bitcoin ABC doc/standards/
    // proofofwriting.md (D20215). After the 4-byte lokad push the script uses
    // BARE opcodes, not pushes: OP_0 version, OP_1..OP_9 action, then payload
    // pushes — so readAllPushes (which stops at bare opcodes) cannot parse
    // it; readScriptItems can. Article content is NOT on-chain (sha256 hashes
    // only), so there is nothing textual to show. Any payload that deviates
    // from the spec degrades to a generic label — recognize by lokad id,
    // enrich only when the shape holds (mirrors Cashtab's ecash-parse).
    const generic = { type: 'powr', content: 'Proof of Writing activity' };
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
    return content ? { type: 'powr', content, powr } : generic;
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
      return { type: 'broadcast', content: post || 'Memo post' };
    }
    return { type: 'broadcast', content: 'Memo action' };
  }

  // Otherwise try to interpret as plain text (no recognized protocol id)
  const text = hexToUtf8(firstPushHex);
  if (text && /^[\x20-\x7e\u00A0-\uFFFF]+$/.test(text) && text.length > 2) {
    return { type: 'broadcast', content: text };
  }
  return null;
}
