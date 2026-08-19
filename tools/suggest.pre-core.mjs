/* FROZEN ORACLE — Flow's computeSuggestions as it stood at f702031, the commit
 * before the ranking moved to vendor/core/suggest.js. Lifted VERBATIM.
 *
 * DO NOT "fix" this by pointing it at the live flow/index.html. That door now
 * calls the core module, so re-extracting would compare the module to itself
 * and hide exactly the change this file exists to detect. The v2.8.0 parser
 * swap left the same note on internal/neo-inline.pre-b2.mjs for the same
 * reason.
 */
import { normalize as normalizeTerm, segmentWords } from '../vendor/core/match.js';

const HASHTAG_RE = /(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]{2,30})/gu;
const SHOUT_RE = /\b[A-Z][A-Z0-9]{2,11}\b/g;
const SHOUT_ONE = /^[A-Z][A-Z0-9]{2,11}$/;
const SUGGEST_MAX = 8;
const SUGGEST_MIN_DF = 3;
const SUGGEST_MIN_DF_TAG = 2;
const SUGGEST_DF_CEIL = 0.30;
const SUGGEST_MIN_SENDERS = 4;
const SUGGEST_MIN_SENDERS_TAG = 2;
const SUGGEST_TAG_SOFT = 4;
const SUGGEST_MAX_LEN = 20;

export function computeSuggestionsPreCore({ rows, wanted, taken }){
  const laneCorpus = { values: () => rows };
  const inScope = (lokad) => wanted({ lokad });
  const state = { laneScope: null, terms: [] };
  const run = () => {
  const df = new Map(), senders = new Map(), shown = new Map();
  const seenText = new Set();
  let docs = 0;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const addSender = (k, s) => {
    if (!s) return;
    let set = senders.get(k); if (!set){ set = new Set(); senders.set(k, set); }
    set.add(s);
  };
  for (const e of laneCorpus.values()){
    if (!e.text || !wanted(e)) continue;
    const key = normalizeTerm(e.text);
    const fresh = !seenText.has(key);
    if (fresh){ seenText.add(key); docs++; }
    const here = new Set();
    HASHTAG_RE.lastIndex = 0;
    let m;
    while ((m = HASHTAG_RE.exec(e.text)) !== null) here.add('#' + m[1]);
    for (const w of (e.text.match(SHOUT_RE) || [])) here.add(w);
    for (const w of segmentWords(key)){
      if (w.length > 1 && w.length <= SUGGEST_MAX_LEN) here.add(w);
    }
    for (const w of here){
      if (fresh) bump(df, w);
      addSender(w, e.from);
      if (!shown.has(w)) shown.set(w, w);      // remember the cased form as written
    }
  }
  if (!docs) return [];
  // `taken` is supplied by the caller in this harness.
  const qualify = (w, tier) => {
    const n = df.get(w) || 0;
    const minDf = tier === 1 ? SUGGEST_MIN_DF_TAG : SUGGEST_MIN_DF;
    if (n < minDf || n / docs > SUGGEST_DF_CEIL) return null;
    if (w.length > SUGGEST_MAX_LEN) return null;
    const norm = normalizeTerm(w);
    if (taken.has(norm)) return null;
    const need = tier === 1 ? SUGGEST_MIN_SENDERS_TAG
               : tier === 3 ? SUGGEST_MIN_SENDERS
               : 0;
    if (need && (senders.get(w) || { size: 0 }).size < need) return null;
    return { term: shown.get(w) || w, n, tier, norm };
  };
  const rank = (pred) => [...df.keys()].filter(pred).sort((a, b) => df.get(b) - df.get(a));
  const tags = [], shouts = [], words = [];
  for (const w of rank(w => w[0] === '#')){ const row = qualify(w, 1); if (row) tags.push(row); }
  for (const w of rank(w => w[0] !== '#' && SHOUT_ONE.test(w))){ const row = qualify(w, 2); if (row) shouts.push(row); }
  for (const w of rank(w => w[0] !== '#' && w === w.toLowerCase())){ const row = qualify(w, 3); if (row) words.push(row); }
  /* Soft cap: at most SUGGEST_TAG_SOFT hashtags while shout/word candidates
     exist. Leftover slots refill from the remaining tags, so 8/8 hashtags
     only happens when tiers 2 and 3 produced nobody. Fixed gates — no
     self-raising threshold that would oscillate between two opens. */
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
  };
  return run();
}
