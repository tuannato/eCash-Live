// Harness for the Lane scope picker (R1, 2026-08-13).
//   node tools/test-lane-scope.mjs
//
// Cursor/coverage math is imported from the shipped vendor/core/lane-cursor.js
// (the same module Flow loads). The corpus store is imported from
// vendor/core/lane-corpus.js. Door-owned functions are still extracted from
// flow/index.html: a test of a copy passes when the copy is right; those fail
// when the page is wrong.
//
// laneRematch (the hidden-id union), laneHold, loadTerms / saveTerms and the
// mute trio live in tools/test-lane-corpus.mjs — also extracted, not copied.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { matchAny, matchEvery, matchTerm, findTermSpans, findAllSpans, segmentWords, normalize as normalizeTerm } from '../vendor/core/match.js';
import { MESSAGE_LOKADS, LOKAD, LOKAD_NAMES } from '../vendor/txparse.js';
import {
  inScope as inScopeOf, sanitizeScope, scopeLabel as scopeLabelOf, laneReach as laneReachOf,
  rangeActive as rangeActiveOf, inRange as inRangeOf, dayStart, senderTag,
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
    else if (c === '}') { depth--; if (!depth) return mod.slice(at, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const NAMES = ['saveLaneStore', 'loadLaneStore', 'restoreLaneStore',
               'cmpChipList', 'dayEnd',
               'computeSuggestions', 'laneTsOf', 'txWhenMs', 'laneSetMatched',
               'reopenIndexIfUnanswered'];
const bodies = NAMES.map(grab).join('\n\n');

// The module constants these bodies close over, quoted from the page.
const CORPUS_MAX = Number(mod.match(/const CORPUS_MAX = (\d+)/)[1]);
const LANE_CURSOR_KEY = mod.match(/const LANE_CURSOR_KEY = '([^']+)'/)[1];
const CMP_CHIP_MAX = Number(mod.match(/const CMP_CHIP_MAX = (\d+)/)[1]);
const CMP_CHIPS = JSON.parse(mod.match(/const CMP_CHIPS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));

function makeLane(quotaChars = Infinity) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    // Real engines throw QuotaExceededError; a budget in CHARACTERS is the right
    // unit, since most of them account localStorage quota in UTF-16.
    setItem: (k, v) => {
      const s = String(v);
      if (s.length > quotaChars) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      store.set(k, s);
    },
    removeItem: (k) => store.delete(k),
  };
  const factory = new Function(
    'MESSAGE_LOKADS', 'LOKAD', 'LOKAD_NAMES', 'matchAny', 'matchEvery',
    'CORPUS_MAX', 'LANE_CURSOR_KEY', 'localStorage', 'CMP_CHIP_MAX', 'CMP_CHIPS',
    'segmentWords', 'normalizeTerm', 'SUGGEST_MAX', 'SUGGEST_MIN_DF', 'SUGGEST_DF_CEIL',
    'SUGGEST_MIN_SENDERS', 'SUGGEST_MAX_LEN', 'HASHTAG_RE', 'SHOUT_RE', 'SHOUT_ONE',
    'SUGGEST_MIN_DF_TAG', 'SUGGEST_MIN_SENDERS_TAG', 'SUGGEST_TAG_SOFT',
    'inScopeOf', 'sanitizeScope', 'scopeLabelOf', 'laneReachOf',
    'rangeActiveOf', 'inRangeOf', 'dayStart', 'senderTag',
    'createCorpus',
    `
    "use strict";
    const state = { laneScope: [LOKAD.CASHTAB_MSG], termMode: 'any', terms: [] };
    const laneCorpus = createCorpus({ max: CORPUS_MAX });
    function corpusAdd(txid, text, ts, lokad, from){ laneCorpus.add(txid, text, ts, lokad, from); }
    function corpusMatches(){
      return laneCorpus.matches({
        terms: enabledTerms(), mutes: activeMutes(),
        scope: state.laneScope, range: laneRange, mode: state.termMode,
      });
    }
    const MATCH_MAX = 200;
    state.txs = new Map(); state.laneTxs = new Map(); state.matched = []; state.matchedTotal = 0;
    let laneBf = null, laneSavedCursor = null, laneStoreTrimmed = 0;
    let laneDeepDone = false, laneRangeDone = false;
    let laneRange = { from: null, to: null }, laneNoDate = 0;
    const enabledTerms = () => state.terms.filter(t => t.on && t.q && !t.mute);
    const activeMutes  = () => state.terms.filter(t => t.on && t.q && t.mute);
    const matchTerms = (hay, terms) =>
      state.termMode === 'all' ? matchEvery(hay, terms) : matchAny(hay, terms);
    const inScope = (lokad) => inScopeOf(lokad, state.laneScope);
    const scopeLabel = () => scopeLabelOf(state.laneScope);
    const laneReach = () => laneReachOf(laneBf ? laneBf.cursor : (laneSavedCursor || null), state.laneScope);
    const rangeActive = () => rangeActiveOf(laneRange);
    const inRange = (ts) => inRangeOf(ts, laneRange);
    ${bodies}
    return {
      state, laneCorpus, localStorage,
      inScope, sanitizeScope, scopeLabel, corpusAdd, corpusMatches, laneReach,
      saveLaneStore, loadLaneStore, restoreLaneStore, cmpChipList,
      rangeActive, inRange, dayStart, dayEnd, senderTag, computeSuggestions,
      laneTsOf, txWhenMs, laneSetMatched, reopenIndexIfUnanswered,
      setTxs: (m) => { for (const [k,v] of m) state.txs.set(k,v); },
      setRange: (r) => { laneRange = r; },
      get corpusFull(){ return laneCorpus.full; },
      get trimmed(){ return laneStoreTrimmed; },
      get savedCursor(){ return laneSavedCursor; },
      get deepDone(){ return laneDeepDone; },
      setDeepDone: (v) => { laneDeepDone = v; },
      setBf: (c) => { laneBf = c ? { cursor: c } : null; },
      setSaved: (c) => { laneSavedCursor = c; },
      raw: () => localStorage.getItem(LANE_CURSOR_KEY),
    };`
  );
  const num = (n) => Number(mod.match(new RegExp('const ' + n + ' = ([\\d.]+)'))[1]);
  const rx  = (n) => eval(mod.match(new RegExp('const ' + n + ' = (/.*?/[gu]*);'))[1]);
  return factory(MESSAGE_LOKADS, LOKAD, LOKAD_NAMES, matchAny, matchEvery,
                 CORPUS_MAX, LANE_CURSOR_KEY, localStorage, CMP_CHIP_MAX, CMP_CHIPS,
                 segmentWords, normalizeTerm, num('SUGGEST_MAX'), num('SUGGEST_MIN_DF'),
                 num('SUGGEST_DF_CEIL'), num('SUGGEST_MIN_SENDERS'), num('SUGGEST_MAX_LEN'),
                 rx('HASHTAG_RE'), rx('SHOUT_RE'), rx('SHOUT_ONE'),
                 num('SUGGEST_MIN_DF_TAG'), num('SUGGEST_MIN_SENDERS_TAG'), num('SUGGEST_TAG_SOFT'),
                 inScopeOf, sanitizeScope, scopeLabelOf, laneReachOf,
                 rangeActiveOf, inRangeOf, dayStart, senderTag,
                 createCorpus);
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const CT = LOKAD.CASHTAB_MSG, PB = LOKAD.PAYBUTTON, EC = LOKAD.ECASHCHAT_TX, AL = LOKAD.ALIAS;

// ---------------------------------------------------------------- inScope ----
{
  const L = makeLane();
  console.log('\n-- inScope: an unknown protocol is IN, never out --');
  ok('null tag is in scope', L.inScope(null) === true);
  ok('undefined tag is in scope', L.inScope(undefined) === true);
  ok('empty-string tag is in scope', L.inScope('') === true);
  ok('selected protocol is in scope', L.inScope(CT) === true);
  ok('unselected protocol is out', L.inScope(PB) === false);
  L.state.laneScope = [CT, PB, EC];
  ok('widened: PayButton now in', L.inScope(PB) === true);
  ok('widened: Alias still out', L.inScope(AL) === false);
  L.state.laneScope = [];
  ok('empty scope: known tag is out', L.inScope(CT) === false);
  ok('empty scope: unknown tag still in', L.inScope(null) === true);
}

// ---------------------------------------------------------- sanitizeScope ----
{
  const L = makeLane();
  console.log('\n-- sanitizeScope: never empty, never an id we cannot read --');
  eq('empty array -> Cashtab', L.sanitizeScope([]), [CT]);
  eq('null -> Cashtab', L.sanitizeScope(null), [CT]);
  eq('undefined -> Cashtab', L.sanitizeScope(undefined), [CT]);
  eq('not an array -> Cashtab', L.sanitizeScope('00746162'), [CT]);
  eq('all junk -> Cashtab', L.sanitizeScope(['nope', 42, null]), [CT]);
  eq('textless lokad dropped', L.sanitizeScope([LOKAD.AGORA, CT]), [CT]);
  eq('duplicates collapsed', L.sanitizeScope([CT, CT, PB]), [CT, PB]);
  eq('order preserved as given', L.sanitizeScope([PB, CT]), [PB, CT]);
  eq('all six survive', L.sanitizeScope(MESSAGE_LOKADS).length, 6);
}

// ------------------------------------------------------------- scopeLabel ----
{
  const L = makeLane();
  console.log('\n-- scopeLabel: proper names, MESSAGE_LOKADS order --');
  eq('single', L.scopeLabel(), 'Cashtab Msg');
  L.state.laneScope = [PB, CT];                       // given out of order
  eq('rendered in index order, not click order', L.scopeLabel(), 'Cashtab Msg · PayButton');
}

// -------------------------------------------------- corpusAdd tag upgrade ----
{
  const L = makeLane();
  console.log('\n-- corpusAdd: a legacy row LEARNS its tag, it is not skipped --');
  L.corpusAdd('a', 'hello', 1, null);
  eq('stored untagged', L.laneCorpus.get('a').lokad, null);
  L.corpusAdd('a', 'hello', 1, CT);
  eq('upgraded in place when the walk meets it again', L.laneCorpus.get('a').lokad, CT);
  L.corpusAdd('a', 'hello', 1, PB);
  eq('an existing tag is never overwritten', L.laneCorpus.get('a').lokad, CT);
  L.corpusAdd('b', 'hi', 2, EC);
  eq('text not clobbered by the upgrade path', L.laneCorpus.get('a').text, 'hello');
  eq('size', L.laneCorpus.size, 2);
}

// ------------------------------------------------- corpusMatches + hidden ----
{
  const L = makeLane();
  console.log('\n-- corpusMatches: hidden is COUNTED, not silently dropped --');
  L.state.terms = [{ q: 'gm', on: true, mode: 'word', fold: false, mute: false }];
  L.corpusAdd('c1', 'gm world', 10, CT);
  L.corpusAdd('c2', 'gm friends', 11, PB);
  L.corpusAdd('c3', 'gm again', 12, EC);
  L.corpusAdd('c4', 'gm legacy', 13, null);          // pre-picker row
  L.corpusAdd('c5', 'nothing here', 14, CT);
  let r = L.corpusMatches();
  eq('Cashtab-only: ids', r.ids, ['c1', 'c4']);
  eq('Cashtab-only: hidden counted', r.hidden.size, 2);
  eq('hidden is a SET OF IDS, so the caller can union it', [...r.hidden].sort(), ['c2', 'c3']);
  L.state.laneScope = [CT, PB, EC];
  r = L.corpusMatches();
  eq('widened: everything matching returns', r.ids, ['c1', 'c2', 'c3', 'c4']);
  eq('widened: nothing hidden', r.hidden.size, 0);
  L.state.terms = [];
  r = L.corpusMatches();
  eq('no terms: no ids', r.ids, []);
  eq('no terms: hidden is 0, not stale', r.hidden.size, 0);
  // A mute outranks the scope: it must not be reported as "hidden by scope",
  // which would offer a checkbox that cannot bring it back.
  L.state.laneScope = [CT];
  L.state.terms = [{ q: 'gm', on: true, mode: 'word', mute: false },
                   { q: 'world', on: true, mode: 'word', mute: true }];
  r = L.corpusMatches();
  eq('muted row is not counted as scope-hidden', r.hidden.size, 2);
  eq('muted row is not returned either', r.ids, ['c4']);
  // The rematch union (one hidden message counted once) is driven against the
  // shipped laneRematch body in tools/test-lane-corpus.mjs. It is not re-stated
  // here. An earlier comment claimed laneRematch could not be lifted; that was
  // false (DOM 0, i18n 0, localStorage 0).
}

// --------------------------------------------------------------- laneReach ---
{
  const L = makeLane();
  console.log('\n-- laneReach: the floor over the SELECTED protocols --');
  ok('no cursor at all -> null', L.laneReach() === null);
  const cur = {
    [CT]: { oldestTs: 1000, done: false },
    [PB]: { oldestTs: 200,  done: false },
    [EC]: { oldestTs: 500,  done: false },
    [AL]: { oldestTs: 50,   done: true  },   // read to genesis: constrains nothing
  };
  L.setSaved(cur);
  L.state.laneScope = [CT];
  eq('single protocol -> its own depth', L.laneReach(), 1000);
  L.state.laneScope = [CT, PB];
  eq('floor is the SHALLOWEST, i.e. the max', L.laneReach(), 1000);
  L.state.laneScope = [PB, EC];
  eq('without Cashtab the floor drops to 500', L.laneReach(), 500);
  L.state.laneScope = [AL];
  eq('a finished protocol imposes no floor', L.laneReach(), null);
  L.state.laneScope = [CT, AL];
  eq('finished sibling does not change the floor', L.laneReach(), 1000);
  L.setSaved({ ...cur, [EC]: { oldestTs: null, done: false } });
  L.state.laneScope = [CT, EC];
  ok('never read -> refuses to state ANY date', L.laneReach() === null);
  L.state.laneScope = [];
  ok('empty scope -> no claim', L.laneReach() === null);

  /* THE RANGES PATH — the reason laneReach stopped reading oldestTs. Once the
     engine can seek, a window read around 2022 sits on the record beside a
     shallow prefix, and only the prefix may speak for "in full back to". */
  console.log('\n-- laneReach over ranges: the prefix, never the deep window --');
  const R = makeLane();
  R.state.laneScope = [CT];
  R.setSaved({ [CT]: { ranges: [[0, 3, 1000], [60, 62, 5]], oldestTs: 5, done: false } });
  eq('reads the prefix, not the oldest thing seen', R.laneReach(), 1000);
  R.setSaved({ [CT]: { ranges: [[7, 9, 5]], oldestTs: 5, done: false } });
  ok('a window that does NOT start at page 0 grants no claim', R.laneReach() === null);
  R.setSaved({ [CT]: { ranges: [], oldestTs: null, done: false } });
  ok('no ranges at all -> no claim', R.laneReach() === null);
  R.setSaved({ [CT]: { ranges: [[0, 4, null]], oldestTs: 900, done: false } });
  ok('a prefix with no timestamp refuses rather than borrowing oldestTs',
     R.laneReach() === null);
  R.setSaved({ [CT]: { ranges: [[0, 9, 400]], done: true } });
  ok('a finished protocol still imposes no floor', R.laneReach() === null);
  R.setSaved({ [CT]: { page: 4, oldestTs: 777, done: false } });
  eq('a pre-ranges save still reads its watermark depth', R.laneReach(), 777);
}

// -------------------------------------------------- merge-persist (the bug) --
{
  console.log('\n-- saveLaneStore: a narrowed scope must not erase read depth --');
  const L = makeLane();
  L.corpusAdd('x', 'hello', 7, CT);
  // Session 1: all six walked, engine cursor covers all six.
  const wide = {};
  for (const id of MESSAGE_LOKADS) wide[id] = { page: 4, pagesDone: 4, numPages: 100, numTxs: 5000, oldestTs: 900, done: false };
  L.setBf(wide);
  L.saveLaneStore();
  eq('session 1 stored all six', Object.keys(JSON.parse(L.raw()).cursor).length, 6);
  // Session 2: reader narrows to Cashtab; the engine is rebuilt for ONE lokad.
  L.setBf({ [CT]: { page: 9, pagesDone: 9, numPages: 188, numTxs: 9392, oldestTs: 400, done: false } });
  L.saveLaneStore();
  const after = JSON.parse(L.raw()).cursor;
  eq('all six still on record', Object.keys(after).length, 6);
  eq('Cashtab advanced', after[CT].page, 9);
  eq('PayButton depth SURVIVED the narrowing', after[PB].page, 4);
  eq('eCashChat depth survived too', after[EC].pagesDone, 4);
  // Session 3: back to a different single protocol — session 2 must persist.
  L.setBf({ [PB]: { page: 6, pagesDone: 6, numPages: 368, numTxs: 18379, oldestTs: 300, done: false } });
  L.saveLaneStore();
  const three = JSON.parse(L.raw()).cursor;
  eq('A -> B -> C keeps A', three[CT].page, 9);
  eq('A -> B -> C keeps B', three[PB].page, 6);
  eq('and everything else', Object.keys(three).length, 6);
  // The corpus rows must carry the tag.
  eq('row is five long', JSON.parse(L.raw()).corpus[0].length, 5);
  eq('row carries the tag', JSON.parse(L.raw()).corpus[0][3], CT);
}

// ----------------------------------------------------- restore, both shapes --
{
  console.log('\n-- restoreLaneStore: 3-element legacy rows and 4-element rows --');
  const L = makeLane();
  L.localStorage.setItem(LANE_CURSOR_KEY, JSON.stringify({
    v: 1,
    cursor: { [CT]: { page: 2, oldestTs: 500, done: false } },
    corpus: [
      ['legacy', 'old row', 100],            // written before the picker
      ['tagged', 'new row', 200, CT],
      ['nulled', 'explicit null', 300, null],
      ['badts',  'ts not a number', 'nope', PB],
      ['short'],                              // malformed
      'not an array',                         // malformed
      [42, 'id not a string', 1, CT],         // malformed
    ],
  }));
  L.restoreLaneStore();
  eq('malformed rows dropped', L.laneCorpus.size, 4);
  eq('legacy row -> null tag', L.laneCorpus.get('legacy').lokad, null);
  eq('legacy row is IN scope, not hidden', L.inScope(L.laneCorpus.get('legacy').lokad), true);
  eq('tagged row keeps its tag', L.laneCorpus.get('tagged').lokad, CT);
  eq('explicit null tolerated', L.laneCorpus.get('nulled').lokad, null);
  eq('non-numeric ts -> null', L.laneCorpus.get('badts').ts, null);
  eq('non-numeric ts keeps its tag', L.laneCorpus.get('badts').lokad, PB);
  eq('cursor restored', L.savedCursor[CT].page, 2);
}

// ------------------------------------------------------------ corpus cap ----
{
  console.log('\n-- corpusAdd cap: older refused, newer evicts the oldest --');
  const L = makeLane();
  for (let i = 0; i < CORPUS_MAX; i++) L.corpusAdd('t' + i, 'text ' + i, 1000 + i, CT);
  eq('filled exactly to the cap', L.laneCorpus.size, CORPUS_MAX);
  ok('not flagged full at the cap', L.corpusFull === false);
  L.corpusAdd('older-than-window', 'too old', 1, CT);
  eq('an older row is refused', L.laneCorpus.size, CORPUS_MAX);
  ok('and says so', L.corpusFull === true);
  ok('the NEWEST entry is still there', L.laneCorpus.has('t' + (CORPUS_MAX - 1)));
  ok('the oldest was not evicted for something older', L.laneCorpus.has('t0'));
  L.corpusAdd('newer-than-window', 'page 0', 9999, CT);
  eq('a newer row still fits the cap', L.laneCorpus.size, CORPUS_MAX);
  ok('it entered', L.laneCorpus.has('newer-than-window'));
  ok('the oldest left to keep the window on the newest end', !L.laneCorpus.has('t0'));
  // A tag upgrade must still work at the cap — it adds no entry.
  L.corpusAdd('t1', 'text 1', 1001, PB);
  eq('upgrade still applies when full', L.laneCorpus.get('t1').lokad, CT);
}

{
  console.log('\n-- reopenIndexIfUnanswered: done+no hits is not coverage --');
  const L = makeLane();
  L.state.terms = [{ q: 'firma', on: true, mode: 'word', mute: false }];
  L.setSaved({ [CT]: { ranges: [[0, 188, 100]], pagesDone: 188, numPages: 188, numTxs: 9400, done: true } });
  L.setDeepDone(true);
  for (let i = 0; i < 10; i++) L.corpusAdd('old' + i, 'nothing here', 1000 + i, CT);
  ok('punches when the cache cannot answer', L.reopenIndexIfUnanswered() === true);
  ok('deepDone cleared', L.deepDone === false);
  eq('ranges emptied so page 0 is readable', L.savedCursor[CT].ranges, []);
  eq('done is false', L.savedCursor[CT].done, false);
  eq('numPages kept', L.savedCursor[CT].numPages, 188);
  L.corpusAdd('hit', 'I prefer #firma more', 9e12, CT);
  ok('a local hit is not punched again', L.reopenIndexIfUnanswered() === false);
  const fresh = makeLane();
  fresh.state.terms = [{ q: 'firma', on: true, mode: 'word', mute: false }];
  ok('a fresh cache is not punched — the walk just starts', fresh.reopenIndexIfUnanswered() === false);
}

// ------------------------------------------ quota: shrink, never drop it all --
{
  console.log('\n-- saveLaneStore under quota: shrink and keep the NEWEST --');
  const mkRows = (L, n) => { for (let i = 0; i < n; i++) L.corpusAdd('id' + i, 'message body number ' + i + ' with some padding text', 1000 + i, CT); };

  // Roomy: everything fits, nothing is reported as lost.
  const roomy = makeLane();
  mkRows(roomy, 200);
  roomy.setBf({ [CT]: { page: 4, pagesDone: 4, numPages: 188, oldestTs: 1000, done: false } });
  roomy.saveLaneStore();
  eq('fits: all rows stored', JSON.parse(roomy.raw()).corpus.length, 200);
  eq('fits: nothing reported trimmed', roomy.trimmed, 0);

  // Tight: must shrink rather than throw the entry away.
  const tight = makeLane(9000);
  mkRows(tight, 200);
  tight.setBf({ [CT]: { page: 4, pagesDone: 4, numPages: 188, oldestTs: 1000, done: false } });
  tight.saveLaneStore();
  const kept = JSON.parse(tight.raw());
  ok('tight: the entry SURVIVES', tight.raw() !== null);
  ok('tight: fewer rows than offered', kept.corpus.length < 200 && kept.corpus.length > 0,
     'kept ' + kept.corpus.length);
  eq('tight: the cursor is intact — the expensive half is never the casualty', kept.cursor[CT].page, 4);
  eq('tight: trimmed count is exact', tight.trimmed, 200 - kept.corpus.length);
  eq('tight: stored payload is within budget', kept && JSON.stringify(kept).length <= 9000, true);
  // The trim must take from the OLD end: the corpus is a window from the newest
  // backwards and the reach line claims everything from now back to its date.
  const ts = kept.corpus.map(r => r[2]);
  eq('tight: newest row kept', Math.max(...ts), 1199);
  ok('tight: rows are newest-first', ts.every((v, i, a) => i === 0 || a[i - 1] >= v));
  ok('tight: the OLDEST row is the one dropped', !kept.corpus.some(r => r[2] === 1000));

  // Hopeless: not even one row fits -> take nothing, never a cursor alone.
  const hopeless = makeLane(120);
  mkRows(hopeless, 50);
  hopeless.setBf({ [CT]: { page: 4, pagesDone: 4, numPages: 188, oldestTs: 1000, done: false } });
  hopeless.saveLaneStore();
  ok('hopeless: nothing stored at all', hopeless.raw() === null);
  eq('hopeless: reports every row lost', hopeless.trimmed, 50);
  ok('hopeless: NO cursor left behind without its corpus', hopeless.raw() === null);

  // A later roomy save must clear the flag rather than latch it.
  tight.localStorage.setItem = (k, v) => { /* roomy again */ };
  tight.saveLaneStore();
  eq('recovered: trimmed resets to 0', tight.trimmed, 0);
}

// -------------------------------------------- composer chips from the topics --
{
  console.log('\n-- cmpChipList: the reader\'s own topics, enabled first --');
  const L = makeLane();
  eq('no topics -> the emoji starters, unchanged', L.cmpChipList(), CMP_CHIPS);

  L.state.terms = [{ q: 'gm', on: true, mute: false }];
  eq('one topic leads, emoji fill the rest',
     L.cmpChipList(), ['gm', ...CMP_CHIPS.slice(0, CMP_CHIP_MAX - 1)]);

  L.state.terms = [
    { q: 'off-topic', on: false, mute: false },
    { q: 'live', on: true, mute: false },
    { q: 'spam', on: true, mute: true },        // muted: never suggested
    { q: 'gm', on: true, mute: false },
  ];
  eq('enabled before disabled, mute excluded',
     L.cmpChipList().slice(0, 3), ['live', 'gm', 'off-topic']);
  ok('a muted word is never offered', !L.cmpChipList().includes('spam'));

  L.state.terms = [
    { q: 'a', on: true, mute: false }, { q: 'b', on: true, mute: false },
    { q: 'c', on: true, mute: false }, { q: 'd', on: true, mute: false },
    { q: 'e', on: true, mute: false }, { q: 'f', on: true, mute: false },
    { q: 'g', on: true, mute: false }, { q: 'h', on: true, mute: false },
  ];
  eq('capped at CMP_CHIP_MAX', L.cmpChipList().length, CMP_CHIP_MAX);
  ok('no emoji filler once the cap is met by topics',
     L.cmpChipList().every(x => !CMP_CHIPS.includes(x)));

  L.state.terms = [{ q: 'gm 🌅', on: true, mute: false }];
  eq('a topic equal to a default is not offered twice',
     L.cmpChipList().filter(x => x === 'gm 🌅').length, 1);
  eq('and the list is still full length', L.cmpChipList().length, CMP_CHIP_MAX);

  L.state.terms = [{ q: '', on: true, mute: false }, { q: 'ok', on: true, mute: false }];
  ok('an empty term is skipped', !L.cmpChipList().includes(''));

  /* The _mine guard. Re-stated rather than lifted: it is one expression inside
     sendTry(), which is 90 lines of DOM and network. The rule is the whole
     point — a message that IS a followed term is a word the reader chose because
     strangers write it, so it cannot be evidence of authorship. */
  console.log('\n-- content-match arming: a bare topic word is not evidence --');
  const arms = (terms, msg) =>
    !!msg && !terms.some(t => t.q && !t.mute && t.q.toLowerCase() === msg.toLowerCase());
  const terms = [{ q: 'gm', on: true, mute: false }, { q: 'scam', on: true, mute: true }];
  ok('bare topic word -> REFUSED', arms(terms, 'gm') === false);
  ok('different case, still refused', arms(terms, 'GM') === false);
  ok('topic word plus real writing -> armed', arms(terms, 'gm everyone, ship day') === true);
  ok('the chip flow the reader described is unaffected', arms(terms, 'gm 🌅 from Flow') === true);
  ok('an unrelated message -> armed', arms(terms, 'hello there') === true);
  ok('empty message -> nothing to arm', arms(terms, '') === false);
  ok('a MUTED word is not a topic, so it arms', arms(terms, 'scam') === true);
  ok('no topics at all -> arms as before', arms([], 'gm') === true);
}

// ------------------------------------------------------- the date window ----
{
  console.log('\n-- inRange: a result with no date is EXCLUDED, never assumed in --');
  const L = makeLane();
  const T = Date.UTC(2026, 0, 15);
  ok('no window -> everything passes', L.inRange(T) === true);
  ok('no window -> even an undated row passes', L.inRange(null) === true);
  L.setRange({ from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 31) });
  ok('inside', L.inRange(T) === true);
  ok('before the start', L.inRange(Date.UTC(2025, 11, 31)) === false);
  ok('after the end', L.inRange(Date.UTC(2026, 1, 1)) === false);
  ok('exactly at the start is IN', L.inRange(Date.UTC(2026, 0, 1)) === true);
  ok('exactly at the end is IN', L.inRange(Date.UTC(2026, 0, 31)) === true);
  ok('one ms before the start is out', L.inRange(Date.UTC(2026, 0, 1) - 1) === false);
  ok('one ms after the end is out', L.inRange(Date.UTC(2026, 0, 31) + 1) === false);
  ok('undated is out once a window exists', L.inRange(null) === false);
  ok('ts 0 is treated as undated, not as 1970', L.inRange(0) === false);
  L.setRange({ from: Date.UTC(2026, 0, 1), to: null });
  ok('open-ended "since" accepts anything newer', L.inRange(Date.UTC(2030, 0, 1)) === true);
  ok('and still rejects older', L.inRange(Date.UTC(2025, 0, 1)) === false);
  L.setRange({ from: null, to: Date.UTC(2026, 0, 31) });
  ok('open-ended "until" accepts anything older', L.inRange(Date.UTC(2000, 0, 1)) === true);
  L.setRange({ from: null, to: null });
  ok('cleared -> back to everything', L.rangeActive() === false);

  console.log('\n-- a calendar day is a DAY: the ends are inclusive --');
  const s = L.dayStart('2026-01-15'), e = L.dayEnd('2026-01-15');
  ok('start is local midnight', new Date(s).getHours() === 0 && new Date(s).getMinutes() === 0);
  ok('end is the last ms of the same day', new Date(e).getDate() === new Date(s).getDate());
  ok('end is after start', e > s);
  ok('a whole day is covered', (e - s) > 86399000 && (e - s) < 86400000);
  ok('garbage in -> null, never NaN posing as a date', L.dayStart('nope') === null);
  ok('empty in -> null', L.dayStart('') === null);
  L.setRange({ from: s, to: e });
  ok('every instant of that day is inside', L.inRange(s + 12 * 3600e3) === true);

  console.log('\n-- corpusMatches under a window --');
  const W = makeLane();
  W.state.terms = [{ q: 'gm', on: true, mode: 'word', mute: false }];
  W.corpusAdd('in1', 'gm one', Date.UTC(2026, 0, 10), CT);
  W.corpusAdd('in2', 'gm two', Date.UTC(2026, 0, 20), CT);
  W.corpusAdd('old', 'gm old', Date.UTC(2025, 0, 10), CT);
  W.corpusAdd('nod', 'gm undated', null, CT);
  let r = W.corpusMatches();
  eq('no window: all four', r.ids.length, 4);
  eq('and none reported undated', r.noDate.size, 0);
  W.setRange({ from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 31) });
  r = W.corpusMatches();
  eq('window: only the two inside', r.ids.sort(), ['in1', 'in2']);
  eq('the undated one is counted', [...r.noDate], ['nod']);
  eq('the merely-old one is NOT counted as undated', r.noDate.size, 1);
  // Scope and window are two different reasons, and one checkbox undoes only one.
  W.corpusAdd('pb', 'gm paybutton', Date.UTC(2026, 0, 12), PB);
  r = W.corpusMatches();
  eq('out-of-scope stays a scope miss, not a date miss', [...r.hidden], ['pb']);
  eq('and the date count is untouched by it', r.noDate.size, 1);
}

