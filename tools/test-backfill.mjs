// Harness for vendor/core/backfill.js (Phase 4a, 2026-08-04b).
//   node tools/test-backfill.mjs
//
// Drives the engine with a STUB chronik client, outside any browser. That is
// also the proof it is neo-adoptable: if it ever needs a DOM, a real client or
// storage, this file stops running.
import { createBackfill, MAX_PAGE_SIZE } from '../vendor/core/backfill.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };

/** spec: { pages: {id: [[txid,...], ...]}, fail?: [{id,page}] } */
function stub(spec) {
  const calls = [];
  return {
    calls,
    lokadId(id) {
      return {
        async history(page, size) {
          calls.push({ id, page, size });
          if ((spec.fail || []).some((f) => f.id === id && f.page === page)) throw new Error('boom');
          const pages = spec.pages[id] || [];
          if (page >= pages.length) return { txs: [], numPages: pages.length, numTxs: 0 };
          const baseTs = (spec.ts && spec.ts[id]) || 1700000000;
          const step = (spec.step && spec.step[id]) || 0;
          return {
            txs: pages[page].map((t) => ({ txid: t, timeFirstSeen: String(baseTs - page * step) })),
            numPages: pages.length,
            numTxs: pages.flat().length,
          };
        },
      };
    },
  };
}
const parse = (d) => ({ id: d.txid });

console.log('\n=== A. multi-page walk across lokads ===');
{
  const c = stub({ pages: { A: [['a1', 'a2'], ['a3']], B: [['b1']] } });
  const got = [];
  const bf = createBackfill({ chronik: c, lokads: ['A', 'B'], parse, onBatch: (t) => got.push(...t.map((x) => x.id)) });
  const cov = await bf.run({ requests: 10 });
  ok('every page of both ids walked', got.join() === 'a1,a2,b1,a3', got.join());
  ok('each unread protocol is read before any is read twice', c.calls.map((x) => x.id + x.page).join() === 'A0,B0,A1', c.calls.map((x) => x.id + x.page).join());
  ok('both marked done', cov.done === true);
  ok('scanned counted', cov.scanned === 4, String(cov.scanned));
  ok('page size clamped to chronik MAX_HISTORY_PAGE_SIZE', c.calls[0].size === MAX_PAGE_SIZE);
}

console.log("\n=== B. dedupe across shifting pages (chronik's own rev_history caveat) ===");
{
  const c = stub({ pages: { A: [['x', 'y'], ['y', 'z']] } });   // 'y' on both pages
  const got = [];
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse, onBatch: (t) => got.push(...t.map((x) => x.id)) });
  const cov = await bf.run({ requests: 5 });
  ok('a txid seen twice is emitted once', got.join() === 'x,y,z', got.join());
  ok('dedupe counted for the coverage line', cov.deduped === 1, String(cov.deduped));
}

console.log('\n=== C. a failed page is a HOLE, and the walk continues past it ===');
{
  const c = stub({ pages: { A: [['a1'], ['a2'], ['a3']] }, fail: [{ id: 'A', page: 1 }] });
  const got = [];
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse, onBatch: (t) => got.push(...t.map((x) => x.id)) });
  const cov = await bf.run({ requests: 5 });
  ok('page 2 still fetched after page 1 failed', got.join() === 'a1,a3', got.join());
  ok('hole recorded with lokad + page', cov.holes.length === 1 && cov.holes[0].lokad === 'A' && cov.holes[0].page === 1, JSON.stringify(cov.holes));
  ok('one bad page does NOT mark the protocol failed', cov.perLokad.A.failed === false);
}
{
  const c = stub({ pages: { A: [['a1']] }, fail: [{ id: 'A', page: 0 }, { id: 'A', page: 1 }, { id: 'A', page: 2 }] });
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse });
  const cov = await bf.run({ requests: 20 });
  // `done` used to be set here too, which is exactly the bug: a protocol nobody
  // could read was indistinguishable from one read to genesis. Termination is
  // now proved by the request count, not by a flag that means something else.
  ok('repeated failure terminates the run', cov.requests === 3, String(cov.requests));
  ok('and it is NOT reported as done', cov.done === false, String(cov.done));
  ok('marked failed:true after the cap, 3 holes', cov.perLokad.A.failed === true && cov.holes.length === 3, String(cov.holes.length));
}

console.log('\n=== D. budget boundary §8 (at / one under / one over) ===');
for (const [budget, expected] of [[0, 0], [1, 1], [2, 2], [3, 3], [4, 3]]) {
  const c = stub({ pages: { A: [['a'], ['b'], ['c']] } });
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse });
  await bf.run({ requests: budget });
  ok(`budget ${budget} -> ${expected} request(s)`, c.calls.length === expected, String(c.calls.length));
}

