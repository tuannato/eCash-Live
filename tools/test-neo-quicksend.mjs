// Harness for neo's quick-send composer.
//   node tools/test-neo-quicksend.mjs
//
// THE FIRST GATE HERE IS NOT ABOUT SENDING. While this composer was written,
// FIVE references turned out to be invented or wrong-shaped -- a constant that
// does not exist, a loader whose return value is unused because it returns
// nothing, a builder called with the wrong argument shape, a validator whose
// result field was guessed, and a byte helper under the wrong name. Every one
// of them passed `node --check`, because they are runtime references inside a
// function nobody called during the check. So the suite resolves every
// identifier this code reaches for, against the module it lives in.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function grab(name) {
  const at = mod.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('not found: ' + name);
  const start = (at >= 6 && mod.slice(at - 6, at) === 'async ') ? at - 6 : at;
  let i = mod.indexOf('{', at), d = 0;
  for (; i < mod.length; i++) {
    const c = mod[i];
    if (c === '/' && mod[i + 1] === '/') { i = mod.indexOf('\n', i); continue; }
    if (c === '/' && mod[i + 1] === '*') { i = mod.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { const q = c; for (i++; i < mod.length; i++) { if (mod[i] === '\\') i++; else if (mod[i] === q) break; } continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) return mod.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

// The composer IIFE, lifted by its own marker comment.
const at = mod.indexOf('/* ============ QUICK SEND ============');
if (at === -1) throw new Error('quick-send block not found');
const end = mod.indexOf('\n})();', at);
const block = mod.slice(at, end + 6);

console.log('\n-- every identifier this code reaches for must exist --');
{
  // Names the composer calls that must be declared elsewhere in the module.
  const needed = [
    'chatBuildBip21', 'chatBuildCashtabUrl', 'chatSendViaCashtabExtension',
    'chatProbeCashtabExtension', 'chatUtf8Bytes', 'chatAddrShort',
    'validateEcashAddress', 'validateCashAddress', 'topicFollows',
    'CHAT_OP_RETURN_BUDGET', 'chatState', 'watchlist',
  ];
  for (const n of needed) {
    const used = new RegExp('\\b' + n + '\\b').test(block);
    if (!used) continue;                       // not referenced, nothing to prove
    const declared =
      new RegExp('^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+' + n + '\\s*\\(', 'm').test(mod) ||
      new RegExp('^\\s*(?:const|let|var)\\s+' + n + '\\b', 'm').test(mod) ||
      new RegExp('^\\s*' + n + ',\\s*$', 'm').test(mod);   // named import
    ok(n + ' is declared where it is used', declared);
  }
  // and the ones that were actually got wrong, pinned by name so a rename shows
  ok('no chatUtf8Len (the real helper is chatUtf8Bytes)', !/\bchatUtf8Len\b/.test(mod));
  ok('no QS_DUST_XEC (the floor is chatState.amountXec)', !/\bQS_DUST_XEC\b/.test(mod));
}

/* CODE, NOT PROSE. Every check below that asks "is this in the source" runs
   against a comment-stripped copy. Asserting on `block` matched the comments
   that EXPLAIN each rule, so deleting the rule itself left the suite green --
   caught twice in this file, once on an ordering check and once on the
   watchlist filter. A gate that reads its own documentation is not a gate. */
const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n-- the send path --');
{
  ok('probes for the extension before choosing a route', /chatProbeCashtabExtension\s*\(/.test(code));
  /* POSITIONS MUST BE MEASURED ON CODE, NOT ON PROSE. The comment above this
     branch names both functions while explaining why the optimistic one cannot
     decide, so a raw indexOf found the SENDER first and reported the order
     backwards. Strip comments before asking where anything sits -- the same trap
     that made an earlier suite's "the event fires after the pack" assertion
     satisfiable by a mention in a comment. */
  const probeAt = code.indexOf('chatProbeCashtabExtension');
  const sendAt = code.indexOf('chatSendViaCashtabExtension');
  const openAt = code.indexOf('window.open');
  ok('the probe decides, and it runs first', probeAt !== -1 && probeAt < sendAt && probeAt < openAt);
  // chatSendViaCashtabExtension resolves true after 200ms whether or not anything
  // listened, so branching on IT meant the URL fallback never ran for anyone
  // without the extension: a cleared field, a "Sent" hint, and no wallet.
  ok('the optimistic sender does not decide the branch',
     !/if\s*\(\s*!?\s*(viaExt|await chatSendViaCashtabExtension)/.test(code));
  /* THESE USED TO MATCH THE ENGLISH SENTENCE, and the i18n pass turned every
     one of them red -- correctly: the sentence moved into a key. Matching the
     KEY is the durable form, because the key is what the code names and the
     i18n suite is what proves the key resolves in all fifteen packs. The guard
     that produces it is asserted beside it, so a message with no branch (or a
     branch with no message) still fails. */
  ok('a blocked pop-up is reported rather than silently swallowed',
     /if\s*\(\s*!opened\s*\)/.test(code) && /'topics\.popup'/.test(code));
}

console.log('\n-- what it refuses --');
{
  ok('refuses with no recipient',
     /if\s*\(\s*!addr\s*\)[^\n]*'try\.needAddr'/.test(code));
  ok('refuses with no message',
     /if\s*\(\s*!text\s*\)[^\n]*'topics\.needMsg'/.test(code));
  // Charset+length is not a checksum: neo's own validator passes a mistyped
  // address, and this composer can move money.
  ok('checks the real checksum, not just the alphabet', /validateCashAddress\s*\(/.test(code));
  // maxlength counts UTF-16 units; the OP_RETURN budget is utf-8 bytes.
  ok('measures the message in BYTES', /chatUtf8Bytes\s*\(/.test(code));
  ok('against the budget Chat already uses', /CHAT_OP_RETURN_BUDGET/.test(code));
  /* BOTH ROUTES, not either. There are two send paths -- the extension and the
     cashtab.com URL -- and a single-occurrence check passes with the disclosure
     deleted from one of them. Mutation proved it: removing one instance could
     not even be applied uniquely, which is the tell. */
  ok('a followed term sent bare is disclosed on BOTH send routes',
     (code.match(/'topics\.bareTerm'/g) || []).length === 2);
}

console.log('\n-- the surface --');
{
  ok('Escape is caught in the capture phase, not on the panel',
     /addEventListener\('keydown'[\s\S]{0,180}\},\s*true\)/.test(code));
  ok('the FAB and its panel are hidden on the Chat tab',
     /#section-messages\[data-tab="chat"\] #qs-fab/.test(html));
  ok('both scrollers reserve room so the last row clears the button',
     /\.msg-list,\s*#topics-body\s*\{\s*padding-bottom:\s*calc\(84px/.test(html));
  ok('the message input is pinned to 16px on mobile (iOS zoom)',
     /#qs-panel input\[type=text\]\s*\{\s*font-size:\s*16px/.test(html));
  ok('a disabled watchlist row is not offered as a destination',
     /enabled\s*!==\s*false/.test(code));
}

console.log('\n-- byte counting, driven --');
{
  const fn = new Function('return ' + grab('chatUtf8Bytes'))();
  eq('ascii is one byte each', fn('gm'), 2);
  eq('a Vietnamese word costs more than its length', fn('chào'), 5);
  eq('an emoji is four', fn('🌅'), 4);
  // 215 CHARACTERS of emoji is 860 bytes -- the exact shape maxlength misses.
  ok('215 emoji blow the budget that 215 chars would allow', fn('🌅'.repeat(215)) > 215);
  eq('empty is zero', fn(''), 0);
}

console.log(fail ? `\nFAILED ${fail}/${pass + fail}` : `\nok: neo quick-send ${pass} assertions`);
if (fail) process.exit(1);
