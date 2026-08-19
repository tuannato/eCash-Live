// Harness for createLaneStore read-merge-write (commit 4, R1–R8).
//   node tools/test-lane-store.mjs
//
// New file, not an extension of test-lane-scope.mjs: that suite extracts the
// door and pins picker/reach/quota through it. These assertions are about two
// writers over one adapter, and a door extraction would hide whether the store
// itself re-reads. The punch-is-session-only check is the one door fact, and
// it extracts reopenIndexIfUnanswered so a comment cannot satisfy it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LOKAD } from '../vendor/txparse.js';
import { createCorpus } from '../vendor/core/lane-corpus.js';
import { createLaneStore } from '../vendor/core/lane-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CT = LOKAD.CASHTAB_MSG, PB = LOKAD.PAYBUTTON, EC = LOKAD.ECASHCHAT_TX;
const KEY = 'ecashlive:flow:lane-cursor';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function mem(quotaChars = Infinity, { getThrows = false, raw = null } = {}) {
  const store = new Map();
  if (raw != null) store.set(KEY, raw);
  return {
    getItem: (k) => {
      if (getThrows) throw new Error('getItem boom');
      return store.has(k) ? store.get(k) : null;
    },
    setItem: (k, v) => {
      const s = String(v);
      if (s.length > quotaChars) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      store.set(k, s);
    },
    removeItem: (k) => { store.delete(k); },
    _map: store,
  };
}

function store(storage, max = 5000) {
  return createLaneStore({ storage, key: KEY, max });
}

function proto(over) {
  return Object.assign({
    ranges: [[0, 4, 1000, 2000]],
    pagesDone: 4,
    numPages: 188,
    numTxs: 9400,
    oldestTs: 1000,
    done: false,
    failed: false,
    rangeDone: false,
  }, over);
}

function row(id, text, ts, lokad, from) {
  const r = [id, text, ts];
  if (arguments.length >= 4) r.push(lokad);
  if (arguments.length >= 5) r.push(from);
  return r;
}

