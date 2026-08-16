// Differential harness: pre-B2 neo parseOpReturn vs vendor/txparse.js.
//   node tools/test-parser-parity.mjs            # committed fixture (CI)
//   node tools/test-parser-parity.mjs --full     # internal/parser-corpus.json
//   node tools/test-parser-parity.mjs --refresh  # refetch from chronik
//
// After P0 B2, index.html no longer defines parseOpReturn — neo imports
// vendor/txparse.js. Re-extracting from the page would compare txparse to
// itself and hide the 1,070-tx Alias/PayButton behaviour change this step
// shipped. The neo side is therefore the frozen pre-B2 body in
// neo-inline.pre-b2.mjs (verbatim extract, taken before the swap).
// That is the regression oracle: pre-swap neo vs live txparse, same buckets.
//
// Default is the fixture so CI is offline. --full / --refresh need the local
// full corpus (gitignored) or a chronik fetch.
//
// Network: chronik only, and only with --refresh.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseOpReturn as txparseOpReturn, MESSAGE_LOKADS, LOKAD as TX_LOKAD } from '../vendor/txparse.js';
import { parseOpReturn as neoParseOpReturn, LOKAD as NEO_LOKAD } from './neo-inline.pre-b2.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'fixtures/parser-corpus.min.json');
const FULL_CORPUS_PATH = join(ROOT, 'internal/parser-corpus.json');
const SNAPSHOT_PATH = join(HERE, 'neo-inline.pre-b2.mjs');
const REFRESH = process.argv.includes('--refresh');
const FULL = process.argv.includes('--full');

const CHRONIK_URLS = ['https://chronik1.ecashlive.net', 'https://chronik.e.cash'];
const BLOCK_COUNT = 48;          // recent blocks for the unbiased population
const LOKAD_PAGE_SIZE = 200;
const LOKAD_PAGES = 5;           // pages per MESSAGE_LOKADS id
const REQUEST_GAP_MS = 180;
const RETRIES = 3;

// ---------------------------------------------------------------------------
// Live page is the swap-landed check. Pre-B2 neo is the frozen snapshot.
// ---------------------------------------------------------------------------
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const txparseSrc = readFileSync(join(ROOT, 'vendor/txparse.js'), 'utf8');
const snapshotSrc = readFileSync(SNAPSHOT_PATH, 'utf8');
const modMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
if (!modMatch) throw new Error('no inline module in index.html');
const mod = modMatch[1];

