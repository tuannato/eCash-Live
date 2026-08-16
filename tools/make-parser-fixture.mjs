// Deterministic, seeded, stratified sample of internal/parser-corpus.json.
//   node tools/make-parser-fixture.mjs
//
// Writes tools/fixtures/parser-corpus.min.json. The full corpus is gitignored
// (~1.7 MB, 6,025 scripts); CI runs the parity suites against this fixture.
// slice(0, N) is forbidden — it would take whatever happened to sort first
// and can drop a whole stratum (Alias-without-OP_0, Cashtab-in-eMPP, …).
//
// Requires the local full corpus + the frozen pre-B2 oracle. Not a CI step.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseOpReturn as txparseOpReturn, LOKAD as TX_LOKAD } from '../vendor/txparse.js';
import { parseOpReturn as neoParseOpReturn, LOKAD as NEO_LOKAD } from './neo-inline.pre-b2.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(ROOT, 'internal/parser-corpus.json');
const OUT_PATH = join(HERE, 'fixtures/parser-corpus.min.json');

// Documented seed so the same full corpus always yields the same fixture.
const SEED = 20260816;

// Roughly 300 scripts. Quotas are on PRIMARY membership so a script is
// claimed by the rarest / most important label it carries. After the union
// we re-count every required label and refuse to write if any is empty.
const QUOTAS = {
  'empp-readable': 40,       // all 40 Cashtab-in-eMPP notes
  'powr': 19,                // all 19
  'alias-op0-differs': 25,   // bare OP_0 version — neo generic, txparse named
  'alias-not-op0': 22,       // no version byte — both extract the name
  'alias-op0-agrees': 5,     // all 5: OP_0 but no extractable payload
  'paybutton-differs': 25,   // 920/920 use OP_0; this is the extracted subset
  'paybutton-agrees': 12,    // OP_0, empty data — both say "PayButton tx"
  'slp': 18,
  'agora': 18,               // AGR0 lives inside eMPP in this corpus
  'empp-marker': 16,         // ALP/dice/ROLL token markers, both parsers null
  'lokad:CASHTAB_MSG': 22,
  'lokad:AIRDROP': 16,
  'lokad:ECASHCHAT_TX': 16,
  'lokad:ARTICLE': 16,
  'plaintext-fallback': 18,  // unknown 4-byte id, printable text
};

const PRIMARY_ORDER = Object.keys(QUOTAS);

const REQUIRED_LABELS = [
  'lokad:CASHTAB_MSG', 'lokad:ALIAS', 'lokad:AIRDROP',
  'lokad:ECASHCHAT_TX', 'lokad:PAYBUTTON', 'lokad:ARTICLE',
  'alias-op0', 'alias-not-op0',
  'paybutton', 'paybutton-op0',
  'empp-readable', 'empp-marker',
  'agora', 'powr', 'slp', 'alp',
  'plaintext-fallback', 'unknown-lokad',
];

const LOKAD_BY_ID = Object.fromEntries(Object.entries(NEO_LOKAD).map(([k, v]) => [v, k]));

