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
   module that writes the key; if the merge lived on the door, every future door
   would have to remember it, and a missed Object.assign is silent data loss.

   Two instances of this module can write the same key (two tabs, two doors).
   Nobody considered that — there is no `storage` listener in the repo, and
   merging into an in-memory lastCursor lets the later setItem erase the earlier
   tab's pages. save() therefore RE-READS, then accumulates, so a second writer
   cannot un-claim what the first already recorded. The re-read lives OUTSIDE
   the shrink loop: that loop treats any throw as "payload too big", and a
   getItem/JSON.parse failure inside it would delete the reader's cache.

   Coverage is monotonic at equal numTxs (union the page intervals; a punch
   whose ranges are empty and done:false does not shrink a stored record).
   numTxs is the generation of those intervals: a growth-shift rewrites page
   numbers, and unioning the pre-shift intervals with the post-shift ones
   claims ranks nobody has read. The higher numTxs for a protocol wins that
   protocol wholesale. The door still owns the session alias it mutates
   (punch, shift-for-growth); it hands that object in and the merge keeps
   every key it did not touch. */

/**
 * @param {object} o
 * @param {object} o.storage  adapter with getItem/setItem/removeItem (the page store, or a fake)
 * @param {string} o.key      storage key — configuration, never a constant in this file
 * @param {number} [o.max]    corpus cap after the txid-union, newest-first. Floor 1.
 *                            Same number the door passes createCorpus. Default 5000.
 *
 * save({ cursor, corpus })
 *   cursor  — the engine's cursor this run, or the door's mutated saved cursor
 *   corpus  — a createCorpus() (dump() is called) or a row array. dump() is a
 *             METHOD, not a getter: this snapshot is taken once per save.
 *   Re-reads storage, merges `cursor` coverage-monotonically onto what is
 *   already there (and onto lastCursor), unions the corpus by txid, then writes
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
export function createLaneStore({ storage, key, max = 5000 } = {}) {
  let lastCursor = null;
  let trimmed = 0;
  const cap = Math.max(1, max | 0);

  function rowsFrom(corpus) {
    if (corpus && typeof corpus.dump === 'function') return corpus.dump();
    if (Array.isArray(corpus)) return corpus.slice();
    return [];
  }

  /* Re-read MUST stay out of the shrink loop. The loop learns "too big" by
     catching any throw from setItem; a getItem or JSON.parse that throws in
     there is mistaken for quota and, at n <= 1, removes the key. */
  function readStored() {
    try {
      const raw = JSON.parse(storage.getItem(key) || 'null');
      if (!raw || typeof raw !== 'object' || !raw.cursor || !Array.isArray(raw.corpus)) return null;
      return raw;
    } catch { return null; }
  }

  function save({ cursor, corpus } = {}) {
    const stored = readStored();
    const incoming = cursor || lastCursor;
    const storedCur = stored && stored.cursor;
    if (!incoming && !storedCur) return null;
    lastCursor = mergeCursors(storedCur, incoming);
    if (!lastCursor) return null;
    const rows = mergeRows(stored ? stored.corpus : [], rowsFrom(corpus));
    /* NEWEST FIRST, so a trim takes from the far end. The corpus is a contiguous
       window from the newest message backwards and the reach line depends on it;
       cutting the near end would leave a hole beside the date being claimed.
       This is the same newest-window rule createCorpus uses, applied to the copy
       that goes to disk. A row with no timestamp sorts oldest and goes first. */
    rows.sort((a, b) => (b[2] || 0) - (a[2] || 0));
    if (rows.length > cap) rows.length = cap;
    /* SHRINK, DO NOT DROP EVERYTHING.
       The old catch removed the whole entry on any failure, so one quota error
       cost the reader every page they had ever walked — cursor included, which
       is the expensive half. Halving retries land on a size that fits in at
       most ~13 tries.

       Storage is shared with neo on this origin and most engines account quota
       in UTF-16, i.e. two bytes per character: measured, 5,000 rows is ~1.73 MB
       of a typical 5 MB budget, which is why CORPUS_MAX sits where it does
       rather than at the 9,392 that would hold all of Cashtab. (The row grew to
       five elements after that measurement; ~173 JSON characters, not ~155.)

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
    /* LIVE OBJECT, NOT A CLONE — and deliberately unlike createBackfill.cursor,
       which deep-copies on every read. The door aliases this as its own saved
       cursor and mutates it in place (punch, shift-for-growth); save() then
       merges that same object forward, which is what keeps a deselected
       protocol's depth. Cloning here would silently discard those writes.

       So do NOT copy the `const before = laneBf.cursor` idiom onto this one.
       That snapshot works only because backfill clones; the same line here
       captures a live reference and any later diff against it is a no-op. */
    get cursor() { return lastCursor; },
  };
}

function copyProto(c) {
  if (!c || typeof c !== 'object') return c;
  const o = Object.assign({}, c);
  if (Array.isArray(o.ranges)) o.ranges = o.ranges.map((r) => (Array.isArray(r) ? r.slice() : r));
  return o;
}

