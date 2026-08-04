// vendor/core/match.js — text matching for Flow's topic Lane (ESM).
//
// Lives outside the page's inline module on purpose: it is same-origin, so
// `script-src 'self'` already covers it and it costs NO extra CSP hash, and
// every line moved out here shrinks the hash-pinned module (the door.js lesson,
// CLAUDE.md). Import it with a `?v=` token and bump that token on any change —
// an ES-module import is cached like any other resource, and a stale copy that
// is missing a newly added export throws and takes the whole page down.
//
// What this module deliberately does NOT do: decide WHAT to search. It is given
// a haystack and a term. Flow passes only `msg.text` — real on-chain writing —
// never `msg.content`, which can be a parser-composed label nobody wrote.

// Case-fold for comparison.
//
// toLowerCase(), NOT toLocaleLowerCase(). The locale-tailored form is keyed to
// the UI language, which is the wrong locale for content written in another
// one, and Turkish is actively destructive: under 'tr', 'I'.toLocaleLowerCase()
// is 'ı' (dotless), so an English word containing I would stop matching itself
// the moment the reader switched the interface to Turkish.
export function normalize(s) {
  if (s == null) return '';
  return String(s).normalize('NFC').toLowerCase();
}

// Strip diacritics so "quan an ngon" finds "Quán ăn ngon".
//
// ONLY where the base character is Latin. Blanket \p{Mn} stripping is not
// acceptable: Thai and Devanagari vowel signs are also category Mn and are part
// of the word, so stripping them turns "ที่" into "ท" — a different string that
// no longer matches itself. This is why the fold is scoped by script, and why
// it is off by default and exposed as a per-term switch.
const LATIN_BASE = /\p{Script=Latin}/u;
const NONSPACING = /\p{Mn}/u;
export function foldLatinMarks(s) {
  if (!s) return '';
  const decomposed = String(s).normalize('NFD');
  let out = '';
  let base = '';
  for (const ch of decomposed) {
    if (NONSPACING.test(ch)) {
      if (LATIN_BASE.test(base)) continue;   // drop the mark, Latin base only
      out += ch;                              // keep it — it carries meaning here
    } else {
      base = ch;
      out += ch;
    }
  }
  return out.normalize('NFC');
}

// Split into word-like tokens.
//
// Intl.Segmenter is in every current browser, needs no library and no CSP
// change, and — the reason it is used rather than a regex — it segments CJK and
// Thai correctly despite those scripts not separating words with spaces. The
// regex fallback exists only for environments without it and is knowingly worse
// for those scripts.
export function segmentWords(s) {
  if (!s) return [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
      const out = [];
      for (const part of seg.segment(String(s))) {
        if (part.isWordLike) out.push(part.segment);
      }
      return out;
    } catch { /* fall through */ }
  }
  return String(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// matchTerm(haystack, term, { mode, fold })
//
//   mode 'word'     (default) the term must appear as a whole word, or as a
//                   contiguous run of whole words for a multi-word term.
//   mode 'contains' plain substring.
//
// Word mode is the default because substring matching is worse than it looks:
// the term "Vn" matches "seven", "even" and "given" in ordinary English text,
// so a topic would fill with noise on its first day.
export function matchTerm(haystack, term, opts) {
  const mode = (opts && opts.mode) || 'word';
  const fold = !!(opts && opts.fold);
  if (haystack == null || term == null) return false;

  let hay = normalize(haystack);
  let needle = normalize(term);
  if (fold) { hay = foldLatinMarks(hay); needle = foldLatinMarks(needle); }
  if (!hay || !needle) return false;

  if (mode === 'contains') return hay.includes(needle);

  const hayWords = segmentWords(hay);
  const termWords = segmentWords(needle);
  if (!termWords.length) return false;
  for (let i = 0; i + termWords.length <= hayWords.length; i++) {
    let all = true;
    for (let j = 0; j < termWords.length; j++) {
      if (hayWords[i + j] !== termWords[j]) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

// Convenience: does ANY enabled term match? Terms OR each other, so that turning
// on a second topic widens the Lane rather than narrowing it to their overlap.
export function matchAny(haystack, terms) {
  if (!haystack || !terms || !terms.length) return false;
  for (const t of terms) {
    if (!t || t.on === false || !t.q) continue;
    if (matchTerm(haystack, t.q, { mode: t.mode || 'word', fold: !!t.fold })) return true;
  }
  return false;
}