function readFirstPush(dataHex) {
  if (!dataHex || dataHex.length < 2) return null;
  const firstByte = parseInt(dataHex.slice(0, 2), 16);
  if (Number.isNaN(firstByte)) return null;
  let pushLen, start;
  if (firstByte === 0x4c) { pushLen = parseInt(dataHex.slice(2, 4), 16); start = 4; }
  else if (firstByte === 0x4d) { pushLen = parseInt(dataHex.slice(4, 6) + dataHex.slice(2, 4), 16); start = 6; }
  else if (firstByte > 0 && firstByte <= 75) { pushLen = firstByte; start = 2; }
  else return { op: firstByte, hex: '' };
  return { len: pushLen, hex: dataHex.slice(start, start + pushLen * 2) };
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
    return {
      kind: LOKAD_BY_ID[id] || (id === '534c5000' ? 'SLP' : id === '534c5032' ? 'ALP' : 'unknown-lokad'),
      lokad: id,
      inners: [],
    };
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

function versionIsOp0(hex) {
  return hex.startsWith('6a04') && hex.slice(12, 14) === '00';
}

function tagScript(hex, neo, txp, kind) {
  const tags = new Set();
  const bucket = classify(neo, txp);
  if (kind.kind === 'CASHTAB_MSG') tags.add('lokad:CASHTAB_MSG');
  if (kind.kind === 'ALIAS') {
    tags.add('lokad:ALIAS');
    if (versionIsOp0(hex)) {
      tags.add('alias-op0');
      tags.add(bucket === 'content-differs' ? 'alias-op0-differs' : 'alias-op0-agrees');
    } else {
      tags.add('alias-not-op0');
    }
  }
  if (kind.kind === 'AIRDROP') tags.add('lokad:AIRDROP');
  if (kind.kind === 'ECASHCHAT_TX') tags.add('lokad:ECASHCHAT_TX');
  if (kind.kind === 'PAYBUTTON') {
    tags.add('lokad:PAYBUTTON');
    tags.add('paybutton');
    if (versionIsOp0(hex)) tags.add('paybutton-op0');
    tags.add(bucket === 'content-differs' ? 'paybutton-differs' : 'paybutton-agrees');
  }
  if (kind.kind === 'ARTICLE') tags.add('lokad:ARTICLE');
  if (kind.kind === 'POWR') tags.add('powr');
  if (kind.kind === 'SLP') tags.add('slp');
  if (kind.kind === 'ALP') tags.add('alp');
  if (kind.kind === 'AGORA') tags.add('agora');
  if (kind.kind === 'empp') {
    if (txp && txp.text) tags.add('empp-readable');
    else tags.add('empp-marker');
    if (kind.inners.includes(TX_LOKAD.AGORA)) tags.add('agora');
    if (kind.inners.includes('534c5032')) tags.add('alp');
    if (kind.inners.includes('534c5000')) tags.add('slp');
    if (kind.inners.includes(TX_LOKAD.CASHTAB_MSG)) tags.add('empp-cashtab');
  }
  if (kind.kind === 'unknown-lokad') {
    tags.add('unknown-lokad');
    if (txp && txp.text && txp.content === txp.text) tags.add('plaintext-fallback');
  }
  if (kind.kind === 'other' && txp && txp.text && txp.content === txp.text) {
    tags.add('plaintext-fallback');
  }
  return tags;
}

function primaryOf(tags) {
  for (const key of PRIMARY_ORDER) if (tags.has(key)) return key;
  return null;
}

// FNV-1a of seed + hex. Independent of corpus insertion order.
function rank(hex) {
  const s = String(SEED) + '\0' + hex;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

if (!existsSync(SRC_PATH)) {
  throw new Error('missing ' + SRC_PATH + ' (local full corpus; not in the public checkout)');
}

const src = JSON.parse(readFileSync(SRC_PATH, 'utf8'));
if (!Array.isArray(src.scripts) || src.scripts.length === 0) {
  throw new Error(SRC_PATH + ' has no scripts');
}

const annotated = [];
const available = Object.create(null);
for (const rec of src.scripts) {
  const hex = rec.hex;
  const neo = neoParseOpReturn(hex);
  const txp = txparseOpReturn(hex);
  const kind = scriptKind(hex);
  const tags = tagScript(hex, neo, txp, kind);
  const primary = primaryOf(tags);
  annotated.push({ rec, tags, primary, kind, neo, txp });
  for (const t of tags) available[t] = (available[t] || 0) + 1;
}

const buckets = Object.create(null);
for (const key of PRIMARY_ORDER) buckets[key] = [];
const leftover = [];
for (const row of annotated) {
  if (row.primary && buckets[row.primary]) buckets[row.primary].push(row);
  else leftover.push(row);
}

function pick(rows, n) {
  const sorted = [...rows].sort((a, b) => {
    const d = rank(a.rec.hex) - rank(b.rec.hex);
    if (d !== 0) return d;
    return a.rec.hex < b.rec.hex ? -1 : a.rec.hex > b.rec.hex ? 1 : 0;
  });
  return sorted.slice(0, n);
}

const selected = new Map();
const selectedByPrimary = Object.create(null);
for (const key of PRIMARY_ORDER) {
  const want = QUOTAS[key];
  const got = pick(buckets[key], want);
  selectedByPrimary[key] = { available: buckets[key].length, quota: want, selected: got.length };
  if (got.length < want) {
    throw new Error(
      'stratum ' + key + ' has only ' + got.length + ' scripts, quota is ' + want
      + ' (available-as-primary ' + buckets[key].length + ', tagged ' + (available[key] || 0) + ')'
    );
  }
  for (const row of got) selected.set(row.rec.hex, row);
}

const labelCounts = Object.create(null);
for (const row of selected.values()) {
  for (const t of row.tags) labelCounts[t] = (labelCounts[t] || 0) + 1;
}
const missing = REQUIRED_LABELS.filter((k) => !labelCounts[k]);
if (missing.length) {
  throw new Error('fixture missed required label(s): ' + missing.join(', '));
}

const scripts = [...selected.values()]
  .map((row) => ({
    hex: row.rec.hex,
    blockCount: row.rec.blockCount || 0,
    lokads: Array.isArray(row.rec.lokads) ? row.rec.lokads : [],
    txid: row.rec.txid || null,
  }))
  .sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));

const fixture = {
  fetchedAt: src.fetchedAt,
  tipHeight: src.tipHeight,
  chronik: src.chronik,
  blocks: src.blocks,
  lokad: src.lokad,
  fixture: {
    generatedBy: 'tools/make-parser-fixture.mjs',
    seed: SEED,
    sourcePath: 'internal/parser-corpus.json',
    sourceFetchedAt: src.fetchedAt,
    sourceTipHeight: src.tipHeight,
    sourceScriptCount: src.scripts.length,
    sourceChronik: src.chronik,
    selectedCount: scripts.length,
    quotas: QUOTAS,
    selectedByPrimary,
    labelCounts,
    requiredLabels: REQUIRED_LABELS,
  },
  scripts,
};

writeFileSync(OUT_PATH, JSON.stringify(fixture) + '\n');

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log('source  ' + SRC_PATH);
console.log('  fetchedAt   ' + src.fetchedAt);
console.log('  tipHeight   ' + src.tipHeight);
console.log('  scripts     ' + src.scripts.length);
console.log('seed    ' + SEED);
console.log('wrote   ' + OUT_PATH);
console.log('  scripts     ' + scripts.length);
console.log('  bytes       ' + Buffer.byteLength(JSON.stringify(fixture) + '\n'));
console.log('\n--- primary quotas ---');
console.log('  ' + pad('stratum', 24) + padL('avail', 7) + padL('quota', 7) + padL('took', 7));
for (const key of PRIMARY_ORDER) {
  const r = selectedByPrimary[key];
  console.log('  ' + pad(key, 24) + padL(r.available, 7) + padL(r.quota, 7) + padL(r.selected, 7));
}
console.log('\n--- required labels in the sample ---');
console.log('  ' + pad('label', 24) + padL('n', 7) + padL('of full', 8));
for (const key of REQUIRED_LABELS) {
  console.log('  ' + pad(key, 24) + padL(labelCounts[key] || 0, 7) + padL(available[key] || 0, 8));
}