function txCount(c) {
  return (c && Number.isInteger(c.numTxs) && c.numTxs >= 0) ? c.numTxs : 0;
}

/* A punch is an instruction to this session's engine, not a fact about the
   cache: empty ranges and done:false. Same-generation only — a growth-shift
   that collapsed every interval is also empty+done:false, but it carries a
   higher numTxs, and those empty ranges are the honest post-shift record. */
function isPunch(c) {
  return !!(c && c.done === false && Array.isArray(c.ranges) && c.ranges.length === 0);
}

function rangesOf(c) {
  if (!c) return null;
  if (Array.isArray(c.ranges)) return c.ranges;
  // Pre-ranges watermark: [0, page) is exactly what `page` meant (backfill.load).
  if (Number.isInteger(c.page) && c.page > 0) {
    return [[0, c.page, Number.isFinite(c.oldestTs) ? c.oldestTs : null, null]];
  }
  return null;
}

function unionRanges(a, b) {
  const list = [];
  for (const src of [a, b]) {
    if (!Array.isArray(src)) continue;
    for (const r of src) {
      if (!Array.isArray(r)) continue;
      const x = r[0], y = r[1];
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y <= x) continue;
      list.push([x, y, r[2] == null ? null : r[2], r[3] == null ? null : r[3]]);
    }
  }
  list.sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
      if (r[2] != null) last[2] = last[2] == null ? r[2] : Math.min(last[2], r[2]);
      if (r[3] != null) last[3] = last[3] == null ? r[3] : Math.max(last[3], r[3]);
    } else out.push(r.slice());
  }
  return out;
}

function mergeProtocol(stored, incoming) {
  const sN = txCount(stored), iN = txCount(incoming);
  // Higher numTxs is a new coordinate system. Do not union its intervals with
  // the ones it supersedes — they point at content that has moved.
  if (iN > sN) return copyProto(incoming);
  if (sN > iN) return copyProto(stored);
  if (isPunch(incoming)) return copyProto(stored);
  if (isPunch(stored)) return copyProto(incoming);

  const out = copyProto(Object.assign({}, stored, incoming));
  const sR = rangesOf(stored), iR = rangesOf(incoming);
  if (sR || iR) {
    out.ranges = unionRanges(sR || [], iR || []);
    out.pagesDone = out.ranges.reduce((n, r) => n + (r[1] - r[0]), 0);
  } else {
    const sp = Number.isInteger(stored.pagesDone) ? stored.pagesDone : 0;
    const ip = Number.isInteger(incoming.pagesDone) ? incoming.pagesDone : 0;
    out.pagesDone = Math.max(sp, ip);
  }
  if (Number.isInteger(stored.page) || Number.isInteger(incoming.page)) {
    out.page = Math.max(stored.page || 0, incoming.page || 0);
  }
  const sT = Number.isFinite(stored.oldestTs) ? stored.oldestTs : null;
  const iT = Number.isFinite(incoming.oldestTs) ? incoming.oldestTs : null;
  if (sT != null && iT != null) out.oldestTs = Math.min(sT, iT);
  else if (sT != null) out.oldestTs = sT;
  else if (iT != null) out.oldestTs = iT;
  out.done = !!(stored.done || incoming.done);
  const sP = Number.isInteger(stored.numPages) ? stored.numPages : null;
  const iP = Number.isInteger(incoming.numPages) ? incoming.numPages : null;
  if (sP != null || iP != null) out.numPages = Math.max(sP || 0, iP || 0);
  if (Number.isInteger(stored.numTxs) || Number.isInteger(incoming.numTxs)) {
    out.numTxs = Math.max(sN, iN);
  }
  return out;
}

function mergeCursors(stored, incoming) {
  if (!incoming && !stored) return null;
  if (!incoming) return copyCursor(stored);
  if (!stored) return copyCursor(incoming);
  const out = {};
  for (const id of new Set([...Object.keys(stored), ...Object.keys(incoming)])) {
    const s = stored[id], i = incoming[id];
    if (!i) out[id] = copyProto(s);
    else if (!s) out[id] = copyProto(i);
    else out[id] = mergeProtocol(s, i);
  }
  return out;
}

function copyCursor(cur) {
  if (!cur || typeof cur !== 'object') return cur;
  const out = {};
  for (const id of Object.keys(cur)) out[id] = copyProto(cur[id]);
  return out;
}

/* Union by txid. A row missing lokad or from is upgraded in place when the
   other side has them — the same rule as createCorpus.add, applied here so a
   second writer cannot drop a tag the first one paid to learn. */
function mergeRows(stored, incoming) {
  const map = new Map();
  const ingest = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
      const id = row[0];
      const had = map.get(id);
      if (!had) { map.set(id, row.slice()); continue; }
      if (!had[3] && row[3]) had[3] = row[3];
      if (!had[4] && row[4]) had[4] = row[4];
    }
  };
  ingest(stored);
  ingest(incoming);
  return Array.from(map.values());
}