// -------------------------------------------------------- topic suggestions --
{
  console.log('\n-- senderTag: stable, and it tells senders apart --');
  const L0 = makeLane();
  ok('same script -> same tag', L0.senderTag('76a914aa88ac') === L0.senderTag('76a914aa88ac'));
  ok('different script -> different tag', L0.senderTag('76a914aa88ac') !== L0.senderTag('76a914bb88ac'));
  ok('null in -> null out', L0.senderTag(null) === null);
  ok('eight hex characters', /^[0-9a-f]{8}$/.test(L0.senderTag('76a914aa88ac')));

  /* THE MEASURED FAILURE, reproduced as a test. Over 1,000 real Cashtab
     messages the frequency ranking returned a casino bot's vocabulary; the
     sender floor is what removes it. Both halves are asserted, because a change
     that quietly drops the floor would put `casino` back at the top. */
  console.log('\n-- tier 3: a campaign is not a topic --');
  const L = makeLane();
  const add = (i, text, sender) => L.corpusAdd('tx' + i, text, 1700000000000 + i * 1000, CT, sender);
  let i = 0;
  /* FILLER FIRST, and it is not padding: with only two groups every word sits
     above the 30% ceiling and is dropped before the sender floor is ever
     consulted, so the test would pass while testing nothing. A hundred unrelated
     messages put the two groups at realistic shares — casino at 25%, under the
     ceiling, so the SENDER floor is what has to exclude it. */
  for (let k = 0; k < 100; k++) add(i++, 'zulu' + k + ' yankee' + k + ' xray' + k, 'filler' + k);
  // one bot, 40 near-identical messages, all from ONE sender
  for (let k = 0; k < 40; k++) add(i++, 'congratulations you win free credit at the casino ' + k, 'bot00001');
  // twenty different people saying thanks
  for (let k = 0; k < 20; k++) add(i++, 'thanks for the help friend ' + k, 'human' + String(k).padStart(3, '0'));
  const s = L.computeSuggestions();
  const terms = s.map(x => x.term);
  ok('the bot word is NOT suggested', !terms.includes('casino'), JSON.stringify(terms));
  ok('nor its siblings', !terms.includes('credit') && !terms.includes('congratulations'), JSON.stringify(terms));
  ok('the word many people wrote IS suggested', terms.includes('thanks'), JSON.stringify(terms));
  ok('at most SUGGEST_MAX chips', s.length <= 8, 'got ' + s.length);

  console.log('\n-- tiers, and what each one excludes --');
  const M = makeLane();
  let j = 0;
  const addM = (text, sender) => M.corpusAdd('m' + (j++), text, 1700000000000 + j * 1000, CT, sender);
  for (let k = 0; k < 100; k++) addM('zulu' + k + ' yankee' + k + ' xray' + k, 'f' + k);
  for (let k = 0; k < 6; k++) addM('trading #firma today number ' + k, 'p' + k);
  for (let k = 0; k < 6; k++) addM('look at FIRMA and BTX now ' + k, 'q' + k);
  for (let k = 0; k < 6; k++) addM('sent to ecash:qz3m3pu6e45tjvwqdzfmz4pylstajdu7qck90dhw89 ok ' + k, 'r' + k);
  const out = M.computeSuggestions();
  const names = out.map(x => x.term);
  ok('a hashtag is offered, # included', names.includes('#firma'), JSON.stringify(names));
  ok('hashtags rank first', out[0] && out[0].tier === 1, JSON.stringify(out.slice(0, 2)));
  ok('a shouted ticker is offered as written', names.includes('FIRMA'), JSON.stringify(names));
  ok('the same word is not offered twice in two cases',
     names.filter(x => x.toLowerCase() === 'firma').length === 1, JSON.stringify(names));
  ok('nothing longer than SUGGEST_MAX_LEN', names.every(x => x.length <= 20), JSON.stringify(names));
  ok('an address never becomes a topic',
     !names.some(x => x.includes('ecash:') || x.length > 20), JSON.stringify(names));
  ok('hashtags need df 2, everything else 3',
     out.every(x => x.n >= (x.tier === 1 ? 2 : 3)), JSON.stringify(out));

  console.log('\n-- suggestions respect what is already a topic, and the scope --');
  const S = makeLane();
  let z = 0;
  for (let k = 0; k < 60; k++) S.corpusAdd('s' + (z++), 'zulu' + k + ' yankee' + k, 1700000000000 + k, CT, 'w' + k);
  for (let k = 0; k < 8; k++) S.corpusAdd('s' + (z++), 'alpha bravo charlie ' + k, 1700000000000 + k, CT, 'u' + k);
  for (let k = 0; k < 8; k++) S.corpusAdd('s' + (z++), 'delta echo foxtrot ' + k, 1700000000000 + k, PB, 'v' + k);
  eq('out-of-scope words are not mined', S.computeSuggestions().some(x => x.term === 'delta'), false);
  S.state.terms = [{ q: 'alpha', on: true, mute: false }, { q: 'bravo', on: true, mute: true }];
  const after = S.computeSuggestions().map(x => x.term);
  ok('a word already followed is not re-offered', !after.includes('alpha'), JSON.stringify(after));
  ok('a MUTED word is never offered', !after.includes('bravo'), JSON.stringify(after));

  console.log('\n-- an empty corpus offers nothing rather than guessing --');
  eq('no corpus -> no chips', makeLane().computeSuggestions(), []);

  console.log('\n-- hashtag gates: df 2, two senders, soft cap 4 --');
  const T = makeLane();
  let ti = 0;
  const addT = (text, sender) => T.corpusAdd('t' + (ti++), text, 1700000000000 + ti * 1000, CT, sender);
  for (let k = 0; k < 100; k++) addT('zulu' + k + ' yankee' + k + ' xray' + k, 'fill' + k);
  addT('see #newtag once a', 'a1');
  addT('see #newtag once b', 'a2');
  const two = T.computeSuggestions();
  ok('df=2 two senders is offered', two.some(x => x.term === '#newtag'), JSON.stringify(two.map(x => x.term)));
  const U = makeLane();
  let ui = 0;
  const addU = (text, sender) => U.corpusAdd('u' + (ui++), text, 1700000000000 + ui * 1000, CT, sender);
  for (let k = 0; k < 100; k++) addU('zulu' + k + ' yankee' + k + ' xray' + k, 'fill' + k);
  addU('only #solo here a', 'botx');
  addU('only #solo here b', 'botx');
  ok('df=2 one sender is NOT offered',
     !U.computeSuggestions().some(x => x.term === '#solo'),
     JSON.stringify(U.computeSuggestions().map(x => x.term)));
  const V = makeLane();
  let vi = 0;
  const addV = (text, sender) => V.corpusAdd('v' + (vi++), text, 1700000000000 + vi * 1000, CT, sender);
  for (let k = 0; k < 100; k++) addV('zulu' + k + ' yankee' + k + ' xray' + k, 'fill' + k);
  addV('once #onceonly a', 'c1');
  addV('different body no tag', 'c2');
  ok('df=1 is not offered even with two senders nearby',
     !V.computeSuggestions().some(x => x.term === '#onceonly'),
     JSON.stringify(V.computeSuggestions().map(x => x.term)));

  const W2 = makeLane();
  let wi = 0;
  const addW = (text, sender) => W2.corpusAdd('w' + (wi++), text, 1700000000000 + wi * 1000, CT, sender);
  for (let k = 0; k < 100; k++) addW('zulu' + k + ' yankee' + k + ' xray' + k, 'fill' + k);
  for (let t = 0; t < 10; t++){
    addW('talk #' + 'tag' + t + ' first ' + t, 'sa' + t);
    addW('talk #' + 'tag' + t + ' second ' + t, 'sb' + t);
  }
  for (let k = 0; k < 6; k++) addW('look at FIRMA and BTX now ' + k, 'sh' + k);
  for (let k = 0; k < 6; k++) addW('thanks for the help friend ' + k, 'hu' + k);
  const mixed = W2.computeSuggestions();
  const mixedTags = mixed.filter(x => x.tier === 1);
  const mixedRest = mixed.filter(x => x.tier !== 1);
  ok('soft cap: at most 4 hashtags when other tiers exist',
     mixedTags.length <= 4, JSON.stringify(mixed.map(x => x.term)));
  ok('shout or word still appears beside the tags',
     mixedRest.length >= 1, JSON.stringify(mixed.map(x => x.term + ':' + x.tier)));
  eq('same corpus, same chips (no oscillation)',
     W2.computeSuggestions().map(x => x.term), mixed.map(x => x.term));

  const X = makeLane();
  let xi = 0;
  const addX = (text, sender) => X.corpusAdd('x' + (xi++), text, 1700000000000 + xi * 1000, CT, sender);
  for (let k = 0; k < 100; k++) addX('zulu' + k + ' yankee' + k + ' xray' + k, 'fill' + k);
  for (let t = 0; t < 10; t++){
    addX('#' + 'tag' + t + ' uniq' + t + 'a', 'ya' + t);
    addX('#' + 'tag' + t + ' uniq' + t + 'b', 'yb' + t);
  }
  const onlyTags = X.computeSuggestions();
  ok('8/8 hashtags only when tiers 2/3 are empty',
     onlyTags.length === 8 && onlyTags.every(x => x.tier === 1),
     JSON.stringify(onlyTags.map(x => x.term + ':' + x.tier)));
}

