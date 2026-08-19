// Harness for createResultStore (commit 5, S1–S7).
//   node tools/test-result-store.mjs
//
// New file, not an extension of test-lane-corpus.mjs: that suite extracts the
// door and pins rematch / mute / terms through it. These assertions are about
// the hold and the answer in isolation, with tsOf and wanted supplied by the
// test — the same shape neo will use.
//
// Mutation table (each row is a one-line edit that must turn the named
// assertion red; confirmed against this file):
//
//   S1  hold() replaces on a duplicate id
//       → "first object wins (witnessed TTF not swapped for _hist)"
//   S2  eviction is oldest-by-tsOf alone (drop the unwanted-first pass)
//       → "2023 window: all 95 wanted rows stay"  (6a49e3a)
//   S3  skip the while (size > cap) loop
//       → "hold cannot pass the cap"
//   S4  matchedTotal = matched.length  (record AFTER the slice)
//       → "total is the uncapped count"
//   S5  omit .reverse()  OR  slice from the oldest end
//       → "display is oldest-first, newest last"
//          / "cap kept the newest"
//   S6a default tsOf to (id, tx) => tx && tx.ts
//       → "no default tsOf: factory throws" never reached;
//         a mempool card then sorts as 1970 (84dc6fd)
//   S6b default wanted to () => true
//       → "no default wanted: factory throws" never reached;
//         the 2023 window then renders zero (6a49e3a again)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createResultStore } from '../vendor/core/result-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function store(over = {}) {
  const tsOf = over.tsOf || ((id, tx) => (tx && tx.ts) || 0);
  const wanted = over.wanted || ((tx) => !tx || tx.wanted !== false);
  return createResultStore({ max: over.max ?? 8, tsOf, wanted });
}

// ------------------------------------------------------------------ S6
console.log('-- S6: tsOf and wanted are required; no defaults --');
{
  let threw = false;
  try { createResultStore({ max: 8 }); }
  catch (e) { threw = /required/.test(e && e.message); }
  ok('no default tsOf/wanted: factory throws', threw);
  threw = false;
  try { createResultStore({ max: 8, tsOf: (id, tx) => tx && tx.ts }); }
  catch (e) { threw = /required/.test(e && e.message); }
  ok('tsOf alone is not enough', threw);
  threw = false;
  try { createResultStore({ max: 8, wanted: () => true }); }
  catch (e) { threw = /required/.test(e && e.message); }
  ok('wanted alone is not enough', threw);
  threw = false;
  try { createResultStore(); }
  catch (e) { threw = /required/.test(e && e.message); }
  ok('empty options throw', threw);
}

// ------------------------------------------------------------------ S1
console.log('\n-- S1: hold refuses to replace; first object wins --');
{
  const S = store();
  const live = { id: 'x', ts: 1, ttf: 123, _hist: false, el: 'stream-el' };
  const fetched = { id: 'x', ts: 2, ttf: null, _hist: true, el: 'fetched-el' };
  S.hold(live);
  S.hold(fetched);
  eq('size stays 1', S.size, 1);
  ok('first object wins (witnessed TTF not swapped for _hist)', S.get('x') === live);
  eq('ttf survived', S.get('x').ttf, 123);
  eq('held .el is still the stream element', S.get('x').el, 'stream-el');
  eq('fetched object was not mutated onto the hold', fetched.el, 'fetched-el');
  S.hold(null);
  S.hold({});
  eq('missing tx / missing id is a no-op', S.size, 1);
}

// ------------------------------------------------------------------ S2
console.log('\n-- S2: eviction takes the unwanted first, then the oldest --');
{
  // THE MEASURED BUG (6a49e3a). A Jun 2023 window + oldest-by-time eviction:
  // every wanted row IS the oldest thing held, so each was evicted the instant
  // it hydrated. Four real pages, 95 fetched, 0 rendered.
  const max = 20;
  const from = Date.UTC(2023, 5, 1), to = Date.UTC(2023, 5, 30);
  const S = store({
    max,
    tsOf: (id, tx) => tx.ts,
    wanted: (tx) => tx.ts >= from && tx.ts <= to,
  });
  for (let i = 0; i < max; i++) {
    S.hold({ id: 'recent' + i, ts: Date.UTC(2026, 0, 1) + i * 1000 });
  }
  eq('filled with out-of-window rows', S.size, max);
  for (let i = 0; i < 12; i++) {
    S.hold({ id: 'jun' + i, ts: Date.UTC(2023, 5, 10) + i * 1000 });
  }
  eq('still at max after the wanted arrived', S.size, max);
  ok('2023 window: all 12 wanted rows stay',
    Array.from({ length: 12 }, (_, i) => S.has('jun' + i)).every(Boolean));
  eq('unwanted recent rows left to make room',
    Array.from({ length: max }, (_, i) => S.has('recent' + i)).filter(Boolean).length,
    max - 12);
}
{
  // Distinguishes unwanted-first from FIFO. Full of WANTED, then an unwanted
  // arrives: FIFO evicts the first-inserted wanted; the shipped rule evicts
  // the unwanted.
  const max = 8;
  const S = store({ max, wanted: (tx) => tx.wanted !== false });
  for (let i = 0; i < max; i++) S.hold({ id: 'w' + i, ts: 1000 + i });
  S.hold({ id: 'unwanted', ts: 99_999, wanted: false });
  eq('unwanted-first: the out-of-scope arrival was evicted', S.has('unwanted'), false);
  ok('unwanted-first: every wanted row remains',
    Array.from({ length: max }, (_, i) => S.has('w' + i)).every(Boolean));
  eq('size still max', S.size, max);
}
{
  const max = 8;
  const S = store({ max });
  for (let i = 0; i < max; i++) S.hold({ id: 'r' + i, ts: 10_000 - i });
  S.hold({ id: 'newer', ts: 20_000 });
  eq('among wanted, the oldest-by-ts left', S.has('r' + (max - 1)), false);
  eq('first-inserted was the newest-by-ts and stayed', S.has('r0'), true);
  eq('the newer arrival entered', S.has('newer'), true);
}

