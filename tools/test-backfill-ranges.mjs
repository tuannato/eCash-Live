// Harness for the ranged cursor + date bounds + the page_size=1 seek (R3).
//   node tools/test-backfill-ranges.mjs
//
// backfill.js is DOM-free, storage-free and dependency-free, so unlike the Lane
// this is the REAL module imported and driven — no extraction, no re-statement.
// The chronik client is a mock serving a synthetic newest-first index, which is
// the one property the real one was measured to have (strictly descending, no
// overlap between pages; verified live at pages 0-3 and probes at 47/94/141/187).
import { createBackfill } from '../vendor/core/backfill.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const DAY = 86400;
const T0 = 1786500000;              // "now" for the synthetic index

/** newest-first index: entry i is i days older than T0. */
function makeIndex(id, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ txid: id + '-' + String(i).padStart(6, '0'), ts: T0 - i * DAY });
  return out;
}
function mockChronik(indexes, log) {
  return {
    lokadId(id) {
      return {
        async history(page, size) {
          if (log) log.push({ id, page, size });
          const all = indexes[id] || [];
          const start = page * size;
          const slice = all.slice(start, start + size);
          return {
            numTxs: all.length,
            numPages: Math.max(1, Math.ceil(all.length / size)),
            txs: slice.map((t) => ({
              txid: t.txid, timeFirstSeen: 0, block: { timestamp: t.ts },
              outputs: [{ outputScript: '6a' }],
            })),
          };
        },
      };
    },
  };
}
const parse = (d) => ({ id: d.txid, ts: Number(d.block.timestamp) });
const mk = (indexes, opts = {}, log = null) => createBackfill({
  chronik: mockChronik(indexes, log), lokads: Object.keys(indexes),
  parse, pageSize: opts.pageSize || 50, ...opts,
});

// ------------------------------------------------- ranges: merge and prefix --
{
  console.log('\n-- ranges: consecutive pages merge into one run --');
  const idx = { A: makeIndex('A', 500) };            // 10 pages at 50
  const bf = mk(idx);
  await bf.run({ requests: 3 });
  const c = bf.cursor.A;
  eq('three pages read as one range', c.ranges.map((r) => [r[0], r[1]]), [[0, 3]]);
  eq('pagesDone', c.pagesDone, 3);
  eq('numPages seen', c.numPages, 10);
  eq('numTxs seen', c.numTxs, 500);
  ok('not done — seven pages left', c.done === false);
  // The range carries the oldest timestamp INSIDE it, which is what a reach
  // claim reads; page 2 ends at entry 149.
  eq('range oldestTs is the deepest entry read', c.ranges[0][2], T0 - 149 * DAY);
  await bf.run({ requests: 7 });
  const d = bf.cursor.A;
  eq('the whole index is one range', d.ranges.map((r) => [r[0], r[1]]), [[0, 10]]);
  ok('done only once the run from 0 covers numPages', d.done === true);
}

// ------------------------------------------------------ minTs stop condition --
{
  console.log('\n-- minTs: stops the QUESTION, never claims the index is done --');
  const idx = { A: makeIndex('A', 500) };
  const bf = mk(idx);
  const cov = await bf.run({ requests: 10, minTs: T0 - 120 * DAY });
  const c = cov.perLokad.A;
  ok('rangeDone set', c.rangeDone === true);
  ok('done is NOT set — the index was never exhausted', c.done === false);
  ok('overall done is false', cov.done === false);
  // Page 2 spans entries 100..149, so it is the first to cross 120 days back.
  eq('stopped on the page that crossed the bound', c.pagesDone, 3);
  eq('and read no further', c.ranges.map((r) => [r[0], r[1]]), [[0, 3]]);
  // A later run without the bound must be free to continue.
  await bf.run({ requests: 2 });
  eq('an unbounded run resumes past it', bf.cursor.A.ranges.map((r) => [r[0], r[1]]), [[0, 5]]);
}

// ------------------------------------------------------------------- seek ----
{
  console.log('\n-- seek: bisect on rank at page_size 1 --');
  const n = 9392;                                   // the real Cashtab figure
  const idx = { A: makeIndex('A', n) };
  const log = [];
  const bf = mk(idx, {}, log);
  const target = T0 - 4000 * DAY;
  const page = await bf.seek('A', target);
  const probes = log.filter((r) => r.size === 1).length;
  eq('landed on the page holding the target', page, Math.floor(4000 / 50));
  ok('probe count is logarithmic, not linear', probes <= Math.ceil(Math.log2(n)) + 2,
     'probes=' + probes);
  ok('every probe asked for ONE transaction', log.every((r) => r.size === 1));
  eq('reported apart from page requests', bf.coverage.probes, probes);

  console.log('\n-- seek: the ends --');
  const b2 = mk({ A: makeIndex('A', n) });
  eq('a target newer than everything -> page 0', await b2.seek('A', T0 + DAY), 0);
  const last = await b2.seek('A', T0 - (n + 500) * DAY);
  eq('a target older than everything -> the last page', last, Math.floor((n - 1) / 50));
  const b3 = mk({ A: [] });
  ok('an empty index seeks to nothing', (await b3.seek('A', T0)) === null);
}

