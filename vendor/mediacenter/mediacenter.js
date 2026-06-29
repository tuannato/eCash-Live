/* =============================================================================
 * mediacenter.js — eCash Live "Media center" external module
 * Phase 1: UI shell / scaffold (panel, cards, dim, eChan coordination).
 *
 * A sibling external module to the eChan companion. Loaded under
 * script-src 'self' (no CSP hash), it SELF-INJECTS all of its DOM and never
 * touches the CSP-hashed inline module in index.html. It talks to the page only
 * through two small, well-defined seams:
 *   - the play tab (.mc-tab) and the eChan quick-action both call
 *     window.__mediaCenter.open();
 *   - eChan position/visibility is driven through window.__echan (a tiny control
 *     API echan.js exposes) — NOT through the display-only __echanBus.
 *
 * Geometry is MEASURED, never hardcoded: the panel mirrors the #section-messages
 * (grid col 4) rect; the dim scrim/content insets come from the live .topbar /
 * .footer / .echan-root rects, so the top bar and footer stay lit and the lesson
 * content stops exactly at eChan's top edge.
 *
 * Phase 2 wires the real eChanLesson iframe (lazy) + media controls; Phase 3
 * wires the youtube-nocookie facade. Phase 1 renders labelled placeholders so
 * the full interaction (slide-in, dim, eChan move/hide, restore) is reviewable.
 * ===========================================================================*/
