// Harness for prependHistory()'s boot-tip divider de-dupe + in-place count
// upgrade.  node tools/test-prepend-divider.mjs
//
// Extracts the shipped prependHistory() AND blockDivider() bodies from
// flow/index.html and runs those. A test of a copy passes when the copy is
// right; this one fails when the page is wrong.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'flow/index.html'), 'utf8');
const mod = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/)[1];

function grab(name) {
  const at = mod.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('not found: ' + name);
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
    else if (c === '}') { depth--; if (!depth) return mod.slice(at, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const body = grab('prependHistory');
const dividerBody = grab('blockDivider');
if (!/^function blockDivider\(/.test(dividerBody)) {
  throw new Error('failed to extract blockDivider()');
}

// Shape pins: the shipped function must do these things, not a restatement.
const pins = [
  [/_blockData\.height === height/, 'DOM height compare is ==='],
  [/existing\._blockData\.n == null/, 'upgrade only when existing n is null'],
  [/existing\._blockData\.n = n/, 'upgrade writes n onto the existing node'],
  [/stream\.querySelectorAll\('\.divider'\)/, 'looks in the live stream'],
];
for (const [re, why] of pins) {
  if (!re.test(body)) throw new Error('shape pin failed: ' + why);
}
if (/new Set|new Map/.test(body)) throw new Error('must not introduce a Set/Map of heights');
if (/cloneNode|replaceWith/.test(body)) throw new Error('must not clone or replace the divider');
if (!/openBlockPanel\(height, div\._blockData\.n\)/.test(dividerBody)) {
  throw new Error('blockDivider must read n from _blockData at click time');
}

// Minimal DOM sufficient for the divider path.
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.type = '';
    this.childNodes = [];
    this.parentNode = null;
    this._blockData = undefined;
    this._listeners = [];
    this._html = '';
    this.scrollHeight = 100;
    this.scrollTop = 0;
    this.hidden = false;
  }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = String(html);
    this.childNodes = [];
    const re = /<([a-zA-Z0-9]+)([^>]*)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const el = new FakeEl(m[1]);
      const cm = m[2].match(/class=["']([^"']*)["']/);
      if (cm) el.className = cm[1];
      el.innerHTML = m[3];
      this.childNodes.push(el);
      el.parentNode = this;
    }
  }
  get firstChild() { return this.childNodes[0] || null; }
  querySelectorAll(sel) {
    const want = sel.replace(/^\./, '');
    const out = [];
    const walk = (n) => {
      if (typeof n.className === 'string' && n.className.split(/\s+/).includes(want)) out.push(n);
      for (const c of n.childNodes) walk(c);
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  appendChild(c) {
    if (c && c._isFrag) {
      for (const n of [...c.childNodes]) this.appendChild(n);
      c.childNodes.length = 0;
      return c;
    }
    this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  insertBefore(c, ref) {
    if (c && c._isFrag) {
      const kids = [...c.childNodes];
      c.childNodes.length = 0;
      if (ref == null) { for (const n of kids) this.appendChild(n); return c; }
      const i = this.childNodes.indexOf(ref);
      for (let k = 0; k < kids.length; k++) {
        this.childNodes.splice(i + k, 0, kids[k]);
        kids[k].parentNode = this;
      }
      return c;
    }
    if (ref == null) return this.appendChild(c);
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  addEventListener(type, fn) { this._listeners.push({ type, fn }); }
  click() { for (const l of this._listeners) if (l.type === 'click') l.fn(); }
}

function makeFrag() {
  const f = new FakeEl('fragment');
  f._isFrag = true;
  return f;
}

function makeStream(dividers) {
  const stream = new FakeEl('div');
  for (const d of dividers) stream.appendChild(d);
  return stream;
}

function makeDivider(height, n) {
  const div = new FakeEl('button');
  div.className = 'divider';
  div.type = 'button';
  div._blockData = { height, n };
  const lbl = new FakeEl('span');
  lbl.className = 'lbl';
  lbl.innerHTML = n != null ? `block ${height} · sealed ${n} tx` : `block ${height}`;
  div.appendChild(lbl);
  return div;
}

const openCalls = [];
let histCount = 0;
const HIST_MAX = 200;
const DUST_XEC = 5.46;

function makeEnv(stream) {
  const document = {
    createElement: (tag) => new FakeEl(tag),
    createDocumentFragment: () => makeFrag(),
  };
  const factory = new Function(
    'document',
    'HIST_MAX', 'histCount', 'DUST_XEC',
    'scrubTx', 'parseTransactionCore', 'txKind', 'labelPay', 'histCard',
    'tf', 't', 'fmtInt', 'esc', 'IC', 'matchesFilter',
    'hideEmpty', 'stream', 'scrollInstant', 'normalizeRoving',
    'openBlockPanel',
    `
    ${dividerBody}
    ${body}
    return { prependHistory, blockDivider };
    `
  );
  return factory(
    document,
    HIST_MAX, histCount, DUST_XEC,
    (tx) => tx,
    (d) => d,
    () => ({ kind: 'msg', f: 'f-msg', icon: 'x' }),
    () => 'pay',
    () => { const el = new FakeEl('article'); el.className = 'card'; return el; },
    (key, vars) => key === 'divider.block'
      ? `block ${vars.h} · sealed ${vars.n} tx`
      : `block ${vars.h}`,
    (k) => k,
    (n) => String(n),
    (s) => s,
    { cube: '[cube]', stack: '[stack]', checks: '' },
    () => true,
    () => {},
    stream,
    () => {},
    () => {},
    (h, n) => openCalls.push([h, n]),
  );
}

function run(txDatas, height, realTxCount, stream) {
  return makeEnv(stream).prependHistory(txDatas, height, realTxCount);
}

function dividers(stream) {
  return stream.querySelectorAll('.divider');
}

const txs = [{ id: 'aa', valueXec: 100 }];
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

// 1. Empty stream (boot divider evicted) → history draws one.
{
  openCalls.length = 0;
  const stream = makeStream([]);
  run(txs, 961856, 4, stream);
  const ds = dividers(stream);
  check('evicted: draws one divider', ds.length === 1, 'got ' + ds.length);
  check('evicted: height H', ds[0]._blockData.height === 961856);
  check('evicted: n=4', ds[0]._blockData.n === 4);
}

// 2. Boot divider present, same height, already counted → no second, no overwrite.
{
  openCalls.length = 0;
  const boot = makeDivider(961856, 4);
  const stream = makeStream([boot]);
  run(txs, 961856, 4, stream);
  const ds = dividers(stream);
  check('dup skip: still one divider', ds.length === 1, 'got ' + ds.length);
  check('dup skip: n stays 4', ds[0]._blockData.n === 4);
  check('dup skip: same node (not replaced)', ds[0] === boot);
}

// 3. Boot divider, no count; batch has a real count → upgrade in place.
//    Click must use the upgraded n via _blockData, on the SAME node.
{
  openCalls.length = 0;
  const live = new FakeEl('article'); live.className = 'card live';
  const stream = makeStream([live]);
  const env = makeEnv(stream);
  const boot = env.blockDivider(961856, null, 'block 961856');
  stream.insertBefore(boot, live);
  env.prependHistory(txs, 961856, 7);
  const ds = dividers(stream);
  check('upgrade: still one divider', ds.length === 1, 'got ' + ds.length);
  check('upgrade: n becomes 7', ds[0]._blockData.n === 7);
  check('upgrade: label is block form', /sealed 7 tx/.test(ds[0].querySelector('.lbl').innerHTML));
  check('upgrade: same node (identity preserved)', ds[0] === boot);
  boot.click();
  check('upgrade: click gets (H, 7) without replacement',
    openCalls.length === 1 && openCalls[0][0] === 961856 && openCalls[0][1] === 7,
    JSON.stringify(openCalls));
}

// 4. Never the reverse: real count must not become omitted.
{
  openCalls.length = 0;
  const boot = makeDivider(961856, 4);
  const stream = makeStream([boot]);
  run(txs, 961856, null, stream);
  const ds = dividers(stream);
  check('no downgrade: still one', ds.length === 1);
  check('no downgrade: n stays 4', ds[0]._blockData.n === 4);
  check('no downgrade: same node', ds[0] === boot);
}

// 5. Existing no-count + batch no-count → leave, do not append.
{
  const boot = makeDivider(961856, null);
  const stream = makeStream([boot]);
  run(txs, 961856, null, stream);
  const ds = dividers(stream);
  check('both omitted: still one', ds.length === 1);
  check('both omitted: n still null', ds[0]._blockData.n == null);
  check('both omitted: same node', ds[0] === boot);
}

// 6. Different height in the stream → history still draws its own.
{
  const other = makeDivider(961855, 3);
  const stream = makeStream([other]);
  run(txs, 961856, 4, stream);
  const ds = dividers(stream);
  check('other height: two dividers', ds.length === 2, 'got ' + ds.length);
  check('other height: new one is H', ds.some(d => d._blockData.height === 961856 && d._blockData.n === 4));
  check('other height: old one kept', ds.some(d => d._blockData.height === 961855 && d._blockData.n === 3));
}

// 7. Cards land ABOVE the surviving boot divider (DOM order).
{
  const boot = makeDivider(961856, 4);
  const live = new FakeEl('article'); live.className = 'card live';
  const stream = makeStream([boot, live]);
  run(txs, 961856, 4, stream);
  const kinds = stream.childNodes.map(n => n.className);
  check('order: card then divider then live',
    kinds[0] === 'card' && kinds[1] === 'divider' && kinds[2] === 'card live',
    JSON.stringify(kinds));
}

// 8. Empty batch (no parseable txs) → do not touch dividers.
{
  const boot = makeDivider(961856, null);
  const stream = makeStream([boot]);
  const added = run([], 961856, 9, stream);
  check('empty frag: added 0', added === 0);
  check('empty frag: divider untouched n', dividers(stream)[0]._blockData.n == null);
}

// 9. n === 0 is a real count (upgrade), not omitted.
{
  const boot = makeDivider(961856, null);
  const stream = makeStream([boot]);
  run(txs, 961856, 0, stream);
  check('zero count: upgrades to 0', dividers(stream)[0]._blockData.n === 0);
}

// 10. Height compare is strict: string "961856" is not H.
{
  const boot = makeDivider('961856', 4);
  const stream = makeStream([boot]);
  run(txs, 961856, 4, stream);
  check('strict === : string height is not a match (draws second)',
    dividers(stream).length === 2, 'got ' + dividers(stream).length);
}

console.log(`\nextracted blockDivider(): ${dividerBody.split('\n').length} lines`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
