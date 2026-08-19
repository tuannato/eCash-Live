// Harness for neo's Topics engine — the parts that decide what is honest.
//   node tools/test-neo-topics.mjs
//
// Extracts the SHIPPED bodies from index.html and drives them. The rules under
// test are all rules the two doors must agree on, so a copy would only prove
// the copy: a follow restoring OFF, one definition of searchable text, and a
// live arrival being INGESTED rather than appended.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];

/** Balanced-brace lift, keeping a leading `async` (the trap that makes `await`
 *  a syntax error and hides it inside the function's own try/catch). */
function grab(name) {
  const at = mod.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('not found in index.html: ' + name);
  const start = (at >= 6 && mod.slice(at - 6, at) === 'async ') ? at - 6 : at;
  let i = mod.indexOf('{', at), depth = 0;
  for (; i < mod.length; i++) {
    const c = mod[i];
    if (c === '/' && mod[i + 1] === '/') { i = mod.indexOf('\n', i); continue; }
    if (c === '/' && mod[i + 1] === '*') { i = mod.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < mod.length; i++) { if (mod[i] === '\\') i++; else if (mod[i] === q) break; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return mod.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------- sandbox
const KEY = 'ecashlive:flow:filters';
function sandbox(stored) {
  const ls = new Map();
  if (stored !== undefined) ls.set(KEY, JSON.stringify(stored));
  const localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
  };
  const src = [
    "const TOPICS_TERMS_KEY = " + JSON.stringify(KEY) + ";",
    "const LOKAD = { CASHTAB_MSG: '00746162' };",
    "let topicTerms = [], topicMode = 'any', topicScope = [LOKAD.CASHTAB_MSG];",
    // The scrub the page uses. Zero-width and bidi marks are the reason .text
    // has to be cleaned at all.
    "const cleanChainText = (s) => String(s == null ? '' : s).replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g, '');",
    "let parseOpReturnResult = null;",
    "function parseOpReturn(){ return parseOpReturnResult; }",
    "let corpusAdds = [], heldTxs = [], rematched = 0;",
    "let topicsCoreReady = true;",
    "const tpCorpus = { add: (...a) => corpusAdds.push(a), get: () => null, size: 0, full: false };",
    "const tpResults = { hold: (tx) => heldTxs.push(tx), get: () => null, matched: [], matchedTotal: 0 };",
    "function topicsEngineReady(){ return topicsCoreReady; }",
    "function topicsRematch(){ rematched++; }",
    "const topicsCore = { matchAny: (h, ts) => ts.some(t => h.toLowerCase().includes(t.q.toLowerCase())),",
    "                     matchEvery: (h, ts) => ts.every(t => h.toLowerCase().includes(t.q.toLowerCase())) };",
    grab('loadTopicSettings'),
    grab('saveTopicSettings'),
    grab('topicsHay'),
    grab('topicMatchText'),
    grab('topicsIngestLive'),
    "const topicFollows = () => topicTerms.filter(t => t.on && !t.mute);",
    "const topicMutes   = () => topicTerms.filter(t => t.mute);",
    "return { loadTopicSettings, saveTopicSettings, topicsHay, topicMatchText, topicsIngestLive,",
    "  get terms(){ return topicTerms; }, get mode(){ return topicMode; }, get scope(){ return topicScope; },",
    "  setTerms(t){ topicTerms = t; }, setMode(m){ topicMode = m; },",
    "  setParse(v){ parseOpReturnResult = v; }, setReady(v){ topicsCoreReady = v; },",
    "  get corpusAdds(){ return corpusAdds; }, get held(){ return heldTxs; }, get rematched(){ return rematched; },",
    "  raw: () => localStorage.getItem(" + JSON.stringify(KEY) + ") };",
  ].join('\n');
  return new Function('localStorage', src)(localStorage);
}

// ---------------------------------------------------------- E1: settings
console.log('\n-- E1: the settings are shared, and restore asymmetrically --');
{
  const S = sandbox({ mode: 'all', scope: ['00746162'], terms: [
    { q: 'gm', on: true, mode: 'word', fold: true, mute: false },
    { q: 'casino', on: true, mode: 'word', fold: false, mute: true },
    { q: 'off', on: false, mode: 'contains', fold: false, mute: true },
  ]});
  S.loadTopicSettings();
  // A FOLLOW COMES BACK OFF: an action must not look taken when it was not.
  eq('a stored follow restores OFF', S.terms.find(t => t.q === 'gm').on, false);
  // A MUTE COMES BACK ON: a standing defence must not lapse because a tab closed.
  eq('a stored mute restores ON', S.terms.find(t => t.q === 'casino').on, true);
  eq('a mute explicitly off stays off', S.terms.find(t => t.q === 'off').on, false);
  eq('mode is read from the shared value', S.mode, 'all');
  eq('scope is read from the shared value', S.scope, ['00746162']);
  eq('term shape is normalised', S.terms[2].mode, 'contains');
}
{
  const S = sandbox();                    // nothing stored at all
  S.loadTopicSettings();
  eq('no stored value -> no terms', S.terms, []);
  eq('no stored value -> Cashtab scope', S.scope, ['00746162']);
  eq('no stored value -> any mode', S.mode, 'any');
}
{
  const S = sandbox({ mode: 'nonsense', scope: [], terms: [{ q: '' }, null, { nope: 1 }] });
  S.loadTopicSettings();
  eq('junk terms are dropped', S.terms, []);
  eq('an empty scope falls back rather than searching nothing', S.scope, ['00746162']);
  eq('an unknown mode falls back to any', S.mode, 'any');
}
{
  // Writing must not invent a key of its own — decision 14, and the reason the
  // approved ecash-live:topics:v1 was never created.
  const S = sandbox({ mode: 'any', scope: ['00746162'], terms: [] });
  S.loadTopicSettings();
  S.setTerms([{ q: 'x', on: true, mode: 'word', fold: false, mute: false }]);
  S.saveTopicSettings();
  const back = JSON.parse(S.raw());
  ok('saves back into the SHARED value', !!back && Array.isArray(back.terms) && back.terms[0].q === 'x');
  eq('and keeps mode and scope with it', [back.mode, back.scope], ['any', ['00746162']]);
}

// ------------------------------------------------------------- E2: the hay
console.log('\n-- E2: one definition of searchable text --');
{
  const S = sandbox({});
  S.setParse({ text: 'hello world' });
  eq('a non-OP_RETURN first output is not text',
     S.topicsHay({ outputs: [{ outputScript: '76a914dead88ac' }] }), null);
  eq('no outputs at all', S.topicsHay({}), null);
  S.setParse(null);
  eq('a script the parser cannot read', S.topicsHay({ outputs: [{ outputScript: '6a00' }] }), null);
  S.setParse({ text: '' });
  eq('an empty text is not a haystack', S.topicsHay({ outputs: [{ outputScript: '6a00' }] }), null);

  S.setParse({ text: 'gm​everyone' });
  const scrubbed = S.topicsHay({ outputs: [{ outputScript: '6a00' }], timeFirstSeen: 5 });
  eq('a zero-width char is scrubbed out of the haystack', scrubbed.hay, 'gmeveryone');
  eq('first-seen becomes ms', scrubbed.ts, 5000);

  S.setParse({ text: 'ok' });
  eq('a block timestamp wins over first-seen',
     S.topicsHay({ outputs: [{ outputScript: '6a00' }], block: { timestamp: 9 }, timeFirstSeen: 5 }).ts, 9000);
  eq('neither known -> no date claimed',
     S.topicsHay({ outputs: [{ outputScript: '6a00' }], timeFirstSeen: 0 }).ts, null);

  // outputs[0] ONLY. A known shortcut on a door, measured at 0/350 on lokad
  // pages, and Flow has the same one. Pinned so it stays a decision.
  S.setParse({ text: 'second' });
  eq('only the first output is read',
     S.topicsHay({ outputs: [{ outputScript: '76a914aa88ac' }, { outputScript: '6a00' }] }), null);
}

// --------------------------------------------------------- matching rules
console.log('\n-- matching: mode, and a mute outranking a follow --');
{
  const S = sandbox({});
  S.setTerms([{ q: 'gm', on: true, mute: false }, { q: 'ship', on: true, mute: false }]);
  S.setMode('any');
  ok('any: one word is enough', S.topicMatchText('gm everyone'));
  S.setMode('all');
  ok('all: one word is not enough', !S.topicMatchText('gm everyone'));
  ok('all: both words match', S.topicMatchText('gm we ship today'));
  S.setMode('any');
  S.setTerms([{ q: 'gm', on: true, mute: false }, { q: 'casino', on: true, mute: true }]);
  ok('a mute vetoes a follow that also matched', !S.topicMatchText('gm from the casino'));
  ok('and leaves an unmuted match alone', S.topicMatchText('gm everyone'));
  S.setTerms([{ q: 'gm', on: false, mute: false }]);
  ok('a follow that is off matches nothing', !S.topicMatchText('gm everyone'));
  S.setTerms([]);
  ok('no follows -> no match, rather than everything', !S.topicMatchText('anything'));
}

// ------------------------------------------------- E7: ingest, not append
console.log('\n-- E7: a live arrival is INGESTED, never appended --');
{
  const S = sandbox({});
  S.setTerms([{ q: 'gm', on: true, mute: false }]);
  S.topicsIngestLive({ id: 't1', message: { text: 'gm everyone' }, firstSeen: 1000 });
  eq('the corpus gets the row', S.corpusAdds.map(a => a[0]), ['t1']);
  ok('a match is also held for rendering', S.held.length === 1);
  ok('and the answer is rebuilt rather than pushed to', S.rematched === 1);

  // A NON-match still enters the corpus: a corpus that keeps only today's hits
  // is blind to tomorrow's term, which is the bug the corpus was created for.
  S.topicsIngestLive({ id: 't2', message: { text: 'nothing here' }, firstSeen: 1000 });
  eq('a non-match is still cached', S.corpusAdds.map(a => a[0]), ['t1', 't2']);
  ok('but is not held', S.held.length === 1);

  S.topicsIngestLive({ id: 't3', message: {}, firstSeen: 1 });
  eq('a message with no text is skipped entirely', S.corpusAdds.length, 2);
  S.topicsIngestLive({ message: { text: 'gm' } });
  eq('an id-less tx is skipped', S.corpusAdds.length, 2);

  // The scrub applies on the live side too, or the doors disagree on the bytes.
  S.topicsIngestLive({ id: 't4', message: { text: 'g​m here' }, firstSeen: 1 });
  eq('live text is scrubbed the same way', S.corpusAdds[2][1], 'gm here');

  S.setReady(false);
  S.topicsIngestLive({ id: 't5', message: { text: 'gm' }, firstSeen: 1 });
  eq('nothing is ingested before the engine exists', S.corpusAdds.length, 3);
}

// ------------------------------------------------- E4/E5: structure, and the
// cross-door equalities decision 14 depends on. These are source assertions:
// they cannot prove the walk works, but they are what notices a defence being
// dropped in a later edit, which no behavioural test of a green build would.
console.log('\n-- E4: the walk keeps its six defences --');
{
  const run = grab('runTopicsBackfill');
  ok('the walk is async', /^async function runTopicsBackfill\(/.test(run));
  const guard = run.indexOf("typeof chronik.lokadId !== 'function'");
  const ctor  = run.indexOf('createBackfill');
  ok('the chronik guard sits BEFORE createBackfill', guard !== -1 && ctor !== -1 && guard < ctor);
  ok('requests are gated on the pane being open, inside the walk',
     /dataset\.topics\s*!==\s*'open'/.test(run));
  ok('an AbortController is created', /new AbortController\s*\(/.test(run));
  ok('and its signal reaches run()', /signal:\s*tpAbort\.signal/.test(run));
  ok('a superseded run refuses to write', /token !== tpRunToken/.test(run));
  const save = run.indexOf('topicsSaveStore()'), cat = run.search(/catch\s*\(/);
  ok('the store is written even when run() throws', save !== -1 && cat !== -1 && save > cat);
  ok('the prefilter ingests every text, not only matches',
     /prefilter:/.test(run) && /tpCorpus\.add\(/.test(run));
  ok('a real parse is supplied', /parse:\s*\(/.test(run));
}

console.log('\n-- E5: the cache is shared, and the two doors must not drift --');
{
  const flow = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
  const neoMax  = Number(mod.match(/const TOPICS_CORPUS_MAX\s*=\s*(\d+)/)[1]);
  const flowMax = Number(flow.match(/const CORPUS_MAX\s*=\s*(\d+)/)[1]);
  eq('neo CORPUS_MAX is 5000', neoMax, 5000);
  // A smaller cap on either door silently recreates the founding bug: the
  // corpus loads without clearing, keeps the newest N, then persists that
  // truncated view beside the OTHER door's full cursor.
  eq('and equals Flow, or the shared cache is corrupted by whoever saves next', neoMax, flowMax);
  const neoKey  = mod.match(/const TOPICS_CURSOR_KEY\s*=\s*'([^']+)'/)[1];
  const flowKey = flow.match(/const LANE_CURSOR_KEY\s*=\s*'([^']+)'/)[1];
  eq('neo writes the shared cursor key', neoKey, 'ecashlive:flow:lane-cursor');
  eq('and it is the key Flow writes', neoKey, flowKey);
  const neoTerms  = mod.match(/const TOPICS_TERMS_KEY\s*=\s*'([^']+)'/)[1];
  const flowTerms = flow.match(/const TERMS_KEY\s*=\s*'([^']+)'/)[1];
  eq('settings are the shared value too', neoTerms, flowTerms);
  // Decision 14 superseded the key approved a day earlier. It must not exist.
  ok('no neo-only Topics key was created', !/ecash-live:topics/.test(mod));
  const build = grab('buildTopicsEngine');
  ok('createCorpus is given the cap', /createCorpus\(\s*\{\s*max:\s*TOPICS_CORPUS_MAX/.test(build));
  ok('createLaneStore is given it as well', /createLaneStore\([\s\S]*?max:\s*TOPICS_CORPUS_MAX/.test(build));
}

console.log('\n-- E9: the Feed keeps its own window --');
{
  ok('MAX_MSG_VISIBLE is untouched at 100', /const MAX_MSG_VISIBLE = 100;/.test(mod));
  const addCard = grab('addMessageCard');
  const ingest = addCard.indexOf('topicsIngestLive');
  const reject = addCard.indexOf('MAX_MSG_VISIBLE');
  ok('Topics ingests before the Feed window decides anything',
     ingest !== -1 && reject !== -1 && ingest < reject);
  const core = readFileSync(join(ROOT, 'vendor/core/backfill.js'), 'utf8');
  ok('vendor/core was not patched to make this fit', !/topics/i.test(core));
}

console.log(fail ? `\nFAILED ${fail}/${pass + fail}` : `\nok: neo topics ${pass} assertions`);
if (fail) process.exit(1);