console.log('\n=== E. cursor: persist, resume, reject junk ===');
{
  const c1 = stub({ pages: { A: [['a1'], ['a2'], ['a3']] } });
  const bf1 = createBackfill({ chronik: c1, lokads: ['A'], parse });
  await bf1.run({ requests: 1 });
  const saved = JSON.parse(JSON.stringify(bf1.cursor));
  const c2 = stub({ pages: { A: [['a1'], ['a2'], ['a3']] } });
  const got = [];
  const bf2 = createBackfill({ chronik: c2, lokads: ['A'], parse, onBatch: (t) => got.push(...t.map((x) => x.id)) });
  bf2.load(saved);
  await bf2.run({ requests: 1 });
  ok('resume continues at page 1, never refetches page 0', c2.calls[0].page === 1 && got.join() === 'a2', JSON.stringify(c2.calls));
}
{
  const c = stub({ pages: { A: [['a1']] } });
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse });
  bf.load({ A: { page: -5, numPages: 'x' }, ZZZ: { page: 9 } });
  ok('junk cursor sanitised, unknown id ignored',
    (bf.cursor.A.ranges || []).length === 0 && bf.cursor.ZZZ === undefined);
  bf.load({ A: { page: 99, numPages: 3 } });
  const r0 = (bf.cursor.A.ranges || [])[0];
  ok('page past numPages clamped and marked done',
    bf.cursor.A.done === true && r0 && r0[0] === 0 && r0[1] === 3,
    JSON.stringify(bf.cursor.A));
}

console.log('\n=== F. numPages 1 vs many, empty id, no lokads ===');
{
  const c = stub({ pages: { A: [['only']] } });
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse });
  const cov = await bf.run({ requests: 5 });
  ok('numPages 1 -> exactly 1 request, done', c.calls.length === 1 && cov.done === true, String(c.calls.length));
}
{
  const c = stub({ pages: { A: [] } });
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse });
  const cov = await bf.run({ requests: 5 });
  ok('empty lokad -> done, 0 scanned, no hole', cov.done === true && cov.scanned === 0 && cov.holes.length === 0);
}
ok('constructing with 0 lokads throws', (() => { try { createBackfill({ chronik: {}, lokads: [], parse }); return false; } catch { return true; } })());

console.log('\n=== G. keep predicate, parse throw, oldestTs honesty ===');
{
  const c = stub({ pages: { A: [['keepme', 'dropme']] } });
  const got = [];
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse, keep: (t) => t.id === 'keepme', onBatch: (t) => got.push(...t.map((x) => x.id)) });
  const cov = await bf.run({ requests: 1 });
  ok('keep filters output but scanned still counts both', got.join() === 'keepme' && cov.scanned === 2 && cov.kept === 1);
}
{
  const c = stub({ pages: { A: [['bad', 'good']] } });
  const got = [];
  const bf = createBackfill({
    chronik: c, lokads: ['A'],
    parse: (d) => { if (d.txid === 'bad') throw new Error('nope'); return { id: d.txid }; },
    onBatch: (t) => got.push(...t.map((x) => x.id)),
  });
  await bf.run({ requests: 1 });
  ok('one unparseable tx does not end the walk', got.join() === 'good', got.join());
}
{
  const c = stub({ pages: { A: [['a']] } });
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse });
  const cov = await bf.run({ requests: 1 });
  ok('oldestTs read from a real timestamp', cov.oldestTs === 1700000000);
}
{
  const c = { lokadId() { return { async history() { return { txs: [{ txid: 't', timeFirstSeen: '0' }], numPages: 1, numTxs: 1 }; } }; } };
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse });
  const cov = await bf.run({ requests: 1 });
  ok('timestamp 0 is unknown, never rendered as 1970', cov.oldestTs === null, String(cov.oldestTs));
}

console.log('\n=== H. prefilter: the cheap gate that makes this usable at all ===');
{
  const c = stub({ pages: { A: [['a', 'b', 'c']] } });
  const parsed = [];
  const bf = createBackfill({
    chronik: c, lokads: ['A'],
    prefilter: (d) => d.txid !== 'b',
    parse: (d) => { parsed.push(d.txid); return { id: d.txid }; },
  });
  const cov = await bf.run({ requests: 1 });
  ok('parse never sees a tx the prefilter rejected', parsed.join() === 'a,c', parsed.join());
  ok('skipped counted, scanned still counts all', cov.skipped === 1 && cov.scanned === 3, `${cov.skipped}/${cov.scanned}`);
}
{
  const c = stub({ pages: { A: [['a', 'b']] } });
  const got = [];
  const bf = createBackfill({
    chronik: c, lokads: ['A'],
    prefilter: (d) => { if (d.txid === 'a') throw new Error('bad'); return true; },
    parse, onBatch: (t) => got.push(...t.map((x) => x.id)),
  });
  const cov = await bf.run({ requests: 1 });
  ok('a throwing prefilter skips that tx, does not end the walk', got.join() === 'b' && cov.skipped === 1, got.join());
}
{
  const c = stub({ pages: { A: [['a']] } });
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse });
  const cov = await bf.run({ requests: 1 });
  ok('no prefilter supplied -> nothing skipped (back-compatible)', cov.skipped === 0 && cov.kept === 1);
}

