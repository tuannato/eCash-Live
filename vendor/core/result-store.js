// vendor/core/result-store.js — bounded hold of parsed Lane results + the answer (ESM).
//
// Lives outside the page's inline module on purpose: it is same-origin, so
// `script-src 'self'` already covers it and it costs NO extra CSP hash, and
// every line moved out here shrinks the hash-pinned module (the door.js lesson,
// CLAUDE.md). Import it with a `?v=` token and bump that token on any change —
// an ES-module import is cached like any other resource, and a stale copy that
// is missing a newly added export throws and takes the whole page down.
//
// What this module deliberately does NOT do: own a search question, walk a
// live stream, fetch, paint, or mute. Those belong to the door. tsOf and
// wanted are REQUIRED parameters for that reason; a convenient default
// reinstates a bug that already shipped. No `state`, no DOM, no storage, no
// network — neo can adopt this file unchanged.
//
// It also never reads or writes `.el` on a held object. A door that reused a
// card factory would otherwise steal the stream's own element (84dc6fd).

/* THE HOLDER AND THE ANSWER USED TO EVICT FROM OPPOSITE ENDS.

   laneHold dropped the first-inserted entry while the backward walk inserts
   newest-first, so it deleted precisely what laneSetMatched (newest by
   timestamp) wanted to keep. Measured at MATCH_MAX 200: 260 matches scanned
   left 60 of them held but unrenderable, 300 left 100, and from 400 the
   overlap is EMPTY — the Lane rendered zero rows while reporting 200 matches
   and a reach of years, and laneHydrate re-fetched 200 transactions it
   already had on every run (07adc97).

   Deriving both from the same tsOf is what makes the two unable to drift. */

/* EVICT WHAT THE ANSWER DOES NOT WANT, and only then the oldest.

   Oldest-by-time alone was right while the Lane always looked at the newest
   end, and it is exactly wrong the moment a date window points into the past:
   every result the reader asked for IS the oldest thing held, so each one was
   evicted the instant it was hydrated, in favour of recent rows the window
   excludes. Measured live — a Jun 2023 window read four real pages, hydrated
   95 transactions and rendered zero (6a49e3a).

   So the first candidates are entries that fail the CURRENT question. They
   are held only because they were fetched under an earlier one, and dropping
   them costs the reader nothing they can see. Oldest-by-tsOf stays as the
   tiebreak. The predicate is door-shaped (scope, window, terms), which is
   why it is a parameter and not a body. */

/* FIRST OBJECT WINS. An id already held is a no-op. A hydrate of a
   transaction already held from the live stream must not swap a witnessed
   object (real TTF) for a fetched one (`_hist`, ttf: null). */

/* ONE WRITER OF THE ANSWER. Two writers with two different rules is what
   let a cheap live match evict a backfilled one that had cost a request.
   Dedupe, order, record the total BEFORE the cap, then keep the newest
   `max`. The total has to survive the cap: 1000 matches reading as "200
   found" reproduces the symptom of a bug already fixed once (84dc6fd). */

/* CAP BY RECENCY, DISPLAY OLDEST-FIRST. Two different decisions. When
   something has to go it is the oldest; the reading order follows the stream
   underneath, so new arrivals appear at the bottom and the two never scroll
   in opposite directions. */

/**
 * @param {object} o
 * @param {number} [o.max]     hard cap on the hold and on the rendered answer.
 *                             Floor 1. Flow passes MATCH_MAX. Default 200.
 * @param {function} o.tsOf    REQUIRED. (id, tx?) -> number. Door supplies
 *                             laneTsOf / txWhenMs. A default of `tx.ts` puts
 *                             a mempool card at 1970 (84dc6fd).
 * @param {function} o.wanted  REQUIRED. (tx) -> boolean. Door supplies the
 *                             current question (scope, window, terms). A
 *                             default of oldest-by-time-only empties a past
 *                             window (6a49e3a).
 *
 * hold(tx)
 *   First object wins. Evicts unwanted-first, then oldest-by-tsOf, until
 *   size <= max. Missing tx / missing id is a no-op. Never touches .el.
 *
 * setMatched(ids)
 *   Sole writer of the answer. Dedupes, orders by tsOf descending, records
 *   matchedTotal BEFORE the cap, keeps the newest `max`, then reverses so
 *   the reader sees oldest first.
 *
 * clear()  empties the hold only. The answer is a different fact; the door
 *          rebuilds it (laneRematch) the way laneClearData already did.
 *
 * The hold is not the live map. Ids in the answer may be absent from the
 * hold (still on the live stream, or a corpus hit not yet fetched).
 * get/has/values speak only for what this store was given.
 */
export function createResultStore({ max = 200, tsOf, wanted, order = 'oldest-first' } = {}) {
  if (typeof tsOf !== 'function' || typeof wanted !== 'function') {
    throw new Error('createResultStore: tsOf and wanted are required');
  }
  const cap = Math.max(1, max | 0);
  const hold = new Map();
  let matched = [];
  let matchedTotal = 0;

  function age(id, tx) {
    return tsOf(id, tx) || 0;
  }

  function holdTx(tx) {
    if (!tx || !tx.id || hold.has(tx.id)) return;
    hold.set(tx.id, tx);
    while (hold.size > cap) {
      let victim = null, victimTs = Infinity, victimWanted = true;
      for (const [id, held] of hold) {
        const ts = age(id, held);
        const isWanted = !!wanted(held);
        // An unwanted entry always beats a wanted one, whatever their ages.
        if (victimWanted && !isWanted) {
          victim = id; victimTs = ts; victimWanted = false;
          continue;
        }
        if (victimWanted !== isWanted) continue;
        if (ts < victimTs) { victimTs = ts; victim = id; }
      }
      if (victim == null) break;
      hold.delete(victim);
    }
  }

  function setMatched(ids) {
    const seen = new Set();
    const rows = [];
    for (const id of (ids || [])) {
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push([id, age(id)]);
    }
    rows.sort((a, b) => b[1] - a[1]);
    matchedTotal = rows.length;
    /* THE CAP IS THE MODULE'S; THE READING ORDER IS THE DOOR'S. This was
       hardcoded to oldest-first, which is right for Flow and wrong for neo, and
       the reason is that each door's list has to run the same way as the stream
       beside it or the two scroll in opposite directions. Flow's stream appends
       at the BOTTOM, so its Lane reads oldest-first; neo's feed inserts at the
       TOP, so Topics reads newest-first. Same cap, same recency slice, opposite
       paint order — which is presentation, and presentation belongs to the door.
       Default unchanged, so Flow keeps exactly what it had. */
    const kept = rows.slice(0, cap);
    matched = (order === 'newest-first' ? kept : kept.reverse()).map((r) => r[0]);
  }

  function clear() {
    hold.clear();
  }

  return {
    hold: holdTx,
    setMatched,
    clear,
    get(id) { return hold.get(id); },
    has(id) { return hold.has(id); },
    values() { return hold.values(); },
    [Symbol.iterator]() { return hold[Symbol.iterator](); },
    get size() { return hold.size; },
    /* A COPY. Every door call site reads -- includes, filter, spread, length --
       and none writes, but handing out the live array makes "one writer" a
       convention rather than a property, and the cap with it. At most `max`
       short strings, read a couple of times per render. */
    get matched() { return matched.slice(); },
    get matchedTotal() { return matchedTotal; },
  };
}
