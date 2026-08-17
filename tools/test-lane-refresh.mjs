// Harness for the Lane's refresh/clear controls and the date-window UX
// (2026-08-15).  node tools/test-lane-refresh.mjs
//
// Cursor/coverage math is imported from the shipped vendor/core/lane-cursor.js
// (the same module Flow loads). dayEnd and isoDay still live on the door and
// are extracted from flow/index.html.
//
// The end-to-end section additionally drives the REAL vendor/core/backfill.js
// against a fake chronik whose index grows the way chronik's does — newest-first,
// new transactions inserted at rank 0 — because the defect being fixed is
// invisible to any model that keeps ranks still.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createBackfill } from '../vendor/core/backfill.js';
import {
  shiftRangesForGrowth, presetFrom, presetActive as presetActiveOf,
  rangeActive as rangeActiveOf, inRange as inRangeOf, dayStart,
} from '../vendor/core/lane-cursor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];

/** Lift `function name(...) { ... }` by balancing braces, skipping strings and
 *  comments so a brace inside either cannot end it. */
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

const LANE_PAGE = Number(mod.match(/const LANE_PAGE = (\d+)/)[1]);
const RANGE_PRESETS = JSON.parse(mod.match(/const RANGE_PRESETS = (\[[^\]]*\])/)[1]);
const isoDaySrc = mod.match(/const isoDay = (\(ms\) => \{[\s\S]*?\n\};)/)[1];

// dayEnd still lives on the door (a calendar sentence, not cursor math).
const dayEnd = new Function(grab('dayEnd') + '\nreturn dayEnd;')();
const isoDay = new Function('return ' + isoDaySrc)();
let laneRange = { from: null, to: null };
const setRange = (r) => { laneRange = r; };
const rangeActive = () => rangeActiveOf(laneRange);
const inRange = (ts) => inRangeOf(ts, laneRange);
const presetActive = (d) => presetActiveOf(d, laneRange);

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

// ---------------------------------------------------------------- boundary math
// §8: compute the attainable range of each side, then test empty / exact edge /
// one-past. A page interval [a,b) covers ranks [a*size, b*size); after `delta`
// new ranks are pushed in at the top that content sits at [a*size+delta,
// b*size+delta), and only WHOLLY covered pages may be claimed.
console.log('shiftRangesForGrowth — page arithmetic');
const S = 50;
ok('no ranges', shiftRangesForGrowth([], 10, S), []);
ok('non-array tolerated', shiftRangesForGrowth(null, 10, S), []);
ok('delta 0 leaves it alone', shiftRangesForGrowth([[0, 12, 111, 222]], 0, S), [[0, 12, 111, 222]]);
ok('delta 1 -> page 0 reopens only', shiftRangesForGrowth([[0, 12, 111, 222]], 1, S), [[1, 12, 111, 222]]);
ok('delta = one full page (exact edge)', shiftRangesForGrowth([[0, 12, 111, 222]], S, S), [[1, 13, 111, 222]]);
ok('delta = one page + 1 (one past)', shiftRangesForGrowth([[0, 12, 111, 222]], S + 1, S), [[2, 13, 111, 222]]);
ok('delta = page - 1', shiftRangesForGrowth([[0, 12, 111, 222]], S - 1, S), [[1, 12, 111, 222]]);
ok('single-page range shifts exactly', shiftRangesForGrowth([[5, 6, 9, 9]], 200, S), [[9, 10, 9, 9]]);
ok('single-page range that no longer fits is dropped',
   shiftRangesForGrowth([[5, 6, 9, 9]], S + 1, S), []);
ok('several ranges, one survives',
   shiftRangesForGrowth([[0, 4, 10, 20], [9, 10, 5, 6], [20, 40, 1, 2]], S + 1, S),
   [[2, 5, 10, 20], [22, 41, 1, 2]]);
ok('timestamps ride along untouched (content did not move, ranks did)',
   shiftRangesForGrowth([[0, 3, 1700000000, 1800000000]], 10, S),
   [[1, 3, 1700000000, 1800000000]]);

// The claim the shift must never break: every rank it still claims really is
// inside the moved content. Brute-forced over a spread of deltas.
console.log('shiftRangesForGrowth — never claims a rank it has not read');
let violations = 0, dropped = 0;
for (let delta = 0; delta <= 240; delta++) {
  const before = [[0, 12, null, null], [30, 33, null, null]];
  for (const r of shiftRangesForGrowth(before, delta, S)) {
    for (let p = r[0]; p < r[1]; p++) {
      const lo = p * S, hi = p * S + S - 1;               // ranks this page holds now
      const inside = before.some(b => lo - delta >= b[0] * S && hi - delta <= b[1] * S - 1);
      if (!inside) violations++;
    }
  }
  const claimed = shiftRangesForGrowth(before, delta, S).reduce((n, r) => n + (r[1] - r[0]), 0);
  if (claimed < 15) dropped++;
}
ok('0 over-claimed pages across delta 0..240', violations, 0);
ok('conservative: some pages given up as partially covered', dropped > 0, true);