// ------------------------------------------------- hashtag detection bounds --
{
  /* linkifyTags walks the DOM, so it cannot be lifted here — but the thing that
     decides WHAT becomes a tag is HASHTAG_RE plus the offset arithmetic that
     turns a match into a start index, and both are pure. Re-stated with the
     shipped pattern quoted out of the page, so a change to the regex fails here.
     The offset matters: the pattern carries a leading boundary character, so the
     tag starts at the '#', not at match.index. */
  console.log('\n-- what counts as a hashtag --');
  const RE = new RegExp(mod.match(/const HASHTAG_RE = (\/.*?\/[gu]+);/)[1].slice(1).replace(/\/[gu]+$/, ''), 'gu');
  const tags = (s) => {
    RE.lastIndex = 0;
    const out = []; let m;
    while ((m = RE.exec(s)) !== null){
      const start = m.index + m[0].length - (m[1].length + 1);
      out.push([s.slice(start, start + m[1].length + 1), start]);
    }
    return out;
  };
  eq('plain tag', tags('gm #firma today').map(x => x[0]), ['#firma']);
  eq('at the very start', tags('#firma rules').map(x => x[0]), ['#firma']);
  eq('the offset points at the #', tags('gm #firma').map(x => x[1]), [3]);
  eq('two in a row', tags('#a1 and #b2').map(x => x[0]), ['#a1', '#b2']);
  eq('after a bracket', tags('(#firma)').map(x => x[0]), ['#firma']);
  eq('after punctuation', tags('wow,#firma!').map(x => x[0]), ['#firma']);
  eq('MID-WORD is not a tag', tags('hash#firma').map(x => x[0]), []);
  eq('a bare # is not a tag', tags('cost # each').map(x => x[0]), []);
  eq('one character is too short', tags('#a here').map(x => x[0]), []);
  eq('two characters is enough', tags('#ab here').map(x => x[0]), ['#ab']);
  eq('digits count', tags('#2026 goals').map(x => x[0]), ['#2026']);
  eq('underscore counts', tags('#a_b ok').map(x => x[0]), ['#a_b']);
  eq('non-Latin script', tags('xin chào #tiếng').map(x => x[0]), ['#tiếng']);
  eq('stops at punctuation', tags('#firma, and').map(x => x[0]), ['#firma']);
  eq('no false positive in a url fragment', tags('see http://x.y/a#b now').map(x => x[0]), []);
  /* THE BOUNDARY IS "NOT A WORD CHARACTER", and these are the cases that proved
     an enumerated list of punctuation was wrong: a message card wraps text in
     typographic quotes, so a tag at the START of a message sat after “ and was
     silently not linkified while the same tag mid-sentence was — and match.js
     matched it either way, so the search found a tag the reader could not tap. */
  eq('after a typographic quote', tags('\u201c#firma does it pay?\u201d').map(x => x[0]), ['#firma']);
  eq('after a straight quote', tags('"#firma" said').map(x => x[0]), ['#firma']);
  eq('after a dash', tags('a-#firma').map(x => x[0]), ['#firma']);
  eq('after an emoji', tags('\u{1F680}#firma').map(x => x[0]), ['#firma']);
  eq('two tags, one at the very start', tags('\u201c#xecx vs #firma\u201d').map(x => x[0]), ['#xecx', '#firma']);
  // A tag long enough to be an id rather than a topic still matches the regex;
  // the 30-char bound in the pattern is what stops a hash being swallowed whole.
  ok('a 64-char hex hash is not taken as one tag',
     tags('#' + 'a'.repeat(64)).every(x => x[0].length <= 31), JSON.stringify(tags('#' + 'a'.repeat(64))));
}

