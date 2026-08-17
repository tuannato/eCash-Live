// vendor/core/lane-cursor.js — cursor, scope and date-window math for the Lane (ESM).
//
// Lives outside the page's inline module on purpose: it is same-origin, so
// `script-src 'self'` already covers it and it costs NO extra CSP hash, and
// every line moved out here shrinks the hash-pinned module (the door.js lesson,
// CLAUDE.md). Import it with a `?v=` token and bump that token on any change —
// an ES-module import is cached like any other resource, and a stale copy that
// is missing a newly added export throws and takes the whole page down.
//
// What this module deliberately does NOT do: own a cursor, a scope or a date
// window. Those belong to the door. Every function here is given the values it
// reads. No `state`, no DOM, no storage, no network — neo can adopt this
// file unchanged.
//
// MESSAGE_LOKADS / LOKAD / LOKAD_NAMES are imported from txparse.js rather than
// threaded through every call: they are protocol constants, not door state, and
// the specifier matches Flow's (`?v=p7`) so the browser holds one copy.

import { MESSAGE_LOKADS, LOKAD, LOKAD_NAMES } from '../txparse.js?v=p7';

/* THE REPORTED REACH IS THE FLOOR, NOT THE DEEPEST POINT.
   Measured on real data: after two rounds, Cashtab had reached 2026-07-03 while
   Alias had reached 2023-11-01, because a page holds 50 transactions and the
   sparse protocols cover years in one page while the dense one covers weeks.
   Reporting the oldest thing seen — 2023 — claimed almost three years of
   coverage when the protocol carrying nearly all the writing had read one month.
   The reader saw exactly that: hits clustered in the last month, one stray from
   2023, and a banner promising 2023.
   So the floor is the OLDEST DATE EVERY protocol has passed, i.e. the max of the
   per-protocol depths. A protocol that is finished imposes no floor: it has been
   read to genesis, so it constrains nothing. */
/* Read over the SELECTED protocols, not over all six. The date describes what
   the reader asked to be searched, so a protocol nobody is searching must not
   constrain it — and, just as importantly, must not silently be counted as
   covered either. Narrowing the scope therefore narrows what the sentence
   claims; the number itself barely moves at the moment of the change, because
   the floor was already held by the shallowest protocol in the old set. */
export function laneReach(cur, scope){
  if (!cur) return null;
  let floor = null;
  for (const id of scope){
    const c = cur[id];
    // ONLY a genuinely exhausted protocol is skipped. One abandoned after
    // repeated failures keeps done:false on purpose, so it constrains the floor
    // exactly like an unfinished one — and if it never got a page at all, the
    // next line refuses to make any claim, which is the whole point.
    if (!c || c.done) continue;               // read to genesis -> covers everything
    /* THE PREFIX, NEVER `oldestTs`. Since the engine can seek, oldestTs is the
       oldest thing seen ANYWHERE — a window read around 2022 would otherwise let
       this sentence claim 2022 while everything between then and now is unread.
       ranges[0] is the contiguous run from page 0 and is the only interval that
       can speak for "in full back to". A cursor saved before ranges existed
       carries a watermark instead, and for it the two are the same number. */
    const pre = Array.isArray(c.ranges) ? (c.ranges[0] && c.ranges[0][0] === 0 ? c.ranges[0][2] : null)
                                        : c.oldestTs;
    if (!pre) return null;                    // never read -> no honest claim
    floor = (floor == null) ? pre : Math.max(floor, pre);
  }
  return floor;
}

/* THE RUNS READ OUT OF ORDER — everything except the one starting at page 0.
   They exist only after a seek, and they are NOT part of the "in full back to"
   sentence: that describes the run from the newest message and nothing else.
   Naming them separately is what lets both statements be true at once.

   Merged across the selected protocols and then across each other, because a
   reader sets one window at a time and each further click extends it — without
   merging, the same window would be printed once per page read. Capped, with the
   remainder counted rather than dropped (§10). Engine timestamps are seconds;
   the coverage line formats milliseconds. */