console.log('\n=== I. the engine holds no results (§10) ===');
{
  const big = Array.from({ length: 200 }, (_, i) => 't' + i);
  const c = stub({ pages: { A: [big, big.map((x) => x + 'b')] } });
  let seen = 0;
  const bf = createBackfill({ chronik: c, lokads: ['A'], parse, onBatch: (t) => { seen += t.length; } });
  const cov = await bf.run({ requests: 5 });
  const keys = Object.keys(cov);
  ok('400 txs streamed out, none retained on the coverage object',
    seen === 400 && !keys.includes('txs') && !keys.includes('results'), keys.join());
}

console.log('\n=== J. scheduling spreads across protocols, and settles itself ===');
{
  // The floor-targeting version put every request into whichever protocol was
  // shallowest. On real data that is PayButton, whose text is machine-generated
  // order ids — the date advanced and the results did not. Coverage of the
  // protocols that carry writing matters more than the speed of one number.
  const pages = (n, p) => Array.from({ length: n }, (_, i) => [p + i]);
  const c = stub({
    pages: { dense: pages(10, 'd'), sparse: pages(2, 's') },
    ts: { dense: 1_800_000_000, sparse: 1_800_000_000 },
    step: { dense: 86400, sparse: 365 * 86400 },
  });
  const bf = createBackfill({ chronik: c, lokads: ['dense', 'sparse'], parse: (d) => ({ id: d.txid }) });
  await bf.run({ requests: 6 });
  const byId = c.calls.reduce((a, x) => { a[x.id] = (a[x.id] || 0) + 1; return a; }, {});
  ok('the dense protocol keeps being read, not starved by the floor',
    byId.dense >= 3, JSON.stringify(byId));
  ok('a protocol that runs out stops taking a share',
    bf.coverage.perLokad.sparse.done === true && byId.sparse === 2, JSON.stringify(byId));
  ok('its budget goes to what is left rather than being wasted',
    byId.dense + byId.sparse === 6, JSON.stringify(byId));
}
{
  const c = stub({ pages: { a: [['x']], b: [['p'], ['q'], ['r']] } });
  const bf = createBackfill({ chronik: c, lokads: ['a', 'b'], parse: (d) => ({ id: d.txid }) });
  await bf.run({ requests: 5 });
  ok('the walk finishes instead of spinning on an exhausted protocol', bf.coverage.done === true);
}

