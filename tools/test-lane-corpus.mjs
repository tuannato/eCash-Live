// Harness for the Lane corpus, hold, mute, rematch and term restore.
//   node tools/test-lane-corpus.mjs
//
// The corpus store is imported from the shipped vendor/core/lane-corpus.js
// (the same module Flow loads). Cursor/coverage math is imported from
// vendor/core/lane-cursor.js. Door-owned functions are still extracted from
// flow/index.html. The previous file at this path re-stated a copy (CORPUS_MAX
// 3000, insertion-order corpus eviction, FIFO laneHold, no lokad/from) and
// stayed green while the page diverged. A test of a copy passes when the copy
// is right; those fail when the page is wrong.
//
// Constants (CORPUS_MAX, MATCH_MAX, TERM_MAX, TERMS_KEY) are read out of the
// page. Hardcoding them is how the fossil rotted.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { matchAny, matchEvery } from '../vendor/core/match.js';
import { MESSAGE_LOKADS, LOKAD, LOKAD_NAMES } from '../vendor/txparse.js';
import {
  inScope as inScopeOf, sanitizeScope, rangeActive as rangeActiveOf, inRange as inRangeOf,
} from '../vendor/core/lane-cursor.js';
import { createCorpus } from '../vendor/core/lane-corpus.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];

/** Lift `function name(...) { ... }` out of the module by balancing braces.
 *  Strings and comments are skipped so a brace inside either cannot end it. */
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

const CORPUS_MAX = Number(mod.match(/const CORPUS_MAX = (\d+)/)[1]);
const MATCH_MAX = Number(mod.match(/const MATCH_MAX = (\d+)/)[1]);
const TERM_MAX = Number(mod.match(/const TERM_MAX = (\d+)/)[1]);
const TERMS_KEY = mod.match(/const TERMS_KEY = '([^']+)'/)[1];

const NAMES = [
  'txWhenMs', 'laneTsOf',
  'enabledTerms', 'activeMutes', 'matchTerms', 'txMatchesTerms', 'txIsMuted',
  'laneHold', 'laneSetMatched', 'laneSuggestInvalidate', 'laneRematch',
  'muteApply', 'recountMutes', 'muteCount',
  'laneAdd', 'sessionCoverage',
  'loadTerms', 'saveTerms',
];
// Concatenate: shipped comments contain backticks that would terminate a
// template literal around ${grab(...)}.
const bodies = NAMES.map(grab).join('\n\n');

const CT = LOKAD.CASHTAB_MSG, PB = LOKAD.PAYBUTTON, EC = LOKAD.ECASHCHAT_TX;

