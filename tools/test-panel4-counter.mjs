// Harness for panel4Counter — sole writer of the panel-04 header count.
//   node tools/test-panel4-counter.mjs
//
// Extracts the shipped panel4Counter() body from index.html and drives that.
// A test of a copy passes when the copy is right; this one fails when the
// page is wrong. The one-writer scan is the real gate: it is what stops
// renderMessages from stamping Feed's count onto a Chat-labelled header.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const modMatch = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
if (!modMatch) throw new Error('no inline module in index.html');
const mod = modMatch[1];

/** Lift `function name(...) { ... }` by balancing braces, skipping strings
 *  and comments so a brace inside either cannot end it.
 *
 *  TRAP: searching for `'function ' + name + '('` lands AFTER `async`.
 *  Slicing from there produces a non-async body and `await` throws
 *  SyntaxError, which then falls into the function's own try/catch.
 *  Walk back six characters and keep the keyword when it is there. */
function grab(name) {
  const at = mod.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('not found in index.html: ' + name);
  let start = at;
  if (at >= 6 && mod.slice(at - 6, at) === 'async ') start = at - 6;
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

const body = grab('panel4Counter');
if (!/^function panel4Counter\(/.test(body) && !/^async function panel4Counter\(/.test(body)) {
  throw new Error('extracted something that is not panel4Counter');
}

// ---------------------------------------------------------------------------
// One writer. Scan the shipped page, not a restatement: any assignment to
// #r-msgs / #r-msgs-label outside panel4Counter is the bug coming back.
// ---------------------------------------------------------------------------
const withoutOwner = html.replace(body, '');
const ASSIGN = /(?:\$\(\s*['"]r-msgs(?:-label)?['"]\s*\)|getElementById\(\s*['"]r-msgs(?:-label)?['"]\s*\))\s*\.\s*(?:textContent|innerText|innerHTML)\s*=/;
const FETCH = /\$\(\s*['"]r-msgs(?:-label)?['"]\s*\)/;
if (ASSIGN.test(withoutOwner)) {
  throw new Error('assignment to #r-msgs / #r-msgs-label outside panel4Counter');
}
if (FETCH.test(withoutOwner)) {
  throw new Error('$("r-msgs") / $("r-msgs-label") used outside panel4Counter');
}

// renderMessages and chatSwitchTab must call the owner, not restated logic.
const renderBody = grab('renderMessages');
const switchBody = grab('chatSwitchTab');
if (!/\bpanel4Counter\s*\(/.test(renderBody)) {
  throw new Error('renderMessages does not call panel4Counter');
}
if (!/\bpanel4Counter\s*\(/.test(switchBody)) {
  throw new Error('chatSwitchTab does not call panel4Counter');
}
if (/\$\(\s*['"]r-msgs/.test(renderBody) || /\$\(\s*['"]r-msgs/.test(switchBody)) {
  throw new Error('a caller still touches #r-msgs directly');
}

// ---------------------------------------------------------------------------
// Drive the shipped body.
// ---------------------------------------------------------------------------
function el(seed) {
  let v = String(seed);
  return {
    get textContent() { return v; },
    set textContent(x) { v = String(x); },
  };
}

function make(tab, feedLen, chatLen, seedN = 'X', seedLbl = 'kept', topics) {
  const nodes = {
    'section-messages': { dataset: topics === undefined ? { tab } : { tab, topics } },
    'r-msgs': el(seedN),
    'r-msgs-label': el(seedLbl),
  };
  const $ = (id) => nodes[id];
  const state = { messages: Array(feedLen).fill(null) };
  const chatState = { messages: Array(chatLen).fill(null) };
  const panel4Counter = new Function('$', 'state', 'chatState', body + '\nreturn panel4Counter;')($, state, chatState);
  return { panel4Counter, nodes, state, chatState };
}

function assertEqual(got, want, label) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

let n = 0;
function check(tab, feedLen, chatLen, wantN, wantLbl, seedN, seedLbl, topics) {
  const { panel4Counter, nodes } = make(tab, feedLen, chatLen, seedN, seedLbl, topics);
  panel4Counter();
  assertEqual(nodes['r-msgs'].textContent, wantN, `tab=${tab} n`);
  assertEqual(nodes['r-msgs-label'].textContent, wantLbl, `tab=${tab} label`);
  n++;
}

// feed → feed count + "recent" (unfiltered length, including empty).
check('feed', 0, 5, '0', 'recent');
check('feed', 37, 2, '37', 'recent');
check('feed', 1, 0, '1', 'recent');

// chat → chat count + "chat".
check('chat', 37, 0, '0', 'chat');
check('chat', 37, 5, '5', 'chat');
check('chat', 0, 1, '1', 'chat');

// Unknown pane: leave both nodes untouched. Painting Feed's count is the
// lie this function exists to stop.
check('blocks', 37, 5, 'X', 'kept', 'X', 'kept');
check('', 37, 5, '99', 'stale', '99', 'stale');
check(undefined, 37, 5, '7', 'chat', '7', 'chat');

// THE TOPICS OVERLAY IS A SECOND AXIS, not a value of data-tab. It covers the
// feed, so data-tab stays whatever it was and the overlay decides. Reading the
// wrong attribute is how the count would keep describing the feed underneath.
check('feed', 37, 5, '0', 'topics', 'X', 'kept', 'open');
check('chat', 37, 5, '0', 'topics', 'X', 'kept', 'open');
// ...and a closed overlay must fall straight through to the tab.
check('feed', 37, 5, '37', 'recent', 'X', 'kept', 'closed');
check('chat', 37, 5, '5', 'chat', 'X', 'kept', 'closed');
// The two axes must not be confused: data-tab="topics" is not the overlay.
check('topics', 37, 5, 'X', 'kept', 'X', 'kept', 'closed');

// Live re-paint on the same pane (the renderMessages path): counts move,
// label stays the pane's word.
{
  const { panel4Counter, nodes, state, chatState } = make('feed', 3, 1, '0', 'recent');
  panel4Counter();
  assertEqual(nodes['r-msgs'].textContent, '3', 'live feed first');
  state.messages.push(null, null);
  panel4Counter();
  assertEqual(nodes['r-msgs'].textContent, '5', 'live feed grew');
  assertEqual(nodes['r-msgs-label'].textContent, 'recent', 'live feed label');
  nodes['section-messages'].dataset.tab = 'chat';
  panel4Counter();
  assertEqual(nodes['r-msgs'].textContent, '1', 'switched to chat');
  assertEqual(nodes['r-msgs-label'].textContent, 'chat', 'switched label');
  chatState.messages.push(null);
  panel4Counter();
  assertEqual(nodes['r-msgs'].textContent, '2', 'live chat grew');
  n++;
}

console.log(`ok: panel4Counter ${n} cases, one writer`);