function rawOf(storage) {
  const s = storage.getItem(KEY);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function protoAt(storage, id) {
  const o = rawOf(storage);
  return (o && o.cursor && o.cursor[id]) || {};
}

// ------------------------------------------------------------------ R1
console.log('-- R1: interleaved writers do not lose work --');
{
  const storage = mem();
  const A = store(storage), B = store(storage);
  A.save({ cursor: { [CT]: proto({ ranges: [[0, 6, 900, 2000]], pagesDone: 6, numTxs: 9400 }) }, corpus: [row('a', 'from A', 2000, CT, 'aaaa')] });
  B.save({ cursor: { [PB]: proto({ ranges: [[0, 3, 800, 1800]], pagesDone: 3, numTxs: 18000, numPages: 368 }) }, corpus: [row('b', 'from B', 1800, PB, 'bbbb')] });
  const out = rawOf(storage);
  ok('Cashtab pages A recorded are still there', !!(out.cursor[CT] && out.cursor[CT].ranges[0][1] === 6));
  ok('PayButton pages B recorded are still there', !!(out.cursor[PB] && out.cursor[PB].ranges[0][1] === 3));
  ok('A\'s row survived B\'s save', out.corpus.some((r) => r[0] === 'a'));
  ok('B\'s row survived next to it', out.corpus.some((r) => r[0] === 'b'));
}
{
  // Same protocol, different pages, same numTxs — the shallower tab writes last.
  const storage = mem();
  const A = store(storage), B = store(storage);
  A.save({ cursor: { [CT]: proto({ ranges: [[0, 10, 500, 2000]], pagesDone: 10, numTxs: 9400 }) }, corpus: [row('n', 'near', 2000, CT)] });
  B.save({ cursor: { [CT]: proto({ ranges: [[60, 62, 50, 80]], pagesDone: 2, numTxs: 9400 }) }, corpus: [row('f', 'far', 80, CT)] });
  const r = rawOf(storage).cursor[CT].ranges;
  ok('prefix A paid for is still claimed', r.some((x) => x[0] === 0 && x[1] === 10));
  ok('seek window B paid for is still claimed', r.some((x) => x[0] === 60 && x[1] === 62));
}
{
  const storage = mem();
  const A = store(storage), B = store(storage);
  A.save({ cursor: { [CT]: proto({ ranges: [[0, 10, 500, 2000]], pagesDone: 10, numTxs: 9400 }) }, corpus: [row('n', 'near', 2000, CT)] });
  B.save({ cursor: { [CT]: proto({ ranges: [[0, 4, 900, 2000]], pagesDone: 4, numTxs: 9400 }) }, corpus: [row('n', 'near', 2000, CT)] });
  eq('a shallower tab does not un-claim', rawOf(storage).cursor[CT].ranges, [[0, 10, 500, 2000]]);
}

// ------------------------------------------------------------------ R2
console.log('\n-- R2: a punch does not shrink what storage claims --');
{
  const storage = mem();
  const A = store(storage), B = store(storage);
  const deep = proto({ ranges: [[0, 188, 100, 2000]], pagesDone: 188, numPages: 188, numTxs: 9400, done: true });
  A.save({ cursor: { [CT]: deep }, corpus: [row('old', 'nothing here', 1000, CT)] });
  const before = storage.getItem(KEY);
  B.save({
    cursor: { [CT]: { ranges: [], pagesDone: 0, numPages: 188, numTxs: 9400, oldestTs: null, done: false, failed: false, rangeDone: false } },
    corpus: [row('old', 'nothing here', 1000, CT)],
  });
  const after = rawOf(storage).cursor[CT];
  eq('stored ranges survived the punch', after.ranges, [[0, 188, 100, 2000]]);
  eq('stored done survived the punch', after.done, true);
  eq('stored pagesDone survived the punch', after.pagesDone, 188);
  ok('the payload is still the record of a read, not an unread', storage.getItem(KEY) !== null);
}

// ------------------------------------------------------------------ R3
console.log('\n-- R3: a growth-shift (higher numTxs) is not unioned with stale intervals --');
{
  const storage = mem();
  const A = store(storage), B = store(storage);
  A.save({ cursor: { [CT]: proto({ ranges: [[0, 12, 111, 222]], pagesDone: 12, numTxs: 9400 }) }, corpus: [row('x', 'x', 222, CT)] });
  // v2.7.0 shift: 50 new ranks → [0,12) becomes [1,12) at numTxs 9450 (delta 50, size 50 → lead 1 tail 1, so [1,13) at exact page; here a 1-rank shift).
  B.save({ cursor: { [CT]: proto({ ranges: [[1, 12, 111, 222]], pagesDone: 11, numTxs: 9450, done: false }) }, corpus: [row('x', 'x', 222, CT)] });
  const c = rawOf(storage).cursor[CT];
  eq('post-shift intervals replaced the pre-shift ones', c.ranges, [[1, 12, 111, 222]]);
  eq('numTxs is the shifted total', c.numTxs, 9450);
  ok('the stale [0, 12) is gone — union would have kept page 0 claimed', !(c.ranges.some((r) => r[0] === 0)));
}
{
  // Inverse: the unshifted tab writes LAST. Same physical fact, other writer.
  const storage = mem();
  const A = store(storage), B = store(storage);
  A.save({ cursor: { [CT]: proto({ ranges: [[1, 12, 111, 222]], pagesDone: 11, numTxs: 9450 }) }, corpus: [row('x', 'x', 222, CT)] });
  B.save({ cursor: { [CT]: proto({ ranges: [[0, 12, 111, 222]], pagesDone: 12, numTxs: 9400 }) }, corpus: [row('x', 'x', 222, CT)] });
  const c = rawOf(storage).cursor[CT];
  eq('a stale later write does not restore page 0', c.ranges, [[1, 12, 111, 222]]);
  eq('higher numTxs still stands', c.numTxs, 9450);
}
{
  // Per-protocol: Cashtab shifted, PayButton untouched in the incoming cursor.
  const storage = mem();
  const A = store(storage), B = store(storage);
  A.save({
    cursor: {
      [CT]: proto({ ranges: [[0, 12, 111, 222]], numTxs: 9400 }),
      [PB]: proto({ ranges: [[0, 4, 300, 400]], numTxs: 18000, numPages: 368 }),
    },
    corpus: [row('x', 'x', 222, CT), row('p', 'p', 400, PB)],
  });
  B.save({
    cursor: { [CT]: proto({ ranges: [[1, 12, 111, 222]], numTxs: 9450 }) },
    corpus: [row('x', 'x', 222, CT)],
  });
  eq('shifted protocol took the new intervals', protoAt(storage, CT).ranges, [[1, 12, 111, 222]]);
  eq('the protocol the shifter did not touch survived', protoAt(storage, PB).ranges, [[0, 4, 300, 400]]);
}
{
  // Empty ranges + higher numTxs is a collapsed shift, not a punch.
  const storage = mem();
  const A = store(storage), B = store(storage);
  A.save({ cursor: { [CT]: proto({ ranges: [[0, 2, 100, 200]], numTxs: 100 }) }, corpus: [row('x', 'x', 200, CT)] });
  B.save({ cursor: { [CT]: { ranges: [], pagesDone: 0, numTxs: 100000, done: false } }, corpus: [row('x', 'x', 200, CT)] });
  eq('collapsed shift (empty ranges, higher numTxs) replaces, does not keep stale', rawOf(storage).cursor[CT].ranges, []);
  eq('and carries the new numTxs', rawOf(storage).cursor[CT].numTxs, 100000);
}

// ------------------------------------------------------------------ R4
console.log('\n-- R4: a protocol only storage knows about survives --');
{
  const storage = mem();
  const A = store(storage), B = store(storage);
  const wide = {
    [CT]: proto({ ranges: [[0, 4, 900, 1000]], numTxs: 5000 }),
    [PB]: proto({ ranges: [[0, 4, 800, 900]], numTxs: 5000, numPages: 368 }),
    [EC]: proto({ ranges: [[0, 4, 700, 800]], numTxs: 5000, numPages: 277 }),
  };
  A.save({ cursor: wide, corpus: [row('x', 'hello', 1000, CT)] });
  B.save({ cursor: { [CT]: proto({ ranges: [[0, 9, 400, 1000]], pagesDone: 9, numPages: 188, numTxs: 9392 }) }, corpus: [row('x', 'hello', 1000, CT)] });
  const after = (rawOf(storage) && rawOf(storage).cursor) || {};
  eq('all three still on record', Object.keys(after).sort(), [CT, EC, PB].sort());
  eq('Cashtab advanced', protoAt(storage, CT).ranges && protoAt(storage, CT).ranges[0] && protoAt(storage, CT).ranges[0][1], 9);
  eq('PayButton depth survived the narrowing', protoAt(storage, PB).pagesDone, 4);
  eq('eCashChat depth survived too', protoAt(storage, EC).pagesDone, 4);
}

// ------------------------------------------------------------------ R5
{
  /* COMMUTATIVITY. Two tabs do not take turns in an agreed order, so A-then-B
     and B-then-A must land on the same stored value. Nothing else in this suite
     would notice a merge that quietly favours whoever wrote last -- and that is
     precisely the bug the re-read exists to kill, wearing a different hat. */
  const ad1 = mem(), ad2 = mem();
  const seedA = { cash: proto({ ranges: [[0, 4, 100, 200]], numTxs: 9400, pagesDone: 4 }) };
  const seedB = { cash: proto({ ranges: [[4, 8, 50, 90]], numTxs: 9400, pagesDone: 4 }) };
  const rowsA = [['a', 'A', 300, null, null]];
  const rowsB = [['b', 'B', 200, null, null]];
  store(ad1).save({ cursor: seedA, corpus: rowsA });
  store(ad1).save({ cursor: seedB, corpus: rowsB });
  store(ad2).save({ cursor: seedB, corpus: rowsB });
  store(ad2).save({ cursor: seedA, corpus: rowsA });
  const one = JSON.parse(ad1.getItem(KEY)), two = JSON.parse(ad2.getItem(KEY));
  eq('R1 A-then-B and B-then-A agree on ranges',
     one.cursor.cash.ranges, two.cursor.cash.ranges);
  eq('R1 A-then-B and B-then-A agree on the corpus',
     one.corpus.map((r) => r[0]).sort(), two.corpus.map((r) => r[0]).sort());
}

console.log('\n-- R5: corpus is a union by txid, tags upgrade, newest-first, sliced to max --');
{
  const storage = mem();
  const A = store(storage), B = store(storage);
  A.save({ cursor: { [CT]: proto() }, corpus: [row('onlyA', 'a', 100, CT, 'fromA'), row('both', 'shared', 300)] });
  B.save({ cursor: { [CT]: proto() }, corpus: [row('onlyB', 'b', 200, PB, 'fromB'), row('both', 'shared', 300, CT, 'fromBoth')] });
  const rows = rawOf(storage).corpus;
  const byId = Object.fromEntries(rows.map((r) => [r[0], r]));
  ok('row only A had survived', !!byId.onlyA);
  ok('row only B had survived', !!byId.onlyB);
  eq('shared row upgraded lokad in place', byId.both[3], CT);
  eq('shared row upgraded from in place', byId.both[4], 'fromBoth');
  eq('newest-first', rows.map((r) => r[0]), ['both', 'onlyB', 'onlyA']);
}
{
  const storage = mem();
  const A = store(storage, 3), B = store(storage, 3);
  A.save({ cursor: { [CT]: proto() }, corpus: [row('t1', 'a', 1, CT), row('t2', 'a', 2, CT), row('t3', 'a', 3, CT)] });
  B.save({ cursor: { [CT]: proto() }, corpus: [row('t4', 'b', 4, CT), row('t5', 'b', 5, CT), row('t6', 'b', 6, CT)] });
  const rows = rawOf(storage).corpus;
  eq('union sliced to max, newest kept', rows.map((r) => r[0]), ['t6', 't5', 't4']);
  eq('exactly max rows', rows.length, 3);
}
{
  // dump() path, not a raw array — the door passes createCorpus.
  const storage = mem();
  const A = store(storage);
  const corp = createCorpus({ max: 50 });
  corp.add('id1', 'hello', 9, CT, 'abcd');
  A.save({ cursor: { [CT]: proto() }, corpus: corp });
  eq('dump() rows round-trip', rawOf(storage).corpus[0], ['id1', 'hello', 9, CT, 'abcd']);
}

// ------------------------------------------------------------------ R6
console.log('\n-- R6: quota shrink still works; a re-read failure is not quota --');
{
  const mk = (n) => Array.from({ length: n }, (_, i) => row('id' + i, 'message body number ' + i + ' with some padding text', 1000 + i, CT));
  const tight = mem(9000);
  const S = store(tight);
  S.save({ cursor: { [CT]: proto({ page: 4, pagesDone: 4 }) }, corpus: mk(200) });
  const kept = rawOf(tight);
  ok('tight: the entry SURVIVES', kept !== null);
  ok('tight: fewer rows than offered', kept.corpus.length < 200 && kept.corpus.length > 0, 'kept ' + (kept && kept.corpus.length));
  eq('tight: the cursor is intact', kept.cursor[CT].page, 4);
  eq('tight: trimmed count is exact', S.trimmed, 200 - kept.corpus.length);
  const ts = kept.corpus.map((r) => r[2]);
  eq('tight: newest row kept', Math.max(...ts), 1199);
  ok('tight: rows are newest-first', ts.every((v, i, a) => i === 0 || a[i - 1] >= v));
  ok('tight: the OLDEST row is the one dropped', !kept.corpus.some((r) => r[2] === 1000));
}
{
  const hopeless = mem(120);
  const S = store(hopeless);
  S.save({
    cursor: { [CT]: proto() },
    corpus: Array.from({ length: 50 }, (_, i) => row('id' + i, 'message body number ' + i + ' with some padding text', 1000 + i, CT)),
  });
  ok('hopeless: nothing stored at all', hopeless.getItem(KEY) === null);
  eq('hopeless: reports every row lost', S.trimmed, 50);
}
{
  // Corrupt JSON in the key. If parse lived inside the shrink loop, this throw
  // would be read as quota and, at n <= 1, removeItem the key.
  const storage = mem(Infinity, { raw: '{not-json' });
  const S = store(storage);
  const payload = S.save({ cursor: { [CT]: proto() }, corpus: [row('ok', 'still here', 1, CT)] });
  ok('corrupt storage is not mistaken for quota: save kept a payload', payload !== null);
  const rewritten = rawOf(storage);
  eq('and the key was rewritten, not removed', rewritten && rewritten.corpus && rewritten.corpus[0] && rewritten.corpus[0][0], 'ok');
}
{
  const storage = mem(Infinity, { getThrows: true });
  const S = store(storage);
  const payload = S.save({ cursor: { [CT]: proto() }, corpus: [row('ok', 'still here', 1, CT)] });
  ok('getItem throw is not mistaken for quota', payload !== null);
  let landed = null;
  try { landed = JSON.parse(storage._map.get(KEY) || 'null'); } catch { landed = null; }
  eq('the write landed', landed && landed.corpus && landed.corpus[0] && landed.corpus[0][0], 'ok');
}

// ------------------------------------------------------------------ R7
console.log('\n-- R7: floor of one row, one stored value, clear() still destroys --');
{
  const storage = mem();
  const S = store(storage);
  const payload = S.save({ cursor: { [CT]: proto() }, corpus: [row('a', 'a', 1, CT), row('b', 'b', 2, CT)] });
  eq('shape is {v, cursor, corpus}', Object.keys(payload).sort(), ['corpus', 'cursor', 'v']);
  eq('version stays 1', payload.v, 1);
  ok('one key', storage._map.size === 1);
  S.clear();
  ok('clear() removes the key', storage.getItem(KEY) === null);
  ok('clear() forgets lastCursor', S.cursor === null);
  eq('clear() resets trimmed', S.trimmed, 0);
  const after = S.save({ cursor: { [CT]: proto() }, corpus: [row('c', 'c', 3, CT)] });
  ok('a save after clear writes a fresh value', after && after.corpus[0][0] === 'c');
}

// ------------------------------------------------------------------ R8
console.log('\n-- R8: lane-store.js stays door-free --');
{
  const src = readFileSync(join(ROOT, 'vendor/core/lane-store.js'), 'utf8');
  const hits = [];
  for (const re of [/state\./g, /document/g, /localStorage/g, /\$\(/g]) {
    const m = src.match(re);
    if (m) hits.push(...m);
  }
  eq('grep state.|document|localStorage|$( is empty', hits, []);
}

// ----------------------------------------------------- door: punch is session-only
console.log('\n-- door: reopenIndexIfUnanswered punches memory, not storage --');
{
  const html = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
  const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];
  function grab(name) {
    const at = mod.indexOf('function ' + name + '(');
    if (at === -1) throw new Error('not found: ' + name);
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
  const body = grab('reopenIndexIfUnanswered');
  ok('the shipped body does not call saveLaneStore', !body.includes('saveLaneStore'));
  ok('the shipped body still empties ranges in memory', body.includes('ranges: []'));

  const CORPUS_MAX = Number(mod.match(/const CORPUS_MAX = (\d+)/)[1]);
  const storage = mem();
  const laneStore = store(storage);
  const laneCorpus = createCorpus({ max: CORPUS_MAX });
  for (let i = 0; i < 10; i++) laneCorpus.add('old' + i, 'nothing here', 1000 + i, CT);
  const deep = { [CT]: { ranges: [[0, 188, 100]], pagesDone: 188, numPages: 188, numTxs: 9400, done: true } };
  laneStore.save({ cursor: deep, corpus: laneCorpus });
  const before = storage.getItem(KEY);
  const door = new Function(
    'CT', 'CORPUS_MAX', 'laneCorpus', 'deep',
    `
    const state = { laneScope: [CT], terms: [{ q: 'firma', on: true, mode: 'word', mute: false }] };
    let laneSavedCursor = JSON.parse(JSON.stringify(deep));
    let laneBf = null, laneDeepDone = true, laneRangeDone = false;
    const enabledTerms = () => state.terms.filter((t) => t.on && t.q && !t.mute);
    const corpusMatches = () => laneCorpus.matches({
      terms: enabledTerms(), mutes: [], scope: state.laneScope, range: { from: null, to: null }, mode: 'any',
    });
    ${body}
    return {
      reopenIndexIfUnanswered,
      get saved() { return laneSavedCursor; },
      get deepDone() { return laneDeepDone; },
    };
    `
  )(CT, CORPUS_MAX, laneCorpus, deep);
  ok('punches when the cache cannot answer', door.reopenIndexIfUnanswered() === true);
  eq('in-memory ranges emptied so page 0 is readable', door.saved[CT].ranges, []);
  eq('in-memory done is false', door.saved[CT].done, false);
  eq('in-memory numPages kept', door.saved[CT].numPages, 188);
  eq('in-memory numTxs kept', door.saved[CT].numTxs, 9400);
  ok('deepDone cleared', door.deepDone === false);
  eq('storage is byte-identical to before the punch', storage.getItem(KEY), before);
  const stored = rawOf(storage).cursor[CT];
  eq('storage ranges still claim the walk', stored.ranges, [[0, 188, 100]]);
  eq('storage done still true', stored.done, true);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
