// Harness for the eMPP + alias/PayButton work (2026-08-04b).
//   node tools/test-txparse-empp.mjs
//
// The five eMPP scripts below are REAL, pulled from chronik's Cashtab-Msg lokad
// index (/lokad-id/00746162/history). They are kept verbatim because they are
// the only evidence that the eMPP payload layout is `4-byte lokad + raw UTF-8`
// with no inner length prefix — the fact the whole parseEmpp design rests on.
import {
  parseOpReturn, parseTransactionCore, LOKAD, MESSAGE_LOKADS,
} from '../vendor/txparse.js';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  <-- ' + x)); };
const hx = (s) => Buffer.from(s, 'utf8').toString('hex');
// Smallest push opcode that fits. The PUSHDATA1 branch is NOT optional: without
// it a 76-byte payload emits a bare 0x4c, which is PUSHDATA1's opcode with no
// length byte — a malformed script that makes the boundary test fail against a
// perfectly correct parser. (That exact mistake was made while writing this.)
const p = (h) => {
  const l = h.length / 2;
  if (l <= 0x4b) return l.toString(16).padStart(2, '0') + h;
  return '4c' + l.toString(16).padStart(2, '0') + h;
};

// ---- real chain data -------------------------------------------------------
const REAL_EMPP = [
  ['6a062f73', '6a5037534c5032000453454e44f0cb08302c4bbc665b6241592b19fd37ec5d632f323e9ab14fdb75d57f94870302404b4c000000120c3f0000001d00746162746f6b656e207478202b204d657373616765203d20436f6f6c',
    'token tx + Message = Cool'],
  ['c207f0bb', '6a5037534c5032000453454e44d44ecf795494b063aa10be876868880df8ef822577c1a546fb1cd9b6c2f57bc60260ec53000000e2a9e20200004c63007461626e6f746963656420796f75206861766520584543582062757420746865206d696e696d756d20666f72207374616b696e6720726577617264732069732061726f756e6420243120736f20686572652069732061206c6974746c652068656c70',
    'noticed you have XECX but the minimum for staking rewards is around $1 so here is a little help'],
  ['8b9ff753', '6a5037534c5032000453454e44ff9ae898bc8dcbe8b1056259f91fe00ef93737514c29038d258d603c52dc2e9602c80000000000ae7d2d0100004c60007461625468616e6b20796f7520666f7220796f757220706f73697469766520726576696577202b2076616c7561626c652074727573742e204d617920796f75206b65657020757020796f7572207472757374206f6e204254582e20f09f998f',
    'Thank you for your positive review + valuable trust. May you keep up your trust on BTX. \u{1F64F}'],
  ['df2ea01d', '6a5037534c5032000453454e44ff9ae898bc8dcbe8b1056259f91fe00ef93737514c29038d258d603c52dc2e9602280000000000fe853f6bfebe4c66007461625468616e6b20796f7520666f7220796f757220706f736974697665207265766965772e2053696e636520796f75206e6f7420686f6c64696e67204254582c2072657761726420697320342042545820746f20636f76657220796f757220636f73742e',
    'Thank you for your positive review. Since you not holding BTX, reward is 4 BTX to cover your cost.'],
  ['089181c6', '6a5037534c5032000453454e44ff9ae898bc8dcbe8b1056259f91fe00ef93737514c29038d258d603c52dc2e9602c800000000001511000000004c67007461625468616e6b20796f7520666f7220796f757220706f73697469766520726576696577202b2076616c7561626c652074727573742e204d617920746865206d757475616c2062656e6566697473206f662042545820746f6b656e20636f6e74696e75652e',
    'Thank you for your positive review + valuable trust. May the mutual benefits of BTX token continue.'],
];

console.log('\n=== A. eMPP: 5 REAL chain txs from the lokad index ===');
for (const [id, script, want] of REAL_EMPP) {
  const m = parseOpReturn(script);
  ok(`${id} text extracted verbatim`, !!m && m.text === want, JSON.stringify(m && m.text));
  ok(`${id} type=cashtab, content===text, synthetic=false`,
    !!m && m.type === 'cashtab' && m.content === m.text && m.synthetic === false);
}

console.log('\n=== B. eMPP spec validity (doc/standards/empp.md) ===');
ok('bare opcode inside eMPP invalidates the whole script', parseOpReturn('6a50' + p(LOKAD.CASHTAB_MSG + hx('hi')) + '51') === null);
ok('OP_0 fragment invalidates the whole script', parseOpReturn('6a50' + '00' + p(LOKAD.CASHTAB_MSG + hx('hi'))) === null);
ok('truncated push invalidates the whole script', parseOpReturn('6a50' + '20' + LOKAD.CASHTAB_MSG) === null);
ok('no fragments -> null', parseOpReturn('6a50') === null);
ok('fragment shorter than a lokad is SKIPPED, not fatal',
  (() => { const m = parseOpReturn('6a50' + p('aabb') + p(LOKAD.CASHTAB_MSG + hx('kept'))); return !!m && m.text === 'kept'; })());

