// Harness for runLaneBackfill (the Lane's walk), before it is extracted.
//   node tools/test-lane-backfill.mjs
//
// Like tools/test-lane-scope.mjs and unlike tools/test-lane-corpus.mjs, this
// EXTRACTS the shipped function bodies from flow/index.html and runs those.
// A test of a copy passes when the copy is right; this one fails when the
// page is wrong.
//
// Why it exists: runLaneBackfill is the largest uncovered Lane function, and
// it is what step 2b moves into vendor/core/. The v2.8.0 parser swap was safe
// because a differential oracle existed first. This file is that oracle —
// it pins what the walk does TODAY. Do not "fix" an assertion to match a
// behaviour nobody approved; a test that encodes a fix will make the
// extraction look wrong when it is right.
//
// createBackfill is the REAL module (same import as tools/test-backfill.mjs).
// The wiring between the two is half of what is being pinned.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createBackfill as realCreateBackfill } from '../vendor/core/backfill.js';
import { matchAny, matchEvery } from '../vendor/core/match.js';
import { MESSAGE_LOKADS, LOKAD } from '../vendor/txparse.js';
import { rangeActive, inRange, inScope, senderTag, senderOf } from '../vendor/core/lane-cursor.js';
import { createCorpus } from '../vendor/core/lane-corpus.js';
import { createLaneStore } from '../vendor/core/lane-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];
const backfillSrc = readFileSync(join(ROOT, 'vendor/core/backfill.js'), 'utf8');
const HOLES_CAP = Number(backfillSrc.match(/const HOLES_CAP = (\d+)/)[1]);

/** Lift `function name(...) { ... }` by balancing braces, skipping strings and
 *  comments so a brace inside either cannot end it.
 *
 *  TRAP: `runLaneBackfill` (and `laneHydrate`) is declared `async function`.
 *  Searching for `'function ' + name + '('` lands AFTER the `async` keyword;
 *  slicing from there produces a non-async body and `await` throws
 *  SyntaxError. Walk back six characters and keep the keyword when it is
 *  there. A suspiciously clean failure is usually this, not the page. */
