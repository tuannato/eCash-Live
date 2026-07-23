// Minimal Cashtab browser-extension bridge for Flow.
//
// Ported (only the pieces Flow needs: extension detection + requestAddress +
// sendBip21) from Bitcoin-ABC's `cashtab-connect`:
//   modules/cashtab-connect/src/index.ts — MIT, (c) 2025 The Bitcoin developers.
//   https://github.com/Bitcoin-ABC/bitcoin-abc/blob/master/modules/cashtab-connect/src/index.ts
//
// Protocol (verbatim from that source): the Cashtab extension sets
// `window.bitcoinAbc === 'cashtab'` on the page, listens for page messages of the
// form `{ type:'FROM_PAGE', ... }`, and replies with `{ type:'FROM_CASHTAB', ... }`.
// It is postMessage ONLY — no network, no dependencies — so it is safe under a
// strict `default-src 'none'` CSP (a page message is not a fetch, and the
// extension's own content script runs outside the page's script-src).

// The extension advertises itself with this window flag.
export function isCashtabExtension(){
  return typeof window !== 'undefined' && window.bitcoinAbc === 'cashtab';
}

// Single shared listener; one address request and one tx request may be in flight.
let addressCb = null, txCb = null, listening = false;
function ensureListener(){
  if (listening || typeof window === 'undefined' || !window.addEventListener) return;
  listening = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;                 // ignore cross-window noise
    const d = event.data;
    if (!d || d.type !== 'FROM_CASHTAB') return;
    // Address response — new format ({success,address,reason}) or legacy ({address}).
    if (addressCb){
      if (typeof d.success !== 'undefined'){
        const cb = addressCb; addressCb = null;
        cb({ success: !!d.success, address: d.address, reason: d.reason });
      } else if (typeof d.address !== 'undefined'){
        const cb = addressCb; addressCb = null;
        const denied = d.address === 'Address request denied by user' || !d.address;
        cb(denied ? { success:false, reason:'denied' } : { success:true, address:d.address });
      } else if (d.addressRequestApproved === false){
        const cb = addressCb; addressCb = null;
        cb({ success:false, reason:'denied' });
      }
    }
    // Transaction response.
    if (txCb && d.txResponse){
      const cb = txCb; txCb = null;
      cb({ success: !!d.txResponse.approved, txid: d.txResponse.txid, reason: d.txResponse.reason });
    }
  });
}

function post(msg){ if (typeof window !== 'undefined' && window.postMessage) window.postMessage(msg, '*'); }

// Ask the extension for the user's address (they approve inside the extension).
// Resolves with the ecash address string, rejects on deny/timeout/unavailable.
export function requestAddress(timeoutMs = 30000){
  return new Promise((resolve, reject) => {
    if (!isCashtabExtension()){ reject(new Error('unavailable')); return; }
    ensureListener();
    const to = setTimeout(() => { addressCb = null; reject(new Error('timeout')); }, timeoutMs);
    addressCb = (r) => { clearTimeout(to); r.success ? resolve(r.address) : reject(new Error(r.reason || 'denied')); };
    post({ text:'Cashtab', type:'FROM_PAGE', addressRequest:true });
  });
}

// Hand the extension a full BIP21 URI (e.g. "ecash:<addr>?op_return_raw=<hex>").
// Resolves with the broadcast txid, rejects on deny/timeout/unavailable.
export function sendBip21(bip21, timeoutMs = 120000){
  return new Promise((resolve, reject) => {
    if (!isCashtabExtension()){ reject(new Error('unavailable')); return; }
    ensureListener();
    const to = setTimeout(() => { txCb = null; reject(new Error('timeout')); }, timeoutMs);
    txCb = (r) => { clearTimeout(to); r.success ? resolve(r.txid) : reject(new Error(r.reason || 'denied')); };
    post({ text:'Cashtab', type:'FROM_PAGE', txInfo:{ bip21 } });
  });
}
