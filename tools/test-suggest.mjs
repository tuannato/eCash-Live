// Both doors rank suggestions with vendor/core/suggest.js.
//   node tools/test-suggest.mjs
//
// The point of this suite is that the extraction did not change the answer, and
// that neither door has grown a second copy since. The oracle is FROZEN
// (tools/suggest.pre-core.mjs) — Flow's own implementation as it stood the
// commit before the move. Pointing it at the live file would compare the module
// to itself.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeSuggestions } from '../vendor/core/suggest.js';
import { computeSuggestionsPreCore } from './suggest.pre-core.mjs';
import { normalize } from '../vendor/core/match.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok  ' + label); }
                              else { fail++; console.log('FAIL  ' + label + '  <--'); } };
const eq = (label, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? label : label + ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, same);
};

/* A corpus with the shape the design was measured against: a long tail of real
   words, some hashtags, some shouted tickers, and one bot repeating itself —
   the case that made the ranking count SENDERS instead of messages. */
function corpus(n = 400) {
  const words = ['gm','thanks','coffee','moon','wen','ship','build','node','block','fee'];
  const tags = ['#firma','#xecx','#ecash'];
  const shouts = ['XEC','BTX','POW','ABC'];
  const rows = [];
  let seed = 7;
  const rnd = (m) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m;
  for (let i = 0; i < n; i++) {
    const bits = [words[rnd(words.length)]];
    if (rnd(3) === 0) bits.push(tags[rnd(tags.length)]);
    if (rnd(4) === 0) bits.push(shouts[rnd(shouts.length)]);
    if (rnd(5) === 0) bits.push(words[rnd(words.length)]);
    rows.push({ text: bits.join(' '), lokad: rnd(6) === 0 ? 'b' : 'a', from: 's' + rnd(40) });
  }
  for (let i = 0; i < 60; i++) rows.push({ text: 'congratulations you win darts casino', lokad: 'a', from: 'bot1' });
  return rows;
}

console.log('-- the extraction did not change the answer --');
{
  const rows = corpus();
  const wanted = (e) => e.lokad === 'a';
  const taken = new Set([normalize('moon')]);
  const before = computeSuggestionsPreCore({ rows, wanted, taken });
  const after = computeSuggestions({ rows, wanted, taken });
  ok('the oracle produces a full row', before.length === 8);
  eq('and the core module matches it exactly', after, before);

  // the scope really is honoured, and it is the caller's answer
  const all = computeSuggestions({ rows, wanted: () => true, taken });
  ok('a wider scope changes the answer', JSON.stringify(all) !== JSON.stringify(after));
  // a term already followed is never offered back
  const withGm = computeSuggestions({ rows, wanted, taken: new Set([normalize('block')]) });
  ok('a taken term is not offered', !withGm.some((r) => normalize(r.term) === 'block'));
}

console.log('\n-- the measurements the ranking is built on --');
{
  const wanted = () => true;
  /* 41% of a real corpus is exact repeats and one text appeared 50 times.
     Counting without deduping lets one broadcast outvote fifty people. */
  /* SIZED FOR THE 30% CEILING. My first version put "thanks" in 30 of 80
     documents -- 37.5%, over the ceiling -- and the suite reported the code
     wrong when the corpus was. A term has to clear MIN_DF (3 distinct
     messages) AND stay under 30% of them, which is only satisfiable at 10
     documents or more, so the filler is what makes the case testable. */
  const spam = [];
  for (let i = 0; i < 50; i++) spam.push({ text: 'buy now casino bonus', lokad: 'a', from: 'bot' + i });
  for (let i = 0; i < 20; i++) spam.push({ text: 'thanks ' + i, lokad: 'a', from: 's' + i });
  for (let i = 0; i < 120; i++) spam.push({ text: 'filler' + i + ' padding' + i, lokad: 'a', from: 'f' + i });
  const r = computeSuggestions({ rows: spam, wanted, taken: new Set() });
  ok('a repeated broadcast does not dominate', !r.some((x) => x.term === 'casino'));
  ok('while a word many people wrote survives', r.some((x) => x.term === 'thanks'));

  /* Ranked by frequency the top was one casino bot's script; ranked by distinct
     senders, casino is 1 and thanks is 20. Tier 3 counts people. */
  const oneSender = [];
  for (let i = 0; i < 20; i++) oneSender.push({ text: 'darts ' + i, lokad: 'a', from: 'bot1' });
  for (let i = 0; i < 20; i++) oneSender.push({ text: 'coffee ' + i, lokad: 'a', from: 'p' + i });
  for (let i = 0; i < 120; i++) oneSender.push({ text: 'filler' + i + ' padding' + i, lokad: 'a', from: 'f' + i });
  const r2 = computeSuggestions({ rows: oneSender, wanted, taken: new Set() });
  ok('one sender repeating a word is not a topic', !r2.some((x) => x.term === 'darts'));
  ok('many senders writing one is', r2.some((x) => x.term === 'coffee'));
}

console.log('\n-- the arguments have no defaults, on purpose --');
{
  /* Same rule as createResultStore: each plausible default silently reinstates
     a bug. "Everything" would mine protocols the reader deselected; an empty
     `taken` would offer back the words they already follow. */
  let threw = 0;
  try { computeSuggestions({ rows: [], taken: new Set() }); } catch (e) { threw++; }
  try { computeSuggestions({ rows: [], wanted: () => true }); } catch (e) { threw++; }
  eq('both missing arguments throw rather than guess', threw, 2);
}

console.log('\n-- neither door keeps a second copy --');
{
  const neo = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const flow = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
  for (const [name, src] of [['neo', neo], ['Flow', flow]]) {
    ok(name + ' imports the shared ranking', /core\/suggest\.js/.test(src));
    ok(name + ' declares no threshold of its own',
       !/const SUGGEST_(MAX|MIN_DF|DF_CEIL|MIN_SENDERS|TAG_SOFT)\b/.test(src));
    ok(name + ' declares no shout pattern of its own', !/const SHOUT_(RE|ONE)\s*=/.test(src));
    /* HASHTAG_RE went the same way: one rule for what is findable and what is
       tappable, which is what the byte-compare test used to police by hand. */
    ok(name + ' declares no hashtag pattern of its own', !/const HASHTAG_RE\s*=/.test(src));
  }
}

console.log(fail ? `\nFAILED ${fail}/${pass + fail}` : `\nok: suggest ${pass} assertions`);
if (fail) process.exit(1);