// -------------------------------------------- maxTs: a window in the past ----
{
  console.log('\n-- maxTs: read a window without walking to it --');
  const idx = { A: makeIndex('A', 5000) };
  const log = [];
  const bf = mk(idx, {}, log);
  await bf.run({ requests: 2 });                    // a little from the top first
  const beforePages = log.filter((r) => r.size === 50).length;
  await bf.run({ requests: 3, maxTs: T0 - 3000 * DAY, minTs: T0 - 3200 * DAY });
  const c = bf.cursor.A;
  const pages = c.ranges.map((r) => [r[0], r[1]]);
  eq('two runs on the record, not one', pages.length, 2);
  eq('the prefix is still what was read from the top', pages[0], [0, 2]);
  ok('the second run starts near the seek target', pages[1][0] === Math.floor(3000 / 50),
     JSON.stringify(pages));
  ok('total page requests stayed inside the budget', log.filter((r) => r.size === 50).length <= beforePages + 3);
  ok('done is false — the middle was never read', c.done === false);

  console.log('\n-- the reach claim may only read the prefix --');
  // The deep window holds far older transactions, and oldestTs sees them...
  ok('oldestTs knows about the deep window', c.oldestTs < T0 - 3000 * DAY);
  // ...but the run from page 0 must still speak only for its own 100 entries.
  eq('the prefix range still reports its own floor', c.ranges[0][2], T0 - 99 * DAY);

  console.log('\n-- dropping maxTs returns to the top --');
  await bf.run({ requests: 1 });
  const back = bf.cursor.A.ranges.map((r) => [r[0], r[1]]);
  eq('the prefix extended, not the deep window', back[0], [0, 3]);
}

// ------------------------------------------------- skip what is already read --
{
  console.log('\n-- a walk never pays for a page twice --');
  const idx = { A: makeIndex('A', 500) };
  const log = [];
  const bf = mk(idx, {}, log);
  await bf.run({ requests: 2, maxTs: T0 - 150 * DAY });   // seek to page 3, read 3-4
  await bf.run({ requests: 6 });                          // then walk from the top
  const pagesRead = log.filter((r) => r.size === 50).map((r) => r.page);
  const dupes = pagesRead.filter((p, i) => pagesRead.indexOf(p) !== i);
  eq('no page fetched twice', dupes, []);
  const c = bf.cursor.A;
  ok('the prefix swallowed the deep window once they met',
     c.ranges.length === 1 || c.ranges[0][1] >= 3, JSON.stringify(c.ranges));
}

// ------------------------------------------------------------ load / migrate --
{
  console.log('\n-- load: the v1 watermark and the ranges shape --');
  const idx = { A: makeIndex('A', 500) };
  const bf = mk(idx);
  bf.load({ A: { page: 4, pagesDone: 4, numPages: 10, numTxs: 500, oldestTs: T0 - 199 * DAY } });
  const c = bf.cursor.A;
  eq('v1 page:4 becomes [0,4)', c.ranges.map((r) => [r[0], r[1]]), [[0, 4]]);
  eq('and keeps the depth it recorded', c.ranges[0][2], T0 - 199 * DAY);
  await bf.run({ requests: 1 });
  eq('the walk resumes at page 4, not 0', bf.cursor.A.ranges.map((r) => [r[0], r[1]]), [[0, 5]]);

  const b2 = mk({ A: makeIndex('A', 500) });
  b2.load({ A: { ranges: [[0, 2, T0], [7, 9, T0 - 400 * DAY]], numPages: 10, numTxs: 500 } });
  eq('a ranges save round-trips', b2.cursor.A.ranges.map((r) => [r[0], r[1]]), [[0, 2], [7, 9]]);
  await b2.run({ requests: 1 });
  eq('and the walk extends the PREFIX', b2.cursor.A.ranges.map((r) => [r[0], r[1]]), [[0, 3], [7, 9]]);

  const b3 = mk({ A: makeIndex('A', 500) });
  b3.load({ A: { ranges: [[0, 999, T0]], numPages: 10 } });
  eq('anything past numPages is clamped, not trusted',
     b3.cursor.A.ranges.map((r) => [r[0], r[1]]), [[0, 10]]);
  ok('and that counts as done', b3.cursor.A.done === true);

  const b4 = mk({ A: makeIndex('A', 500) });
  b4.load({ A: { ranges: [[5, 5], [3, 1], ['x', 2], null, [0, 2, T0]], numPages: 10 } });
  eq('malformed intervals are dropped', b4.cursor.A.ranges.map((r) => [r[0], r[1]]), [[0, 2]]);

  const b5 = mk({ A: makeIndex('A', 500) });
  b5.load({ B: { page: 3 } });
  eq('an unknown lokad cannot resurrect itself', b5.cursor.A.ranges, []);
}

// ------------------------------------------------- a hole is never a range ---
{
  console.log('\n-- a failed page is a hole, and holes are not coverage --');
  let calls = 0;
  const chronik = {
    lokadId() {
      return { async history(page, size) {
        calls++;
        if (page === 1) throw new Error('node down');
        const all = makeIndex('A', 500);
        const slice = all.slice(page * size, page * size + size);
        return { numTxs: 500, numPages: 10, txs: slice.map((t) => ({ txid: t.txid, timeFirstSeen: 0, block: { timestamp: t.ts }, outputs: [{ outputScript: '6a' }] })) };
      } };
    },
  };
  const bf = createBackfill({ chronik, lokads: ['A'], parse, pageSize: 50 });
  const cov = await bf.run({ requests: 3 });
  const c = cov.perLokad.A;
  eq('the failed page is NOT recorded as read', c.ranges.map((r) => [r[0], r[1]]), [[0, 1], [2, 3]]);
  eq('the hole is counted', cov.holeCount, 1);
  ok('and the prefix stops at the hole', c.ranges[0][1] === 1);
  ok('so done stays false', c.done === false);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