// ------------------------------------------------------------- preset day math
console.log('presetFrom / presetActive — a preset names a day, not an instant');
for (const d of RANGE_PRESETS) {
  const from = presetFrom(d);
  const dt = new Date(from);
  ok(`preset ${d}d starts at local midnight`,
     [dt.getHours(), dt.getMinutes(), dt.getSeconds(), dt.getMilliseconds()], [0, 0, 0, 0]);
  // What syncDateInputs() writes into the field must be a day the filter really
  // includes — the defect was the field naming a day whose morning was excluded.
  ok(`preset ${d}d: the field's own day is inside the window`,
     (setRange({ from, to: null }), inRange(dayStart(isoDay(from)))), true);
  ok(`preset ${d}d: the chip recognises its own value exactly`,
     (setRange({ from, to: null }), presetActive(d)), true);
  ok(`preset ${d}d: re-tapping produces an identical value (a real no-op)`,
     presetFrom(d) === from, true);
}
setRange({ from: null, to: null });
ok('no window -> "All time" is the lit chip', presetActive(0), true);
ok('no window -> a day preset is not lit', presetActive(30), false);
setRange({ from: presetFrom(30), to: Date.now() });
ok('a typed pair is never reported as a preset', presetActive(30), false);

// The old ±12h tolerance let a page left open un-light its own preset. Exact
// equality cannot drift, so the only thing that changes the answer is midnight.
{
  const from = presetFrom(30);
  setRange({ from, to: null });
  ok('preset stays lit however long the page has been open', presetActive(30), true);
}

// ------------------------------------------------------ end to end, real engine
console.log('laneRefreshIndex — the newest end of a restored cursor');
const ID = '00746162';
let NOW = 1_800_000_000;
let index = [];
for (let i = 0; i < 500; i++) index.push({ txid: 'seed' + String(i).padStart(4, '0'), ts: NOW - i * 3600 });
let probeRequests = 0, pageRequests = 0;
const chronik = {
  lokadId: () => ({
    history: async (page, size) => {
      if (size === 1) probeRequests++; else pageRequests++;
      return {
        txs: index.slice(page * size, page * size + size)
               .map(e => ({ txid: e.txid, timeFirstSeen: e.ts, outputs: [], inputs: [] })),
        numPages: Math.ceil(index.length / size), numTxs: index.length,
      };
    },
  }),
};
const seen = new Set();
const mk = () => createBackfill({
  chronik, lokads: [ID], pageSize: LANE_PAGE,
  parse: (d) => ({ id: d.txid }),
  onBatch: (txs) => txs.forEach(t => seen.add(t.id)),
});

let bf = mk();
await bf.run({ requests: 4 });
const saved = bf.cursor;
const depthBefore = saved[ID].ranges[0][1];

// 120 messages are written between sessions.
index = Array.from({ length: 120 }, (_, i) => ({ txid: 'NEW' + String(i).padStart(4, '0'), ts: NOW + 86400 - i * 3600 }))
             .concat(index);

// (a) The defect, reproduced: resume and walk deeper without repairing the top.
{
  const before = seen.size;
  const b = mk(); b.load(saved);
  await b.run({ requests: 4 }); await b.run({ requests: 4 });
  const gained = [...seen].filter(x => x.startsWith('NEW')).length;
  ok('WITHOUT refresh: 8 further pages reach none of the 120 new messages', gained, 0);
  ok('WITHOUT refresh: the prefix still claims it starts at page 0',
     b.cursor[ID].ranges[0][0], 0);
  ok('WITHOUT refresh: pages were spent', seen.size > before, true);
}

// (b) With the repair: apply the shipped shift to the SAVED cursor, then walk.
{
  seen.clear();
  probeRequests = 0; pageRequests = 0;
  const probe = await chronik.lokadId(ID).history(0, 1);   // what laneRefreshIndex spends
  const delta = probe.numTxs - saved[ID].numTxs;
  ok('growth measured from numTxs alone', delta, 120);
  const repaired = {
    [ID]: Object.assign({}, saved[ID], {
      ranges: shiftRangesForGrowth(saved[ID].ranges, delta, LANE_PAGE),
      numTxs: probe.numTxs,
      numPages: Math.ceil(probe.numTxs / LANE_PAGE),
      done: false, rangeDone: false,
    }),
  };
  ok('the prefix no longer claims the pages the new messages took',
     repaired[ID].ranges[0][0] > 0, true);
  const b = mk(); b.load(repaired);
  await b.run({ requests: 4 });
  const gained = [...seen].filter(x => x.startsWith('NEW')).length;
  ok('WITH refresh: every new message is reached', gained, 120);
  ok('WITH refresh: it cost one probe', probeRequests, 1);
  ok('WITH refresh: depth already paid for is kept',
     b.cursor[ID].ranges[0][1] >= depthBefore, true);
  ok('WITH refresh: the prefix is whole again once the top is re-read',
     b.cursor[ID].ranges[0][0], 0);
}

// (c) A quiet index costs nothing beyond the probe.
{
  probeRequests = 0; pageRequests = 0;
  const probe = await chronik.lokadId(ID).history(0, 1);
  const delta = probe.numTxs - (500 + 120);
  ok('no growth -> nothing to repair', delta <= 0, true);
  ok('no growth -> zero page requests', pageRequests, 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
