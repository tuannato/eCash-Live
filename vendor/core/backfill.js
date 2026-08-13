// =============================================================================
// backfill.js — retrospective walk of chronik's LOKAD ID index.
//
// The live stream is protocol-agnostic but only ever moves FORWARD. This walks
// BACKWARD, and it does so through chronik's own index rather than by scanning
// blocks: `/lokad-id/<id>/history` is newest-first, reaches to genesis, and
// returns message txs instead of everything. Measured on a real 6,174-tx Agora
// corpus, a block scan yields 0 searchable messages for its entire bandwidth.
//
// DELIBERATELY DOM-FREE, STORAGE-FREE AND DEPENDENCY-FREE. It takes a chronik
// client, a parser and a predicate, and hands results back through a callback.
// Both doors can therefore use it unchanged: Flow renders into the Lane, neo
// into its feed. Anything that reaches for `document`, `localStorage` or a
// door-specific import belongs in the caller, not here.
//
// WHAT THIS FILE REFUSES TO DO, and why:
//   - It keeps no results. Batches are streamed out; the caller owns the cap.
//     An engine that accumulated would grow without a bound it can see.
//   - It never claims coverage it did not get. A failed page is recorded as a
//     HOLE and the walk continues past it; silence is not an option, and
//     stopping a whole protocol on one bad page turns a transient error into
//     permanent absence.
//   - It does not persist. Cursors go in and come out; the door owns the key.
// =============================================================================

// chronik's MAX_HISTORY_PAGE_SIZE (chronik-indexer/src/query/group_history.rs).
// Asking for more is rejected by the node.
export const MAX_PAGE_SIZE = 200;

// Consecutive failed pages on ONE lokad before it is abandoned for this run.
// A cap is required, not defensive: when the very first page fails `numPages`
// is still unknown, so there is no natural end to walk toward.
const FAIL_MAX = 3;

// Bound on the dedupe set. NOTE: this set is an OPTIMISATION, not correctness —
// both doors already key transactions by txid, so an eviction can only cost one
// redundant parse, never a duplicated render. Do not "fix" this cap by removing
// it; unbounded is the actual bug (§10).
const SEEN_CAP = 5000;

// Holes are a permanent record — the walk never re-reads a failed page — so the
// list only ever grows, and against an unreachable node it grows every click:
// measured at 240 entries after 40 clicks across six protocols, with snapshot()
// copying the whole array once per page. The COUNT is what the coverage line
// states and it stays exact; the entries themselves are diagnostics, and the
// oldest ones stop being useful long before the newest do (§10).
const HOLES_CAP = 200;

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