if (/function parseOpReturn\s*\(/.test(mod)) {
  throw new Error('index.html still defines parseOpReturn — B2 swap did not land');
}
if (!mod.includes("from './vendor/txparse.js?v=p7'")) {
  throw new Error('index.html module does not import vendor/txparse.js?v=p7');
}
if (!snapshotSrc.includes('EMPP marker')) {
  throw new Error('pre-B2 snapshot is missing the EMPP-marker comment — wrong body?');
}
if (!('CASHTAB_MSG' in NEO_LOKAD)) {
  throw new Error('pre-B2 snapshot LOKAD does not look like the shipped map');
}

const LOKAD_BY_ID = Object.fromEntries(Object.entries(NEO_LOKAD).map(([k, v]) => [v, k]));
// PayButton is already in MESSAGE_LOKADS; listed again so the report can say so.
const TARGET_LOKADS = [...MESSAGE_LOKADS];
if (!TARGET_LOKADS.includes(TX_LOKAD.PAYBUTTON)) TARGET_LOKADS.push(TX_LOKAD.PAYBUTTON);

// ---------------------------------------------------------------------------
// Static assertion: Agora carry lives in parseTransactionCore, not parseOpReturn.
// ---------------------------------------------------------------------------
function lineOf(src, needle) {
  const at = src.indexOf(needle);
  if (at === -1) return null;
  return src.slice(0, at).split('\n').length;
}

const NEO_AGORA_ASSIGN = `tx.message = {
      type: synthType,
      content: tx.agora.label || 'Agora interaction',
      synthetic: true,
    };`;
const TX_AGORA_CARRIED = 'const carried = tx.message && tx.message.text ? tx.message.text : null;';
const TX_AGORA_ASSIGN = "tx.message = msg(synthType, tx.agora.label || 'Agora interaction', carried);";

const agoraStatic = {
  neoLine: lineOf(html, NEO_AGORA_ASSIGN),
  snapshotLine: lineOf(snapshotSrc, NEO_AGORA_ASSIGN),
  txCarriedLine: lineOf(txparseSrc, TX_AGORA_CARRIED),
  txAssignLine: lineOf(txparseSrc, TX_AGORA_ASSIGN),
  neoHasTextField: /text\s*:/.test(NEO_AGORA_ASSIGN),
  txPassesCarried: txparseSrc.includes(TX_AGORA_CARRIED) && txparseSrc.includes(TX_AGORA_ASSIGN),
};

// ---------------------------------------------------------------------------
// Script-kind peek — reporting only, not a third parser. Mirrors the first-byte
// dispatch both sides share (0x4c / 0x4d / 1..75) so a LOKAD id can be named.
// ---------------------------------------------------------------------------
function readFirstPush(dataHex) {
  if (!dataHex || dataHex.length < 2) return null;
  const firstByte = parseInt(dataHex.slice(0, 2), 16);
  if (Number.isNaN(firstByte)) return null;
  let pushLen, start;
  if (firstByte === 0x4c) { pushLen = parseInt(dataHex.slice(2, 4), 16); start = 4; }
  else if (firstByte === 0x4d) { pushLen = parseInt(dataHex.slice(4, 6) + dataHex.slice(2, 4), 16); start = 6; }
  else if (firstByte > 0 && firstByte <= 75) { pushLen = firstByte; start = 2; }
  else return { op: firstByte, hex: '' };
  const hex = dataHex.slice(start, start + pushLen * 2);
  return { len: pushLen, hex };
}

function walkPushes(dataHex, max = 16) {
  const out = [];
  let p = dataHex || '';
  while (p.length >= 2 && out.length < max) {
    const firstByte = parseInt(p.slice(0, 2), 16);
    if (Number.isNaN(firstByte)) break;
    let len, start;
    if (firstByte === 0x4c) { len = parseInt(p.slice(2, 4), 16); start = 4; }
    else if (firstByte === 0x4d) { len = parseInt(p.slice(4, 6) + p.slice(2, 4), 16); start = 6; }
    else if (firstByte > 0 && firstByte <= 75) { len = firstByte; start = 2; }
    else break;
    if (!Number.isFinite(len) || p.length < start + len * 2) break;
    out.push(p.slice(start, start + len * 2));
    p = p.slice(start + len * 2);
  }
  return out;
}

function scriptKind(hex) {
  const h = (hex || '').toLowerCase();
  if (!h.startsWith('6a')) return { kind: 'not-opreturn', lokad: null, inners: [] };
  const data = h.slice(2);
  if (data.startsWith('50')) {
    const inners = [];
    for (const frag of walkPushes(data.slice(2))) {
      if (frag.length >= 8) inners.push(frag.slice(0, 8));
    }
    return { kind: 'empp', lokad: 'empp', inners };
  }
  const first = readFirstPush(data);
  if (!first || first.op != null) return { kind: 'bare-op', lokad: null, inners: [] };
  if (first.len === 4) {
    const id = first.hex.toLowerCase();
    return { kind: LOKAD_BY_ID[id] || (id === '534c5000' ? 'SLP' : id === '534c5032' ? 'ALP' : 'unknown-lokad'), lokad: id, inners: [] };
  }
  const prefix = first.hex.slice(0, 8).toLowerCase();
  if (LOKAD_BY_ID[prefix] || prefix === '534c5000' || prefix === '534c5032') {
    return { kind: 'inline-' + (LOKAD_BY_ID[prefix] || prefix), lokad: prefix, inners: [] };
  }
  if (first.hex.startsWith('6d')) return { kind: 'memo', lokad: 'memo', inners: [] };
  return { kind: 'other', lokad: null, inners: [] };
}

function classify(neo, txp) {
  if (neo === null && txp === null) return 'agree';
  if (neo === null && txp !== null) return 'neo-null';
  if (neo !== null && txp === null) return 'txparse-null';
  if (neo.type === txp.type && neo.content === txp.content) return 'agree';
  return 'content-differs';
}

function clip(s, n = 80) {
  if (s == null) return 'null';
  const t = String(s).replace(/\s+/g, ' ');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Corpus: fixture by default. --full reads the local full corpus. --refresh
// fetches from chronik and writes internal/parser-corpus.json (not the fixture).
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

function collectOutputs(tx, into, meta) {
  let n = 0;
  for (const o of (tx.outputs || [])) {
    const hex = o && o.outputScript;
    if (typeof hex !== 'string' || !hex.startsWith('6a')) continue;
    const key = hex.toLowerCase();
    let rec = into.get(key);
    if (!rec) {
      rec = { hex: key, blockCount: 0, lokads: [], txid: tx.txid || null };
      into.set(key, rec);
    }
    if (meta.source === 'block') rec.blockCount += 1;
    if (meta.lokad && !rec.lokads.includes(meta.lokad)) rec.lokads.push(meta.lokad);
    if (!rec.txid && tx.txid) rec.txid = tx.txid;
    n++;
  }
  return n;
}

function loadLocalCorpus(path, label) {
  if (!existsSync(path)) {
    throw new Error(label + ' not present at ' + path);
  }
  const cached = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(cached.scripts) || cached.scripts.length === 0) {
    throw new Error(path + ' has no scripts');
  }
  console.log(`using ${label} ${path} (${cached.scripts.length} scripts, fetched ${cached.fetchedAt})`);
  return cached;
}

async function buildCorpus() {
  if (!REFRESH && !FULL) {
    return loadLocalCorpus(FIXTURE_PATH, 'fixture');
  }
  if (!REFRESH && FULL) {
    return loadLocalCorpus(FULL_CORPUS_PATH, 'full corpus');
  }

  console.log('fetching corpus from chronik (authorized this run, chronik only)…');
  const c = await loadChronik();
  const info = await withRetry('blockchainInfo', () => c.blockchainInfo());
  const tip = info.tipHeight;
  console.log(`  tipHeight ${tip}`);

  const scripts = new Map();
  const blocks = {
    heights: [],
    requests: 0,
    txsScanned: 0,
    opreturnOutputs: 0,
    failed: [],
  };

  // Unbiased population: several recent blocks, every OP_RETURN output.
  const firstHeight = tip - BLOCK_COUNT + 1;
  for (let h = firstHeight; h <= tip; h++) {
    let page = 0;
    let numPages = 1;
    while (page < numPages) {
      await sleep(REQUEST_GAP_MS);
      let resp;
      try {
        resp = await withRetry(`blockTxs ${h} p${page}`, () => c.blockTxs(h, page, 200));
      } catch (e) {
        blocks.failed.push({ height: h, page, err: String(e && e.message || e) });
        break;
      }
      blocks.requests++;
      const txs = Array.isArray(resp) ? resp : (resp && resp.txs) || [];
      if (page === 0) {
        blocks.heights.push(h);
        numPages = resp && resp.numPages ? resp.numPages : 1;
      }
      blocks.txsScanned += txs.length;
      for (const tx of txs) blocks.opreturnOutputs += collectOutputs(tx, scripts, { source: 'block' });
      page++;
    }
    if ((h - firstHeight + 1) % 10 === 0) {
      console.log(`  blocks ${firstHeight}–${h}: ${blocks.opreturnOutputs} OP_RETURN, ${scripts.size} distinct`);
    }
  }

  const lokad = {};
  for (const id of TARGET_LOKADS) {
    const name = LOKAD_BY_ID[id] || id;
    const rec = {
      name, id, pages: [], pageSize: LOKAD_PAGE_SIZE, numTxs: null, numPages: null,
      txsScanned: 0, opreturnOutputs: 0, failed: [],
    };
    for (let p = 0; p < LOKAD_PAGES; p++) {
      await sleep(REQUEST_GAP_MS);
      let resp;
      try {
        resp = await withRetry(`lokad ${name} p${p}`, () => c.lokadId(id).history(p, LOKAD_PAGE_SIZE));
      } catch (e) {
        rec.failed.push({ page: p, err: String(e && e.message || e) });
        break;
      }
      rec.pages.push(p);
      if (p === 0) { rec.numTxs = resp.numTxs; rec.numPages = resp.numPages; }
      const txs = (resp && resp.txs) || [];
      rec.txsScanned += txs.length;
      for (const tx of txs) rec.opreturnOutputs += collectOutputs(tx, scripts, { source: 'lokad', lokad: id });
      if (resp && resp.numPages != null && p + 1 >= resp.numPages) break;
      if (txs.length === 0) break;
    }
    lokad[id] = rec;
    console.log(`  lokad ${name} (${id}): ${rec.txsScanned} txs / ${rec.numTxs} indexed, pages ${rec.pages.join(',')}`);
  }

  const corpus = {
    fetchedAt: new Date().toISOString(),
    tipHeight: tip,
    chronik: CHRONIK_URLS,
    blocks,
    lokad,
    scripts: [...scripts.values()],
  };
  writeFileSync(FULL_CORPUS_PATH, JSON.stringify(corpus));
  console.log(`wrote ${FULL_CORPUS_PATH} (${corpus.scripts.length} distinct scripts)`);
  return corpus;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const extractNotes = [];
if (!snapshotSrc.includes('if (firstPushHex.startsWith(\'50\') && !firstPushIsId) return null;')) {
  extractNotes.push('pre-B2 neo EMPP-marker branch (dead after the first-byte else) was not found as a literal');
}

// Smoke: a known eMPP Cashtab note (from internal/test-txparse-empp.mjs) must
// be neo-null / txparse-message before we trust the extracted body.
const SMOKE_EMPP = '6a5037534c5032000453454e44f0cb08302c4bbc665b6241592b19fd37ec5d632f323e9ab14fdb75d57f94870302404b4c000000120c3f0000001d00746162746f6b656e207478202b204d657373616765203d20436f6f6c';
{
  const n = neoParseOpReturn(SMOKE_EMPP);
  const t = txparseOpReturn(SMOKE_EMPP);
  if (n !== null) throw new Error('smoke: neo parseOpReturn did not return null on a known eMPP script — extraction is wrong');
  if (!t || t.type !== 'cashtab' || t.text !== 'token tx + Message = Cool') {
    throw new Error('smoke: txparse did not extract the known eMPP Cashtab note: ' + JSON.stringify(t));
  }
}

const corpus = await buildCorpus();

const buckets = { agree: 0, 'neo-null': 0, 'content-differs': 0, 'txparse-null': 0 };
const byKind = new Map();
const txparseNulls = [];
const neoNulls = [];
const contentDiffs = [];
const neoThrows = [];
const txThrows = [];
let invariantOk = 0, invariantBad = [];
let textNonNull = 0;
let neoHasTextField = 0;
let neoResults = 0, txResults = 0;
const emppInners = new Map();
const protoShape = {
  ALIAS: { op0: 0, notOp0: 0, agreeGeneric: 0, agreeNamed: 0, differNeoGeneric: 0, other: 0 },
  PAYBUTTON: { op0: 0, notOp0: 0, agreeGeneric: 0, agreeNamed: 0, differNeoGeneric: 0, other: 0 },
};

// Unbiased block-sample occurrence counters (not deduped).
const blockOcc = {
  total: 0, 'neo-null': 0, empp: 0, emppBothNull: 0, emppReadable: 0, emppMarker: 0,
  agree: 0, 'content-differs': 0, 'txparse-null': 0,
};
// Distinct-script eMPP split: a readable payload is a non-null txparse.text.
// Everything else eMPP (ALP/Agora/dice/…) is a token marker both parsers
// correctly return null for. The readable count is what neo actually loses.
const emppSplit = { distinct: 0, readable: 0, marker: 0, readableNoText: 0 };
const stratumHits = {
  'lokad:CASHTAB_MSG': 0, 'lokad:ALIAS': 0, 'lokad:AIRDROP': 0,
  'lokad:ECASHCHAT_TX': 0, 'lokad:PAYBUTTON': 0, 'lokad:ARTICLE': 0,
  'alias-op0': 0, 'alias-not-op0': 0,
  agora: 0, powr: 0, slp: 0, alp: 0,
  'plaintext-fallback': 0, 'unknown-lokad': 0,
};

function bumpKind(kind, bucket) {
  let row = byKind.get(kind);
  if (!row) { row = { agree: 0, 'neo-null': 0, 'content-differs': 0, 'txparse-null': 0, total: 0 }; byKind.set(kind, row); }
  row[bucket]++;
  row.total++;
}

for (const rec of corpus.scripts) {
  const hex = rec.hex;
  let neo, txp;
  try { neo = neoParseOpReturn(hex); }
  catch (e) { neoThrows.push({ hex, txid: rec.txid, err: String(e && e.message || e) }); continue; }
  try { txp = txparseOpReturn(hex); }
  catch (e) { txThrows.push({ hex, txid: rec.txid, err: String(e && e.message || e) }); continue; }

  if (neo) {
    neoResults++;
    if (Object.prototype.hasOwnProperty.call(neo, 'text')) neoHasTextField++;
  }
  if (txp) {
    txResults++;
    const syn = txp.synthetic === (txp.content !== txp.text);
    if (syn) invariantOk++;
    else invariantBad.push({ hex, txid: rec.txid, type: txp.type, content: txp.content, text: txp.text, synthetic: txp.synthetic });
    if (txp.text) textNonNull++;
  }

  const bucket = classify(neo, txp);
  buckets[bucket]++;
  const kind = scriptKind(hex);
  bumpKind(kind.kind, bucket);
  if (kind.kind === 'CASHTAB_MSG') stratumHits['lokad:CASHTAB_MSG']++;
  if (kind.kind === 'ALIAS') {
    stratumHits['lokad:ALIAS']++;
    const rest = hex.startsWith('6a04') ? hex.slice(12) : '';
    if (rest.slice(0, 2) === '00') stratumHits['alias-op0']++;
    else stratumHits['alias-not-op0']++;
  }
  if (kind.kind === 'AIRDROP') stratumHits['lokad:AIRDROP']++;
  if (kind.kind === 'ECASHCHAT_TX') stratumHits['lokad:ECASHCHAT_TX']++;
  if (kind.kind === 'PAYBUTTON') stratumHits['lokad:PAYBUTTON']++;
  if (kind.kind === 'ARTICLE') stratumHits['lokad:ARTICLE']++;
  if (kind.kind === 'POWR') stratumHits.powr++;
  if (kind.kind === 'SLP' || (kind.kind === 'empp' && kind.inners.includes('534c5000'))) stratumHits.slp++;
  if (kind.kind === 'ALP' || (kind.kind === 'empp' && kind.inners.includes('534c5032'))) stratumHits.alp++;
  if (kind.kind === 'AGORA' || (kind.kind === 'empp' && kind.inners.includes(TX_LOKAD.AGORA))) stratumHits.agora++;
  if (kind.kind === 'unknown-lokad') stratumHits['unknown-lokad']++;
  if ((kind.kind === 'unknown-lokad' || kind.kind === 'other') && txp && txp.text && txp.content === txp.text) {
    stratumHits['plaintext-fallback']++;
  }

  if (rec.blockCount > 0) {
    blockOcc.total += rec.blockCount;
    blockOcc[bucket] += rec.blockCount;
    if (kind.kind === 'empp') {
      blockOcc.empp += rec.blockCount;
      if (neo === null && txp === null) blockOcc.emppBothNull += rec.blockCount;
      if (txp && txp.text) blockOcc.emppReadable += rec.blockCount;
      else blockOcc.emppMarker += rec.blockCount;
    }
  }

  if (bucket === 'txparse-null') {
    txparseNulls.push({ hex, txid: rec.txid, kind: kind.kind, lokad: kind.lokad, neo, blockCount: rec.blockCount, lokads: rec.lokads });
  } else if (bucket === 'neo-null') {
    neoNulls.push({
      hex, txid: rec.txid, kind: kind.kind, inners: kind.inners,
      txType: txp.type, txContent: txp.content, txText: txp.text,
      blockCount: rec.blockCount, lokads: rec.lokads,
    });
  } else if (bucket === 'content-differs') {
    contentDiffs.push({
      hex, txid: rec.txid, kind: kind.kind, lokad: kind.lokad,
      neoType: neo.type, neoContent: neo.content,
      txType: txp.type, txContent: txp.content, txText: txp.text,
      blockCount: rec.blockCount, lokads: rec.lokads,
    });
  }

  if (kind.kind === 'empp') {
    const key = [...new Set(kind.inners)].sort().join('+') || '(none)';
    let row = emppInners.get(key);
    if (!row) { row = { n: 0, neoNull: 0, bothNull: 0, readable: 0 }; emppInners.set(key, row); }
    row.n++;
    if (bucket === 'neo-null') row.neoNull++;
    if (neo === null && txp === null) row.bothNull++;
    if (txp && txp.text) row.readable++;
    emppSplit.distinct++;
    if (txp && txp.text) emppSplit.readable++;
    else if (txp) emppSplit.readableNoText++;
    else emppSplit.marker++;
  }

  if (kind.kind === 'ALIAS' || kind.kind === 'PAYBUTTON') {
    const rest = hex.startsWith('6a04') ? hex.slice(12) : '';
    const firstByte = rest.slice(0, 2);
    const shape = protoShape[kind.kind];
    if (firstByte === '00') shape.op0++;
    else shape.notOp0++;
    if (bucket === 'agree') {
      const generic = kind.kind === 'ALIAS' ? 'alias registration' : 'PayButton tx';
      if (neo && neo.content === generic) shape.agreeGeneric++;
      else shape.agreeNamed++;
    } else if (bucket === 'content-differs' && neo && (neo.content === 'alias registration' || neo.content === 'PayButton tx')) {
      shape.differNeoGeneric++;
    } else {
      shape.other++;
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';

console.log('\n========== PARSER PARITY — pre-B2 neo vs vendor/txparse.js ==========');
console.log('evidence only; no shipped file was written.');
console.log('neo side: frozen pre-B2 parseOpReturn from tools/neo-inline.pre-b2.mjs (index.html no longer defines it).');
if (extractNotes.length) for (const n of extractNotes) console.log('EXTRACT NOTE:', n);

console.log('\n--- Agora carry (static, not measured) ---');
console.log(`  neo live index.html:${agoraStatic.neoLine}  old type/content/synthetic assign (expected gone after B2; it lived in parseTransaction, not parseOpReturn)`);
console.log(`  pre-B2 assign had a text field: ${agoraStatic.neoHasTextField} (false — that is why txparse carries text through)`);
console.log(`  txparse vendor/txparse.js:${agoraStatic.txCarriedLine}  binds carried; assign at :${agoraStatic.txAssignLine} passes it to msg()`);
console.log(`  static assertion ${agoraStatic.neoLine == null && !agoraStatic.neoHasTextField && agoraStatic.txPassesCarried ? 'PASS' : 'FAIL'}`);

console.log('\n--- Corpus ---');
console.log(`  fetchedAt     ${corpus.fetchedAt}`);
console.log(`  tipHeight     ${corpus.tipHeight}`);
console.log(`  distinct scripts  ${corpus.scripts.length}`);
const b = corpus.blocks;
console.log(`  blocks        ${b.heights.length} heights (${b.heights[0]}–${b.heights[b.heights.length - 1]}), ${b.requests} requests, ${b.txsScanned} txs scanned, ${b.opreturnOutputs} OP_RETURN outputs`);
if (b.failed && b.failed.length) console.log(`  block failures: ${JSON.stringify(b.failed)}`);
console.log('  lokad pages:');
for (const id of TARGET_LOKADS) {
  const rec = (corpus.lokad || {})[id];
  if (!rec) { console.log(`    ${id}  MISSING from corpus`); continue; }
  console.log(`    ${pad(rec.name || id, 16)} ${id}  pages=[${(rec.pages || []).join(',')}] size=${rec.pageSize}  scanned=${rec.txsScanned} / indexed=${rec.numTxs} (${rec.numPages} pages)`);
  if (rec.failed && rec.failed.length) console.log(`      failures: ${JSON.stringify(rec.failed)}`);
}

console.log('\n--- Bucket counts (distinct scripts) ---');
console.log(`  ${pad('bucket', 18)} ${padL('n', 6)}  ${padL('share', 7)}`);
const nScripts = corpus.scripts.length - neoThrows.length - txThrows.length;
for (const k of ['agree', 'neo-null', 'content-differs', 'txparse-null']) {
  console.log(`  ${pad(k, 18)} ${padL(buckets[k], 6)}  ${padL(pct(buckets[k], nScripts), 7)}`);
}
console.log(`  ${pad('TOTAL classified', 18)} ${padL(nScripts, 6)}`);
if (neoThrows.length) console.log(`  neo threw on ${neoThrows.length} scripts (not bucketed)`);
if (txThrows.length) console.log(`  txparse threw on ${txThrows.length} scripts (not bucketed)`);

console.log('\n--- Per-kind breakdown (distinct scripts) ---');
console.log(`  ${pad('kind', 22)} ${padL('agree', 7)} ${padL('neo-null', 8)} ${padL('c-diff', 7)} ${padL('tp-null', 7)} ${padL('total', 7)}`);
const kindRows = [...byKind.entries()].sort((a, b) => b[1].total - a[1].total);
for (const [kind, row] of kindRows) {
  console.log(`  ${pad(kind, 22)} ${padL(row.agree, 7)} ${padL(row['neo-null'], 8)} ${padL(row['content-differs'], 7)} ${padL(row['txparse-null'], 7)} ${padL(row.total, 7)}`);
}

console.log('\n--- Unbiased block sample (OP_RETURN OUTPUT occurrences, not deduped) ---');
console.log(`  OP_RETURN outputs     ${blockOcc.total}`);
console.log(`  eMPP (6a50…)          ${blockOcc.empp}  ${pct(blockOcc.empp, blockOcc.total)}   ← original "~42% of OP_RETURN is eMPP" claim`);
console.log(`  eMPP readable         ${blockOcc.emppReadable}  ${pct(blockOcc.emppReadable, blockOcc.total)}   (txparse.text set — what neo actually loses)`);
console.log(`  eMPP token-marker     ${blockOcc.emppMarker}  ${pct(blockOcc.emppMarker, blockOcc.total)}   (both parsers correctly return null)`);
console.log(`  eMPP both-null        ${blockOcc.emppBothNull}  ${pct(blockOcc.emppBothNull, blockOcc.total)}`);
console.log(`  neo-null              ${blockOcc['neo-null']}  ${pct(blockOcc['neo-null'], blockOcc.total)}   ← bucket as defined (neo null, txparse a message)`);
console.log(`  agree                 ${blockOcc.agree}  ${pct(blockOcc.agree, blockOcc.total)}`);
console.log(`  content-differs       ${blockOcc['content-differs']}  ${pct(blockOcc['content-differs'], blockOcc.total)}`);
console.log(`  txparse-null          ${blockOcc['txparse-null']}  ${pct(blockOcc['txparse-null'], blockOcc.total)}`);

// Distinct-script neo-null share of the block sample (secondary).
let blockDistinct = 0, blockDistinctNeoNull = 0, blockDistinctEmpp = 0;
for (const rec of corpus.scripts) {
  if (rec.blockCount <= 0) continue;
  blockDistinct++;
  const k = scriptKind(rec.hex);
  if (k.kind === 'empp') blockDistinctEmpp++;
}
// Recompute neo-null distinct from classified set:
for (const rec of corpus.scripts) {
  if (rec.blockCount <= 0) continue;
  let neo, txp;
  try { neo = neoParseOpReturn(rec.hex); txp = txparseOpReturn(rec.hex); }
  catch { continue; }
  if (classify(neo, txp) === 'neo-null') blockDistinctNeoNull++;
}
console.log(`  distinct scripts in sample   ${blockDistinct}  (eMPP ${blockDistinctEmpp}, neo-null ${blockDistinctNeoNull} = ${pct(blockDistinctNeoNull, blockDistinct)})`);

console.log('\n--- Expected divergence 1: eMPP ---');
const emppRow = byKind.get('empp') || { agree: 0, 'neo-null': 0, 'content-differs': 0, 'txparse-null': 0, total: 0 };
console.log(`  eMPP distinct: ${emppRow.total}  neo-null=${emppRow['neo-null']} agree=${emppRow.agree} content-differs=${emppRow['content-differs']} txparse-null=${emppRow['txparse-null']}`);
console.log('  neo hits the first-byte else and returns null on 6a50 (OP_RESERVED); its EMPP check is after that return and is dead.');
console.log('  READABLE vs TOKEN-MARKER (this is what neo loses):');
console.log(`    distinct eMPP              ${emppSplit.distinct}`);
console.log(`    readable payload           ${emppSplit.readable}  (${pct(emppSplit.readable, emppSplit.distinct)} of eMPP; txparse.text set)`);
console.log(`    token-marker only          ${emppSplit.marker}  (${pct(emppSplit.marker, emppSplit.distinct)} of eMPP; both parsers null)`);
if (emppSplit.readableNoText) {
  console.log(`    txparse message, no text   ${emppSplit.readableNoText}  (label only — not counted as readable)`);
}
console.log(`    eMPP is ${pct(blockOcc.empp, blockOcc.total)} of block-sample OP_RETURN while neo-null is ${pct(blockOcc['neo-null'], blockOcc.total)} because ${blockOcc.emppMarker} of ${blockOcc.empp} eMPP outputs in that window are token markers, not writing.`);
console.log('  inner lokad sets (distinct scripts):');
for (const [key, row] of [...emppInners.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`    ${pad(key, 36)} n=${padL(row.n, 4)}  readable=${padL(row.readable, 3)}  neo-null=${padL(row.neoNull, 3)}  both-null=${padL(row.bothNull, 4)}`);
}
console.log(`  neo-null eMPP (txparse extracted a message neo dropped): ${neoNulls.length}`);
for (const ex of neoNulls) {
  console.log(`    ${ex.txid || '?'}  type=${ex.txType}  text=${JSON.stringify(clip(ex.txText || ex.txContent, 70))}  inners=${(ex.inners || []).join('+')}  blockHits=${ex.blockCount}`);
}

console.log('\n--- Expected divergence 2: Alias / PayButton ---');
for (const name of ['ALIAS', 'PAYBUTTON']) {
  const row = byKind.get(name) || { agree: 0, 'neo-null': 0, 'content-differs': 0, 'txparse-null': 0, total: 0 };
  const s = protoShape[name];
  const examples = contentDiffs.filter((d) => d.kind === name).slice(0, 3);
  console.log(`  ${name}: n=${row.total} agree=${row.agree} content-differs=${row['content-differs']} neo-null=${row['neo-null']} txparse-null=${row['txparse-null']}`);
  console.log(`    version byte: bare OP_0=${s.op0}  not-OP_0=${s.notOp0}`);
  console.log(`    agree generic (both labels, no extractable payload)=${s.agreeGeneric}`);
  console.log(`    agree named (both extracted the same payload)=${s.agreeNamed}`);
  console.log(`    content-differs, neo generic / txparse extracted=${s.differNeoGeneric}`);
  if (s.other) console.log(`    other (unexpected shape)=${s.other}`);
  for (const ex of examples) {
    console.log(`    e.g. ${ex.txid || '?'}  neo=${clip(ex.neoContent, 50)}  txparse=${clip(ex.txContent, 50)}  text=${clip(ex.txText, 40)}`);
  }
}

console.log('\n--- Expected divergence 3: text vs content ---');
console.log(`  neo results with a 'text' own-property: ${neoHasTextField} / ${neoResults}  (expected 0)`);
console.log(`  txparse results: ${txResults}; non-null text: ${textNonNull}`);
console.log(`  invariant synthetic === (content !== text): ${invariantOk} hold, ${invariantBad.length} break`);

console.log('\n--- txparse-null (DANGEROUS — neo returns a message, txparse returns null) ---');
if (txparseNulls.length === 0) {
  console.log('  none. txparse never went silent where neo spoke.');
} else {
  console.log(`  ${txparseNulls.length} script(s). Enumerating every one:`);
  txparseNulls.forEach((ex, i) => {
    console.log(`  [${i + 1}] kind=${ex.kind} lokad=${ex.lokad} txid=${ex.txid || '?'} blockHits=${ex.blockCount} indexed=${(ex.lokads || []).join(',') || '—'}`);
    console.log(`      neo: type=${ex.neo && ex.neo.type} content=${JSON.stringify(ex.neo && ex.neo.content)}`);
    console.log(`      hex: ${ex.hex}`);
  });
}

if (neoThrows.length) {
  console.log('\n--- neo threw ---');
  for (const ex of neoThrows) console.log(`  ${ex.txid || '?'} ${ex.err} ${clip(ex.hex, 100)}`);
}
if (txThrows.length) {
  console.log('\n--- txparse threw ---');
  for (const ex of txThrows) console.log(`  ${ex.txid || '?'} ${ex.err} ${clip(ex.hex, 100)}`);
}
if (invariantBad.length) {
  console.log('\n--- invariant breaks ---');
  for (const ex of invariantBad) {
    console.log(`  ${ex.txid || '?'} type=${ex.type} content=${JSON.stringify(ex.content)} text=${JSON.stringify(ex.text)} synthetic=${ex.synthetic}`);
  }
}

// content-differs that are NOT the named Alias/PayButton class — possible neo-right.
const unexpectedDiffs = contentDiffs.filter((d) => d.kind !== 'ALIAS' && d.kind !== 'PAYBUTTON');
console.log('\n--- content-differs outside Alias/PayButton (unexpected; inspect) ---');
if (unexpectedDiffs.length === 0) {
  console.log('  none. Every content-differs row is Alias or PayButton.');
} else {
  console.log(`  ${unexpectedDiffs.length} script(s):`);
  for (const ex of unexpectedDiffs.slice(0, 40)) {
    console.log(`  kind=${ex.kind} txid=${ex.txid || '?'}`);
    console.log(`    neo     ${ex.neoType} ${JSON.stringify(clip(ex.neoContent, 100))}`);
    console.log(`    txparse ${ex.txType} ${JSON.stringify(clip(ex.txContent, 100))} text=${JSON.stringify(clip(ex.txText, 60))}`);
    console.log(`    hex ${clip(ex.hex, 160)}`);
  }
  if (unexpectedDiffs.length > 40) console.log(`  … ${unexpectedDiffs.length - 40} more`);
}

console.log('\n--- content-differs summary ---');
const diffsByKind = new Map();
for (const d of contentDiffs) diffsByKind.set(d.kind, (diffsByKind.get(d.kind) || 0) + 1);
for (const [k, n] of [...diffsByKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pad(k, 22)} ${n}`);
}

console.log('\n========== end ==========');

// ---------------------------------------------------------------------------
// CI assertions. Counts move with the sample; the shape must not.
// An empty required stratum is a broken fixture, not a pass.
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  c ? pass++ : fail++;
  console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x));
};

console.log('\n-- CI assertions --');
ok('index.html defines 0 inline parseOpReturn', !/function parseOpReturn\s*\(/.test(mod));
ok('index.html imports vendor/txparse.js?v=p7', mod.includes("from './vendor/txparse.js?v=p7'"));
ok('Agora carry lives in txparse (static)',
  agoraStatic.neoLine == null && !agoraStatic.neoHasTextField && agoraStatic.txPassesCarried);
ok('txparse-null is 0 (safety property)', txparseNulls.length === 0, String(txparseNulls.length));
ok('neo-null > 0', neoNulls.length > 0, String(neoNulls.length));
{
  const bad = neoNulls.filter((ex) =>
    !(ex.kind === 'empp'
      && (ex.inners || []).includes(TX_LOKAD.CASHTAB_MSG)
      && ex.txType === 'cashtab'));
  ok('every neo-null is Cashtab-in-eMPP', bad.length === 0,
    bad.slice(0, 3).map((e) => `${e.kind}/${e.txType}/${(e.inners || []).join('+')}`).join('; '));
}
ok('content-differs > 0', contentDiffs.length > 0, String(contentDiffs.length));
ok('every content-differs is Alias or PayButton', unexpectedDiffs.length === 0,
  unexpectedDiffs.slice(0, 3).map((e) => e.kind).join(','));
ok('synthetic === (content !== text) for every txparse result',
  invariantBad.length === 0 && (txResults === 0 || invariantOk === txResults),
  `ok=${invariantOk} bad=${invariantBad.length} results=${txResults}`);
ok('neither parser threw', neoThrows.length === 0 && txThrows.length === 0,
  `neo=${neoThrows.length} tx=${txThrows.length}`);

const requiredStrata = [
  ['lokad:CASHTAB_MSG', stratumHits['lokad:CASHTAB_MSG']],
  ['lokad:ALIAS', stratumHits['lokad:ALIAS']],
  ['lokad:AIRDROP', stratumHits['lokad:AIRDROP']],
  ['lokad:ECASHCHAT_TX', stratumHits['lokad:ECASHCHAT_TX']],
  ['lokad:PAYBUTTON', stratumHits['lokad:PAYBUTTON']],
  ['lokad:ARTICLE', stratumHits['lokad:ARTICLE']],
  ['alias-op0', stratumHits['alias-op0']],
  ['alias-not-op0', stratumHits['alias-not-op0']],
  ['empp-readable', emppSplit.readable],
  ['empp-marker', emppSplit.marker],
  ['agora', stratumHits.agora],
  ['powr', stratumHits.powr],
  ['slp', stratumHits.slp],
  ['alp', stratumHits.alp],
  ['plaintext-fallback', stratumHits['plaintext-fallback']],
  ['unknown-lokad', stratumHits['unknown-lokad']],
];
for (const [name, n] of requiredStrata) {
  ok('stratum ' + name + ' is non-empty', n > 0, 'n=' + n);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

