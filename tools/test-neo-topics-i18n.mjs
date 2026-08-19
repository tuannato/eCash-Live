// Harness for the Topics i18n layer on neo.
//   node tools/test-neo-topics-i18n.mjs
//
// Every assertion here reads the SHIPPED index.html. The failure this file
// exists to catch is drift that no runtime error reports: a borrowed sentence
// edited on one door only, a key used but never defined (which renders the raw
// key), a static node that quietly stops being translated because its id moved,
// and a date that is a day out east of Greenwich.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/* THE DATE ASSERTION IS DEAD IN UTC, and CI runners are UTC. Measured: the
   toISOString round trip is correct at offset 0 and wrong everywhere else, so a
   green run here would have proved nothing about the bug it exists to catch.
   Node reads TZ once at startup, so the only way to fix the zone is a child.
   Asia/Ho_Chi_Minh is chosen because it is a fixed +07:00 with no DST -- a zone
   that changes offset would make this suite pass or fail by season. */
if (new Date(2026, 0, 15).getTimezoneOffset() === 0 && new Date(2026, 6, 15).getTimezoneOffset() === 0) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit', env: Object.assign({}, process.env, { TZ: 'Asia/Ho_Chi_Minh' }),
  });
  process.exit(r.status === null ? 1 : r.status);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const neo = readFileSync(join(ROOT, 'index.html'), 'utf8');
const flow = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
const mod = neo.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];
const codeOnly = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let n = 0;
const ok = (cond, label) => { if (!cond) throw new Error('FAIL: ' + label); n++; };

/** Balanced slice of `const NAME = <open> ... <close>`, string- and
 *  comment-aware, for both object and array literals. */
function objectText(src, name, open = '{') {
  const close = open === '{' ? '}' : ']';
  const at = src.indexOf('const ' + name + ' = ' + open);
  if (at === -1) throw new Error('not found: ' + name);
  let i = src.indexOf(open, at), d = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) { if (src[i] === '\\') i++; else if (src[i] === q) break; }
      continue;
    }
    if (c === open) d++;
    else if (c === close) { d--; if (!d) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
/** Evaluate the literal rather than regex it: an apostrophe inside a value
 *  (there are several) is exactly what a regex parser gets wrong. */
function objectOf(src, name) {
  const txt = objectText(src, name).replace(/^const\s+\w+\s*=\s*/, '');
  return new Function('return (' + txt + ');')();
}

const BORROWED = objectOf(mod, 'TOPICS_EN_BORROWED');
const OWN      = objectOf(mod, 'TOPICS_EN_OWN');
const FLOW_EN  = objectOf(flow, 'FLOW_STRINGS_EN');

// ---------------------------------------------------------------------------
// 1. A BORROW IS A BORROW. A borrowed key whose English is edited here is not
//    shared copy any more: the fifteen packs go on translating Flow's sentence
//    while this door shows a different one, and nothing at runtime says so.
// ---------------------------------------------------------------------------
for (const [k, v] of Object.entries(BORROWED)) {
  ok(k in FLOW_EN, 'borrowed key missing from Flow: ' + k);
  ok(FLOW_EN[k] === v, 'borrowed value differs from Flow: ' + k
     + '\n   neo : ' + JSON.stringify(v) + '\n   flow: ' + JSON.stringify(FLOW_EN[k]));
}
// ...and an OWN key must NOT shadow a borrowed one, or which sentence shows
// would depend on object-spread order rather than on a decision.
for (const k of Object.keys(OWN)) ok(!(k in BORROWED), 'OWN key shadows a borrowed one: ' + k);

// ---------------------------------------------------------------------------
// 2. The pack version is the cache key for flow.<lang>.json, and neo fetches
//    the SAME files Flow does. A stale token here serves a returning reader an
//    old pack -- silently, as an English fallback for every new key.
// ---------------------------------------------------------------------------
const neoV = mod.match(/const TOPICS_I18N_V\s*=\s*'([^']+)'/);
const flowV = flow.match(/const I18N_V\s*=\s*'([^']+)'/);
ok(neoV && flowV, 'both version constants are declared');
ok(neoV[1] === flowV[1], `TOPICS_I18N_V (${neoV && neoV[1]}) must equal Flow's I18N_V (${flowV && flowV[1]})`);

// ---------------------------------------------------------------------------
// 3. Every key ASKED FOR is defined. topicsT falls back to the key itself, so
//    a typo ships as a raw 'lane.reachh' on screen with no error anywhere.
// ---------------------------------------------------------------------------
const ALL = Object.assign({}, BORROWED, OWN);
/* KEY-SHAPED LITERALS ANYWHERE IN THE CODE, with comments stripped first.
   Two narrower versions each produced a false positive on their first run, and
   both are worth recording because they are the same mistake in two shapes:
   reading only `topicsT('` missed `topicsT(mode === 'all' ? 'term.all' : ...)`,
   and reading only call arguments missed the keys that travel as data --
   tpRefreshMsg carries ['lane.refreshFound', {...}] and is resolved later.
   Stripping comments matters as much: this file's own prose names half these
   keys, so without it the "never used" half of the check would pass on
   anything ever mentioned. */
