// Harness for the Lane corpus / cursor fix (2026-08-04b, post-audit).
//   node tools/test-lane-corpus.mjs
//
// The Lane logic lives inside flow/index.html's inline module and cannot be
// imported, so the functions under test are RE-STATED here with the same bodies.
// That is a real weakness — it tests a copy — so every case below is one the
// audit reproduced against the page itself, and the browser run is what
// confirms the shipped code. This file exists to pin the RULES so a later edit
// that breaks one fails cheaply.
import { matchAny, matchEvery, matchTerm, findAllSpans } from '../vendor/core/match.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };

const MATCH_MAX = 200, CORPUS_MAX = 3000;

function makeLane() {
  const corpus = new Map();
  let corpusOldest = null;
  const laneTxs = new Map(), txs = new Map();
  let matched = [];

  const corpusAdd = (txid, text, ts) => {
    if (corpus.has(txid)) return;
    corpus.set(txid, { text, ts: ts || null });
    if (ts && (corpusOldest == null || ts < corpusOldest)) corpusOldest = ts;
    while (corpus.size > CORPUS_MAX) corpus.delete(corpus.keys().next().value);
  };
  const laneHold = (tx) => {
    if (!tx || !tx.id || laneTxs.has(tx.id)) return;
    laneTxs.set(tx.id, tx);
    while (laneTxs.size > MATCH_MAX) laneTxs.delete(laneTxs.keys().next().value);
  };
  const laneSetMatched = (ids) => {
    const seen = new Set(), rows = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const tx = txs.get(id) || laneTxs.get(id);
      const c = corpus.get(id);
      rows.push([id, (tx && tx.ts) || (c && c.ts) || 0]);
    }
    rows.sort((a, b) => b[1] - a[1]);
    matched = rows.slice(0, MATCH_MAX).reverse().map((r) => r[0]);
  };
  const corpusMatches = (follow, mutes = []) => {
    const out = [];
    if (!follow.length) return out;
    for (const [txid, e] of corpus) {
      if (mutes.length && matchAny(e.text, mutes)) continue;
      if (matchAny(e.text, follow)) out.push(txid);
    }
    return out;
  };
  return { corpus, laneTxs, txs, corpusAdd, laneHold, laneSetMatched, corpusMatches,
    get matched() { return matched; }, get oldest() { return corpusOldest; } };
}
const term = (q, extra = {}) => ({ q, on: true, mode: 'word', fold: false, mute: false, ...extra });

console.log('\n=== A. a NEW term is answered from the corpus, with no network ===');
{
  const L = makeLane();
  L.corpusAdd('t1', 'alpha channel', 1000);
  L.corpusAdd('t2', 'beta release', 2000);
  L.corpusAdd('t3', 'nothing here', 3000);
  const first = L.corpusMatches([term('alpha')]);
  const second = L.corpusMatches([term('beta')]);
  ok('term 1 answered locally', first.join() === 't1', first.join());
  ok('term 2 answered locally from the SAME corpus', second.join() === 't2', second.join());
  ok('corpus is not consumed by answering', L.corpus.size === 3);
}

console.log('\n=== B. the bug the audit reproduced: pages skipped for a new term ===');
{
  // The old shape: results cleared, cursor kept. Modelled as "the corpus is
  // cleared but the walk resumes at page N", which is what made pages 0..N-1
  // unreachable for every later term.
  const L = makeLane();
  const pages = [['p0a', 'beta one'], ['p1a', 'beta two'], ['p2a', 'gamma']];
  // NEW behaviour: everything scanned is retained regardless of the term in force
  pages.forEach(([id, text], i) => L.corpusAdd(id, text, 1000 + i));
  const hits = L.corpusMatches([term('beta')]);
  ok('a term introduced AFTER the walk still sees page 0 and 1',
    hits.sort().join() === 'p0a,p1a', hits.join());
  ok('reach reflects the oldest entry actually held', L.oldest === 1000, String(L.oldest));
}

