// Harness for neo's first-visit language pick.
//   node tools/test-neo-lang.mjs
//
// Drives the SHIPPED pickInitialLang out of vendor/companion/echan.js. The
// point of the feature is that the two doors answer the same browser the same
// way, so the list-parity assertion below is as much the gate as the matrix is:
// if neo and Flow ever disagree about which codes exist, they disagree about
// what a first-time reader is shown, and no matrix over one door can see it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const echan = readFileSync(join(ROOT, 'vendor/companion/echan.js'), 'utf8');
const flow  = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');

/** Lift `function name(...) {...}` by balancing braces, skipping strings and
 *  comments. Keeps a leading `async` (see the trap in test-panel4-counter). */
function grab(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('not found: ' + name);
  const start = (at >= 6 && src.slice(at - 6, at) === 'async ') ? at - 6 : at;
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) { if (src[i] === '\\') i++; else if (src[i] === q) break; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

function codes(src, decl) {
  const m = src.match(new RegExp(decl + '\\s*=\\s*\\[([\\s\\S]*?)\\];'));
  if (!m) throw new Error('no ' + decl);
  return [...m[1].matchAll(/code:\s*'([^']+)'/g)].map(x => x[1]);
}

let n = 0;
const eq = (got, want, label) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  n++;
};

// --- the two doors must offer the same set, in the same order ---------------
const neoCodes = codes(echan, 'I18N_LANGS');
const flowCodes = codes(flow, 'I18N_LANGS');
eq(neoCodes, flowCodes, 'I18N_LANGS parity neo vs flow');
if (neoCodes.length !== 16) throw new Error('expected 16 languages, got ' + neoCodes.length);
n++;

// --- drive the shipped body -------------------------------------------------
const body = grab(echan, 'pickInitialLang');
const LANGS = neoCodes.map(c => ({ code: c }));
function run(saved, navLang) {
  const STORAGE = { lang: 'ecashlive.lang' };
  const lsGet = (k, fb) => (saved === null || saved === undefined ? fb : saved);
  const navigator = { language: navLang };
  const fn = new Function('lsGet', 'STORAGE', 'I18N_LANGS', 'navigator',
    body + '\nreturn pickInitialLang;')(lsGet, STORAGE, LANGS, navigator);
  return fn();
}

// 1. a stored choice always wins, whatever the browser says
eq(run('vi', 'de-DE'), 'vi', 'saved beats browser');
eq(run('zh-TW', 'en-US'), 'zh-TW', 'saved regional beats browser');
// 2. a stored value that is not a pack we ship falls through to the browser
eq(run('xx', 'ja'), 'ja', 'unknown saved falls through');
eq(run('', 'ko'), 'ko', 'empty saved falls through');
// 3. exact match, case-insensitive
eq(run(null, 'pt-BR'), 'pt-BR', 'exact regional');
eq(run(null, 'ZH-cn'), 'zh-CN', 'exact is case-insensitive');
// THE case that separates exact-match from base-match, and the only one in the
// whole set that can: zh-CN and zh-TW share a base. Without the exact step the
// base scan returns whichever Chinese pack is listed first, so a Taiwanese
// reader silently gets Simplified. Found by mutation-testing this file: every
// other case here passes with the exact step deleted.
eq(run(null, 'zh-TW'), 'zh-TW', 'zh-TW must not collapse to zh-CN');
// A SHARED LIMITATION, pinned here so it is a known shortcut and not a
// surprise. 'zh-Hant-TW' is a legitimate tag for Traditional Chinese, matches
// no code exactly, falls to the base scan, and takes the first zh* in the list
// — Simplified. Flow has done this since it shipped; neo now does it
// identically, which is the point of the port. Fixing it means fixing BOTH
// doors in a change of its own, or the two disagree again.
eq(run(null, 'zh-Hant-TW'), 'zh-CN', 'zh-Hant-TW falls to zh-CN on both doors (shared gap)');
// 4. base match when the region is one we do not ship
eq(run(null, 'vi-VN'), 'vi', 'base match vi-VN -> vi');
eq(run(null, 'de-AT'), 'de', 'base match de-AT -> de');
eq(run(null, 'pt-PT'), 'pt-BR', 'base match pt-PT -> pt-BR (only pt we ship)');
// 5. nothing matches, and the degenerate inputs
eq(run(null, 'sw-KE'), 'en', 'no match -> en');
eq(run(null, ''), 'en', 'empty navigator.language -> en');
eq(run(null, undefined), 'en', 'missing navigator.language -> en');

// --- the detected value must NOT be persisted -------------------------------
// Flow stores only an explicit choice; storing the guess would trap a reader
// who later changes their browser language.
if (/setItem|lsSet/.test(body)) {
  throw new Error('pickInitialLang persists the detected value; it must not');
}
n++;

// --- setLanguage must announce, and announce LAST ---------------------------
const setLang = grab(echan, 'setLanguage');
if (!/ecashlive:lang/.test(setLang)) {
  throw new Error('setLanguage does not dispatch ecashlive:lang');
}
const evAt = setLang.indexOf('ecashlive:lang');
const packAt = setLang.indexOf('loadLangPack');
if (packAt === -1 || evAt < packAt) {
  throw new Error('the event must fire after the pack loads, not before');
}
n++;

// --- boot must use it, not a hardcoded fallback -----------------------------
if (/lsGet\(\s*STORAGE\.lang\s*,\s*'en'\s*\)/.test(echan)) {
  throw new Error("boot still falls back to hardcoded 'en' instead of pickInitialLang");
}
n++;

console.log(`ok: neo language pick ${n} cases, ${neoCodes.length} languages, doors in parity`);