/* TWO DIRECTIONS, TWO KINDS OF EVIDENCE, and conflating them fails both ways.
   "Used but not defined" must only consider literals actually handed to the
   translator -- a key-shaped string that is not a key ('memo.cash' is a website
   in a protocol list) is not a missing translation. "Defined but never used"
   has to look wider, because keys travel as data too. */
/* THE SHAPE THIS FILE DEPENDS ON, ASSERTED BELOW RATHER THAN ASSUMED. It was
   /^[a-z]+\./ and a11y.scrollRow has digits in it, so the key was invisible to
   the scanner and reported as never used while being used. I had checked "all
   keys match the assumed shape" -- before that key existed. An assumption a
   suite relies on has to be a test in the suite, or it is true only until the
   next key. */
const KEY_SHAPE = /^[a-z][a-z0-9]*\.[A-Za-z0-9]+$/;
const called = new Set();
for (const m of codeOnly.matchAll(/topicsTf?\(([^)]*)\)/g)) {
  // Key-shaped only: the same call can carry a comparison literal, and
  // topicsT(mode === 'all' ? 'term.all' : 'term.any') reported 'all' missing.
  for (const q of m[1].matchAll(/'([^']+)'/g)) if (KEY_SHAPE.test(q[1])) called.add(q[1]);
}
/* THE DECLARATIONS ARE NOT USES. Scanning key-shaped literals across the whole
   module swept in `'term.full': '...'` from the tables themselves, so every key
   counted as used and the check could never fire -- vacuous, and it looked
   exactly like a passing gate. Mutation caught it: putting a hardcoded English
   sentence back over its own translation stayed green. The tables are cut out
   before the scan. */
/* SLICED FROM THE SAME TEXT IT IS REMOVED FROM. The first version took the
   slice from `mod` (comments intact) and removed it from `codeOnly` (comments
   stripped), so any block comment inside a table made the needle miss and the
   cut-out silently did nothing. Measured: TOPICS_EN_BORROWED has none and was
   excluded; TOPICS_EN_OWN has two and was NOT -- which is the table invented
   keys live in, so an unused OWN key could never have been caught. The gate
   looked identical either way. */
const withoutTables = codeOnly
  .replace(objectText(codeOnly, 'TOPICS_EN_BORROWED'), '')
  .replace(objectText(codeOnly, 'TOPICS_EN_OWN'), '');
const used = new Set(called);
for (const m of withoutTables.matchAll(/'([^']+)'/g)) if (KEY_SHAPE.test(m[1]) && m[1] in ALL) used.add(m[1]);
for (const k of Object.keys(ALL)) ok(KEY_SHAPE.test(k), 'key does not match the shape the scanner assumes: ' + k);
ok(called.size >= 40, 'found the call sites (' + called.size + ')');
for (const k of called) ok(k in ALL, 'key used but not defined: ' + k);

/* AND EVERY KEY DEFINED MUST BE USED. The check above only runs one way, so a
   hardcoded English sentence sitting beside its own unused translation passes
   it -- which is exactly what happened to term.full and term.fromRead: both
   borrowed, both translated fifteen times, both shadowed by a literal. An
   unused key is either dead weight or a translation that is not reaching the
   screen, and neither should ship quietly. */
for (const k of Object.keys(ALL)) ok(used.has(k), 'key defined but never used: ' + k);

// Placeholders must match on both sides of the borrow, or a translated
// sentence keeps a {var} nobody fills.
const varsOf = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of Object.keys(BORROWED)) ok(varsOf(BORROWED[k]) === varsOf(FLOW_EN[k]), 'placeholder drift: ' + k);

// Every tf() call must pass exactly the placeholders its value declares --
// a missing one renders the literal '{n}' to the reader.
for (const m of mod.matchAll(/topicsTf\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g)) {
  const want = varsOf(ALL[m[1]] || '');
  const got = [...m[2].matchAll(/(\w+)\s*:/g)].map((x) => x[1]).sort().join(',');
  ok(want === got, `tf('${m[1]}') passes {${got}}, value needs {${want}}`);
}

// ---------------------------------------------------------------------------
// 4. The static tables address real nodes. An id renamed in the markup leaves
//    a table row pointing at nothing -- and `if (n)` means it fails silently,
//    which is the whole reason this is a table and not scattered assignments.
// ---------------------------------------------------------------------------
const tableRows = (name) => {
  const txt = objectText(mod, name, '[').replace(/^const\s+\w+\s*=\s*/, '');
  return new Function('return (' + txt + ');')();
};
for (const name of ['TOPICS_STATIC_TEXT', 'TOPICS_STATIC_ATTR', 'TOPICS_STATIC_OPT']) {
  for (const row of tableRows(name)) {
    const id = row[0], key = row[row.length - 1];
    ok(new RegExp('id="' + id + '"').test(neo), name + ': no element id="' + id + '"');
    ok(key in ALL, name + ': undefined key ' + key);
  }
}

