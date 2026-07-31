/* =============================================================================
 * eCash Live — door router (v1.0)
 * =============================================================================
 * The site has two doors over the same live data: neo (the pro dashboard,
 * index.html) and Flow (the newcomer stream, flow/index.html). This file owns
 * the single question "which door is this visitor's home?" and nothing else.
 *
 * ONE FILE, BOTH DOORS — on purpose. The rule used to live inside neo's pinned
 * module while Flow only wrote half of it, so the two sides could drift apart
 * and disagree about a visitor. Sharing the resolver makes disagreement
 * impossible (core value #6, "two doors, one truth").
 *
 * WHY A CLASSIC <script> IN <head>, NOT THE MODULE
 *   A `type="module"` script is deferred: it runs after the document is parsed,
 *   so a redirect decided there happens *after* the browser has already painted
 *   the wrong door. A newcomer would see the dense dashboard flash past on the
 *   way to Flow — the exact first impression this change exists to fix. A
 *   render-blocking classic script in <head> decides before the first paint.
 *
 * WHY IT COSTS NO CSP TOKEN
 *   Both pages already ship `script-src 'self'`, which covers a same-origin
 *   file. An inline <script> would instead need its own SHA-256 pinned in the
 *   CSP, and `update-csp-hash.sh` rewrites the FIRST sha256 token it finds —
 *   a second token would be corrupted by the next routine hash regen. An
 *   external file sidesteps that trap entirely.
 *
 * THE DEFAULT
 *   Flow is the front door for anyone with no history here. It explains itself;
 *   neo assumes you already know what a mempool is.
 *
 *   A visitor who has used the dashboard before is NEVER moved. "No stored
 *   preference" is not the same as "new" — this site shipped for a long time
 *   with no preference key at all, so plenty of regulars have never expressed a
 *   choice. Silently relocating their home page would be exactly the kind of
 *   surprise the project does not do. Prior use is detected from neo's own
 *   localStorage keys (NEO_KEYS below), and the answer is written down the
 *   first time it is derived, so the ambiguity exists for one page load only.
 *
 * STORAGE
 *   Reads/writes exactly one key, `ecashlive:pref` ('flow' | 'pro'), which both
 *   doors already used before this file existed. No new key, and nothing here is
 *   sensitive: it is a UI preference, never sent anywhere.
 * ============================================================================= */
(function () {
  'use strict';

  var PREF_KEY = 'ecashlive:pref';
  var FLOW_PATH = './flow/';

  /* Keys written ONLY by neo, so finding one proves prior dashboard use.
   *
   * Deliberately NOT here:
   *   'ecashlive.lang'        — both doors write it (shared language choice)
   *   'ecashlive:pref'        — that is the answer, not evidence for it
   *   'ecashlive:flow:*'      — Flow's own keys
   *   'ecash-live-chat-v1', 'ecash-live:watchlist:v3' — neo-owned, but Flow
   *      READS them (the one-way myAddr seed and watchlist merge). Reading
   *      cannot create them, so they would still be valid evidence; they are
   *      listed for completeness and kept.
   * The list is a union: any single hit is enough. Over-detecting only means a
   * visitor keeps the dashboard, which is the safe direction to be wrong in. */
  var NEO_KEYS = [
    'ecash-live-view',
    'ecash-live-guide-seen-v1',
    'ecash-live-chat-v1',
    'ecash-live-chat-opened-v1',
    'ecash-live:icons:show',
    'ecash-live:price:per1m',
    'ecash-live:radar:open',
    'ecash-live:radar:sound',
    'ecash-live:radar:sweep',
    'ecash-live:watchlist:v1',
    'ecash-live:watchlist:v2',
    'ecash-live:watchlist:v3',
    'ecashlive.echan.visits',
    'ecashlive.echan.shown',
    'ecashlive.echan.deskpos',
    'ecashlive.echan.dismissed',
    'ecashlive.echan.tourdone',
    'ecashlive.echan.statsring'
  ];

  /* localStorage throws in a partitioned/blocked context (Safari private mode,
   * some embedded webviews). Every access is guarded: with no storage the
   * visitor is treated as new on every load, which is a degraded experience,
   * never a broken one. */
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function usedNeoBefore() {
    for (var i = 0; i < NEO_KEYS.length; i++) {
      if (get(NEO_KEYS[i]) !== null) return true;
    }
    return false;
  }

  function param(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }

  /**
   * The visitor's home door: 'flow' or 'pro'.
   * Persists the answer the first time it is derived, so every later visit is a
   * lookup rather than a re-derivation — and so the NEO_KEYS heuristic runs at
   * most once per browser.
   */
  function resolve() {
    // ?door=flow / ?door=pro — an explicit, shareable override. This is the
    // escape hatch for a visitor stuck on the wrong door (and for support:
    // "open this link"). It records the choice like any other.
    var forced = param('door');
    if (forced === 'flow' || forced === 'pro') { set(PREF_KEY, forced); return forced; }

    var pref = get(PREF_KEY);
    if (pref === 'flow' || pref === 'pro') return pref;

    var door = usedNeoBefore() ? 'pro' : 'flow';
    set(PREF_KEY, door);
    return door;
  }

  /** Record a door the visitor picked in the UI (neo's Flow gateway, Flow's
   *  "Dashboard →"). Kept here so both doors write the key the same way. */
  function choose(d) { if (d === 'flow' || d === 'pro') set(PREF_KEY, d); }

  window.__ecDoor = { resolve: resolve, choose: choose, current: function () { return get(PREF_KEY); } };

  // Which page is this? Declared by the tag itself (data-door), so the file
  // needs no path sniffing and no edit to <html>.
  var here = 'neo';
  try {
    var s = document.currentScript;
    if (s && s.getAttribute('data-door')) here = s.getAttribute('data-door');
  } catch (e) {}

  // Only neo redirects. Flow never sends anyone to the dashboard on its own:
  // landing on Flow is already the answer, and a shared ?tx= receipt must open
  // where it points. Flow still calls resolve(), so a newcomer who arrives
  // through a share link has their default recorded like anyone else.
  if (here !== 'neo') { resolve(); return; }

  // ?endpoint= points neo at a different chronik node. It is a dashboard-only
  // dev override and must always land on the dashboard.
  if (param('endpoint') !== null) return;

  // location.replace, not assign: the redirect must not become a back-button
  // trap between the two doors. Query and hash are carried so a link's intent
  // survives the hop.
  if (resolve() === 'flow') location.replace(FLOW_PATH + location.search + location.hash);
})();
