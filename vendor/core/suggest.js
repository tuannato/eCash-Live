/* Topic suggestions, shared by both doors.
 *
 * WHY THIS IS A MODULE AND NOT TWO IMPLEMENTATIONS. Both panes tell the reader
 * the chips come "from the {n} messages read so far", and both read the same
 * corpus out of the same stored value — so two rankings are two answers under
 * one claim. neo had a single tier (words, four senders, top eight) against
 * Flow's three, and on one corpus they disagreed. That is soul #6 broken by
 * duplication, and the fix is to have one ranking rather than to keep two in
 * step by hand.
 *
 * EVERY THRESHOLD BELOW CAME FROM MEASURING 1,000 LIVE CASHTAB MESSAGES, and
 * two of those measurements decided the design (aa73eca):
 *
 *   - 41% of the corpus is exact repeats, and one text appeared 50 times.
 *     Counting without deduping lets a single broadcast outvote fifty people,
 *     so documents are deduped BY TEXT before anything is counted.
 *
 *   - Ranked by frequency the top of the list was congratulations·119, win·115,
 *     casino·57, darts·51 — one casino bot's script. Ranked by how many
 *     DIFFERENT SENDERS wrote a word, casino is 1 while thanks, on far fewer
 *     messages, is 20. That is the campaign/topic boundary, and nothing else
 *     measured drew it. So tier 3 counts people, not messages.
 *
 * NO STOPWORD LIST, DELIBERATELY. A frequency ceiling was tried instead and the
 * data refused it: on real messages a 30% ceiling removed exactly one word
 * ("the"), because on-chain messages are short and heterogeneous. A real list
 * is sixteen translations and a correctness trap in Thai and Vietnamese, and a
 * suggestion is a chip nobody has to tap — the cost of one dull entry is low
 * and the cost of a wrong stopword list is not.
 *
 * TIER 3 IS ON BY THE OWNER'S DECISION, recorded so nobody quietly "improves"
 * it away. It does surface function words (a live 300-message corpus gave
 * XEC·11 BTX·10 POW·5 DOIT·4 alongside to·29 the·27 you·24 for·21). The author
 * recommended shipping tiers 1 and 2 only; the owner kept tier 3 with that
 * evidence in hand. Dropping it is deleting one loop — do not do it silently.
 */
import { normalize, segmentWords, findHashtags } from './match.js';

export const SUGGEST_MAX = 8;             // two comfortable rows on a phone
export const SUGGEST_MIN_DF = 3;          // shout + words: three distinct messages
export const SUGGEST_MIN_DF_TAG = 2;      // a hashtag is already a declared topic
export const SUGGEST_DF_CEIL = 0.30;      // and not in more than a third of them
export const SUGGEST_MIN_SENDERS = 4;     // tier 3 only: four different people
export const SUGGEST_MIN_SENDERS_TAG = 2; // one bot repeating #casino takes no slot
export const SUGGEST_TAG_SOFT = 4;        // at most half the row while 2/3 have anyone
export const SUGGEST_MAX_LEN = 20;        // beyond this it is an address or a URL

/* A shouted ticker: XEC, BTX, POW. Upper case is the signal, so this is the one
 * place the ORIGINAL text is read rather than the normalized copy. */
export const SHOUT_RE = /\b[A-Z][A-Z0-9]{2,11}\b/g;
export const SHOUT_ONE = /^[A-Z][A-Z0-9]{2,11}$/;   // /g is stateful — never .test() with it

/* `wanted` and `taken` have NO defaults, for the same reason createResultStore's
 * do not: each plausible default silently reinstates a bug. Defaulting `wanted`
 * to "everything" would mine protocols the reader has deselected — the scope
 * picker exists precisely to stop that — and defaulting `taken` to empty would
 * offer back the words they already follow.
 *
 * rows: iterable of { text, lokad, from }. `from` may be null; a row without it
 * simply contributes no sender, which lowers its rank rather than raising it.
 */
export function computeSuggestions({ rows, wanted, taken }) {
  if (typeof wanted !== 'function') throw new TypeError('computeSuggestions needs wanted(row)');
  if (!taken || typeof taken.has !== 'function') throw new TypeError('computeSuggestions needs taken:Set');

  const df = new Map(), senders = new Map(), shown = new Map();
  const seenText = new Set();
  let docs = 0;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const addSender = (k, s) => {
    if (!s) return;
    let set = senders.get(k); if (!set) { set = new Set(); senders.set(k, set); }
    set.add(s);
  };

  for (const e of rows) {
    if (!e || !e.text || !wanted(e)) continue;
    const key = normalize(e.text);
    /* DEDUPE BY TEXT, NOT BY ROW. The document count and every df below are
       counts of distinct MESSAGES; a broadcast sent fifty times is one thing
       somebody said, not fifty. Senders are still collected from every row,
       because fifty senders repeating one text is a different fact. */
    const fresh = !seenText.has(key);
    if (fresh) { seenText.add(key); docs++; }

    const here = new Set();
    for (const [, , tag] of findHashtags(e.text)) here.add(tag);
    for (const w of (e.text.match(SHOUT_RE) || [])) here.add(w);
    for (const w of segmentWords(key)) {
      if (w.length > 1 && w.length <= SUGGEST_MAX_LEN) here.add(w);
    }
    for (const w of here) {
      if (fresh) bump(df, w);
      addSender(w, e.from);
      if (!shown.has(w)) shown.set(w, w);   // remember the cased form as written
    }
  }
  if (!docs) return [];

  const qualify = (w, tier) => {
    const n = df.get(w) || 0;
    const minDf = tier === 1 ? SUGGEST_MIN_DF_TAG : SUGGEST_MIN_DF;
    if (n < minDf || n / docs > SUGGEST_DF_CEIL) return null;
    if (w.length > SUGGEST_MAX_LEN) return null;
    const norm = normalize(w);
    if (taken.has(norm)) return null;
    const need = tier === 1 ? SUGGEST_MIN_SENDERS_TAG
               : tier === 3 ? SUGGEST_MIN_SENDERS
               : 0;
    if (need && (senders.get(w) || { size: 0 }).size < need) return null;
    return { term: shown.get(w) || w, n, tier, norm };
  };
  const rank = (pred) => [...df.keys()].filter(pred).sort((a, b) => df.get(b) - df.get(a));

  const tags = [], shouts = [], words = [];
  for (const w of rank((w) => w[0] === '#')) { const row = qualify(w, 1); if (row) tags.push(row); }
  for (const w of rank((w) => w[0] !== '#' && SHOUT_ONE.test(w))) { const row = qualify(w, 2); if (row) shouts.push(row); }
  for (const w of rank((w) => w[0] !== '#' && w === w.toLowerCase())) { const row = qualify(w, 3); if (row) words.push(row); }

  /* SOFT CAP: at most SUGGEST_TAG_SOFT hashtags while shout/word candidates
     exist, with leftover slots refilled from the remaining tags — so 8/8
     hashtags happens only when tiers 2 and 3 produced nobody. Fixed gates, and
     no self-raising threshold: one that adapted to the last result would
     oscillate between two opens. */
  const out = [];
  const used = new Set();
  const take = (row) => {
    if (out.length >= SUGGEST_MAX || used.has(row.norm)) return;
    used.add(row.norm);
    out.push({ term: row.term, n: row.n, tier: row.tier });
  };
  for (const row of tags.slice(0, SUGGEST_TAG_SOFT)) take(row);
  for (const row of shouts) take(row);
  for (const row of words) take(row);
  for (const row of tags.slice(SUGGEST_TAG_SOFT)) take(row);
  return out;
}