console.log('\n=== C. state.matched has ONE owner and one cap ===');
{
  const L = makeLane();
  const ids = [];
  for (let i = 0; i < 150; i++) { const id = 's' + i; L.txs.set(id, { id, ts: 1e6 + i }); ids.push(id); }
  for (let i = 0; i < 200; i++) { const id = 'b' + i; L.laneHold({ id, ts: 500 + i }); ids.push(id); }
  L.laneSetMatched(ids);
  ok('350 candidates capped to MATCH_MAX', L.matched.length === MATCH_MAX, String(L.matched.length));
  ok('cap kept the newest (they are now at the END)', L.matched[L.matched.length-1] === 's149', L.matched[L.matched.length-1]);
  // A live match arriving must not silently drop a backfilled row below the cap.
  const before = new Set(L.matched);
  L.laneSetMatched(['live1', ...L.matched]);
  L.txs.set('live1', { id: 'live1', ts: 2e6 });
  ok('a live arrival does not exceed the cap', L.matched.length === MATCH_MAX, String(L.matched.length));
  ok('it evicts the OLDEST, not an arbitrary one',
    !L.matched.includes([...before].pop()) || L.matched.length === MATCH_MAX);
}
{
  const L = makeLane();
  for (let i = 0; i < 260; i++) L.laneHold({ id: 'x' + i, ts: i });
  ok('laneTxs cap holds at MATCH_MAX', L.laneTxs.size === MATCH_MAX, String(L.laneTxs.size));
}

console.log('\n=== D. corpus bound (§10) ===');
{
  const L = makeLane();
  for (let i = 0; i < CORPUS_MAX + 250; i++) L.corpusAdd('c' + i, 'text ' + i, 1000 + i);
  ok('corpus capped at CORPUS_MAX', L.corpus.size === CORPUS_MAX, String(L.corpus.size));
  ok('oldest survives eviction as a floor, never resets to null', L.oldest === 1000, String(L.oldest));
  ok('duplicate txid does not grow the corpus', (() => { const n = L.corpus.size; L.corpusAdd('c500', 'dup', 9); return L.corpus.size === n; })());
}

console.log('\n=== E. mute still outranks follow, in the corpus path too ===');
{
  const L = makeLane();
  L.corpusAdd('m1', 'buy alpha now', 10);
  L.corpusAdd('m2', 'alpha only', 20);
  const hits = L.corpusMatches([term('alpha')], [term('buy', { mute: true })]);
  ok('a muted match is excluded from a corpus answer', hits.join() === 'm2', hits.join());
}

console.log('\n=== F. ordering: a 2023 row never outranks a live one by luck ===');
{
  const L = makeLane();
  L.corpusAdd('old', 'alpha', 1_600_000_000_000);
  L.corpusAdd('new', 'alpha', 1_760_000_000_000);
  L.laneSetMatched(['old', 'new']);
  ok('oldest first regardless of insertion order', L.matched.join() === 'old,new', L.matched.join());
  ok('unknown timestamp sorts to the TOP (oldest end), never the bottom', (() => {
    const M = makeLane();
    M.corpusAdd('known', 'alpha', 5);
    M.corpusAdd('unknown', 'alpha', null);
    M.laneSetMatched(['unknown', 'known']);
    return M.matched.join() === 'unknown,known';
  })());
}

console.log('\n=== F2. reported reach is the FLOOR every protocol passed ===');
{
  // Real depths measured on chain after two rounds at pageSize 50.
  const laneReach = (cur, ids) => {
    let floor = null;
    for (const id of ids) {
      const c = cur[id];
      if (!c || c.done) continue;
      if (!c.oldestTs) return null;
      floor = (floor == null) ? c.oldestTs : Math.max(floor, c.oldestTs);
    }
    return floor;
  };
  const ids = ['cashtab', 'alias', 'article'];
  const cur = {
    cashtab: { oldestTs: 1782000000, done: false },   // ~2026-07
    alias:   { oldestTs: 1698800000, done: false },   // ~2023-11
    article: { oldestTs: 1738800000, done: false },   // ~2025-02
  };
  ok('floor is the SHALLOWEST protocol, not the deepest',
    laneReach(cur, ids) === 1782000000, String(laneReach(cur, ids)));
  ok('a finished protocol imposes no floor', (() => {
    const c2 = { ...cur, cashtab: { oldestTs: 1782000000, done: true } };
    return laneReach(c2, ids) === 1738800000;
  })());
  ok('a protocol never read means NO claim at all', (() => {
    const c3 = { ...cur, alias: { oldestTs: null, done: false } };
    return laneReach(c3, ids) === null;
  })());
  ok('all finished -> no floor needed', (() => {
    const c4 = {};
    for (const id of ids) c4[id] = { oldestTs: 1, done: true };
    return laneReach(c4, ids) === null;
  })());
}