function makeLane(opts = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const scope = opts.scope || [CT];
  const terms = opts.terms ? opts.terms.slice() : [];
  const termMode = opts.termMode || 'any';
  const src = [
    '"use strict";',
    'const state = {',
    '  laneScope: scope.slice(), termMode, terms: terms.slice(),',
    '  txs: new Map(), laneTxs: new Map(), matched: [], matchedTotal: 0,',
    '  laneOpen: false,',
    '};',
    'const laneCorpus = createCorpus({ max: CORPUS_MAX });',
    'function corpusAdd(txid, text, ts, lokad, from){ laneCorpus.add(txid, text, ts, lokad, from); }',
    'function corpusMatches(){',
    '  return laneCorpus.matches({',
    '    terms: enabledTerms(), mutes: activeMutes(),',
    '    scope: state.laneScope, range: laneRange, mode: state.termMode,',
    '  });',
    '}',
    'const muteCounts = new Map();',
    'let laneRange = { from: null, to: null };',
    'let laneNoDate = 0, laneScopeHidden = 0;',
    'let laneSuggestCache = "seed";',
    'let renderLaneN = 0, renderChipsN = 0, chipRepaintN = 0;',
    'function renderLane(){ renderLaneN++; }',
    'function renderTermChips(){ renderChipsN++; }',
    'function scheduleChipRepaint(){ chipRepaintN++; }',
    'const inScope = (lokad) => inScopeOf(lokad, state.laneScope);',
    'const rangeActive = () => rangeActiveOf(laneRange);',
    'const inRange = (ts) => inRangeOf(ts, laneRange);',
    bodies,
    'return {',
    '  state, laneCorpus, muteCounts, localStorage,',
    '  inScope, corpusAdd, corpusMatches, laneTsOf, txWhenMs,',
    '  enabledTerms, activeMutes, matchTerms, txMatchesTerms, txIsMuted,',
    '  laneHold, laneSetMatched, laneRematch, laneSuggestInvalidate,',
    '  muteApply, recountMutes, muteCount, laneAdd, sessionCoverage,',
    '  loadTerms, saveTerms, inRange, sanitizeScope,',
    '  setRange: (r) => { laneRange = r; },',
    '  get corpusFull(){ return laneCorpus.full; },',
    '  get corpusGen(){ return laneCorpus.gen; },',
    '  get scopeHidden(){ return laneScopeHidden; },',
    '  get noDate(){ return laneNoDate; },',
    '  get suggestCache(){ return laneSuggestCache; },',
    '  get renderLaneN(){ return renderLaneN; },',
    '  get renderChipsN(){ return renderChipsN; },',
    '  get chipRepaintN(){ return chipRepaintN; },',
    '};',
  ].join('\n');
  const factory = new Function(
    'MESSAGE_LOKADS', 'LOKAD', 'LOKAD_NAMES',
    'matchAny', 'matchEvery',
    'CORPUS_MAX', 'MATCH_MAX', 'TERM_MAX', 'TERMS_KEY',
    'localStorage', 'scope', 'terms', 'termMode',
    'inScopeOf', 'sanitizeScope', 'rangeActiveOf', 'inRangeOf',
    'createCorpus',
    src
  );
  return factory(
    MESSAGE_LOKADS, LOKAD, LOKAD_NAMES,
    matchAny, matchEvery,
    CORPUS_MAX, MATCH_MAX, TERM_MAX, TERMS_KEY,
    localStorage, scope, terms, termMode,
    inScopeOf, sanitizeScope, rangeActiveOf, inRangeOf,
    createCorpus
  );
}

const term = (q, extra = {}) => ({ q, on: true, mode: 'word', fold: false, mute: false, ...extra });

