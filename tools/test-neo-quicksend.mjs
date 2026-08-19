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
  /* WAS: "refuses with no message". That was true while a message was the only
     thing a quick send could carry -- an empty one meant there was nothing to
     send. With an XEC amount the panel can send a payment with no words, so the
     guard became "neither", and this assertion is the one that reported the
     change rather than letting it through. The replacement lives in
     "what it refuses, now that either will do". */
  ok('refuses when there is neither a message nor an amount',
     /if\s*\(\s*!text && !xec\s*\)[^\n]*'cmp\.needAmtOrMsg'/.test(code));
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
  /* WAS: the selector and its brace on one line. The anti-zoom rule is a
     selector LIST now -- the amount field had to join it -- so matching the
     pair together broke on formatting rather than on behaviour. Rewriting it as
     a generic rule-splitter did not work either: the block sits inside an
     @media, and `r.indexOf('{')` then lands on the media query's own brace, so
     the "selector" half was the comment above it. Ask the block directly. */
  {
    const at = html.indexOf('iOS auto-zooms on focus');
    const block = (at === -1 ? '' : html.slice(at, html.indexOf('}\n  }', at)))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    ok('the message input is pinned to 16px on mobile (iOS zoom)',
       /#qs-panel input\[type=text\]/.test(block) && /font-size:\s*16px/.test(block));
  }
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

console.log('\n-- the XEC amount --');
{
  // The row exists and starts closed.
  ok('there is an amount row', /id="qs-amt"/.test(html));
  ok('behind a toggle, like Flow', /id="qs-amt-toggle"[^>]*aria-expanded="false"/.test(html));
  ok('and it starts hidden', /id="qs-amt" hidden|id="qs-amt"[^>]*\shidden/.test(html));
  /* .qs-amt sets display:flex, so the hidden attribute is inert without the
     guard -- the author-beats-UA rule that left #tp-editor on screen. */
  ok('with the [hidden] guard its own display needs',
     /\.qs-amt\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(html));
  /* Flow shipped and then fixed exactly this: the number input inherited
     width:100% from the shared input rule and pushed the panel sideways. */
  ok('the number input opts out of stretching',
     /#qs-amt-num\s*\{[^}]*flex:\s*none/.test(html) && /#qs-amt-num\s*\{[^}]*width:\s*\d+px/.test(html));
  ok('and the row can shrink below its content', /\.qs-amt\s*\{[^}]*min-width:\s*0/.test(html));

  // ONE OWNER. The amount this panel spends is chatState.amountXec, which the
  // Chat composer already writes and chatBuildBip21 already reads.
  const sync = grab('qsSyncAmount');
  ok('the control writes the amount neo already had', /chatState\.amountXec = /.test(sync));
  ok('and repaints Chat so the two cannot disagree', /chatRenderAmount\(\)/.test(sync));
  ok('and persists it where Chat persists it', /chatSavePersist\(\)/.test(sync));
  ok('the floor is the dust floor', /Math\.max\(QS_AMT_MIN/.test(sync));
  ok('and the floor is named once', /const DUST_XEC_FLOOR\s*=\s*5\.46/.test(mod));

  const render = grab('qsRenderSend');
  /* XEC trades near $0.0000063, so the dust floor is ~$0.000034 and four
     decimals render it as "$0" -- a real payment labelled free. An absent
     number is honest; a zero is not, which is why warmup prints "—". */
  ok('the USD is dropped when it would round to zero',
     /parseFloat\(shown\) > 0/.test(render));
  ok('and never shown without a rate', /if \(xecUsd > 0\)/.test(render));
  ok('the button says what it will send', /'cmp\.previewXec'/.test(render));
  ok('and mentions the message when there is one', /'cmp\.previewMsg'/.test(render));

  /* Writing the clamped value back on every keystroke makes "10" impossible:
     the "1" snaps to the floor before the "0" arrives. */
  ok('the field settles on blur, not on every keystroke',
     /amtNum\.addEventListener\('change'/.test(mod)
     && !/amtNum\.addEventListener\('input',[^\n]*amtNum\.value =/.test(mod));
}

// ---------------------------------------------------------------------------
// DRIVEN: a pure-XEC send must not carry an OP_RETURN. An empty one is a push
// of zero bytes -- a fee paid for a record that says nothing.
// ---------------------------------------------------------------------------
console.log('\n-- the builder, driven --');
{
  const build = new Function('chatBuildOpReturnRaw',
    grab('chatBuildBip21') + '\nreturn chatBuildBip21;')((m) => 'DEADBEEF');
  const peers = [{ addr: 'ecash:qqtest' }];

  const withMsg = build(peers, 5.46, 'gm');
  ok('a message send carries the OP_RETURN', withMsg.includes('op_return_raw=DEADBEEF'));
  ok('and the amount', withMsg.includes('amount=5.46'));

  const pure = build(peers, 25, '');
  ok('a pure-XEC send carries the amount', pure.includes('amount=25.00'));
  ok('and NO op_return at all', !pure.includes('op_return_raw'));
  eq('so the link is just the payment', pure, 'ecash:qqtest?amount=25.00');

  eq('null and undefined are treated as no message',
     [build(peers, 10, null), build(peers, 10, undefined)].map((u) => u.includes('op_return_raw')).join(),
     'false,false');
  // Multi-recipient (the Chat path) still repeats amount per address.
  const two = build([{ addr: 'ecash:qqa' }, { addr: 'ecash:qqb' }], 7, 'hi');
  ok('extra recipients still each get an amount', (two.match(/amount=7\.00/g) || []).length === 2);
  ok('and the op_return stays before the extra addr',
     two.indexOf('op_return_raw') < two.indexOf('addr=ecash:qqb'));
}

console.log('\n-- what it refuses, now that either will do --');
{
  const send = mod.slice(mod.indexOf("send.addEventListener('click'"));
  ok('a recipient is still always required', /if \(!addr\)[^\n]*try\.needAddr/.test(send));
  /* Before the amount existed, an empty message was simply nothing to send.
     With an amount open, a payment with no words is an ordinary transaction. */
  ok('but a message alone is no longer the only thing that counts',
     /if \(!text && !xec\)[^\n]*cmp\.needAmtOrMsg/.test(send));
  ok('and the byte check skips an absent message', /const bytes = text \? chatUtf8Bytes\(text\) : 0/.test(send));
  /* It used to pass chatState.amountXec unconditionally, so a quick send spent
     whatever the Chat slider was last left at, unseen. */
  ok('the send spends what is on screen, or the floor',
     /chatBuildBip21\(\[\{ addr: norm \}\], xec \|\| DUST_XEC_FLOOR, text\)/.test(send));
}

// ===========================================================================
// THE TIP JAR. One address, protected in one place: defineProperty'd
// writable:false and configurable:false, plus an interval that re-checks it.
// A surface that offers it must read THAT, never a second copy of the string.
// ===========================================================================
console.log('\n-- the tip jar --');
{
  const picks = grab('renderPicks');
  ok('the quick send offers the tip jar', /'cmp\.tipJar'/.test(picks));
  /* THE LOCK EXISTS SO THERE IS ONE PLACE TO REACH. Pasting the literal again
     here would quietly create a second, outside the lock and outside the
     interval that watches it. */
  ok('and reads the locked global, not a literal',
     /add\(topicsT\('cmp\.tipJar'\), TIP_ADDRESS/.test(picks));
  ok('with no second copy of the address anywhere in the panel',
     !/ecash:qracka0/.test(picks));
  ok('the address is still defined once', (mod.match(/ecash:qracka0[a-z0-9]+/g) || []).length === 1);
  /* SCOPED TO THE TIP BLOCK. A bare /writable:\s*false/ over the whole module is
     satisfied by any other defineProperty in the file -- loosening the tip lock
     left it green, which is the same weak-gate shape as matching a key name
     anywhere instead of at its call site. */
  {
    const at = mod.indexOf("defineProperty(globalThis, 'TIP_ADDRESS'");
    const block = at === -1 ? '' : mod.slice(at, mod.indexOf('}', mod.indexOf('enumerable', at)));
    ok('the lock is on TIP_ADDRESS itself', at !== -1);
    ok('and it is not writable', /writable:\s*false/.test(block));
    ok('and not configurable', /configurable:\s*false/.test(block));
  }

  /* IT REFUSES TO OFFER ITSELF IF THE GLOBAL NO LONGER MATCHES. And the check
     fails CLOSED: its own try/catch means a throw answers "do not offer",
     never "offer anyway", and never takes the watchlist picks down with it. */
  ok('the pick is gated on the global matching the literal',
     /TIP_ADDRESS === _TIP_ADDRESS_LITERAL/.test(picks));
  ok('and the gate fails closed',
     /catch \(e\) \{ tipOk = false; \}/.test(picks));

  /* SECURITY.md records that the tamper check's "refuse to render" half has
     been a no-op since v1.7.2, because the element it hides was removed. It
     protects something that exists again. */
  const guard = mod.slice(mod.indexOf('tampering detected'), mod.indexOf('tampering detected') + 700);
  ok('the tamper check drops the live tip surface too', /qs-pick\[data-tip="1"\]/.test(guard));
  ok('the pick carries the marker the check looks for', /b\.dataset\.tip = '1'/.test(picks));
}

console.log('\n-- the keyboard, and the zoom it causes --');
{
  /* iOS zooms on focus when a text input is under 16px, and .qs-amt #qs-amt-num
     sets 11px -- exactly that. The existing anti-zoom block covered
     input[type=text] only, so the number field was the one that would have
     jumped the whole page on focus. */
  /* COMMENTS STRIPPED, THIRD TIME ON THIS BRANCH. The comment inside this very
     block names `.qs-amt #qs-amt-num` while explaining why it was added, so the
     assertion matched the prose and stayed green with the selector deleted --
     the same mistake as reading `z-index:1` out of the comment that explained
     the z-index, and as counting the i18n key tables as uses of their own keys.
     A suite that reads documentation is testing the documentation. */
  const zoomRaw = html.slice(html.indexOf('iOS auto-zooms on focus'), html.indexOf('iOS auto-zooms on focus') + 1200);
  const zoom = zoomRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the anti-zoom block covers the text inputs', /#qs-panel input\[type=text\]/.test(zoom));
  ok('and the amount field, which sets 11px of its own', /\.qs-amt #qs-amt-num/.test(zoom));
  ok('at the size iOS stops zooming at', /font-size:\s*16px/.test(zoom));

  /* THE KEYBOARD DOES NOT MOVE position:fixed. On iOS the layout viewport is
     unchanged when it opens; only the visual viewport shrinks, so a panel
     pinned to the bottom sits underneath it. */
  const kb = grab('qsTrackKeyboard');
  ok('the overlap is measured from visualViewport',
     /window\.innerHeight - vv\.height - vv\.offsetTop/.test(kb));
  ok('and published as a length the sheet can use', /setProperty\('--kb'/.test(kb));
  ok('with a threshold, so the URL bar is not mistaken for a keyboard',
     /overlap > 60/.test(kb));
  /* There is no keyboard event: resize and scroll on the viewport are what fire
     on iOS, and both are needed -- scrolling with the keyboard up moves it. */
  ok('it listens to the viewport itself, not the window',
     /vv\.addEventListener\('resize'/.test(kb) && /vv\.addEventListener\('scroll'/.test(kb));
  ok('and does nothing where visualViewport is missing', /if \(!vv\) return;/.test(kb));
  ok('the flag is only set while the panel is open', /!panel\.hidden/.test(kb));

  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the panel rises by the measured amount', /body\[data-kb="1"\] #qs-panel\s*\{[^}]*bottom:\s*calc\(var\(--kb/.test(css));
  /* It must outrank the eChan lift: eChan is behind the keyboard too, so its
     offset is no longer the thing to clear. Later in source at equal weight. */
  ok('and it wins over the eChan lift',
     css.indexOf('body[data-kb="1"] #qs-panel') > css.indexOf('body:has(.echan-root.echan-shown) #qs-panel'));
  ok('the panel can scroll if the gap is small', /body\[data-kb="1"\] #qs-panel\s*\{[^}]*overflow-y:\s*auto/.test(css));
  ok('and the button gets out of the way', /body\[data-kb="1"\] #qs-fab\s*\{[^}]*pointer-events:\s*none/.test(css));
}

console.log(fail ? `\nFAILED ${fail}/${pass + fail}` : `\nok: neo quick-send ${pass} assertions`);
if (fail) process.exit(1);
