// vendor/core/lane-corpus.js — bounded searchable store of scanned Lane text (ESM).
//
// Lives outside the page's inline module on purpose: it is same-origin, so
// `script-src 'self'` already covers it and it costs NO extra CSP hash, and
// every line moved out here shrinks the hash-pinned module (the door.js lesson,
// CLAUDE.md). Import it with a `?v=` token and bump that token on any change —
// an ES-module import is cached like any other resource, and a stale copy that
// is missing a newly added export throws and takes the whole page down.
//
// What this module deliberately does NOT do: decide WHAT to search, or own a
// Map the door can `.set()` past the cap. The door asks with `terms`, `mutes`,
// `scope`, `range` and `mode`; this file answers with ids. No `state`, no DOM,
// no storage, no network — neo can adopt this file unchanged.
//
// matchAny / matchEvery come from match.js rather than being re-implemented.
// inScope / inRange come from lane-cursor.js. The specifiers match Flow's so
// the browser holds one copy of each.

import { matchAny, matchEvery } from './match.js?v=7';
import { inScope, inRange } from './lane-cursor.js?v=1';

/* THE CORPUS, and why it exists — this is the fix for a real bug, recorded so it
   is not "simplified" away.

   The prefilter already decodes every scanned transaction's on-chain text.
   The first version threw that away and kept `raw: txData` — the whole chronik
   object — for the few that matched: it kept the expensive thing and discarded
   the cheap one. Worse, because nothing was cached, a NEW term had to walk the
   index again, and since the cursor was persisted it resumed mid-walk, so the
   newest pages were unreachable for that term forever. Reproduced live: a fresh
   term started at page 3 of every protocol and could never see pages 0-2.

   Keeping {text, ts} per scanned tx dissolves all of it. A new term is answered
   LOCALLY from what was already paid for — no requests, no cursor question — and
   the cursor stops meaning "how far this term looked" (which must never be
   reused across terms) and starts meaning "how much index is cached" (which is a
   fact about the cache, so persisting it is correct). Only genuine matches that
   are not already parsed cost a request, and only one each. */
/* The entry carries WHICH INDEX FOUND IT, and that tag comes from the walk
   rather than from the script. An eMPP payload names several protocols and
   chronik indexes the transaction under each, so the bytes have no single
   answer; the index it was read from is exactly the fact the scope picker asks
   about. Costs 11 bytes on a measured 155-byte row — 7%.

   `lokad` is null for a row saved before this existed. Null is never treated as
   out of scope: we cannot prove it, and guessing would hide results the reader
   paid for. Those rows self-heal, because anything that matches gets hydrated
   anyway and the door learns the tag then, at no extra request. */

/* The corpus is a window from the NEWEST held message backwards. A newest-first
   walk only ever offers older rows once full, so those are refused. A seek that
   filled from the middle first then left `done` on the cursor is the other
   shape: page 0 arrives later, is newer than everything held, and MUST enter —
   otherwise a new term is answered from 2023 while the messages it wants sat on
   page 0, and "Read all of Cashtab Msg" is a lie. Evict the oldest in that case
   only. Insertion-order eviction stays forbidden.

   The cap is this module's invariant. The door must not be able to `.set()`
   past it, which is why the engine owns the Map rather than accepting one. The
   floor is one row: a zero cap is the empty-corpus-beside-a-cursor state the
   store-as-one-value rule exists to make unreachable. */

/**
 * @param {object} [o]
 * @param {number} [o.max]  hard cap on rows; floor 1. Flow passes CORPUS_MAX.
 *
 * dump() is a METHOD, not a getter. createBackfill clones on every `.cursor`
 * read because the walk is live; this snapshot is taken once per save, and a
 * getter that allocated 5,000 arrays on `if (c.dump)` would be the wrong
 * shape. The clone is the point: createLaneStore.save() sorts and slices the
 * copy for the quota trim, and that must not reorder or drop rows in the Map.
 *
 * Row shape is the one saveLaneStore already writes and restoreLaneStore
 * already reads: `[id, text, ts, lokad, from]`. Three-element legacy rows
 * (no tag, no sender) load as `lokad: null, from: null`. load() does not
 * clear first — restore lands on an empty instance at boot, and a merge
 * through add() is how a legacy row upgrades in place.
 */