console.log('\n=== B2. an unknown lokad inside eMPP does not leak its id into the text ===');
{
  const m = parseOpReturn('6a50' + p('57585a5a' + hx('some payload text')));
  ok('payload only, id stripped', !!m && m.text === 'some payload text', JSON.stringify(m));
  ok('id is not searchable as if someone wrote it', !!m && !/WXZZ/i.test(m.text));
}
{
  const m = parseOpReturn('6a50' + p('57585a5a' + hx('ab')));
  ok('too-short payload under an unknown id yields nothing', m === null, JSON.stringify(m));
}

console.log('\n=== C. eMPP boundary math around the 4-byte lokad + PUSHDATA1 ===');
ok('len 3 (one under a lokad) -> skipped', parseOpReturn('6a50' + p('aabbcc')) === null);
ok('len 4 (lokad, no payload) -> no text', (() => { const m = parseOpReturn('6a50' + p(LOKAD.CASHTAB_MSG)); return m === null || m.text === null; })());
ok('len 5 (one over) -> 1-byte text', (() => { const m = parseOpReturn('6a50' + p(LOKAD.CASHTAB_MSG + hx('x'))); return !!m && m.text === 'x'; })());
ok('75-byte push (direct opcode)', (() => { const t = 'y'.repeat(71); const m = parseOpReturn('6a50' + p(LOKAD.CASHTAB_MSG + hx(t))); return !!m && m.text === t; })());
ok('76-byte push (PUSHDATA1)', (() => { const t = 'y'.repeat(72); const m = parseOpReturn('6a50' + p(LOKAD.CASHTAB_MSG + hx(t))); return !!m && m.text === t; })());

console.log('\n=== D. eMPP fragment selection: real text beats a textless protocol ===');
ok('ALP first, cashtab second -> the message', (() => { const m = parseOpReturn('6a50' + p('534c5032' + '00045345') + p(LOKAD.CASHTAB_MSG + hx('note'))); return !!m && m.text === 'note'; })());
ok('cashtab first, ALP second -> the message', (() => { const m = parseOpReturn('6a50' + p(LOKAD.CASHTAB_MSG + hx('note')) + p('534c5032' + '00045345')); return !!m && m.text === 'note'; })());
ok('all fragments textless -> null', parseOpReturn('6a50' + p('534c5032' + '00045345') + p(LOKAD.AGORA + '07504152')) === null);

console.log('\n=== E. non-eMPP scripts unaffected by the 0x50 dispatch ===');
ok('standard cashtab still parses', (() => { const m = parseOpReturn('6a' + '04' + LOKAD.CASHTAB_MSG + p(hx('classic'))); return !!m && m.text === 'classic'; })());
ok('PayButton lokad starts with 0x50 but is NOT eMPP', (() => { const m = parseOpReturn('6a' + '04' + LOKAD.PAYBUTTON + '00' + p(hx('pb'))); return !!m && m.type === 'broadcast'; })());
ok('non-OP_RETURN -> null', parseOpReturn('76a914') === null);

// ---- alias + PayButton (the bare-OP_0 defect, fixed 2026-08-04b) ------------
console.log("\n=== F. PayButton: the spec's OWN example scripts ===");
const ex1 = '6a0450415900000c0102030405060708090a0b0c00';
const ex2 = '6a0450415900000c0102030405060708090a0b0c080102030405060708';
const ex3 = '6a04504159000000080102030405060708';
const d12 = Buffer.from('0102030405060708090a0b0c', 'hex').toString('utf8');
ok('ex1 (data, no nonce) -> data extracted', parseOpReturn(ex1).text === d12, JSON.stringify(parseOpReturn(ex1)));
ok('ex2 (data + nonce) -> data, NOT the nonce', parseOpReturn(ex2).text === d12, JSON.stringify(parseOpReturn(ex2)));
ok('ex3 (NO data + nonce) -> null, nonce not mistaken for data', parseOpReturn(ex3).text === null, JSON.stringify(parseOpReturn(ex3)));
ok('utf8 payload round-trips', (() => { const m = parseOpReturn('6a0450415900' + '00' + p(hx('order-42')) + '08' + '0102030405060708'); return m.text === 'order-42' && m.content === 'PayButton: order-42'; })());
ok('nonce never leaks into text', parseOpReturn('6a0450415900' + '00' + p(hx('real-data')) + p(hx('NONCE!!!'))).text === 'real-data');

console.log('\n=== G. Alias: spec shape (bare OP_0 version) ===');
const alias = (name) => parseOpReturn('6a04' + LOKAD.ALIAS + '00' + p(hx(name)) + p('00'.repeat(21)));
ok('name extracted from a spec-conformant registration', (() => { const m = alias('satoshi'); return m.text === 'satoshi' && m.content === 'alias: "satoshi"'; })());
ok('1-char alias (spec minimum)', alias('a').text === 'a');
ok('21-char alias (spec maximum)', alias('a'.repeat(21)).text === 'a'.repeat(21));
ok('22-char alias (one past) rejected', alias('a'.repeat(22)).text === null);
ok('uppercase rejected by the [a-z0-9] rule', alias('BadCase').text === null);
ok('version only, no alias -> label, no text', (() => { const m = parseOpReturn('6a04' + LOKAD.ALIAS + '00'); return m.type === 'alias' && m.text === null; })());

