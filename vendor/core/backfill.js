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
 * @param {function} o.parse       (txData) => tx|null — the door's parse + scrub
 * @param {function} [o.prefilter] (txData) => boolean — CHEAP test run BEFORE parse
 * @param {function} [o.keep]      (tx) => boolean — the door's matcher; default keep-all
 * @param {function} [o.onBatch]   (txs, coverage) => void
 * @param {number}   [o.pageSize]
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
    cursor[id] = { page: 0, pagesDone: 0, numPages: null, numTxs: null, oldestTs: null, done: false, failed: false };
  }
  const holes = [];
  let requests = 0, scanned = 0, deduped = 0, kept = 0, skipped = 0;

  function noteSeen(txid) {
    seen.add(txid);
    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
  }

  function snapshot() {
    const perLokad = {};
    for (const id of lokads) perLokad[id] = { ...cursor[id] };
    return {
      perLokad,
      requests, scanned, deduped, kept, skipped,
      holes: holes.slice(),
      // The single honest summary the coverage line needs: how far back the
      // walk actually reached across every protocol it managed to read. null
      // while nothing has been read — never 0, which would render as 1970.
      oldestTs: lokads.reduce((acc, id) => {
        const t = cursor[id].oldestTs;
        return t == null ? acc : (acc == null ? t : Math.min(acc, t));
      }, null),
      done: lokads.every((id) => cursor[id].done),
    };
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
      const c = cursor[id];
      if (!c.done && !c.failed) { rrIndex = (rrIndex + i + 1) % lokads.length; return id; }
    }
    return null;
  }

  return {
    get cursor() { return JSON.parse(JSON.stringify(cursor)); },
    get coverage() { return snapshot(); },

    /** Restore a persisted cursor. Unknown ids are ignored so removing a lokad
     *  from the list can never resurrect it, and a stored `page` past the known
     *  `numPages` is clamped rather than trusted. */
    load(saved) {
      if (!saved || typeof saved !== 'object') return;
      for (const id of lokads) {
        const s = saved[id];
        if (!s || typeof s !== 'object') continue;
        const c = cursor[id];
        c.page = Number.isInteger(s.page) && s.page >= 0 ? s.page : 0;
        c.pagesDone = Number.isInteger(s.pagesDone) && s.pagesDone >= 0 ? s.pagesDone : 0;
        c.numPages = Number.isInteger(s.numPages) && s.numPages >= 0 ? s.numPages : null;
        c.oldestTs = Number.isFinite(s.oldestTs) ? s.oldestTs : null;
        if (c.numPages != null && c.page >= c.numPages) { c.page = c.numPages; c.done = true; }
      }
    },

    /**
     * Walk up to `requests` pages. The budget is counted in REQUESTS, not
     * transactions: one request is one page of up to `size` full tx objects,
     * and that is the unit a node actually feels.
     */
    async run({ requests: budget = 6, signal } = {}) {
      // A new run is the caller asking again, so give an abandoned protocol
      // another chance. Its holes stay on the record; only the giving-up resets.
      for (const id of lokads){ cursor[id].failed = false; cursor[id].fails = 0; }
      let used = 0;
      while (used < budget) {
        if (signal && signal.aborted) break;
        const id = nextLokad();
        if (!id) break;
        const st = cursor[id];

        let page;
        try {
          page = await chronik.lokadId(id).history(st.page, size);
          used++; requests++;
        } catch (err) {
          used++; requests++;
          holes.push({ lokad: id, page: st.page, err: String((err && err.message) || err) });
          st.fails = (st.fails || 0) + 1;
          st.page++;
          // ABANDONED IS NOT DONE. Marking a protocol whose node kept failing
          // as `done` made it indistinguishable from one read to genesis, and
          // every consumer of `done` then treated it as fully covered: the reach
          // floor skipped it, the overall `done` flipped true, and the caller's
          // button said "searched everything" and disabled itself, so the reader
          // could not even retry. Two different facts need two different flags.
          if (st.fails >= FAIL_MAX) st.failed = true;
          else if (st.numPages != null && st.page >= st.numPages) st.done = true;
          continue;
        }
        st.fails = 0;

        st.numPages = Number.isInteger(page && page.numPages) ? page.numPages : st.numPages;
        st.numTxs = Number.isInteger(page && page.numTxs) ? page.numTxs : st.numTxs;

        const out = [];
        for (const txData of ((page && page.txs) || [])) {
          const txid = txData && txData.txid;
          if (!txid) continue;
          if (seen.has(txid)) { deduped++; continue; }
          noteSeen(txid);
          scanned++;
          const ts = tsOf(txData);
          if (ts != null) st.oldestTs = st.oldestTs == null ? ts : Math.min(st.oldestTs, ts);
          // Cheap gate before the expensive parse — see the note on `prefilter`.
          // A throw here is treated as "not interesting" rather than fatal, for
          // the same reason the parse below is guarded.
          if (prefilter) {
            let want = false;
            try { want = !!prefilter(txData); } catch { want = false; }
            if (!want) { skipped++; continue; }
          }
          let tx = null;
          // One unparseable tx must not end the walk — it would turn a single
          // malformed script into the disappearance of everything older.
          try { tx = parse(txData); } catch { tx = null; }
          if (!tx) continue;
          if (keep && !keep(tx)) continue;
          out.push(tx);
        }
        kept += out.length;

        st.pagesDone++;
        st.page++;
        if (st.numPages != null && st.page >= st.numPages) st.done = true;

        if (out.length && onBatch) onBatch(out, snapshot());
        await yieldToUI();
      }
      return snapshot();
    },
  };
}