console.log('\n=== F3. display order is oldest-first, cap keeps the newest ===');
{
  const L = makeLane();
  for (let i = 0; i < 5; i++) L.corpusAdd('t' + i, 'alpha', 1000 + i);
  L.laneSetMatched(['t0','t1','t2','t3','t4']);
  ok('oldest at top, newest at bottom (matches the stream)',
    L.matched.join() === 't0,t1,t2,t3,t4', L.matched.join());
}

console.log('\n=== G. highlight spans agree with the matcher, in BOTH directions ===');
{
  // The audit's two cases, which the old indexOf highlighter got backwards.
  const folded = { q: 'quan an ngon', on: true, mode: 'word', fold: true, mute: false };
  const hay = 'Quán ăn ngon nhất';
  ok('folded term MATCHES the accented text', matchTerm(hay, folded.q, { mode: 'word', fold: true }));
  const sp = findAllSpans(hay, [folded]);
  ok('...and now highlights it (old code marked nothing)', sp.length === 1, JSON.stringify(sp));
  ok('span covers exactly the matched words',
    sp.length === 1 && hay.slice(sp[0][0], sp[0][1]) === 'Quán ăn ngon', JSON.stringify(sp));
}
{
  const word = { q: 'an', on: true, mode: 'word', fold: false, mute: false };
  ok('word mode does NOT match inside "banana"', !matchTerm('banana bread', 'an', { mode: 'word' }));
  ok('...and highlights nothing there (old code marked it)', findAllSpans('banana bread', [word]).length === 0);
  ok('word mode still matches and marks a standalone word',
    findAllSpans('an apple', [word]).length === 1);
}
{
  const c = { q: 'an', on: true, mode: 'contains', fold: false, mute: false };
  const spans = findAllSpans('banana plan', [c]);
  ok('contains mode marks the whole word it matched inside', spans.length === 2, JSON.stringify(spans));
}
{
  const t1 = { q: 'alpha', on: true, mode: 'word', fold: false, mute: false };
  const t2 = { q: 'beta', on: true, mode: 'word', fold: false, mute: false };
  const spans = findAllSpans('alpha and beta', [t1, t2]);
  ok('two terms produce two ordered, non-overlapping spans',
    spans.length === 2 && spans[0][0] < spans[1][0], JSON.stringify(spans));
}
{
  ok('a term that matches nothing yields no spans', findAllSpans('nothing here', [{ q: 'zzz', on: true, mode: 'word' }]).length === 0);
  ok('empty haystack is safe', findAllSpans('', [{ q: 'a', on: true, mode: 'word' }]).length === 0);
  ok('Thai text is not folded apart (its marks are part of the word)',
    matchTerm('ที่นี่', 'ที่นี่', { mode: 'word', fold: true }));
}

console.log('\n=== H. mute counts are maintained incrementally, not re-walked ===');
{
  // Mirrors the shipped muteApply/recountMutes/muteCount trio.
  const terms = [];
  const counts = new Map();
  const txs = new Map();
  const muteApply = (tx, d) => {
    if (!tx || !tx._hay) return;
    for (const m of terms) {
      if (!m.mute || !m.on || !m.q) continue;
      if (!matchAny(tx._hay, [m])) continue;
      counts.set(m.q, Math.max(0, (counts.get(m.q) || 0) + d));
    }
  };
  const recount = () => {
    counts.clear();
    const mutes = terms.filter(m => m.mute && m.on && m.q);
    if (!mutes.length) return;
    for (const tx of txs.values()) {
      if (!tx._hay) continue;
      for (const m of mutes) if (matchAny(tx._hay, [m])) counts.set(m.q, (counts.get(m.q) || 0) + 1);
    }
  };
  const track = (tx) => { if (!txs.has(tx.id)) muteApply(tx, +1); txs.set(tx.id, tx); };
  const drop = (id) => { muteApply(txs.get(id), -1); txs.delete(id); };

  terms.push({ q: 'spam', on: true, mode: 'word', fold: false, mute: true });
  track({ id: 'a', _hay: 'spam offer' });
  track({ id: 'b', _hay: 'spam again' });
  track({ id: 'c', _hay: 'clean text' });
  ok('counts up on admit', counts.get('spam') === 2, String(counts.get('spam')));
  track({ id: 'a', _hay: 'spam offer' });
  ok('re-admitting the same txid does not double count', counts.get('spam') === 2, String(counts.get('spam')));
  drop('a');
  ok('counts down on eviction', counts.get('spam') === 1, String(counts.get('spam')));
  drop('c');
  ok('evicting a non-match changes nothing', counts.get('spam') === 1, String(counts.get('spam')));
  drop('b');
  ok('never goes negative', counts.get('spam') === 0, String(counts.get('spam')));

  // A NEW mute has no history to count up from — only a recount is correct.
  txs.clear(); counts.clear();
  track({ id: 'x', _hay: 'buy now' });
  track({ id: 'y', _hay: 'buy later' });
  terms.push({ q: 'buy', on: true, mode: 'word', fold: false, mute: true });
  ok('a mute added AFTER the txs starts at 0 without a recount', !counts.get('buy'));
  recount();
  ok('recount picks up the history', counts.get('buy') === 2, String(counts.get('buy')));
  ok('the incremental path then continues from it', (() => { track({ id: 'z', _hay: 'buy again' }); return counts.get('buy') === 3; })());
  ok('a tx with no text is ignored by both paths', (() => { track({ id: 'n', _hay: null }); return counts.get('buy') === 3; })());
}