export function createCorpus({ max = 5000 } = {}) {
  const cap = Math.max(1, max | 0);
  const map = new Map();
  let full = false;
  let gen = 0;

  function add(txid, text, ts, lokad, from) {
    const had = map.get(txid);
    // A row restored without a tag is UPGRADED in place when the walk meets the
    // same transaction again. Returning early here — the obvious shape — would
    // leave a legacy row untagged forever, since the corpus never evicts.
    if (had) {
      let bumped = false;
      if (!had.lokad && lokad) { had.lokad = lokad; bumped = true; }
      if (!had.from && from) { had.from = from; bumped = true; }
      if (bumped) gen++;
      return;
    }
    if (map.size >= cap) {
      let oldestId = null, oldestTs = Infinity;
      for (const [id, e] of map) {
        const t = e.ts || 0;
        if (t < oldestTs) { oldestTs = t; oldestId = id; }
      }
      const incoming = ts || 0;
      if (!oldestId || incoming <= oldestTs) { full = true; return; }
      map.delete(oldestId);
      full = true;
    }
    map.set(txid, { text, ts: ts || null, lokad: lokad || null, from: from || null });
    gen++;
  }

  // Answer a term from the corpus alone. No requests, no cursor, instant.
  //
  // OUT-OF-SCOPE HITS ARE COUNTED, NOT JUST DROPPED. A returning reader's corpus
  // was gathered across all six protocols in proportion to their text yield, so
  // roughly four fifths of it sits outside the new default — dropping that in
  // silence would read as lost data. The count rides back to the coverage line,
  // and re-ticking the box brings every one of them straight back with no request.
  /* A SET OF IDS, NOT A COUNTER. Almost every hydrated result is in both the
     corpus and the door's parsed hold — the corpus records what was scanned,
     the hold what was parsed — so two independent counters would report the
     same hidden message twice, and the line would claim roughly double what
     one tick brings back. */
  function matches({ terms, mutes, scope, range, mode } = {}) {
    const out = [];
    const hidden = new Set(), noDate = new Set();
    const follow = Array.isArray(terms) ? terms : [];
    const muteList = Array.isArray(mutes) ? mutes : [];
    if (!follow.length) return { ids: out, hidden, noDate };
    const sc = Array.isArray(scope) ? scope : [];
    const rng = range || { from: null, to: null };
    const hit = (hay) => (mode === 'all' ? matchEvery(hay, follow) : matchAny(hay, follow));
    for (const [txid, e] of map) {
      if (muteList.length && matchAny(e.text, muteList)) continue;
      if (!hit(e.text)) continue;
      if (!inScope(e.lokad, sc)) { hidden.add(txid); continue; }
      // The window is applied AFTER the scope, and counted apart from it: they are
      // two different reasons a match is not on screen, and one checkbox brings
      // back only one of them.
      if (!inRange(e.ts, rng)) { if (!e.ts) noDate.add(txid); continue; }
      out.push(txid);
    }
    return { ids: out, hidden, noDate };
  }

  function dump() {
    const rows = [];
    for (const [id, e] of map) {
      rows.push([id, e.text, e.ts, e.lokad || null, e.from || null]);
    }
    return rows;
  }

  function load(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') continue;
      // row[3] is absent on everything written before the scope picker; null there
      // means "protocol unknown", which inScope() reads as in — never as out.
      add(row[0], row[1], Number.isFinite(row[2]) ? row[2] : null,
          typeof row[3] === 'string' ? row[3] : null,
          typeof row[4] === 'string' ? row[4] : null);
    }
    if (map.size >= cap) full = true;
  }

  function clear() {
    map.clear();
    full = false;
    gen++;
  }

  return {
    add,
    matches,
    dump,
    load,
    clear,
    get(txid) { return map.get(txid); },
    has(txid) { return map.has(txid); },
    values() { return map.values(); },
    [Symbol.iterator]() { return map[Symbol.iterator](); },
    get size() { return map.size; },
    get full() { return full; },
    get gen() { return gen; },
  };
}
