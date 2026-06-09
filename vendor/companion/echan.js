/* =============================================================================
 * eChan companion — 1.3.0-polish controller
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
  const VERSION              = '1.3.0';
  const SPRITE_PATH          = './vendor/companion/sprites/';
  const SPRITE_MANIFEST_URL  = './vendor/companion/sprites/manifest.json';
  const SEED_URL             = './vendor/companion/seed.json';

  /* EMOTIONS map — the `fallback` field is the chain used by setEmotion
   * when the requested emotion's sprite pool is empty. Drawing new art
   * later (echan_studying.webp + manifest count bump) makes the pool
   * non-empty, which short-circuits the fallback automatically. */
  const EMOTIONS = {
    neutral:   { label: 'Neutral',   idle: true,  fallback: null      },
    happy:     { label: 'Happy',     idle: true,  fallback: null      },
    thinking:  { label: 'Thinking',  idle: true,  fallback: null      },
    alert:     { label: 'Alert',     idle: false, fallback: null      },
    celebrate: { label: 'Celebrate', idle: false, fallback: null      },
    sleepy:    { label: 'Sleepy',    idle: true,  fallback: null      },
    /* New in 1.3.0-polish — pending art */
    studying:  { label: 'Studying',  idle: true,  fallback: 'thinking' },
    observing: { label: 'Observing', idle: true,  fallback: 'neutral'  },
    shy:       { label: 'Shy',       idle: false, fallback: 'happy'    },
  };
  const EMOTION_KEYS  = Object.keys(EMOTIONS);

  const MODES = {
    quiet:  { label: 'Quiet',  desc: 'Announcements only' },
    casual: { label: 'Casual', desc: 'Default — occasional commentary' },
    chatty: { label: 'Chatty', desc: 'Frequent commentary' },
  };
  const DEFAULT_MODE   = 'casual';

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
    quietUntil: 'ecashlive.echan.quietUntil',
    sound:      'ecashlive.echan.sound',
  });
  const LEGACY_KEYS = ['ecashlive.echan.dismissed'];

  const TYPE_MS_PER_CHAR       = 28;
  const ADVANCE_AUTO_MS        = 7000;
  const ADVANCE_MIN_VISIBLE_MS = 1500;
  const PAGE_DOTS_MAX          = 5;

  const SEEN_RING_MAX          = 200;
  const IDLE_SHORT_MS          = 4 * 60 * 1000;
  const IDLE_LONG_MS           = 15 * 60 * 1000;
  const GREET_COOLDOWN_MS      = 4 * 60 * 60 * 1000;
  const NETWORK_POLL_MS        = 30000;
  const NETWORK_BUSY_TPS       = 8;
  const NETWORK_QUIET_TPS      = 0.6;
  const QUIET_HOUR_MS          = 60 * 60 * 1000;

  /* Delay between visibility-return and the wake tick. Lets the browser
   * repaint the page first so the dialogue lands feeling smooth. */
  const WAKE_TICK_DELAY_MS     = 500;

  const GLITCH_TOTAL_MS = 320;
  const GLITCH_SWAP_MS  = 140;
  const SPRITE_VARIANT_CAP = 20;

  const SOUND_MASTER_GAIN          = 0.15;
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
    lockedEmotion: null,
    /* Glitch timers */
    glitchSwapTimer: null,
    glitchEndTimer: null,
    /* Visibility / persistence */
    shown: false,
    mode: DEFAULT_MODE,
    deskpos: DESKPOS_PERCH,
    soundEnabled: false,
    settingsOpen: false,
    quickActionsOpen: false,
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
    categoryDefaults: {},      /* category → default emotion name */
    seenIds: null,
    lastInteraction: Date.now(),
    contentTimer: null,
    /* Network polling */
    networkTimer: null,
    lastNetState: 'normal',
    /* Audio */
    audioCtx: null,
    audioMasterGain: null,
    lastTypeBlipAt: 0,
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
  function ensureAudio() {
    if (state.audioCtx) return state.audioCtx;
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
  function canPlaySound() {
    return state.soundEnabled && !isQuietActive();
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
      /* count of 0 is legal — means "no art yet, use fallback chain in
       * setEmotion". Required for the 3 new emotions to participate in
       * dialogue routing even before sprites exist. */
      if (Number.isInteger(v) && v >= 0 && v <= SPRITE_VARIANT_CAP) counts[name] = v;
      else                                                          counts[name] = (EMOTIONS[name].fallback ? 0 : 1);
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
        text: MODES[k].label,
        'data-mode': k,
        onclick: (e) => { e.stopPropagation(); setMode(k); },
      });
      modeRow.appendChild(btn);
    }

    const soundBtn = el('button', {
      class: 'echan-settings-soundbtn',
      type: 'button',
      text: state.soundEnabled ? 'On' : 'Off',
      'aria-pressed': String(state.soundEnabled),
      onclick: (e) => { e.stopPropagation(); toggleSound(); },
    });
    state.soundBtn = soundBtn;

    return el('div', { class: 'echan-settings', role: 'menu' },
      el('div', { class: 'echan-settings-title', text: 'settings' }),
      el('div', { class: 'echan-settings-row' },
        /* "Chat mode" → "Chattiness" — describes the axis being controlled
         * rather than a generic feature category. */
        el('div', { class: 'echan-settings-label', text: 'Chattiness' }),
        modeRow,
      ),
      el('div', { class: 'echan-settings-row echan-settings-row-inline' },
        el('div', { class: 'echan-settings-label', text: 'Sound' }),
        soundBtn,
      ),
    );
  }

  function buildQuickActions() {
    return el('div', { class: 'echan-quickactions', role: 'menu' },
      el('button', { class: 'echan-qa-btn', type: 'button', text: 'Stats',
        title: 'Open Network Statistics popover',
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); qaStats(); } }),
      el('button', { class: 'echan-qa-btn', type: 'button', text: 'Latest block',
        title: 'Open the most recent block popover',
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); qaLatestBlock(); } }),
      el('button', { class: 'echan-qa-btn', type: 'button', text: 'Tip the project',
        title: 'Open the tip dialog',
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); qaTip(); } }),
      el('button', { class: 'echan-qa-btn', type: 'button', text: 'Quiet for 1 hour',
        title: 'Mute eChan for an hour',
        onclick: (e) => { e.stopPropagation(); closeQuickActions(); qaQuietHour(); } }),
    );
  }

  function onAvatarClick(e) {
    e.stopPropagation();
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
    pushMessage({
      id: pick.id,
      category: pick.category,
      priority: 2,
      emotion: resolveEmotionForLine(pick) || 'celebrate',
      text: pick.text,
    });
    markSeen(pick.id);
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
        if (state.footerTarget) { wireObs(); update(); }
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
  function show() {
    state.shown = true;
    state.root.classList.add('echan-shown');
    pulseRailOff();
    lsSet(STORAGE.shown, '1');
    if (!state.activeMessage && state.queue.length) showNextMessage();
  }
  function hide() {
    state.shown = false;
    state.root.classList.remove('echan-shown');
    closeSettings();
    closeQuickActions();
    lsSet(STORAGE.shown, '0');
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
    setDeskPos(state.deskpos === DESKPOS_FOOTER ? DESKPOS_PERCH : DESKPOS_FOOTER);
  }

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
      state.queue = state.queue.filter(m => m.priority >= 3);
      refreshPageDots();
    }
    /* Restart engine timer at the new cadence (or stop scheduling
     * altogether if the new mode is quiet). scheduleContentTick
     * internally consults CONTENT_TICK_INTERVAL[state.mode]. */
    scheduleContentTick();
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
  function qaQuietHour() {
    lsSet(STORAGE.quietUntil, String(Date.now() + QUIET_HOUR_MS));
    state.queue = state.queue.filter(m => m.priority >= 3 || m.source === 'owner');
    refreshPageDots();
    hide();
  }
  function isQuietActive() {
    const until = parseInt(lsGet(STORAGE.quietUntil, '0'), 10) || 0;
    return until > Date.now();
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
    const requestedName = name;

    /* Walk fallback chain until we find a non-empty pool or run out. */
    let resolvedName = name;
    let pool = state.sprites[resolvedName];
    while ((!pool || !pool.length) && EMOTIONS[resolvedName] && EMOTIONS[resolvedName].fallback) {
      resolvedName = EMOTIONS[resolvedName].fallback;
      pool = state.sprites[resolvedName];
    }
    if (!pool || !pool.length) return;   /* nothing usable — bail silently */

    /* Pick variant from the RESOLVED pool. */
    let idx = 0;
    if (typeof opts.variant === 'number' && opts.variant >= 0 && opts.variant < pool.length) {
      idx = opts.variant;
    } else if (pool.length > 1) {
      const last = state.lastVariantIdx[resolvedName];
      do { idx = Math.floor(Math.random() * pool.length); }
      while (idx === last);
    }
    state.lastVariantIdx[resolvedName] = idx;

    const next = pool[idx];
    const prev = state.activeSprite;
    if (next === prev) {
      /* Same sprite — still update intent name in case caller wants the
       * semantic state to change without a visual swap. */
      state.currentEmotion = requestedName;
      return;
    }

    state.currentEmotion = requestedName;

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
  function pushMessage(msg) {
    if (isQuietActive() && msg.source !== 'owner') return;
    if (state.mode === 'quiet'  && msg.priority < 3) return;
    if (state.mode === 'casual' && msg.priority < 2) return;
    state.queue.push(msg);
    state.queue.sort((a, b) => (b.priority || 1) - (a.priority || 1));
    refreshPageDots();
    if (state.shown && !state.activeMessage) showNextMessage();
    else if (!state.shown && msg.priority >= 3) pulseRailOn();
  }

  function showNextMessage() {
    const msg = state.queue.shift();
    if (!msg) { state.activeMessage = null; refreshPageDots(); return; }
    state.activeMessage = msg;

    state.root.classList.remove('echan-pri-3', 'echan-pri-owner');
    if (msg.source === 'owner')      state.root.classList.add('echan-pri-owner');
    else if (msg.priority >= 3)      state.root.classList.add('echan-pri-3');

    state.textCat.textContent = msg.category ? '· ' + msg.category : '';
    state.lockedEmotion = msg.emotion || 'neutral';
    setEmotion(state.lockedEmotion);
    playArrival();

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
    state.textAdvance.classList.add('visible');
    clearTimeout(state.advanceTimer);
    const dwell = (state.activeMessage && state.activeMessage.dwellMs) || ADVANCE_AUTO_MS;
    state.advanceTimer = setTimeout(advance, dwell);
  }
  function advance() {
    clearTimeout(state.advanceTimer);
    state.textAdvance.classList.remove('visible');
    state.root.classList.remove('echan-pri-3', 'echan-pri-owner');
    state.lockedEmotion = null;
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
    if (state.typewriterTimer) finishTypewriter();
    else if (Date.now() - state.advanceArmedAt >= ADVANCE_MIN_VISIBLE_MS) advance();
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
  async function loadSeed() {
    let data = null;
    try {
      const res = await fetch(SEED_URL, { cache: 'no-cache' });
      if (res.ok) {
        data = await res.json();
      } else {
        console.warn('[eChan] seed.json fetch failed:', res.status);
      }
    } catch (e) {
      console.warn('[eChan] seed.json fetch error:', e && e.message);
    }
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
  function persistSeenRing() {
    try {
      const arr = Array.from(state.seenIds);
      while (arr.length > SEEN_RING_MAX) arr.shift();
      lsSet(STORAGE.seen, arr.join(','));
    } catch (e) {}
  }
  function markSeen(id) {
    if (!id || !state.seenIds) return;
    if (state.seenIds.has(id)) state.seenIds.delete(id);
    state.seenIds.add(id);
    while (state.seenIds.size > SEEN_RING_MAX) {
      const first = state.seenIds.values().next().value;
      state.seenIds.delete(first);
    }
    persistSeenRing();
  }

  function isLineEligible(line) {
    if (!line) return false;
    if (line.ttlOnce && state.seenIds && state.seenIds.has(line.id)) return false;
    return true;
  }

  function weightedPick(candidates) {
    if (!candidates || !candidates.length) return null;
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

    const pick = weightedPick(candidates);
    if (!pick) return;

    pushMessage({
      id: pick.id, category: pick.category, priority: pick.priority || 1,
      emotion: resolveEmotionForLine(pick), text: pick.text,
    });
    markSeen(pick.id);
    lsSet(STORAGE.greeted, String(Date.now()));
    lsSet(STORAGE.visits, String(visits + 1));
  }

  /* contentTick — runs at the cadence set by CONTENT_TICK_INTERVAL[mode].
   * Self-schedules at the end so wake-from-sleep can call it directly
   * without double-scheduling. Bails cheaply in quiet mode (engine off). */
  function contentTick() {
    /* Schedule next tick first — keeps cadence steady regardless of
     * whether this tick produced output. scheduleContentTick is a no-op
     * in quiet mode (returns early without setting a timer). */
    scheduleContentTick();

    if (state.mode === 'quiet') return;
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
    if (!pool.length) return;

    const pick = weightedPick(pool);
    if (!pick) return;

    pushMessage({
      id: pick.id, category: pick.category, priority: pick.priority || 1,
      emotion: resolveEmotionForLine(pick), text: pick.text,
    });
    markSeen(pick.id);
  }

  function scheduleContentTick() {
    clearTimeout(state.contentTimer);
    const interval = CONTENT_TICK_INTERVAL[state.mode];
    if (!interval) return;   /* quiet mode → engine off */
    const [min, max] = interval;
    const delay = min + Math.random() * (max - min);
    state.contentTimer = setTimeout(contentTick, delay);
  }

  /* ===========================================================================
   * NETWORK POLLER
   * =========================================================================*/
  function pollNetwork() {
    if (document.hidden || isQuietActive()) { scheduleNetworkPoll(); return; }
    const tpsEl = document.getElementById('f-tps');
    if (!tpsEl) { scheduleNetworkPoll(); return; }
    const txt = tpsEl.textContent.trim();
    const tps = parseFloat(txt);
    if (isNaN(tps)) { scheduleNetworkPoll(); return; }

    let now = 'normal';
    if (tps > NETWORK_BUSY_TPS)        now = 'busy';
    else if (tps < NETWORK_QUIET_TPS)  now = 'quiet';

    if (now !== state.lastNetState && now !== 'normal') {
      const trigger = (now === 'busy') ? 'network:busy' : 'network:quiet';
      const pool = (state.seedByTrigger[trigger] || []).filter(isLineEligible);
      if (pool.length) {
        const pick = weightedPick(pool);
        if (pick) {
          pushMessage({
            id: pick.id, category: pick.category, priority: pick.priority || 1,
            emotion: resolveEmotionForLine(pick), text: pick.text,
          });
          markSeen(pick.id);
        }
      }
    }
    state.lastNetState = now;
    scheduleNetworkPoll();
  }
  function scheduleNetworkPoll() {
    clearTimeout(state.networkTimer);
    state.networkTimer = setTimeout(pollNetwork, NETWORK_POLL_MS);
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
    } else {
      /* Resume work. Finish any in-progress typewriter so the message
       * isn't half-revealed when the user returns. */
      if (state.activeMessage) finishTypewriter();
      scheduleNetworkPoll();
      /* Wake-from-sleep: fire an immediate content tick after a brief
       * settle delay, rather than waiting the full mode cadence. The
       * tick self-schedules the next one at normal cadence, so no
       * double-tick risk. Eliminates the long silence after returning
       * from a hidden tab. */
      setTimeout(contentTick, WAKE_TICK_DELAY_MS);
    }
  }
  function onDocClick(e) {
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
          push: pushMessage,
          pulseOn:  pulseRailOn,
          pulseOff: pulseRailOff,
          tick: contentTick,
          clearSeen: () => { state.seenIds.clear(); persistSeenRing(); },
          clearQuiet: () => { lsRemove(STORAGE.quietUntil); },
          forceGreet: () => { lsRemove(STORAGE.greeted); maybeGreet(); },
          triggerEaster,
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

    state.seenIds = loadSeenRing();

    const manifestPromise = loadSpriteManifest();
    const seedPromise = loadSeed();

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

    publishApi();

    seedPromise.then(() => {
      setTimeout(maybeGreet, 500);
      scheduleContentTick();
      scheduleNetworkPoll();
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