export function laneWindows(cur, scope){
  const raw = [];
  for (const id of scope){
    const c = cur[id];
    if (!c || !Array.isArray(c.ranges)) continue;
    for (const r of c.ranges){
      if (r[0] === 0) continue;                 // the prefix has its own sentence
      if (r[2] == null || r[3] == null) continue;
      raw.push([r[2] * 1000, r[3] * 1000]);     // [oldest, newest]
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const w of raw){
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  return merged;
}

/* Then SHIFT rather than discard. Content read at old rank r now sits at r + d,
   so a page interval [a, b) covers ranks that have moved to [a*size+d,
   b*size+d); expressed back in whole pages that is [a + ceil(d/size),
   b + floor(d/size)). Rounding outward at the start and inward at the end means
   a partially-covered page is never claimed — the error is always in the
   direction of re-reading something, never of skipping it. Every page of depth
   the reader paid for is kept, which is the whole point: resetting to page 0
   instead would cost 188 pages (~31 clicks) on Cashtab to recover what is
   usually a single page of drift. At the measured ~2.3 Cashtab messages a day, a
   week away is ~16 ranks — one page. */
export function shiftRangesForGrowth(ranges, delta, size){
  const lead = Math.ceil(delta / size), tail = Math.floor(delta / size);
  const out = [];
  for (const r of (Array.isArray(ranges) ? ranges : [])){
    const a = r[0] + lead, b = r[1] + tail;
    if (b > a) out.push([a, b, r[2], r[3]]);   // the timestamps describe CONTENT, which did not move
  }
  return out;
}

/* THE ONE PLACE THAT DECIDES WHETHER A RESULT IS IN SCOPE.
   An unknown protocol is always in: absence of a tag is absence of evidence, and
   hiding on a guess would delete results that were genuinely found and paid for.
   Live transactions have no tag by construction — see the note in laneRematch. */
export function inScope(lokad, scope){
  if (!lokad) return true;
  return scope.includes(lokad);
}

// Display order follows MESSAGE_LOKADS so the picker and the summary agree.
export function scopeLabel(scope){
  return MESSAGE_LOKADS.filter(id => scope.includes(id))
                       .map(id => LOKAD_NAMES[id] || id).join(' · ');
}

// Only ids this parser actually has a text-bearing branch for, and never empty:
// createBackfill throws on an empty list, and a Lane that searches nothing while
// still lighting its chip would be the "promise with nothing behind it" that
// turning a topic on was fixed to stop being.
export function sanitizeScope(list){
  const out = [];
  for (const id of (Array.isArray(list) ? list : [])){
    if (typeof id === 'string' && MESSAGE_LOKADS.includes(id) && !out.includes(id)) out.push(id);
  }
  return out.length ? out : [LOKAD.CASHTAB_MSG];
}

/* MERGED, and the bug that made it necessary was found live rather than by the
   harness. The engine's cursor only ever describes the protocols it was built
   with, so once a narrowed run had happened the panel read "not read yet" beside
   eCashChat and PayButton — while storage still held pages 1/277 and 1/368 for
   them, and the very next tick would have resumed from there. Saying "not read"
   about something we have read is the one thing this panel exists to get right:
   it is what the reader decides on. The live cursor goes last so a live run
   stays authoritative for whatever it is actually walking. */
export function scopeCursorView(saved, live){
  return Object.assign({}, saved || {}, live || {});
}

export function rangeActive(range){ return range.from != null || range.to != null; }

/* A calendar day is a DAY, not an instant: the reader picked a date in their own
   timezone while the index timestamps in UTC, so a window legitimately includes
   a few hours either side of what a UTC reading would give. Widening at both
   ends is the honest direction — it can show something just outside, never hide
   something just inside. */
export function dayStart(iso){ const d = new Date(iso + 'T00:00:00'); const n = d.getTime(); return isFinite(n) ? n : null; }

/* A result with no timestamp cannot be placed in a window. It is EXCLUDED and
   counted, never quietly kept: including it would put an undated row inside a
   date filter, which is the one thing a date filter must not do. */
export function inRange(ts, range){
  if (!rangeActive(range)) return true;
  if (!ts) return false;
  if (range.from != null && ts < range.from) return false;
  if (range.to != null && ts > range.to) return false;
  return true;
}

/* WHO WROTE IT, as eight hex characters.
   Measured, and it is the whole reason the suggestion list is usable: ranking
   words by how OFTEN they appear returns the busiest bot's script — over 1,000
   real Cashtab messages the top of that list was congratulations·119, win·115,
   casino·57, darts·51, all from one or two senders. Ranking by how many
   DIFFERENT people wrote a word separates a campaign from a topic exactly:
   casino collapses to 1 sender while thanks, on 21 messages, has 20.

   FNV-1a, not a cryptographic hash, and it does not need to be — it exists only
   to tell one sender apart from another, and a collision costs one suggestion
   its rank. Taken from inputs[0] of a transaction the walk has already fetched,
   so it adds no request and no full parse. Stored beside chain-public message
   text that is far more identifying than this is; it says nothing about the
   reader. */
export function senderTag(script){
  if (!script || typeof script !== 'string') return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < script.length; i++){
    h ^= script.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
export function senderOf(txData){
  const i = txData && txData.inputs && txData.inputs[0];
  if (!i) return null;
  return senderTag(i.outputScript || (i.prevOut && i.prevOut.outputScript) || null);
}

/* A PRESET HAS TO PRODUCE A DAY, NOT AN INSTANT, because the control beside it
   only knows how to show days.
   `Date.now() - d * 864e5` is a moment mid-afternoon, and syncDateInputs() then
   writes isoDay() of it into the field — so the box said "2026-07-16" while the
   filter actually began at 20:00 that evening. Verified against the shipped
   inRange(): a message from 09:00 on the very day the field names was excluded.
   A date control that names a day it does not include is the same defect as a
   silent mute count, on the one surface built to be scrupulous about coverage.

   Two more things fall out of snapping. Re-tapping the lit preset becomes a real
   no-op — before, a second tap five minutes later produced a different `from`,
   so onRangeChanged() ran, aborted the walk and re-spent the budget on an
   unchanged question. And the chip stops going dark on its own: presetActive()
   needed a ±12h tolerance to recognise its own value, so a page left open for
   twelve hours un-lit the preset while nothing had been touched.

   setDate/setHours rather than millisecond arithmetic: subtracting 30*864e5
   lands an hour out across a DST boundary, and this is a calendar question. */
export function presetFrom(d){
  const x = new Date();
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - d);
  return x.getTime();
}
export function presetActive(d, range){
  if (!rangeActive(range)) return d === 0;
  if (range.to != null) return false;            // a typed window, not a preset
  return d > 0 && range.from === presetFrom(d);  // exact: both are day starts
}
