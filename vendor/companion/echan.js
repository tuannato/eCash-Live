/* =============================================================================
 * eChan companion — 1.3.4 controller
 * =============================================================================
 *
 * 1.3.4: transient Chat-tab hide API (enterChatHide/exitChatHide) — the mobile
 *   tab router collapses eChan to hide mode while the Chat tab is focused and
 *   restores the user's prior state on any other tab, without persisting.
 *
 * Changes vs 1.3.0:
 *  - LIVE NETWORK REACTIONS via window.__echanBus: stats frames, block,
 *    blockfinal, bigtx, ttf (node-precise), fusion, onchainmsg, watchlist.
 *    Per-route cooldowns + random skip keep eChan from narrating spam.
 *  - TIMELINESS GUARANTEES: 10s boot-grace ignores the history-replay
 *    burst at page load (backfilled blocks/txs/messages are not "news");
 *    block commentary requires strictly-increasing height; queued event
 *    messages carry freshness deadlines and are dropped at display time
 *    if stale — eChan never announces a block that's 4 heights old.
 *  - Whale/shark tiers: ≥1B XEC = whale (event:bigtx), 100M–1B = shark
 *    (event:sharktx). Inline emit floor 100M.
 *  - TREND ENGINE: TPS/TTF-p50 ±25% vs 30-min baseline + new 24h peak.
 *  - GRUMPY PATH: annoyed emotion on slow finality (>4s) and block
 *    droughts (>30 min, escalating).
 *  - SPOTLIGHT: mentioned tx/block/feed cards glow ~5s, display-synced.
 *  - Emotion fallback machinery removed: studying/observing/shy/annoyed
 *    are plain first-class emotions now — pools load from the manifest
 *    like any other; empty pool = avatar keeps current sprite.
 *  - Default chattiness: Chatty. "?" help beside the Chattiness label
 *    expands inline mode descriptions (sourced from MODES map).
 *  - Casual-mode fix: engine-sourced chatter bypasses the priority gate
 *    (cadence already governs volume); markSeen/cooldowns only consumed
 *    on actual display.
 *  - AudioContext autoplay-policy fix: context is only created/resumed
 *    after a real user gesture; sound calls no-op silently before that.
 * =============================================================================
 *
 * Changes vs 1c:
 *  - "Chat mode" label → "Chattiness".
 *  - Mode-aware content tick cadence. Quiet mode now stops the engine
 *    entirely (owner-pushed announcements still flow). Casual cadence is
 *    35-60s. Chatty cadence is 12-22s (was uniform 22-38s across all
 *    modes — so Chatty actually felt slower than its name implied).
 *  - Emotion fallback chain. New emotions studying / observing / shy are
 *    registered; if no sprite art exists for them yet, setEmotion walks
 *    the fallback chain (studying → thinking, observing → neutral, shy →
 *    happy). The intent (line says "studying") is preserved; only the
 *    sprite visual falls back temporarily. Once you ship art and bump
 *    manifest, fallback evaporates automatically.
 *  - Category emotion defaults. seed.json may now declare a
 *    `categoryDefaults` map (e.g. education → studying). Lines with no
 *    `emotion` field inherit the default for their category. Lines with
 *    `emotion` set override the default as before.
 *  - Breathing animation REMOVED. State field, both functions, and the
 *    init/visibility hookup all gone. Idle visual life is entirely
 *    message-driven glitch transitions now.
 *  - Wake-from-sleep: visibility-return fires one immediate content
 *    tick after a 500ms settle delay, so users coming back from sleep
 *    see eChan come alive within ~1s rather than waiting the full
 *    cadence window. contentTick self-schedules so no double-tick.
 *
 * Invariants unchanged: external script, outside CSP, name always
 * "eChan" mixed case.
 * ===========================================================================*/

