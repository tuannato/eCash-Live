// Differential harness: pre-B2 neo helpers vs vendor/txparse.js.
//   node tools/test-helper-parity.mjs            # committed fixture (CI)
//   node tools/test-helper-parity.mjs --full     # internal/parser-corpus.json
//   node tools/test-helper-parity.mjs --refresh  # refetch output scripts
//
// Evidence only. Step B1 compared the live inline copies to txparse (all ten
// IDENTICAL). After P0 B2 those copies are gone from index.html — neo imports
// the shared module. Re-extracting from the page would fail, and comparing
// txparse to itself would hide a later helper regression. The neo side is
// therefore the frozen pre-B2 bodies in neo-inline.pre-b2.mjs.
//
// Behavioural comparison, not textual: comments and formatting differ by
// design. What matters is whether the two produce the same output for the
// same input. Deep equality distinguishes null from undefined from ''.
//
// Default is the parser fixture so CI is offline. --refresh is the only
// network path (chronik only). The output-script corpus is optional.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  LOKAD as TX_LOKAD,
  LOKAD_NAMES as TX_LOKAD_NAMES,
  POWR_ACTIONS as TX_POWR_ACTIONS,
  TOKEN_DISPLAY_OVERRIDES as TX_TOKEN_OVERRIDES,
  hexToUtf8 as txHexToUtf8,
  encodeOutputScript as txEncodeOutputScript,
  readScriptItems as txReadScriptItems,
  agoraPartialPriceNanoSats as txAgoraPrice,
  parseFirstPush as txParseFirstPush,
  applyTokenOverride as txApplyTokenOverride,
  validateCashAddress,
  MESSAGE_LOKADS,
} from '../vendor/txparse.js';
import {
  LOKAD as neoLOKAD,
  LOKAD_NAMES as neoLOKAD_NAMES,
  POWR_ACTIONS as neoPOWR_ACTIONS,
  TOKEN_DISPLAY_OVERRIDES as neoTOKEN_DISPLAY_OVERRIDES,
  applyTokenOverride as neoApplyTokenOverride,
  hexToUtf8 as neoHexToUtf8,
  parseFirstPush as neoParseFirstPush,
  readScriptItems as neoReadScriptItems,
  agoraPartialPriceNanoSats as neoAgoraPrice,
  encodeOutputScript as neoEncodeOutputScript,
} from './neo-inline.pre-b2.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'fixtures/parser-corpus.min.json');
const PARSER_CORPUS_PATH = join(ROOT, 'internal/parser-corpus.json');
const OUTPUT_CORPUS_PATH = join(ROOT, 'internal/output-script-corpus.json');
const SNAPSHOT_PATH = join(HERE, 'neo-inline.pre-b2.mjs');
const REFRESH = process.argv.includes('--refresh');
const FULL = process.argv.includes('--full');

const CHRONIK_URLS = ['https://chronik1.ecashlive.net', 'https://chronik.e.cash'];
const OUT_BLOCK_COUNT = 6;
const OUT_PAGES_PER_BLOCK = 2;
const OUT_PAGE_SIZE = 200;
const REQUEST_GAP_MS = 180;
const RETRIES = 3;

// CashAddr test vector documented on both sides.
const CASHADDR_VEC_HASH160 = '7ad1e6c11691269dcf1272ddac04fb5e354aa0df';
const CASHADDR_VEC_P2PKH = '76a914' + CASHADDR_VEC_HASH160 + '88ac';
const CASHADDR_VEC_ADDR = 'ecash:qpadrekpz6gjd8w0zfedmtqyld0r2j4qmuthccqd8d';
const FIRMA_ID = '0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0';
const AGR0_PARTIAL_MARKER = '41475230' + '07' + '5041525449414c';

// ---------------------------------------------------------------------------
// Extract shipped neo symbols from index.html (verbatim, brace-balanced).
// ---------------------------------------------------------------------------
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const txparseSrc = readFileSync(join(ROOT, 'vendor/txparse.js'), 'utf8');
const flowHtml = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
const snapshotSrc = readFileSync(SNAPSHOT_PATH, 'utf8');
const modMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
if (!modMatch) throw new Error('no inline module in index.html');
const mod = modMatch[1];

// B2 swap-landed: neo must import these, not redefine them.
for (const needle of [
  'function hexToUtf8(',
  'function encodeOutputScript(',
  'function applyTokenOverride(',
  'function readScriptItems(',
  'function parseFirstPush(',
  'function agoraPartialPriceNanoSats(',
  'const LOKAD =',
  'const LOKAD_NAMES =',
  'const POWR_ACTIONS =',
  'const TOKEN_DISPLAY_OVERRIDES',
]) {
  if (mod.includes(needle)) {
    throw new Error('index.html still defines `' + needle + '` — B2 swap did not land');
  }
}
if (!mod.includes("from './vendor/txparse.js?v=p7'")) {
  throw new Error('index.html module does not import vendor/txparse.js?v=p7');
}
if (!snapshotSrc.includes("TextDecoder('utf-8'")) {
  throw new Error('pre-B2 snapshot hexToUtf8 is missing TextDecoder — wrong body?');
}
if (!snapshotSrc.includes(FIRMA_ID)) {
  throw new Error('pre-B2 snapshot is missing the Firma token id');
}
if (!snapshotSrc.includes('0x4e')) {
  throw new Error('pre-B2 snapshot readScriptItems is missing PUSHDATA4 — wrong body?');
}

// Smoke: the documented CashAddr vector must come out of the frozen pre-B2 body.
{
  const got = neoEncodeOutputScript(CASHADDR_VEC_P2PKH);
  if (got !== CASHADDR_VEC_ADDR) {
    throw new Error('smoke: extracted encodeOutputScript missed the documented vector: ' + got);
  }
  if (neoHexToUtf8('6869') !== 'hi') {
    throw new Error('smoke: extracted hexToUtf8("6869") !== "hi"');
  }
}

// ---------------------------------------------------------------------------
// Deep equality that distinguishes null / undefined / '' / NaN / -0 / bigint.
// ---------------------------------------------------------------------------
function same(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'bigint') return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  const bset = new Set(bk);
  for (const k of ak) {
    if (!bset.has(k)) return false;
    if (!same(a[k], b[k])) return false;
  }
  return true;
}

function invoke(fn, args) {
  try {
    return { ok: true, value: fn(...args) };
  } catch (e) {
    return {
      ok: false,
      errName: e && e.name ? e.name : 'Error',
      errMessage: e && e.message ? String(e.message) : String(e),
    };
  }
}