(() => {
  'use strict';

  const VERSION = 'mediacenter 0.1.0 (Phase 1 scaffold)';

  /* eChan's desktop position transition is 380ms (--ec-anim-pos). When we send
   * her to the footer for a lesson we wait this out before revealing the lesson
   * content, so it lands exactly above her settled top edge (req #10). */
  const LESSON_REVEAL_MS = 420;
  const MOBILE_BP = 939;
  const LS_OPENED = 'ecashlive.mc.opened';
  const LS_MUTED  = 'ecashlive.mc.muted';   // lesson music mute preference

  /* ===========================================================================
   * CONTENT CATALOGUE — EDIT THIS to add/remove content. Nothing else to touch.
   *
   * Card fields:
   *   id     unique slug. Also the deep-link (?mc=<id>) and the art filename.
   *   kind   'lesson' → plays the eChanLesson animation (Phase 2)
   *          'series' → shows an episode list; each episode plays a YouTube video
   *   tag    little chip label (e.g. 'Lesson', 'Series')
   *   title  heading      desc  1–2 sentence blurb      meta  small mono footnote
   *   img    card art → vendor/mediacenter/cards/<id>.webp
   *          WebP · landscape 3:2 (~960×640) · focal subject on the RIGHT
   *          (left ~40% fades into the text). Missing file → placeholder shows.
   *   episodes  (series only) — array of:
   *          { n, title, yt, img }
   *          n     episode number
   *          title episode title
   *          yt    YouTube video ID — the bit after "watch?v=" or "youtu.be/",
   *                e.g. https://youtu.be/dQw4w9WgXcQ  →  the id is dQw4w9WgXcQ
   *                Leave null until you have it. When set, the episode plays in a
   *                privacy-friendly youtube-nocookie player; nothing contacts
   *                Google until the viewer actually clicks that episode.
   *          title / img  OPTIONAL. Run `node vendor/mediacenter/fetch-yt.js`
   *                once and the TITLE + a self-hosted 16:9 thumbnail are pulled
   *                from the id (→ yt-meta.json + cards/yt-<id>.jpg) and used
   *                automatically — you only need `yt`. The title/img written
   *                here are just fallbacks. To supply art by hand instead:
   *                WebP · 16:9 (~640×360 — standard YouTube thumb ratio).
   *          Add as many episodes as you want — the list scrolls.
   *
   * Add a whole new series: copy the 'whycrypto' object, give it a new id + art,
   * and list its episodes. The UI is fully data-driven — no code changes needed.
   * =========================================================================*/
  const CARDS = [
    {
      id: 'avalanche', kind: 'lesson', tag: 'Lesson',
      title: 'Avalanche consensus',
      desc: 'A guided, animated walkthrough of how eCash reaches pre- and ' +
            'post-consensus finality — narrated live by eChan.',
      meta: 'Interactive · ~5 min',
      img: './vendor/mediacenter/cards/avalanche.webp',
      // eChan presenter script, per scene. <base>.<lang>.json (falls back to .en).
      narrationBase: './vendor/mediacenter/lesson-avalanche',
    },
    {
      id: 'whycrypto', kind: 'series', tag: 'Series',
      title: 'Why crypto series',
      desc: 'Short episodes on why decentralized, sound digital money matters — ' +
            'and where eCash fits.',
      meta: 'Video series',
      img: './vendor/mediacenter/cards/whycrypto.webp',
      episodes: [
        // ↓ paste the YouTube ID into `yt`, then run `node vendor/mediacenter/fetch-yt.js`
        //   — title + thumbnail auto-fill (self-hosted). title/img below are fallbacks.
        { n: 1, title: 'What problem does crypto actually solve?', yt: 'meB5gOLYfIs', img: './vendor/mediacenter/cards/whycrypto-ep1.webp' },
        { n: 2, title: 'Money, trust, and why decentralization',   yt: 'd9pc0B5bgtI', img: './vendor/mediacenter/cards/whycrypto-ep2.webp' },
        { n: 3, title: 'Where eCash fits',                         yt: 'M9MimPfj-8A', img: './vendor/mediacenter/cards/whycrypto-ep3.webp' },
        { n: 4, title: 'Avalanche, in plain words',                yt: 'loyAApr_FA0', img: './vendor/mediacenter/cards/whycrypto-ep4.webp' },
        { n: 5, title: 'Using eCash day to day',                   yt: 'gKzy3rgAyC0', img: './vendor/mediacenter/cards/whycrypto-ep5.webp' },
        { n: 6, title: '', yt: 'Tf020EUz6tw' },
        { n: 7, title: '', yt: 'mC1Dspc0FPE' },
        { n: 8, title: '', yt: 'Klj79uQf7Cw' },
        { n: 9, title: '', yt: '9mMMloxbwRg' },
      ],
    },
  ];

  /* ---------------------------------------------------------------------------
   * tiny DOM helper (same shape as echan.js el())
   * -------------------------------------------------------------------------*/
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];   // trusted, module-authored only
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    for (const c of kids) { if (c == null) continue; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return e;
  }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }
  const isMobile = () => window.matchMedia && window.matchMedia('(max-width: ' + MOBILE_BP + 'px)').matches;

  /* play-triangle glyph reused for the tab + episode rows */
  const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  /* Inline SVG media-control glyphs (not font glyphs — consistent cross-platform,
   * per the project's eye/spinner convention). */
  const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  const PREV_SVG  = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 6h2v12H7zM20 6v12L9 12z"/></svg>';
  const NEXT_SVG  = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15 6h2v12h-2zM4 6l11 6L4 18z"/></svg>';
  const RESTART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>';
  const VOL_ON_SVG  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.7 5.3a9 9 0 0 1 0 13.4"/></svg>';
  const VOL_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  // Fullscreen toggle (corners-out = enter, corners-in = exit).
  const FS_ENTER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
  const FS_EXIT_SVG  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M16 21v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';

  /* Deployed lesson docs (copied from internal/). Loaded lazily — only when the
   * Avalanche card is clicked. Same-origin, so we drive them via their global
   * window.__echanLesson / window.SCENES (no postMessage needed). */
  // Bump LESSON_V whenever the lesson files change so browsers fetch the new
  // copy (the iframe src isn't covered by index.html's ?v= cache token).
  const LESSON_V = '2';
  const LESSON_SRC = {
    mobile:  './vendor/mediacenter/lessons/eChanLesson.html?v=' + LESSON_V,
    desktop: './vendor/mediacenter/lessons/eChanLesson-wide.html?v=' + LESSON_V,
  };
  /* Optional background music for the lesson (you supply the file). MP3,
   * stereo ~96–128kbps. Loops while the lesson plays; the mute button toggles it.
   * Missing file → simply no music (the button is harmless). */
  const MUSIC_SRC = './vendor/mediacenter/lesson-music.mp3';

  /* Right-side art layer with the left→right fade. Shows a placeholder gradient
   * until the real .webp loads (probe-then-swap), so a missing file degrades
   * cleanly. Shared by the home cards and the episode cards. */
  function buildArt(imgUrl) {
    const art = el('div', { class: 'mc-card-art mc-art-placeholder' });
    if (imgUrl) {
      const probe = new Image();
      probe.onload = () => { art.style.backgroundImage = 'url("' + imgUrl + '")'; art.classList.remove('mc-art-placeholder'); };
      probe.src = imgUrl;
    }
    return art;
  }

  const state = {
    built: false,
    open: false,
    view: 'home',        // 'home' | 'series'
    currentSeries: null, // the series card whose episode list is showing (for Back)
    playing: null,       // null | 'lesson' | 'media'
    nodes: {},
    ytMeta: {},          // { '<ytId>': { title, img } } from fetch-yt.js (optional)
    lesson: null,        // { iframe, ctl, scenes, curIdx, hold, poll } while a lesson runs
    ytGuard: null,       // YouTube playback watchdog (reveals the watch-link on failure)
    ytLinkEl: null,      // the "Watch on YouTube" fallback link element, when shown
  };

  /* Load the auto-generated YouTube metadata (titles + self-hosted thumbnails)
   * if present. Same-origin fetch (connect-src 'self'); absent file → episodes
   * just fall back to their manual title/img. See vendor/mediacenter/fetch-yt.js. */
  function loadYtMeta() {
    try {
      fetch('./vendor/mediacenter/yt-meta.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => { if (m && typeof m === 'object') state.ytMeta = m; })
        .catch(() => {});
    } catch (e) {}
  }

  /* ---------------------------------------------------------------------------
   * geometry — all measured from live rects
   * -------------------------------------------------------------------------*/
  function rectOf(sel) {
    const n = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return (r.width || r.height) ? r : null;
  }
  function topbarBottom() { const r = rectOf('.topbar'); return r ? Math.round(r.bottom) : 0; }
  // Top of the stats row (block/online/price = row 2). Mobile fullscreen climbs
  // up to here so it covers the stats but leaves row 1 (brand/LIVE/menu) lit.
  function statsRowTop() { const r = rectOf('.meta'); return r ? Math.round(r.top) : topbarBottom(); }
  function footerHeight() {
    const r = rectOf('.footer');
    if (r) return Math.round(r.height);
    const v = getComputedStyle(document.documentElement).getPropertyValue('--footer-h');
    return parseInt(v, 10) || 44;
  }
  /* Panel target = the col-4 onchain panel rect; fall back to a right strip. */
  function targetRect() {
    const top = topbarBottom();
    const fH = footerHeight();
    // Mobile: a CONSISTENT panel regardless of which dashboard tab (new/mempool/
    // msg…) is active — measuring #section-messages there gives a different size
    // per tab. Always span topbar-bottom → footer-top, fixed width.
    if (isMobile()) {
      const w = Math.min(440, Math.round(window.innerWidth * 0.94));
      return { left: window.innerWidth - w, top, width: w, height: window.innerHeight - top - fH };
    }
    const r = rectOf('#section-messages');
    if (r && r.width > 40 && r.height > 40) return r;
    const w = Math.min(440, Math.round(window.innerWidth * 0.92));
    return { left: window.innerWidth - w, top, width: w, height: window.innerHeight - top - fH };
  }

  function positionPanel() {
    const r = targetRect();
    const p = state.nodes.panel.style;
    p.left = r.left + 'px';
    p.top = r.top + 'px';
    p.width = r.width + 'px';
    p.height = r.height + 'px';
  }

  /* Scrim + content insets. mode: 'lesson' stops content at eChan's top edge;
   * 'media' fills the whole dimmed area. The scrim always meets the panel's
   * left edge and leaves the top bar + footer lit. */
  function positionScrimAndContent(mode) {
    const mob = isMobile();
    const fH = footerHeight();
    // Fullscreen lesson: edge-to-edge, cover the panel + controls; on mobile also
    // climb over the stats row. eChan keeps floating on top (z above content).
    const fs = mode === 'lesson' && state.lesson && state.lesson.fullscreen;
    const top = (fs && mob) ? statsRowTop() : topbarBottom();
    const panelLeft = Math.round(targetRect().left);
    // On mobile the panel is hidden during playback (full-width content); on
    // desktop windowed it stops at the panel's left edge (req #9/#10); fullscreen
    // covers the panel too → no right inset.
    const rightInset = (mob || fs) ? 0 : Math.max(0, window.innerWidth - panelLeft);
    const m = fs ? 0 : (mob ? 12 : 14);

    const s = state.nodes.scrim.style;
    s.top = top + 'px';
    s.right = rightInset + 'px';
    s.bottom = fH + 'px';
    s.left = '0px';

    const c = state.nodes.content.style;
    c.top = (top + m) + 'px';
    c.left = m + 'px';
    c.right = (rightInset + m) + 'px';
    if (mode === 'lesson') {
      // Stop at eChan's settled top (measured after her move) — fall back to a
      // sensible gap above the footer if she isn't present. On mobile windowed,
      // reserve a band above her for the controls (between content and dialog).
      const ech = rectOf('.echan-root');
      const bottomY = ech ? Math.round(window.innerHeight - ech.top) : (fH + 200);
      if (fs) {
        // Mobile: down to eChan's top (she sits at the footer). Desktop: all the
        // way to the footer top — eChan floats over the content's bottom-left.
        c.bottom = (mob ? bottomY : fH) + 'px';
      } else {
        const band = mob ? 92 : 0;
        c.bottom = (bottomY + band + m) + 'px';
      }
    } else {
      c.bottom = (fH + m) + 'px';
    }
  }

  function reflow() {
    if (!state.open) return;
    positionPanel();
    if (state.playing) { positionScrimAndContent(state.playing); positionControls(); }
  }

  /* ---------------------------------------------------------------------------
   * build (once) + inject
   * -------------------------------------------------------------------------*/
  function build() {
    if (state.built) return;

    const scrim = el('div', { class: 'mc-scrim', 'aria-hidden': 'true',
      onclick: () => stopPlaying() });

    const contentClose = el('button', { class: 'mc-content-close', type: 'button',
      title: 'Close', 'aria-label': 'Close content', html: '✕', onclick: () => stopPlaying() });
    // Dim fullscreen toggle — shown only while a lesson plays (CSS gates on
    // .mc-content.mc-lesson). Returns the lesson to the windowed layout.
    const contentFs = el('button', { class: 'mc-content-fs', type: 'button',
      title: 'Exit fullscreen', 'aria-label': 'Toggle fullscreen', html: FS_EXIT_SVG,
      onclick: () => toggleFullscreen() });
    const contentInner = el('div', { class: 'mc-content-inner' });
    const content = el('div', { class: 'mc-content', role: 'region', 'aria-label': 'Media content' },
      contentFs, contentClose, contentInner);

    const back = el('button', { class: 'mc-panel-back', type: 'button', title: 'Back',
      'aria-label': 'Back', html: '‹', onclick: () => goBack() });
    const title = el('div', { class: 'mc-panel-title' },
      el('span', { class: 'mc-accent', text: 'Media' }), ' center');
    const close = el('button', { class: 'mc-panel-close', type: 'button', title: 'Close',
      'aria-label': 'Close media center', html: '✕', onclick: () => closePanel() });
    const head = el('div', { class: 'mc-panel-head' }, back, title, close);

    const body = el('div', { class: 'mc-panel-body' });
    const panel = el('div', { class: 'mc-panel', role: 'dialog', 'aria-label': 'Media center', 'aria-modal': 'false' }, head, body);

    // Lesson media controls (shown only while a lesson plays). Lives in the
    // dimmed gap — desktop: right of eChan; mobile: between content and dialog.
    const ctlIdx  = el('span', { class: 'mc-ctl-idx',  text: '01/15' });
    const ctlName = el('span', { class: 'mc-ctl-name', text: '' });
    const ctlFill = el('i', { class: 'mc-ctl-fill' });
    const ctlPlay = el('button', { class: 'mc-ctl mc-ctl-play', type: 'button', title: 'Play / Pause', 'aria-label': 'Play / Pause', html: PLAY_SVG, onclick: ctlPlayPause });
    const ctlMute = el('button', { class: 'mc-ctl mc-ctl-mute', type: 'button', title: 'Mute music', 'aria-label': 'Mute music', html: VOL_ON_SVG, onclick: ctlToggleMute });
    // Background music element (file supplied later; missing → just silent).
    const audio = el('audio', { class: 'mc-audio', src: MUSIC_SRC, loop: '', preload: 'none' });
    const controls = el('div', { class: 'mc-controls', role: 'group', 'aria-label': 'Lesson controls' },
      el('div', { class: 'mc-ctl-meta' }, ctlIdx, ctlName),
      el('div', { class: 'mc-ctl-bar' }, ctlFill),
      el('div', { class: 'mc-ctl-btns' },
        el('button', { class: 'mc-ctl mc-ctl-restart', type: 'button', title: 'Restart from beginning', 'aria-label': 'Restart from beginning', html: RESTART_SVG, onclick: ctlRestart }),
        el('button', { class: 'mc-ctl mc-ctl-back', type: 'button', title: 'Previous chapter', 'aria-label': 'Previous chapter', html: PREV_SVG, onclick: ctlBack }),
        ctlPlay,
        el('button', { class: 'mc-ctl mc-ctl-next', type: 'button', title: 'Next chapter', 'aria-label': 'Next chapter', html: NEXT_SVG, onclick: ctlNext }),
        ctlMute,
      ),
    );

    // Mount into eChan's parent (#stage-wrap) so the dim + content share her
    // stacking context — eChan is appended there (echan.js init), and #stage-wrap
    // is position:fixed (its own stacking context). At document.body level her
    // z-index could never rise above a body-level scrim, so she'd be dimmed.
    // #stage-wrap has no transform, so it does NOT clip our position:fixed
    // layers; and the footer is a body sibling that paints above #stage-wrap,
    // so it stays lit without any clamping.
    const host = document.getElementById('stage-wrap') || document.body;
    host.appendChild(scrim);
    host.appendChild(content);
    host.appendChild(controls);
    host.appendChild(audio);
    host.appendChild(panel);

    state.nodes = { scrim, content, contentInner, contentFs, panel, body, head, title, back,
      controls, ctlIdx, ctlName, ctlFill, ctlPlay, ctlMute, audio };
    state.built = true;

    window.addEventListener('resize', reflow, { passive: true });
    document.addEventListener('keydown', (e) => {
      if (!state.open) return;
      if (e.key === 'Escape') { if (state.playing || state.view === 'series') goBack(); else closePanel(); }
    });
  }

  /* ---------------------------------------------------------------------------
   * views
   * -------------------------------------------------------------------------*/
  function renderHome() {
    state.view = 'home';
    state.currentSeries = null;
    const body = state.nodes.body;
    body.textContent = '';
    for (const card of CARDS) {
      const art = buildArt(card.img);
      const info = el('div', { class: 'mc-card-info' },
        el('span', { class: 'mc-card-tag', text: card.tag }),
        el('div', { class: 'mc-card-title', text: card.title }),
        el('p', { class: 'mc-card-desc', text: card.desc }),
        el('div', { class: 'mc-card-meta', text: card.meta }),
      );
      const cardEl = el('button', { class: 'mc-card', type: 'button', 'data-card': card.id,
        onclick: () => openCard(card) }, art, info);
      body.appendChild(cardEl);
    }
    setPlayingChrome(false);
  }

  function renderSeries(card) {
    state.view = 'series';
    state.currentSeries = card;     // so Back from a playing episode returns here
    state.nodes.title.textContent = '';
    state.nodes.title.append(el('span', { class: 'mc-accent', text: card.title }));
    const body = state.nodes.body;
    body.textContent = '';
    const list = el('div', { class: 'mc-episodes' });
    card.episodes.forEach((ep) => {
      // Auto-fill title + thumbnail from fetch-yt.js output when available;
      // otherwise fall back to the manual title/img in the catalogue.
      const m = (ep.yt && state.ytMeta[ep.yt]) || {};
      const epTitle = m.title || ep.title;
      const epImg = m.img || ep.img;
      // Same art-with-fade look as the home cards, but a shorter card (title only).
      const art = buildArt(epImg);
      const info = el('div', { class: 'mc-ecard-info' },
        el('span', { class: 'mc-ecard-num', text: 'EP ' + String(ep.n).padStart(2, '0') + (ep.yt ? '' : ' · soon') }),
        el('div', { class: 'mc-ecard-title', text: epTitle }),
      );
      const play = el('span', { class: 'mc-ecard-play', html: PLAY_SVG });
      list.appendChild(el('button', { class: 'mc-ecard', type: 'button', 'data-ep': ep.n,
        onclick: () => playEpisode(card, ep) }, art, info, play));
    });
    body.appendChild(list);
    setPlayingChrome(true);     // show the Back arrow
  }

  function setPlayingChrome(on) {
    state.nodes.panel.classList.toggle('mc-playing', !!on);
  }

  /* ---------------------------------------------------------------------------
   * actions
   * -------------------------------------------------------------------------*/
  function openCard(card) {
    if (state.playing) stopPlaying();   // tear down any running lesson/video first
    if (card.kind === 'lesson') enterLesson(card);
    else if (card.kind === 'series') renderSeries(card);
  }

  function enterLesson(card) {
    state.playing = 'lesson';
    setPlayingChrome(true);
    state.nodes.title.textContent = '';
    state.nodes.title.append(el('span', { class: 'mc-accent', text: card.title }));

    // eChan stays visible but drops to the footer; her up-toggle is disabled.
    try { window.__echan && window.__echan.enterLessonMode && window.__echan.enterLessonMode(); } catch (e) {}

    if (isMobile()) state.nodes.panel.classList.add('mc-tucked');   // free the screen for content

    // Lazy: the lesson doc (~580KB) is fetched only now, on click. Mobile vs
    // desktop variant by breakpoint. Same-origin → we drive it via its global
    // window.__echanLesson / window.SCENES once its React app has mounted.
    const iframe = el('iframe', {
      src: isMobile() ? LESSON_SRC.mobile : LESSON_SRC.desktop,
      title: card.title, loading: 'eager',
    });
    // Fullscreen is the default on open (req: cover stats row + media buttons,
    // panel; eChan keeps floating). Toggle returns to the windowed layout.
    state.lesson = { iframe, ready: false, scenes: [], curIdx: 0, poll: null, narration: null, lastNarrated: -1, fullscreen: true };
    state.nodes.content.classList.add('mc-lesson');   // reveals the fullscreen toggle
    loadNarration(card.narrationBase);
    startMusic();
    showContent(iframe);
    state.nodes.scrim.classList.add('mc-on');
    state.nodes.controls.classList.add('mc-on');
    applyFullscreen();                                 // sets classes + positions
    state.nodes.content.classList.add('mc-on');
    waitForLessonApi(iframe);
    // Reveal after her slide settles so the box lands above her top edge (req #10).
    setTimeout(() => {
      if (state.playing === 'lesson') {
        applyFullscreen();
        state.nodes.content.classList.add('mc-shown');
        state.nodes.controls.classList.add('mc-shown');
      }
    }, LESSON_REVEAL_MS);
  }

  /* Flip the lesson between fullscreen (default) and the windowed layout. In
   * fullscreen the content goes edge-to-edge over the panel + media controls
   * (mobile: also over the stats row); eChan stays floating on top. */
  function toggleFullscreen() {
    if (!state.lesson) return;
    state.lesson.fullscreen = !state.lesson.fullscreen;
    applyFullscreen();
  }
  function applyFullscreen() {
    if (state.playing !== 'lesson' || !state.lesson) return;
    const fs = !!state.lesson.fullscreen;
    state.nodes.content.classList.toggle('mc-fs', fs);
    state.nodes.controls.classList.toggle('mc-fs-hide', fs);   // CSS hides controls
    // Desktop: hide the Media-center panel under fullscreen (mobile is already
    // tucked for the whole lesson). Re-shows it on exit.
    if (!isMobile()) state.nodes.panel.classList.toggle('mc-tucked', fs);
    const b = state.nodes.contentFs;
    if (b) { b.innerHTML = fs ? FS_EXIT_SVG : FS_ENTER_SVG; b.title = fs ? 'Exit fullscreen' : 'Fullscreen'; }
    positionScrimAndContent('lesson');
    positionControls();
  }

  /* Read the lesson's control API FRESH on every call. The lesson reassigns
   * window.__echanLesson on each render (its effect deps include time/playing),
   * so a captured reference would FREEZE getTime()/getPlaying() — that was why
   * the play/pause icon never flipped. Setters are stable; getters must be live. */
  function lessonApi() {
    const L = state.lesson;
    if (!L || !L.iframe) return null;
    try { return (L.iframe.contentWindow && L.iframe.contentWindow.__echanLesson) || null; } catch (e) { return null; }
  }

  /* Poll for the lesson's API + SCENES (set after its React app mounts), then
   * start playback + wire the live readout. */
  function waitForLessonApi(iframe) {
    let tries = 0;
    const tick = () => {
      if (state.playing !== 'lesson' || !state.lesson || state.lesson.iframe !== iframe) return;
      let api, scenes;
      try { const w = iframe.contentWindow; api = w && w.__echanLesson; scenes = w && w.SCENES; } catch (e) {}
      if (api && scenes && scenes.length) {
        state.lesson.ready = true;
        state.lesson.scenes = scenes;
        onLessonReady();
        return;
      }
      if (tries++ < 80) setTimeout(tick, 100);
    };
    tick();
  }

  function onLessonReady() {
    const api = lessonApi();
    if (api) { try { api.play(); } catch (e) {} }     // autostart like a video
    updateControls();
    state.lesson.poll = setInterval(updateControls, 250);
  }

  /* Re-read shortly after an action so the icon/readout reflect React's just-
   * committed state without waiting for the next 250ms poll tick. */
  function nudgeControls() { setTimeout(updateControls, 80); }

  /* eChan presenter narration: load <base>.<lang>.json (fallback .en), then push
   * one line into eChan's dialog as the lesson advances scenes (req #13). */
  function loadNarration(base) {
    if (!base || !state.lesson) return;
    const lang = lsGet('ecashlive.lang', 'en') || 'en';
    const urls = (lang && lang !== 'en') ? [base + '.' + lang + '.json', base + '.en.json'] : [base + '.en.json'];
    (function attempt(i) {
      if (i >= urls.length || !state.lesson) return;
      fetch(urls[i], { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => { if (state.lesson && d && d.lines) state.lesson.narration = d; })
        .catch(() => attempt(i + 1));
    })(0);
  }
  function pushNarration(idx) {
    const n = state.lesson && state.lesson.narration;
    const line = n && n.lines && n.lines[idx];
    if (!line) return;
    const emo = (n.emotions && n.emotions[idx]) || 'neutral';
    try {
      // Instant, queue-free presenter channel (interrupts immediately) so scene
      // changes / next-back-restart flip eChan's line at once. See echan.js.
      if (window.__echan && window.__echan.presentLine) window.__echan.presentLine(line, emo);
    } catch (e) {}
  }

  /* Live readout (scene title/index, progress, play icon) + hold-loop. */
  function updateControls() {
    const L = state.lesson;
    const api = lessonApi();
    if (!L || !api) return;
    let t = 0, dur = 169, playing = false;
    try { t = api.getTime() || 0; dur = api.getDuration() || 169; playing = !!api.getPlaying(); } catch (e) { return; }
    let idx = 0;
    for (let i = 0; i < L.scenes.length; i++) { if (t >= L.scenes[i].t) idx = i; else break; }
    L.curIdx = idx;
    if (L.narration && idx !== L.lastNarrated) { L.lastNarrated = idx; pushNarration(idx); }
    const n = state.nodes;
    n.ctlIdx.textContent = String(idx + 1).padStart(2, '0') + '/' + String(L.scenes.length).padStart(2, '0');
    n.ctlName.textContent = (L.scenes[idx] && L.scenes[idx].title) || '';
    n.ctlFill.style.width = (dur > 0 ? Math.min(100, (t / dur) * 100) : 0) + '%';
    n.ctlPlay.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  }

  function ctlPlayPause() { const api = lessonApi(); if (!api) return; try { api.toggle(); } catch (e) {} updateControls(); nudgeControls(); }
  function ctlRestart() {
    const api = lessonApi(); if (!api) return;
    try { api.seek(0); api.play(); } catch (e) {}      // lesson back to the start
    const a = state.nodes.audio;                        // and restart the music too
    if (a) { try { a.currentTime = 0; if (!a.muted && a.paused) { const p = a.play(); if (p && p.catch) p.catch(() => {}); } } catch (e) {} }
    updateControls(); nudgeControls();
  }
  function ctlBack() {
    const L = state.lesson; const api = lessonApi(); if (!L || !api) return;
    let t = 0; try { t = api.getTime() || 0; } catch (e) {}
    const sc = L.scenes[L.curIdx];
    // >2s into the chapter → restart it; otherwise jump to the previous chapter.
    const target = (sc && t - sc.t > 2) ? sc.t : L.scenes[Math.max(0, L.curIdx - 1)].t;
    try { api.seek(target); api.play(); } catch (e) {}
    updateControls(); nudgeControls();
  }
  function ctlNext() {
    const L = state.lesson; const api = lessonApi(); if (!L || !api) return;
    const ni = Math.min(L.scenes.length - 1, L.curIdx + 1);
    try { api.seek(L.scenes[ni].t); api.play(); } catch (e) {}
    updateControls(); nudgeControls();
  }
  /* Background-music helpers — the mute button toggles state.nodes.audio. */
  function updateMuteBtn() {
    const a = state.nodes.audio;
    const muted = !!(a && a.muted);
    state.nodes.ctlMute.innerHTML = muted ? VOL_OFF_SVG : VOL_ON_SVG;
    state.nodes.ctlMute.classList.toggle('mc-ctl-muted', muted);
    state.nodes.ctlMute.title = muted ? 'Unmute music' : 'Mute music';
    state.nodes.ctlMute.setAttribute('aria-label', muted ? 'Unmute music' : 'Mute music');
  }
  function startMusic() {
    const a = state.nodes.audio;
    if (!a) return;
    a.muted = lsGet(LS_MUTED, '0') === '1';
    try { a.currentTime = 0; } catch (e) {}
    // Called within the card-click gesture, so autoplay is permitted; a missing
    // music file just rejects harmlessly.
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
    updateMuteBtn();
  }
  function stopMusic() {
    const a = state.nodes.audio;
    if (a) { try { a.pause(); } catch (e) {} }
  }
  function ctlToggleMute() {
    const a = state.nodes.audio;
    if (!a) return;
    a.muted = !a.muted;
    lsSet(LS_MUTED, a.muted ? '1' : '0');
    // Unmuting while paused (e.g. the file was added after load) → try to start
    // it now; this is still inside the click gesture.
    if (!a.muted && a.paused) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
    updateMuteBtn();
  }

  /* Place the controls in the leftover dim area (req #12): desktop → the gap to
   * the RIGHT of eChan's window; mobile → between the content and her dialog. */
  function positionControls() {
    if (state.playing !== 'lesson' || !state.nodes.controls) return;
    const cs = state.nodes.controls.style;
    const content = state.nodes.content.getBoundingClientRect();
    const ech = rectOf('.echan-root');
    const echTop = ech ? ech.top : (window.innerHeight - 160);
    if (isMobile()) {
      cs.left = Math.round(content.left) + 'px';
      cs.width = Math.round(content.width) + 'px';
      cs.top = Math.round((content.bottom + echTop) / 2) + 'px';
    } else {
      const echRight = ech ? ech.right : 540;
      const echMid = ech ? (ech.top + ech.height / 2) : (window.innerHeight - 120);
      const left = Math.round(echRight + 16);
      cs.left = left + 'px';
      cs.width = Math.max(170, Math.round(content.right - left - 8)) + 'px';
      cs.top = Math.round(echMid) + 'px';
    }
  }

  function playEpisode(card, ep) {
    if (state.playing) stopPlaying();   // never stack a video on a running lesson/video
    state.playing = 'media';
    setPlayingChrome(true);
    state.nodes.title.textContent = '';
    state.nodes.title.append(el('span', { class: 'mc-accent', text: 'Ep ' + ep.n }), ' · ' + card.title);

    // Full media: eChan fully hidden + her rail toggle hidden.
    try { window.__echan && window.__echan.enterMediaMode && window.__echan.enterMediaMode(); } catch (e) {}

    if (isMobile()) state.nodes.panel.classList.add('mc-tucked');   // free the screen for content
    // Click-to-load: the iframe (and the first contact with Google) is created
    // ONLY now, because the viewer explicitly clicked this episode. Uses the
    // privacy-enhanced youtube-nocookie host. No id yet → labelled placeholder.
    if (ep.yt) {
      const src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(ep.yt)
        + '?rel=0&modestbranding=1&playsinline=1&autoplay=1&enablejsapi=1&origin='
        + encodeURIComponent(location.origin);
      const iframe = el('iframe', {
        src, title: ep.title,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        referrerpolicy: 'strict-origin-when-cross-origin',
      });
      showContent(iframe);
      setupYtFallback(iframe, ep.yt);   // reveal a "Watch on YouTube" link only if it never plays
    } else {
      showContent(mediaPlaceholder(ep));
    }
    state.nodes.scrim.classList.add('mc-on');
    positionScrimAndContent('media');
    state.nodes.content.classList.add('mc-on');
    requestAnimationFrame(() => state.nodes.content.classList.add('mc-shown'));
  }

  /* If a YouTube embed never starts (e.g. YouTube's "confirm you're not a robot"
   * gate on a flagged IP), surface a "Watch on YouTube ↗" fallback link. We can't
   * read the cross-origin iframe, so we use YouTube's IFrame-API postMessage: a
   * playing/buffering state cancels the fallback; otherwise a ~5s timer (or an
   * error) reveals the link. Scoped to the current video; cleared in stopPlaying. */
  function setupYtFallback(iframe, id) {
    clearYtFallback();
    const g = { iframe, id, started: false, timer: null, onMsg: null, onLoad: null };
    state.ytGuard = g;
    g.onLoad = () => {
      try {
        iframe.contentWindow.postMessage(
          JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
          'https://www.youtube-nocookie.com');
      } catch (e) {}
    };
    iframe.addEventListener('load', g.onLoad);
    g.onMsg = (e) => {
      if (state.ytGuard !== g) return;
      if (typeof e.origin !== 'string' || e.origin.indexOf('youtube') === -1) return;
      let d = e.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (x) { return; } }
      if (!d) return;
      const ps = (d.info && typeof d.info === 'object') ? d.info.playerState
        : (typeof d.info === 'number' ? d.info : undefined);
      if (ps === 1 || ps === 3) { g.started = true; hideYtLink(); }   // playing / buffering
      else if (d.event === 'onError') showYtLink(g.id);
    };
    window.addEventListener('message', g.onMsg);
    g.timer = setTimeout(() => { if (state.ytGuard === g && !g.started) showYtLink(g.id); }, 5000);
  }
  function clearYtFallback() {
    const g = state.ytGuard;
    if (!g) { hideYtLink(); return; }
    if (g.timer) clearTimeout(g.timer);
    if (g.onMsg) window.removeEventListener('message', g.onMsg);
    if (g.onLoad && g.iframe) g.iframe.removeEventListener('load', g.onLoad);
    state.ytGuard = null;
    hideYtLink();
  }
  function showYtLink(id) {
    if (state.ytLinkEl || state.playing !== 'media') return;
    const a = el('a', { class: 'mc-yt-link', target: '_blank', rel: 'noopener',
      href: 'https://www.youtube.com/watch?v=' + encodeURIComponent(id),
      html: 'Watch on YouTube <span aria-hidden="true">↗</span>' });
    state.ytLinkEl = a;
    state.nodes.content.appendChild(a);
  }
  function hideYtLink() {
    if (state.ytLinkEl && state.ytLinkEl.parentNode) state.ytLinkEl.parentNode.removeChild(state.ytLinkEl);
    state.ytLinkEl = null;
  }

  function showContent(node) {
    const inner = state.nodes.contentInner;   // clear only the inner, keep the close button
    inner.textContent = '';
    inner.appendChild(node);
  }

  function stopPlaying() {
    if (!state.playing) return;
    state.playing = null;
    if (state.lesson) {                          // stop the readout poll
      if (state.lesson.poll) clearInterval(state.lesson.poll);
      state.lesson = null;
    }
    stopMusic();
    clearYtFallback();                            // drop the YouTube watch-link timer/listener
    // Stop the media IMMEDIATELY — removing the iframe now kills YouTube/lesson
    // playback at once (no audio tail). The empty box then fades out.
    state.nodes.contentInner.textContent = '';
    state.nodes.content.classList.remove('mc-shown', 'mc-fs', 'mc-lesson');
    state.nodes.controls.classList.remove('mc-on', 'mc-shown', 'mc-fs-hide');
    state.nodes.scrim.classList.remove('mc-on');
    setTimeout(() => { if (!state.playing) state.nodes.content.classList.remove('mc-on'); }, 280);
    try { window.__echan && window.__echan.exitMode && window.__echan.exitMode(); } catch (e) {}
    state.nodes.panel.classList.remove('mc-tucked');   // un-tuck (mobile)
  }

  function goHome() {
    if (state.playing) stopPlaying();
    state.nodes.title.textContent = '';
    state.nodes.title.append(el('span', { class: 'mc-accent', text: 'Media' }), ' center');
    renderHome();
    state.nodes.panel.classList.remove('mc-tucked');   // un-tuck (mobile)
  }

  /* Context-aware Back: always stops whatever is playing first. From a series
   * episode it returns to that episode list; otherwise to the library. */
  function goBack() {
    if (state.playing === 'media' && state.currentSeries) {
      const series = state.currentSeries;
      stopPlaying();
      renderSeries(series);
      return;
    }
    goHome();   // goHome() also stops any playing lesson
  }

  function open() {
    build();
    if (state.open) { reflow(); return; }
    state.open = true;
    renderHome();
    positionPanel();
    requestAnimationFrame(() => state.nodes.panel.classList.add('mc-on'));
    markTab(true);
    lsSet(LS_OPENED, '1');
    document.querySelectorAll('.mc-tab').forEach((t) => t.classList.remove('mc-tab-pulse'));
  }

  function closePanel() {
    if (!state.open) return;
    if (state.playing) stopPlaying();
    state.open = false;
    state.nodes.panel.classList.remove('mc-on');
    state.nodes.panel.classList.remove('mc-tucked');
    markTab(false);
  }

  function markTab(active) {
    document.querySelectorAll('.mc-tab').forEach((t) => t.classList.toggle('mc-tab-active', !!active));
  }

  /* Placeholder shown for a series episode that has no YouTube id yet. */
  function mediaPlaceholder(ep) {
    return el('div', { class: 'mc-placeholder' },
      el('span', { class: 'mc-ph-badge', text: 'Phase 3' }),
      el('div', { class: 'mc-ph-title', text: 'Episode ' + ep.n }),
      el('p', { class: 'mc-ph-sub', text: ep.title + ' — a click-to-load youtube-nocookie player will fill this dimmed '
        + 'area. eChan is hidden while video plays and restores to her previous position on close.' }),
    );
  }

  /* ---------------------------------------------------------------------------
   * wire entry points + boot
   * -------------------------------------------------------------------------*/
  function wireTab() {
    const tabs = document.querySelectorAll('.mc-tab');   // desktop (#msg-tabs) + mobile (#mobile-tabs)
    const fresh = !lsGet(LS_OPENED, '');
    tabs.forEach((tab) => {
      if (fresh) tab.classList.add('mc-tab-pulse');
      tab.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); state.open ? closePanel() : open(); });
    });
  }

  window.__mediaCenter = {
    open, close: closePanel, isOpen: () => state.open,
    isPlaying: () => state.playing !== null,   // true during lesson OR video playback
    version: VERSION,
  };

  /* Deep-link: ?mc=open opens the library; ?mc=<cardId> opens + plays a card
   * (e.g. ?mc=avalanche). Delayed so eChan has finished its async init and the
   * control API has a live state.root to drive. */
  function handleDeepLink() {
    let raw;
    try { raw = new URLSearchParams(location.search).get('mc'); } catch (e) { return; }
    if (!raw) return;
    // ?mc=open · ?mc=<id> (open a card) · ?mc=<seriesId>:<epN> (play an episode)
    const [id, epStr] = String(raw).split(':');
    const card = CARDS.find(c => c.id === id);
    const epN = epStr ? parseInt(epStr, 10) : null;
    let tries = 0;
    const go = () => {
      // If playing a card that coordinates eChan, wait until eChan's DOM is
      // built so the control API can actually drive her (avoids a startup race).
      const echReady = !window.__echan || !window.__echan.isReady || window.__echan.isReady();
      if (card && !echReady && tries++ < 40) { setTimeout(go, 150); return; }
      open();
      if (!card) return;
      if (card.kind === 'series' && epN) {
        const ep = (card.episodes || []).find(e => e.n === epN);
        if (ep) { renderSeries(card); playEpisode(card, ep); return; }
      }
      openCard(card);
    };
    setTimeout(go, 300);
  }

  function init() {
    wireTab();
    loadYtMeta();
    handleDeepLink();
    console.log('[mediacenter] ready', VERSION);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