// --------------------------------------------------------- hashtag matching --
{
  /* match.js is a real module, so this drives the shipped code directly. The
     defect being pinned: word mode drops '#', so before this a `#firma` topic
     matched bare `firma` anywhere — including inside `hash#firma` — and the
     highlight marked the bare word, telling the reader the wrong reason. */
  console.log('\n-- a #term matches hashtags, and nothing else --');
  const H = 'gm #firma and #FIRMA. also firma alone, plus hash#firma inline.';
  const m = (t, o) => matchTerm(H, t, o || { mode: 'word' });
  ok('the hashtag matches', m('#firma') === true);
  ok('case does not matter', m('#FIRMA') === true);
  ok('a bare word in the text is NOT a hashtag match',
     matchTerm('just firma here', '#firma', { mode: 'word' }) === false);
  ok('mid-word # is not a hashtag', matchTerm('hash#firma only', '#firma', { mode: 'word' }) === false);
  ok('a tag that is not there', m('#nothere') === false);
  ok('# alone is not a term', m('#') === false);
  ok('empty after the # is not a term', matchTerm(H, '#', { mode: 'word' }) === false);
  ok('a plain term still behaves exactly as before',
     matchTerm('just firma here', 'firma', { mode: 'word' }) === true);
  ok('contains mode cannot smuggle a bare word past it',
     matchTerm('just firma here', '#firma', { mode: 'contains' }) === false);

  console.log('\n-- the highlight marks the # too --');
  const sp = findTermSpans(H, '#firma', { mode: 'word' });
  eq('two spans', sp.length, 2);
  eq('and each one includes the hash', sp.map(([a, b]) => H.slice(a, b)), ['#firma', '#FIRMA']);
  ok('never marks the bare word', !sp.some(([a, b]) => H.slice(a, b) === 'firma'));

  console.log('\n-- fold still applies inside a tag --');
  ok('folded', matchTerm('xin chào #tiếng', '#tieng', { mode: 'word', fold: true }) === true);
  ok('unfolded', matchTerm('xin chào #tiếng', '#tieng', { mode: 'word', fold: false }) === false);

  console.log('\n-- at the very start of a message --');
  ok('leading hashtag matches', matchTerm('#firma leads', '#firma', { mode: 'word' }) === true);
  eq('and its span starts at 0', findTermSpans('#firma leads', '#firma', { mode: 'word' }), [[0, 6]]);

  console.log('\n-- mixed terms merge without swallowing each other --');
  const all = findAllSpans(H, [{ q: '#firma', on: true }, { q: 'alone', on: true }]);
  eq('three spans', all.length, 3);
  ok('a tag span and a word span stay distinct',
     all.some(([a, b]) => H.slice(a, b) === '#firma') && all.some(([a, b]) => H.slice(a, b) === 'alone'),
     JSON.stringify(all.map(([a, b]) => H.slice(a, b))));
}