console.log('\n=== K. abandoned is NOT done — the coverage claim it used to forge ===');
{
  // Article's node keeps failing; the other protocol is healthy.
  const c = stub({ pages: { good: [['g0'], ['g1'], ['g2']], bad: [['b0'], ['b1']] },
                   fail: [{ id: 'bad', page: 0 }, { id: 'bad', page: 1 }, { id: 'bad', page: 2 }] });
  const bf = createBackfill({ chronik: c, lokads: ['good', 'bad'], parse: (d) => ({ id: d.txid }) });
  const cov = await bf.run({ requests: 12 });
  ok('the failing protocol is marked failed', cov.perLokad.bad.failed === true);
  ok('...and is NOT marked done', cov.perLokad.bad.done === false, JSON.stringify(cov.perLokad.bad));
  ok('overall done stays FALSE while one was abandoned', cov.done === false);
  ok('the healthy one still finished', cov.perLokad.good.done === true);
  ok('its holes are on the record', cov.holes.length === 3, String(cov.holes.length));
  // This is the reach rule the Lane applies. An abandoned protocol that never
  // got a page has no oldestTs, so no coverage date can honestly be stated.
  const laneReach = (cur, ids) => {
    let floor = null;
    for (const id of ids) {
      const x = cur[id];
      if (!x || x.done) continue;
      if (!x.oldestTs) return null;
      floor = floor == null ? x.oldestTs : Math.max(floor, x.oldestTs);
    }
    return floor;
  };
  ok('reach REFUSES to answer when a protocol was never read',
    laneReach(cov.perLokad, ['good', 'bad']) === null, String(laneReach(cov.perLokad, ['good', 'bad'])));
}
{
  // A protocol abandoned partway must CONSTRAIN the floor, not be skipped.
  const laneReach = (cur, ids) => {
    let floor = null;
    for (const id of ids) {
      const x = cur[id];
      if (!x || x.done) continue;
      if (!x.oldestTs) return null;
      floor = floor == null ? x.oldestTs : Math.max(floor, x.oldestTs);
    }
    return floor;
  };
  const cur = {
    deep: { oldestTs: 1000, done: true,  failed: false },   // exhausted -> no floor
    mid:  { oldestTs: 5000, done: false, failed: false },
    gave: { oldestTs: 9000, done: false, failed: true  },   // abandoned -> still counts
  };
  ok('an abandoned protocol constrains the floor like an unfinished one',
    laneReach(cur, ['deep', 'mid', 'gave']) === 9000, String(laneReach(cur, ['deep', 'mid', 'gave'])));
  ok('only a truly exhausted one is skipped',
    laneReach({ ...cur, gave: { oldestTs: 9000, done: true, failed: false } }, ['deep','mid','gave']) === 5000);
}
{
  // Pressing the button again must retry what was given up on.
  const c = stub({ pages: { a: [['x'], ['y']] }, fail: [{ id: 'a', page: 0 }, { id: 'a', page: 1 }, { id: 'a', page: 2 }] });
  const bf = createBackfill({ chronik: c, lokads: ['a'], parse: (d) => ({ id: d.txid }) });
  await bf.run({ requests: 5 });
  ok('abandoned after the cap', bf.coverage.perLokad.a.failed === true);
  const callsAfterFirst = c.calls.length;
  await bf.run({ requests: 2 });
  ok('a NEW run retries it rather than skipping forever', c.calls.length > callsAfterFirst,
    callsAfterFirst + ' -> ' + c.calls.length);
}
{
  // And it must still terminate rather than spin.
  const c = stub({ pages: { a: [['x']] }, fail: [{ id: 'a', page: 0 }, { id: 'a', page: 1 }, { id: 'a', page: 2 }] });
  const bf = createBackfill({ chronik: c, lokads: ['a'], parse: (d) => ({ id: d.txid }) });
  const cov = await bf.run({ requests: 50 });
  ok('one run stops at the failure cap, it does not loop', cov.requests <= 3, String(cov.requests));
}

console.log("\n=== L. AT FLOW'S OWN SHAPE — 6 protocols, 6 requests, one dead node ===");
{
  // Section K uses 12 requests over 2 protocols, so each gets 6 and FAIL_MAX is
  // reachable. Flow never has that shape: LANE_REQUESTS (6) equals the number of
  // protocols, so round-robin gives each exactly ONE attempt per click and the
  // fail counter resets at the next run. A correct unit test was sitting on top
  // of a path the product cannot reach — this exercises the real one.
  const ids = ['a', 'b', 'c', 'd', 'e', 'dead'];
  const pages = {}; for (const i of ids) pages[i] = Array.from({ length: 50 }, (_, k) => [i + k]);
  const chronik = { lokadId(id) { return { async history(page) {
    if (id === 'dead') throw new Error('502');
    return { txs: pages[id][page].map((t) => ({ txid: t, timeFirstSeen: '1700000000' })), numPages: 50, numTxs: 50 };
  } }; } };
  // Attempted (pos moved) and still no timestamp. `page` died with ranges.
  // A protocol nobody has tried yet (pos 0) is not "unreadable" — it is unread.
  const unread = (cov) => Object.values(cov.perLokad)
    .filter((c) => !c.done && !c.oldestTs && c.pos > 0).length;

  const bf = createBackfill({ chronik, lokads: ids, parse: (d) => ({ id: d.txid }) });
  ok('before any click nothing is claimed unreadable', unread(bf.coverage) === 0);
  let cov = await bf.run({ requests: 6 });
  ok('one dead protocol is reported after the FIRST click', unread(cov) === 1, String(unread(cov)));
  ok('the healthy five are not', unread(cov) === 1 && cov.perLokad.a.pagesDone === 1);
  for (let i = 0; i < 19; i++) cov = await bf.run({ requests: 6 });
  ok('still reported after twenty clicks', unread(cov) === 1, String(unread(cov)));
  ok('holes accumulate alongside it', cov.holes.length === 20, String(cov.holes.length));
  // The old trigger, kept so the reason it was replaced stays visible.
  ok('`failed` never fires at this shape — which is why it was the wrong trigger',
    Object.values(cov.perLokad).every((c) => c.failed === false));
  ok('and no false coverage is claimed', cov.done === false);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