function grab(name) {
  const at = mod.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('not found in flow/index.html: ' + name);
  let start = at;
  if (at >= 6 && mod.slice(at - 6, at) === 'async ') start = at - 6;
  let i = mod.indexOf('{', at), depth = 0;
  for (; i < mod.length; i++) {
    const c = mod[i];
    if (c === '/' && mod[i + 1] === '/') { i = mod.indexOf('\n', i); continue; }
    if (c === '/' && mod[i + 1] === '*') { i = mod.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < mod.length; i++) { if (mod[i] === '\\') i++; else if (mod[i] === q) break; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return mod.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const LANE_PAGE = Number(mod.match(/const LANE_PAGE = (\d+)/)[1]);
const LANE_REQUESTS = Number(mod.match(/const LANE_REQUESTS = (\d+)/)[1]);
const MATCH_MAX = Number(mod.match(/const MATCH_MAX = (\d+)/)[1]);
const CORPUS_MAX = Number(mod.match(/const CORPUS_MAX = (\d+)/)[1]);
const LANE_CURSOR_KEY = mod.match(/const LANE_CURSOR_KEY = '([^']+)'/)[1];
const RANGE_KICK_MS = Number(mod.match(/const RANGE_KICK_MS = (\d+)/)[1]);
const SCOPE_KICK_MS = Number(mod.match(/const SCOPE_KICK_MS = (\d+)/)[1]);

const CT = LOKAD.CASHTAB_MSG;
const PB = LOKAD.PAYBUTTON;
const TS = 1_700_000_000;
const TERM = { q: 'hello', on: true, mode: 'word', fold: false, mute: false };

// Concatenate: the shipped bodies contain backtick comments (`failed`,
// `oldestTs`, `before`) that would terminate a template literal around
// ${grab(...)}.
const LANE_FNS = [
  'enabledTerms', 'activeMutes', 'matchTerms', 'txMatchesTerms', 'txIsMuted',
  'laneTsOf', 'txWhenMs', 'stampTs',
  'laneHold',
  'corpusAdd',
  'hayFromTx', 'ingestHistoryTx', 'lanePrefilter',
  'corpusMatches', 'laneSetMatched', 'laneSuggestInvalidate', 'laneRematch',
  'saveLaneStore',
  'laneParseTx',
  'laneHydrate',
  'interrupt',
  'runLaneBackfill',
  'onRangeChanged',
];
const bodies = LANE_FNS.map(grab).join('\n\n');

const INTERRUPT_FNS = ['laneClearData', 'onRangeChanged', 'onTermsChanged', 'onScopeChanged'];

function mkTx(txid, tsSec, text) {
  const hay = text || 'hello topic';
  return {
    txid,
    timeFirstSeen: tsSec,
    block: { timestamp: tsSec },
    outputs: [{ outputScript: '6a' }],
    inputs: [],
    _text: hay,
  };
}
function pageOf(prefix, n, ts0, step) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(mkTx(prefix + i, (ts0 || TS) - i * (step || 3600)));
  return out;
}

/** Fake chronik. history() is the real engine's only network. */
function stubChronik(spec) {
  const calls = [];
  const pages = spec.pages || {};
  return {
    calls,
    lokadId(id) {
      if (typeof spec.lokadId !== 'undefined' && spec.lokadId === false) {
        throw new Error('lokadId should not have been called');
      }
      return {
        async history(page, size) {
          calls.push({ id, page, size });
          if (spec.onHistory) await spec.onHistory(id, page, size);
          if (spec.fail && spec.fail(id, page)) throw new Error('hole');
          const seq = pages[id] || [];
          const numPages = spec.numPages && spec.numPages[id] != null
            ? spec.numPages[id] : Math.max(seq.length, 1);
          const txs = seq[page] || [];
          let numTxs = 0;
          if (spec.numTxs && spec.numTxs[id] != null) numTxs = spec.numTxs[id];
          else for (const p of seq) numTxs += p.length;
          return { txs, numPages, numTxs };
        },
      };
    },
    async tx() { return null; },
  };
}

function parseOpReturn(sc) {
  if (!sc || String(sc).slice(0, 2).toLowerCase() !== '6a') return null;
  return { text: 'hello topic' };
}
function parseTransactionCore(d) {
  if (!d || !d.txid) return null;
  return { id: d.txid, message: { text: 'hello topic' } };
}

function makeLane(opts = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const chronik = opts.chronik === undefined ? stubChronik(opts) : opts.chronik;
  const holdThrow = !!opts.holdThrow;
  const interruptAfterRun = !!opts.interruptAfterRun;
  const requests = opts.requests != null ? opts.requests : LANE_REQUESTS;
  const terms = opts.terms !== undefined ? opts.terms : [{ ...TERM }];
  const scope = opts.scope || [CT];
  const saved = opts.savedCursor !== undefined ? opts.savedCursor : null;

  // Bodies are concatenated, not interpolated — see the note above LANE_FNS.
  const src = [
    '"use strict";',
    'let createCalls = 0, loadCalls = 0;',
    'const runArgLog = [];',
    'let lastCreateOpts = null;',
    'const held = [];',
    'let rematchN = 0, renderMoreN = 0, saveN = 0;',
    'let hydrateN = 0;',
    'function createBackfill(o){',
    '  createCalls++;',
    '  lastCreateOpts = o;',
    '  const bf = realCreateBackfill(o);',
    '  const origLoad = bf.load.bind(bf);',
    '  const origRun = bf.run.bind(bf);',
    '  return {',
    '    get cursor(){ return bf.cursor; },',
    '    get coverage(){ return bf.coverage; },',
    '    load(c){ loadCalls++; return origLoad(c); },',
    '    run(args){',
    '      runArgLog.push({ minTs: args.minTs, maxTs: args.maxTs, requests: args.requests, hasSignal: !!(args && args.signal) });',
    '      const p = origRun(args);',
    '      if (!interruptAfterRun) return p;',
    '      return Promise.resolve(p).then((cov) => { interrupt(); return cov; });',
    '    },',
    '  };',
    '}',
    'const state = {',
    '  chronik, laneScope: scope.slice(), terms, termMode: "any",',
    '  laneOpen: !!opts.laneOpen, txs: new Map(), laneTxs: new Map(),',
    '  matched: [], matchedTotal: 0,',
    '};',
    'const laneCorpus = createCorpus({ max: CORPUS_MAX });',
    'const laneStore = createLaneStore({ storage: localStorage, key: LANE_CURSOR_KEY });',
    'let laneBf = null;',
    'let laneBusy = ' + (opts.busy ? 'true' : 'false') + ';',
    'let laneRunToken = 0, laneAbort = null;',
    'let laneDeepHoles = 0, laneDeepDone = ' + (opts.deepDone ? 'true' : 'false') + ';',
    'let laneUnread = 0, laneRangeDone = false;',
    'let laneRange = opts.range ? opts.range : { from: null, to: null };',
    'let laneSavedCursor = saved;',
    'let laneSuggestCache = null, laneNoDate = 0, laneScopeHidden = 0;',
    'function clean(s){ return String(s == null ? "" : s); }',
    'function scrubTx(tx){',
    '  if (!tx) return tx;',
    '  tx._hay = (tx.message && tx.message.text) ? tx.message.text : null;',
    '  return tx;',
    '}',
    'function txKind(tx){',
    '  if (tx && tx.message) return { kind: "msg", f: "msg", icon: "m" };',
    '  return { kind: "pay", f: "pay", icon: "c" };',
    '}',
    'function deriveRoute(){ return { from: null, to: null, allAddrs: new Set() }; }',
    'function renderLane(){}',
    'function renderLaneMore(){ renderMoreN++; }',
    'function refreshLaneScope(){}',
    'function refreshLaneRange(){}',
    'function scheduleSuggest(){}',
    'function maybeAutoBackfill(){}',
    'let scopeKickTimer = null;',
    'const RANGE_KICK_MS = ' + RANGE_KICK_MS + ';',
    'const SCOPE_KICK_MS = ' + SCOPE_KICK_MS + ';',
    bodies,
    'const _hold = laneHold;',
    'laneHold = function(tx){',
    '  held.push(tx && tx.id);',
    '  if (holdThrow) throw new Error("hold-boom");',
    '  return _hold(tx);',
    '};',
    'const _rematch = laneRematch;',
    'laneRematch = function(){ rematchN++; return _rematch(); };',
    'const _save = saveLaneStore;',
    'saveLaneStore = function(){ saveN++; return _save(); };',
    'const _hydrate = laneHydrate;',
    'laneHydrate = async function(token){ hydrateN++; return _hydrate(token); };',
    'return {',
    '  state, laneCorpus, lanePrefilter, laneParseTx, txMatchesTerms,',
    '  runLaneBackfill, interrupt, onRangeChanged,',
    '  get creates(){ return createCalls; },',
    '  get loads(){ return loadCalls; },',
    '  get runArgs(){ return runArgLog; },',
    '  get lastOpts(){ return lastCreateOpts; },',
    '  get held(){ return held.slice(); },',
    '  get rematchN(){ return rematchN; },',
    '  get renderMoreN(){ return renderMoreN; },',
    '  get saveN(){ return saveN; },',
    '  get hydrateN(){ return hydrateN; },',
    '  get busy(){ return laneBusy; },',
    '  get token(){ return laneRunToken; },',
    '  get deepHoles(){ return laneDeepHoles; },',
    '  get deepDone(){ return laneDeepDone; },',
    '  get unread(){ return laneUnread; },',
    '  get rangeDone(){ return laneRangeDone; },',
    '  get saved(){ return laneSavedCursor; },',
    '  get bf(){ return laneBf; },',
    '  raw: () => localStorage.getItem(LANE_CURSOR_KEY),',
    '  setRange: (r) => { laneRange = r; },',
    '  setBusy: (v) => { laneBusy = v; },',
    '  setDeepDone: (v) => { laneDeepDone = v; },',
    '  setRangeDone: (v) => { laneRangeDone = v; },',
    '  setUnread: (v) => { laneUnread = v; },',
    '  setBf: (v) => { laneBf = v; },',
    '  setChronik: (c) => { state.chronik = c; },',
    '  setTerms: (t) => { state.terms = t; },',
    '  setScope: (ids) => { state.laneScope = ids; },',
    '};',
  ].join('\n');

  const factory = new Function(
    'realCreateBackfill', 'parseOpReturn', 'parseTransactionCore',
    'matchAny', 'matchEvery',
    'localStorage', 'chronik', 'scope', 'terms', 'saved',
    'MATCH_MAX', 'CORPUS_MAX', 'LANE_PAGE', 'LANE_REQUESTS', 'LANE_CURSOR_KEY',
    'holdThrow', 'interruptAfterRun', 'opts',
    'rangeActive', 'inRange', 'inScope', 'senderTag', 'senderOf',
    'createCorpus', 'createLaneStore',
    src
  );
  return factory(
    realCreateBackfill, parseOpReturn, parseTransactionCore,
    matchAny, matchEvery,
    localStorage, chronik, scope, terms, saved,
    MATCH_MAX, CORPUS_MAX, LANE_PAGE, requests, LANE_CURSOR_KEY,
    holdThrow, interruptAfterRun, opts,
    rangeActive, inRange, inScope, senderTag, senderOf,
    createCorpus, createLaneStore
  );
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  c ? pass++ : fail++;
  console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x));
};
const eq = (n, got, want) =>
  ok(n, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function tripleIn(src) {
  return /laneRunToken\s*\+\+/.test(src)
      && /laneAbort\.abort\s*\(/.test(src)
      && /laneBusy\s*=\s*false/.test(src);
}

// ---------------------------------------------------------------- extraction
console.log('-- grab keeps async, so await is legal --');
ok('runLaneBackfill body starts with async function',
   grab('runLaneBackfill').startsWith('async function runLaneBackfill('));
ok('laneHydrate body starts with async function',
   grab('laneHydrate').startsWith('async function laneHydrate('));
ok('enabledTerms is not async',
   grab('enabledTerms').startsWith('function enabledTerms('));

let factoryErr = null;
try { makeLane({ pages: { [CT]: [pageOf('s', 1)] } }); }
catch (e) { factoryErr = e; }
ok('factory compiles (async extraction)', !factoryErr,
   factoryErr && (factoryErr.stack || factoryErr.message));

// A known-good call before any assertion that could be a harness bug.
console.log('\n-- extraction smoke: a known-good call --');
{
  const L = makeLane({ pages: { [CT]: [pageOf('sm', 2)] }, numPages: { [CT]: 1 } });
  await L.runLaneBackfill();
  ok('smoke: call resolves', true);
  ok('smoke: createBackfill ran once', L.creates === 1, String(L.creates));
  ok('smoke: run() received a signal', L.runArgs[0] && L.runArgs[0].hasSignal === true);
  ok('smoke: laneBusy cleared at rest', L.busy === false);
  ok('smoke: wired the shipped lanePrefilter',
     L.lastOpts && L.lastOpts.prefilter === L.lanePrefilter);
  ok('smoke: wired the shipped laneParseTx',
     L.lastOpts && L.lastOpts.parse === L.laneParseTx);
  ok('smoke: pageSize is LANE_PAGE', L.lastOpts && L.lastOpts.pageSize === LANE_PAGE);
  ok('smoke: chronik is state.chronik', L.lastOpts && L.lastOpts.chronik === L.state.chronik);
}

// ------------------------------------------------------------- entry guards
console.log('\n-- entry guards: return without side effects --');
{
  const L = makeLane({ busy: true, pages: { [CT]: [pageOf('b', 1)] } });
  await L.runLaneBackfill();
  ok('already busy: createBackfill not called', L.creates === 0, String(L.creates));
  ok('already busy: nothing held', L.held.length === 0);
  ok('already busy: save not called', L.saveN === 0);
  ok('already busy: still busy (did not enter)', L.busy === true);
}
{
  const L = makeLane({ deepDone: true, pages: { [CT]: [pageOf('d', 1)] } });
  await L.runLaneBackfill();
  ok('laneDeepDone: createBackfill not called', L.creates === 0);
  ok('laneDeepDone: renderLaneMore not called', L.renderMoreN === 0);
  ok('laneDeepDone: still not busy', L.busy === false);
}
{
  const L = makeLane({ terms: [], pages: { [CT]: [pageOf('e', 1)] } });
  await L.runLaneBackfill();
  ok('no terms: createBackfill not called', L.creates === 0);
}
{
  const L = makeLane({
    terms: [{ q: 'hello', on: true, mode: 'word', fold: false, mute: true }],
    pages: { [CT]: [pageOf('m', 1)] },
  });
  await L.runLaneBackfill();
  ok('muted-only: createBackfill not called (enabledTerms is empty)', L.creates === 0);
}
{
  const L = makeLane({ chronik: null });
  await L.runLaneBackfill();
  ok('chronik missing: createBackfill not called', L.creates === 0);
  ok('chronik missing: laneBusy still false', L.busy === false);
  ok('chronik missing: renderLaneMore not called', L.renderMoreN === 0);
}
{
  const L = makeLane({ chronik: { tx: async () => null } });
  await L.runLaneBackfill();
  ok('chronik without lokadId: createBackfill not called', L.creates === 0);
  ok('chronik without lokadId: laneBusy still false', L.busy === false);
  ok('chronik without lokadId: nothing saved', L.saveN === 0);
}

// -------------------------------------------------------- engine lifecycle
console.log('\n-- engine lifecycle: one instance, load once --');
{
  const saved = {
    [CT]: {
      ranges: [[0, 2, TS - 7200, TS]],
      pagesDone: 2, numPages: 10, numTxs: 500,
      oldestTs: TS - 7200, done: false, rangeDone: false,
    },
  };
  const L = makeLane({
    pages: { [CT]: [pageOf('p0', 2), pageOf('p1', 2), pageOf('p2', 2), pageOf('p3', 2)] },
    numPages: { [CT]: 10 }, numTxs: { [CT]: 500 },
    savedCursor: saved,
    requests: 1,
  });
  await L.runLaneBackfill();
  eq('first run: createBackfill once', L.creates, 1);
  eq('first run: load() once (restored cursor)', L.loads, 1);
  const bf1 = L.bf;
  await L.runLaneBackfill();
  eq('second run: still one createBackfill', L.creates, 1);
  eq('second run: load() still once', L.loads, 1);
  ok('second run: same instance', L.bf === bf1);
}

// -------------------------------------------------------------- token race
console.log('\n-- the token race, all three arms --');
{
  // Arm 1: token moves while history() is in flight. The engine does not pass
  // the signal into history(), so the page still returns; onBatch then drops.
  let n = 0;
  const L = makeLane({
    pages: { [CT]: [pageOf('t1', 3), pageOf('t1b', 3)] },
    numPages: { [CT]: 4 },
    onHistory() { if (n++ === 0) L.interrupt(); },
  });
  await L.runLaneBackfill();
  ok('onBatch drop: nothing held', L.held.length === 0, String(L.held.length));
  ok('onBatch drop: rematch not called', L.rematchN === 0, String(L.rematchN));
  ok('onBatch drop: coverage not written', L.deepHoles === 0 && L.deepDone === false && L.unread === 0);
  ok('onBatch drop: laneBusy not stranded', L.busy === false);
}
{
  // Arm 2: token moves after run() resolves, before the write. onBatch already
  // ran (token still matched mid-walk); the post-run assignments must not.
  const L = makeLane({
    pages: { [CT]: [pageOf('t2', 2)] },
    numPages: { [CT]: 1 },
    interruptAfterRun: true,
  });
  await L.runLaneBackfill();
  ok('after run(): holds happened (token still matched mid-walk)', L.held.length > 0, String(L.held.length));
  ok('after run(): laneDeepDone not written (would be true — 1-page index)', L.deepDone === false);
  ok('after run(): laneDeepHoles / laneUnread / laneRangeDone untouched',
     L.deepHoles === 0 && L.unread === 0 && L.rangeDone === false);
  ok('after run(): saveLaneStore not called (early return is before it)', L.saveN === 0);
  ok('after run(): laneBusy not stranded', L.busy === false);
}

// -------------------------------------------------------- interrupt: one writer
console.log('\n-- interrupt: four callers, one writer, extras stay at their sites --');
for (const name of INTERRUPT_FNS) {
  const src = grab(name);
  ok(name + ' calls interrupt()', /\binterrupt\s*\(\s*\)/.test(src));
  ok(name + ' no longer writes the triple inline', !tripleIn(src));
}
const interruptSrc = grab('interrupt');
ok('interrupt() is the only writer of the triple',
   tripleIn(interruptSrc) && !tripleIn(mod.replace(interruptSrc, '')));

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
const interruptCode = stripComments(interruptSrc);
ok('interrupt() does not mention laneDeepDone / laneBf / laneUnread / laneRangeDone / honesty clocks',
   !/\blaneDeepDone\b/.test(interruptCode)
   && !/\blaneBf\b/.test(interruptCode)
   && !/\blaneUnread\b/.test(interruptCode)
   && !/\blaneRangeDone\b/.test(interruptCode)
   && !/\blaneProbeSpentAt\b/.test(interruptCode)
   && !/\blanePrefixVerifiedAt\b/.test(interruptCode));
{
  // Drive the shipped onRangeChanged: a range change that reset laneDeepDone
  // would re-enable "Search further back" after the chain was exhausted.
  const L = makeLane({ pages: { [CT]: [pageOf('ir', 1)] }, numPages: { [CT]: 1 } });
  const sentinelBf = { keep: true };
  L.setDeepDone(true);
  L.setRangeDone(true);
  L.setUnread(3);
  L.setBf(sentinelBf);
  L.setBusy(true);
  const t0 = L.token;
  L.onRangeChanged({ from: 1_700_000_000_000, to: null });
  ok('onRangeChanged: interrupt ran (token advanced, busy cleared)',
     L.token === t0 + 1 && L.busy === false);
  ok('onRangeChanged: laneDeepDone survived (the reason extras stay at their sites)',
     L.deepDone === true);
  ok('onRangeChanged: laneRangeDone reset at the site, not inside interrupt()',
     L.rangeDone === false);
  ok('onRangeChanged: laneBf and laneUnread untouched',
     L.bf === sentinelBf && L.unread === 3);
}

// -------------------------------------------------------------------- toSec
console.log('\n-- toSec: the single ms→s boundary, values handed to run() --');
async function runWithRange(from, to) {
  const L = makeLane({
    pages: { [CT]: [pageOf('ts', 1)] },
    numPages: { [CT]: 1 },
    range: { from, to },
  });
  await L.runLaneBackfill();
  return L.runArgs[0];
}
{
  const a = await runWithRange(null, null);
  eq('null → null (minTs)', a.minTs, null);
  eq('null → null (maxTs)', a.maxTs, null);
}
{
  const a = await runWithRange(0, 0);
  eq('0 → 0 (minTs)', a.minTs, 0);
  eq('0 → 0 (maxTs)', a.maxTs, 0);
}
{
  const a = await runWithRange(999, 999);
  eq('999 → 0', a.minTs, 0);
  eq('999 → 0 (max too)', a.maxTs, 0);
}
{
  const a = await runWithRange(1000, 1000);
  eq('1000 → 1', a.minTs, 1);
  eq('1000 → 1 (max too)', a.maxTs, 1);
}
{
  const a = await runWithRange(1500, 1500);
  eq('1500 → 1', a.minTs, 1);
  eq('1500 → 1 (max too)', a.maxTs, 1);
}
{
  // 2026-06-15T12:00:00.456Z. The second is the floor, not a rounded clock.
  const MS_2026 = 1781524800456;
  const a = await runWithRange(MS_2026, MS_2026);
  eq('2026 ms timestamp → 1781524800 s (minTs)', a.minTs, 1781524800);
  eq('2026 ms timestamp → 1781524800 s (maxTs)', a.maxTs, 1781524800);
}

// -------------------------------------------------------- coverage outputs
console.log('\n-- coverage outputs: holeCount scalar, not holes.length --');
{
  const L = makeLane({
    pages: { [CT]: [pageOf('h0', 2)] },
    numPages: { [CT]: 1 },
  });
  await L.runLaneBackfill();
  ok('full 1-page walk: laneDeepDone takes cov.done', L.deepDone === true);
  eq('full 1-page walk: no holes', L.deepHoles, 0);
}
{
  const L = makeLane({
    pages: { [CT]: [pageOf('h1', 2), pageOf('h2', 2), pageOf('h3', 2), pageOf('h4', 2)] },
    numPages: { [CT]: 20 },
    requests: 2,
  });
  await L.runLaneBackfill();
  ok('partial walk: laneDeepDone is false', L.deepDone === false);
}
{
  // Every history() throws. holes[] is capped at HOLES_CAP; holeCount is not.
  // Enough runs that the two must differ if the page reads the scalar.
  const L = makeLane({ fail: () => true, requests: 3 });
  let steps = 0;
  while (steps < 120 && L.deepHoles <= HOLES_CAP) {
    await L.runLaneBackfill();
    steps++;
  }
  ok('constructed more holes than HOLES_CAP', L.deepHoles > HOLES_CAP,
     `holes=${L.deepHoles} cap=${HOLES_CAP} steps=${steps}`);
  ok('laneDeepHoles is not stuck at the list cap (would be holes.length)',
     L.deepHoles !== HOLES_CAP, String(L.deepHoles));
  ok('laneDeepDone stays false across a hole-only walk', L.deepDone === false);
}

// ------------------------------------------------------------ laneRangeDone
console.log('\n-- laneRangeDone --');
{
  const L = makeLane({
    pages: { [CT]: [pageOf('rd1', 2)] },
    numPages: { [CT]: 1 },
    range: { from: 0, to: null },
  });
  await L.runLaneBackfill();
  ok('window + every protocol done → true', L.rangeDone === true);
}
{
  const L = makeLane({
    scope: [CT, PB],
    pages: {
      [CT]: [pageOf('rdC', 2)],
      [PB]: [pageOf('rdP0', 2), pageOf('rdP1', 2), pageOf('rdP2', 2),
             pageOf('rdP3', 2), pageOf('rdP4', 2), pageOf('rdP5', 2),
             pageOf('rdP6', 2)],
    },
    numPages: { [CT]: 1, [PB]: 20 },
    range: { from: 0, to: null },
    requests: 6,
  });
  await L.runLaneBackfill();
  ok('window active, one protocol still open → false', L.rangeDone === false);
  ok('(and that protocol is not done)', L.deepDone === false);
}
{
  const L = makeLane({
    pages: { [CT]: [pageOf('rd0', 2)] },
    numPages: { [CT]: 1 },
    range: { from: null, to: null },
  });
  await L.runLaneBackfill();
  ok('no window, everything finished → false', L.rangeDone === false);
  ok('(the chain IS done; the window is not the question)', L.deepDone === true);
}

// --------------------------------------------------------------- laneUnread
console.log('\n-- laneUnread, the (a)/(b) rule --');
{
  // (b) tried and still nothing: first visit, every page is a hole.
  const L = makeLane({ fail: () => true, requests: 3 });
  await L.runLaneBackfill();
  eq('(b) first visit, all holes: counts', L.unread, 1);
  ok('(b) oldestTs never landed (pos moved on holes)', L.bf && L.bf.cursor[CT].pos > 0);
}
{
  // (a) this run advanced pos without pagesDone — a hole on a protocol that
  // already has an oldestTs, so (b) does not fire.
  // Same client for both runs: page 0 succeeds, everything deeper throws.
  // createBackfill closes over chronik, so swapping state.chronik would not
  // reach the engine — this is the reused instance the lifecycle test pins.
  const L = makeLane({
    pages: { [CT]: [pageOf('ua0', 2), pageOf('ua1', 2), pageOf('ua2', 2)] },
    numPages: { [CT]: 20 },
    requests: 1,
    fail: (_id, page) => page > 0,
  });
  await L.runLaneBackfill();
  eq('(a) setup: a successful page is not unread', L.unread, 0);
  ok('(a) setup: oldestTs is now set', L.bf.cursor[CT].oldestTs != null);
  const pagesBefore = L.bf.cursor[CT].pagesDone;
  await L.runLaneBackfill();
  eq('(a) hole this run on a known protocol: counts', L.unread, 1);
  eq('(a) pagesDone did not move', L.bf.cursor[CT].pagesDone, pagesBefore);
}
{
  const L = makeLane({
    pages: { [CT]: [pageOf('ud', 2)] },
    numPages: { [CT]: 1 },
  });
  await L.runLaneBackfill();
  ok('done protocol: never counts', L.unread === 0 && L.deepDone === true);
}
{
  // Returning reader: six protocols already read to their floor. Nothing
  // moves this run. Must be 0, not 6 — every cursor field is a lifetime
  // total that load() restores, and counting those is the regression.
  const saved = {};
  for (const id of MESSAGE_LOKADS) {
    saved[id] = {
      ranges: [[0, 6, TS - 86400, TS]],
      pagesDone: 6, numPages: 6, numTxs: 300,
      oldestTs: TS - 86400, done: true, rangeDone: false,
    };
  }
  const L = makeLane({
    scope: MESSAGE_LOKADS.slice(),
    savedCursor: saved,
    pages: Object.fromEntries(MESSAGE_LOKADS.map((id) => [id, []])),
    numPages: Object.fromEntries(MESSAGE_LOKADS.map((id) => [id, 6])),
    numTxs: Object.fromEntries(MESSAGE_LOKADS.map((id) => [id, 300])),
  });
  await L.runLaneBackfill();
  eq('returning reader, nothing moved this run: 0 not 6', L.unread, 0);
  ok('returning reader: load() restored the lifetime cursor', L.loads === 1);
}

// -------------------------------------------------------------- persistence
console.log('\n-- persistence: save even when run() throws --');
{
  const L = makeLane({
    pages: { [CT]: [pageOf('sv', 3)] },
    numPages: { [CT]: 4 },
    holdThrow: true,
    requests: 2,
  });
  await L.runLaneBackfill();
  ok('run() threw (onBatch/laneHold): call still settled', L.busy === false);
  ok('saveLaneStore ran despite the throw', L.saveN >= 1, String(L.saveN));
  ok('those pages were still written to storage', L.raw() != null);
  const stored = JSON.parse(L.raw());
  ok('stored cursor kept the page that was read before the throw',
     stored && stored.cursor && stored.cursor[CT] && stored.cursor[CT].pagesDone >= 1,
     JSON.stringify(stored && stored.cursor && stored.cursor[CT]));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
