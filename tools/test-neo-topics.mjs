// Harness for neo's Topics engine — the parts that decide what is honest.
//   node tools/test-neo-topics.mjs
//
// Extracts the SHIPPED bodies from index.html and drives them. The rules under
// test are all rules the two doors must agree on, so a copy would only prove
// the copy: a follow restoring OFF, one definition of searchable text, and a
// live arrival being INGESTED rather than appended.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { matchAny, matchEvery, findAllSpans, findHashtags } from '../vendor/core/match.js';
import { LOKAD, LOKAD_NAMES } from '../vendor/txparse.js';
// The probe uses the REAL cursor arithmetic. Re-stating shiftRangesForGrowth
// here would be testing this file's idea of the shift, not the shipped one.
import { scopeCursorView, shiftRangesForGrowth } from '../vendor/core/lane-cursor.js';
import {
  laneReach, laneWindows, rangeActive, inScope, inRange, dayStart,
} from '../vendor/core/lane-cursor.js';
import { createCorpus } from '../vendor/core/lane-corpus.js';
import { createResultStore } from '../vendor/core/result-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];

/** Balanced-brace lift, keeping a leading `async` (the trap that makes `await`
 *  a syntax error and hides it inside the function's own try/catch). */
function grab(name) {
  const at = mod.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('not found in index.html: ' + name);
  const start = (at >= 6 && mod.slice(at - 6, at) === 'async ') ? at - 6 : at;
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

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------- sandbox
const KEY = 'ecashlive:flow:filters';
function sandbox(stored) {
  const ls = new Map();
  if (stored !== undefined) ls.set(KEY, JSON.stringify(stored));
  const localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
  };
  const src = [
    "const TOPICS_TERMS_KEY = " + JSON.stringify(KEY) + ";",
    // The loader caps on load, as Flow's does. This sandbox predates that and
    // broke the moment the dependency appeared -- which is the extraction
    // working: a function that grew a dependency cannot quietly keep passing.
    "const TOPICS_TERM_MAX = 8;",
    "const LOKAD = { CASHTAB_MSG: '00746162' };",
    "let topicTerms = [], topicMode = 'any', topicScope = [LOKAD.CASHTAB_MSG];",
    // The scrub the page uses. Zero-width and bidi marks are the reason .text
    // has to be cleaned at all.
    "const cleanChainText = (s) => String(s == null ? '' : s).replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g, '');",
    "let parseOpReturnResult = null;",
    "function parseOpReturn(){ return parseOpReturnResult; }",
    "let corpusAdds = [], heldTxs = [], rematched = 0;",
    "let topicsCoreReady = true;",
    "const tpCorpus = { add: (...a) => corpusAdds.push(a), get: () => null, size: 0, full: false };",
    "const tpResults = { hold: (tx) => heldTxs.push(tx), get: () => null, matched: [], matchedTotal: 0 };",
    "function topicsEngineReady(){ return topicsCoreReady; }",
    "function topicsRematch(){ rematched++; }",
    "const topicsCore = { matchAny: (h, ts) => ts.some(t => h.toLowerCase().includes(t.q.toLowerCase())),",
    "                     matchEvery: (h, ts) => ts.every(t => h.toLowerCase().includes(t.q.toLowerCase())) };",
    grab('loadTopicSettings'),
    grab('saveTopicSettings'),
    grab('topicsHay'),
    grab('topicMatchText'),
    grab('topicsIngestLive'),
    "const topicFollows = () => topicTerms.filter(t => t.on && !t.mute);",
    "const topicMutes   = () => topicTerms.filter(t => t.mute);",
    "return { loadTopicSettings, saveTopicSettings, topicsHay, topicMatchText, topicsIngestLive,",
    "  get terms(){ return topicTerms; }, get mode(){ return topicMode; }, get scope(){ return topicScope; },",
    "  setTerms(t){ topicTerms = t; }, setMode(m){ topicMode = m; },",
    "  setParse(v){ parseOpReturnResult = v; }, setReady(v){ topicsCoreReady = v; },",
    "  get corpusAdds(){ return corpusAdds; }, get held(){ return heldTxs; }, get rematched(){ return rematched; },",
    "  raw: () => localStorage.getItem(" + JSON.stringify(KEY) + ") };",
  ].join('\n');
  return new Function('localStorage', src)(localStorage);
}

// ---------------------------------------------------------- E1: settings
console.log('\n-- E1: the settings are shared, and restore asymmetrically --');
{
  const S = sandbox({ mode: 'all', scope: ['00746162'], terms: [
    { q: 'gm', on: true, mode: 'word', fold: true, mute: false },
    { q: 'casino', on: true, mode: 'word', fold: false, mute: true },
    { q: 'off', on: false, mode: 'contains', fold: false, mute: true },
  ]});
  S.loadTopicSettings();
  // A FOLLOW COMES BACK OFF: an action must not look taken when it was not.
  eq('a stored follow restores OFF', S.terms.find(t => t.q === 'gm').on, false);
  // A MUTE COMES BACK ON: a standing defence must not lapse because a tab closed.
  eq('a stored mute restores ON', S.terms.find(t => t.q === 'casino').on, true);
  eq('a mute explicitly off stays off', S.terms.find(t => t.q === 'off').on, false);
  eq('mode is read from the shared value', S.mode, 'all');
  eq('scope is read from the shared value', S.scope, ['00746162']);
  eq('term shape is normalised', S.terms[2].mode, 'contains');
}
{
  const S = sandbox();                    // nothing stored at all
  S.loadTopicSettings();
  eq('no stored value -> no terms', S.terms, []);
  eq('no stored value -> Cashtab scope', S.scope, ['00746162']);
  eq('no stored value -> any mode', S.mode, 'any');
}
{
  const S = sandbox({ mode: 'nonsense', scope: [], terms: [{ q: '' }, null, { nope: 1 }] });
  S.loadTopicSettings();
  eq('junk terms are dropped', S.terms, []);
  eq('an empty scope falls back rather than searching nothing', S.scope, ['00746162']);
  eq('an unknown mode falls back to any', S.mode, 'any');
}
{
  // Writing must not invent a key of its own — decision 14, and the reason the
  // approved ecash-live:topics:v1 was never created.
  const S = sandbox({ mode: 'any', scope: ['00746162'], terms: [] });
  S.loadTopicSettings();
  S.setTerms([{ q: 'x', on: true, mode: 'word', fold: false, mute: false }]);
  S.saveTopicSettings();
  const back = JSON.parse(S.raw());
  ok('saves back into the SHARED value', !!back && Array.isArray(back.terms) && back.terms[0].q === 'x');
  eq('and keeps mode and scope with it', [back.mode, back.scope], ['any', ['00746162']]);
}

// ------------------------------------------------------------- E2: the hay
console.log('\n-- E2: one definition of searchable text --');
{
  const S = sandbox({});
  S.setParse({ text: 'hello world' });
  eq('a non-OP_RETURN first output is not text',
     S.topicsHay({ outputs: [{ outputScript: '76a914dead88ac' }] }), null);
  eq('no outputs at all', S.topicsHay({}), null);
  S.setParse(null);
  eq('a script the parser cannot read', S.topicsHay({ outputs: [{ outputScript: '6a00' }] }), null);
  S.setParse({ text: '' });
  eq('an empty text is not a haystack', S.topicsHay({ outputs: [{ outputScript: '6a00' }] }), null);

  S.setParse({ text: 'gm​everyone' });
  const scrubbed = S.topicsHay({ outputs: [{ outputScript: '6a00' }], timeFirstSeen: 5 });
  eq('a zero-width char is scrubbed out of the haystack', scrubbed.hay, 'gmeveryone');
  eq('first-seen becomes ms', scrubbed.ts, 5000);

  S.setParse({ text: 'ok' });
  eq('a block timestamp wins over first-seen',
     S.topicsHay({ outputs: [{ outputScript: '6a00' }], block: { timestamp: 9 }, timeFirstSeen: 5 }).ts, 9000);
  eq('neither known -> no date claimed',
     S.topicsHay({ outputs: [{ outputScript: '6a00' }], timeFirstSeen: 0 }).ts, null);

  // outputs[0] ONLY. A known shortcut on a door, measured at 0/350 on lokad
  // pages, and Flow has the same one. Pinned so it stays a decision.
  S.setParse({ text: 'second' });
  eq('only the first output is read',
     S.topicsHay({ outputs: [{ outputScript: '76a914aa88ac' }, { outputScript: '6a00' }] }), null);
}

// --------------------------------------------------------- matching rules
console.log('\n-- matching: mode, and a mute outranking a follow --');
{
  const S = sandbox({});
  S.setTerms([{ q: 'gm', on: true, mute: false }, { q: 'ship', on: true, mute: false }]);
  S.setMode('any');
  ok('any: one word is enough', S.topicMatchText('gm everyone'));
  S.setMode('all');
  ok('all: one word is not enough', !S.topicMatchText('gm everyone'));
  ok('all: both words match', S.topicMatchText('gm we ship today'));
  S.setMode('any');
  S.setTerms([{ q: 'gm', on: true, mute: false }, { q: 'casino', on: true, mute: true }]);
  ok('a mute vetoes a follow that also matched', !S.topicMatchText('gm from the casino'));
  ok('and leaves an unmuted match alone', S.topicMatchText('gm everyone'));
  S.setTerms([{ q: 'gm', on: false, mute: false }]);
  ok('a follow that is off matches nothing', !S.topicMatchText('gm everyone'));
  S.setTerms([]);
  ok('no follows -> no match, rather than everything', !S.topicMatchText('anything'));
}

// ------------------------------------------------- E7: ingest, not append
console.log('\n-- E7: a live arrival is INGESTED, never appended --');
{
  const S = sandbox({});
  S.setTerms([{ q: 'gm', on: true, mute: false }]);
  S.topicsIngestLive({ id: 't1', message: { text: 'gm everyone' }, firstSeen: 1000 });
  eq('the corpus gets the row', S.corpusAdds.map(a => a[0]), ['t1']);
  ok('a match is also held for rendering', S.held.length === 1);
  ok('and the answer is rebuilt rather than pushed to', S.rematched === 1);

  // A NON-match still enters the corpus: a corpus that keeps only today's hits
  // is blind to tomorrow's term, which is the bug the corpus was created for.
  S.topicsIngestLive({ id: 't2', message: { text: 'nothing here' }, firstSeen: 1000 });
  eq('a non-match is still cached', S.corpusAdds.map(a => a[0]), ['t1', 't2']);
  ok('but is not held', S.held.length === 1);

  S.topicsIngestLive({ id: 't3', message: {}, firstSeen: 1 });
  eq('a message with no text is skipped entirely', S.corpusAdds.length, 2);
  S.topicsIngestLive({ message: { text: 'gm' } });
  eq('an id-less tx is skipped', S.corpusAdds.length, 2);

  // The scrub applies on the live side too, or the doors disagree on the bytes.
  S.topicsIngestLive({ id: 't4', message: { text: 'g​m here' }, firstSeen: 1 });
  eq('live text is scrubbed the same way', S.corpusAdds[2][1], 'gm here');

  S.setReady(false);
  S.topicsIngestLive({ id: 't5', message: { text: 'gm' }, firstSeen: 1 });
  eq('nothing is ingested before the engine exists', S.corpusAdds.length, 3);
}

