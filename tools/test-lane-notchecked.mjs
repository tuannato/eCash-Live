// Harness for the Lane's "not checked" qualifier (2026-08-16).
//   node internal/test-lane-notchecked.mjs
//
// Like tools/test-lane-scope.mjs and unlike tools/test-lane-corpus.mjs, this
// EXTRACTS the shipped function bodies from flow/index.html and runs those.
// A test of a copy passes when the copy is right; this one fails when the
// page is wrong.
//
// Why it exists: laneRefreshIndex used one session variable for two jobs
// (request budget vs "the prefix is actually verified"). A failed probe then
// silenced lane.notChecked. The two facts are now two names; this file
// drives the shipped laneRefreshIndex against a fake chronik and asserts
// both the qualifier and the once-per-session budget after a failure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];

/** Lift `function name(...) { ... }` by balancing braces, skipping strings and
 *  comments so a brace inside either cannot end it.
 *
 *  TRAP: `laneRefreshIndex` is declared `async function`. Searching for
 *  `'function ' + name + '('` lands AFTER the `async` keyword; slicing from
 *  there produces a non-async body and `await` throws SyntaxError. Walk
 *  back six characters and keep the keyword when it is there. */
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
const LANE_CURSOR_KEY = mod.match(/const LANE_CURSOR_KEY = '([^']+)'/)[1];