// Call-site shape of trackTx: increment only on first admit. muteApply itself
// is the shipped body; this is not a re-statement of it.
function admit(L, tx) {
  if (!L.state.txs.has(tx.id)) L.muteApply(tx, +1);
  L.state.txs.set(tx.id, tx);
}
function drop(L, id) {
  L.muteApply(L.state.txs.get(id), -1);
  L.state.txs.delete(id);
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log('\n=== extraction: shipped bodies, page constants ===');
ok('CORPUS_MAX came from the page', Number.isFinite(CORPUS_MAX) && CORPUS_MAX >= 1, String(CORPUS_MAX));
ok('MATCH_MAX came from the page', Number.isFinite(MATCH_MAX) && MATCH_MAX >= 1, String(MATCH_MAX));
ok('TERM_MAX came from the page', Number.isFinite(TERM_MAX) && TERM_MAX >= 1, String(TERM_MAX));
ok('TERMS_KEY came from the page', typeof TERMS_KEY === 'string' && TERMS_KEY.length > 0, TERMS_KEY);
ok('laneRematch body starts with function laneRematch',
  grab('laneRematch').startsWith('function laneRematch('));
ok('laneHold body starts with function laneHold',
  grab('laneHold').startsWith('function laneHold('));
ok('loadTerms body starts with function loadTerms',
  grab('loadTerms').startsWith('function loadTerms('));
let factoryErr = null;
try { makeLane(); }
catch (e) { factoryErr = e; }
ok('factory compiles', !factoryErr, factoryErr && (factoryErr.stack || factoryErr.message));

console.log('\n=== A. a NEW term is answered from the corpus, with no network ===');
{
  const L = makeLane();
  L.corpusAdd('t1', 'alpha channel', 1000, CT);
  L.corpusAdd('t2', 'beta release', 2000, CT);
  L.corpusAdd('t3', 'nothing here', 3000, CT);
  L.state.terms = [term('alpha')];
  const first = L.corpusMatches();
  L.state.terms = [term('beta')];
  const second = L.corpusMatches();
  eq('term 1 answered locally', first.ids, ['t1']);
  eq('term 2 answered locally from the SAME corpus', second.ids, ['t2']);
  eq('corpus is not consumed by answering', L.laneCorpus.size, 3);
  L.state.terms = [];
  eq('no-terms returns no ids (and does not invent hidden)', L.corpusMatches().ids, []);
  eq('empty follow list is empty, not stale', L.corpusMatches().hidden.size, 0);
}

console.log('\n=== B. the skipped-pages bug the corpus exists to prevent ===');
{
  // The old shape: results cleared, cursor kept. A new term resumed at page N
  // and pages 0..N-1 were unreachable forever. The corpus keeps every scanned
  // row, so a term introduced AFTER the walk still sees the early pages.
  const L = makeLane();
  const pages = [['p0a', 'beta one'], ['p1a', 'beta two'], ['p2a', 'gamma']];
  pages.forEach(([id, text], i) => L.corpusAdd(id, text, 1000 + i, CT));
  L.state.terms = [term('beta')];
  const hits = L.corpusMatches();
  eq('a term introduced AFTER the walk still sees page 0 and 1',
    hits.ids.slice().sort(), ['p0a', 'p1a']);
  eq('page 2 is in the corpus even though it did not match', L.laneCorpus.has('p2a'), true);
}

console.log('\n=== C. state.matched has ONE owner and one cap ===');
{
  const L = makeLane();
  const ids = [];
  for (let i = 0; i < 150; i++) {
    const id = 's' + i;
    L.state.txs.set(id, { id, ts: 1e6 + i });
    ids.push(id);
  }
  for (let i = 0; i < MATCH_MAX; i++) {
    const id = 'b' + i;
    L.laneHold({ id, ts: 500 + i });
    ids.push(id);
  }
  L.laneSetMatched(ids);
  eq('350 candidates capped to MATCH_MAX', L.state.matched.length, MATCH_MAX);
  eq('matchedTotal still names the uncapped count', L.state.matchedTotal, 150 + MATCH_MAX);
  eq('cap kept the newest (they sit at the END)', L.state.matched[L.state.matched.length - 1], 's149');
  eq('the oldest backfilled id is the one that left', L.state.matched.includes('b0'), false);
  L.state.txs.set('live1', { id: 'live1', ts: 2e6 });
  const beforeOldest = L.state.matched[0];
  L.laneSetMatched(['live1', ...L.state.matched]);
  eq('a live arrival does not exceed the cap', L.state.matched.length, MATCH_MAX);
  eq('it evicts the oldest, and the live id is last',
    L.state.matched[L.state.matched.length - 1], 'live1');
  eq('the previous oldest is gone', L.state.matched.includes(beforeOldest), false);
}
{
  const L = makeLane();
  for (let i = 0; i < MATCH_MAX + 60; i++) L.laneHold({ id: 'x' + i, ts: i, _hay: 'z' });
  eq('laneTxs cap holds at MATCH_MAX', L.state.laneTxs.size, MATCH_MAX);
}

console.log('\n=== D. corpus bound at the page CORPUS_MAX; eviction is oldest-by-ts ===');
{
  const L = makeLane();
  // Newest FIRST so insertion order is the opposite of ts order. Insertion-
  // order eviction (what the fossil believed) would drop c0; the shipped rule
  // drops the smallest ts.
  for (let i = 0; i < CORPUS_MAX; i++) L.corpusAdd('c' + i, 'text ' + i, 10_000 - i, CT);
  eq('corpus capped at the page CORPUS_MAX', L.laneCorpus.size, CORPUS_MAX);
  ok('not flagged full merely by sitting at the cap', L.corpusFull === false);
  const genAtCap = L.corpusGen;

  L.corpusAdd('ancient', 'too old', 1, CT);
  eq('a row older than the oldest held is refused', L.laneCorpus.has('ancient'), false);
  eq('size unchanged by the refusal', L.laneCorpus.size, CORPUS_MAX);
  ok('refusal sets corpusFull', L.corpusFull === true);
  eq('the oldest held is still there', L.laneCorpus.has('c' + (CORPUS_MAX - 1)), true);
  eq('refusal does not bump corpusGen', L.corpusGen, genAtCap);

  L.corpusAdd('fresh', 'page 0', 20_000, CT);
  eq('a newer row still fits the cap', L.laneCorpus.size, CORPUS_MAX);
  eq('it entered', L.laneCorpus.has('fresh'), true);
  eq('oldest-by-ts left (not the first-inserted)', L.laneCorpus.has('c' + (CORPUS_MAX - 1)), false);
  eq('first-inserted was the NEWEST and stayed', L.laneCorpus.has('c0'), true);
  ok('accepting at the cap also flags full', L.corpusFull === true);
  ok('accepting bumps corpusGen', L.corpusGen > genAtCap);

  const n = L.laneCorpus.size;
  L.corpusAdd('c1', 'dup', 9);
  eq('duplicate txid does not grow the corpus', L.laneCorpus.size, n);
}
{
  const L = makeLane();
  L.corpusAdd('leg', 'hello', 1, null, null);
  const gen0 = L.corpusGen;
  eq('stored untagged', L.laneCorpus.get('leg').lokad, null);
  eq('stored without from', L.laneCorpus.get('leg').from, null);
  L.corpusAdd('leg', 'hello', 1, CT, 'abcd1234');
  eq('legacy row gains lokad in place', L.laneCorpus.get('leg').lokad, CT);
  eq('legacy row gains from in place', L.laneCorpus.get('leg').from, 'abcd1234');
  ok('upgrade bumps corpusGen', L.corpusGen === gen0 + 1);
  L.corpusAdd('leg', 'hello', 1, PB, 'ffffffff');
  eq('an existing lokad is never overwritten', L.laneCorpus.get('leg').lokad, CT);
  eq('an existing from is never overwritten', L.laneCorpus.get('leg').from, 'abcd1234');
  eq('text not clobbered by the upgrade path', L.laneCorpus.get('leg').text, 'hello');
  eq('upgrade does not add a row', L.laneCorpus.size, 1);
}

console.log('\n=== E. mute outranks follow, corpus path and live path ===');
{
  const L = makeLane({ terms: [term('alpha'), term('buy', { mute: true })] });
  L.corpusAdd('m1', 'buy alpha now', 10, CT);
  L.corpusAdd('m2', 'alpha only', 20, CT);
  eq('a muted match is excluded from a corpus answer', L.corpusMatches().ids, ['m2']);
  eq('the muted row is not reported as scope-hidden either', L.corpusMatches().hidden.size, 0);
}
{
  const L = makeLane({ terms: [term('alpha'), term('buy', { mute: true })] });
  const muted = { id: 'm1', _hay: 'buy alpha now' };
  const clean = { id: 'm2', _hay: 'alpha only' };
  const none = { id: 'm3', _hay: 'nothing' };
  const silent = { id: 'm4', _hay: null };
  ok('live: muted text is muted', L.txIsMuted(muted) === true);
  ok('live: clean follow is not muted', L.txIsMuted(clean) === false);
  ok('live: muted text is NOT a Lane match', L.txMatchesTerms(muted) === false);
  ok('live: clean follow IS a Lane match', L.txMatchesTerms(clean) === true);
  ok('live: a non-match is not a match', L.txMatchesTerms(none) === false);
  ok('live: no text is not muted and not a match',
    L.txIsMuted(silent) === false && L.txMatchesTerms(silent) === false);
}

console.log('\n=== F3. display order is oldest-first, cap keeps the newest ===');
{
  const L = makeLane();
  for (let i = 0; i < 5; i++) {
    L.corpusAdd('t' + i, 'alpha', 1000 + i, CT);
    L.state.txs.set('t' + i, { id: 't' + i, ts: 1000 + i });
  }
  L.laneSetMatched(['t4', 't0', 't2', 't1', 't3']);
  eq('oldest at top, newest at bottom, regardless of input order',
    L.state.matched, ['t0', 't1', 't2', 't3', 't4']);
  L.corpusAdd('unknown', 'alpha', null, CT);
  L.laneSetMatched(['t0', 'unknown']);
  eq('unknown timestamp sorts to the TOP (oldest end), never the bottom',
    L.state.matched, ['unknown', 't0']);
}

console.log('\n=== laneHold: unwanted first, then oldest by laneTsOf ===');
{
  // THE MEASURED BUG. A Jun 2023 window + oldest-by-time eviction: every
  // wanted row IS the oldest thing held, so each was evicted the instant it
  // hydrated. Four real pages, 95 fetched, 0 rendered. Unwanted-first stops
  // that: recent rows the window excludes leave first.
  const L = makeLane({ terms: [term('alpha')] });
  L.setRange({ from: Date.UTC(2023, 5, 1), to: Date.UTC(2023, 5, 30) });
  for (let i = 0; i < MATCH_MAX; i++) {
    L.laneHold({ id: 'recent' + i, ts: Date.UTC(2026, 0, 1) + i * 1000, _hay: 'alpha', _lokad: CT });
  }
  eq('filled with out-of-window rows', L.state.laneTxs.size, MATCH_MAX);
  for (let i = 0; i < 95; i++) {
    L.laneHold({ id: 'jun' + i, ts: Date.UTC(2023, 5, 10) + i * 1000, _hay: 'alpha', _lokad: CT });
  }
  eq('still at MATCH_MAX after the 95 wanted arrived', L.state.laneTxs.size, MATCH_MAX);
  ok('all 95 wanted 2023 rows are still held (the bug no longer happens)',
    Array.from({ length: 95 }, (_, i) => L.state.laneTxs.has('jun' + i)).every(Boolean));
  eq('95 recent out-of-window rows left to make room',
    Array.from({ length: MATCH_MAX }, (_, i) => L.state.laneTxs.has('recent' + i)).filter(Boolean).length,
    MATCH_MAX - 95);
}
{
  // Distinguishes unwanted-first from FIFO. FIFO and unwanted-first agree
  // when the unwanted rows were inserted first (the 2023 case above). They
  // disagree when the map is full of WANTED and an unwanted arrives: FIFO
  // evicts the first-inserted wanted; the shipped rule evicts the unwanted.
  const L = makeLane({ terms: [term('alpha')] });
  for (let i = 0; i < MATCH_MAX; i++) {
    L.laneHold({ id: 'w' + i, ts: 1000 + i, _hay: 'alpha', _lokad: CT });
  }
  L.laneHold({ id: 'unwanted', ts: 99_999, _hay: 'alpha', _lokad: PB });
  eq('unwanted-first: the out-of-scope arrival was evicted', L.state.laneTxs.has('unwanted'), false);
  ok('unwanted-first: every wanted row remains',
    Array.from({ length: MATCH_MAX }, (_, i) => L.state.laneTxs.has('w' + i)).every(Boolean));
  eq('size still MATCH_MAX', L.state.laneTxs.size, MATCH_MAX);
}
{
  // Among wanted, the tiebreak is oldest-by-laneTsOf, not insertion order.
  const L = makeLane({ terms: [term('alpha')] });
  for (let i = 0; i < MATCH_MAX; i++) {
    L.laneHold({ id: 'r' + i, ts: 10_000 - i, _hay: 'alpha', _lokad: CT });
  }
  L.laneHold({ id: 'newer', ts: 20_000, _hay: 'alpha', _lokad: CT });
  eq('among wanted, the oldest-by-ts left', L.state.laneTxs.has('r' + (MATCH_MAX - 1)), false);
  eq('first-inserted was the newest-by-ts and stayed', L.state.laneTxs.has('r0'), true);
  eq('the newer arrival entered', L.state.laneTxs.has('newer'), true);
}
{
  const L = makeLane();
  L.laneHold({ id: 'a', ts: 1 });
  L.laneHold({ id: 'a', ts: 2 });
  eq('duplicate hold is a no-op', L.state.laneTxs.size, 1);
  eq('the first object is kept', L.state.laneTxs.get('a').ts, 1);
}

console.log('\n=== H. mute counts are incremental, not a re-walk ===');
{
  const L = makeLane({ terms: [term('spam', { mute: true })] });
  admit(L, { id: 'a', _hay: 'spam offer' });
  admit(L, { id: 'b', _hay: 'spam again' });
  admit(L, { id: 'c', _hay: 'clean text' });
  eq('counts up on admit', L.muteCount('spam'), 2);
  admit(L, { id: 'a', _hay: 'spam offer' });
  eq('re-admitting the same txid does not double count', L.muteCount('spam'), 2);
  drop(L, 'a');
  eq('counts down on eviction', L.muteCount('spam'), 1);
  drop(L, 'c');
  eq('evicting a non-match changes nothing', L.muteCount('spam'), 1);
  drop(L, 'b');
  eq('never goes negative', L.muteCount('spam'), 0);
  ok('muteApply scheduled a chip repaint when the count changed', L.chipRepaintN > 0);
}
{
  const L = makeLane();
  admit(L, { id: 'x', _hay: 'buy now' });
  admit(L, { id: 'y', _hay: 'buy later' });
  L.state.terms = [term('buy', { mute: true })];
  eq('a mute added AFTER the txs starts at 0 without a recount', L.muteCount('buy'), 0);
  L.recountMutes();
  eq('recount picks up the history in state.txs', L.muteCount('buy'), 2);
  admit(L, { id: 'z', _hay: 'buy again' });
  eq('the incremental path then continues from it', L.muteCount('buy'), 3);
  admit(L, { id: 'n', _hay: null });
  eq('a tx with no text is ignored by both paths', L.muteCount('buy'), 3);
}
{
  const L = makeLane({ terms: [term('spam', { mute: true }), term('alpha')] });
  L.muteCounts.set('spam', 7);
  L.muteCounts.set('alpha', 4);
  eq('muteCount reports the map for an active mute', L.muteCount('spam'), 7);
  eq('muteCount is 0 for a follow, even if the map is stale', L.muteCount('alpha'), 0);
  L.state.terms[0].on = false;
  eq('muteCount is 0 for a mute that is off', L.muteCount('spam'), 0);
}
{
  // recount walks state.txs only — mute is a stream defence. A held Lane
  // row that never entered the live map is not counted.
  const L = makeLane({ terms: [term('spam', { mute: true })] });
  L.state.laneTxs.set('held', { id: 'held', _hay: 'spam held' });
  L.recountMutes();
  eq('recount does not walk laneTxs', L.muteCount('spam'), 0);
}

console.log('\n=== I. restore rule: a follow comes back OFF, a mute comes back ON ===');
{
  const L = makeLane();
  L.state.termMode = 'all';
  L.state.laneScope = [CT, PB];
  L.state.terms = [
    term('topic', { on: true, mode: 'contains', fold: true }),
    term('spam', { mute: true, on: true }),
    term('off-mute', { mute: true, on: false }),
  ];
  L.saveTerms();
  const saved = JSON.parse(L.localStorage.getItem(TERMS_KEY));
  eq('saveTerms writes the mode beside the terms', saved.mode, 'all');
  eq('saveTerms writes the scope beside the terms', saved.scope, [CT, PB]);
  eq('saveTerms writes the follow as still ON (the reset is on load)', saved.terms[0].on, true);

  const R = makeLane();
  R.localStorage.setItem(TERMS_KEY, L.localStorage.getItem(TERMS_KEY));
  R.loadTerms();
  eq('a followed topic restores OFF', R.state.terms[0].on, false);
  eq('an active mute restores ON', R.state.terms[1].on, true);
  eq('a mute the reader turned off stays off', R.state.terms[2].on, false);
  eq('the topic itself is still saved, only its state resets', R.state.terms[0].q, 'topic');
  eq('three terms came back', R.state.terms.length, 3);
  eq('mode survives the reset', R.state.termMode, 'all');
  eq('fold survives the reset', R.state.terms[0].fold, true);
  eq('contains mode survives the reset', R.state.terms[0].mode, 'contains');
  eq('scope survives the reset', R.state.laneScope, [CT, PB]);
}
{
  // Older saves are a bare array. loadTerms still applies the restore rule.
  const L = makeLane();
  L.localStorage.setItem(TERMS_KEY, JSON.stringify([
    { q: 'old-follow', on: true, mute: false },
    { q: 'old-mute', on: true, mute: true },
  ]));
  L.loadTerms();
  eq('legacy array: follow restores OFF', L.state.terms[0].on, false);
  eq('legacy array: mute restores ON', L.state.terms[1].on, true);
}
{
  const L = makeLane();
  const long = 'x'.repeat(60);
  const extras = [];
  for (let i = 0; i < TERM_MAX + 3; i++) extras.push({ q: 't' + i, on: true, mute: false });
  L.localStorage.setItem(TERMS_KEY, JSON.stringify({
    mode: 'any',
    terms: [{ q: long, on: true, mute: false, mode: 'nope' }, ...extras],
  }));
  L.loadTerms();
  eq('q is clipped to 40', L.state.terms[0].q.length, 40);
  eq('unknown mode becomes word', L.state.terms[0].mode, 'word');
  eq('load stops at TERM_MAX', L.state.terms.length, TERM_MAX);
}

console.log('\n=== J. ANY widens, ALL narrows (shipped matchTerms) ===');
{
  const L = makeLane();
  const a = term('alpha'), b = term('beta');
  L.state.termMode = 'any';
  ok('ANY: one of two is enough', L.matchTerms('alpha only', [a, b]) === true);
  ok('ANY: both present also matches', L.matchTerms('alpha and beta', [a, b]) === true);
  L.state.termMode = 'all';
  ok('ALL: one of two is not', L.matchTerms('alpha only', [a, b]) === false);
  ok('ALL: both present matches', L.matchTerms('alpha and beta', [a, b]) === true);
  ok('order in the text does not matter', L.matchTerms('beta then alpha', [a, b]) === true);
  // The dangerous edge: "all of nothing" is vacuously true in logic and would
  // put EVERY transaction in the lane the moment the last topic was switched off.
  ok('ALL of an empty list is FALSE, not vacuously true', L.matchTerms('anything', []) === false);
  ok('ALL ignores disabled terms rather than failing on them',
    L.matchTerms('alpha only', [a, { ...b, on: false }]) === true);
  ok('ALL of only-disabled terms is false, not vacuously true',
    L.matchTerms('alpha only', [{ ...a, on: false }]) === false);
  ok('ALL respects per-term mode',
    L.matchTerms('banana plan', [term('an', { mode: 'contains' })]) === true);
  ok('...and rejects when one term fails under its own mode',
    L.matchTerms('banana plan', [term('an', { mode: 'contains' }), term('zzz')]) === false);
  L.state.termMode = 'any';
  ok('empty haystack is false in ANY', L.matchTerms('', [a]) === false);
  L.state.termMode = 'all';
  ok('empty haystack is false in ALL', L.matchTerms('', [a]) === false);
}
{
  // A mute is a VETO and stays ANY whatever the follow mode is.
  const L = makeLane({
    termMode: 'all',
    terms: [term('alpha'), term('beta'), term('buy', { mute: true }), term('zzz', { mute: true })],
  });
  ok('one mute of two is enough to hide, even under ALL follows',
    L.txIsMuted({ id: 'h', _hay: 'buy alpha now' }) === true);
  ok('...so ALL-of-follows cannot let a muted row through',
    L.txMatchesTerms({ id: 'h', _hay: 'buy alpha and beta' }) === false);
  ok('the same text without the mute word matches ALL follows',
    L.txMatchesTerms({ id: 'ok', _hay: 'alpha and beta' }) === true);
}

console.log('\n=== laneRematch union: one hidden message counted ONCE ===');
{
  // Nearly every hydrated result is in the corpus AND in state.laneTxs. Counting
  // each source separately would promise twice what one tick of a checkbox
  // brings back. hidden is a Set, so the two sources cannot double-count.
  //
  // This used to be re-stated in test-lane-scope.mjs with a claim that
  // laneRematch "reaches into DOM-bound state and cannot be lifted." Measured
  // against the shipped body: DOM 0, i18n 0, localStorage 0. It is lifted here.
  const L = makeLane({ terms: [term('gm')], scope: [CT] });
  L.corpusAdd('c1', 'gm world', 10, CT);
  L.corpusAdd('c2', 'gm friends', 11, PB);
  L.corpusAdd('c3', 'gm again', 12, EC);
  L.corpusAdd('c4', 'gm legacy', 13, null);
  L.corpusAdd('c5', 'nothing here', 14, CT);
  L.state.laneTxs.set('c2', { id: 'c2', _hay: 'gm friends', _lokad: PB, ts: 11 });
  L.state.laneTxs.set('c3', { id: 'c3', _hay: 'gm again', _lokad: EC, ts: 12 });
  L.state.laneTxs.set('c9', { id: 'c9', _hay: 'gm extra', _lokad: PB, ts: 19 });
  const cm = L.corpusMatches();
  eq('corpus alone hides 2 (c2, c3)', [...cm.hidden].sort(), ['c2', 'c3']);
  L.laneRematch();
  eq('union says 3, not 5', L.scopeHidden, 3);
  eq('matched is the in-scope corpus hits (c1, c4), oldest first',
    L.state.matched, ['c1', 'c4']);
  eq('c9 is held but out of scope, so it is not in matched',
    L.state.matched.includes('c9'), false);
  eq('suggest cache was invalidated', L.suggestCache, null);
}
{
  // THE SCOPE FILTERS THE INDEX, NEVER THE LIVE STREAM. A matching live tx
  // with a PayButton tag still enters the answer.
  const L = makeLane({ terms: [term('gm')], scope: [CT] });
  L.corpusAdd('c1', 'gm world', 10, CT);
  L.state.txs.set('live-pb', { id: 'live-pb', _hay: 'gm from live', _lokad: PB, ts: 50 });
  L.laneRematch();
  ok('a live match is in the answer even when its tag is out of scope',
    L.state.matched.includes('live-pb'));
  ok('the in-scope corpus hit is there too', L.state.matched.includes('c1'));
}
{
  // Mute outranks follow on the rematch path the same way it does live:
  // txMatchesTerms, not a private copy of matchAny. This shipped wrong once.
  const L = makeLane({ terms: [term('gm'), term('buy', { mute: true })] });
  L.state.txs.set('seed', { id: 'seed', _hay: 'buy gm now', ts: 1 });
  L.state.laneTxs.set('held', { id: 'held', _hay: 'buy gm held', ts: 2, _lokad: CT });
  L.corpusAdd('corp', 'buy gm corp', 3, CT);
  L.laneRematch();
  eq('muted rows from every source stay out of matched', L.state.matched, []);
}

console.log('\n=== laneAdd: hold, then one owner of matched ===');
{
  const L = makeLane({ terms: [term('alpha')] });
  L.laneAdd({ id: 'a', ts: 1500, _hay: 'alpha' });
  eq('held', L.state.laneTxs.has('a'), true);
  eq('matched', L.state.matched, ['a']);
  L.laneAdd({ id: 'a', ts: 1500, _hay: 'alpha' });
  eq('duplicate add does not grow matched', L.state.matched.length, 1);
  L.laneAdd({ id: 'b', ts: 1400, _hay: 'alpha' });
  eq('second add is ordered oldest-first', L.state.matched, ['b', 'a']);
  eq('chips repaint on a new match', L.renderChipsN >= 1, true);
}
{
  const L = makeLane({ terms: [term('alpha')] });
  L.setRange({ from: 1000, to: 2000 });
  L.laneAdd({ id: 'out', ts: 9999, _hay: 'alpha' });
  eq('out of window is not held', L.state.laneTxs.has('out'), false);
  eq('out of window is not matched', L.state.matched.includes('out'), false);
}
{
  const L = makeLane({ terms: [term('alpha')] });
  for (let i = 0; i < MATCH_MAX + 5; i++) {
    L.laneAdd({ id: 'n' + i, ts: 1000 + i, _hay: 'alpha' });
  }
  eq('laneAdd cannot grow matched past MATCH_MAX', L.state.matched.length, MATCH_MAX);
  eq('the newest id is last', L.state.matched[MATCH_MAX - 1], 'n' + (MATCH_MAX + 4));
}

console.log('\n=== sessionCoverage: scanned / noText, recomputed, not latched ===');
{
  // The comment above the shipped body says this uses txMatchesTerms. The body
  // does not — it counts every held live tx and how many carry no writing.
  // Mute and follow do not change the numbers. That is what is pinned.
  const L = makeLane({ terms: [term('alpha'), term('spam', { mute: true })] });
  L.state.txs.set('a', { id: 'a', _hay: 'alpha' });
  L.state.txs.set('b', { id: 'b', _hay: 'spam' });
  L.state.txs.set('c', { id: 'c', _hay: null });
  L.state.txs.set('d', { id: 'd' });
  eq('scanned is every live tx', L.sessionCoverage().scanned, 4);
  eq('noText counts missing _hay, not non-matches', L.sessionCoverage().noText, 2);
  L.state.txs.set('e', { id: 'e', _hay: 'alpha again' });
  eq('recomputed on demand — a later admit moves the figure', L.sessionCoverage().scanned, 5);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