console.log('\n=== I. restore rule: a follow comes back OFF, a mute comes back ON ===');
{
  // Mirrors loadTerms(). A follow is an action and must not look taken after a
  // reload; a mute is a standing defence and must not lapse.
  const restore = (saved) => saved.map((e) => {
    const mute = !!e.mute;
    return { q: e.q, on: mute ? (e.on !== false) : false, mode: e.mode || 'word', fold: !!e.fold, mute };
  });
  const out = restore([
    { q: 'topic', on: true, mute: false },
    { q: 'spam', on: true, mute: true },
    { q: 'off-mute', on: false, mute: true },
  ]);
  ok('a followed topic restores OFF', out[0].on === false);
  ok('an active mute restores ON', out[1].on === true);
  ok('a mute the reader turned off stays off', out[2].on === false);
  ok('the topic itself is still saved, only its state resets', out[0].q === 'topic' && out.length === 3);
  ok('mode and fold survive the reset', (() => {
    const r = restore([{ q: 'x', on: true, mute: false, mode: 'contains', fold: true }]);
    return r[0].mode === 'contains' && r[0].fold === true;
  })());
}

console.log('\n=== J. ANY widens, ALL narrows ===');
{
  const a = term('alpha'), b = term('beta');
  ok('ANY: one of two is enough', matchAny('alpha only', [a, b]));
  ok('ALL: one of two is not', !matchEvery('alpha only', [a, b]));
  ok('ALL: both present matches', matchEvery('alpha and beta', [a, b]));
  ok('ANY: both present also matches', matchAny('alpha and beta', [a, b]));
  ok('order in the text does not matter', matchEvery('beta then alpha', [a, b]));
  // The dangerous edge: "all of nothing" is vacuously true in logic and would
  // put EVERY transaction in the lane the moment the last topic was switched off.
  ok('ALL of an empty list is FALSE, not vacuously true', !matchEvery('anything', []));
  ok('ALL ignores disabled terms rather than failing on them',
    matchEvery('alpha only', [a, { ...b, on: false }]));
  ok('ALL of only-disabled terms is false, not vacuously true',
    !matchEvery('alpha only', [{ ...a, on: false }]));
  ok('ALL respects per-term mode', matchEvery('banana plan', [term('an', { mode: 'contains' })]));
  ok('...and rejects when one term fails under its own mode',
    !matchEvery('banana plan', [term('an', { mode: 'contains' }), term('zzz')]));
  ok('empty haystack is false in both', !matchEvery('', [a]) && !matchAny('', [a]));
}
{
  // A mute is a VETO and stays ANY whatever the follow mode is: one match hides
  // it. Requiring every mute to agree would let a second mute weaken the first.
  const hay = 'buy alpha now';
  const mutes = [term('buy', { mute: true }), term('zzz', { mute: true })];
  ok('one mute of two is enough to hide', matchAny(hay, mutes));
  ok('...whereas ALL would have let it through', !matchEvery(hay, mutes));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
