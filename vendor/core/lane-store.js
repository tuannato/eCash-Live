// vendor/core/lane-store.js — persist the Lane cursor and corpus as one value (ESM).
//
// Lives outside the page's inline module on purpose: it is same-origin, so
// `script-src 'self'` already covers it and it costs NO extra CSP hash, and
// every line moved out here shrinks the hash-pinned module (the door.js lesson,
// CLAUDE.md). Import it with a `?v=` token and bump that token on any change —
// an ES-module import is cached like any other resource, and a stale copy that
// is missing a newly added export throws and takes the whole page down.
//
// What this module deliberately does NOT do: own a search question, a corpus
// Map, or a storage key. The door hands it a storage adapter and a key — whether
// two doors share one cursor is a product decision this file must not pre-empt
// by hardcoding `ecashlive:flow:lane-cursor`. The corpus is createCorpus()'s;
// save() takes the snapshot (prefer corpus.dump()) so two places cannot derive
// the same rows and drift. No `state`, no DOM, no network — neo can adopt this
// file unchanged.
//
// A pure serialize() cannot work here. The shrink policy is a retry loop: it
// learns the payload was too big by attempting the write and catching
// QuotaExceededError. That is why the engine drives the write, and why it
// takes a storage adapter rather than returning a string for the door to store.

/* THE CURSOR AND THE CORPUS ARE STORED TOGETHER, AND THAT IS THE POINT.

   The cursor says which pages have been read; the corpus is what was read. If
   the cursor outlives the corpus, the next session resumes past pages it can no
   longer search, and every new term is blind to them — which is the original bug
   in a slower form, surviving a reload instead of a term change. Writing them as
   one value makes that state unreachable rather than merely unlikely.

   If storage fails (quota, private mode) NEITHER is kept, for the same reason. */

/* THE STORED CURSOR IS A SUPERSET, AND THE STORE OWNS THE MERGE.

   createBackfill fixes its cursor object from the `lokads` it was built with, so
   at a narrowed scope the engine's cursor describes only the selected protocols.
   Writing it straight to storage would erase the read depth of everything the
   reader had just deselected — pages already paid for, gone, and re-walked from
   zero the moment they tick the box again. Worse, the corpus would still hold
   those entries while the cursor claimed nothing had been read, which is exactly
   the state laneReach() answers by refusing to state a date at all.

   That is a persistence invariant, not a door-session one. This file is the only
   writer; if the merge lived on the door, every future door would have to
   remember it, and a missed Object.assign is silent data loss. save() therefore
   ACCUMULATES: each incoming cursor is assigned onto whatever was last saved or
   loaded, so scope A -> B -> A keeps both. The door still owns the session
   alias it mutates (punch, shift-for-growth); it hands that object in and the
   merge keeps every key it did not touch. */

/**
 * @param {object} o
 * @param {object} o.storage  adapter with getItem/setItem/removeItem (window.localStorage, or a fake)
 * @param {string} o.key      storage key — configuration, never a constant in this file
 *
 * save({ cursor, corpus })
 *   cursor  — the engine's cursor this run, or the door's mutated saved cursor
 *   corpus  — a createCorpus() (dump() is called) or a row array. dump() is a
 *             METHOD, not a getter: this snapshot is taken once per save.
 *   Merges `cursor` into the last saved/loaded cursor, then writes
 *   `{ v: 1, cursor, corpus }` newest-first, shrinking on quota.
 *   Returns the written payload, or null if nothing could be kept.
 *
 * load()  -> { v, cursor, corpus } | null
 *   Three-element legacy rows stay in the array; createCorpus.load() is what
 *   upgrades them. No version bump — the fourth element was additive.
 *
 * clear()  forgets the accumulated cursor and removes the key.
 *
 * trimmed  rows that would not fit, for the door's lane.storeTrimmed line.
 *          0 whenever everything fit, which is the ordinary case.
 */
export function createLaneStore({ storage, key } = {}) {
  let lastCursor = null;
  let trimmed = 0;

  function rowsFrom(corpus) {
    if (corpus && typeof corpus.dump === 'function') return corpus.dump();
    if (Array.isArray(corpus)) return corpus.slice();
    return [];
  }

  function save({ cursor, corpus } = {}) {
    if (cursor) lastCursor = Object.assign({}, lastCursor || {}, cursor);
    if (!lastCursor) return null;
    const rows = rowsFrom(corpus);
    /* NEWEST FIRST, so a trim takes from the far end. The corpus is a contiguous
       window from the newest message backwards and the reach line depends on it;
       cutting the near end would leave a hole beside the date being claimed.
       This is the same newest-window rule createCorpus uses, applied to the copy
       that goes to disk. A row with no timestamp sorts oldest and goes first. */
    rows.sort((a, b) => (b[2] || 0) - (a[2] || 0));
    /* SHRINK, DO NOT DROP EVERYTHING.
       The old catch removed the whole entry on any failure, so one quota error
       cost the reader every page they had ever walked — cursor included, which
       is the expensive half. Halving retries land on a size that fits in at
       most ~13 tries.

       Storage is shared with neo on this origin and most engines account quota
       in UTF-16, i.e. two bytes per character: measured, 5,000 rows is ~1.5 MB
       of a typical 5 MB budget, which is why CORPUS_MAX sits where it does
       rather than at the 9,392 that would hold all of Cashtab.

       The floor is 1, not 0: a cursor stored beside an EMPTY corpus is the
       exact "resumes past pages it can no longer search" state this pair was
       written as one value to make unreachable. If even one row will not fit,
       take nothing. */
    let n = rows.length;
    for (;;) {
      try {
        const payload = { v: 1, cursor: lastCursor, corpus: rows.slice(0, n) };
        storage.setItem(key, JSON.stringify(payload));
        trimmed = rows.length - n;
        return payload;
      } catch {
        if (n <= 1) {
          try { storage.removeItem(key); } catch {}
          trimmed = rows.length;
          return null;
        }
        n = Math.floor(n / 2);
      }
    }
  }

  function load() {
    try {
      const raw = JSON.parse(storage.getItem(key) || 'null');
      if (!raw || typeof raw !== 'object' || !raw.cursor || !Array.isArray(raw.corpus)) return null;
      lastCursor = raw.cursor;
      return raw;
    } catch { return null; }
  }

  function clear() {
    lastCursor = null;
    trimmed = 0;
    try { storage.removeItem(key); } catch {}
  }

  return {
    save,
    load,
    clear,
    get trimmed() { return trimmed; },
    get cursor() { return lastCursor; },
  };
}