function describe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'bigint') return v.toString() + 'n';
  if (typeof v === 'string') {
    const shown = JSON.stringify(v);
    return shown.length > 160 ? shown.slice(0, 157) + '…"' : shown;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() + 'n' : val));
    return s.length > 240 ? s.slice(0, 237) + '…' : s;
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function describeResult(r) {
  if (!r.ok) return `THREW ${r.errName}: ${r.errMessage}`;
  return describe(r.value);
}

function describeArgs(args) {
  return args.map(describe).join(', ');
}

/** Unclipped identity for a case. `describe()` shortens long hex and would
 *  collapse distinct Agora/SLP scripts that share a 160-char prefix. */
function caseKey(c) {
  const parts = [c.label];
  for (const a of c.args) {
    if (a === undefined) parts.push('undefined');
    else if (typeof a === 'bigint') parts.push(a.toString() + 'n');
    else if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean' || a === null) {
      parts.push(JSON.stringify(a));
    } else {
      try { parts.push(JSON.stringify(a)); }
      catch { parts.push(String(a)); }
    }
  }
  return parts.join('\0');
}

function clip(s, n = 80) {
  if (s == null) return String(s);
  const t = String(s);
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Constant deep-compare.
// ---------------------------------------------------------------------------
function compareMaps(name, neoMap, txMap) {
  const neoKeys = Object.keys(neoMap);
  const txKeys = Object.keys(txMap);
  const neoSet = new Set(neoKeys);
  const txSet = new Set(txKeys);
  const onlyNeo = neoKeys.filter((k) => !txSet.has(k));
  const onlyTx = txKeys.filter((k) => !neoSet.has(k));
  const shared = neoKeys.filter((k) => txSet.has(k));
  const valueDiffs = [];
  for (const k of shared) {
    if (!same(neoMap[k], txMap[k])) {
      valueDiffs.push({ key: k, neo: neoMap[k], tx: txMap[k] });
    }
  }
  return {
    name,
    kind: 'constant',
    n: neoKeys.length + onlyTx.length,
    onlyNeo,
    onlyTx,
    valueDiffs,
    identical: onlyNeo.length === 0 && onlyTx.length === 0 && valueDiffs.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Function runner.
// ---------------------------------------------------------------------------
function runCases(name, neoFn, txFn, cases) {
  const diffs = [];
  let agree = 0;
  let bothThrew = 0;
  const seen = new Set();
  const unique = [];
  for (const c of cases) {
    const key = caseKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  for (const c of unique) {
    const a = invoke(neoFn, c.args);
    const b = invoke(txFn, c.args);
    const match = a.ok === b.ok
      && (a.ok ? same(a.value, b.value) : a.errName === b.errName);
    if (match) {
      agree++;
      if (!a.ok) bothThrew++;
    } else {
      diffs.push({
        label: c.label,
        args: c.args,
        neo: a,
        tx: b,
        size: describeArgs(c.args).length,
      });
    }
  }
  diffs.sort((x, y) => x.size - y.size);
  return {
    name,
    kind: 'function',
    n: unique.length,
    agree,
    differ: diffs.length,
    bothThrew,
    diffs,
    identical: diffs.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Input builders.
// ---------------------------------------------------------------------------
function utf8Hex(str) {
  return Buffer.from(str, 'utf8').toString('hex');
}

function pushHex(payloadHex) {
  const len = payloadHex.length / 2;
  if (len <= 0x4b) return len.toString(16).padStart(2, '0') + payloadHex;
  if (len <= 0xff) return '4c' + len.toString(16).padStart(2, '0') + payloadHex;
  const lo = (len & 0xff).toString(16).padStart(2, '0');
  const hi = ((len >> 8) & 0xff).toString(16).padStart(2, '0');
  return '4d' + lo + hi + payloadHex;
}

function leHex(n, bytes) {
  let v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) v = (1n << BigInt(bytes * 8)) + v;
  let h = '';
  for (let i = 0; i < bytes; i++) {
    h += (v & 0xffn).toString(16).padStart(2, '0');
    v >>= 8n;
  }
  return h;
}

function makeAgora({
  numAtomsTrunc = 0,
  numSatsTrunc = 0,
  atomsScale = 1n,
  scaledPerSat = 1n,
  minAccepted = 1n,
  lockTime = 0,
  makerPk = '02' + '11'.repeat(32),
  prefix = '',
  oddNibble = false,
} = {}) {
  const body = AGR0_PARTIAL_MARKER
    + leHex(numAtomsTrunc, 1)
    + leHex(numSatsTrunc, 1)
    + leHex(atomsScale, 8)
    + leHex(scaledPerSat, 8)
    + leHex(minAccepted, 8)
    + leHex(lockTime, 4)
    + makerPk;
  return (oddNibble ? '0' : '') + prefix + body;
}

function classifyOut(h) {
  if (!h) return 'empty';
  if (h.startsWith('6a')) return 'opreturn';
  if (h.length === 50 && h.startsWith('76a914') && h.endsWith('88ac')) return 'p2pkh';
  if (h.length === 46 && h.startsWith('a914') && h.endsWith('87')) return 'p2sh';
  return 'other';
}

// ---------------------------------------------------------------------------
// Output-script corpus (P2PKH / P2SH / other). OP_RETURN corpus is not enough.
// ---------------------------------------------------------------------------
async function loadChronik() {
  const { ChronikClient } = await import(join(ROOT, 'vendor/chronik-client.js'));
  return new ChronikClient(CHRONIK_URLS);
}

async function withRetry(label, fn) {
  let last;
  for (let i = 0; i < RETRIES; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const wait = 400 * (i + 1) * (i + 1);
      console.log(`  retry ${i + 1}/${RETRIES} ${label}: ${e && e.message ? e.message : e} (wait ${wait}ms)`);
      await sleep(wait);
    }
  }
  throw last;
}

function collectOutScript(hex, txid, into) {
  if (typeof hex !== 'string' || !hex) return;
  const key = hex.toLowerCase();
  let rec = into.get(key);
  if (!rec) {
    rec = { hex: key, count: 0, txid: txid || null, kind: classifyOut(key) };
    into.set(key, rec);
  }
  rec.count++;
}

async function buildOutputCorpus() {
  if (!REFRESH && existsSync(OUTPUT_CORPUS_PATH) && FULL) {
    const cached = JSON.parse(readFileSync(OUTPUT_CORPUS_PATH, 'utf8'));
    console.log(`reusing cached output-script corpus ${OUTPUT_CORPUS_PATH} (${cached.scripts.length} scripts, fetched ${cached.fetchedAt})`);
    return cached;
  }
  if (!REFRESH) {
    console.log('output-script corpus skipped (offline default; pass --full to use a local cache, --refresh to fetch)');
    return { fetchedAt: null, tipHeight: null, scripts: [] };
  }

  console.log('fetching ordinary output scripts from chronik (authorized this run, chronik only)…');
  const c = await loadChronik();
  const info = await withRetry('blockchainInfo', () => c.blockchainInfo());
  const tip = info.tipHeight;
  console.log(`  tipHeight ${tip}`);

  const scripts = new Map();
  const blocks = { heights: [], requests: 0, txsScanned: 0, outputs: 0, failed: [] };
  const firstHeight = tip - OUT_BLOCK_COUNT + 1;

  for (let h = firstHeight; h <= tip; h++) {
    for (let page = 0; page < OUT_PAGES_PER_BLOCK; page++) {
      await sleep(REQUEST_GAP_MS);
      let resp;
      try {
        resp = await withRetry(`blockTxs ${h} p${page}`, () => c.blockTxs(h, page, OUT_PAGE_SIZE));
      } catch (e) {
        blocks.failed.push({ height: h, page, err: String(e && e.message || e) });
        break;
      }
      blocks.requests++;
      const txs = Array.isArray(resp) ? resp : (resp && resp.txs) || [];
      if (page === 0) blocks.heights.push(h);
      blocks.txsScanned += txs.length;
      for (const tx of txs) {
        for (const o of (tx.outputs || [])) {
          blocks.outputs++;
          collectOutScript(o && o.outputScript, tx.txid, scripts);
        }
        for (const inp of (tx.inputs || [])) {
          collectOutScript(inp && inp.outputScript, tx.txid, scripts);
          if (inp && inp.prevOut) collectOutScript(inp.prevOut.outputScript, tx.txid, scripts);
        }
      }
      if (resp && resp.numPages != null && page + 1 >= resp.numPages) break;
      if (txs.length === 0) break;
    }
    console.log(`  block ${h}: ${scripts.size} distinct scripts so far`);
  }

  const corpus = {
    fetchedAt: new Date().toISOString(),
    tipHeight: tip,
    chronik: CHRONIK_URLS,
    blocks,
    scripts: [...scripts.values()],
  };
  writeFileSync(OUTPUT_CORPUS_PATH, JSON.stringify(corpus));
  console.log(`wrote ${OUTPUT_CORPUS_PATH} (${corpus.scripts.length} distinct scripts)`);
  return corpus;
}

// ---------------------------------------------------------------------------
// Shared-name inventory (extend the nine if another pair exists).
// ---------------------------------------------------------------------------
function exportedNames(src) {
  const names = [];
  const re = /^export (?:const|function) ([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return names;
}

function neoTopLevelNames(moduleSrc) {
  const names = new Set();
  const re = /(?:^|\n)(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(moduleSrc))) names.add(m[1]);
  return names;
}

const TX_EXPORTS = exportedNames(txparseSrc);
const NEO_TOP = neoTopLevelNames(mod);
const SHARED_NAMES = TX_EXPORTS.filter((n) => NEO_TOP.has(n));
const TX_ONLY = TX_EXPORTS.filter((n) => !NEO_TOP.has(n));
const NAMED_NINE = [
  'LOKAD', 'hexToUtf8', 'encodeOutputScript', 'LOKAD_NAMES', 'readScriptItems',
  'POWR_ACTIONS', 'agoraPartialPriceNanoSats', 'TOKEN_DISPLAY_OVERRIDES', 'parseFirstPush',
];
const EXTRA_PAIRS = SHARED_NAMES.filter((n) => !NAMED_NINE.includes(n) && n !== 'parseOpReturn');

// ---------------------------------------------------------------------------
// Build input sets, then run.
// ---------------------------------------------------------------------------
function hexToUtf8Cases(parserCorpus) {
  const cases = [];
  const add = (label, ...args) => cases.push({ label, args });

  add('empty-string', '');
  add('null', null);
  add('undefined', undefined);
  add('no-arg');
  add('number-0', 0);
  add('number-10', 10);
  add('false', false);
  add('true', true);
  add('object', {});
  add('array', []);

  add('odd-length-1', 'a');
  add('odd-length-3', 'abc');
  add('odd-length-6a0', '6a0');
  add('non-hex-zz', 'zz');
  add('non-hex-gg', 'gg');
  add('non-hex-mixed', '6axx');
  add('non-hex-space', '68 69');
  add('0x-prefix', '0x6869');
  add('6a-alone', '6a');
  add('uppercase-HI', '6869');
  add('uppercase-FF', 'FF');
  add('mixed-case', 'FFaa');

  add('ascii-hi', '6869');
  add('ascii-empty-bytes', '');
  add('nul-only', '00');
  add('embedded-nul', '610062');           // a\0b
  add('emoji-grin', utf8Hex('😀'));
  add('emoji-flags', utf8Hex('🇻🇳'));
  add('viet-diacritics', utf8Hex('Việt Nam — Xin chào thế giới'));
  add('viet-full', utf8Hex('Đặng Thị Ngọc Ánh'));
  add('nbsp', utf8Hex('\u00a0'));
  add('replacement-char', utf8Hex('\uFFFD'));

  // Invalid UTF-8. TextDecoder({fatal:false}) replaces; both sides share that.
  add('invalid-ff', 'ff');
  add('invalid-80', '80');
  add('overlong-c0af', 'c0af');
  add('lone-surrogate-ed-a0-80', 'eda080');   // U+D800
  add('lone-surrogate-ed-bf-bf', 'edbfbf');   // U+DFFF
  add('too-big-f4908080', 'f4908080');
  add('truncated-c3', 'c3');                  // start of 2-byte, no continuation
  add('truncated-e1bb', 'e1bb');              // start of ệ, missing last byte

  add('very-long-100k-a', '61'.repeat(100_000));
  add('very-long-odd', '61'.repeat(100_000) + '6');

  // Real corpus: the OP_RETURN hex itself, the body after 6a, and every push.
  const seenPush = new Set();
  for (const rec of parserCorpus.scripts) {
    const hex = rec.hex;
    add('corpus-script', hex);
    if (hex.startsWith('6a')) add('corpus-body', hex.slice(2));
    const { items } = txReadScriptItems(hex.startsWith('6a') ? hex.slice(2) : hex, 64);
    for (const it of items) {
      if (it.kind === 'push' && it.hex && !seenPush.has(it.hex)) {
        seenPush.add(it.hex);
        add('corpus-push', it.hex);
      }
    }
  }
  return cases;
}

function parseFirstPushCases(parserCorpus) {
  const cases = [];
  const add = (label, ...args) => cases.push({ label, args });

  add('empty-string', '');
  add('null', null);
  add('undefined', undefined);
  add('no-arg');
  add('6a-alone', '6a');
  add('odd-length', 'abc');
  add('non-hex', 'zz');
  add('one-byte', '01');
  add('OP_0', '00');
  add('OP_1NEGATE', '4f');
  add('OP_1', '51');
  add('OP_16', '60');

  add('direct-hello', pushHex(utf8Hex('hello')));
  add('direct-empty-payload-via-01-empty', '01'); // promises 1 byte, none follow
  add('PUSHDATA1-hello', '4c' + '05' + utf8Hex('hello'));
  add('PUSHDATA2-hello', '4d' + '0500' + utf8Hex('hello')); // not handled — both should null
  add('PUSHDATA4-hello', '4e' + '05000000' + utf8Hex('hello'));
  add('direct-75-as', '4b' + '61'.repeat(75));
  add('direct-76-illegal', '4c' + '4c' + '61'.repeat(76)); // 0x4c is PUSHDATA1, this is 76-byte via PUSHDATA1

  add('truncated-direct', '05ab');            // promises 5, has 1
  add('truncated-PUSHDATA1-len', '4c');       // no length byte
  add('truncated-PUSHDATA1-body', '4c05ab');  // promises 5, has 1
  add('zero-length-direct-impossible', '00'); // OP_0, not a push
  add('uppercase', pushHex(utf8Hex('Hi')).toUpperCase());
  add('emoji', pushHex(utf8Hex('😀')));
  add('viet', pushHex(utf8Hex('Việt')));
  add('embedded-nul', pushHex('610062'));

  for (const rec of parserCorpus.scripts) {
    const hex = rec.hex;
    add('corpus-full', hex);
    if (hex.startsWith('6a')) add('corpus-after-6a', hex.slice(2));
  }
  return cases;
}

function readScriptItemsCases(parserCorpus) {
  const cases = [];
  const add = (label, ...args) => cases.push({ label, args });

  add('empty-string', '');
  add('null', null);
  add('undefined', undefined);
  add('no-arg');
  add('6a-alone', '6a');
  add('odd-length', 'abc');
  add('non-hex-zz', 'zz');
  add('uppercase-hello', pushHex(utf8Hex('Hi')).toUpperCase());

  // Bare opcodes.
  add('OP_0', '00');
  add('OP_1NEGATE', '4f');
  for (let op = 0x51; op <= 0x60; op++) {
    add(`OP_${op - 0x50}`, op.toString(16));
  }
  add('OP_RESERVED', '50');
  add('OP_RETURN', '6a');
  add('OP_NOP', '61');
  add('OP_CHECKSIG', 'ac');

  // Direct pushes.
  add('direct-1-byte', '01aa');
  add('direct-75', '4b' + '11'.repeat(75));
  add('direct-0-illegal-is-OP_0', '00');

  // PUSHDATA1 / 2 / 4.
  add('PUSHDATA1-empty', '4c00');
  add('PUSHDATA1-1', '4c01aa');
  add('PUSHDATA1-75', '4c4b' + '22'.repeat(75));
  add('PUSHDATA1-76', '4c4c' + '22'.repeat(76));
  add('PUSHDATA1-255', '4cff' + '33'.repeat(255));
  add('PUSHDATA2-1', '4d0100' + 'aa');
  add('PUSHDATA2-256', '4d0001' + '44'.repeat(256));
  add('PUSHDATA4-1', '4e01000000' + 'aa');
  add('PUSHDATA4-0', '4e00000000');

  // Truncated pushes.
  add('trunc-direct', '05ab');
  add('trunc-PUSHDATA1-no-len', '4c');
  add('trunc-PUSHDATA1-body', '4c05abcd');
  add('trunc-PUSHDATA2-no-len', '4d01');
  add('trunc-PUSHDATA2-body', '4d0500aa');
  add('trunc-PUSHDATA4-no-len', '4e010000');
  add('trunc-PUSHDATA4-body', '4e05000000aa');

  // maxItems cap. Default is 32. Attainable range for a stream of OP_0: 0..∞,
  // but the function stops at maxItems and sets truncated.
  const op0 = (n) => '00'.repeat(n);
  add('cap-empty', op0(0));
  add('cap-default-31', op0(31));
  add('cap-default-32', op0(32));
  add('cap-default-33', op0(33));
  add('cap-default-64', op0(64));
  add('cap-explicit-0-of-0', op0(0), 0);
  add('cap-explicit-0-of-1', op0(1), 0);
  add('cap-explicit-1-of-1', op0(1), 1);
  add('cap-explicit-1-of-2', op0(2), 1);
  add('cap-explicit-32-of-32', op0(32), 32);
  add('cap-explicit-32-of-33', op0(33), 32);
  add('cap-explicit-31-of-32', op0(32), 31);
  add('mixed-ops-then-push', '00514f' + pushHex(utf8Hex('x')));
  add('push-then-OP_0', pushHex(utf8Hex('hi')) + '00');

  for (const rec of parserCorpus.scripts) {
    const hex = rec.hex;
    add('corpus-full', hex);
    if (hex.startsWith('6a')) add('corpus-after-6a', hex.slice(2));
  }
  return cases;
}

function encodeOutputScriptCases(outCorpus) {
  const cases = [];
  const add = (label, ...args) => cases.push({ label, args });

  add('empty-string', '');
  add('null', null);
  add('undefined', undefined);
  add('no-arg');
  add('number-0', 0);
  add('false', false);
  add('object', {});
  add('array', []);
  add('6a-alone', '6a');
  add('odd-length', '76a914');
  add('non-hex-in-hash', '76a914zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz88ac');

  // Documented vector.
  add('vec-p2pkh-lower', CASHADDR_VEC_P2PKH);
  add('vec-p2pkh-upper', CASHADDR_VEC_P2PKH.toUpperCase());
  add('vec-p2pkh-mixed', CASHADDR_VEC_P2PKH.slice(0, 10).toUpperCase() + CASHADDR_VEC_P2PKH.slice(10));

  // P2SH constructed from the same hash160.
  const vecP2sh = 'a914' + CASHADDR_VEC_HASH160 + '87';
  add('vec-p2sh', vecP2sh);
  add('vec-p2sh-upper', vecP2sh.toUpperCase());

  // Length edges around P2PKH (50 hex) and P2SH (46 hex).
  add('p2pkh-one-short', CASHADDR_VEC_P2PKH.slice(0, 48));
  add('p2pkh-one-long', CASHADDR_VEC_P2PKH + '00');
  add('p2pkh-bad-suffix', CASHADDR_VEC_P2PKH.slice(0, 46) + '88ad');
  add('p2pkh-bad-prefix', '76a915' + CASHADDR_VEC_HASH160 + '88ac');
  add('p2sh-one-short', vecP2sh.slice(0, 44));
  add('p2sh-one-long', vecP2sh + '00');
  add('p2sh-bad-suffix', vecP2sh.slice(0, 44) + '88');
  add('opreturn-cashtab', '6a04007461620568656c6c6f');
  add('bare-pubkey-33', '21' + '02' + '11'.repeat(32) + 'ac');
  add('p2pk-65', '41' + '04' + '11'.repeat(64) + 'ac');
  add('empty-script-op0', '00');

  for (const rec of outCorpus.scripts) {
    add('corpus-' + rec.kind, rec.hex);
  }
  return cases;
}

function agoraCases(parserCorpus) {
  const cases = [];
  const add = (label, ...args) => cases.push({ label, args });

  add('empty-string', '');
  add('null', null);
  add('undefined', undefined);
  add('no-arg');
  add('6a-alone', '6a');
  add('odd-length', 'abc');
  add('no-marker', '6a0400746162');
  add('marker-only', AGR0_PARTIAL_MARKER);
  add('marker-odd-nibble', '0' + AGR0_PARTIAL_MARKER + '00' + '00' + leHex(1, 8) + leHex(1, 8) + leHex(1, 8) + leHex(0, 4) + '02' + '11'.repeat(32));

  // Field-edge synthetics. Attainable: trunc 0..7 accepted, 8 rejected;
  // scale factors must be > 0; makerPk 33 bytes starting 02/03/04.
  add('edge-trunc-0-0', makeAgora({ numAtomsTrunc: 0, numSatsTrunc: 0 }));
  add('edge-trunc-7-7', makeAgora({ numAtomsTrunc: 7, numSatsTrunc: 7 }));
  add('edge-trunc-atoms-8', makeAgora({ numAtomsTrunc: 8 }));
  add('edge-trunc-sats-8', makeAgora({ numSatsTrunc: 8 }));
  add('edge-scale-0', makeAgora({ atomsScale: 0n }));
  add('edge-per-sat-0', makeAgora({ scaledPerSat: 0n }));
  add('edge-scale-1', makeAgora({ atomsScale: 1n, scaledPerSat: 1n }));
  add('edge-scale-u64max', makeAgora({ atomsScale: (1n << 64n) - 1n, scaledPerSat: 1n }));
  add('edge-persat-u64max', makeAgora({ atomsScale: 1n, scaledPerSat: (1n << 64n) - 1n }));
  add('edge-both-u64max', makeAgora({
    atomsScale: (1n << 64n) - 1n,
    scaledPerSat: (1n << 64n) - 1n,
  }));
  add('edge-result-near-u64', makeAgora({
    numAtomsTrunc: 0,
    numSatsTrunc: 0,
    atomsScale: 1n << 64n,          // 2^64, one past a u64 field if stored as u64
    scaledPerSat: 1n,
  }));
  // Intermediate product 1e9 * u64max * 2^(8*7) overflows Number; both use bigint.
  add('edge-number-overflow-intermediate', makeAgora({
    numAtomsTrunc: 0,
    numSatsTrunc: 7,
    atomsScale: (1n << 64n) - 1n,
    scaledPerSat: 1n,
  }));
  add('pk-02', makeAgora({ makerPk: '02' + 'ab'.repeat(32) }));
  add('pk-03', makeAgora({ makerPk: '03' + 'ab'.repeat(32) }));
  add('pk-04', makeAgora({ makerPk: '04' + 'ab'.repeat(32) }));
  add('pk-01-rejected', makeAgora({ makerPk: '01' + 'ab'.repeat(32) }));
  add('pk-short', makeAgora({ makerPk: '02' + 'ab'.repeat(16) }));
  add('truncated-after-marker', AGR0_PARTIAL_MARKER + '00');
  add('uppercase-marker', makeAgora({}).toUpperCase());

  let agoraN = 0;
  for (const rec of parserCorpus.scripts) {
    if (rec.hex.toLowerCase().includes(AGR0_PARTIAL_MARKER)) {
      add('corpus-agora', rec.hex);
      agoraN++;
    }
  }
  return { cases, agoraN };
}

function applyOverrideCases() {
  const cases = [];
  const add = (label, tokenId, o) => cases.push({
    label,
    args: [tokenId, o],
    // Fresh copy per side is made in the runner wrapper below.
  });
  add('null-id-null-o', null, null);
  add('undef-id-undef-o', undefined, undefined);
  add('empty-id', '', { name: 'X' });
  add('unknown-id', 'ff'.repeat(32), { name: 'X', ticker: 'Y' });
  add('firma-empty-obj', FIRMA_ID, {});
  add('firma-named', FIRMA_ID, { name: 'as minted', ticker: 'FIRMA' });
  add('firma-url-already', FIRMA_ID, { url: 'old.example' });
  add('firma-extra-keys', FIRMA_ID, { name: 'N', ticker: 'T', url: 'u', extra: 1 });
  add('no-o', FIRMA_ID, null);
  add('o-undefined', FIRMA_ID, undefined);
  add('id-undefined-obj', undefined, { name: 'X' });
  return cases;
}

// applyTokenOverride mutates `o`. Give each side its own clone so a mutation
// on one cannot leak into the other, then compare both the return and the
// mutated object. The runner below wraps that.
function runApplyOverride(neoFn, txFn, cases) {
  const diffs = [];
  let agree = 0;
  for (const c of cases) {
    const [tokenId, o] = c.args;
    const clone = (v) => {
      if (v && typeof v === 'object') return { ...v };
      return v;
    };
    const neoO = clone(o);
    const txO = clone(o);
    const a = invoke(neoFn, [tokenId, neoO]);
    const b = invoke(txFn, [tokenId, txO]);
    const retMatch = a.ok === b.ok && (a.ok ? same(a.value, b.value) : a.errName === b.errName);
    const mutMatch = same(neoO, txO);
    if (retMatch && mutMatch) {
      agree++;
    } else {
      diffs.push({
        label: c.label,
        args: c.args,
        neo: a,
        tx: b,
        neoMut: neoO,
        txMut: txO,
        size: describeArgs(c.args).length,
      });
    }
  }
  diffs.sort((x, y) => x.size - y.size);
  return {
    name: 'applyTokenOverride',
    kind: 'function',
    n: cases.length,
    agree,
    differ: diffs.length,
    bothThrew: 0,
    diffs,
    identical: diffs.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Boundary math (CLAUDE.md rule 6) — compute attainable range, then empty /
// full / exactly-at-edge / one-past. Results are pasted in the report.
// ---------------------------------------------------------------------------
function boundaryMath() {
  const rows = [];

  // readScriptItems maxItems. Attainable item count is 0..∞ for a well-formed
  // stream; the cap is the default 32 (or the caller-supplied maxItems).
  {
    const cap = 32;
    const mk = (n) => '00'.repeat(n);
    const trials = [
      ['empty', mk(0)],
      ['one-under', mk(cap - 1)],
      ['exactly-at-edge', mk(cap)],
      ['one-past', mk(cap + 1)],
    ];
    for (const [name, hex] of trials) {
      const neo = neoReadScriptItems(hex);
      const tx = txReadScriptItems(hex);
      rows.push({
        bound: `readScriptItems maxItems=${cap} ${name} (n=${hex.length / 2})`,
        neo: { n: neo.items.length, truncated: neo.truncated },
        tx: { n: tx.items.length, truncated: tx.truncated },
        same: same(neo, tx),
      });
    }
  }

  // encodeOutputScript length. P2PKH is exactly 50 hex chars; P2SH 46.
  {
    const p2pkh = CASHADDR_VEC_P2PKH;
    const p2sh = 'a914' + CASHADDR_VEC_HASH160 + '87';
    const trials = [
      ['p2pkh empty', ''],
      ['p2pkh one-short (49)', p2pkh.slice(0, 49)],
      ['p2pkh exactly-at-edge (50)', p2pkh],
      ['p2pkh one-past (51)', p2pkh + '0'],
      ['p2sh empty', ''],
      ['p2sh one-short (45)', p2sh.slice(0, 45)],
      ['p2sh exactly-at-edge (46)', p2sh],
      ['p2sh one-past (47)', p2sh + '0'],
    ];
    for (const [name, hex] of trials) {
      const neo = neoEncodeOutputScript(hex);
      const tx = txEncodeOutputScript(hex);
      rows.push({
        bound: `encodeOutputScript ${name}`,
        neo,
        tx,
        same: same(neo, tx),
      });
    }
  }

  // agora trunc bytes 0..7 accepted, 8 rejected. scale 0 rejected, 1 accepted.
  {
    const trials = [
      ['trunc 0 (empty/min)', makeAgora({ numAtomsTrunc: 0, numSatsTrunc: 0 })],
      ['trunc 7 (exactly-at-edge)', makeAgora({ numAtomsTrunc: 7, numSatsTrunc: 7 })],
      ['trunc 8 (one-past)', makeAgora({ numAtomsTrunc: 8, numSatsTrunc: 0 })],
      ['atomsScale 0 (empty/rejected)', makeAgora({ atomsScale: 0n })],
      ['atomsScale 1 (min accepted)', makeAgora({ atomsScale: 1n })],
      ['atomsScale 2^64-1 (u64 full)', makeAgora({ atomsScale: (1n << 64n) - 1n })],
      ['atomsScale 2^64 (one-past u64 field)', makeAgora({ atomsScale: 1n << 64n })],
    ];
    for (const [name, hex] of trials) {
      const neo = invoke(neoAgoraPrice, [hex]);
      const tx = invoke(txAgoraPrice, [hex]);
      rows.push({
        bound: `agoraPartialPriceNanoSats ${name}`,
        neo: describeResult(neo),
        tx: describeResult(tx),
        same: neo.ok === tx.ok && (neo.ok ? same(neo.value, tx.value) : neo.errName === tx.errName),
      });
    }
  }

  // hexToUtf8 length parity. Attainable: even-length hex → decoded string;
  // odd-length → ''.
  {
    const trials = [
      ['empty', ''],
      ['1 nibble (odd, one-past empty)', '6'],
      ['1 byte (exactly 2 nibbles)', '61'],
      ['odd 3 nibbles', '616'],
    ];
    for (const [name, hex] of trials) {
      const neo = neoHexToUtf8(hex);
      const tx = txHexToUtf8(hex);
      rows.push({
        bound: `hexToUtf8 ${name}`,
        neo,
        tx,
        same: same(neo, tx),
      });
    }
  }

  // parseFirstPush: firstByte in 1..75 or 0x4c. 0 and 76 are the edges.
  {
    const trials = [
      ['empty', ''],
      ['firstByte 0 (OP_0, below range)', '00'],
      ['firstByte 1 (exactly-at-edge low)', '01aa'],
      ['firstByte 75 (exactly-at-edge high)', '4b' + '61'.repeat(75)],
      ['firstByte 76 (0x4c PUSHDATA1, handled)', '4c01aa'],
      ['firstByte 77 (0x4d PUSHDATA2, NOT handled)', '4d0100aa'],
    ];
    for (const [name, hex] of trials) {
      const neo = neoParseFirstPush(hex);
      const tx = txParseFirstPush(hex);
      rows.push({
        bound: `parseFirstPush ${name}`,
        neo,
        tx,
        same: same(neo, tx),
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function loadParserCorpus() {
  const path = FULL ? PARSER_CORPUS_PATH : FIXTURE_PATH;
  const label = FULL ? 'full corpus' : 'fixture';
  if (!existsSync(path)) {
    throw new Error('missing ' + path + (FULL ? ' — pass no flag to use the committed fixture' : ' — run tools/make-parser-fixture.mjs'));
  }
  const cached = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(cached.scripts) || cached.scripts.length === 0) {
    throw new Error(path + ' has no scripts');
  }
  console.log(`using parser ${label} ${path} (${cached.scripts.length} scripts, fetched ${cached.fetchedAt})`);
  return cached;
}
const parserCorpus = loadParserCorpus();

const outCorpus = await buildOutputCorpus();

const constResults = [
  compareMaps('LOKAD', neoLOKAD, TX_LOKAD),
  compareMaps('LOKAD_NAMES', neoLOKAD_NAMES, TX_LOKAD_NAMES),
  compareMaps('POWR_ACTIONS', neoPOWR_ACTIONS, TX_POWR_ACTIONS),
  compareMaps('TOKEN_DISPLAY_OVERRIDES', neoTOKEN_DISPLAY_OVERRIDES, TX_TOKEN_OVERRIDES),
];

const hexCases = hexToUtf8Cases(parserCorpus);
const firstPushCases = parseFirstPushCases(parserCorpus);
const readCases = readScriptItemsCases(parserCorpus);
const encodeCases = encodeOutputScriptCases(outCorpus);
const { cases: agoraInputCases, agoraN } = agoraCases(parserCorpus);

const fnResults = [
  runCases('hexToUtf8', neoHexToUtf8, txHexToUtf8, hexCases),
  runCases('parseFirstPush', neoParseFirstPush, txParseFirstPush, firstPushCases),
  runCases('readScriptItems', neoReadScriptItems, txReadScriptItems, readCases),
  runCases('encodeOutputScript', neoEncodeOutputScript, txEncodeOutputScript, encodeCases),
  runCases('agoraPartialPriceNanoSats', neoAgoraPrice, txAgoraPrice, agoraInputCases),
  runApplyOverride(neoApplyTokenOverride, txApplyTokenOverride, applyOverrideCases()),
];

const bounds = boundaryMath();

// Correctness spot-checks (spec / documented vector), independent of parity.
const correctness = [];
{
  const neo = neoEncodeOutputScript(CASHADDR_VEC_P2PKH);
  const tx = txEncodeOutputScript(CASHADDR_VEC_P2PKH);
  correctness.push({
    name: 'CashAddr P2PKH test vector',
    want: CASHADDR_VEC_ADDR,
    neo, tx,
    neoOk: neo === CASHADDR_VEC_ADDR,
    txOk: tx === CASHADDR_VEC_ADDR,
    valid: validateCashAddress(tx),
  });
}
{
  const p2sh = 'a914' + CASHADDR_VEC_HASH160 + '87';
  const neo = neoEncodeOutputScript(p2sh);
  const tx = txEncodeOutputScript(p2sh);
  correctness.push({
    name: 'CashAddr P2SH (same hash160 → ecash:p…)',
    want: 'ecash:p… and validateCashAddress true',
    neo, tx,
    neoOk: typeof neo === 'string' && neo.startsWith('ecash:p'),
    txOk: typeof tx === 'string' && tx.startsWith('ecash:p'),
    valid: typeof tx === 'string' && validateCashAddress(tx),
  });
}
{
  const neo = neoHexToUtf8(utf8Hex('Việt'));
  const tx = txHexToUtf8(utf8Hex('Việt'));
  correctness.push({
    name: 'hexToUtf8 Vietnamese',
    want: 'Việt',
    neo, tx,
    neoOk: neo === 'Việt',
    txOk: tx === 'Việt',
    valid: true,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function verdictOf(r) {
  if (r.kind === 'constant') return r.identical ? 'IDENTICAL' : 'DIFFERS';
  return r.identical ? 'IDENTICAL' : 'DIFFERS';
}

console.log('\n========== HELPER PARITY — pre-B2 neo vs vendor/txparse.js ==========');
console.log('evidence only; no shipped file was written.');
console.log(`neo side: frozen pre-B2 bodies from tools/neo-inline.pre-b2.mjs (${NAMED_NINE.join(', ')}, applyTokenOverride, cashaddr helpers)`);
console.log(`parser corpus: ${parserCorpus.scripts.length} OP_RETURN scripts @ ${parserCorpus.fetchedAt} tip=${parserCorpus.tipHeight}`);
console.log(`output corpus: ${outCorpus.scripts.length} scripts @ ${outCorpus.fetchedAt || '—'} tip=${outCorpus.tipHeight == null ? '—' : outCorpus.tipHeight}`);
{
  const byKind = { p2pkh: 0, p2sh: 0, opreturn: 0, other: 0, empty: 0 };
  for (const s of outCorpus.scripts) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  console.log(`  output kinds: p2pkh=${byKind.p2pkh} p2sh=${byKind.p2sh} opreturn=${byKind.opreturn} other=${byKind.other}`);
}
{
  let agoraNonNull = 0;
  for (const rec of parserCorpus.scripts) {
    if (!rec.hex.toLowerCase().includes(AGR0_PARTIAL_MARKER)) continue;
    const r = invoke(txAgoraPrice, [rec.hex]);
    if (r.ok && r.value != null) agoraNonNull++;
  }
  console.log(`agora PARTIAL scripts in parser corpus: ${agoraN}  (non-null price: ${agoraNonNull})`);
}

console.log('\n--- Shared-name inventory ---');
console.log(`  txparse exports (${TX_EXPORTS.length}): ${TX_EXPORTS.join(', ')}`);
console.log(`  names still defined in live neo (should be none of the ten after B2): ${SHARED_NAMES.join(', ') || '(none)'}`);
console.log(`  txparse-only vs live neo definitions: ${TX_ONLY.join(', ') || '(none)'}`);
console.log(`  extra live pairs beyond the named nine: ${EXTRA_PAIRS.join(', ') || '(none)'}`);
console.log('  validateCashAddress: txparse-only, 0 definitions in neo — addition, not tested as a pair.');
console.log('  MESSAGE_LOKADS: txparse-only, 0 definitions in neo — addition, not tested as a pair.');
console.log('  parseOpReturn: pair, already measured in test-parser-parity.mjs (step A) — not re-tested here.');
console.log('  parseTransactionCore vs neo parseTransaction: different names, wrapper stays local.');

const flowMentions = {
  validateCashAddress: (flowHtml.match(/validateCashAddress/g) || []).length,
  MESSAGE_LOKADS: (flowHtml.match(/MESSAGE_LOKADS/g) || []).length,
  applyTokenOverride: (flowHtml.match(/applyTokenOverride/g) || []).length,
};
console.log(`  flow/index.html mentions: validateCashAddress=${flowMentions.validateCashAddress} MESSAGE_LOKADS=${flowMentions.MESSAGE_LOKADS} applyTokenOverride=${flowMentions.applyTokenOverride}`);

console.log('\n--- Verdicts ---');
console.log(`  ${pad('symbol', 28)} ${pad('kind', 10)} ${pad('verdict', 12)} ${padL('inputs', 8)} ${padL('agree', 8)} ${padL('differ', 8)}`);
const all = [...constResults, ...fnResults];
for (const r of all) {
  const v = verdictOf(r);
  const n = r.n;
  const ag = r.kind === 'constant' ? (r.identical ? n : n - r.valueDiffs.length - r.onlyNeo.length - r.onlyTx.length) : r.agree;
  const df = r.kind === 'constant' ? (r.onlyNeo.length + r.onlyTx.length + r.valueDiffs.length) : r.differ;
  console.log(`  ${pad(r.name, 28)} ${pad(r.kind, 10)} ${pad(v, 12)} ${padL(n, 8)} ${padL(ag, 8)} ${padL(df, 8)}`);
}

console.log('\n--- Constants (key-level) ---');
for (const r of constResults) {
  console.log(`  ${r.name}: ${verdictOf(r)}  keys neo=${Object.keys(r.name === 'LOKAD' ? neoLOKAD : r.name === 'LOKAD_NAMES' ? neoLOKAD_NAMES : r.name === 'POWR_ACTIONS' ? neoPOWR_ACTIONS : neoTOKEN_DISPLAY_OVERRIDES).length} tx=${Object.keys(r.name === 'LOKAD' ? TX_LOKAD : r.name === 'LOKAD_NAMES' ? TX_LOKAD_NAMES : r.name === 'POWR_ACTIONS' ? TX_POWR_ACTIONS : TX_TOKEN_OVERRIDES).length}`);
  if (r.onlyNeo.length) console.log(`    only neo: ${r.onlyNeo.join(', ')}`);
  if (r.onlyTx.length) console.log(`    only txparse: ${r.onlyTx.join(', ')}`);
  if (r.valueDiffs.length) {
    for (const d of r.valueDiffs) {
      console.log(`    value differs @ ${d.key}:`);
      console.log(`      neo     ${describe(d.neo)}`);
      console.log(`      txparse ${describe(d.tx)}`);
    }
  }
  if (r.identical) {
    if (r.name === 'TOKEN_DISPLAY_OVERRIDES') {
      const firma = neoTOKEN_DISPLAY_OVERRIDES[FIRMA_ID];
      console.log(`    Firma ${FIRMA_ID.slice(0, 16)}… = ${describe(firma)}`);
      console.log('    mirror of the "stop renaming Firma" change DID land on both sides (url only, no tokenName/tokenTicker).');
    }
  }
}

console.log('\n--- DIFFERS (smallest reproducing input first) ---');
let anyDiff = false;
for (const r of fnResults) {
  if (!r.diffs.length) continue;
  anyDiff = true;
  console.log(`  ${r.name}: ${r.diffs.length} differing input(s)`);
  for (const d of r.diffs.slice(0, 12)) {
    console.log(`    [${d.label}] args=(${describeArgs(d.args)})`);
    console.log(`      neo     ${describeResult(d.neo)}`);
    console.log(`      txparse ${describeResult(d.tx)}`);
    if (d.neoMut !== undefined) {
      console.log(`      neo mut ${describe(d.neoMut)}`);
      console.log(`      tx  mut ${describe(d.txMut)}`);
    }
  }
  if (r.diffs.length > 12) console.log(`    … ${r.diffs.length - 12} more`);
}
if (!anyDiff) console.log('  none. Every function agreed on every input tried.');

console.log('\n--- Boundary math (CLAUDE.md rule 6) ---');
for (const b of bounds) {
  const mark = b.same ? 'same' : 'DIFF';
  console.log(`  [${mark}] ${b.bound}`);
  console.log(`         neo=${describe(b.neo)}  tx=${describe(b.tx)}`);
}

console.log('\n--- Spec / documented-vector spot checks ---');
for (const c of correctness) {
  console.log(`  ${c.name}: want ${describe(c.want)}`);
  console.log(`    neo=${describe(c.neo)} (${c.neoOk ? 'ok' : 'FAIL'})  tx=${describe(c.tx)} (${c.txOk ? 'ok' : 'FAIL'})  checksum=${c.valid}`);
}

console.log('\n--- What this run did NOT exercise ---');
console.log('  - Browser TextDecoder vs Node TextDecoder. Both sides ran in Node  (same ICU). A browser replacement-character difference on invalid UTF-8 is theoretically possible and was not compared.');
console.log('  - hexToUtf8 / parseFirstPush / readScriptItems call-site argument shapes beyond what the functions accept. The 17 hexToUtf8 uses in neo all pass hex strings derived from script pushes; those payloads are covered via the corpus pushes.');
console.log('  - encodeOutputScript on every historical output ever. Sample is recent-block + adversarial + the documented vector.');
console.log('  - agoraPartialPriceNanoSats on ONESHOT (AGR0+ONESHOT) scripts: parser corpus has 0 ONESHOT OP_RETURNs; the function looks only for PARTIAL.');
console.log('  - validateCashAddress as a pair (neo does not define it). Used only as a checksum on encoded addresses.');
console.log('  - MESSAGE_LOKADS as a pair (neo does not define it).');
console.log('  - parseOpReturn / parseTransaction (step A / out of scope).');
console.log('  - A live browser rendering path. This is a Node harness.');

console.log('\n========== end ==========');

const summary = all.map((r) => `${r.name}=${verdictOf(r)}:${r.n}`).join(' ');
console.log('SUMMARY ' + summary);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  c ? pass++ : fail++;
  console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x));
};

console.log('\n-- CI assertions --');
ok('index.html imports vendor/txparse.js?v=p7', mod.includes("from './vendor/txparse.js?v=p7'"));
ok('index.html defines none of the ten swapped helpers', SHARED_NAMES.length === 0, SHARED_NAMES.join(', '));
for (const r of all) {
  ok(r.name + ' IDENTICAL', r.identical, verdictOf(r) + ' n=' + r.n);
}
ok('every boundary trial agrees', bounds.every((b) => b.same),
  bounds.filter((b) => !b.same).map((b) => b.bound).join('; '));
for (const c of correctness) {
  ok(c.name + ' neo', c.neoOk, describe(c.neo));
  ok(c.name + ' txparse', c.txOk, describe(c.tx));
  if ('valid' in c) ok(c.name + ' checksum', !!c.valid, String(c.valid));
}
ok('parser fixture/corpus is non-empty', parserCorpus.scripts.length > 0,
  String(parserCorpus.scripts.length));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