// ------------------------------------------------- ordering: newest at the end --
{
  /* THE REPORTED BUG. A transaction still in the mempool has no block timestamp
     and often no timeFirstSeen either, so stampTs() writes no tx.ts — and the
     old laneTsOf() read that as 0, "the oldest thing here", which put the newest
     arrivals at the TOP of a list that reads oldest-first. */
  console.log('\n-- laneTsOf: a live arrival is NOW, not 1970 --');
  const L = makeLane();
  const NOW = Date.now();
  const live   = { id: 'live',  firstSeenLocal: NOW };                       // mempool: no ts at all
  const older  = { id: 'older', ts: NOW - 3600e3 };                          // confirmed an hour ago
  const oldest = { id: 'old2',  ts: NOW - 7200e3 };
  const hist   = { id: 'hist',  _hist: true, firstSeenLocal: NOW, ts: NOW - 86400e3 };
  const ghost  = { id: 'ghost', _hist: true, firstSeenLocal: NOW };          // backfilled, no chain time
  ok('a mempool tx sorts as now, not 0', L.laneTsOf('live', live) >= NOW - 50);
  eq('a confirmed tx keeps its block time', L.laneTsOf('older', older), NOW - 3600e3);
  eq('a historical tx uses its chain time, never parse time', L.laneTsOf('hist', hist), NOW - 86400e3);
  eq('a backfilled tx with no chain time is still unknown', L.laneTsOf('ghost', ghost), 0);
  ok('live is newer than the hour-old one', L.laneTsOf('live', live) > L.laneTsOf('older', older));

  console.log('\n-- laneSetMatched: oldest first, newest last --');
  L.setTxs(new Map([['live', live], ['older', older], ['old2', oldest]]));
  L.laneSetMatched(['live', 'older', 'old2']);
  eq('display order is oldest -> newest', L.state.matched, ['old2', 'older', 'live']);
  ok('the live arrival is LAST, where the reader is looking',
     L.state.matched[L.state.matched.length - 1] === 'live');
  // the same shape for a mempool tx that predates the page: identical path, so
  // it must land in the same place rather than at the top.
  const preboot = { id: 'preboot', firstSeenLocal: NOW - 1000 };
  L.setTxs(new Map([['preboot', preboot]]));
  L.laneSetMatched(['live', 'older', 'old2', 'preboot']);
  eq('a pre-existing mempool tx sorts by arrival too, not to the top',
     L.state.matched, ['old2', 'older', 'preboot', 'live']);
  ok('and neither undated row leads the list', L.state.matched[0] === 'old2');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