// The two gates, extracted so a rename or a re-merge fails this file rather
// than the suite passing against names we invented.
const honestyM = mod.match(/if \(reach && !(\w+)\) cov\.push\(t\('lane\.notChecked'\)\)/);
if (!honestyM) throw new Error('honesty gate not found in renderLane');
const HONESTY = honestyM[1];
const budgetM = mod.match(/function maybeAutoRefresh\(\)\{\s*if \((\w+) \|\| laneRefreshBusy\) return;/);
if (!budgetM) throw new Error('budget gate not found in maybeAutoRefresh');
const BUDGET = budgetM[1];

const CT = '00746162';
const PB = '50415900';
const TS = 1_700_000_000;

function prefix(numTxs, ranges) {
  return {
    ranges: ranges || [[0, 6, TS, TS + 86400]],
    numTxs,
    numPages: Number.isInteger(numTxs) ? Math.ceil(numTxs / LANE_PAGE) : undefined,
    done: false,
    rangeDone: false,
    pagesDone: 6,
  };
}

function makeLane(opts = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  let probes = 0;
  const handler = opts.probe || ((id) => ({ numTxs: 9000, txs: [] }));
  const chronik = {
    lokadId: (id) => ({
      history: async (page, size) => {
        probes++;
        return handler(id, page, size);
      },
    }),
  };
  // Concatenate: the shipped bodies contain backtick comments (`c`, `oldestTs`)
  // that would terminate a template literal around ${grab(...)}.
  const bodies = [
    grab('shiftRangesForGrowth'),
    grab('scopeCursorView'),
    grab('saveLaneStore'),
    grab('laneReach'),
    grab('laneRefreshIndex'),
    grab('maybeAutoRefresh'),
    grab('laneClearData'),
  ].join('\n\n');
  const src = [
    '"use strict";',
    'const state = { chronik, laneScope: [CT], laneOpen: true, laneTxs: new Map() };',
    'const laneCorpus = new Map();',
    'laneCorpus.set("seed", { text: "x", ts: ' + TS + ', lokad: CT, from: null });',
    'let laneBf = null;',
    'let laneSavedCursor = { [CT]: ' + JSON.stringify(prefix(9000)) + ' };',
    'let laneBusy = false;',
    'let ' + BUDGET + ' = 0;',
    'let ' + HONESTY + ' = 0;',
    'let laneRefreshBusy = false, laneRefreshMsg = null;',
    'let laneRunToken = 0, laneAbort = null;',
    'let corpusFull = false, laneStoreTrimmed = 0;',
    'let laneDeepHoles = 0, laneDeepDone = false, laneRangeDone = false;',
    'let laneUnread = 0, laneScopeHidden = 0, laneNoDate = 0;',
    'let suggestPrefetchP = null, suggestSeenNumTxs = null, suggestSeenLokad = null;',
    'let laneSuggestCache = null, laneSuggestAt = -1, corpusGen = 0;',
    'const setTimeout = () => 0;',
    'const toast = () => {};',
    'const t = (k) => k;',
    'const tf = (k) => k;',
    'const fmtInt = (n) => String(n);',
    'const renderLane = () => {};',
    'const renderLaneTools = () => {};',
    'const renderLaneMore = () => {};',
    'const refreshLaneScope = () => {};',
    'const laneRematch = () => {};',
    'const runLaneBackfill = async () => {};',
    bodies,
    'return {',
    '  state, laneCorpus,',
    '  laneRefreshIndex, maybeAutoRefresh, laneClearData, laneReach,',
    '  get spent(){ return ' + BUDGET + '; },',
    '  get verified(){ return ' + HONESTY + '; },',
    '  get saved(){ return laneSavedCursor; },',
    '  setSaved: (c) => { laneSavedCursor = c; },',
    '  setScope: (ids) => { state.laneScope = ids; },',
    '};',
  ].join('\n');
  const factory = new Function(
    'LANE_PAGE', 'LANE_CURSOR_KEY', 'localStorage', 'chronik', 'CT', 'PB',
    src
  );
  const L = factory(LANE_PAGE, LANE_CURSOR_KEY, localStorage, chronik, CT, PB);
  L.probes = () => probes;
  return L;
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  c ? pass++ : fail++;
  console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x));
};
const eq = (n, got, want) =>
  ok(n, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function qualifier(L) {
  // The shipped gate: if (reach && !lanePrefixVerifiedAt) show lane.notChecked.
  return !!(L.laneReach() && !L.verified);
}

const results = [];
function row(scenario, L, expectVerified, expectQualifier) {
  const verified = L.verified > 0;
  const shown = qualifier(L);
  const passRow = verified === expectVerified && shown === expectQualifier;
  results.push({
    scenario,
    verified,
    qualifier: shown ? 'shown' : 'hidden',
    ok: passRow,
  });
  ok(scenario + ': verified=' + verified + ' qualifier=' + (shown ? 'shown' : 'hidden'),
     passRow,
     `want verified=${expectVerified} qualifier=${expectQualifier ? 'shown' : 'hidden'}`);
}

console.log('-- grab keeps async, so await is legal --');
ok('laneRefreshIndex body starts with async function',
   grab('laneRefreshIndex').startsWith('async function laneRefreshIndex('));
ok('maybeAutoRefresh is not async',
   grab('maybeAutoRefresh').startsWith('function maybeAutoRefresh('));

console.log('\n-- the two facts are two names --');
ok('budget gate and honesty gate read different variables',
   BUDGET !== HONESTY,
   `both read ${BUDGET}`);
ok('budget name is laneProbeSpentAt', BUDGET === 'laneProbeSpentAt');
ok('honesty name is lanePrefixVerifiedAt', HONESTY === 'lanePrefixVerifiedAt');

// ---------------------------------------------------------------- scenarios
console.log('\n-- shipped laneRefreshIndex vs fake chronik --');

{
  const L = makeLane({
    probe: () => { throw new Error('offline'); },
  });
  const before = JSON.parse(JSON.stringify(L.saved[CT].ranges));
  await L.laneRefreshIndex(true);
  row('probe throws for every protocol', L, false, true);
  eq('throw: ranges unchanged (why the qualifier matters)', L.saved[CT].ranges, before);
  ok('throw: budget spent', L.spent > 0);
}

{
  const L = makeLane({
    probe: () => ({ numTxs: 'nope', txs: [] }),
  });
  const before = JSON.parse(JSON.stringify(L.saved[CT].ranges));
  await L.laneRefreshIndex(true);
  row('probe returns a non-integer numTxs', L, false, true);
  eq('non-integer: ranges unchanged', L.saved[CT].ranges, before);
}

{
  const L = makeLane({
    probe: (id) => {
      if (id === PB) throw new Error('partial');
      return { numTxs: 9000, txs: [] };
    },
  });
  L.setSaved({ [CT]: prefix(9000), [PB]: prefix(18000) });
  L.setScope([CT, PB]);
  const beforePb = JSON.parse(JSON.stringify(L.saved[PB].ranges));
  await L.laneRefreshIndex(true);
  row('one of two protocols throws (partial)', L, false, true);
  eq('partial: failed protocol ranges unchanged', L.saved[PB].ranges, beforePb);
}

{
  const L = makeLane({
    probe: () => ({ numTxs: 9000, txs: [] }),
  });
  await L.laneRefreshIndex(true);
  row('probe succeeds, index unchanged', L, true, false);
}

{
  const L = makeLane({
    probe: () => ({ numTxs: 9120, txs: [] }),
  });
  const before = JSON.parse(JSON.stringify(L.saved[CT].ranges));
  await L.laneRefreshIndex(true);
  row('probe succeeds, index grew', L, true, false);
  ok('grew: ranges shifted (prefix no longer claims page 0 alone as before)',
     JSON.stringify(L.saved[CT].ranges) !== JSON.stringify(before));
  ok('grew: prefix start moved forward', L.saved[CT].ranges[0][0] > 0);
}

{
  const L = makeLane({
    probe: () => { throw new Error('must not be called'); },
  });
  L.setSaved({ [CT]: prefix(9000, [[3, 8, TS, TS + 86400]]) });
  await L.laneRefreshIndex(true);
  row('nothing to probe (no page-0 prefix)', L, true, false);
  ok('no page-0: chronik was not asked', L.probes() === 0);
}

{
  const L = makeLane({
    probe: () => { throw new Error('must not be called'); },
  });
  L.setSaved({ [CT]: prefix('9000') });
  await L.laneRefreshIndex(true);
  row('nothing to probe (numTxs not an integer on the cursor)', L, true, false);
  ok('non-integer cursor: chronik was not asked', L.probes() === 0);
}

{
  const L = makeLane({
    probe: () => { throw new Error('offline'); },
  });
  await L.laneRefreshIndex(true);
  ok('pre-clear: a failed probe left the prefix unverified', L.verified === 0);
  L.laneClearData();
  row('after laneClearData', L, true, false);
}

// ---------------------------------------------------------- once-per-session
console.log('\n-- once-per-session budget after a failed probe --');
{
  const L = makeLane({
    probe: () => { throw new Error('offline'); },
  });
  await L.laneRefreshIndex(true);
  const afterFail = L.probes();
  ok('first failed probe spent exactly one request', afterFail === 1);
  ok('after failure the budget bit is set', L.spent > 0);
  ok('after failure the honesty bit is unset', L.verified === 0);
  ok('qualifier still shown after the failed probe', qualifier(L) === true);
  L.maybeAutoRefresh();
  await Promise.resolve();
  ok('maybeAutoRefresh does not fire a second probe after failure',
     L.probes() === afterFail,
     `probes ${L.probes()} after ${afterFail}`);
  // If the two jobs still shared one variable, either the qualifier would
  // already be hidden (assignment kept, honesty silenced) or this second
  // call would have issued another request (assignment withheld). Both
  // being true at once is the whole reason for the split.
  ok('split is load-bearing: spent AND unverified at once',
     L.spent > 0 && L.verified === 0 && qualifier(L) === true && L.probes() === afterFail);
}

console.log('\n-- scenario table --');
for (const r of results) {
  console.log(`  ${r.ok ? 'ok' : 'FAIL'}  ${r.scenario}  verified=${r.verified}  qualifier=${r.qualifier}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