(function () {
  'use strict';

  /* ===========================================================================
   * CONFIG
   * =========================================================================*/
  const VERSION = '1.3.4';
  const SPRITE_PATH          = './vendor/companion/sprites/';
  const SPRITE_MANIFEST_URL  = './vendor/companion/sprites/manifest.json';
  const SEED_URL             = './vendor/companion/seed.json';

  /* ---- i18n (v1.3.2) ----
   * Dashboard prose is translatable; English titles + technical terms
   * (TPS, TTF, Avalanche, panel headers) stay English by design. Two pack
   * files per language: vendor/i18n/<code>.json = { ui, tooltips } for
   * the dashboard side (tooltips bridge via window.__ecI18n), and
   * vendor/companion/seed.<code>.json = fully translated dialogue. Only
   * the selected pack is fetched; every lookup falls back to English. */
  const I18N_BASE = './vendor/i18n/';
  const SEED_I18N = (code) => './vendor/companion/seed.' + code + '.json';
  /* Order: English first, the rest alphabetical by code. `disp` is the
   * always-2-character badge shown on the 🌐 button and list rows
   * (pt-BR→PT, fil→PH, zh-CN→ZH, zh-TW→TW); native names disambiguate. */
  const I18N_LANGS = [
    { code: 'en',    disp: 'EN', native: 'English' },
    { code: 'de',    disp: 'DE', native: 'Deutsch' },
    { code: 'es',    disp: 'ES', native: 'Español' },
    { code: 'fil',   disp: 'PH', native: 'Filipino' },
    { code: 'fr',    disp: 'FR', native: 'Français' },
    { code: 'id',    disp: 'ID', native: 'Bahasa Indonesia' },
    { code: 'ja',    disp: 'JA', native: '日本語' },
    { code: 'ko',    disp: 'KO', native: '한국어' },
    { code: 'pt-BR', disp: 'PT', native: 'Português (BR)' },
    { code: 'ru',    disp: 'RU', native: 'Русский' },
    { code: 'th',    disp: 'TH', native: 'ไทย' },
    { code: 'tr',    disp: 'TR', native: 'Türkçe' },
    { code: 'uk',    disp: 'UK', native: 'Українська' },
    { code: 'vi',    disp: 'VI', native: 'Tiếng Việt' },
    { code: 'zh-CN', disp: 'ZH', native: '简体中文' },
    { code: 'zh-TW', disp: 'TW', native: '繁體中文' },
  ];
  function langDisp(code) {
    const L = I18N_LANGS.find(l => l.code === code);
    return L ? L.disp : String(code).toUpperCase().slice(0, 2);
  }

  /* English UI strings — single source of truth; packs override by key.
   * The eChan name itself is never translated. */
  const UI_EN = {
    'qa.stats':        'Stats',
    'qa.stats.title':  'Open Network Statistics popover',
    'qa.block':        'Latest block',
    'qa.block.title':  'Open the most recent block popover',
    'qa.media':        'Media center',
    'qa.media.title':  'Open the Media center',
    'qa.tip':          'Tip the project',
    'qa.tip.title':    'Open the tip dialog',
    'qa.guide':        'Guide',
    'qa.guide.title':  'Let eChan walk you through the dashboard',
    'settings.title':  'settings',
    'settings.chattiness': 'Chattiness',
    'settings.sound':  'Sound',
    'settings.help.aria': 'What do the modes mean?',
    'mode.quiet':      'Quiet',
    'mode.quiet.desc': 'Silent — only operator announcements get through.',
    'mode.casual':     'Casual',
    'mode.casual.desc': 'Comments every ~45s; reacts to important events (whales, watchlist, trends).',
    'mode.chatty':     'Chatty',
    'mode.chatty.desc': 'Default — frequent commentary every ~15s + reactions to every event.',
    'chips.tour':      '▶ Show me around',
    'chips.lang':       '🌐 Language',
    'chips.later':     'Later',
    'tour.back':       '⟵ Back',
    'tour.exit':       '✕ Exit tour',
    'tour.done':       "That's the tour 👋 I'll be right here, narrating the chain live.",
    'lang.title':      'Language',
  };

  /* EMOTIONS map — six core sprites + four newer ones (studying, observing,
   * shy, annoyed). All are plain first-class emotions: sprite pools load
   * straight from the manifest like any other. The old fallback-chain
   * machinery ("show thinking while studying art is pending") is gone —
   * if an emotion's pool is empty (art not uploaded yet / manifest 0),
   * setEmotion simply bails and the avatar keeps its current sprite. */
  const EMOTIONS = {
    neutral:   { label: 'Neutral',   idle: true  },
    happy:     { label: 'Happy',     idle: true  },
    thinking:  { label: 'Thinking',  idle: true  },
    alert:     { label: 'Alert',     idle: false },
    celebrate: { label: 'Celebrate', idle: false },
    sleepy:    { label: 'Sleepy',    idle: true  },
    studying:  { label: 'Studying',  idle: true  },
    observing: { label: 'Observing', idle: true  },
    shy:       { label: 'Shy',       idle: false },
    annoyed:   { label: 'Annoyed',   idle: false },
  };
  const EMOTION_KEYS  = Object.keys(EMOTIONS);

  const MODES = {
    quiet:  { label: 'Quiet',  desc: 'Silent — only operator announcements get through.' },
    casual: { label: 'Casual', desc: 'Comments every ~45s; reacts to important events (whales, watchlist, trends).' },
    chatty: { label: 'Chatty', desc: 'Default — frequent commentary every ~15s + reactions to every event.' },
  };
  const DEFAULT_MODE   = 'chatty';

  /* Per-mode content tick intervals [minMs, maxMs] — null = engine off.
   * Quiet truly stops scheduling; owner-pushed messages via
   * window.__echanReceive still display when source==='owner'. */
  const CONTENT_TICK_INTERVAL = {
    quiet:  null,
    casual: [35000, 60000],
    chatty: [12000, 22000],
  };

  const DESKPOS_PERCH  = 'perch';
  const DESKPOS_FOOTER = 'footer';

  const STORAGE = Object.freeze({
    shown:      'ecashlive.echan.shown',
    mode:       'ecashlive.echan.mode',
    deskpos:    'ecashlive.echan.deskpos',
    seen:       'ecashlive.echan.seen',
    visits:     'ecashlive.echan.visits',
    greeted:    'ecashlive.echan.greetedAt',
    statsRing:  'ecashlive.echan.statsring',
    tourDone:    'ecashlive.echan.tourdone',
    tourOffered: 'ecashlive.echan.touroffered',
    lang:        'ecashlive.lang',
    sound:      'ecashlive.echan.sound',
  });
  /* quietUntil joins the legacy list in 1.3.2: the "Quiet for 1 hour"
   * quick-action was replaced by Guide, and a stored mute with no UI to
   * cancel it would strand the user silent. */
  const LEGACY_KEYS = ['ecashlive.echan.dismissed', 'ecashlive.echan.quietUntil'];

  const TYPE_MS_PER_CHAR       = 28;
  const ADVANCE_AUTO_MS        = 7000;
  const ADVANCE_MIN_VISIBLE_MS = 1500;
  const PAGE_DOTS_MAX          = 5;

  const SEEN_RING_MAX          = 200;
  const RECENT_SHOWN_MAX       = 8;        /* anti-repeat: small-pool recency window */
  const IDLE_SHORT_MS          = 4 * 60 * 1000;
  const IDLE_LONG_MS           = 15 * 60 * 1000;
  const GREET_COOLDOWN_MS      = 4 * 60 * 60 * 1000;
  const OPENER_DELAY           = [2500, 4000];   /* refresh opener when greeting suppressed */
  /* ---- v1.3.1: live network event reactions (via window.__echanBus) ----
   * Each route: bus event → seed trigger + gate policy + optional dashboard
   * spotlight selector builder. cooldownMs = min gap between reactions of
   * one type; chance = random keep-probability applied AFTER the cooldown
   * gate (1 = always). The inline module emits everything cheap; eChan
   * decides what's actually worth talking about. txSel/msgSel are hoisted
   * function declarations defined in the EVENT BUS section below. */
  const EVENT_ROUTES = {
    block:      { trigger: 'event:block',        priority: 1, cooldownMs: 10 * 60e3, chance: 0.3,
                  spot: d => '#section-blockchain .block-card[data-height="' + d.height + '"]' },
    blockfinal: { trigger: 'event:blockfinal',   priority: 1, cooldownMs: 0,         chance: 1,
                  spot: d => '#section-blockchain .block-card[data-height="' + d.height + '"]' },
    bigtx:      { trigger: 'event:bigtx',        priority: 2, cooldownMs: 5 * 60e3,  chance: 1,
                  spot: d => txSel(d.txid) },
    sharktx:    { trigger: 'event:sharktx',      priority: 2, cooldownMs: 5 * 60e3,  chance: 1,
                  spot: d => txSel(d.txid) },
    fastttf:    { trigger: 'event:fastttf',      priority: 1, cooldownMs: 15 * 60e3, chance: 1,
                  spot: d => txSel(d.txid) },
    slowttf:    { trigger: 'event:slowttf',      priority: 2, cooldownMs: 15 * 60e3, chance: 1,
                  spot: d => txSel(d.txid) },
    fusion:     { trigger: 'event:fusion',       priority: 1, cooldownMs: 10 * 60e3, chance: 1,
                  spot: d => msgSel(d.txid) },
    watchlist:  { trigger: 'event:watchlist',    priority: 2, cooldownMs: 3 * 60e3,  chance: 1,
                  spot: d => txSel(d.txid) },
    onchainmsg: { trigger: 'event:onchainmsg',   priority: 1, cooldownMs: 10 * 60e3, chance: 0.5,
                  spot: d => msgSel(d.txid) },
    blockdrought: { trigger: 'event:blockdrought', priority: 2, cooldownMs: 0, chance: 1, spot: null },
  };
  const FAST_TTF_MAX_MS  = 300;        /* brag below this */
  const SLOW_TTF_MIN_MS  = 4000;       /* grumble above this */
  const WHALE_XEC        = 1e9;        /* 🐋 whale: ≥1B XEC */
  const SHARK_XEC        = 1e8;        /* 🦈 shark: 100M–1B XEC (inline emits from 100M up) */

  /* ---- Timeliness guards (1.3.1 audit) ----
   * EVENT_BOOT_GRACE_MS: the dashboard backfills recent blocks, txs, and
   * feed messages at page load through the SAME functions that handle
   * live arrivals — so the bus fires a burst of "events" that are
   * actually history. Reacting to those produced bugs like announcing a
   * block 4 heights behind tip. All non-stats events inside the grace
   * window are observed (timestamps, max height) but never spoken.
   *
   * EVENT_STALE_MS: a queued event line can wait behind an active message;
   * if it waits longer than its deadline, the news is no longer news —
   * showNextMessage drops it at display time instead of reading out a
   * stale headline. Trend lines get a long deadline (they describe a
   * 30-min window, aging slowly); drought has none (it stays true). */
  const EVENT_BOOT_GRACE_MS = 10000;

  /* Event cooldowns scale with chattiness (v1.3.2): the base cooldownMs
   * values in EVENT_ROUTES are tuned for Casual; Chatty multiplies them
   * down so a talkative eChan is also a more reactive one. Trend
   * cooldowns scale identically. */
  const EVENT_COOLDOWN_SCALE = { quiet: 1, casual: 1, chatty: 0.4 };
  const EVENT_STALE_MS = {
    block: 90e3, blockfinal: 90e3,
    bigtx: 120e3, sharktx: 120e3,
    fastttf: 120e3, slowttf: 120e3,
    fusion: 120e3, onchainmsg: 120e3, watchlist: 180e3,
    trend: 600e3,
  };
  const BLOCK_DROUGHT_MS = 30 * 60e3;  /* grumble after this long without a block */
  const SPOTLIGHT_MS     = 5000;       /* dashboard card glow duration */

  /* Trend detection over relay stats frames (5s cadence via bus). Frames
   * are downsampled into a ring (1/min, ~40 entries, O(1) memory) and
   * compared now-vs-30-min-ago. Noise floors stop a 0.01→0.02 TPS blip
   * from reading as "+100%". Per-metric cooldown; eval cadence scales
   * with chattiness. */
  const TREND_PCT             = 25;
  const TREND_BASELINE_MS     = 30 * 60e3;
  const TREND_MIN_BASELINE_MS = 20 * 60e3;
  const TREND_COOLDOWN_MS     = 30 * 60e3;
  const TREND_RING_MAX        = 40;
  const TREND_SAMPLE_GAP_MS   = 60e3;
  const TREND_TPS_FLOOR       = 0.2;
  const TREND_TTF_FLOOR_MS    = 50;
  const TREND_EVAL_INTERVAL   = { quiet: null, casual: 5 * 60e3, chatty: 2 * 60e3 };

  /* DOM TPS polling is FALLBACK-ONLY as of 1.3.1 — used when the ttf-feed
   * is down and no stats frames arrive. Interval scales with chattiness. */
  const NETWORK_POLL_INTERVAL = { quiet: null, casual: 30000, chatty: 15000 };
  const STATS_FRESH_MS        = 30000;
  const NETWORK_BUSY_TPS       = 8;
  const NETWORK_QUIET_TPS      = 0.6;
  const QUIET_HOUR_MS          = 60 * 60 * 1000;

  /* Delay between visibility-return and the wake tick. Lets the browser
   * repaint the page first so the dialogue lands feeling smooth. */
  const WAKE_TICK_DELAY_MS     = 500;

  const GLITCH_TOTAL_MS = 320;
  const GLITCH_SWAP_MS  = 140;
  const SPRITE_VARIANT_CAP = 20;

  const SOUND_MASTER_GAIN          = 0.27;
  const SOUND_TYPE_FREQ_BASE_HZ    = 440;
  const SOUND_TYPE_FREQ_JITTER_HZ  = 15;
  const SOUND_TYPE_DUR_MS          = 12;
  const SOUND_TYPE_MIN_INTERVAL_MS = 50;
  const SOUND_ARRIVAL_F1_HZ        = 660;
  const SOUND_ARRIVAL_F2_HZ        = 880;
  const SOUND_ARRIVAL_DUR_MS       = 120;
  const SOUND_GLITCH_DUR_MS        = 80;
  const SOUND_GLITCH_BANDPASS_HZ   = 1200;

  const EASTER_CLICK_COUNT       = 5;
  const EASTER_CLICK_WINDOW_MS   = 1500;
  const EASTER_COOLDOWN_MS       = 30000;

  const FALLBACK_SEED = [
    { id: 'fb-1', category: 'idle', trigger: 'random', priority: 1, emotion: 'thinking', weight: 1, ttlOnce: false,
      text: "I'm eChan — your eCash co-pilot. Seed content failed to load; running in fallback mode. Check /vendor/companion/seed.json." },
    { id: 'fb-2', category: 'idle', trigger: 'random', priority: 1, emotion: 'neutral', weight: 1, ttlOnce: false,
      text: "Still here, just quieter than usual until the content file loads." },
    { id: 'fb-3', category: 'idle', trigger: 'random', priority: 1, emotion: 'sleepy', weight: 1, ttlOnce: false,
      text: "Network's there, I'm here, all is well." },
  ];

  /* ===========================================================================
   * STATE
   * =========================================================================*/
  const state = {
    /* DOM refs */
    root: null, rail: null, body: null,
    avatar: null,
    textHead: null, textBody: null, textCat: null, textAdvance: null,
    railPosToggle: null,
    pageDotsContainer: null,
    settings: null,
    quickActions: null,
    soundBtn: null,
    /* Sprite */
    sprites: {},
    activeSprite: null,
    spriteCounts: null,
    lastVariantIdx: Object.create(null),
    /* Emotion */
    currentEmotion: 'neutral',
    sessFastestMs: Infinity,                /* #4: fastest finality witnessed this session */
    sessBlocks: 0,                          /* #3: real new tips this session */
    sessWhales: 0,                          /* #3: whale tx witnessed this session */
    /* Glitch timers */
    glitchSwapTimer: null,
    glitchEndTimer: null,
    /* Visibility / persistence */
    shown: false,
    mode: DEFAULT_MODE,
    deskpos: DESKPOS_PERCH,
    deskposLocked: false,   /* true while the Media center pins her to the footer */
    soundEnabled: false,
    settingsOpen: false,
    quickActionsOpen: false,
    presenting: false,   /* Media-center lesson narration owns the dialog (presenter mode) */
    mcMediaActive: false, /* true only while a media-center VIDEO is playing (mutes her sound; lessons are exempt) */
    /* Queue / typewriter */
    queue: [],
    activeMessage: null,
    typewriterTimer: null,
    typewriterIndex: 0,
    advanceTimer: null,
    advanceArmedAt: 0,
    /* Resize tracking */
    footerObs: null,
    footerTarget: null,
    /* Doc handlers */
    visHandler: null,
    docClickHandler: null,
    keyHandler: null,
    resizeHandler: null,
    /* Content engine */
    seedLoaded: false,
    seedByTrigger: {},
    langPanelEl: null,
    categoryDefaults: {},      /* category → default emotion name */
    seenIds: null,
    recentShown: [],                        /* anti-repeat: ids of last N shown lines (session) */
    seenPersistTimer: null,                 /* P1: debounce seen-ring localStorage write */
    lastInteraction: Date.now(),
    contentTimer: null,
    wakeTimer: null,                        /* V2: tracked wake-from-hidden content tick */
    quietUntil: 0,                          /* L2/P2: in-memory quiet-hour (debug-only) */
    /* Network polling */
    networkTimer: null,
    lastNetState: 'normal',
    netSeeded: false,                       /* T2/L1: seed net-state on first frame, don't emit */
    /* v1.3.1 — event bus / trends / drought */
    busUnsub: null,
    busSubscribedAt: 0,                     /* boot-grace anchor */
    chronikUp: true,                        /* chronik WS link (gates drought) */
    maxSeenHeight: -1,                      /* monotonic block guard */
    eventLastFireAt: Object.create(null),   /* route key → ts */
    lastCommentedBlock: -1,                 /* pairs blockfinal with block */
    lastBlockAt: Date.now(),                /* seeded at boot — fresh load isn't a drought */
    statsRing: [],                          /* downsampled [{t, tps, ttfP50Ms, sampleCount}] */
    lastStats: null,
    lastStatsAt: 0,
    lastSeenPeak: null,                     /* null until first frame — no reaction on load */
    trendLastFireAt: Object.create(null),   /* metric key → ts */
    trendTimer: null,
    /* v1.3.2 — i18n + tour + chips */
    lang: 'en',
    i18n: null,                             /* loaded pack {ui, tooltips} or null=English */
    tour: { active: false, step: 0, steps: [] },
    tourSpotEl: null,
    chipsEl: null,
    langBtn: null,
    langPop: null,
    langPopOpen: false,
    firstSession: false,        /* true during a visits===0 session */
    settingsPleaDone: false,    /* the don't-mute-me line fires once */
    appliedDomMap: null,        /* domMap of the currently applied pack */
    domObserver: null,
    domObserverTimer: null,
    domApplying: false,
    /* Audio */
    audioCtx: null,
    audioMasterGain: null,
    lastTypeBlipAt: 0,
    userGestured: false,
    /* Easter */
    avatarClickCount: 0,
    avatarClickWindowTimer: null,
    lastEasterFireAt: 0,
  };

  /* ===========================================================================
   * UTILITY
   * =========================================================================*/
  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }
  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class')      e.className = attrs[k];
        else if (k === 'text')  e.textContent = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else                  e.setAttribute(k, attrs[k]);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  /* ===========================================================================
   * SOUND MODULE
   * =========================================================================*/
  /* Autoplay-policy compliance (1.3.1 fix): browsers refuse AudioContext
   * creation/start before a user gesture. With sound persisted ON from a
   * previous session, the first auto-arriving message used to call
   * ensureAudio() pre-gesture → console warning + permanently-suspended
   * context. Now: ensureAudio refuses to construct until a real gesture
   * has happened (capture-phase pointerdown/keydown listeners in init set
   * the flag — capture runs before any click handler, so the sound
   * toggle's own click counts). A suspended context is also resume()d on
   * the next gesture. All play* calls silently no-op until unlocked. */
  function ensureAudio() {
    if (state.audioCtx) {
      // Self-heal: the browser can suspend the context after the initial unlock
      // (reopen browser/bfcache, app-switch, screen lock, idle auto-suspend).
      // Resume it so every play call recovers instead of staying silent.
      if (state.audioCtx.state === 'suspended' && state.userGestured) state.audioCtx.resume().catch(() => {});
      return state.audioCtx;
    }
    if (!state.userGestured) return null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      state.audioCtx = new Ctx();
      state.audioMasterGain = state.audioCtx.createGain();
      state.audioMasterGain.gain.value = SOUND_MASTER_GAIN;
      state.audioMasterGain.connect(state.audioCtx.destination);
    } catch (e) { return null; }
    return state.audioCtx;
  }
  function unlockAudioOnGesture() {
    state.userGestured = true;
    if (state.soundEnabled) {
      const ctx = ensureAudio();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  }
  function canPlaySound() {
    return state.soundEnabled && !isQuietActive() && !state.mcMediaActive;
  }
  function playTypeBlip() {
    if (!canPlaySound()) return;
    const now = performance.now();
    if (now - state.lastTypeBlipAt < SOUND_TYPE_MIN_INTERVAL_MS) return;
    state.lastTypeBlipAt = now;
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = SOUND_TYPE_FREQ_BASE_HZ + (Math.random() - 0.5) * 2 * SOUND_TYPE_FREQ_JITTER_HZ;
    const t = ctx.currentTime;
    const dur = SOUND_TYPE_DUR_MS / 1000;
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(state.audioMasterGain);
    osc.start(t);
    osc.stop(t + dur);
  }
  function playArrival() {
    if (!canPlaySound()) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const t = ctx.currentTime;
    const dur = SOUND_ARRIVAL_DUR_MS / 1000;
    osc.frequency.setValueAtTime(SOUND_ARRIVAL_F1_HZ, t);
    osc.frequency.exponentialRampToValueAtTime(SOUND_ARRIVAL_F2_HZ, t + dur);
    gain.gain.setValueAtTime(0.0, t);
    gain.gain.linearRampToValueAtTime(0.4, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(state.audioMasterGain);
    osc.start(t);
    osc.stop(t + dur);
  }
  function playGlitch() {
    if (!canPlaySound()) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const dur = SOUND_GLITCH_DUR_MS / 1000;
    const bufLen = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = SOUND_GLITCH_BANDPASS_HZ;
    bandpass.Q.value = 2;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(state.audioMasterGain);
    noise.start(t);
    noise.stop(t + dur);
  }
  function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    lsSet(STORAGE.sound, state.soundEnabled ? '1' : '0');
    refreshSoundButton();
    if (state.soundEnabled) {
      ensureAudio();
      playArrival();
    }
  }
  function refreshSoundButton() {
    if (!state.soundBtn) return;
    state.soundBtn.textContent = state.soundEnabled ? 'On' : 'Off';
    state.soundBtn.setAttribute('aria-pressed', String(state.soundEnabled));
  }

  /* ===========================================================================
   * SPRITE MANIFEST
   * =========================================================================*/
  async function loadSpriteManifest() {
    let raw = null;
    try {
      const res = await fetch(SPRITE_MANIFEST_URL, { cache: 'no-cache' });
      if (res.ok) {
        raw = await res.json();
      } else if (res.status !== 404) {
        console.warn('[eChan] sprite manifest fetch failed:', res.status);
      }
    } catch (e) {
      console.warn('[eChan] sprite manifest fetch error:', e && e.message);
    }
    const counts = {};
    const src = (raw && raw.emotions && typeof raw.emotions === 'object') ? raw.emotions : {};
    for (const name of EMOTION_KEYS) {
      const v = Number(src[name]);
      if (Number.isInteger(v) && v >= 0 && v <= SPRITE_VARIANT_CAP) counts[name] = v;
      else                                                          counts[name] = 1;
    }
    state.spriteCounts = counts;
  }

  function spriteFilename(emotion, variantIdx) {
    return (variantIdx === 1)
      ? 'echan_' + emotion + '.webp'
      : 'echan_' + emotion + '_' + variantIdx + '.webp';
  }

  /* ===========================================================================
   * BUILD DOM
   * =========================================================================*/
  function buildDom() {
    const railChev = el('div', { class: 'echan-rail-chev', 'aria-hidden': 'true' });
    const railGear = el('div', {
      class: 'echan-rail-gear',
      role: 'button',
      tabindex: '0',
      'aria-label': 'eChan settings',
      onclick:   (e) => { e.stopPropagation(); toggleSettings(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSettings(); } },
    });
    const railPosToggle = el('div', {
      class: 'echan-rail-postoggle',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Toggle eChan position',
      onclick:   (e) => { e.stopPropagation(); toggleDeskPos(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDeskPos(); } },
    });
    const rail = el('div', {
      class: 'echan-rail',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Toggle eChan dialog',
      onclick:   onRailClick,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
    }, railChev, railGear, railPosToggle);

    const avatar = el('div', {
      class: 'echan-avatar',
      role: 'button',
      tabindex: '0',
      'aria-label': 'eChan quick actions',
      onclick:   onAvatarClick,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleQuickActions(); } },
    });
    state.sprites = {};
    for (const name of EMOTION_KEYS) {
      state.sprites[name] = [];
      const count = (state.spriteCounts && state.spriteCounts[name]) || 0;
      for (let i = 1; i <= count; i++) {
        const filename = spriteFilename(name, i);
        const img = el('img', {
          class: 'echan-sprite',
          src: SPRITE_PATH + filename,
          alt: '',
          'data-emotion': name,
          'data-variant': String(i),
          loading: 'eager',
          decoding: 'async',
          draggable: 'false',
        });
        img.addEventListener('error', () => {
          const pool = state.sprites[name];
          const idx = pool.indexOf(img);
          if (idx !== -1) pool.splice(idx, 1);
          if (img.parentNode) img.parentNode.removeChild(img);
          console.warn('[eChan] sprite missing, removed from pool:', filename);
        }, { once: true });
        avatar.appendChild(img);
        state.sprites[name].push(img);
      }
      state.lastVariantIdx[name] = -1;
    }

    const textHead = el('div', { class: 'echan-text-head' },
      el('span', { class: 'echan-name', text: 'eChan' }),
      el('span', { class: 'echan-chev', text: '›' }),
      el('span', { class: 'echan-cat',  text: '' }),
    );
    const textBody    = el('div', {
      class: 'echan-text-body',
      role: 'status',
      'aria-live': 'polite',
    });
    const textAdvance = el('div', {
      class: 'echan-text-advance',
      'aria-hidden': 'true',
      text: '▶',
    });
    const pageDotsContainer = el('div', {
      class: 'echan-pages',
      'aria-hidden': 'true',
    });
    const text = el('div', {
      class: 'echan-text',
      onclick: onTextClick,
    }, textHead, textBody, textAdvance, pageDotsContainer);

    const quickActions = buildQuickActions();
    const body = el('div', { class: 'echan-body' }, avatar, text, quickActions);
    const settings = buildSettings();
    const root = el('div', { class: 'echan-root' }, rail, body, settings);

    state.root              = root;
    state.rail              = rail;
    state.body              = body;
    state.avatar            = avatar;
    state.textHead          = textHead;
    state.textBody          = textBody;
    state.textCat           = textHead.querySelector('.echan-cat');
    state.textAdvance       = textAdvance;
    state.railPosToggle     = railPosToggle;
    state.pageDotsContainer = pageDotsContainer;
    state.settings          = settings;
    state.quickActions      = quickActions;

    return root;
  }

  function buildSettings() {
    const modeRow = el('div', { class: 'echan-settings-modes' });
    for (const k of ['quiet', 'casual', 'chatty']) {
      const btn = el('button', {
        type: 'button',
        text: t('mode.' + k),
        'data-i18n': 'mode.' + k,
        'data-mode': k,
        onclick: (e) => { e.stopPropagation(); setMode(k); },
      });
      modeRow.appendChild(btn);
    }

    /* "?" help toggle (v1.3.1) — expands an inline panel describing the
     * three modes. Descriptions come straight from MODES so they live in
     * exactly one place. Not persisted; collapses with the popover. */
    const helpBtn = el('button', {
      class: 'echan-settings-help-btn',
      type: 'button',
      'aria-label': t('settings.help.aria'),
      'aria-expanded': 'false',
      text: '?',
    });
    const helpRows = el('div', { class: 'echan-settings-help' });
    for (const k of ['quiet', 'casual', 'chatty']) {
      helpRows.appendChild(el('div', { class: 'echan-settings-help-row' },
        el('span', { class: 'echan-settings-help-name', text: t('mode.' + k),
                     'data-i18n': 'mode.' + k }),
        el('span', { class: 'echan-settings-help-desc', text: t('mode.' + k + '.desc'),
                     'data-i18n': 'mode.' + k + '.desc' }),
      ));
    }

    const soundBtn = el('button', {
      class: 'echan-settings-soundbtn',
      type: 'button',
      text: state.soundEnabled ? 'On' : 'Off',
      'aria-pressed': String(state.soundEnabled),
      onclick: (e) => { e.stopPropagation(); toggleSound(); },
    });
    state.soundBtn = soundBtn;

    const settingsEl = el('div', { class: 'echan-settings', role: 'menu' },
      el('div', { class: 'echan-settings-title', text: t('settings.title'), 'data-i18n': 'settings.title' }),
      el('div', { class: 'echan-settings-row' },
        el('div', { class: 'echan-settings-labelrow' },
          el('div', { class: 'echan-settings-label', text: t('settings.chattiness'), 'data-i18n': 'settings.chattiness' }),
          helpBtn,
        ),
        modeRow,
        helpRows,
      ),
      el('div', { class: 'echan-settings-row echan-settings-row-inline' },
        el('div', { class: 'echan-settings-label', text: t('settings.sound'), 'data-i18n': 'settings.sound' }),
        soundBtn,
      ),
    );
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = settingsEl.classList.toggle('echan-modehelp-open');
      helpBtn.setAttribute('aria-expanded', String(open));
    });
    return settingsEl;
  }

  function buildQuickActions() {
    /* v1.3.2: "Quiet for 1 hour" replaced by "Guide" — the Quiet MODE
     * covers long-term muting, and eChan now owns onboarding. Labels are
     * data-i18n tagged for live language switching. */
    return el('div', { class: 'echan-quickactions', role: 'menu' },
      el('button', { class: 'echan-qa-btn', type: 'button', text: t('qa.stats'),
        'data-i18n': 'qa.stats', 'data-i18n-title': 'qa.stats.title',
        title: t('qa.stats.title'),
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); qaStats(); } }),
      el('button', { class: 'echan-qa-btn', type: 'button', text: t('qa.block'),
        'data-i18n': 'qa.block', 'data-i18n-title': 'qa.block.title',
        title: t('qa.block.title'),
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); qaLatestBlock(); } }),
      el('button', { class: 'echan-qa-btn', type: 'button', text: t('qa.media'),
        'data-i18n': 'qa.media', 'data-i18n-title': 'qa.media.title',
        title: t('qa.media.title'),
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); qaMedia(); } }),
      el('button', { class: 'echan-qa-btn', type: 'button', text: t('qa.tip'),
        'data-i18n': 'qa.tip', 'data-i18n-title': 'qa.tip.title',
        title: t('qa.tip.title'),
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); qaTip(); } }),
      el('button', { class: 'echan-qa-btn', type: 'button', text: t('qa.guide'),
        'data-i18n': 'qa.guide', 'data-i18n-title': 'qa.guide.title',
        title: t('qa.guide.title'),
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); startTour(); } }),
    );
  }

  /* Quick-action: open the Media center external module (vendor/mediacenter/).
   * No-op if that module isn't loaded yet. */
  function qaMedia() {
    try { window.__mediaCenter && window.__mediaCenter.open(); } catch (e) {}
  }

  function onAvatarClick(e) {
    e.stopPropagation();
    /* During the tour the avatar IS the next button — the dialog can be
     * easy to miss as a tap target, the girl herself is not. No menu, no
     * easter counting while guiding. */
    if (state.tour.active) { nextTourStep(); return; }
    toggleQuickActions();
    bumpInteraction();

    state.avatarClickCount++;
    clearTimeout(state.avatarClickWindowTimer);
    state.avatarClickWindowTimer = setTimeout(() => {
      state.avatarClickCount = 0;
    }, EASTER_CLICK_WINDOW_MS);

    if (state.avatarClickCount >= EASTER_CLICK_COUNT) {
      state.avatarClickCount = 0;
      clearTimeout(state.avatarClickWindowTimer);
      const now = Date.now();
      if (now - state.lastEasterFireAt < EASTER_COOLDOWN_MS) return;
      state.lastEasterFireAt = now;
      closeQuickActions();
      triggerEaster();
    }
  }

  function triggerEaster() {
    const pool = (state.seedByTrigger['manual'] || []).filter(l =>
      l.category === 'easter' && isLineEligible(l)
    );
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    /* Easter is user-initiated — treat as engine chatter so it shows in
     * Casual too (it's pri 2 anyway, but the tag makes intent explicit). */
    if (pushMessage({
      id: pick.id,
      category: pick.category,
      priority: 2,
      emotion: resolveEmotionForLine(pick) || 'celebrate',
      text: pick.text,
      source: 'engine',
    })) {
      markSeen(pick.id);
    }
  }

  /* ===========================================================================
   * RESIZE TRACKING
   * =========================================================================*/
  function setupResizeTracking() {
    state.footerTarget = document.querySelector('.footer');
    if (!state.footerTarget) {
      let tries = 0;
      const retry = () => {
        if (++tries > 10) return;
        state.footerTarget = document.querySelector('.footer');
        if (state.footerTarget) {
          wireObs(); update();
          /* I1: match the synchronous path — a late-mounting footer should
           * also update --ec-footer-actual on window resize, not only via
           * the ResizeObserver. */
          if (!state.resizeHandler) {
            state.resizeHandler = update;
            window.addEventListener('resize', state.resizeHandler);
          }
        }
        else setTimeout(retry, 200);
      };
      setTimeout(retry, 200);
      return;
    }
    function update() {
      if (!state.footerTarget) return;
      const h = Math.round(state.footerTarget.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--ec-footer-actual', h + 'px');
    }
    function wireObs() {
      try {
        if (!state.footerObs) {
          state.footerObs = new ResizeObserver(update);
          state.footerObs.observe(state.footerTarget);
        }
      } catch (e) {}
    }
    wireObs();
    update();
    state.resizeHandler = update;
    window.addEventListener('resize', state.resizeHandler);
  }

  /* ===========================================================================
   * SHOW / HIDE / TOGGLE
   * =========================================================================*/
  function show(persist) {
    state.shown = true;
    state.root.classList.add('echan-shown');
    pulseRailOff();
    if (persist !== false) lsSet(STORAGE.shown, '1');
    if (!state.activeMessage && state.queue.length) showNextMessage();
  }
  function hide(persist) {
    state.shown = false;
    state.root.classList.remove('echan-shown');
    closeSettings();
    closeQuickActions();
    if (persist !== false) lsSet(STORAGE.shown, '0');
    stopTypewriter();
  }
  function toggle() { if (state.shown) hide(); else show(); }

  function onRailClick(e) {
    if (e.target.closest('.echan-rail-gear'))      return;
    if (e.target.closest('.echan-rail-postoggle')) return;
    toggle();
  }

  /* ===========================================================================
   * DESKTOP POSITION TOGGLE
   * =========================================================================*/
  function setDeskPos(pos, persist) {
    if (pos !== DESKPOS_PERCH && pos !== DESKPOS_FOOTER) pos = DESKPOS_PERCH;
    state.deskpos = pos;
    if (persist !== false) lsSet(STORAGE.deskpos, pos);
    if (pos === DESKPOS_FOOTER) state.root.classList.add('echan-deskpos-footer');
    else                        state.root.classList.remove('echan-deskpos-footer');
  }
  function toggleDeskPos() {
    /* The Media center pins her to the footer during a lesson and disables the
     * up-toggle; ignore user toggles while locked. */
    if (state.deskposLocked) return;
    setDeskPos(state.deskpos === DESKPOS_FOOTER ? DESKPOS_PERCH : DESKPOS_FOOTER);
  }

  /* ===========================================================================
   * MEDIA-CENTER CONTROL API (window.__echan)
   *
   * The Media center (vendor/mediacenter/) drives eChan's position/visibility
   * through this small imperative surface — NOT through __echanBus, which is
   * display-only text whose emit() swallows errors (see CLAUDE.md §4). Every
   * move here is TRANSIENT (persist:false) so the user's stored deskpos / shown
   * preference is preserved and restored on exitMode().
   *   - enterLessonMode(): keep her visible, drop to the footer, lock the
   *     up-toggle, and elevate her above the media-center dim.
   *   - enterMediaMode():  hide her completely (incl. the rail toggle) for video.
   *   - exitMode():        restore the saved shown + deskpos and clear locks.
   * =========================================================================*/
  let _mcPrior = null;
  function _mcSetPosLockUI(on) {
    if (state.railPosToggle) state.railPosToggle.classList.toggle('echan-postoggle-locked', !!on);
  }
  function mcEnterLessonMode() {
    if (!_mcPrior) _mcPrior = { shown: state.shown, deskpos: state.deskpos };
    if (!state.shown) show();
    setDeskPos(DESKPOS_FOOTER, false);
    state.deskposLocked = true;
    state.mcMediaActive = false;   /* lessons keep her voice — never muted */
    _mcSetPosLockUI(true);
    if (state.root) {
      state.root.classList.add('echan-mc-elevated');
      // Mobile: drop her all the way over the footer to free vertical space (req #11).
      if (window.matchMedia && window.matchMedia('(max-width: 939px)').matches) {
        state.root.classList.add('echan-mc-lesson-mobile');
      }
    }
    presentBegin();   /* lesson narration takes over the dialog */
  }
  function mcEnterMediaMode() {
    if (!_mcPrior) _mcPrior = { shown: state.shown, deskpos: state.deskpos };
    state.mcMediaActive = true;    /* video playing — mute her sound entirely */
    hide();
    if (state.root) state.root.classList.add('echan-mc-hidden');
  }
  function mcExitMode() {
    presentEnd();   /* clear any leftover narration + resume normal chatter */
    state.mcMediaActive = false;
    state.deskposLocked = false;
    _mcSetPosLockUI(false);
    if (state.root) {
      state.root.classList.remove('echan-mc-elevated');
      state.root.classList.remove('echan-mc-hidden');
      state.root.classList.remove('echan-mc-lesson-mobile');
    }
    if (_mcPrior) {
      setDeskPos(_mcPrior.deskpos, false);
      if (_mcPrior.shown) show(); else hide();
      _mcPrior = null;
    }
  }

  /* ---- Transient chat-tab hide (mobile) ------------------------------------
   * The mobile UI collapses eChan to hide mode while the Chat tab is focused
   * and restores the user's prior state on any other tab. Like the media-center
   * moves above, this is TRANSIENT (persist:false) so the stored `shown`
   * preference is never overwritten. Kept on its own `_chatHidePrior` so it can
   * never fight the media center, which owns visibility while active. */
  let _chatHidePrior = null;
  function enterChatHide() {
    if (state.mcMediaActive) return;   /* media center owns visibility */
    if (_chatHidePrior !== null) return;
    _chatHidePrior = state.shown;
    if (state.shown) hide(false);
  }
  function exitChatHide() {
    if (_chatHidePrior === null) return;
    const prior = _chatHidePrior;
    _chatHidePrior = null;
    if (prior && !state.shown && !state.mcMediaActive) show(false);
  }

  /* ---- Presenter mode: lesson narration that BYPASSES the message queue ----
   * presentLine shows a line immediately (interrupting the current one), holdOpen
   * so it stays until the next scene's line. presentBegin/End clear the queue +
   * suppress chatter (see pushMessage/contentTick gates) so nothing mixes in or
   * lingers. Driven by the Media center via window.__echan.presentLine(). */
  function presentBegin() {
    state.presenting = true;
    state.queue = [];
    stopTypewriter();
    clearTimeout(state.advanceTimer);
    clearChips();
    state.activeMessage = null;
    refreshPageDots();
  }
  function presentLine(text, emotion) {
    if (!state.presenting) return;
    if (!state.shown) show();
    stopTypewriter();
    clearTimeout(state.advanceTimer);
    clearChips();
    state.queue = [];
    state.root.classList.remove('echan-pri-3', 'echan-pri-owner');
    state.activeMessage = { text: String(text || ''), emotion: emotion || 'neutral',
      source: 'lesson', category: '', holdOpen: true };
    state.textCat.textContent = '';
    setEmotion(emotion || 'neutral');
    startTypewriter(state.activeMessage.text);
    refreshPageDots();
  }
  function presentEnd() {
    if (!state.presenting) return;
    state.presenting = false;
    state.queue = [];
    stopTypewriter();
    clearTimeout(state.advanceTimer);
    clearChips();
    state.activeMessage = null;
    state.textAdvance.classList.remove('visible');
    state.textCat.textContent = '';
    state.textBody.textContent = '';
    state.root.classList.remove('echan-pri-3', 'echan-pri-owner');
    setEmotion('neutral', { glitch: false });
    refreshPageDots();
    /* Resume chatter PROMPTLY (~2.5-4s) instead of waiting a full cadence gap
     * (~12-22s), so the dialog doesn't sit empty after the lesson closes. Mirrors
     * the wake-opener in init(). Quiet mode (no interval) stays silent. */
    clearTimeout(state.contentTimer);
    if (!document.hidden && CONTENT_TICK_INTERVAL[state.mode]) {
      const d = OPENER_DELAY[0] + Math.random() * (OPENER_DELAY[1] - OPENER_DELAY[0]);
      state.contentTimer = setTimeout(contentTick, d);
    }
  }

  /* NOTE: the media-center control methods are exposed on the EXISTING
   * window.__echan getter installed by publishApi() during init() — see there.
   * A separate `window.__echan = …` here would be silently clobbered by that
   * getter (Object.defineProperty), which is the bug that left the companion
   * dimmed in the media-center lesson mode. Do not re-add an assignment here. */

  /* ===========================================================================
   * SETTINGS POPOVER
   * =========================================================================*/
  function toggleSettings() { state.settingsOpen ? closeSettings() : openSettings(); }
  function openSettings() {
    closeQuickActions();
    state.settingsOpen = true;
    state.root.classList.add('echan-settings-open');
    refreshSettingsActiveMode();
    refreshSoundButton();
  }
  function closeSettings() {
    state.settingsOpen = false;
    state.root.classList.remove('echan-settings-open');
  }
  function refreshSettingsActiveMode() {
    if (!state.settings) return;
    state.settings.querySelectorAll('.echan-settings-modes button')
      .forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
  }
  function setMode(mode) {
    if (!MODES[mode]) return;
    state.mode = mode;
    lsSet(STORAGE.mode, mode);
    refreshSettingsActiveMode();
    if (mode === 'quiet') {
      state.queue = state.queue.filter(m => m.priority >= 3 || m.source === 'owner');
      refreshPageDots();
    }
    /* Restart engine timer at the new cadence (or stop scheduling
     * altogether if the new mode is quiet). scheduleContentTick
     * internally consults CONTENT_TICK_INTERVAL[state.mode]. The
     * fallback poller + trend engine are mode-scaled too (v1.3.1). */
    scheduleContentTick();
    scheduleNetworkPoll();
    scheduleTrendEval();
  }

  /* ===========================================================================
   * QUICK-ACTIONS POPOVER
   * =========================================================================*/
  function toggleQuickActions() {
    state.quickActionsOpen ? closeQuickActions() : openQuickActions();
  }
  function openQuickActions() {
    closeSettings();
    state.quickActionsOpen = true;
    state.root.classList.add('echan-quickactions-open');
  }
  function closeQuickActions() {
    state.quickActionsOpen = false;
    state.root.classList.remove('echan-quickactions-open');
  }

  function qaStats() {
    const cell = document.getElementById('f-tps-cell')
              || document.querySelector('.footer .cell:not(.no-click)');
    if (cell) cell.click();
  }
  function qaLatestBlock() {
    const cards = document.querySelectorAll('#section-blockchain .block-card[data-height]');
    if (!cards.length) return;
    let latest = null, maxH = -1;
    cards.forEach(c => {
      const h = Number(c.dataset.height);
      if (!isNaN(h) && h > maxH) { maxH = h; latest = c; }
    });
    if (latest) latest.click();
  }
  function qaTip() {
    const btn = document.getElementById('tip-btn');
    if (btn) btn.click();
  }
  /* Debug-only (no UI binding): mute non-owner chatter for ~an hour.
   * In-memory only — see isQuietActive. */
  function qaQuietHour() {
    state.quietUntil = Date.now() + QUIET_HOUR_MS;
    state.queue = state.queue.filter(m => m.priority >= 3 || m.source === 'owner');
    refreshPageDots();
    hide();
  }
  function isQuietActive() {
    /* P2/L2: in-memory only. quiet-hour has no UI (debug-only, via
     * __echan.qa.quietHour); reading from state avoids a localStorage hit
     * on every gate check, and not persisting it means it can't survive —
     * nor be silently wiped by — a reload (the old persisted path was a
     * no-op because quietUntil is in LEGACY_KEYS and cleared at init). */
    return state.quietUntil > Date.now();
  }

  /* ===========================================================================
   * EMOTION SWITCHING + FALLBACK CHAIN
   *
   * setEmotion(name, opts):
   *   opts.glitch  — boolean, default true (skip for passive changes)
   *   opts.variant — optional 0-based variant idx (force pick)
   *
   * Fallback resolution:
   *   If the requested emotion's sprite pool is empty (e.g. studying has
   *   no art yet), walk EMOTIONS[name].fallback until a non-empty pool
   *   is found. The variant pick + lastVariantIdx tracking use the
   *   RESOLVED name (so we correctly remember "we just showed thinking
   *   variant 2 as a fallback for studying"). state.currentEmotion uses
   *   the REQUESTED name (so dialogue intent is preserved).
   *
   *   When you ship real art (echan_studying.webp + manifest count 1+),
   *   the studying pool becomes non-empty and the fallback chain
   *   short-circuits automatically. No code change needed.
   * =========================================================================*/
  function setEmotion(name, opts) {
    opts = opts || {};
    if (!EMOTIONS[name]) name = 'neutral';
    const pool = state.sprites[name];
    if (!pool || !pool.length) return;   /* unknown sprite — silent bail */

    let idx = 0;
    if (typeof opts.variant === 'number' && opts.variant >= 0 && opts.variant < pool.length) {
      idx = opts.variant;
    } else if (pool.length > 1) {
      const last = state.lastVariantIdx[name];
      do { idx = Math.floor(Math.random() * pool.length); }
      while (idx === last);
    }
    state.lastVariantIdx[name] = idx;

    const next = pool[idx];
    const prev = state.activeSprite;
    if (next === prev) {
      state.currentEmotion = name;
      return;
    }

    state.currentEmotion = name;

    if (state.glitchSwapTimer) { clearTimeout(state.glitchSwapTimer); state.glitchSwapTimer = null; }
    if (state.glitchEndTimer)  { clearTimeout(state.glitchEndTimer);  state.glitchEndTimer  = null; }

    const wantGlitch = (opts.glitch !== false) && !prefersReducedMotion() && state.avatar;

    if (wantGlitch) {
      state.avatar.classList.remove('echan-glitching');
      // eslint-disable-next-line no-unused-expressions
      void state.avatar.offsetWidth;
      state.avatar.classList.add('echan-glitching');
      playGlitch();

      state.glitchSwapTimer = setTimeout(() => {
        if (next) next.classList.add('active');
        if (prev) prev.classList.remove('active');
        state.activeSprite = next;
        state.glitchSwapTimer = null;
      }, GLITCH_SWAP_MS);

      state.glitchEndTimer = setTimeout(() => {
        if (state.avatar) state.avatar.classList.remove('echan-glitching');
        state.glitchEndTimer = null;
      }, GLITCH_TOTAL_MS);
    } else {
      if (state.avatar) state.avatar.classList.remove('echan-glitching');
      if (next) next.classList.add('active');
      if (prev) prev.classList.remove('active');
      state.activeSprite = next;
    }
  }

  /* ===========================================================================
   * EMOTION RESOLVER — line → emotion name
   *
   * Order of precedence:
   *   1. line.emotion (explicit per-line override)
   *   2. state.categoryDefaults[line.category] (seed.json category default)
   *   3. 'neutral' (final fallback)
   *
   * Used by every place that pulls a line from seed and pushes it as a
   * message: maybeGreet, contentTick, pollNetwork, triggerEaster.
   * =========================================================================*/
  function resolveEmotionForLine(line) {
    if (!line) return 'neutral';
    if (line.emotion && EMOTIONS[line.emotion]) return line.emotion;
    if (line.category && state.categoryDefaults && state.categoryDefaults[line.category]) {
      const def = state.categoryDefaults[line.category];
      if (EMOTIONS[def]) return def;
    }
    return 'neutral';
  }

  /* ===========================================================================
   * MESSAGE QUEUE + TYPEWRITER
   * =========================================================================*/
  /* Returns true if the message was accepted (queued or displayed), false
   * if a mode/quiet gate dropped it — callers MUST gate markSeen() and
   * cooldown bookkeeping on this, otherwise dropped lines pollute the
   * seen-ring and consume greeting/event cooldowns invisibly (the 1.3.1
   * casual-mode silence bug).
   *
   * Gate semantics (fixed in 1.3.1):
   *  - quiet:  only priority 3 / owner — engine is off anyway.
   *  - casual: priority ≥2 for EVENTS/feed pushes, but engine-sourced
   *    chatter (content tick, greetings) is exempt — its volume is already
   *    governed by the mode's 35-60s cadence. Without the exemption, the
   *    70-of-90 seed lines at priority 1 never displayed in casual at all.
   *  - chatty: everything. */
  function pushMessage(msg) {
    /* Presenter mode (Media-center lesson narration) owns the dialog — drop all
     * normal/engine/event/owner chatter so it can't mix in or pile up behind. */
    if (state.presenting && (!msg || msg.source !== 'lesson')) return false;
    /* Tour owns the dialog: engine/event messages are dropped (returning
     * false keeps cooldowns + seen-ring untouched); owner announcements
     * queue silently and surface right after the tour. */
    if (state.tour.active) {
      if (msg.source === 'owner') { state.queue.push(msg); return true; }
      return false;
    }
    if (isQuietActive() && msg.source !== 'owner') return false;
    if (state.mode === 'quiet'  && msg.priority < 3 && msg.source !== 'owner') return false;
    if (state.mode === 'casual' && msg.priority < 2 && msg.source !== 'engine' && msg.source !== 'owner') return false;
    state.queue.push(msg);
    state.queue.sort((a, b) => (b.priority || 1) - (a.priority || 1));
    refreshPageDots();
    if (state.shown && !state.activeMessage) showNextMessage();
    else if (!state.shown && msg.priority >= 3) pulseRailOn();
    return true;
  }

  /* A queued event message goes stale when its deadline passes or its
   * route-specific check fires (e.g. a newer block has been seen). Stale
   * news is silently skipped at dequeue — better to say nothing than to
   * announce a block that's 4 heights behind tip. */
  function isMsgStale(m) {
    if (!m) return false;
    if (m.eventAt && m.staleAfterMs && Date.now() - m.eventAt > m.staleAfterMs) return true;
    if (typeof m.staleCheck === 'function') {
      try { return !!m.staleCheck(); } catch (e) { return false; }
    }
    return false;
  }

  function showNextMessage() {
    let msg = state.queue.shift();
    while (msg && isMsgStale(msg)) msg = state.queue.shift();
    if (!msg) { state.activeMessage = null; refreshPageDots(); return; }
    state.activeMessage = msg;

    state.root.classList.remove('echan-pri-3', 'echan-pri-owner');
    if (msg.source === 'owner')      state.root.classList.add('echan-pri-owner');
    else if (msg.priority >= 3)      state.root.classList.add('echan-pri-3');

    state.textCat.textContent = msg.category ? '· ' + msg.category : '';
    setEmotion(msg.emotion || 'neutral');
    playArrival();
    /* v1.3.1: glow the dashboard card this message refers to (if any and
     * if it's still in the DOM). Display-time trigger keeps glow + words
     * synchronized even when the message waited in the queue. */
    if (msg.spotlight) spotlightCard(msg.spotlight);

    /* Chip prompts (v1.3.2 — e.g. the first-visit tour offer): render the
     * tappable choices and mark the offer as made so it never re-asks. */
    if (msg.chips) {
      showChips(msg.chips);
      if (msg.offerFlag) lsSet(msg.offerFlag, '1');
    } else {
      clearChips();
    }
    if (msg.attract) addAttract();

    startTypewriter(msg.text || '');
    refreshPageDots();
  }

  function startTypewriter(text) {
    stopTypewriter();
    state.typewriterIndex = 0;
    state.textBody.textContent = '';
    /* Reset scroll position when a new message starts so long-text
     * messages always begin at the top. */
    state.textBody.scrollTop = 0;
    /* M2: mark the live region busy while characters stream in so screen
     * readers announce the settled text once, not partial/repeated states.
     * Cleared in armAdvance, which both the reduced-motion and normal
     * completion paths reach. */
    state.textBody.setAttribute('aria-busy', 'true');
    if (prefersReducedMotion()) {
      state.textBody.textContent = text;
      armAdvance();
      return;
    }
    const tick = () => {
      if (state.typewriterIndex >= text.length) { armAdvance(); return; }
      const ch = text.charAt(state.typewriterIndex);
      state.textBody.textContent = text.slice(0, ++state.typewriterIndex);
      if (ch && ch.trim().length) playTypeBlip();
      state.typewriterTimer = setTimeout(tick, TYPE_MS_PER_CHAR);
    };
    tick();
  }
  function stopTypewriter() {
    if (state.typewriterTimer) { clearTimeout(state.typewriterTimer); state.typewriterTimer = null; }
  }
  function finishTypewriter() {
    if (!state.activeMessage) return;
    stopTypewriter();
    state.textBody.textContent = state.activeMessage.text || '';
    state.typewriterIndex = (state.activeMessage.text || '').length;
    armAdvance();
  }
  function armAdvance() {
    state.advanceArmedAt = Date.now();
    state.textBody.setAttribute('aria-busy', 'false');   /* M2: typing done */
    state.textAdvance.classList.add('visible');
    clearTimeout(state.advanceTimer);
    /* holdOpen (tour steps, chip prompts): wait for the user, no timer. */
    if (state.activeMessage && state.activeMessage.holdOpen) return;
    const dwell = (state.activeMessage && state.activeMessage.dwellMs) || ADVANCE_AUTO_MS;
    state.advanceTimer = setTimeout(advance, dwell);
  }
  function advance() {
    clearTimeout(state.advanceTimer);
    clearChips();
    state.textAdvance.classList.remove('visible');
    state.root.classList.remove('echan-pri-3', 'echan-pri-owner');
    state.activeMessage = null;
    if (state.queue.length) showNextMessage();
    else {
      setEmotion('neutral', { glitch: false });
      state.textCat.textContent = '';
      refreshPageDots();
    }
  }

  function onTextClick() {
    if (!state.activeMessage) return;
    if (state.typewriterTimer) { finishTypewriter(); return; }
    if (state.tour.active) {
      if (Date.now() - state.advanceArmedAt >= ADVANCE_MIN_VISIBLE_MS) nextTourStep();
      return;
    }
    /* Chip prompts (welcome offers) only resolve through a chip tap —
     * a stray dialog tap must not dismiss the one-time decision. */
    if (state.activeMessage.holdOpen) return;
    if (Date.now() - state.advanceArmedAt >= ADVANCE_MIN_VISIBLE_MS) advance();
  }

  /* ===========================================================================
   * PAGE DOTS
   * =========================================================================*/
  function refreshPageDots() {
    const c = state.pageDotsContainer;
    if (!c) return;
    const total = (state.activeMessage ? 1 : 0) + state.queue.length;
    if (total <= 1) {
      c.classList.remove('visible');
      c.innerHTML = '';
      return;
    }
    c.classList.add('visible');
    c.innerHTML = '';
    const visible = Math.min(total, PAGE_DOTS_MAX);
    for (let i = 0; i < visible; i++) {
      const dot = el('span', { class: 'echan-page-dot' });
      if (i === 0 && state.activeMessage) dot.classList.add('active');
      c.appendChild(dot);
    }
    if (total > PAGE_DOTS_MAX) {
      c.appendChild(el('span', { class: 'echan-pages-more', text: '+' + (total - PAGE_DOTS_MAX) }));
    }
  }

  /* ===========================================================================
   * RAIL PULSE
   * =========================================================================*/
  function pulseRailOn() {
    if (!state.rail) return;
    state.rail.classList.add('echan-rail-pulse-on');
  }
  function pulseRailOff() {
    if (!state.rail) return;
    state.rail.classList.remove('echan-rail-pulse-on');
  }

  /* ===========================================================================
   * CONTENT ENGINE
   * =========================================================================*/
  /* ===========================================================================
   * I18N RUNTIME (v1.3.2)
   * =========================================================================*/
  function t(key, fallback) {
    const pack = state.i18n;
    if (pack && pack.ui && typeof pack.ui[key] === 'string') return pack.ui[key];
    if (UI_EN[key] !== undefined) return UI_EN[key];
    return (fallback !== undefined) ? fallback : key;
  }

  async function loadLangPack(code) {
    if (!code || code === 'en') { state.i18n = null; return; }
    try {
      const res = await fetch(I18N_BASE + code + '.json', { cache: 'no-cache' });
      state.i18n = res.ok ? await res.json() : null;
      if (!res.ok) console.warn('[eChan] lang pack fetch failed:', code, res.status);
    } catch (e) {
      state.i18n = null;
      console.warn('[eChan] lang pack fetch error:', code, e && e.message);
    }
  }

  async function setLanguage(code) {
    if (!I18N_LANGS.some(l => l.code === code)) return;
    state.lang = code;
    lsSet(STORAGE.lang, code);
    try { document.documentElement.lang = code; } catch (e) {}
    await loadLangPack(code);
    await loadSeed();            /* dialogue re-fetched in the new language */
    refreshUiTexts();
    if (state.langBtn) {
      const c = state.langBtn.querySelector('.echan-lang-code');
      if (c) c.textContent = langDisp(code);
    }
    applyDomI18n();
    startDomI18nObserver();
    closeLangPopover();
  }

  /* Re-applies translated strings to everything built with data-i18n /
   * data-i18n-title markers. Live apply — no reload needed. */
  function refreshUiTexts() {
    if (!state.root) return;
    state.root.querySelectorAll('[data-i18n]').forEach(n => {
      n.textContent = t(n.getAttribute('data-i18n'));
    });
    state.root.querySelectorAll('[data-i18n-title]').forEach(n => {
      n.title = t(n.getAttribute('data-i18n-title'));
    });
    if (state.langBtn) state.langBtn.title = t('lang.title');
  }

  /* Bridge consumed by the inline module's showTooltip/showStackedTooltip
   * hooks (see index v1.3.2): translated tooltip {title, body} by key, or
   * null → English TOOLTIP_CONTENT fallback. */
  function publishI18nBridge() {
    window.__ecI18n = {
      lang: () => state.lang,
      tooltip: (key) => {
        const p = state.i18n;
        if (p && p.tooltips && p.tooltips[key]
            && typeof p.tooltips[key].title === 'string'
            && typeof p.tooltips[key].body === 'string') {
          return p.tooltips[key];
        }
        return null;
      },
    };
  }

  /* ===========================================================================
   * DASHBOARD DOM TRANSLATION (v1.3.2)
   *
   * Packs may carry two extra sections beyond ui/tooltips:
   *   dom:    { "selector": { text?, html?, title?, placeholder? } } —
   *           static strings (gray helper hints, hover titles,
   *           placeholders, info-tile popovers). `text` replaces the
   *           element's LAST text node so icon/dot spans survive; `html`
   *           replaces innerHTML for rich content (only pack-authored
   *           markup — same trust level as the tooltip bodies). Originals
   *           cached in data-ec-orig-* for revert; data-ec-html-lang
   *           marks applied language for idempotency (innerHTML
   *           round-trips are browser-normalized, so equality checks
   *           can't be trusted for loop prevention).
   *   domMap: { "selector": { "EN VALUE": "translated", ... } } — value-
   *           mapped, for labels the inline JS rewrites at runtime (e.g.
   *           the LIVE→CHAIN→FEED view toggle). Idempotent by matching.
   * A debounced MutationObserver re-applies forward translations when the
   * dashboard re-renders translated regions (active only when lang≠en).
   * English titles + technical terms are deliberately NOT in packs.
   * =========================================================================*/
  function lastTextNode(el) {
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      const n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim()) return n;
    }
    return null;
  }

  function applyDomI18n() {
    state.domApplying = true;
    try {
      /* full restore first — handles switching pack→pack and pack→en */
      document.querySelectorAll('[data-ec-orig-text]').forEach(el => {
        const n = lastTextNode(el);
        if (n) n.textContent = el.getAttribute('data-ec-orig-text');
      });
      document.querySelectorAll('[data-ec-orig-html]').forEach(el => {
        el.innerHTML = el.getAttribute('data-ec-orig-html');
        el.removeAttribute('data-ec-html-lang');
      });
      document.querySelectorAll('[data-ec-orig-title]').forEach(el => {
        el.title = el.getAttribute('data-ec-orig-title');
      });
      document.querySelectorAll('[data-ec-orig-warn]').forEach(el => {
        el.setAttribute('data-warn', el.getAttribute('data-ec-orig-warn'));
      });
      document.querySelectorAll('[data-ec-orig-ph]').forEach(el => {
        el.placeholder = el.getAttribute('data-ec-orig-ph');
      });
      revertDomMap();
      applyDomForward();
    } finally {
      state.domApplying = false;
    }
  }

  /* L3: defence-in-depth for first-party i18n packs. CSP (script-src 'self'
   * '<hash>', no unsafe-inline) already blocks inline-handler execution and
   * packs are first-party — but innerHTML is the one sink where markup-shaped
   * data lands, so strip <script>/<style> elements and on* handler attributes
   * before assigning. Structural/style markup the packs legitimately use
   * (ul/li/strong/code/span[class|style]/p/b) passes through untouched. */
  function sanitizeForwardHtml(str) {
    try {
      const tpl = document.createElement('template');
      tpl.innerHTML = String(str);
      tpl.content.querySelectorAll('script, style').forEach(n => n.remove());
      tpl.content.querySelectorAll('*').forEach(node => {
        for (const a of Array.from(node.attributes)) {
          if (a.name.toLowerCase().indexOf('on') === 0) node.removeAttribute(a.name);
        }
      });
      return tpl.innerHTML;
    } catch (e) { return ''; }
  }

  function applyDomForward() {
    const pack = state.i18n;
    if (!pack) return;
    state.domApplying = true;
    try {
      const dom = pack.dom || {};
      for (const sel in dom) {
        let els; try { els = document.querySelectorAll(sel); } catch (e) { continue; }
        els.forEach(el => {
          const d = dom[sel];
          if (typeof d.text === 'string') {
            const n = lastTextNode(el);
            if (n && n.textContent !== d.text) {
              if (!el.hasAttribute('data-ec-orig-text')) el.setAttribute('data-ec-orig-text', n.textContent);
              n.textContent = d.text;
            }
          }
          if (typeof d.html === 'string'
              && el.getAttribute('data-ec-html-lang') !== state.lang) {
            if (!el.hasAttribute('data-ec-orig-html')) el.setAttribute('data-ec-orig-html', el.innerHTML);
            el.innerHTML = sanitizeForwardHtml(d.html);
            el.setAttribute('data-ec-html-lang', state.lang);
          }
          if (typeof d.title === 'string' && el.title !== d.title) {
            if (!el.hasAttribute('data-ec-orig-title')) el.setAttribute('data-ec-orig-title', el.title);
            el.title = d.title;
          }
          if (typeof d.placeholder === 'string' && 'placeholder' in el && el.placeholder !== d.placeholder) {
            if (!el.hasAttribute('data-ec-orig-ph')) el.setAttribute('data-ec-orig-ph', el.placeholder);
            el.placeholder = d.placeholder;
          }
          /* "warn" rewrites data-warn — the page renders it as a pure-CSS
           * hover tooltip via content: attr(data-warn) */
          if (typeof d.warn === 'string' && el.getAttribute('data-warn') !== d.warn) {
            if (!el.hasAttribute('data-ec-orig-warn')) el.setAttribute('data-ec-orig-warn', el.getAttribute('data-warn') || '');
            el.setAttribute('data-warn', d.warn);
          }
        });
      }
      const tmap = pack.titleMap || null;
      if (tmap) {
        document.querySelectorAll('[title]').forEach(el => {
          const cur = el.getAttribute('title');
          const tr = tmap[cur];
          if (tr !== undefined && tr !== cur) {
            /* refresh the cached original every time — JS may have
             * toggled the title to a different English state since the
             * last pass, and restore must return to the CURRENT state */
            el.setAttribute('data-ec-orig-title', cur);
            el.title = tr;
          }
        });
      }
      const map = pack.domMap || null;
      state.appliedDomMap = map;
      if (map) {
        for (const sel in map) {
          let els; try { els = document.querySelectorAll(sel); } catch (e) { continue; }
          els.forEach(el => {
            const n = lastTextNode(el);
            if (!n) return;
            const cur = n.textContent.trim();
            if (map[sel][cur] !== undefined) n.textContent = map[sel][cur];
          });
        }
      }
    } finally {
      state.domApplying = false;
    }
  }

  function revertDomMap() {
    const prev = state.appliedDomMap;
    if (!prev) return;
    for (const sel in prev) {
      let els; try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      const rev = {};
      for (const k in prev[sel]) rev[prev[sel][k]] = k;
      els.forEach(el => {
        const n = lastTextNode(el);
        if (!n) return;
        const cur = n.textContent.trim();
        if (rev[cur] !== undefined) n.textContent = rev[cur];
      });
    }
    state.appliedDomMap = null;
  }

  function startDomI18nObserver() {
    stopDomI18nObserver();
    const p = state.i18n;
    if (!p || (!p.dom && !p.domMap && !p.titleMap)) return;
    state.domObserver = new MutationObserver((muts) => {
      if (state.domApplying) return;
      /* P3: ignore the companion's own DOM churn. The typewriter rewrites
       * textContent once per character; without this, every dialogue char
       * (lang≠en) would schedule a full re-translation sweep over the whole
       * document. The packs never target the companion subtree, so a batch
       * confined to it is safe to skip. */
      if (state.root && muts.every(m => state.root.contains(m.target))) return;
      clearTimeout(state.domObserverTimer);
      state.domObserverTimer = setTimeout(applyDomForward, 300);
    });
    state.domObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['title'],
    });
  }
  function stopDomI18nObserver() {
    if (state.domObserver) { try { state.domObserver.disconnect(); } catch (e) {} }
    state.domObserver = null;
    clearTimeout(state.domObserverTimer);
  }

  /* ---- Language button (🌐), injected into the dashboard ctrl bar ----
   * Injection instead of inline HTML keeps the index diff at zero for
   * this feature; the old #btn-guide is hidden via echan.css (its modal
   * stays in code, reachable from devtools). */
  function injectLangButton() {
    const tipBtn = document.getElementById('tip-btn');
    const host = tipBtn && tipBtn.parentElement;
    if (!host) return;
    const btn = el('button', {
      class: 'ctrl-btn echan-lang-ctrl', id: 'btn-echan-lang', type: 'button',
      title: t('lang.title'), 'aria-haspopup': 'true', 'aria-expanded': 'false',
      onclick: (e) => { e.stopPropagation(); toggleLangPopover(); } },
      el('span', { class: 'echan-lang-globe', text: '🌐' }),
      el('span', { class: 'echan-lang-code', text: langDisp(state.lang) }),
    );
    host.insertBefore(btn, tipBtn);
    state.langBtn = btn;
  }

  function toggleLangPopover() {
    if (state.langPopOpen) closeLangPopover(); else openLangPopover();
  }
  function openLangPopover() {
    closeLangPopover();
    if (!state.langBtn) return;
    const rows = I18N_LANGS.map(L => el('button', {
      class: 'echan-langpop-row' + (L.code === state.lang ? ' active' : ''),
      type: 'button',
      onclick: (e) => { e.stopPropagation(); setLanguage(L.code); } },
      el('span', { class: 'echan-langpop-code', text: L.disp }),
      el('span', { class: 'echan-langpop-native', text: L.native }),
    ));
    const pop = el('div', { class: 'echan-langpop', role: 'menu', 'aria-label': 'Language' }, ...rows);
    document.body.appendChild(pop);
    const r = state.langBtn.getBoundingClientRect();
    pop.style.right  = Math.max(8, window.innerWidth - r.right) + 'px';
    pop.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
    state.langPop = pop;
    state.langPopOpen = true;
    state.langBtn.setAttribute('aria-expanded', 'true');
  }
  function closeLangPopover() {
    if (state.langPop) { try { state.langPop.remove(); } catch (e) {} }
    state.langPop = null;
    state.langPopOpen = false;
    if (state.langBtn) state.langBtn.setAttribute('aria-expanded', 'false');
  }

  /* Seed loader is language-aware (v1.3.2): seed.<lang>.json first, then
   * the English seed.json — a missing or broken translation degrades to
   * English, never to silence. */
  async function loadSeed() {
    const tryFetch = async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        return res.ok ? await res.json() : null;
      } catch (e) { return null; }
    };
    let data = null;
    if (state.lang && state.lang !== 'en') data = await tryFetch(SEED_I18N(state.lang));
    if (!data) data = await tryFetch(SEED_URL);
    if (!data) console.warn('[eChan] seed fetch failed (incl. English fallback)');
    let lines = (data && Array.isArray(data.lines)) ? data.lines : null;
    if (!lines || !lines.length) {
      console.warn('[eChan] using fallback seed (in-code, 3 lines)');
      lines = FALLBACK_SEED;
    }
    /* categoryDefaults is optional — empty object if missing, which makes
     * resolveEmotionForLine fall straight through to 'neutral'. */
    state.categoryDefaults = (data && data.categoryDefaults && typeof data.categoryDefaults === 'object')
      ? data.categoryDefaults
      : {};
    buildSeedIndex(lines);
    state.seedLoaded = true;
  }

  function buildSeedIndex(lines) {
    const byTrig = {};
    for (const line of lines) {
      if (!line || !line.id || !line.trigger || !line.text) continue;
      (byTrig[line.trigger] = byTrig[line.trigger] || []).push(line);
    }
    state.seedByTrigger = byTrig;
  }

  function loadSeenRing() {
    try {
      const raw = lsGet(STORAGE.seen, '');
      if (!raw) return new Set();
      return new Set(String(raw).split(',').filter(Boolean));
    } catch (e) { return new Set(); }
  }
  function flushSeenRing() {
    clearTimeout(state.seenPersistTimer);
    state.seenPersistTimer = null;
    try {
      const arr = Array.from(state.seenIds);
      while (arr.length > SEEN_RING_MAX) arr.shift();
      lsSet(STORAGE.seen, arr.join(','));
    } catch (e) {}
  }
  /* P1: coalesce the per-line localStorage write. markSeen fires on every
   * accepted message (~every 15s in Chatty, plus one per event); debounce
   * the serialize+write and flush on hide/pagehide so nothing is lost. */
  function persistSeenRing() {
    if (state.seenPersistTimer) return;
    state.seenPersistTimer = setTimeout(flushSeenRing, 1000);
  }
  function markSeen(id) {
    if (!id || !state.seenIds) return;
    if (state.seenIds.has(id)) state.seenIds.delete(id);
    state.seenIds.add(id);
    while (state.seenIds.size > SEEN_RING_MAX) {
      const first = state.seenIds.values().next().value;
      state.seenIds.delete(first);
    }
    /* Anti-repeat recency deque (session-only, not persisted). */
    const rs = state.recentShown;
    const ix = rs.indexOf(id);
    if (ix !== -1) rs.splice(ix, 1);
    rs.push(id);
    while (rs.length > RECENT_SHOWN_MAX) rs.shift();
    persistSeenRing();
  }

  /* Optional per-line `requires` condition — checked against LIVE state at
   * pick time so eChan never claims a network condition that isn't true
   * right now (e.g. "calm chain" mid-spike). Unknown values pass open so a
   * seed typo degrades to "always eligible" rather than muting a line. */
  function lineRequirementMet(req) {
    switch (req) {
      case 'net:quiet':   return state.lastNetState === 'quiet';
      case 'net:busy':    return state.lastNetState === 'busy';
      case 'net:notbusy': return state.lastNetState !== 'busy';
      case 'feed:up':     return (Date.now() - state.lastStatsAt) < STATS_FRESH_MS;
      default:            return true;
    }
  }

  function isLineEligible(line) {
    if (!line) return false;
    if (line.ttlOnce && state.seenIds && state.seenIds.has(line.id)) return false;
    if (line.requires && !lineRequirementMet(line.requires)) return false;
    return true;
  }

  function weightedPick(candidates) {
    if (!candidates || !candidates.length) return null;
    /* Anti-repeat (recency): when the pool allows, drop ids shown in the
     * last RECENT_SHOWN_MAX messages. Hard exclusion, independent of the
     * 200-ring's 0.33 soft penalty, so small pools (events/time/network)
     * can't collapse to uniform-random once every line is already in the
     * ring. Never empties the pool: if exclusion removes everything, fall
     * back to avoiding just the single most-recent id, then to all. */
    if (candidates.length > 1 && state.recentShown.length) {
      const recent = state.recentShown;
      let narrowed = candidates.filter(c => recent.indexOf(c.id) === -1);
      if (!narrowed.length) {
        const lastId = recent[recent.length - 1];
        narrowed = candidates.filter(c => c.id !== lastId);
        if (!narrowed.length) narrowed = candidates;
      }
      candidates = narrowed;
    }
    const weighted = candidates.map(c => {
      const w = (c.weight || 1) * (state.seenIds && state.seenIds.has(c.id) ? 0.33 : 1.0);
      return { line: c, weight: w };
    });
    const total = weighted.reduce((s, w) => s + w.weight, 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (const w of weighted) {
      r -= w.weight;
      if (r <= 0) return w.line;
    }
    return weighted[weighted.length - 1].line;
  }

  function getTimeBucket() {
    const h = new Date().getHours();
    if (h >= 5  && h < 12) return 'morning';
    if (h >= 12 && h < 18) return 'afternoon';
    if (h >= 18 && h < 22) return 'evening';
    return 'night';
  }

  /* Guide-offer chips for the first-visit welcome. attract stays ON
   * through the whole offer; only the guide decision clears it. */
  function decorateWelcomeWithGuideChips(msg) {
    msg.holdOpen = true;
    msg.attract = true;
    msg.offerFlag = STORAGE.tourOffered;
    msg.chips = [
      { label: t('chips.tour'), primary: true,
        onTap: () => { clearChips(); startTour(); } },
      { label: t('chips.later'),
        onTap: () => { removeAttract(); clearChips(); advance(); queueSettingsPlea(); } },
      { label: t('chips.lang'),
        onTap: () => openLangPanel() },
    ];
  }

  /* v1.3.3: the language choice lives INSIDE the welcome — a 🌐 chip next
   * to "Later". Tapping it opens an overlay covering the whole text frame
   * (the avatar stays visible). Pick a language → panel closes → the
   * welcome re-runs in that language. ✕ just closes; the original welcome
   * chips sit untouched underneath. */
  function openLangPanel() {
    closeLangPanel();
    const frame = state.textBody && state.textBody.closest('.echan-text');
    if (!frame) return;
    const panel = el('div', {
      class: 'echan-lang-panel',
      /* swallow clicks so the welcome behind it never advances */
      onclick: (e) => e.stopPropagation(),
    });
    panel.appendChild(el('button', {
      class: 'echan-lang-panel-close', type: 'button', text: '✕',
      'aria-label': 'Close',
      onclick: (e) => { e.stopPropagation(); closeLangPanel(); },
    }));
    panel.appendChild(el('div', { class: 'echan-lang-panel-grid' },
      ...I18N_LANGS.map(L => el('button', {
        class: 'echan-chip' + (L.code === state.lang ? ' primary' : ''),
        type: 'button', text: L.native,
        onclick: (e) => {
          e.stopPropagation();
          panel.classList.add('busy');   /* block double-taps while the pack loads */
          setLanguage(L.code)
            .then(() => { closeLangPanel(); rebuildWelcomeTranslated(); })
            .catch(() => closeLangPanel());  /* never strand the overlay */
        },
      }))));
    frame.appendChild(panel);
    state.langPanelEl = panel;
  }

  function closeLangPanel() {
    if (state.langPanelEl) { try { state.langPanelEl.remove(); } catch (e) {} }
    state.langPanelEl = null;
  }

  /* Re-render the first-visit welcome after a language switch. Greeting
   * bookkeeping (visits, greeted, markSeen) already happened on first
   * display — this only replaces the visible message, so no re-counting.
   * NOTE: no isLineEligible here — the welcome line is ttlOnce and already
   * marked seen at first display, so filtering would empty the pool and
   * silently strand the chips (the v1.3.3 stuck-panel bug). */
  function rebuildWelcomeTranslated() {
    const pool = (state.seedByTrigger['welcome:firstVisit'] || []).slice();
    const got = pickAndFill(pool, liveVars());
    if (got) {
      const msg = {
        id: got.pick.id, category: got.pick.category, priority: got.pick.priority || 2,
        emotion: resolveEmotionForLine(got.pick), text: got.text, source: 'engine',
      };
      decorateWelcomeWithGuideChips(msg);
      clearChips();
      state.activeMessage = null;
      pushMessage(msg);
      return;
    }
    /* Seed unavailable in this language — keep the current text but rebuild
     * the welcome chips (labels now in the new UI language) so the dialog
     * is never left without controls. */
    if (state.activeMessage) {
      decorateWelcomeWithGuideChips(state.activeMessage);
      showChips(state.activeMessage.chips);
    }
  }

  /* The chattiness pitch, reframed as a plea (per design: she begs not to
   * be muted instead of dryly documenting settings). Fires once, after
   * the user's guide decision. */
  function queueSettingsPlea() {
    if (state.settingsPleaDone) return;
    state.settingsPleaDone = true;
    const pool = (state.seedByTrigger['welcome:settings'] || []).filter(isLineEligible);
    const got = pickAndFill(pool, liveVars());
    if (!got) return;
    if (pushMessage({
      id: got.pick.id, category: got.pick.category, priority: got.pick.priority || 2,
      emotion: resolveEmotionForLine(got.pick), text: got.text, source: 'engine',
    })) markSeen(got.pick.id);
  }

  function maybeGreet() {
    if (!state.seedLoaded) return;
    if (isQuietActive()) return;

    const lastGreet = parseInt(lsGet(STORAGE.greeted, '0'), 10) || 0;
    if (Date.now() - lastGreet < GREET_COOLDOWN_MS) return;

    const visits = parseInt(lsGet(STORAGE.visits, '0'), 10) || 0;
    let candidates = [];

    if (visits === 0) {
      candidates = (state.seedByTrigger['welcome:firstVisit'] || []).filter(isLineEligible);
    } else {
      const useReturn = Math.random() < 0.6;
      const returnPool = (state.seedByTrigger['welcome:returning'] || []).filter(isLineEligible);
      const timePool   = (state.seedByTrigger['time:' + getTimeBucket()] || []).filter(isLineEligible);
      candidates = (useReturn && returnPool.length) ? returnPool : timePool;
      if (!candidates.length) candidates = returnPool.length ? returnPool : timePool;
    }
    if (!candidates.length) return;

    const got = pickAndFill(candidates, liveVars());
    if (!got) return;

    /* source:'engine' → cadence-governed, exempt from the casual priority
     * gate. Cooldown + visit bookkeeping only when actually accepted, so
     * a dropped greeting doesn't burn the 4h window invisibly. */
    const greetMsg = {
      id: got.pick.id, category: got.pick.category, priority: got.pick.priority || 1,
      emotion: resolveEmotionForLine(got.pick), text: got.text, source: 'engine',
    };
    /* v1.3.2 first-visit flow: language pick (once) → welcome with the
     * guide offer → don't-mute-me plea after their decision. The lang
     * prompt replaces the greeting on the very first paint; the welcome
     * is rebuilt AFTER the language switch so it arrives translated. */
    if (visits === 0 && lsGet(STORAGE.tourOffered, '0') !== '1') {
      state.firstSession = true;
      decorateWelcomeWithGuideChips(greetMsg);
    }
    const accepted = pushMessage(greetMsg);
    if (!accepted) return;
    markSeen(got.pick.id);
    lsSet(STORAGE.greeted, String(Date.now()));
    lsSet(STORAGE.visits, String(visits + 1));
    return true;
  }

  /* contentTick — runs at the cadence set by CONTENT_TICK_INTERVAL[mode].
   * Self-schedules at the end so wake-from-sleep can call it directly
   * without double-scheduling. Bails cheaply in quiet mode (engine off). */
  function contentTick() {
    /* Schedule next tick first — keeps cadence steady regardless of
     * whether this tick produced output. scheduleContentTick is a no-op
     * in quiet mode (returns early without setting a timer). */
    scheduleContentTick();

    if (state.presenting) return;        /* lesson narration owns the dialog */
    if (state.mode === 'quiet') return;
    if (state.tour.active) return;
    if (!state.seedLoaded) return;
    if (document.hidden) return;
    if (isQuietActive()) return;
    if (state.activeMessage) return;
    if (state.queue.length) return;

    const idleMs = Date.now() - state.lastInteraction;
    let pool = [];
    if (idleMs > IDLE_LONG_MS)  pool = pool.concat(state.seedByTrigger['idle:long']  || []);
    if (idleMs > IDLE_SHORT_MS) pool = pool.concat(state.seedByTrigger['idle:short'] || []);
    pool = pool.concat(state.seedByTrigger['random'] || []);
    pool = pool.filter(isLineEligible);
    /* #2: when live stats are fresh, bias chatter toward the data-aware
     * amb-live lines (they double-enter the weighted pool). When stale they
     * self-exclude anyway — their {liveX} placeholders won't fill. */
    if (state.lastStats && (Date.now() - state.lastStatsAt) < STATS_FRESH_MS) {
      const liveLines = pool.filter(l => l.id && l.id.indexOf('amb-live') === 0);
      if (liveLines.length) pool = pool.concat(liveLines);
    }
    if (!pool.length) return;

    /* pickAndFill enables live template vars ({liveTps}, {tipHeight}, …)
     * in ordinary chatter. source:'engine' → exempt from the casual
     * priority gate (cadence already governs volume). markSeen only on
     * accept so dropped lines don't pollute the seen-ring. */
    const got = pickAndFill(pool, liveVars());
    if (!got) return;
    if (pushMessage({
      id: got.pick.id, category: got.pick.category, priority: got.pick.priority || 1,
      emotion: resolveEmotionForLine(got.pick), text: got.text, source: 'engine',
    })) {
      markSeen(got.pick.id);
    }
  }

  function scheduleContentTick() {
    clearTimeout(state.contentTimer);
    /* V1: never re-arm the cadence while hidden. A stray wake tick (or any
     * tick) firing during a hidden interval must not resurrect the engine
     * the visibility handler paused; resumption is driven by the wake tick
     * in onVisibilityChange when the tab returns. */
    if (document.hidden) return;
    const interval = CONTENT_TICK_INTERVAL[state.mode];
    if (!interval) return;   /* quiet mode → engine off */
    const [min, max] = interval;
    let delay = min + Math.random() * (max - min);
    /* #2: gently pace cadence with live throughput — busier network → talk a
     * little more often, quiet → a little less. Clamped to [0.7,1.3]× so it
     * never spams or goes silent. No-op when stats are stale. */
    const st = state.lastStats;
    if (st && (Date.now() - state.lastStatsAt) < STATS_FRESH_MS && typeof st.tpsNow === 'number') {
      const pivot = NETWORK_BUSY_TPS || 5;
      const factor = pivot / Math.max(st.tpsNow, 0.01);
      delay *= Math.max(0.7, Math.min(1.3, factor));
    }
    state.contentTimer = setTimeout(contentTick, delay);
  }

  /* ===========================================================================
   * EVENT BUS (v1.3.1) — reactions to live network events
   *
   * The inline module defines window.__echanBus and emits cheap payloads
   * at its existing handler sites. eChan subscribes here and applies all
   * the editorial policy: per-route cooldowns, random skip, mode gating,
   * template filling, and dashboard spotlighting. Keeping policy on this
   * side means tuning never requires a CSP regen.
   * =========================================================================*/
  /* Restore the persisted trend ring (v1.3.2): entries older than the
   * ring's useful horizon are dropped; malformed payloads are discarded
   * wholesale. Without this, every reload silenced trends for ~20 min. */
  function restoreStatsRing() {
    try {
      const raw = lsGet(STORAGE.statsRing);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      const horizon = Date.now() - (TREND_RING_MAX * TREND_SAMPLE_GAP_MS);
      state.statsRing = arr
        .filter(e => e && typeof e.t === 'number' && typeof e.tps === 'number' && e.t > horizon)
        .slice(-TREND_RING_MAX);
    } catch (e) { state.statsRing = []; }
  }

  function subscribeBus() {
    if (window.__echanBus && typeof window.__echanBus.on === 'function') {
      state.busUnsub = window.__echanBus.on(onBusEvent);
      state.busSubscribedAt = Date.now();
      return;
    }
    /* echan.js is defer-loaded after the inline module, so the bus should
     * already exist — the retry covers exotic load orders only. */
    let tries = 0;
    const retry = () => {
      if (window.__echanBus && typeof window.__echanBus.on === 'function') {
        state.busUnsub = window.__echanBus.on(onBusEvent);
        state.busSubscribedAt = Date.now();
      } else if (++tries < 20) setTimeout(retry, 500);
    };
    setTimeout(retry, 500);
  }

  /* Selector builders for the spotlight — the three card surfaces the
   * dashboard renders. CSS.escape guards exotic ids (txids are hex, but
   * defensive costs nothing). */
  function cssEsc(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s);
  }
  function txSel(txid)  { return txid ? '.tx-row[data-txid="'   + cssEsc(txid) + '"]' : null; }
  function msgSel(txid) { return txid ? '.msg-card[data-msgid="' + cssEsc(txid) + '"]' : null; }

  function onBusEvent(type, data) {
    if (type === 'stats') { recordStats(data); return; }
    if (!data) return;

    /* chronik link status (v1.3.2) — processed before every other gate
     * (incl. boot grace) so the flag always tracks reality. On reconnect
     * the drought clock restarts: downtime is OUR outage, not a chain
     * drought, and must not trigger an instant grumble. */
    if (type === 'chronik') {
      if (data.up && !state.chronikUp) state.lastBlockAt = Date.now();
      state.chronikUp = !!data.up;
      return;
    }

    /* Bookkeeping happens UNCONDITIONALLY — the drought watchdog and the
     * monotonic guard must see every block, including boot-replayed and
     * commentary-skipped ones. */
    let isNewTip = false;
    if (type === 'block') {
      state.lastBlockAt = Date.now();
      if (typeof data.height === 'number' && data.height > state.maxSeenHeight) {
        /* T1: the first block ever observed only seeds the monotonic guard.
         * A slow WS connect + backfill can land the first block AFTER the
         * time-based boot grace has expired; narrating it would announce a
         * stale block as "just landed". Seed silently, mirroring the
         * lastSeenPeak===null first-frame seed used for peaks. */
        const wasUnseeded = state.maxSeenHeight < 0;
        state.maxSeenHeight = data.height;
        isNewTip = !wasUnseeded;
        if (isNewTip) state.sessBlocks++;   /* #3: session tip counter */
      }
    }

    /* Boot grace: the dashboard backfills recent blocks/txs/messages at
     * page load through the same code paths as live arrivals. None of
     * that is news — observe it (above), never speak it. */
    if (Date.now() - state.busSubscribedAt < EVENT_BOOT_GRACE_MS) return;

    /* M1: don't narrate live events while the tab is hidden. Bookkeeping
     * above (tip height, drought clock, chronik link, stats) already ran,
     * so state stays correct; this suppresses only the spoken reaction —
     * and the unbounded queue growth it would otherwise cause. Mirrors the
     * document.hidden gate in evaluateTrends/evaluateTpsEdges. */
    if (document.hidden) return;

    /* Monotonic guard: only the new tip is "just landed". Re-announced,
     * reorged, or out-of-order blocks are observed but not narrated. */
    if (type === 'block' && !isNewTip) return;

    /* ttf splits into brag vs grumble; the dead zone in between is the
     * normal case and stays silent. */
    let routeKey = type;
    if (type === 'ttf') {
      if (!data.precise) return;
      if (typeof data.ms === 'number' && data.ms < state.sessFastestMs) state.sessFastestMs = data.ms;
      if (data.ms < FAST_TTF_MAX_MS)      routeKey = 'fastttf';
      else if (data.ms > SLOW_TTF_MIN_MS) routeKey = 'slowttf';
      else return;
    }
    /* bigtx splits by size: whale (≥1B XEC) keeps the original trigger,
     * shark (100M–1B) gets its own dialogue tier. The inline module emits
     * from 100M up; values below that never reach us. */
    if (type === 'bigtx') {
      if (typeof data.valueXec !== 'number' || data.valueXec < SHARK_XEC) return;
      routeKey = (data.valueXec >= WHALE_XEC) ? 'bigtx' : 'sharktx';
      if (routeKey === 'bigtx') state.sessWhales++;   /* #3: session whale counter */
    }

    const route = EVENT_ROUTES[routeKey];
    if (!route) return;
    if (isQuietActive()) return;
    if (state.mode === 'quiet' && route.priority < 3) return;

    /* blockfinal only pairs with a block we actually commented on —
     * otherwise every ~10min block would produce TWO lines. */
    if (routeKey === 'blockfinal') {
      if (data.height !== state.lastCommentedBlock) return;
      state.lastCommentedBlock = -1;
    }

    const now = Date.now();
    const last = state.eventLastFireAt[routeKey] || 0;
    const cdMs = (route.cooldownMs || 0) * (EVENT_COOLDOWN_SCALE[state.mode] || 1);
    if (cdMs && now - last < cdMs) return;
    if (route.chance < 1 && Math.random() > route.chance) return;

    /* Freshness metadata: deadline by route, plus a block-specific check
     * so a queued "Block N just landed" dies the moment N+1 is seen. */
    const spotSel = route.spot ? route.spot(data) : null;
    const fresh = {
      eventAt: now,
      staleAfterMs: EVENT_STALE_MS[routeKey] || null,
      staleCheck: (routeKey === 'block' || routeKey === 'blockfinal')
        ? () => (typeof data.height === 'number' && data.height < state.maxSeenHeight)
        : null,
    };
    if (!pushEventLine(route.trigger, route.priority, eventVars(data), spotSel, fresh)) return;
    state.eventLastFireAt[routeKey] = now;
    if (routeKey === 'block') state.lastCommentedBlock = data.height;
  }

  /* Normalize a bus payload into the template variable namespace. Vars the
   * payload doesn't carry stay undefined → fillTemplate skips lines that
   * reference them. */
  function eventVars(data) {
    return {
      height:   data.height,
      txCount:  (data.txCount  != null) ? Number(data.txCount).toLocaleString('en-US') : undefined,
      valueXec: (data.valueXec != null) ? fmtCompact(data.valueXec) : undefined,
      ttfMs:    (data.ms       != null) ? Math.round(data.ms) : undefined,
      ttfSec:   (data.ms       != null) ? fmtTtfSec(data.ms) : undefined,
      watched:  data.label,
      msgType:  data.msgType,
      pct:      data.pct,
      peakTps:  data.peakTps,
      mins:     data.mins,
    };
  }

  function fmtCompact(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return String(Math.round(v));
  }

  /* TPS with magnitude-aware precision (v1.3.2 fix): the old toFixed(1)
   * rendered a real 0.02 TPS as "0.0" — eChan quoting an obviously wrong
   * number is worse than silence. Small values keep enough decimals to
   * stay truthful; big values drop the noise. */
  function fmtTps(v) {
    if (typeof v !== 'number' || !isFinite(v)) return undefined;
    if (v >= 10)  return String(Math.round(v));
    if (v >= 1)   return v.toFixed(1).replace(/\.0$/, '');
    if (v >= 0.1) return v.toFixed(2);
    if (v >= 0.001) return v.toFixed(v >= 0.01 ? 2 : 3);  // keep full digits: 0.001 .. 0.099
    if (v > 0)      return '< 0.001';                     // never quote a zero-looking "0.000"
    return '0';
  }

  /* TTF for dialogue: seconds, one decimal (v1.3.2 — "0.3s" reads more
   * human than "287ms"). Grumpy lines intentionally keep raw {ttfMs} for
   * comedic exaggeration. */
  function fmtTtfSec(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return undefined;
    const s = ms / 1000;
    if (s >= 10) return String(Math.round(s));
    return s.toFixed(1).replace(/\.0$/, '');
  }

  /* Live template variables — usable in ANY seed line, not just event
   * lines. Values come from the freshest relay frame / bus state; when the
   * data isn't fresh the var is undefined, fillTemplate returns null, and
   * the line is skipped. So "{liveTps} TPS right now" can never display a
   * stale number — staleness gating falls out of the template mechanism. */
  function liveVars() {
    const st = state.lastStats;
    const fresh = st && (Date.now() - state.lastStatsAt) < STATS_FRESH_MS;
    return {
      liveTps:     (fresh && typeof st.tps === 'number') ? fmtTps(st.tps) : undefined,
      /* seconds, not ms — see fmtTtfSec rationale */
      liveTtf:     (fresh && typeof st.ttfP50Ms === 'number') ? fmtTtfSec(st.ttfP50Ms) : undefined,
      livePeak:    (fresh && typeof st.tpsPeak24h === 'number') ? fmtTps(st.tpsPeak24h) : undefined,
      liveTxCount: (fresh && typeof st.sampleCount === 'number' && st.sampleCount > 0)
                     ? st.sampleCount.toLocaleString('en-US') : undefined,
      tipHeight:   (state.maxSeenHeight > 0) ? String(state.maxSeenHeight) : undefined,
      /* v1.5.5 relay now-window + derived consistency (all gated on fresh). */
      liveTpsNow:  (fresh && typeof st.tpsNow === 'number') ? fmtTps(st.tpsNow) : undefined,
      liveTtfNow:  (fresh && typeof st.ttfP50NowMs === 'number') ? fmtTtfSec(st.ttfP50NowMs) : undefined,
      livePctUnder3s: (fresh && typeof st.pctFinalUnder3s === 'number')
                     ? (Math.round(st.pctFinalUnder3s * 100) + '%') : undefined,
      liveTtfSpread: (fresh && typeof st.ttfP90Ms === 'number' && typeof st.ttfP10Ms === 'number')
                     ? fmtTtfSec(st.ttfP90Ms - st.ttfP10Ms) : undefined,
      /* Session records/memory — not from the stats frame, so not fresh-gated. */
      liveFastest:    isFinite(state.sessFastestMs) ? (state.sessFastestMs / 1000).toFixed(2) : undefined,
      liveSessBlocks: (state.sessBlocks > 0) ? String(state.sessBlocks) : undefined,
      liveSessWhales: (state.sessWhales > 0) ? String(state.sessWhales) : undefined,
    };
  }

  /* Shared pick+fill: weighted-pick from the pool, substitute {vars}; a
   * line whose placeholders can't all be satisfied right now is dropped
   * from the candidate pool and another tried (≤4 attempts). */
  function pickAndFill(pool, vars) {
    for (let attempt = 0; attempt < 4 && pool.length; attempt++) {
      const pick = weightedPick(pool);
      if (!pick) return null;
      const text = fillTemplate(pick.text, vars);
      if (text === null) { pool = pool.filter(l => l !== pick); continue; }
      return { pick, text };
    }
    return null;
  }

  /* {placeholder} substitution. Returns null if ANY referenced var is
   * missing — caller treats that as "line not usable for this event". */
  function fillTemplate(text, vars) {
    let ok = true;
    const out = String(text).replace(/\{(\w+)\}/g, (m, k) => {
      const v = vars ? vars[k] : undefined;
      if (v === undefined || v === null) { ok = false; return m; }
      return String(v);
    });
    return ok ? out : null;
  }

  /* Pick an eligible seed line for the trigger, fill its template, push.
   * Lines whose placeholders can't all be satisfied are dropped from the
   * candidate pool and another is tried (≤4 attempts) — defensive against
   * seed edits referencing vars an event doesn't carry. Returns true if a
   * message was actually pushed. */
  function pushEventLine(trigger, priority, vars, spotlightSel, fresh) {
    if (!state.seedLoaded) return false;
    const pool = (state.seedByTrigger[trigger] || []).filter(isLineEligible);
    /* Event vars win over live vars on key collision. */
    const got = pickAndFill(pool, Object.assign(liveVars(), vars));
    if (!got) return false;
    /* Accept-gated: a casual-mode drop of a pri-1 event must NOT consume
     * the route cooldown (caller sets it on true) or mark the line seen —
     * otherwise Chatty users switching modes inherit ghost cooldowns. */
    const accepted = pushMessage({
      id: got.pick.id, category: got.pick.category,
      priority: got.pick.priority || priority,
      emotion: resolveEmotionForLine(got.pick),
      text: got.text,
      spotlight: spotlightSel || undefined,
      eventAt:      fresh ? fresh.eventAt      : undefined,
      staleAfterMs: fresh ? fresh.staleAfterMs : undefined,
      staleCheck:   fresh ? fresh.staleCheck   : undefined,
    });
    if (!accepted) return false;
    markSeen(got.pick.id);
    return true;
  }

  /* ===========================================================================
   * ATTRACT (v1.3.2) — high-visibility state for the first-visit dialog
   *
   * New users were scrolling straight past a politely glowing bubble. The
   * attract class drives a strong, NEVER-expiring pulse on the dialog
   * (CSS: .echan-root.echan-attract) that is only removed when the user
   * makes a guide decision — picks "show me around" or "later". Language
   * chips keep it on; the welcome that follows keeps it on; only the
   * guide choice clears it.
   * =========================================================================*/
  function addAttract() {
    if (state.root) state.root.classList.add('echan-attract');
  }
  function removeAttract() {
    if (state.root) state.root.classList.remove('echan-attract');
  }

  /* ===========================================================================
   * CHIPS (v1.3.2) — tappable inline choices in the dialog
   *
   * Transient by design: built at use time with already-translated labels
   * (no data-i18n), cleared on advance/exit. Used for the first-visit
   * tour offer and the in-tour exit affordance.
   * =========================================================================*/
  function showChips(defs) {
    clearChips();
    if (!state.textBody || !defs || !defs.length) return;
    const chips = el('div', { class: 'echan-chips' },
      ...defs.map(d => el('button', {
        class: 'echan-chip' + (d.primary ? ' primary' : ''), type: 'button', text: d.label,
        onclick: (e) => { e.stopPropagation(); try { d.onTap(); } catch (err) {} },
      })));
    state.textBody.insertAdjacentElement('afterend', chips);
    state.chipsEl = chips;
  }
  function clearChips() {
    closeLangPanel();
    if (state.chipsEl) { try { state.chipsEl.remove(); } catch (e) {} }
    state.chipsEl = null;
  }

  /* ===========================================================================
   * TOUR (v1.3.2) — eChan-led guided walkthrough
   *
   * Steps live in seed.json (trigger 'tour:step', ordered by `step`,
   * optional `spot` selector) — which makes the whole tour translatable
   * through the normal seed.<lang>.json pipeline. While active: the
   * engine timers are stopped, events are dropped (cooldowns untouched —
   * pushMessage returns false), owner messages still queue for after.
   * Navigation: tap the dialog → next; ✕ chip or Esc → exit; the
   * spotlight HOLD variant stays lit for the whole step, and on mobile
   * the owning tab is activated first so the glow is actually visible.
   * =========================================================================*/
  function tourSteps() {
    return (state.seedByTrigger['tour:step'] || [])
      .slice()
      .sort((a, b) => (a.step | 0) - (b.step | 0));
  }

  function startTour() {
    if (state.tour.active) return;
    if (!state.seedLoaded) return;
    const steps = tourSteps();
    if (!steps.length) return;
    closeQuickActions();
    closeSettings();
    closeLangPopover();
    /* Silence the world: engine timers off, queue flushed (events are
     * ephemeral; owner messages will re-queue via pushMessage's tour
     * gate if any arrive mid-tour). */
    clearTimeout(state.contentTimer);
    clearTimeout(state.advanceTimer);
    stopTypewriter();
    state.queue = [];
    state.activeMessage = null;
    state.tour = { active: true, step: 0, steps };
    removeAttract();
    if (state.avatar) state.avatar.classList.add('echan-avatar-tour');
    if (!state.shown) show();
    showTourStep(0);
  }

  function showTourStep(i) {
    const stp = state.tour.steps[i];
    if (!stp) { endTour(true); return; }
    state.tour.step = i;
    clearTourSpot();
    if (stp.spot) activateTabFor(stp.spot);
    /* Tour text may use live vars; a missing var renders as '…' rather
     * than killing the step (tour must never dead-end). */
    let text = fillTemplate(stp.text, liveVars());
    if (text === null) text = String(stp.text).replace(/\{\w+\}/g, '…');
    state.activeMessage = {
      id: stp.id, category: 'tour', priority: 3,
      emotion: resolveEmotionForLine(stp), text, tour: true, holdOpen: true,
    };
    state.textCat.textContent = '· tour ' + (i + 1) + '/' + state.tour.steps.length;
    setEmotion(state.activeMessage.emotion);
    playArrival();
    if (stp.spot) holdSpotlight(stp.spot);
    startTypewriter(text);
    const chips = [];
    if (i > 0) chips.push({ label: t('tour.back'), onTap: () => showTourStep(i - 1) });
    chips.push({ label: t('tour.exit'), onTap: () => endTour(false) });
    showChips(chips);
    refreshPageDots();
  }

  function nextTourStep() { showTourStep(state.tour.step + 1); }

  function endTour(completed) {
    clearTourSpot();
    clearChips();
    if (state.avatar) state.avatar.classList.remove('echan-avatar-tour');
    const wasActive = state.tour.active;
    state.tour = { active: false, step: 0, steps: [] };
    if (!wasActive) return;
    lsSet(STORAGE.tourDone, '1');
    state.activeMessage = null;
    state.textCat.textContent = '';
    state.textBody.textContent = '';
    state.textAdvance.classList.remove('visible');
    /* Resume normal life. */
    scheduleContentTick();
    scheduleNetworkPoll();
    scheduleTrendEval();
    if (completed) {
      pushMessage({
        id: 'tour-end', category: 'tour', priority: 2,
        emotion: 'celebrate', text: t('tour.done'), source: 'engine',
      });
    } else if (state.queue.length) {
      showNextMessage();
    }
    /* First-session epilogue: the "please don't mute me" plea. */
    if (state.firstSession) queueSettingsPlea();
  }

  /* Persistent spotlight for tour steps — steady glow, removed on step
   * change/exit (vs the 5s one-shot pulse used for event mentions). */
  function holdSpotlight(selector) {
    let target = null;
    try { target = document.querySelector(selector); } catch (e) { return; }
    if (!target) return;
    target.classList.add('echan-spotlight-hold');
    state.tourSpotEl = target;
  }
  function clearTourSpot() {
    if (state.tourSpotEl) {
      try { state.tourSpotEl.classList.remove('echan-spotlight-hold'); } catch (e) {}
    }
    state.tourSpotEl = null;
  }

  /* Mobile: make sure the panel that owns `selector` is the active tab
   * before spotlighting inside it. Same section↔tab mapping as
   * spotlightCard's tab glow. */
  function activateTabFor(selector) {
    if (!window.matchMedia || !window.matchMedia('(max-width: 939px)').matches) return;
    let target = null;
    try { target = document.querySelector(selector); } catch (e) { return; }
    const section = target && target.closest('.col-section, .messages, .blockchain, .watchlist');
    if (!section || !section.id) return;
    if (section.classList.contains('mobile-active')) return;
    const name = section.id.replace(/^section-/, '');
    const tab = document.querySelector('.mobile-tab[data-section="' + cssEsc(name) + '"]');
    if (tab) { try { tab.click(); } catch (e) {} }
  }

  /* ===========================================================================
   * SPOTLIGHT — glow the dashboard card eChan is talking about
   *
   * Triggered from showNextMessage at DISPLAY time (not queue time) so the
   * glow is synchronized with the dialogue actually being on screen. The
   * target may have been evicted from the DOM by then (tx rows rotate
   * fast) — querySelector miss is a silent no-op. Class removal is timed
   * rather than animation-fill so a re-mention can re-trigger cleanly.
   * =========================================================================*/
  function spotlightCard(selector) {
    if (!selector) return;
    let el = null;
    try { el = document.querySelector(selector); } catch (e) { return; }
    if (!el) return;
    el.classList.remove('echan-spotlight');
    // eslint-disable-next-line no-unused-expressions
    void el.offsetWidth;   /* restart animation if re-mentioned */
    el.classList.add('echan-spotlight');
    setTimeout(() => {
      try { el.classList.remove('echan-spotlight'); } catch (e) {}
    }, SPOTLIGHT_MS + 300);

    /* Mobile (<940px): panels stack behind a tab strip and only the
     * .mobile-active one is visible — an in-card glow inside a hidden
     * panel says nothing. Light up the owning section's TAB as well so
     * the user knows which panel the event lives in. Tab id mapping:
     * #section-<name> ↔ .mobile-tab[data-section="<name>"]. */
    if (window.matchMedia && window.matchMedia('(max-width: 939px)').matches) {
      const section = el.closest('.col-section, .messages, .blockchain, .watchlist');
      if (!section || !section.id) return;
      const name = section.id.replace(/^section-/, '');
      const tab = document.querySelector('.mobile-tab[data-section="' + cssEsc(name) + '"]');
      if (!tab) return;
      tab.classList.remove('echan-spotlight-tab');
      // eslint-disable-next-line no-unused-expressions
      void tab.offsetWidth;
      tab.classList.add('echan-spotlight-tab');
      setTimeout(() => {
        try { tab.classList.remove('echan-spotlight-tab'); } catch (e) {}
      }, SPOTLIGHT_MS + 300);
    }
  }

  /* ===========================================================================
   * TREND ENGINE (v1.3.1)
   * =========================================================================*/
  function recordStats(d) {
    if (!d || typeof d.tps !== 'number') return;
    state.lastStats = d;
    state.lastStatsAt = Date.now();
    /* Fresh stats frames double as the busy/quiet TPS source. */
    evaluateTpsEdges(d.tps);
    /* Downsample into the ring: at most one snapshot per minute. */
    const ring = state.statsRing;
    const t = Date.now();
    if (!ring.length || t - ring[ring.length - 1].t >= TREND_SAMPLE_GAP_MS) {
      ring.push({ t, tps: d.tps, ttfP50Ms: d.ttfP50Ms, sampleCount: d.sampleCount });
      if (ring.length > TREND_RING_MAX) ring.shift();
      /* Persist (≤1 write/min by construction, ~2KB): a reload no longer
       * resets the 30-min trend baseline to zero. */
      try { lsSet(STORAGE.statsRing, JSON.stringify(ring)); } catch (e) {}
    }
    /* New 24h peak — edge-detected vs the last frame. First observation
     * only seeds the baseline so a page load doesn't celebrate stale news. */
    if (typeof d.tpsPeak24h === 'number') {
      if (state.lastSeenPeak !== null && d.tpsPeak24h > state.lastSeenPeak) {
        fireTrend('peak', 'event:trend:peak', 2, {
          peakTps: fmtTps(d.tpsPeak24h),
        });
      }
      state.lastSeenPeak = Math.max(state.lastSeenPeak ?? 0, d.tpsPeak24h);
    }
  }

  /* Snapshot closest to 30 min ago — must itself be ≥20 min old so early
   * page life doesn't compare now-vs-2-minutes-ago and overreact. */
  function baselineSnapshot() {
    const ring = state.statsRing;
    if (!ring.length) return null;
    const target = Date.now() - TREND_BASELINE_MS;
    let best = null;
    for (const s of ring) {
      if (!best || Math.abs(s.t - target) < Math.abs(best.t - target)) best = s;
    }
    if (!best || Date.now() - best.t < TREND_MIN_BASELINE_MS) return null;
    return best;
  }

  function evaluateTrends() {
    scheduleTrendEval();
    if (document.hidden || isQuietActive() || state.mode === 'quiet') return;

    /* Block drought — checked before the stats-freshness gate because a
     * drought is detectable even with the relay feed down. fireTrend's
     * 30-min cooldown makes it re-grumble with an escalating count while
     * the drought persists. */
    const sinceBlock = Date.now() - state.lastBlockAt;
    if (state.chronikUp && sinceBlock > BLOCK_DROUGHT_MS) {
      fireTrend('drought', 'event:blockdrought', 2, {
        mins: Math.round(sinceBlock / 60000),
      });
    }

    const now = state.lastStats;
    if (!now || Date.now() - state.lastStatsAt > STATS_FRESH_MS) return;
    const base = baselineSnapshot();
    if (!base) return;

    /* TPS average */
    if (typeof now.tps === 'number' && typeof base.tps === 'number' && base.tps >= TREND_TPS_FLOOR) {
      const pct = Math.round(((now.tps - base.tps) / base.tps) * 100);
      if (pct >= TREND_PCT)       fireTrend('tps', 'event:trend:tps_up',   2, { pct });
      else if (pct <= -TREND_PCT) fireTrend('tps', 'event:trend:tps_down', 1, { pct: -pct });
    }
    /* TTF p50 — down = improvement (worth celebrating), up = degradation */
    if (typeof now.ttfP50Ms === 'number' && typeof base.ttfP50Ms === 'number'
        && base.ttfP50Ms >= TREND_TTF_FLOOR_MS) {
      const pct = Math.round(((now.ttfP50Ms - base.ttfP50Ms) / base.ttfP50Ms) * 100);
      if (pct <= -TREND_PCT)     fireTrend('ttf', 'event:trend:ttf_down', 2, { pct: -pct });
      else if (pct >= TREND_PCT) fireTrend('ttf', 'event:trend:ttf_up',   1, { pct });
    }
  }

  function fireTrend(metric, trigger, priority, vars) {
    const now = Date.now();
    const last = state.trendLastFireAt[metric] || 0;
    if (now - last < TREND_COOLDOWN_MS * (EVENT_COOLDOWN_SCALE[state.mode] || 1)) return;
    if (pushEventLine(trigger, priority, vars, null)) state.trendLastFireAt[metric] = now;
  }

  function scheduleTrendEval() {
    clearTimeout(state.trendTimer);
    const interval = TREND_EVAL_INTERVAL[state.mode];
    if (!interval) return;   /* quiet mode → trend engine off */
    state.trendTimer = setTimeout(evaluateTrends, interval);
  }

  /* ===========================================================================
   * TPS EDGE DETECTION + FALLBACK DOM POLLER
   *
   * v1.3.1: stats frames from the bus are the primary TPS source (5s
   * cadence, exact relay numbers). The DOM poll of #f-tps survives only
   * as a fallback for when the ttf-feed is disconnected; its interval
   * scales with chattiness (quiet mode = no polling at all). Both sources
   * funnel into evaluateTpsEdges so busy/quiet transitions behave
   * identically regardless of origin.
   * =========================================================================*/
  function evaluateTpsEdges(tps) {
    if (document.hidden || isQuietActive()) return;
    let now = 'normal';
    if (tps > NETWORK_BUSY_TPS)        now = 'busy';
    else if (tps < NETWORK_QUIET_TPS)  now = 'quiet';

    /* T2/L1: the first frame only seeds lastNetState. Without this guard a
     * load landing on a busy/quiet network fires an edge line off the
     * default 'normal', colliding with the greeting. Mirrors lastSeenPeak. */
    if (state.netSeeded && now !== state.lastNetState && now !== 'normal') {
      const trigger = (now === 'busy') ? 'network:busy' : 'network:quiet';
      const pool = (state.seedByTrigger[trigger] || []).filter(isLineEligible);
      const got = pickAndFill(pool, liveVars());
      if (got) {
        /* Edge lines are event-like: priority semantics apply (net-quiet
         * at pri 1 stays Chatty-only; net-busy at pri 2 shows in Casual).
         * markSeen gated on accept. */
        if (pushMessage({
          id: got.pick.id, category: got.pick.category, priority: got.pick.priority || 1,
          emotion: resolveEmotionForLine(got.pick), text: got.text,
        })) {
          markSeen(got.pick.id);
        }
      }
    }
    state.lastNetState = now;
    state.netSeeded = true;
  }

  function pollNetwork() {
    scheduleNetworkPoll();
    if (document.hidden || isQuietActive()) return;
    /* Feed healthy → stats frames already drive edge detection. */
    if (Date.now() - state.lastStatsAt < STATS_FRESH_MS) return;
    const tpsEl = document.getElementById('f-tps');
    if (!tpsEl) return;
    const tps = parseFloat(tpsEl.textContent.trim());
    if (isNaN(tps)) return;
    evaluateTpsEdges(tps);
  }
  function scheduleNetworkPoll() {
    clearTimeout(state.networkTimer);
    const interval = NETWORK_POLL_INTERVAL[state.mode];
    if (!interval) return;   /* quiet mode → no fallback polling */
    state.networkTimer = setTimeout(pollNetwork, interval);
  }

  /* ===========================================================================
   * INTERACTION TRACKING
   * =========================================================================*/
  function bumpInteraction() {
    state.lastInteraction = Date.now();
  }

  /* ===========================================================================
   * DOC HANDLERS
   * =========================================================================*/
  function onVisibilityChange() {
    if (document.hidden) {
      stopTypewriter();
      clearTimeout(state.advanceTimer);
      clearTimeout(state.contentTimer);
      clearTimeout(state.networkTimer);
      clearTimeout(state.trendTimer);
      clearTimeout(state.wakeTimer);
      flushSeenRing();
    } else {
      /* Resume work. Finish any in-progress typewriter so the message
       * isn't half-revealed when the user returns. */
      if (state.activeMessage) finishTypewriter();
      /* Re-resume audio if the browser suspended it while hidden. */
      if (state.soundEnabled && state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
      scheduleNetworkPoll();
      scheduleTrendEval();
      /* Wake-from-sleep: fire an immediate content tick after a brief
       * settle delay, rather than waiting the full mode cadence. The
       * tick self-schedules the next one at normal cadence, so no
       * double-tick risk. Eliminates the long silence after returning
       * from a hidden tab. */
      clearTimeout(state.wakeTimer);
      state.wakeTimer = setTimeout(contentTick, WAKE_TICK_DELAY_MS);
    }
  }
  function onDocClick(e) {
    if (state.langPopOpen && state.langPop
        && !state.langPop.contains(e.target)
        && !(state.langBtn && state.langBtn.contains(e.target))) {
      closeLangPopover();
    }
    bumpInteraction();
    if (state.settingsOpen) {
      if (!e.target.closest('.echan-settings') && !e.target.closest('.echan-rail-gear')) {
        closeSettings();
      }
    }
    if (state.quickActionsOpen) {
      if (!e.target.closest('.echan-quickactions') && !e.target.closest('.echan-avatar')) {
        closeQuickActions();
      }
    }
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      if (state.tour.active)      { endTour(false); return; }
      if (state.langPopOpen)      closeLangPopover();
      if (state.settingsOpen)     closeSettings();
      if (state.quickActionsOpen) closeQuickActions();
    }
  }

  /* ===========================================================================
   * PUBLIC API
   * =========================================================================*/
  function publishApi() {
    window.__echanReceive = function (frame) {
      if (!frame || typeof frame !== 'object') return;
      pushMessage({
        id:       String(frame.id || ('rx-' + Date.now())),
        category: String(frame.category || 'news'),
        priority: Math.max(1, Math.min(3, frame.priority | 0)) || 1,
        emotion:  EMOTIONS[frame.emotion] ? frame.emotion : 'neutral',
        text:     String(frame.text || '').slice(0, 1200),
        source:   frame.source === 'owner' ? 'owner' : 'feed',
        dwellMs:  Math.max(1500, Math.min(30000, frame.dwellMs | 0)) || ADVANCE_AUTO_MS,
      });
    };
    Object.defineProperty(window, '__echan', {
      configurable: true,
      get() {
        return Object.freeze({
          version:  VERSION,
          shown:    state.shown,
          mode:     state.mode,
          deskpos:  state.deskpos,
          soundEnabled: state.soundEnabled,
          queueLen: state.queue.length,
          emotion:  state.currentEmotion,
          seedLoaded: state.seedLoaded,
          seedCategories: Object.keys(state.seedByTrigger).reduce((acc, k) => {
            acc[k] = state.seedByTrigger[k].length; return acc;
          }, {}),
          categoryDefaults: Object.assign({}, state.categoryDefaults),
          spriteCounts: state.spriteCounts ? Object.assign({}, state.spriteCounts) : null,
          seenCount: state.seenIds ? state.seenIds.size : 0,
          isQuiet:  isQuietActive(),
          show, hide, toggle, setMode,
          setEmotion: (name, opts) => setEmotion(name, opts || {}),
          setDeskPos, toggleDeskPos,
          /* Media-center control surface (driven by vendor/mediacenter/). */
          isReady: () => !!state.root,
          enterLessonMode: mcEnterLessonMode,
          enterMediaMode:  mcEnterMediaMode,
          exitMode:        mcExitMode,
          /* Mobile Chat-tab transient hide (driven by index.html tab router). */
          enterChatHide:   enterChatHide,
          exitChatHide:    exitChatHide,
          presentLine:     presentLine,
          push: pushMessage,
          pulseOn:  pulseRailOn,
          pulseOff: pulseRailOff,
          tick: contentTick,
          clearSeen: () => { state.seenIds.clear(); persistSeenRing(); },
          clearQuiet: () => { state.quietUntil = 0; },
          forceGreet: () => { lsRemove(STORAGE.greeted); maybeGreet(); },
          triggerEaster,
          /* v1.3.1 — event bus / trend debug surface */
          lastBlockAgoMin: Math.round((Date.now() - state.lastBlockAt) / 60000),
          statsFresh: (Date.now() - state.lastStatsAt) < STATS_FRESH_MS,
          statsRingLen: state.statsRing.length,
          chronikUp: state.chronikUp,
          lang: state.lang,
          tourActive: state.tour.active,
          startTour,
          eventLastFireAt: Object.assign({}, state.eventLastFireAt),
          /* simulate a bus event from devtools, e.g.
           *   __echan.bus('bigtx', {valueXec: 25000000, txid: 'abc'})
           *   __echan.bus('ttf', {ms: 5200, precise: true})        */
          bus: (type, data) => onBusEvent(type, data || {}),
          spotlight: spotlightCard,
          evaluateTrends,
          toggleSound,
          playTypeBlip, playArrival, playGlitch,
          qa: { stats: qaStats, latestBlock: qaLatestBlock, tip: qaTip, quietHour: qaQuietHour },
        });
      },
    });
  }

  /* ===========================================================================
   * INIT
   * =========================================================================*/
  async function init() {
    for (const k of LEGACY_KEYS) lsRemove(k);

    const savedMode = lsGet(STORAGE.mode, DEFAULT_MODE);
    state.mode = MODES[savedMode] ? savedMode : DEFAULT_MODE;
    const savedPos = lsGet(STORAGE.deskpos, DESKPOS_PERCH);
    state.deskpos = (savedPos === DESKPOS_FOOTER) ? DESKPOS_FOOTER : DESKPOS_PERCH;
    const savedShown = lsGet(STORAGE.shown, '1');
    state.soundEnabled = lsGet(STORAGE.sound, '0') === '1';

    /* Language before seed: the seed fetch is language-aware. */
    const savedLang = lsGet(STORAGE.lang, 'en') || 'en';
    state.lang = I18N_LANGS.some(l => l.code === savedLang) ? savedLang : 'en';
    try { document.documentElement.lang = state.lang; } catch (e) {}
    publishI18nBridge();

    state.seenIds = loadSeenRing();

    const manifestPromise = loadSpriteManifest();
    const seedPromise = (async () => { await loadLangPack(state.lang); await loadSeed(); })();

    await manifestPromise;

    const root = buildDom();
    const mountTo = document.getElementById('stage-wrap') || document.body;
    mountTo.appendChild(root);

    setDeskPos(state.deskpos, false);

    /* First-paint emotion — passive (no glitch). Breathing animation
     * removed — single sprite stays put until the next message-driven
     * emotion change. */
    requestAnimationFrame(() => {
      setEmotion('neutral', { glitch: false });
    });

    setupResizeTracking();
    refreshSettingsActiveMode();
    refreshSoundButton();

    if (savedShown !== '0') requestAnimationFrame(() => requestAnimationFrame(show));

    state.visHandler      = onVisibilityChange;
    state.docClickHandler = onDocClick;
    state.keyHandler      = onKey;
    document.addEventListener('visibilitychange', state.visHandler);
    document.addEventListener('click', state.docClickHandler);
    document.addEventListener('keydown', state.keyHandler);
    /* P1: last-chance flush of the debounced seen-ring on unload. */
    window.addEventListener('pagehide', flushSeenRing);
    /* Audio unlock — capture phase fires before any click handler, so the
     * very first interaction (including the sound toggle itself) counts. NOT
     * once: the context can be suspended later (reopen browser/bfcache,
     * app-switch, screen lock, idle auto-suspend); re-running unlock on each
     * gesture resumes it instead of leaving sound permanently dead. */
    document.addEventListener('pointerdown', unlockAudioOnGesture, { capture: true });
    document.addEventListener('keydown',     unlockAudioOnGesture, { capture: true });

    publishApi();
    restoreStatsRing();
    subscribeBus();
    injectLangButton();

    seedPromise.then(() => {
      applyDomI18n();
      startDomI18nObserver();
      setTimeout(() => {
        const greeted = maybeGreet();
        /* Refresh opener: when the greeting is suppressed (e.g. the 4h
         * cooldown after a page reload), don't sit silent until the first
         * cadence tick (12–22s in Chatty). Bring the first content line
         * forward to a few seconds so eChan visibly "wakes up". Only when no
         * greeting showed, the tab is visible, and the mode has a cadence
         * (skips quiet). The early tick self-reschedules normal cadence. */
        if (!greeted && !document.hidden && CONTENT_TICK_INTERVAL[state.mode]) {
          clearTimeout(state.contentTimer);
          const d = OPENER_DELAY[0] + Math.random() * (OPENER_DELAY[1] - OPENER_DELAY[0]);
          state.contentTimer = setTimeout(contentTick, d);
        }
      }, 500);
      scheduleContentTick();
      scheduleNetworkPoll();
      scheduleTrendEval();
    });

    console.log('[eChan] mounted', VERSION,
      '· mode=', state.mode,
      '· deskpos=', state.deskpos,
      '· sound=', state.soundEnabled,
      '· shown=', state.shown,
      '· sprites=', state.spriteCounts);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