// ------------------------------------------------------------------ S3
console.log('\n-- S3: the store owns the cap --');
{
  const S = store({ max: 5 });
  for (let i = 0; i < 20; i++) S.hold({ id: 'x' + i, ts: i });
  eq('hold cannot pass the cap', S.size, 5);
  const S0 = store({ max: 0 });
  S0.hold({ id: 'a', ts: 1 });
  S0.hold({ id: 'b', ts: 2 });
  eq('a zero max floors to 1', S0.size, 1);
}

// ------------------------------------------------------------------ S4
console.log('\n-- S4: one writer; total is recorded BEFORE the cap --');
{
  const S = store({ max: 5, tsOf: (id, tx) => (tx && tx.ts) || Number(String(id).slice(1)) || 0 });
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push('n' + i);
  S.setMatched([...ids, 'n0', 'n3']); // dupes
  eq('deduped then capped', S.matched.length, 5);
  eq('total is the uncapped count', S.matchedTotal, 12);
  eq('cap kept the newest', S.matched[S.matched.length - 1], 'n11');
  eq('the oldest left', S.matched.includes('n0'), false);
}

// ------------------------------------------------------------------ S5
console.log('\n-- S5: cap by recency, display oldest-first --');
{
  const S = store({ max: 10, tsOf: (id) => ({ t4: 4, t0: 0, t2: 2, t1: 1, t3: 3 }[id] ?? 0) });
  S.setMatched(['t4', 't0', 't2', 't1', 't3']);
  eq('display is oldest-first, newest last', S.matched, ['t0', 't1', 't2', 't3', 't4']);
  S.setMatched(['t0', 'unknown']);
  eq('unknown timestamp sorts to the oldest end', S.matched, ['unknown', 't0']);
}
{
  const S = store({ max: 3, tsOf: (id) => Number(id) });
  S.setMatched(['1', '5', '3', '9', '2']);
  eq('display oldest of the kept newest', S.matched, ['3', '5', '9']);
  eq('newest is last', S.matched[S.matched.length - 1], '9');
}

// ------------------------------------------------------------------ hold is not the live map
console.log('\n-- the store is not the live map --');
{
  const S = store({ max: 4, tsOf: (id) => ({ live: 9, corp: 1, held: 5 }[id] ?? 0) });
  S.hold({ id: 'held', ts: 5 });
  S.setMatched(['corp', 'held', 'live']);
  eq('answer can name ids the hold does not have', S.matched, ['corp', 'held', 'live']);
  eq('hold still has only what hold() was given', S.size, 1);
  ok('live id is not in the hold', !S.has('live'));
  ok('corpus id is not in the hold', !S.has('corp'));
}

// ------------------------------------------------------------------ S7
console.log('\n-- S7: door-free, and hold never touches .el --');
{
  const src = readFileSync(join(ROOT, 'vendor/core/result-store.js'), 'utf8');
  const hits = [];
  for (const re of [/state\./g, /document/g, /localStorage/g, /\$\(/g, /chronik/g, /requestAnimationFrame/g]) {
    const m = src.match(re);
    if (m) hits.push(...m);
  }
  eq('grep state.|document|localStorage|$(|chronik|requestAnimationFrame is empty', hits, []);
  ok('the module never writes .el', !/\.el\s*=/.test(src));
}
{
  const S = store({ max: 2 });
  const tx = new Proxy({ id: 'p', ts: 1 }, {
    get(t, k) {
      if (k === 'el') throw new Error('touched .el');
      return t[k];
    },
    set(t, k, v) {
      if (k === 'el') throw new Error('wrote .el');
      t[k] = v;
      return true;
    },
  });
  let threw = false;
  try { S.hold(tx); S.hold({ id: 'q', ts: 2 }); }
  catch { threw = true; }
  ok('hold does not read or write .el', !threw && S.has('p'));
}

// ------------------------------------------------------------------ clear
console.log('\n-- clear empties the hold, not the answer --');
{
  const S = store({ max: 4, tsOf: (id, tx) => (tx && tx.ts) || 1 });
  S.hold({ id: 'a', ts: 1 });
  S.setMatched(['a', 'b']);
  S.clear();
  eq('hold is empty', S.size, 0);
  eq('answer survives clear (door rematches)', S.matched.slice().sort(), ['a', 'b']);
  eq('total survives clear', S.matchedTotal, 2);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