// ------------------------------------------------- E4/E5: structure, and the
// cross-door equalities decision 14 depends on. These are source assertions:
// they cannot prove the walk works, but they are what notices a defence being
// dropped in a later edit, which no behavioural test of a green build would.
console.log('\n-- E4: the walk keeps its six defences --');
{
  const run = grab('runTopicsBackfill');
  ok('the walk is async', /^async function runTopicsBackfill\(/.test(run));
  const guard = run.indexOf("typeof chronik.lokadId !== 'function'");
  const ctor  = run.indexOf('createBackfill');
  ok('the chronik guard sits BEFORE createBackfill', guard !== -1 && ctor !== -1 && guard < ctor);
  ok('requests are gated on the pane being open, inside the walk',
     /dataset\.topics\s*!==\s*'open'/.test(run));
  ok('an AbortController is created', /new AbortController\s*\(/.test(run));
  ok('and its signal reaches run()', /signal:\s*tpAbort\.signal/.test(run));
  ok('a superseded run refuses to write', /token !== tpRunToken/.test(run));
  const save = run.indexOf('topicsSaveStore()'), cat = run.search(/catch\s*\(/);
  ok('the store is written even when run() throws', save !== -1 && cat !== -1 && save > cat);
  ok('the prefilter ingests every text, not only matches',
     /prefilter:/.test(run) && /tpCorpus\.add\(/.test(run));
  ok('a real parse is supplied', /parse:\s*\(/.test(run));
}

console.log('\n-- E5: the cache is shared, and the two doors must not drift --');
{
  const flow = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
  const neoMax  = Number(mod.match(/const TOPICS_CORPUS_MAX\s*=\s*(\d+)/)[1]);
  const flowMax = Number(flow.match(/const CORPUS_MAX\s*=\s*(\d+)/)[1]);
  eq('neo CORPUS_MAX is 5000', neoMax, 5000);
  // A smaller cap on either door silently recreates the founding bug: the
  // corpus loads without clearing, keeps the newest N, then persists that
  // truncated view beside the OTHER door's full cursor.
  eq('and equals Flow, or the shared cache is corrupted by whoever saves next', neoMax, flowMax);
  const neoKey  = mod.match(/const TOPICS_CURSOR_KEY\s*=\s*'([^']+)'/)[1];
  const flowKey = flow.match(/const LANE_CURSOR_KEY\s*=\s*'([^']+)'/)[1];
  eq('neo writes the shared cursor key', neoKey, 'ecashlive:flow:lane-cursor');
  eq('and it is the key Flow writes', neoKey, flowKey);
  const neoTerms  = mod.match(/const TOPICS_TERMS_KEY\s*=\s*'([^']+)'/)[1];
  const flowTerms = flow.match(/const TERMS_KEY\s*=\s*'([^']+)'/)[1];
  eq('settings are the shared value too', neoTerms, flowTerms);
  // Decision 14 superseded the key approved a day earlier. It must not exist.
  ok('no neo-only Topics key was created', !/ecash-live:topics/.test(mod));
  const build = grab('buildTopicsEngine');
  ok('createCorpus is given the cap', /createCorpus\(\s*\{\s*max:\s*TOPICS_CORPUS_MAX/.test(build));
  ok('createLaneStore is given it as well', /createLaneStore\([\s\S]*?max:\s*TOPICS_CORPUS_MAX/.test(build));
}

// ---------------------------------------------------------------- coverage
// Drive the SHIPPED topicsCoverage / topicsRematch / runTopicsBackfill bodies.
// A test of a restated copy would stay green while the page went quiet.

function objectText(src, name, open = '{') {
  const close = open === '{' ? '}' : ']';
  const at = src.indexOf('const ' + name + ' = ' + open);
  if (at === -1) throw new Error('not found: ' + name);
  let i = src.indexOf(open, at), d = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) { if (src[i] === '\\') i++; else if (src[i] === q) break; }
      continue;
    }
    if (c === open) d++;
    else if (c === close) { d--; if (!d) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
function objectOf(src, name) {
  const txt = objectText(src, name).replace(/^const\s+\w+\s*=\s*/, '');
  return new Function('return (' + txt + ');')();
}

const TOPICS_EN = Object.assign(
  {},
  objectOf(mod, 'TOPICS_EN_BORROWED'),
  objectOf(mod, 'TOPICS_EN_OWN'),
);
const CT = LOKAD.CASHTAB_MSG, PB = LOKAD.PAYBUTTON, EC = LOKAD.ECASHCHAT_TX;
const WINDOWS_SHOWN = Number(mod.match(/const WINDOWS_SHOWN\s*=\s*(\d+)/)[1]);
const secOf = (iso) => dayStart(iso) / 1000;
const rowText = (r) => (typeof r === 'string' ? r : r.warn);
const partsOf = (key) => TOPICS_EN[key].split(/\{[^}]+\}/).filter(Boolean);
const has = (rows, key) => rows.some((r) => partsOf(key).every((p) => rowText(r).includes(p)));
const textOf = (rows, key) => {
  const parts = partsOf(key);
  const row = rows.find((r) => parts.every((p) => rowText(r).includes(p)));
  return row == null ? null : rowText(row);
};

function coverageOf(opts = {}) {
  const txs = opts.txs instanceof Map ? opts.txs : new Map(opts.txs || []);
  const matched = opts.matched || [];
  const hold = opts.hold || {};
  const corpusHas = opts.corpusHas instanceof Set ? opts.corpusHas : new Set(opts.corpusHas || []);
  const src = [
    'const TOPICS_EN = ' + JSON.stringify(TOPICS_EN) + ';',
    'let topicsPack = null, topicsOverlay = null;',
    grab('topicsT'),
    grab('topicsTf'),
    grab('topicsIsoDay'),
    'function topicsEngineReady(){ return ready; }',
    'const topicsCore = { laneReach, laneWindows, rangeActive };',
    'let topicScope = scope;',
    'let topicRange = range;',
    'let tpSavedCursor = saved;',
    'let tpBf = live ? { cursor: live } : null;',
    'let tpDeepDone = !!deepDone, tpHoles = holes, tpTrimmed = trimmed;',
    'let tpUnread = unread, tpScopeHidden = scopeHidden, tpNoDate = noDate;',
    'let topicPrefixVerifiedAt = verified;',
    'const WINDOWS_SHOWN = shown;',
    'const LOKAD_NAMES = names;',
    'function topicsScopeLabel(){ return "Cashtab Msg"; }',
    'const tpCorpus = { size: corpusSize, full: !!corpusFull, has: (id) => corpusHas.has(id) };',
    'const tpResults = { matched, matchedTotal, get: (id) => hold[id] || null };',
    'const state = { txs };',
    grab('topicsCoverage'),
    'return topicsCoverage();',
  ].join('\n');
  return new Function(
    'ready', 'laneReach', 'laneWindows', 'rangeActive',
    'scope', 'range', 'saved', 'live',
    'deepDone', 'holes', 'trimmed', 'unread', 'scopeHidden', 'noDate', 'verified',
    'shown', 'names', 'corpusSize', 'corpusFull', 'corpusHas',
    'matched', 'matchedTotal', 'hold', 'txs',
    src,
  )(
    opts.ready !== false, laneReach, laneWindows, rangeActive,
    opts.scope || [CT], opts.range || { from: null, to: null },
    opts.saved || null, opts.live || null,
    !!opts.deepDone, opts.holes || 0, opts.trimmed || 0,
    opts.unread || 0, opts.scopeHidden || 0, opts.noDate || 0,
    // Default VERIFIED, so every existing coverage case keeps meaning what it
    // meant. A test that has to opt out of a qualifier is a test that would
    // silently start asserting the qualifier's absence.
    opts.verified === undefined ? 1 : opts.verified,
    WINDOWS_SHOWN, LOKAD_NAMES, opts.corpusSize || 0, !!opts.corpusFull, corpusHas,
    matched, opts.matchedTotal != null ? opts.matchedTotal : matched.length, hold, txs,
  );
}

function rematchOf(opts = {}) {
  const corpus = createCorpus({ max: 50 });
  for (const row of (opts.corpus || [])) corpus.add(row[0], row[1], row[2], row[3], null);
  const results = createResultStore({
    max: 50,
    tsOf: (id, tx) => (tx && (tx.ts || 0)) || (corpus.get(id) && corpus.get(id).ts) || 0,
    wanted: () => true,
    order: 'newest-first',
  });
  for (const tx of (opts.held || [])) results.hold(tx);
  const src = [
    'let topicTerms = terms, topicMode = mode, topicScope = scope, topicRange = range;',
    'const topicFollows = () => topicTerms.filter(t => t.on && !t.mute);',
    'const topicMutes   = () => topicTerms.filter(t => t.mute);',
    'function topicsEngineReady(){ return true; }',
    'const topicsCore = { matchAny, matchEvery, inScope, inRange };',
    'const tpCorpus = corpus, tpResults = results;',
    'let tpScopeHidden = 0, tpNoDate = 0;',
    'function renderTopics(){}',
    grab('topicMatchText'),
    grab('topicTxMatches'),
    grab('topicTsOf'),
    grab('topicsRematch'),
    'topicsRematch();',
    'return { hidden: tpScopeHidden, noDate: tpNoDate, matched: tpResults.matched.slice() };',
  ].join('\n');
  return new Function(
    'terms', 'mode', 'scope', 'range',
    'matchAny', 'matchEvery', 'inScope', 'inRange',
    'corpus', 'results',
    src,
  )(
    opts.terms || [{ q: 'gm', on: true, mute: false, mode: 'contains', fold: false }],
    opts.mode || 'any',
    opts.scope || [CT],
    opts.range || { from: null, to: null },
    matchAny, matchEvery, inScope, inRange,
    corpus, results,
  );
}

async function unreadOf(opts = {}) {
  const internal = JSON.parse(JSON.stringify(opts.cursor));
  const src = [
    'function topicsEngineReady(){ return true; }',
    'let tpBusy = false, tpDeepDone = false, tpRunToken = 1, tpAbort = null;',
    'let tpHoles = 0, tpUnread = 0, tpSavedCursor = null, tpRangeDone = false;',
    // The walk now decides "window covered" too, so the driver owes it a window
    // and a rangeActive. Default: no window, so rangeDone can never be claimed
    // and every existing unread case keeps meaning what it meant.
    'const topicRange = range;',
    'const topicFollows = () => [{ q: "gm", on: true }];',
    'const topicScope = scope;',
    'function $(id){ return { dataset: { topics: "open" } }; }',
    'const chronik = { lokadId(){} };',
    'const topicsCore = { rangeActive: (r) => !!(r && (r.from != null || r.to != null)) };',
    'const TOPICS_REQUESTS = 6;',
    'function renderTopics(){}',
    'function topicsSaveStore(){}',
    'function topicsRematch(){}',
    'const tpBf = bf;',
    grab('runTopicsBackfill'),
    'return (async () => { await runTopicsBackfill(); return { unread: tpUnread, holes: tpHoles, rangeDone: tpRangeDone }; })();',
  ].join('\n');
  return new Function('scope', 'bf', 'range', src)(opts.scope || [CT], {
    get cursor() { return JSON.parse(JSON.stringify(internal)); },
    async run() {
      if (opts.mutate) opts.mutate(internal);
      return opts.cov(internal);
    },
  }, opts.range || { from: null, to: null });
}

console.log('\n-- coverage: shipped topicsCoverage, same conditions as Flow --');
{
  eq('WINDOWS_SHOWN is Flow\'s bound', WINDOWS_SHOWN, 3);
  const empty = coverageOf();
  /* lane.scanned is UNCONDITIONAL, as on Flow (`const cov = [tf('lane.scanned',
     ...)]`), so a fresh pane opens by saying it has searched nothing rather
     than by saying nothing. It is also the denominator noText needs: without
     it, neo -- whose feed holds every payment -- opened with "1,240 carried no
     text to search" as the first and largest number on the line. */
  eq('a fresh pane states the session figure and the two always-on caveats',
     empty, ['searched 0 transactions from this session',
             TOPICS_EN['lane.liveNote'], TOPICS_EN['lane.notIndexed']]);
  eq('engine not ready -> nothing claimed', coverageOf({ ready: false }), []);
}
{
  const txs = new Map([
    ['a', { id: 'a', _hay: 'gm' }],
    ['b', { id: 'b', _hay: null }],
    ['c', { id: 'c' }],
  ]);
  const rows = coverageOf({ txs });
  eq('noText counts missing _hay, not non-matches',
     textOf(rows, 'lane.noText'), '2 carried no text to search');
  const later = new Map(txs); later.set('d', { id: 'd' });
  eq('noText is recomputed, not latched',
     textOf(coverageOf({ txs: later }), 'lane.noText'), '3 carried no text to search');
  ok('all-text session emits no noText sentence',
     !has(coverageOf({ txs: new Map([['a', { _hay: 'x' }]]) }), 'lane.noText'));
}
{
  const rows = coverageOf({
    matched: ['live', 'held', 'pending', 'gone'],
    hold: { held: { id: 'held', _hay: 'gm' } },
    corpusHas: ['pending'],
    txs: new Map([['live', { id: 'live', _hay: 'gm' }]]),
  });
  eq('aged counts only matches that left memory AND the corpus',
     textOf(rows, 'lane.aged'), '1 older matches have left memory');
  ok('a pending corpus hit is not aged', !has(coverageOf({
    matched: ['pending'], corpusHas: ['pending'],
  }), 'lane.aged'));
  ok('a live or held match is not aged', !has(coverageOf({
    matched: ['live', 'held'],
    hold: { held: { id: 'held' } },
    txs: new Map([['live', { id: 'live' }]]),
  }), 'lane.aged'));
}
{
  eq('unread sentence uses the latched count',
     textOf(coverageOf({ unread: 2 }), 'lane.unread'),
     '2 protocols could not be read — coverage is not stated for them');
  ok('unread 0 is silent', !has(coverageOf({ unread: 0 }), 'lane.unread'));
}
{
  eq('scopeHidden sentence uses the latched Set size',
     textOf(coverageOf({ scopeHidden: 3 }), 'lane.scopeHidden'),
     '3 saved matches come from protocols you are not searching — tick them above to see them again');
  ok('scopeHidden 0 is silent', !has(coverageOf({ scopeHidden: 0 }), 'lane.scopeHidden'));
}
{
  const reachDay = '2026-05-12';
  const saved = { [CT]: { ranges: [[0, 6, secOf(reachDay), secOf('2026-08-12')]], oldestTs: secOf(reachDay), done: false } };
  const win = { from: dayStart('2022-06-01'), to: dayStart('2022-06-30') };
  const rows = coverageOf({ saved, range: win, noDate: 4 });
  ok('window sentence is present', has(rows, 'lane.window'));
  eq('noDate rides next to the window',
     textOf(rows, 'lane.noDate'), '4 matches carry no date and fall outside it');
  eq('windowBeyond fires when the window starts before the prefix',
     textOf(rows, 'lane.windowBeyond'),
     'your window starts before what has been searched — search further back to reach it');
  ok('noDate is silent without a window',
     !has(coverageOf({ saved, noDate: 4 }), 'lane.noDate'));
  ok('windowBeyond is silent when the window is inside the prefix',
     !has(coverageOf({ saved, range: { from: dayStart('2026-06-01'), to: null } }), 'lane.windowBeyond'));
  ok('windowBeyond is silent without a prefix to compare',
     !has(coverageOf({ range: win }), 'lane.windowBeyond'));
}
{
  // A 2022 seek must NOT move the reach date. laneReach reads only ranges[0].
  const prefixTs = secOf('2026-05-12');
  const seekA = [20, 22, secOf('2022-06-01'), secOf('2022-07-11')];
  const seekB = [40, 42, secOf('2023-01-01'), secOf('2023-02-01')];
  const seekC = [60, 62, secOf('2024-03-01'), secOf('2024-04-01')];
  const seekD = [80, 82, secOf('2021-01-01'), secOf('2021-02-01')];
  const saved = { [CT]: {
    ranges: [[0, 6, prefixTs, secOf('2026-08-12')], seekA, seekB, seekC, seekD],
    oldestTs: secOf('2021-01-01'), done: false,
  } };
  const rows = coverageOf({ saved });
  const reach = textOf(rows, 'lane.reach');
  ok('reach names the PREFIX date, not the 2021 seek',
     !!reach && reach.includes('2026-05-12') && !reach.includes('2021'));
  const plus = rows.filter((r) => typeof r === 'string' && r.startsWith('plus '));
  eq('plusWindow shows the first WINDOWS_SHOWN seek runs', plus.length, WINDOWS_SHOWN);
  eq('plusWindow is oldest-first after laneWindows merge/sort, not insertion order',
     plus[0], 'plus 2021-01-01 → 2021-02-01');
  eq('the 2022 seek is still named (it is not the prefix)',
     plus[1], 'plus 2022-06-01 → 2022-07-11');
  eq('moreWindows counts the remainder, does not drop it',
     textOf(rows, 'lane.moreWindows'), 'and 1 more windows read');
  ok('the prefix itself is not also printed as plusWindow',
     !plus.some((p) => p.includes('2026-05-12')));
}
{
  const saved = { [CT]: {
    ranges: [[0, 2, secOf('2026-05-12'), secOf('2026-08-12')],
             [10, 12, secOf('2022-06-01'), secOf('2022-07-01')]],
    oldestTs: secOf('2022-06-01'), done: false,
  } };
  ok('one extra window: plusWindow, no moreWindows',
     has(coverageOf({ saved }), 'lane.plusWindow')
     && !has(coverageOf({ saved }), 'lane.moreWindows'));
}

console.log('\n-- rematch: hidden and noDate are a Set of ids, not a counter --');
{
  const R = rematchOf({
    scope: [CT],
    corpus: [
      ['c1', 'gm world', 10, CT],
      ['c2', 'gm friends', 11, PB],
      ['c3', 'gm again', 12, EC],
      ['c4', 'gm legacy', 13, null],
      ['c5', 'nothing here', 14, CT],
    ],
    held: [
      { id: 'c2', _hay: 'gm friends', _lokad: PB, ts: 11 },
      { id: 'c3', _hay: 'gm again', _lokad: EC, ts: 12 },
      { id: 'c9', _hay: 'gm extra', _lokad: PB, ts: 19 },
    ],
  });
  eq('union says 3, not 5 (c2/c3 in both sources + c9 hold-only)', R.hidden, 3);
  ok('in-scope corpus hits stay in the answer (c1, untagged c4)',
     R.matched.includes('c1') && R.matched.includes('c4'));
  ok('out-of-scope hold is not in the answer', !R.matched.includes('c9'));
}
{
  const R = rematchOf({
    scope: [CT],
    range: { from: dayStart('2026-01-01'), to: dayStart('2026-12-31') },
    corpus: [
      ['dated', 'gm dated', dayStart('2026-06-01'), CT],
      ['undated', 'gm none', null, CT],
    ],
    held: [
      { id: 'held-none', _hay: 'gm held', _lokad: CT, ts: null },
    ],
  });
  // corpus undated + hold undated. Same id would collapse; these are distinct.
  eq('noDate counts undated corpus + undated hold', R.noDate, 2);
  ok('dated in-window match stays in the answer', R.matched.includes('dated'));
  ok('undated match is excluded from the answer',
     !R.matched.includes('undated') && !R.matched.includes('held-none'));
}
{
  const R = rematchOf({
    scope: [CT],
    range: { from: dayStart('2026-01-01'), to: null },
    corpus: [['undated', 'gm none', null, CT]],
    held: [{ id: 'undated', _hay: 'gm none', _lokad: CT, ts: null }],
  });
  eq('the same undated id in corpus AND hold counts once', R.noDate, 1);
}

console.log('\n-- unread: the (a)/(b) rule, driven through runTopicsBackfill --');
{
  const b = await unreadOf({
    cursor: { [CT]: { pos: 0, pagesDone: 0, oldestTs: null, done: false } },
    mutate: (c) => { c[CT].pos = 3; },
    cov: (c) => ({ holeCount: 3, done: false, perLokad: { [CT]: { ...c[CT] } } }),
  });
  eq('(b) tried this run, still nothing: counts', b.unread, 1);
}
{
  const a = await unreadOf({
    cursor: { [CT]: { pos: 1, pagesDone: 1, oldestTs: 1_700_000_000, done: false } },
    mutate: (c) => { c[CT].pos = 2; },
    cov: (c) => ({ holeCount: 1, done: false, perLokad: { [CT]: { ...c[CT], pagesDone: 1 } } }),
  });
  eq('(a) pos moved, pagesDone did not: counts', a.unread, 1);
}
{
  const d = await unreadOf({
    cursor: { [CT]: { pos: 5, pagesDone: 5, oldestTs: 1, done: true } },
    cov: (c) => ({ holeCount: 0, done: true, perLokad: { [CT]: { ...c[CT] } } }),
  });
  eq('a done protocol is never unread', d.unread, 0);
}
{
  const r = await unreadOf({
    cursor: { [CT]: { pos: 6, pagesDone: 6, oldestTs: 1, done: false } },
    cov: (c) => ({ holeCount: 0, done: false, perLokad: { [CT]: { ...c[CT] } } }),
  });
  eq('returning reader, nothing moved this run: 0 not 1', r.unread, 0);
}

console.log('\n-- coverage source: the shipped body names every sentence --');
{
  const cov = grab('topicsCoverage');
  const rem = grab('topicsRematch');
  const run = grab('runTopicsBackfill');
  for (const k of [
    'lane.noText', 'lane.aged', 'lane.unread', 'lane.scopeHidden',
    'lane.noDate', 'lane.windowBeyond', 'lane.plusWindow', 'lane.moreWindows',
  ]) {
    ok('topicsCoverage asks for ' + k, cov.includes("'" + k + "'"));
  }
  ok('rematch unions cm.hidden (a Set)', /const hidden = cm\.hidden/.test(rem));
  ok('rematch unions cm.noDate (a Set)', /const noDate = cm\.noDate/.test(rem));
  ok('rematch stores Set size, not a counter',
     /tpScopeHidden = hidden\.size/.test(rem) && /tpNoDate = noDate\.size/.test(rem));
  ok('rematch does not increment a hidden counter', !/\+\+\s*$|hidden\+\+/.test(rem));
  const beforeAt = run.indexOf('const before = tpBf.cursor');
  const runAt = run.indexOf('tpBf.run(');
  ok('unread snapshots the cloned cursor BEFORE run()',
     beforeAt !== -1 && runAt !== -1 && beforeAt < runAt);
  ok('topicsCoverage calls C.laneWindows, not an invented name',
     /C\.laneWindows\s*\(/.test(cov));
  ok('topicsCoverage does not invent fmtDate / fmtInt',
     !/\bfmtDate\b/.test(cov) && !/\bfmtInt\b/.test(cov));
  ok('laneWindows is fed the merged cursor, same object as laneReach',
     /const cur = Object\.assign/.test(cov)
     && /C\.laneReach\(\s*cur/.test(cov)
     && /C\.laneWindows\(\s*cur/.test(cov));
}

console.log('\n-- E9: the Feed keeps its own window --');
{
  ok('MAX_MSG_VISIBLE is untouched at 100', /const MAX_MSG_VISIBLE = 100;/.test(mod));
  const addCard = grab('addMessageCard');
  const ingest = addCard.indexOf('topicsIngestLive');
  const reject = addCard.indexOf('MAX_MSG_VISIBLE');
  ok('Topics ingests before the Feed window decides anything',
     ingest !== -1 && reject !== -1 && ingest < reject);
  const core = readFileSync(join(ROOT, 'vendor/core/backfill.js'), 'utf8');
  ok('vendor/core was not patched to make this fit', !/topics/i.test(core));
}

// ===========================================================================
// THE FRESHNESS PROBE. Two facts that look like one, and the whole point of
// this block is that the shipped code keeps them apart. Flow shipped them as a
// single variable for two releases; the qualifier it added in v2.7.0 could
// therefore never appear, and the ledger entry for v2.8.2 is explicit that the
// obvious fix reintroduces a different bug. These drive the shipped bodies.
// ===========================================================================
console.log('\n-- the freshness probe --');
{
  // The qualifier reads the honesty bit, not the budget.
  const withReach = { saved: { [CT]: { ranges: [[0, 6, 1770000000, 1780000000]], numTxs: 300, numPages: 6 } } };
  const verified = coverageOf(Object.assign({ verified: 1 }, withReach));
  const unver = coverageOf(Object.assign({ verified: 0 }, withReach));
  ok('a verified prefix states its date with no caveat',
     verified.some((c) => typeof c === 'string' && c.startsWith('searched'))
     && !verified.some((c) => c && c.warn === TOPICS_EN['lane.notChecked']));
  ok('an unverified prefix says so, beside the same date',
     unver.some((c) => typeof c === 'string' && c.startsWith('searched'))
     && unver.some((c) => c && c.warn === TOPICS_EN['lane.notChecked']));
  // A caveat with nothing to qualify is noise. No reach -> no qualifier, even
  // though the bit is false: this is the "first visit" case 07f3ca0 was about.
  ok('no reach means no qualifier, whatever the bit says',
     !coverageOf({ verified: 0 }).some((c) => c && c.warn === TOPICS_EN['lane.notChecked']));
  // It is a WARNING, not a plain sentence: the reach line beside it is a claim,
  // and an unmarked caveat next to a claim reads as more claim.
  ok('the qualifier renders as a warning',
     unver.filter((c) => c && c.warn === TOPICS_EN['lane.notChecked']).length === 1);
}
{
  // Source-level, because these are properties of the shipped text that no
  // input can exercise from outside the module.
  const probe = grab('topicsRefreshIndex');
  const clear = grab('topicsClearData');
  const auto = grab('maybeTopicsAutoRefresh');

  ok('the budget is spent on EVERY settled outcome',
     /topicProbeSpentAt = Date\.now\(\);/.test(probe)
     && !/if\s*\([^)]*\)\s*topicProbeSpentAt = Date\.now\(\)/.test(probe));
  ok('the honesty bit is set only when nothing failed',
     /topicPrefixVerifiedAt = \(failed === 0\) \? Date\.now\(\) : 0;/.test(probe));
  // failed === reached is sitting in the button message and looks like the same
  // test. Using it here would let a partial failure keep claiming the date.
  ok('the honesty bit does not use failed === reached',
     !/topicPrefixVerifiedAt[^;]*failed === reached/.test(probe));
  ok('the two are separate variables, not one',
     /let topicProbeSpentAt = 0, topicPrefixVerifiedAt = 0;/.test(mod));

  ok('a shrinking index is left alone', /if \(delta <= 0\) continue;/.test(probe));
  ok('only a prefix from rank 0 is repairable', /ranges\[0\]\[0\] === 0/.test(probe));
  ok('the shift moves the MERGED view, not the stored half',
     /C\.shiftRangesForGrowth\(c\.ranges, delta, TOPICS_PAGE\)/.test(probe)
     && /const cur = C\.scopeCursorView\(tpSavedCursor/.test(probe));
  ok('a growth un-finishes the protocol', /next\.done = false/.test(probe));
  ok('a growth reads the new pages straight away', /await runTopicsBackfill\(\)/.test(probe));

  ok('the auto probe is gated on the budget', /if \(topicProbeSpentAt \|\| tpRefreshBusy\) return;/.test(auto));
  ok('an empty store cannot be stale, so it is not probed', /tpCorpus\.size\) return;/.test(auto));
  ok('the pane asks for it once, on open', /maybeTopicsAutoRefresh\(\);/.test(grab('openTopics')));

  /* BOTH HALVES, and in that order. The abort stops a request already out; the
     token stops leftover work WRITING. Checking only the ordering of the abort
     passed with the token bump deleted -- found by mutation, which is the only
     reason this assertion names two things. */
  ok('clear stops the walk in flight before wiping',
     /tpRunToken\+\+;/.test(clear)
     && /tpAbort && tpAbort\.abort\(\)/.test(clear)
     && clear.indexOf('tpRunToken++') < clear.indexOf('tpCorpus.clear()')
     && clear.indexOf('tpAbort') < clear.indexOf('tpCorpus.clear()'));
  ok('clear goes through the store, not around it into localStorage',
     /tpStore\.clear\(\);/.test(clear) && !/localStorage\.removeItem/.test(clear));
  ok('clear arms itself rather than calling confirm()',
     /tpClearArmed/.test(clear) && !/\bconfirm\(/.test(clear));
  // The topics are the reader's QUESTION, not data. A button that also deleted
  // eight saved topics would be the worst kind of surprise.
  ok('clear does not touch the topics', !/topicTerms/.test(clear) && !/TOPICS_TERMS_KEY/.test(clear));
  ok('a fresh store is verified by construction, not unverified',
     /topicProbeSpentAt = Date\.now\(\); topicPrefixVerifiedAt = Date\.now\(\);/.test(clear));
  ok('clear resets every counter the coverage line reads',
     ['tpHoles', 'tpTrimmed', 'tpUnread', 'tpScopeHidden', 'tpNoDate', 'tpDeepDone']
       .every((v) => new RegExp('\\b' + v + ' = (?:0|false)').test(clear)));
}

// ===========================================================================
// DRIVE THE PROBE. Everything above about the two clocks is a property of the
// shipped TEXT; this runs the shipped BODY. The budget assertion is the one
// that proves the split is real -- after a probe that FAILED, the auto path
// must still decline the second request, measured at one probe in, one out.
// Anything less and an offline reader fires a failing probe on every open,
// which is the bug the unconditional assignment was added to stop.
// ===========================================================================
console.log('\n-- the probe, driven --');
function probeRun({ answers, saved, corpusSize = 300 }) {
  let calls = 0;
  const chronik = {
    lokadId: (id) => ({
      history: async () => {
        calls++;
        const a = answers[id];
        if (a === 'throw') throw new Error('offline');
        if (a === 'garbage') return { numTxs: 'not a number' };
        return { numTxs: a };
      },
    }),
  };
  const src = [
    'let topicProbeSpentAt = 0, topicPrefixVerifiedAt = 0;',
    'let tpRefreshBusy = false, tpRefreshMsg = null;',
    'let tpBusy = false, tpRunToken = 0, tpAbort = null;',
    'let tpSavedCursor = saved, tpBf = null, tpDeepDone = false;',
    'let tpCorpus = { size: corpusSize };',
    'const topicScope = scope;',
    'const TOPICS_PAGE = 50;',
    'const topicsCore = C;',
    'function topicsEngineReady(){ return true; }',
    'function renderTopicTools(){}',
    'function renderTopics(){}',
    'function topicsSaveStore(){}',
    'async function runTopicsBackfill(){ walked++; }',
    grab('topicsRefreshIndex'),
    grab('maybeTopicsAutoRefresh'),
    'return { topicsRefreshIndex, maybeTopicsAutoRefresh,',
    '  read: () => ({ spent: topicProbeSpentAt, verified: topicPrefixVerifiedAt,',
    '                 msg: tpRefreshMsg, cursor: tpSavedCursor }) };',
  ].join('\n');
  const box = { walked: 0 };
  const api = new Function('chronik', 'saved', 'scope', 'corpusSize', 'C', 'setTimeout', 'walked',
    'var walked = 0;\n' + src + '\n')(
    chronik, saved, Object.keys(answers), corpusSize,
    { scopeCursorView, shiftRangesForGrowth }, () => {}, 0);
  return { api, calls: () => calls, box };
}
const prefix = (numTxs, pages) => ({ ranges: [[0, pages, 1770000000, 1780000000]], numTxs, numPages: Math.ceil(numTxs / 50) });

await (async () => {
  // 1. Every probe succeeds and nothing grew -> verified, budget spent.
  {
    const { api, calls } = probeRun({ answers: { [CT]: 300 }, saved: { [CT]: prefix(300, 6) } });
    await api.topicsRefreshIndex(true);
    const r = api.read();
    ok('a clean probe verifies the prefix', r.verified > 0 && r.spent > 0);
    eq('and says it is up to date', r.msg[0], 'lane.refreshNone');
    eq('one request per walked protocol', calls(), 1);
  }
  // 2. The probe throws -> budget SPENT, prefix NOT verified.
  {
    const { api, calls } = probeRun({ answers: { [CT]: 'throw' }, saved: { [CT]: prefix(300, 6) } });
    await api.topicsRefreshIndex(true);
    const r = api.read();
    ok('a failed probe still spends the budget', r.spent > 0);
    eq('and leaves the prefix unverified', r.verified, 0);
    eq('and says it could not check', r.msg[0], 'lane.refreshFailed');
    // THE ASSERTION THE SPLIT EXISTS FOR.
    await api.maybeTopicsAutoRefresh();
    eq('the auto path declines a second request after a FAILED probe', calls(), 1);
  }
  // 3. A non-integer numTxs is a failure, not a zero.
  {
    const { api } = probeRun({ answers: { [CT]: 'garbage' }, saved: { [CT]: prefix(300, 6) } });
    await api.topicsRefreshIndex(true);
    eq('a non-integer numTxs counts as failure', api.read().verified, 0);
  }
  // 4. ANY failure withholds it, not only total failure.
  {
    const AL = '2e786563';
    const { api } = probeRun({
      answers: { [CT]: 300, [AL]: 'throw' },
      saved: { [CT]: prefix(300, 6), [AL]: prefix(100, 2) },
    });
    await api.topicsRefreshIndex(true);
    const r = api.read();
    eq('one of two failing still withholds the date', r.verified, 0);
    // ...and it is NOT reported as "could not check", because one did.
    eq('but the button does not claim total failure', r.msg[0], 'lane.refreshNone');
  }
  // 5. Growth: ranges shift, the walk is re-run, the date is still verified.
  {
    const { api, calls } = probeRun({ answers: { [CT]: 437 }, saved: { [CT]: prefix(300, 6) } });
    await api.topicsRefreshIndex(false);
    const r = api.read();
    eq('growth is announced with its size', r.msg[0], 'lane.refreshFound');
    eq('and counted exactly', r.msg[1].n, 137);
    // 137 ranks at page 50: start rounds OUTWARD, end rounds INWARD, so a
    // partially covered page is given up rather than claimed.
    const shifted = r.cursor[CT].ranges[0];
    eq('the prefix start rounds outward', shifted[0], Math.ceil(137 / 50));
    eq('the prefix end rounds inward', shifted[1], 6 + Math.floor(137 / 50));
    eq('numTxs moves to the new coordinate system', r.cursor[CT].numTxs, 437);
    ok('the protocol is un-finished', r.cursor[CT].done === false);
    ok('a successful growth is still verified', r.verified > 0);
    eq('still one request', calls(), 1);
  }
  // 6. A SHRINKING index is left alone -- a reorg cannot be described by one
  //    number, so nothing is shifted and nothing is claimed to have changed.
  {
    const { api } = probeRun({ answers: { [CT]: 250 }, saved: { [CT]: prefix(300, 6) } });
    await api.topicsRefreshIndex(true);
    const r = api.read();
    eq('a shrink is not a growth', r.msg[0], 'lane.refreshNone');
    eq('and the ranges are untouched', r.cursor[CT].ranges[0][1], 6);
    eq('as is numTxs', r.cursor[CT].numTxs, 300);
  }
  // 7. Nothing read from rank 0 -> nothing to repair, and no request spent.
  {
    const { api, calls } = probeRun({
      answers: { [CT]: 400 },
      saved: { [CT]: { ranges: [[3, 8, 1770000000, 1780000000]], numTxs: 300, numPages: 6 } },
    });
    await api.topicsRefreshIndex(true);
    eq('a seek-only cursor costs no request', calls(), 0);
    ok('and is treated as verified, having claimed no date', api.read().verified > 0);
  }
  // 8. An empty corpus is never probed at all.
  {
    const { api, calls } = probeRun({ answers: { [CT]: 400 }, saved: { [CT]: prefix(300, 6) }, corpusSize: 0 });
    await api.maybeTopicsAutoRefresh();
    eq('an empty store is not probed', calls(), 0);
  }
})();


// ===========================================================================
// ROWS: the highlight and the tappable tag. Both are properties of DOM the
// shipped builders produce, so these drive them against a minimal document
// rather than matching source.
// ===========================================================================
console.log('\n-- rows: highlight and hashtags --');
{
  // A hand-rolled document just large enough for the two builders. Building
  // this by hand rather than pulling in a DOM library keeps the suite offline
  // and dependency-free, which is what lets it run in CI at all.
  function makeDoc() {
    const TEXT = 3;
    function node(tag) {
      const n = {
        tagName: (tag || '').toUpperCase(), nodeType: 1, childNodes: [],
        className: '', dataset: {}, attrs: {}, tabIndex: undefined,
        parentNode: null,
        appendChild(c) { c.parentNode = n; n.childNodes.push(c); return c; },
        setAttribute(k, v) { n.attrs[k] = String(v); },
        replaceChild(fresh, old) {
          const i = n.childNodes.indexOf(old);
          const kids = fresh.nodeType === 11 ? fresh.childNodes : [fresh];
          for (const k of kids) k.parentNode = n;
          n.childNodes.splice(i, 1, ...kids);
        },
        set textContent(v) {
          // parentNode matters: linkifyTags replaces a text node THROUGH its
          // parent, so a double that forgets the link throws where the real
          // DOM would not. A test double's bug reads exactly like a code bug.
          n.childNodes = [text(String(v))].filter((t) => t.nodeValue !== '');
          for (const c of n.childNodes) c.parentNode = n;
        },
        get textContent() {
          return n.childNodes.map((c) => (c.nodeType === TEXT ? c.nodeValue : c.textContent)).join('');
        },
        set title(v) { n.attrs.title = String(v); },
        get title() { return n.attrs.title; },
      };
      return n;
    }
    function text(v) { return { nodeType: TEXT, nodeValue: v, parentNode: null }; }
    function frag() { const f = node(''); f.nodeType = 11; return f; }
    return {
      createElement: node, createTextNode: text, createDocumentFragment: frag,
      createTreeWalker(root) {
        const out = [];
        (function walk(n) {
          for (const c of n.childNodes) { if (c.nodeType === TEXT) out.push(c); else walk(c); }
        })(root);
        let i = 0;
        return { nextNode: () => (i < out.length ? out[i++] : null) };
      },
      NodeFilter: { SHOW_TEXT: 4 },
      node,
    };
  }
  function runRow(text, terms) {
    const doc = makeDoc();
    const src = [
      'const topicsCore = C;',
      'function topicsT(k){ return k; }',
      'function topicsTf(k, v){ return k + " " + JSON.stringify(v); }',
      grab('topicsHighlightInto'),
      grab('topicsLinkifyTags'),
      'const el = document.createElement("div");',
      'topicsHighlightInto(el, hay, terms);',
      'topicsLinkifyTags(el);',
      'return el;',
    ].join('\n');
    return new Function('C', 'document', 'NodeFilter', 'hay', 'terms', src)(
      { findAllSpans, findHashtags }, doc, doc.NodeFilter, text, terms);
  }
  const kids = (el) => el.childNodes.map((c) =>
    c.nodeType === 3 ? ['text', c.nodeValue]
      : [c.tagName === 'MARK' ? 'mark' : c.className, c.textContent]);

  eq('plain text stays one text node',
     kids(runRow('gm everyone', [])), [['text', 'gm everyone']]);
  eq('a match is marked, and only the match',
     kids(runRow('say gm now', [{ q: 'gm', on: true, mode: 'word' }])),
     [['text', 'say '], ['mark', 'gm'], ['text', ' now']]);
  // The whole reason findAllSpans is used instead of indexOf.
  eq('word mode does not mark inside a longer word',
     kids(runRow('banana', [{ q: 'an', on: true, mode: 'word' }])), [['text', 'banana']]);
  eq('a hashtag becomes a control',
     kids(runRow('gm #firma', [])), [['text', 'gm '], ['topic-tag', '#firma']]);
  eq('a#b is not a hashtag', kids(runRow('a#b', [])), [['text', 'a#b']]);
  // THE ORDER IS THE FEATURE: a tag you already follow stays a match and is not
  // offered again, because the walker never descends into a <mark>.
  eq('a followed hashtag stays a mark, not an offer',
     kids(runRow('gm #firma', [{ q: '#firma', on: true, mode: 'word' }])),
     [['text', 'gm '], ['mark', '#firma']]);
  eq('...while an unfollowed one beside it is still offered',
     kids(runRow('#firma and #xec420', [{ q: '#firma', on: true, mode: 'word' }])),
     [['mark', '#firma'], ['text', ' and '], ['topic-tag', '#xec420']]);
  {
    const el = runRow('gm #firma', []);
    const tag = el.childNodes[1];
    eq('the tag carries its own value', tag.dataset.tag, '#firma');
    eq('and an accessible name', tag.attrs['aria-label'], 'term.addTag {"q":"#firma"}');
    eq('and is reachable by keyboard', tag.tabIndex, 0);
    eq('and announces itself as a control', tag.attrs.role, 'button');
  }
  // Text never becomes markup, whatever the chain says.
  {
    const el = runRow('<img src=x onerror=alert(1)> #ok', []);
    eq('markup in chain text stays text',
       el.childNodes[0].nodeValue, '<img src=x onerror=alert(1)> ');
    eq('and the tag beside it still works', el.childNodes[1].className, 'topic-tag');
  }
  // Source-level: the handlers must be delegated, not per row.
  ok('tag activation is delegated once, not attached per row',
     !/topicRow[\s\S]{0,900}addEventListener/.test(grab('topicRow')));
  ok('the tag asks rather than adds',
     /openTermEditor\(tag\.dataset\.tag\)/.test(mod));
  /* BOTH PRESENT, AND IN THAT ORDER. The bare indexOf comparison passed with
     the highlight call DELETED, because a missing name gives -1 and -1 is less
     than everything -- found by mutating topicRow to set innerHTML directly.
     The helpers being safe proves nothing if the row does not use them. */
  {
    const rowSrc = grab('topicRow');
    const hi = rowSrc.indexOf('topicsHighlightInto'), lk = rowSrc.indexOf('topicsLinkifyTags');
    ok('the row builds its text through the highlighter', hi !== -1);
    ok('and offers tags through the linkifier', lk !== -1);
    ok('and linkify runs after the marks', hi < lk);
    ok('and never assigns innerHTML', !/innerHTML/.test(rowSrc));
  }
}

// ONE HASHTAG RULE FOR BOTH DOORS. Flow carries its own inline copy; if the two
// ever disagree, a tag one door makes tappable is not findable by the term it
// creates. Byte-compare rather than trust.
{
  const flowSrc = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
  const flowRe = flowSrc.match(/const HASHTAG_RE = (\/.*\/gu);/);
  const coreRe = readFileSync(join(ROOT, 'vendor/core/match.js'), 'utf8').match(/export const HASHTAG_RE = (\/.*\/gu);/);
  ok('both doors declare the hashtag pattern', !!flowRe && !!coreRe);
  eq('and it is the same pattern, byte for byte', flowRe[1], coreRe[1]);
}

// ===========================================================================
// THE hidden ATTRIBUTE IS ONLY AS STRONG AS THE SHEET LETS IT BE. Author origin
// beats the UA sheet, so any author `display` on an element's id or class makes
// `hidden` inert and leaves it laid out, catching clicks, over what it is meant
// to be behind. Measured against this stylesheet before the fix: #tp-editor
// computed `flex` while carrying `hidden`, putting the term editor permanently
// over the results. Flow paid for this with its composer eating the FAB's
// clicks and fixed it globally; neo guards each element, so this counts them.
// ===========================================================================
console.log('\n-- the hidden attribute actually hides --');
{
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  // Every element in the page that carries the bare `hidden` attribute.
  const tags = html.match(/<[a-z][^>]*\shidden(?=[\s/>])[^>]*>/gi) || [];
  ok('found the hidden elements', tags.length >= 5);
  for (const tag of tags) {
    const id = (tag.match(/\sid="([^"]+)"/) || [])[1];
    const classes = ((tag.match(/\sclass="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    // Does any author rule give this element a display it would have to beat?
    const selectors = [id && '#' + id, ...classes.map((c) => '.' + c)].filter(Boolean);
    /* ONLY THE SUBJECT OF A RULE MATTERS. `.meta .cell { display: flex }` does
       not style a .cell that is not inside .meta -- the first version of this
       check matched the selector anywhere in the chain and failed a footer cell
       that is correctly hidden today. So: split on commas, take the LAST
       compound of each selector, and ask whether our element is that subject.
       Descendant qualifiers ahead of it are somebody else's context. */
    const styled = selectors.some((sel) => {
      const bare = sel.slice(1);
      const rules = css.match(/[^{}]+\{[^}]*\}/g) || [];
      return rules.some((rule) => {
        const head = rule.slice(0, rule.indexOf('{'));
        if (!/\bdisplay\s*:/.test(rule)) return false;
        return head.split(',').some((one) => {
          const parts = one.trim().split(/\s+|>|\+|~/).filter(Boolean);
          /* THE LIMIT OF A STATIC CHECK, STATED RATHER THAN PAPERED OVER. A rule
             with a descendant qualifier (`.meta .cell { display:flex }`) applies
             only inside that ancestor, and whether THIS element sits there is a
             question about the DOM, not the sheet. So only unconditional single
             -compound rules count here: those are the ones that certainly beat
             the UA sheet, and they are the shape that produced the bug. A
             descendant-qualified rule can still make `hidden` inert -- it is
             simply not something this file can decide. */
          if (parts.length !== 1) return false;
          const subject = parts[0];
          return sel[0] === '#' ? subject.includes('#' + bare)
                                : new RegExp('\\.' + bare + '(?![\\w-])').test(subject);
        });
      });
    });
    if (!styled) continue;   // nothing to beat: the UA rule wins on its own
    const guarded = selectors.some((sel) => {
      const re = new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none\\s*!important');
      return re.test(css);
    });
    ok('[hidden] wins on ' + (id || classes.join('.')) + ' (an author display needs an !important guard)', guarded);
  }
}

// ===========================================================================
// THE LAST TWO PARITY GAPS. Both are things the door could already DO and had
// no way to be told: the mode was read, persisted and honoured with no control
// to set it, and a covered date window had no state of its own so the button
// would have claimed the whole index.
// ===========================================================================
console.log('\n-- mode chip and the covered window --');
{
  const chips = grab('renderTopicChips');
  // With one topic, ANY and ALL are the same answer and a control that cannot
  // change anything implies the result would differ.
  ok('the mode chip appears only with two or more topics running',
     /topicFollows\(\)\.length > 1/.test(chips));
  ok('it shows which mode is active', /term\.all.*term\.any|term\.any.*term\.all/s.test(chips));
  ok('it announces its state', /aria-pressed'?,\s*String\(topicMode === 'all'\)/.test(chips));
  ok('it has an accessible name of its own', /'term\.modeAria'/.test(chips));
  ok('flipping it persists', /topicMode = topicMode === 'all' \? 'any' : 'all';[\s\S]{0,80}saveTopicSettings/.test(chips));
  // The mute half: a mode change re-decides which feed cards are hidden.
  ok('and re-renders the feed', /renderMessages\(\)/.test(chips));

  const render = grab('renderTopics');
  ok('a covered window does not claim the whole index',
     /tpRangeDone \? topicsT\('lane\.rangeEnd'\)/.test(render));
  ok('and deepEnd still wins over it', render.indexOf('lane.deepEnd') < render.indexOf('lane.rangeEnd'));
  ok('the button is disabled on a covered window', /tpBusy \|\| tpDeepDone \|\| tpRangeDone/.test(render));

  const walk = grab('runTopicsBackfill');
  ok('rangeDone is only claimed while a window is active',
     /tpRangeDone = topicsCore\.rangeActive\(topicRange\) &&/.test(walk));
  ok('and needs every selected protocol to have stopped',
     /topicScope\.every\(\(id\) => \{[\s\S]{0,140}c\.done \|\| c\.rangeDone/.test(walk));

  /* CHANGING THE WINDOW INVALIDATES THE ANSWER. Widen a covered window and a
     stale flag leaves the button disabled, still saying "Window covered", over
     a range nothing has read. One owner clears it; the two call sites go
     through that owner and nothing else assigns topicRange. */
  const setter = grab('setTopicRange');
  ok('the window has one owner', /tpRangeDone = false;/.test(setter));
  {
    const assigns = (mod.match(/(?:^|[^.\w])topicRange\s*=/gm) || []).length;
    ok('and nothing assigns the window around it (' + assigns + ' assignments)', assigns === 2);
  }
  ok('the presets go through it', /setTopicRange\(d === 0 \?/.test(grab('renderTopicPresets')));
  ok('the date fields go through it', /setTopicRange\(\{ from, to \}\)/.test(grab('wireTopicDates')));
  // Every path that drops the walk must drop this with it, or a covered window
  // survives the change that invalidated it.
  for (const [name, fn] of [['clear', 'topicsClearData'], ['a growth', 'topicsRefreshIndex']]) {
    ok(name + ' clears the covered-window flag', /tpRangeDone = false/.test(grab(fn)));
  }
}
// ...and driven through the shipped walk, because the interesting part is which
// per-protocol field ends the window and which ends the index.
{
  const AL = '2e786563';
  const win = { from: Date.parse('2023-06-01'), to: Date.parse('2023-06-30') };
  const run = (cov, opts) => unreadOf(Object.assign({
    cursor: { perLokad: {}, holes: [], holeCount: 0, done: false },
    cov: () => cov,
  }, opts));
  const P = (o) => Object.assign({ pos: 4, pagesDone: 4, oldestTs: 1600000000 }, o);

  eq('a window every protocol stopped inside is covered',
     (await run({ perLokad: { [CT]: P({ rangeDone: true }) }, holes: [], holeCount: 0, done: false },
       { range: win })).rangeDone, true);
  // done (read to genesis) also stops it -- that protocol cannot hold the
  // window open, so it must not veto the state either.
  eq('a protocol read to genesis does not veto it',
     (await run({ perLokad: { [CT]: P({ rangeDone: true }), [AL]: P({ done: true }) }, holes: [], holeCount: 0, done: false },
       { range: win, scope: [CT, AL] })).rangeDone, true);
  eq('one protocol still walking keeps it open',
     (await run({ perLokad: { [CT]: P({ rangeDone: true }), [AL]: P({}) }, holes: [], holeCount: 0, done: false },
       { range: win, scope: [CT, AL] })).rangeDone, false);
  // THE ASSERTION THAT MATTERS: the same shape with NO window is not covered,
  // it is simply unfinished -- otherwise the button would go quiet on a walk
  // that has every right to go deeper.
  eq('without a window, nothing is ever "covered"',
     (await run({ perLokad: { [CT]: P({ rangeDone: true }) }, holes: [], holeCount: 0, done: false },
       {})).rangeDone, false);
}

// ===========================================================================
// THE THREE CHIP STATES. Following, saved-but-off and muting decide whether the
// pane is collecting for a word at all, so a reader who cannot tell them apart
// cannot tell why a topic found nothing. They must differ by SHAPE as well as
// by hue -- hue alone excludes anyone who cannot separate cyan from grey.
// ===========================================================================
console.log('\n-- the chip states are tellable apart --');
{
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const rule = (sel) => {
    const i = css.indexOf(sel + ' {');
    return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
  };
  const off = '.topic-chip:not(.active):not(.mute):not(.topic-mode)';

  /* FOUR CHIPS, FOUR READINGS, BY COLOUR ALONE (the user's call). The dot that
     used to carry the state is gone, so every one of these four has to resolve
     to a DIFFERENT colour -- the assertion is that no two share one, not that
     any particular hue was chosen. */
  const colourOf = (sel) => (rule(sel).match(/color:\s*([^;]+);/) || [])[1];
  const states = {
    off: colourOf(off),
    following: colourOf('.topic-chip.active'),
    muting: colourOf('.topic-chip.mute'),
    mode: colourOf('.topic-chip.topic-mode'),
  };
  for (const [name, c] of Object.entries(states)) ok(name + ' has a colour of its own', !!c);
  ok('and no two states share one', new Set(Object.values(states)).size === 4);

  /* OFF IS WHITE, NOT DIM. It was var(--text-4) -- 16% white -- which read as
     disabled rather than dormant, and a saved topic you cannot see is a topic
     you cannot turn back on. */
  ok('off is full white', /var\(--text\)/.test(states.off));
  ok('and not one of the faded tokens', !/--text-[234]/.test(states.off));
  ok('...and still shows it is a control', rule(off + ':hover').length > 0);

  ok('following wears the match colour', /--cyan/.test(states.following));
  ok('muting never does', !/--cyan/.test(states.muting) && /--amber/.test(states.muting));
  /* The mode chip is not a topic, so it takes neither topic colour. */
  ok('the mode chip takes neither', !/--cyan/.test(states.mode) && !/--amber/.test(states.mode));

  // The dot is gone, and its absence is asserted so it does not creep back in
  // beside a colour scheme that no longer needs it.
  ok('no state dot remains', !/\.topic-chip[^{]*::before/.test(css));

  /* SPECIFICITY: the mode chip in "all words" carries .active too, so the two
     rules tie at (0,2,0) and source order decides. If .active were moved below
     .topic-mode the mode chip would turn cyan and read as a topic. */
  ok('the mode rule is declared after the match rule',
     css.indexOf('.topic-chip.topic-mode {') > css.indexOf('.topic-chip.active {'));
  ok('and its own active state outranks both', rule('.topic-chip.topic-mode.active').length > 0);
}

// ===========================================================================
// THE ROW OVERFLOWS. Measured at the eight-topic cap in a 390px column: 856px
// of content in a 388px box before the gap was removed -- more than half the
// controls off-screen, with the scrollbar hidden and nothing saying so. On a
// desktop there is no horizontal gesture at all, so those chips were
// unreachable with a mouse.
// ===========================================================================
console.log('\n-- the row says when it overflows --');
{
  /* COMMENTS STRIPPED FIRST. The fade's own comment explains why it outranks
     the chips by saying "z-index:1", and the naive reader matched THAT and
     reported 1 -- a suite reading the prose that documents a rule instead of
     the rule, which is the same mistake test-neo-quicksend made against the
     English sentences it was pinning. And a declaration can be split across
     several rules with the same selector (the base .msg-filters and the Topics
     override), so all of them are concatenated rather than the first taken. */
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => {
    const out = [];
    let i = 0;
    for (;;) {
      i = css.indexOf(sel + ' {', i);
      if (i === -1) break;
      // the selector must not be the tail of a longer one (.foo vs .barfoo)
      const before = css[i - 1];
      if (before && /[\w.#\-]/.test(before)) { i += sel.length; continue; }
      out.push(css.slice(i, css.indexOf('}', i)));
      i += sel.length;
    }
    return out.join('\n');
  };
  const strip = rule('.msg-filters');
  const fade = rule('.hscroll::after');

  // ONE STRIP, NOT LOOSE PILLS. The panel is already divided into columns.
  /* THE LAST DECLARATION WINS, not the absence of earlier ones. The base rule
     legitimately carries gap:4px and the Topics rule overrides it at equal
     specificity, so "no nonzero gap anywhere" is the wrong test -- it failed on
     a stylesheet that computes to 0. Take the last gap on this selector, which
     is what the cascade takes. The mobile block used to re-introduce 6px here
     and that is exactly what this is watching for. */
  const gaps = [...strip.matchAll(/gap:\s*([\d.]+)(px)?/g)].map((m) => Number(m[1]));
  ok('the row declares a gap somewhere', gaps.length > 0);
  ok('and the last one, which the cascade takes, is 0', gaps[gaps.length - 1] === 0);
  ok('shared edges are collapsed', /\.msg-filters > \*\s*\{[^}]*margin-left:\s*-1px/.test(css));
  ok('and the first one is not', /\.msg-filters > \*:first-child\s*\{[^}]*margin-left:\s*0/.test(css));

  // A sideways swipe was also dragging the page vertically -- Flow's footer bug.
  ok('a sideways swipe does not drag the page', /touch-action:\s*pan-x/.test(strip));
  ok('and does not chain to the page', /overscroll-behavior-x:\s*contain/.test(strip));

  /* THE FADE IS STICKY, NOT ABSOLUTE, and takes no width. An absolute one
     scrolls away with the content instead of staying at the edge; a positive
     margin would add width to the row whose width is the whole problem. */
  ok('the fade sticks to the edge', /position:\s*sticky/.test(fade));
  ok('and adds no width', /margin-left:\s*-(\d+)px/.test(fade)
     && fade.match(/width:\s*(\d+)px/)[1] === fade.match(/margin-left:\s*-(\d+)px/)[1]);
  /* It must outrank the chips: the lit states carry z-index:1 so their coloured
     edge draws over a neighbour's, and that put them over the fade as well --
     the chevron rendered as a smudge on an amber chip, opaque gradient and all. */
  ok('and paints above the lit chips',
     Number((fade.match(/z-index:\s*(\d+)/) || [])[1]) > 1);
  /* IT REACHES PAST THE ROW'S OWN PADDING, via a sticky OFFSET and not a
     negative margin: sticky keeps the element's MARGIN box inside the
     scrollport, so margin-right:-16px pulled the border box 16px LEFT -- the
     opposite of the intent, and two renders went by before it was measured
     rather than eyeballed. Measured after: ::after right -16px against a 14px
     padding, chevron at the true edge with nothing showing past it. */
  ok('the fade reaches past the row padding', /right:\s*-(\d+)px/.test(fade));
  ok('and does it with an offset, not a margin', !/margin-right:\s*-/.test(fade));
  {
    const reach = Number(fade.match(/right:\s*-(\d+)px/)[1]);
    const pads = [...strip.matchAll(/padding:\s*[\d.]+px\s+([\d.]+)px/g)].map((m) => Number(m[1]));
    ok('by at least the widest padding it has to cover (' + reach + ' >= ' + Math.max(...pads) + ')',
       reach >= Math.max(...pads));
  }
  ok('the nudge respects reduced motion',
     /@media \(prefers-reduced-motion: no-preference\)[\s\S]{0,160}hint-on/.test(css));
  ok('and the fade is hidden until it is needed',
     /opacity:\s*0/.test(fade) && /\.hscroll\.can-r::after\s*\{[^}]*opacity:\s*1/.test(css));

  // MEASURED, not assumed: a hint that cannot self-correct becomes a permanent
  // chevron pointing at nothing.
  const upd = grab('updateTopicScrollHint');
  ok('the hint measures', /scrollWidth - el\.clientWidth/.test(upd));
  ok('with slack for fractional device pixels', /max > 2/.test(upd));
  ok('and goes away at the end of the row', /scrollLeft < max - 2/.test(upd));
  ok('the nudge stops once the row has been scrolled', /!el\._hsUsed/.test(upd));

  const init = grab('initTopicScrollHint');
  ok('a vertical wheel scrolls it sideways', /addEventListener\('wheel'/.test(init));
  /* preventDefault only while it can still move that way: at either end the
     page must keep scrolling as normal, which is also why it is not passive. */
  ok('but only while it can still move', /if \(next === el\.scrollLeft\) return;[\s\S]{0,40}preventDefault/.test(init));
  ok('so the listener cannot be passive', /\{ passive: false \}/.test(init));
  ok('the row is focusable, so arrows scroll it', /el\.tabIndex = 0/.test(init));
  ok('and announces itself', /setAttribute\('role', 'group'\)/.test(init));
  ok('it re-measures on resize', /addEventListener\('resize', updateTopicScrollHint\)/.test(init));
  // Fonts and translation both change every chip's width.
  ok('and once the fonts have landed', /fonts\.ready\.then\(updateTopicScrollHint\)/.test(init));
  ok('and after a language switch',
     /requestAnimationFrame\(updateTopicScrollHint\)/.test(grab('applyTopicsLang')));
  ok('and when the chips change', /requestAnimationFrame\(updateTopicScrollHint\)/.test(grab('renderTopicChips')));
  ok('and when the pane opens', /requestAnimationFrame\(updateTopicScrollHint\)/.test(grab('openTopics')));
  ok('the listeners are attached once', /if \(!el \|\| el\._hsInit\) return;/.test(init));
}

// ===========================================================================
// CHIP ORDER. A followed topic is a question you are reading answers to; a mute
// is a standing defence you set once and stop thinking about. Interleaved by
// creation date, the thing you are reading gets pushed off the right edge by the
// thing you are ignoring -- and the row overflows at 390px well before the cap.
// Driven against a fake DOM: the order is what the renderer PRODUCES, not what
// its source says it intends.
// ===========================================================================
console.log('\n-- mutes sit at the end --');
{
  function chipsFor(terms, mode = 'any') {
    const made = [];
    const row = {
      children: [],
      querySelectorAll: () => [],
      insertBefore(node, ref) {
        const i = row.children.indexOf(ref);
        row.children.splice(i === -1 ? row.children.length : i, 0, node);
        return node;
      },
    };
    const add = { id: 'add', get nextSibling() { return row.children[row.children.indexOf(add) + 1] || null; } };
    row.children.push(add);
    // every inserted node needs the same nextSibling view
    const mkNext = (n) => Object.defineProperty(n, 'nextSibling', {
      get() { return row.children[row.children.indexOf(n) + 1] || null; }, configurable: true });
    const document = {
      createElement: () => {
        const n = { className: '', textContent: '', type: '',
          setAttribute() {}, addEventListener() {} };
        mkNext(n); made.push(n); return n;
      },
      querySelector: () => row,
    };
    const src = [
      'const topicTerms = terms;',
      'let topicMode = mode;',
      'function $(){ return add; }',
      'function topicFollows(){ return topicTerms.filter(t => t.on && !t.mute); }',
      'function topicsT(k){ return k; }',
      'function saveTopicSettings(){}',
      'function topicsEngineReady(){ return false; }',
      'function openTopics(){}',
      'function topicsRematch(){}',
      'function runTopicsBackfill(){}',
      'function renderMessages(){}',
      'function initTopicScrollHint(){}',
      'function updateTopicScrollHint(){}',
      'function requestAnimationFrame(){}',
      grab('renderTopicChips'),
      'renderTopicChips();',
    ].join('\n');
    new Function('terms', 'mode', 'document', 'add', 'row', src)(terms, mode, document, add, row);
    // read the DOM back, not the input
    return row.children.filter((n) => n !== add)
      .map((n) => (n.className.includes('topic-mode') ? '[mode]' : n.textContent));
  }
  const T = (q, o) => Object.assign({ q, on: true, mute: false }, o);

  eq('a lone topic renders alone', chipsFor([T('gm')]), ['gm']);
  // Newest first WITHIN a group -- the topic added a moment ago is the one
  // being looked for. Storage is oldest-first.
  eq('topics come back newest first',
     chipsFor([T('gm'), T('firma'), T('xec')]), ['[mode]', 'xec', 'firma', 'gm']);
  // THE ASK: a mute created in the middle does not sit in the middle.
  // THE ASK: a mute created in the middle does not sit in the middle. (Both of
  // these have two RUNNING topics, so the mode chip is there too -- my first
  // pass wrote the expectation without it and the suite was right, not the code.)
  eq('a mute goes to the end however old it is',
     chipsFor([T('gm'), T('casino', { mute: true }), T('firma')]),
     ['[mode]', 'firma', 'gm', 'casino']);
  eq('several mutes keep their own order, still at the end',
     chipsFor([T('casino', { mute: true }), T('gm'), T('dice', { mute: true }), T('firma')]),
     ['[mode]', 'firma', 'gm', 'dice', 'casino']);
  eq('all mutes is just all mutes',
     chipsFor([T('casino', { mute: true }), T('dice', { mute: true })]), ['dice', 'casino']);
  eq('an OFF topic is still a topic, not a mute',
     chipsFor([T('gm', { on: false }), T('casino', { mute: true }), T('firma')]),
     ['firma', 'gm', 'casino']);
  // The mode chip needs two RUNNING topics; mutes and off topics do not count.
  eq('two mutes do not summon the mode chip',
     chipsFor([T('a', { mute: true }), T('b', { mute: true })]), ['b', 'a']);
  eq('a topic plus a mute does not either',
     chipsFor([T('gm'), T('casino', { mute: true })]), ['gm', 'casino']);
  eq('two running topics do',
     chipsFor([T('gm'), T('firma')]), ['[mode]', 'firma', 'gm']);

  /* THE STORED ARRAY IS NOT REORDERED. It is the value Flow reads out of the
     shared key, so sorting it here would silently reorder the other door's
     list -- decision 14 is one stored value, two doors. */
  {
    const terms = [T('gm'), T('casino', { mute: true }), T('firma')];
    const before = terms.map((t) => t.q).join(',');
    chipsFor(terms);
    eq('rendering does not reorder what is stored', terms.map((t) => t.q).join(','), before);
  }
}

// ===========================================================================
// THE LOADER READS A VALUE FLOW ALSO WRITES, AND WRITES BACK WHAT IT READ.
// So it has to be at least as permissive as Flow's, and no more permissive
// about the cap. Both bodies are extracted and driven on the SAME store: a
// difference between them is a difference two doors will disagree about.
// ===========================================================================
console.log('\n-- the two loaders agree --');
{
  const flowSrc = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
  function grabFrom(src, name) {
    const at = src.indexOf('function ' + name + '('); let i = src.indexOf('{', at), d = 0;
    for (; i < src.length; i++) { const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
      if (c === "'" || c === '"' || c === '`') { const q = c; for (i++; i < src.length; i++) { if (src[i] === '\\') i++; else if (src[i] === q) break; } continue; }
      if (c === '{') d++; else if (c === '}') { d--; if (!d) return src.slice(at, i + 1); } }
    throw new Error('unbalanced ' + name);
  }
  const runBoth = (terms) => {
    const ls = { getItem: () => JSON.stringify({ mode: 'any', scope: [CT], terms }), setItem() {} };
    const neoOut = new Function('localStorage', 'LOKAD', 'TOPICS_TERMS_KEY', 'TOPICS_TERM_MAX',
      'let topicTerms=[],topicMode="any",topicScope=[];' + grab('loadTopicSettings') +
      'loadTopicSettings(); return topicTerms;')(ls, { CASHTAB_MSG: CT }, 'k', 8);
    const st = { terms: [], laneScope: [], termMode: 'any' };
    new Function('localStorage', 'TERMS_KEY', 'TERM_MAX', 'sanitizeScope', 'state',
      grabFrom(flowSrc, 'loadTerms') + 'loadTerms();')(ls, 'k', 8, (x) => x || [], st);
    return { neo: neoOut.map((t) => t.q), flow: st.terms.map((t) => t.q) };
  };

  /* A BARE STRING IS A TERM. Flow reads saves that predate the option object;
     neo required e.q, dropped them, and then wrote the shortened list back --
     deleting them from Flow's list by opening the other door once. */
  {
    const r = runBoth(['gm', { q: 'thanks' }]);
    eq('a bare-string entry survives both loaders', r.neo, r.flow);
    ok('and it is actually kept', r.neo.includes('gm'));
  }
  /* THE CAP IS A CAP ON LOAD, not only in the editor. Measured before the fix:
     a store of 14 gave Flow 8 and neo 13 -- over §10's bound, matched against
     every arriving message, and saved back at that size. */
  {
    const many = Array.from({ length: 14 }, (_, i) => ({ q: 'w' + i }));
    const r = runBoth(many);
    eq('an over-long list is capped the same way', r.neo, r.flow);
    eq('and capped at all', r.neo.length, 8);
  }
  // Mixed shapes, mutes, junk: the two must still not diverge.
  {
    const r = runBoth(['a', { q: 'b', mute: true }, null, { q: '' }, 5, { q: 'c', mode: 'contains' }]);
    eq('junk is skipped identically', r.neo, r.flow);
  }
  /* PRESENT, then ordered. `indexOf(a) < indexOf(b)` is true when a is MISSING
     (-1 is less than everything) -- the same sentinel that let a deleted
     highlight call pass the row-order check earlier on this branch. Deleting
     the declaration outright is the mutation that found it here. */
  ok('the cap is declared at all', mod.includes('const TOPICS_TERM_MAX'));
  ok('and before the loader that uses it',
     mod.indexOf('const TOPICS_TERM_MAX') < mod.indexOf('function loadTopicSettings'));
  // ...because the loader runs at module top level, where a later const is in
  // the temporal dead zone and the throw lands in a try/catch that hides it.
  ok('and the loader is called at module top level',
     /^try \{ loadTopicSettings\(\);/m.test(mod));

  // The chips row is a focusable role=group; an unnamed one is a tab stop that
  // announces nothing.
  ok('the chips row is given an accessible name',
     /row\.setAttribute\('aria-label', topicsT\('topics\.rowAria'\)\)/.test(grab('renderTopicStatics')));
}

// ===========================================================================
// TWO THINGS THE "defined but never used" GATE SURFACED. Both keys were
// borrowed, translated fifteen times, and reaching nothing -- which is not
// dead weight but a feature that was never wired.
// ===========================================================================
console.log('\n-- the safety line, and a refusal that speaks --');
{
  /* PERMANENT, like Flow's. This pane renders text written by whoever paid the
     fee, and the reader arrived by following a WORD rather than a person, so
     there is no sender they have chosen to trust. */
  ok('the pane carries a safety line', /id="topics-safety"/.test(html));
  ok('and it is inside the Topics pane, not the feed',
     html.indexOf('id="topics-safety"') > html.indexOf('<div id="topics" ')
     && html.indexOf('id="topics-safety"') < html.indexOf('id="topics-body"'));
  ok('it says what Flow says', /\['topics-safety',\s*'safety\.lane'\]/.test(mod));
  ok('and it is not inside anything that hides', !/topics-safety[^>]*hidden/.test(html));

  /* A REFUSAL WITH NOTHING ON THE PAGE reads as a broken control rather than a
     rule -- v2.7.0 fixed exactly that for the date fields, and the scope picker
     had the same silence. */
  ok('the hint element exists', /id="tp-scope-hint"/.test(html));
  ok('and it announces itself', /id="tp-scope-hint"[^>]*role="status"/.test(html));

  /* DRIVEN, not matched. Source-matching `'scope.needOne'` passed with the
     branch wrapped in `if (0)` -- the key was still in the file, doing nothing.
     Untick the last protocol on the real renderer and read what the hint says. */
  {
    const nodes = [];
    const mk = () => { const n = { className: '', innerHTML: '', textContent: '',
      children: [], dataset: {}, _l: {},
      appendChild(c) { n.children.push(c); return c; },
      setAttribute() {}, addEventListener(t, f) { n._l[t] = f; },
      querySelector: () => n._input || null };
      nodes.push(n); return n; };
    const box = mk(); const hint = mk();
    // The shipped code attaches to lab.querySelector('input'), not to the
    // label -- a fake that swallows addEventListener here reports "the refusal
    // does not fire" when the refusal is fine and the double is wrong.
    const input = { checked: true, _l: {}, addEventListener(t, f) { input._l[t] = f; } };
    const doc = { createElement: () => { const n = mk(); n._input = input; return n; } };
    const scope = [CT];
    const src = [
      'const topicsCore = C;',
      'const LOKAD = { PAYBUTTON: "50415900" };',
      'const LOKAD_NAMES = { "' + CT + '": "Cashtab Msg" };',
      'const C_MESSAGE_LOKADS = ["' + CT + '"];',
      'let topicScope = scope;',
      'let tpBf = null, tpDeepDone = false, tpRangeDone = false, tpUnread = 0;',
      'let tpSavedCursor = null;',
      'function $(id){ return id === "tp-scope" ? box : (id === "tp-scope-hint" ? hint : null); }',
      'function topicsT(k){ return k; }',
      'function topicsTf(k, v){ return k; }',
      'function escapeHtml(x){ return String(x); }',
      'function saveTopicSettings(){}',
      'function renderTopicTools(){}',
      'function topicsRematch(){}',
      'function runTopicsBackfill(){}',
      'function setTimeout(){}',
      grab('renderTopicScopePanel'),
      'renderTopicScopePanel();',
      'return { fire: (checked) => { input.checked = checked; ' +
        'input._l.change && input._l.change({ target: input }); }, input };',
    ].join('\n');
    const api = new Function('C', 'document', 'box', 'hint', 'scope', 'MESSAGE_LOKADS', 'input', src)(
      { scopeCursorView: () => ({}), sanitizeScope: (x) => x, MESSAGE_LOKADS: [CT] },
      doc, box, hint, scope, [CT], input);
    // Unticking the only protocol must be refused AND explained.
    api.fire(false);
    eq('unticking the last protocol is refused', api.input.checked, true);
    eq('and the reader is told why', hint.textContent, 'scope.needOne');
    // Ticking something again clears the message.
    api.fire(true);
    eq('and the message clears when the rule is satisfied', hint.textContent, '');
  }
}

console.log(fail ? `\nFAILED ${fail}/${pass + fail}` : `\nok: neo topics ${pass} assertions`);
if (fail) process.exit(1);