// ---------------------------------------------------------------------------
// 5. applyTopicsLang calls six renderers by name. Six invented symbols already
//    reached `node --check` clean in this pane; a name that does not resolve is
//    now a red test rather than a console line nobody reads.
// ---------------------------------------------------------------------------
const apply = mod.slice(mod.indexOf('async function applyTopicsLang'));
const list = apply.slice(apply.indexOf('for (const fn of ['), apply.indexOf(']', apply.indexOf('for (const fn of [')));
const names = [...list.matchAll(/\brender\w+/g)].map((m) => m[0]);
ok(names.length === 6, 'applyTopicsLang drives six renderers, found ' + names.length);
for (const fn of names) {
  ok(new RegExp('function ' + fn + '\\s*\\(').test(mod), 'applyTopicsLang calls a function that does not exist: ' + fn);
}
// And the guard must be INSIDE the loop. One try/catch around all six is how
// a single thrown renderer used to take the five after it down in silence --
// so count the try blocks in the driver rather than pattern-match its shape.
const driver = apply.slice(0, apply.indexOf('\n}'));
ok((driver.match(/\btry\s*\{/g) || []).length === 1
   && /\]\)\s*\{\s*try\s*\{\s*fn\(\);\s*\}\s*catch/.test(driver),
   'the try must sit inside the loop body, one per renderer');

// The listener that makes any of this run on a language change. Naming the
// HANDLER matters: index.html has a second ecashlive:lang listener (the send
// panel's recipient picks), so a bare "is the event listened to" check passes
// with this one deleted -- caught by mutation, which could not even apply.
ok(/addEventListener\(\s*'ecashlive:lang'\s*,[^;]*applyTopicsLang/.test(mod),
   'applyTopicsLang is not wired to ecashlive:lang');

// ---------------------------------------------------------------------------
// 6. DATES ARE LOCAL, and this is the assertion that only fails outside UTC.
//    dayStart() is local midnight; toISOString() is UTC. Drive the shipped
//    topicsIsoDay against the shipped dayStart in a zone ahead of Greenwich.
// ---------------------------------------------------------------------------
const isoBody = mod.slice(mod.indexOf('function topicsIsoDay('));
const topicsIsoDay = new Function(isoBody.slice(0, (() => {
  let i = isoBody.indexOf('{'), d = 0;
  for (; i < isoBody.length; i++) {
    if (isoBody[i] === '{') d++;
    else if (isoBody[i] === '}') { d--; if (!d) return i + 1; }
  }
})()) + '\nreturn topicsIsoDay;')();

const { dayStart } = await import(join(ROOT, 'vendor/core/lane-cursor.js'));
for (const day of ['2026-07-16', '2026-01-01', '2026-12-31', '2026-03-01']) {
  ok(topicsIsoDay(dayStart(day)) === day, `round trip ${day} -> ${topicsIsoDay(dayStart(day))} (TZ=${process.env.TZ || 'system'})`);
}
ok(topicsIsoDay(null) === '' && topicsIsoDay(undefined) === '', 'null/undefined render as empty, not "1970-01-01"');
ok(topicsIsoDay(NaN) === '', 'NaN renders as empty');
// The max on the date inputs is today in the READER's calendar; a UTC "today"
// forbids picking today for anyone east of Greenwich before their morning.
// One timestamp for both sides: two Date.now() calls straddling midnight would
// make this fail once every 86,400 seconds for a reason that is not the bug.
const nowMs = Date.now();
ok(topicsIsoDay(nowMs) === new Date(nowMs).toLocaleDateString('en-CA'), 'today is the local today');

// ---------------------------------------------------------------------------
// 7. The overlay packs exist for every language Flow ships, and carry exactly
//    the OWN keys. An extra key is dead weight; a missing one is an English
//    sentence inside a translated pane.
// ---------------------------------------------------------------------------
const dir = join(ROOT, 'vendor/i18n');
const langs = readdirSync(dir).filter((f) => /^flow\..+\.json$/.test(f))
  .map((f) => f.slice(5, -5)).sort();
ok(langs.length === 15, 'fifteen Flow packs, found ' + langs.length);
const ownKeys = Object.keys(OWN).sort().join('|');
for (const code of langs) {
  const file = join(dir, 'topics.' + code + '.json');
  let pack;
  try { pack = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new Error('FAIL: missing or unparseable overlay pack: topics.' + code + '.json'); }
  ok(Object.keys(pack).sort().join('|') === ownKeys, 'topics.' + code + '.json key drift');
  for (const k of Object.keys(pack)) {
    ok(typeof pack[k] === 'string' && pack[k].trim() !== '', code + ': empty value for ' + k);
    ok(varsOf(pack[k]) === varsOf(OWN[k]), code + ': placeholder drift in ' + k);
  }
}

console.log(`ok: neo Topics i18n, ${n} assertions across ${langs.length} packs`);