function tsOf(txData) {
  const t = (txData && txData.block && txData.block.timestamp) || (txData && txData.timeFirstSeen);
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {object}   o
 * @param {object}   o.chronik     chronik client exposing lokadId(id).history(page, size)
 * @param {string[]} o.lokads      ids to walk (see MESSAGE_LOKADS in txparse.js)
 * @param {function} o.parse       (txData, lokadId) => tx|null — the door's parse + scrub
 * @param {function} [o.prefilter] (txData, lokadId) => boolean — CHEAP test run BEFORE parse
 * @param {function} [o.keep]      (tx) => boolean — the door's matcher; default keep-all
 * @param {function} [o.onBatch]   (txs, coverage, lokadId) => void
 * @param {number}   [o.pageSize]
 *
 * WHICH INDEX PRODUCED A TRANSACTION is knowledge only this walk has, so it is
 * handed to every caller-supplied function as a trailing argument. A door that
 * lets the reader choose protocols needs it to tag what it caches: the script
 * cannot answer the question, because an eMPP payload carries several LOKAD ids
 * and chronik indexes the tx under each — "the index it was found under" is a
 * fact about the walk, not about the bytes. The argument is additive; a callback
 * that ignores it behaves exactly as before.
 *
 * USE `prefilter`. It is the difference between a usable feature and an
 * unusable one, measured, not guessed: full-parsing one 200-tx page of Cashtab
 * messages costs **1950 ms**, while reading only `outputs[0]`'s OP_RETURN,
 * matching on that, and full-parsing the handful that survive costs **2 ms** —
 * a 1064x saving on real chronik data. A full parse resolves inputs, outputs,
 * addresses, token entries and Agora state; a search needs none of that until
 * a transaction has already matched. Without a prefilter, one click across six
 * protocols spends ~13 seconds of main-thread time and no amount of yielding
 * hides it.
 */
export function createBackfill({ chronik, lokads, parse, prefilter, keep, onBatch, pageSize = MAX_PAGE_SIZE }) {
  if (!chronik) throw new Error('backfill: chronik client required');
  if (!Array.isArray(lokads) || !lokads.length) throw new Error('backfill: lokads required');
  if (typeof parse !== 'function') throw new Error('backfill: parse required');

  const size = Math.max(1, Math.min(MAX_PAGE_SIZE, pageSize | 0));
  const seen = new Set();
  let rrIndex = 0;

  const cursor = {};
  for (const id of lokads) {
    cursor[id] = {
      /* WHICH PAGES HAVE BEEN READ, as merged `[start, end, oldestTs)` intervals
         rather than one high-water mark.
         A mark was enough while the only way to move was downward from page 0.
         Once a seek can land in the middle, a mark has to either claim the pages
         it jumped over or forget the ones it read, and both are lies about
         coverage. Each interval carries the oldest timestamp seen inside it, so
         the run that starts at page 0 — the only part a "searched in full back
         to X" sentence may describe — can be read off directly, and the rest
         disclosed separately as what it is. */
      ranges: [],
      pagesDone: 0, numPages: null, numTxs: null,
      // Oldest seen ANYWHERE, seeked-to regions included. Never the reach claim.
      oldestTs: null,
      done: false, failed: false,
      // Out of pages FOR THIS QUESTION (a date bound stopped it, or it ran off
      // the end of the index below a seek). Not `done`: nothing about the index
      // was exhausted, so it must never read as fully covered.
      rangeDone: false,
      pos: 0,          // next page to read — runtime only, deliberately not persisted
      seekedFor: null, // the maxTs this protocol is already positioned for
    };
  }
  const holes = [];
  let holeCount = 0;   // exact, unlike holes.length once the cap bites
  let requests = 0, scanned = 0, deduped = 0, kept = 0, skipped = 0, probes = 0;

  function noteSeen(txid) {
    seen.add(txid);
    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
  }

  /** Merge `[a, b)` into st.ranges as `[a, b, oldestTs, newestTs]`.
   *
   *  BOTH ENDS, because a run read out of order has to be describable. The
   *  oldest alone answers "how far back does the prefix reach"; a window seeked
   *  to in the middle needs to say where it STARTS as well, or a coverage line
   *  can only report a floating date with no span attached to it.
   *
   *  TOUCHING COUNTS AS OVERLAPPING: [0,5) beside [5,9) is one run of pages, and
   *  leaving them apart would make the prefix stop short of what was read. */
  function addRange(st, a, b, oldest, newest) {
    const norm = (v) => (v == null ? null : v);
    const list = st.ranges.concat([[a, b, norm(oldest), norm(newest == null ? oldest : newest)]]);
    list.sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of list) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) {
        last[1] = Math.max(last[1], r[1]);
        if (r[2] != null) last[2] = last[2] == null ? r[2] : Math.min(last[2], r[2]);
        if (r[3] != null) last[3] = last[3] == null ? r[3] : Math.max(last[3], r[3]);
      } else out.push([r[0], r[1], r[2], r[3]]);
    }
    st.ranges = out;
  }
  /** The contiguous run starting at page 0, or null. */
  function prefix(st) { const r = st.ranges[0]; return (r && r[0] === 0) ? r : null; }
  function prefixEnd(st) { const r = prefix(st); return r ? r[1] : 0; }
  /** Step forward over anything already read, so a walk never pays twice. */
  function skipRead(st, from) {
    let p = from;
    for (let guard = 0; guard <= st.ranges.length; guard++) {
      const r = st.ranges.find((x) => p >= x[0] && p < x[1]);
      if (!r) return p;
      p = r[1];
    }
    return p;
  }
  /** Exhausted means the run FROM PAGE 0 covers the index. A seek that happens
   *  to touch the last page proves nothing about the middle. */
  function isDone(st) { return st.numPages != null && prefixEnd(st) >= st.numPages; }

  function snapshot() {
    const perLokad = {};
    for (const id of lokads) {
      const c = cursor[id];
      perLokad[id] = { ...c, ranges: c.ranges.map((r) => r.slice()) };
    }
    return {
      perLokad,
      requests, scanned, deduped, kept, skipped,
      // Probes are requests too, and tiny ones — reported apart so a caller can
      // tell a 22 KB lookup from a page it paid a megabyte for.
      probes,
      // Read holeCount, not holes.length: the list is capped, the count is not.
      holeCount,
      holes: holes.slice(),
      // How far back the walk reached ANYWHERE. Coverage sentences want the
      // per-protocol prefix in `perLokad[id].ranges[0]`, not this — a seek makes
      // the two different numbers, which is the whole reason ranges exist. null
      // while nothing has been read — never 0, which would render as 1970.
      oldestTs: lokads.reduce((acc, id) => {
        const t = cursor[id].oldestTs;
        return t == null ? acc : (acc == null ? t : Math.min(acc, t));
      }, null),
      done: lokads.every((id) => cursor[id].done),
    };
  }

  /** Land on the page holding `targetTs` without walking down to it.
   *
   *  The index is newest-first and — measured on real data at pages 0-3 plus
   *  probes at 47/94/141/187 — strictly descending with NO overlap between
   *  pages, so a rank can be bisected on its timestamp. The probe asks for
   *  pageSize 1, where the page index IS the transaction's rank, so a step costs
   *  ONE transaction (~1.5 KB measured) instead of a whole page. Fourteen probes
   *  (~22 KB, 6-10s) land anywhere in a 9,392-entry index; walking to the same
   *  place costs ~25 MB.
   *
   *  Exact to the BLOCK, which is all a date can mean: transactions in one block
   *  share a timestamp, and chronik does not promise a stable order among them
   *  across page sizes (measured — 18 in one block reorder). The caller reads a
   *  real page from here and walks on, so a few positions either way cost
   *  nothing. Returns a page index at this instance's `size`, or null.
   */
  async function seekPage(id, targetTs, signal) {
    const st = cursor[id];
    if (!st) return null;
    const probe = async (rank) => {
      probes++; requests++;
      const p = await chronik.lokadId(id).history(rank, 1);
      if (Number.isInteger(p && p.numTxs)) st.numTxs = p.numTxs;
      const d = (p && p.txs && p.txs[0]) || null;
      return d ? tsOf(d) : null;
    };
    try { if (st.numTxs == null) await probe(0); } catch { return null; }
    const total = st.numTxs;
    if (!Number.isInteger(total) || total <= 0) return null;
    let lo = 0, hi = total - 1;
    while (lo <= hi) {
      if (signal && signal.aborted) break;
      const mid = (lo + hi) >> 1;
      let ts = null;
      try { ts = await probe(mid); } catch { break; }
      if (ts == null) break;
      // Newer than the target means the answer is deeper in the index.
      if (ts > targetTs) lo = mid + 1; else hi = mid - 1;
    }
    const rank = Math.min(Math.max(lo, 0), total - 1);
    return Math.floor(rank / size);
  }

  /** One page from each unread protocol per pass — plain round-robin.
   *
   *  A previous version chose the protocol holding the coverage floor, which is
   *  optimal for moving the reported date and WRONG for the product. On real
   *  data the floor is held by PayButton, whose text field is machine-generated
   *  order identifiers, so every request went to the one protocol that can
   *  essentially never contain human writing: the date advanced steadily while
   *  the result count did not move at all. Measured — six pages of PayButton,
   *  zero new matches, on a topic with fifty-nine existing ones.
   *
   *  Round-robin is not the wasteful option it looks like, because it settles
   *  itself: a protocol that runs out is marked done and stops taking a share,
   *  so the sparse ones cost a bounded number of pages and then step aside. The
   *  price is that the reported floor moves only as fast as the densest
   *  protocol allows — which is not a scheduling artifact but the truth about
   *  how deep the coverage actually is.
   */
  function nextLokad() {
    for (let i = 0; i < lokads.length; i++) {
      const id = lokads[(rrIndex + i) % lokads.length];
      // Abandoned is skipped for THIS run — there is nothing more to try now —
      // but it is not `done`, so it never counts as covered.
      // rangeDone is per-run and per-question: a date bound stopped this
      // protocol, or it ran off the end of the index below a seek. Skipped like
      // `failed`, and like `failed` it is NOT `done`.
      const c = cursor[id];
      if (!c.done && !c.failed && !c.rangeDone) { rrIndex = (rrIndex + i + 1) % lokads.length; return id; }
    }
    return null;
  }

  return {
    get cursor() { return JSON.parse(JSON.stringify(cursor)); },
    get coverage() { return snapshot(); },

    /** Restore a persisted cursor. Unknown ids are ignored so removing a lokad
     *  from the list can never resurrect it, and anything past a known
     *  `numPages` is clamped rather than trusted.
     *
     *  A pre-ranges save carried a single `page` high-water mark, and `[0, page)`
     *  is exactly what it meant — so the migration is lossless and needs no
     *  version flag. Both shapes are accepted, because a reader who opens an old
     *  build after a new one would otherwise lose every page they had walked. */
    load(saved) {
      if (!saved || typeof saved !== 'object') return;
      for (const id of lokads) {
        const s = saved[id];
        if (!s || typeof s !== 'object') continue;
        const c = cursor[id];
        c.pagesDone = Number.isInteger(s.pagesDone) && s.pagesDone >= 0 ? s.pagesDone : 0;
        c.numPages = Number.isInteger(s.numPages) && s.numPages >= 0 ? s.numPages : null;
        c.numTxs = Number.isInteger(s.numTxs) && s.numTxs >= 0 ? s.numTxs : null;
        c.oldestTs = Number.isFinite(s.oldestTs) ? s.oldestTs : null;
        c.ranges = [];
        if (Array.isArray(s.ranges)) {
          for (const r of s.ranges) {
            if (!Array.isArray(r)) continue;
            const a = r[0], b = r[1];
            if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b <= a) continue;
            addRange(c, a, b, Number.isFinite(r[2]) ? r[2] : null, Number.isFinite(r[3]) ? r[3] : null);
          }
        } else if (Number.isInteger(s.page) && s.page > 0) {
          addRange(c, 0, s.page, c.oldestTs, null);   // v1 watermark: only a floor was ever stored
        }
        if (c.numPages != null) {
          c.ranges = c.ranges
            .map((r) => [r[0], Math.min(r[1], c.numPages), r[2], r[3]])
            .filter((r) => r[1] > r[0]);
        }
        c.done = isDone(c);
        c.pos = skipRead(c, 0);
      }
    },

    /** Exposed for a caller that wants to position without reading — the Lane
     *  uses run({maxTs}) instead, which seeks on its own budget. */
    seek(id, targetTs, { signal } = {}) { return seekPage(id, targetTs, signal); },

    /**
     * Walk up to `requests` pages. The budget is counted in REQUESTS, not
     * transactions: one request is one page of up to `size` full tx objects,
     * and that is the unit a node actually feels.
     *
     * `minTs` / `maxTs` are the two ends of a date window, and they cost very
     * different things. `minTs` is only a stop condition on a walk that was
     * happening anyway, so it is free. `maxTs` means starting somewhere other
     * than the top, which needs a seek — charged to its OWN budget, because a
     * probe is a single transaction and taking it out of the page budget would
     * trade a ~22 KB lookup for a lost page of results.
     */
    async run({ requests: budget = 6, signal, minTs = null, maxTs = null } = {}) {
      // A new run is the caller asking again, so give an abandoned protocol
      // another chance. Its holes stay on the record; only the giving-up resets.
      // rangeDone goes too: it described the PREVIOUS question's bounds.
      for (const id of lokads){ const c = cursor[id]; c.failed = false; c.fails = 0; c.rangeDone = false; }
      // Position first, once per protocol per window. Doing it here rather than
      // per page keeps a 14-probe bisection from repeating six times.
      if (maxTs != null) {
        for (const id of lokads) {
          if (signal && signal.aborted) break;
          const st = cursor[id];
          if (st.done || st.seekedFor === maxTs) continue;
          const p = await seekPage(id, maxTs, signal);
          if (p == null) continue;
          st.pos = skipRead(st, p);
          st.seekedFor = maxTs;
        }
      } else {
        // No newer bound: back to the top of the index, extending the run that
        // starts at page 0. Without this reset a window left over from an
        // earlier question would keep the walk stranded deep in the index.
        for (const id of lokads) {
          const st = cursor[id];
          if (st.seekedFor != null) { st.seekedFor = null; st.pos = skipRead(st, 0); }
        }
      }
      let used = 0;
      while (used < budget) {
        if (signal && signal.aborted) break;
        const id = nextLokad();
        if (!id) break;
        const st = cursor[id];
        const at = st.pos;

        let page;
        try {
          page = await chronik.lokadId(id).history(at, size);
          used++; requests++;
        } catch (err) {
          used++; requests++;
          holeCount++;
          holes.push({ lokad: id, page: at, err: String((err && err.message) || err) });
          if (holes.length > HOLES_CAP) holes.shift();
          st.fails = (st.fails || 0) + 1;
          // A failed page is a HOLE: step past it, but never record it as read.
          st.pos = skipRead(st, at + 1);
          // ABANDONED IS NOT DONE. Marking a protocol whose node kept failing
          // as `done` made it indistinguishable from one read to genesis, and
          // every consumer of `done` then treated it as fully covered: the reach
          // floor skipped it, the overall `done` flipped true, and the caller's
          // button said "searched everything" and disabled itself, so the reader
          // could not even retry. Two different facts need two different flags.
          if (st.fails >= FAIL_MAX) st.failed = true;
          else if (st.numPages != null && st.pos >= st.numPages) st.rangeDone = true;
          continue;
        }
        st.fails = 0;

        st.numPages = Number.isInteger(page && page.numPages) ? page.numPages : st.numPages;
        st.numTxs = Number.isInteger(page && page.numTxs) ? page.numTxs : st.numTxs;

        const out = [];
        // The oldest timestamp ON THIS PAGE, kept apart from st.oldestTs: it is
        // what the page's interval carries, and what a minTs bound is tested
        // against. Recorded for every transaction, dedupe included.
        let pageOldest = null, pageNewest = null;
        for (const txData of ((page && page.txs) || [])) {
          const txid = txData && txData.txid;
          if (!txid) continue;
          // HOW FAR BACK THIS PAGE REACHED IS A FACT ABOUT THE PAGE, so it is
          // recorded before the dedupe rather than after it. A transaction can
          // legitimately appear in more than one lokad history — an eMPP payload
          // carries several ids and chronik indexes the tx under each — so
          // dropping the timestamp along with the duplicate left a protocol that
          // had genuinely been read reporting oldestTs null. That is the exact
          // input laneReach() treats as "never read", so it refused to state any
          // date at all, and the caller then reported the protocol as unread.
          // Found by verifying the caller's fix, not by reading this file.
          const ts = tsOf(txData);
          if (ts != null) {
            st.oldestTs = st.oldestTs == null ? ts : Math.min(st.oldestTs, ts);
            pageOldest = pageOldest == null ? ts : Math.min(pageOldest, ts);
            pageNewest = pageNewest == null ? ts : Math.max(pageNewest, ts);
          }
          if (seen.has(txid)) { deduped++; continue; }
          noteSeen(txid);
          scanned++;
          // Cheap gate before the expensive parse — see the note on `prefilter`.
          // A throw here is treated as "not interesting" rather than fatal, for
          // the same reason the parse below is guarded.
          if (prefilter) {
            let want = false;
            try { want = !!prefilter(txData, id); } catch { want = false; }
            if (!want) { skipped++; continue; }
          }
          let tx = null;
          // One unparseable tx must not end the walk — it would turn a single
          // malformed script into the disappearance of everything older.
          try { tx = parse(txData, id); } catch { tx = null; }
          if (!tx) continue;
          if (keep && !keep(tx)) continue;
          out.push(tx);
        }
        kept += out.length;

        st.pagesDone++;
        // The page is on the record with the depth it actually reached, so the
        // run starting at page 0 can state its own oldest date without ever
        // borrowing one from a region a seek jumped to.
        addRange(st, at, at + 1, pageOldest, pageNewest);
        st.pos = skipRead(st, at + 1);
        st.done = isDone(st);
        // Two ways to be finished WITH THE QUESTION rather than with the index:
        // the window's older edge is behind us, or there is nothing below here.
        if (minTs != null && pageOldest != null && pageOldest < minTs) st.rangeDone = true;
        if (st.numPages != null && st.pos >= st.numPages) st.rangeDone = true;

        if (out.length && onBatch) onBatch(out, snapshot(), id);
        await yieldToUI();
      }
      return snapshot();
    },
  };
}