console.log('\n=== H. the four untouched readAllPushes branches ===');
ok('Cashtab standard', parseOpReturn('6a04' + LOKAD.CASHTAB_MSG + p(hx('hello'))).text === 'hello');
ok('Airdrop note', parseOpReturn('6a04' + LOKAD.AIRDROP + p('aa'.repeat(32)) + p(hx('free'))).text === 'free');
ok('eCashChat post', parseOpReturn('6a04' + LOKAD.ECASHCHAT_TX + p(hx('post')) + p(hx('hi all'))).text === 'hi all');
ok('Article title', parseOpReturn('6a04' + LOKAD.ARTICLE + p(hx('My title'))).text === 'My title');
ok('POWR stays hashes-only', (() => { const m = parseOpReturn('6a04' + LOKAD.POWR + '0051' + p('bb'.repeat(32))); return m.type === 'powr' && m.text === null; })());
ok('encrypted stays textless', parseOpReturn('6a04' + LOKAD.CASHTAB_ENC + p('deadbeef')).text === null);

console.log('\n=== I. MESSAGE_LOKADS parity: the table vs the actual branches ===');
// One realistic payload per protocol, built from each branch's documented shape.
const PROBE = {
  [LOKAD.CASHTAB_MSG]: p(hx('hello world')),
  [LOKAD.ALIAS]: '00' + p(hx('satoshi')) + p('00'.repeat(21)),
  [LOKAD.AIRDROP]: p('aa'.repeat(32)) + p(hx('free tokens')),
  [LOKAD.ECASHCHAT_TX]: p(hx('post')) + p(hx('a public post')),
  [LOKAD.PAYBUTTON]: '00' + p(hx('order-42')) + '08' + '0102030405060708',
  [LOKAD.ARTICLE]: p(hx('My article title')),
  [LOKAD.CASHTAB_ENC]: p('deadbeef'),
  [LOKAD.AGORA]: p(hx('PARTIAL')),
  [LOKAD.ECASHCHAT_AUTH]: p(hx('auth')),
  [LOKAD.PAYWALL]: p('aa'.repeat(32)),
  [LOKAD.CASHFUSION]: p('00'),
  [LOKAD.POWR]: '0051' + p('bb'.repeat(32)),
};
ok('MESSAGE_LOKADS has 6 entries', MESSAGE_LOKADS.length === 6, String(MESSAGE_LOKADS.length));
const want = new Set(MESSAGE_LOKADS);
for (const [name, id] of Object.entries(LOKAD)) {
  const m = parseOpReturn('6a' + '04' + id + (PROBE[id] || ''));
  const has = !!(m && m.text);
  ok(`${name.padEnd(15)} ${id} text=${has ? 'yes' : 'no '} ${want.has(id) ? '(listed)' : '(excluded)'}`,
    has === want.has(id), `table says ${want.has(id)}, parser gave ${has} -> ${JSON.stringify(m)}`);
}
for (const id of MESSAGE_LOKADS) ok(`  ${id} is a real LOKAD value`, Object.values(LOKAD).includes(id));

console.log('\n=== J. REGRESSION: 6,174-tx Agora corpus classification unchanged ===');
const CORPUS = join(ROOT, 'internal/agora-review/out/agora-samples.jsonl');
if (!fs.existsSync(CORPUS)) {
  console.log('  skip  corpus not present at', CORPUS);
} else {
  const BASE = { 'agora-list': 1093, 'agora-buy': 2978, 'agora-relist': 1866, 'agora-cancel': 237 };
  const got = {}; let nTx = 0, realText = 0, empp = 0;
  for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let raw; try { raw = JSON.parse(line).raw; } catch { continue; }
    if (!raw || !raw.outputs) continue;
    nTx++;
    if ((raw.outputs[0]?.outputScript || '').toLowerCase().startsWith('6a50')) empp++;
    let tx; try { tx = parseTransactionCore(raw); } catch { continue; }
    if (!tx.message) continue;
    got[tx.message.type] = (got[tx.message.type] || 0) + 1;
    if (tx.message.text != null && String(tx.message.text).length) realText++;
  }
  ok(`corpus ${nTx} txs, ${empp} of them eMPP`, nTx === 6174 && empp === 5385, `${nTx}/${empp}`);
  for (const k of Object.keys(BASE)) ok(`${k} = ${BASE[k]}`, got[k] === BASE[k], `got ${got[k]}`);
  ok('still 0 real text in the Agora corpus', realText === 0, String(realText));
  ok('no new message types', Object.keys(got).sort().join() === Object.keys(BASE).sort().join(), Object.keys(got).join());
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
