/* eCash Live — finality report (/finality/)
 * ---------------------------------------------------------------------------
 * Draws the per-day finality series from api.ecashlive.net/history.
 *
 * External and same-origin on purpose: script-src is 'self', so this file
 * costs no CSP hash, unlike the pinned inline modules on the other two pages.
 * Keep it that way — an inline <script> here would add a third hash to
 * regenerate and a third way to ship a blank page.
 *
 * The chart is hand-rolled SVG. There is no chart library option: CSP is
 * default-src 'none' with no CDN, and everything ships self-hosted. SVG over
 * canvas because it themes from CSS variables for free, prints and scales
 * cleanly, and needs no animation frame — the dashboard already spends one on
 * the radar.
 *
 * The rule that shapes most of the code below: a day the relay did not record
 * is a HOLE, not a value. It is never interpolated, the line breaks across it,
 * and the legend says so. Drawing a smooth line through a day nobody measured
 * would invent exactly the kind of number this project refuses to print.
 */
(() => {
  'use strict';

  const API = 'https://api.ecashlive.net/history';
  const DAY_MS = 86400000;

  // The response shape is versioned server-side (API_VERSION rides in the edge
  // cache key), but a BROWSER caches by URL, and that key has no version in it.
  // api.ecashlive.net/history?days=30 is the exact URL neo and Flow have been
  // fetching all along, and the edge hands it out with a four-hour browser TTL.
  // So a visitor whose browser stored the pre-series response kept serving it
  // from disk, and this page reported "no series" while the API was answering
  // correctly — observed live, not theorised.
  //
  // Sending the version makes the URL distinct for browsers. It costs nothing
  // at the edge: routeOf() builds the cache key from only what the handler
  // actually reads, so an extra parameter still maps to one entry. Bump it when
  // the fields this page depends on change.
  const API_V = 4;

  const el = (id) => document.getElementById(id);
  const state = { days: 30, data: null, busy: false };

  /* ------------------------------------------------------------- utilities */

  // Dates arrive as UTC "YYYY-MM-DD" from our own rollup. Gate the shape anyway
  // before it reaches markup or Date parsing — the discipline is cheap and the
  // alternative is trusting a string because it is usually fine.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const dayNum = (d) => {
    if (!DATE_RE.test(d)) return null;
    const t = Date.parse(d + 'T00:00:00Z');
    return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDay = (d) => {
    const [y, m, dd] = d.split('-');
    return `${MON[+m - 1]} ${+dd}`;
  };
  const fmtDayYear = (d) => `${fmtDay(d)}, ${d.slice(0, 4)}`;

  // Seconds, one decimal under a minute — the same shape the dashboard footer
  // uses, so the two never disagree about the same figure.
  const fmtSec = (ms) => {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'min';
  };
  const fmtInt = (n) => (typeof n === 'number' && isFinite(n))
    ? n.toLocaleString('en-US') : '—';
  // Axis labels only. The readout still shows the exact count — an axis is for
  // reading a magnitude off, a tooltip is for reading the number.
  const compact = (n) => {
    if (!(n > 0)) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  };

  /* --------------------------------------------------------------- scaling */

  // Round the axis top up to something a person would choose, so gridlines land
  // on readable numbers instead of 4.37s.
  function niceTop(max) {
    if (!(max > 0)) return 1000;
    const steps = [500, 1000, 2000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
    for (const s of steps) {
      if (max <= s * 4) return Math.ceil(max / s) * s;
    }
    return Math.ceil(max / 600000) * 600000;
  }
  function ticksFor(top) {
    const n = 4;
    const out = [];
    for (let i = 0; i <= n; i++) out.push((top / n) * i);
    return out;
  }

  /* -------------------------------------------------------------- segments */

  // Split the series into runs of CONSECUTIVE recorded days. A break here is
  // what stops the line being drawn across a day we have no record for.
  function segment(series, field = 'p50Ms') {
    const segs = [];
    let cur = [];
    let prev = null;
    for (const r of series) {
      const dn = dayNum(r.date);
      const usable = dn !== null && typeof r[field] === 'number';
      if (!usable) { if (cur.length) { segs.push(cur); cur = []; } prev = null; continue; }
      if (prev !== null && dn !== prev + 1) { if (cur.length) segs.push(cur); cur = []; }
      cur.push({ ...r, dn });
      prev = dn;
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  /* ----------------------------------------------------------------- chart */

  function drawChart() {
    const host = el('chart');
    const d = state.data;
    if (!host) return;

    if (!d || !Array.isArray(d.series) || !d.series.length) return;

    const pts = d.series.filter((r) => dayNum(r.date) !== null);
    if (!pts.length) { host.innerHTML = '<div class="cw-msg">No usable days in the record.</div>'; return; }

    const W = Math.max(320, host.clientWidth || 640);
    const H = W < 520 ? 240 : 320;
    const PAD = { t: 14, r: 14, b: 26, l: W < 520 ? 38 : 46 };
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;

    const d0 = dayNum(pts[0].date);
    const d1 = dayNum(pts[pts.length - 1].date);
    const span = Math.max(1, d1 - d0);
    const X = (dn) => PAD.l + ((dn - d0) / span) * iw;

    // y always starts at zero. For a duration a truncated baseline exaggerates
    // ordinary variation into drama, which is the visual version of the number
    // inflation this project spends its effort avoiding.
    let peak = 0;
    for (const r of pts) {
      for (const v of [r.p90Ms, r.p50Ms]) if (typeof v === 'number' && v > peak) peak = v;
    }
    const top = niceTop(peak);
    const Y = (ms) => PAD.t + ih - (Math.min(ms, top) / top) * ih;

    const segs = segment(pts);
    const parts = [];

    // gridlines + y labels
    for (const tv of ticksFor(top)) {
      const y = Y(tv).toFixed(1);
      parts.push(`<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`);
      parts.push(`<text x="${PAD.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" font-family="'Fira Code',monospace" font-size="10" fill="rgba(255,255,255,0.34)">${esc(fmtSec(tv))}</text>`);
    }

    // p10-p90 band, one polygon per contiguous run
    for (const seg of segs) {
      const band = seg.filter((r) => typeof r.p10Ms === 'number' && typeof r.p90Ms === 'number');
      if (band.length < 2) continue;
      const up = band.map((r) => `${X(r.dn).toFixed(1)},${Y(r.p90Ms).toFixed(1)}`);
      const dn = band.slice().reverse().map((r) => `${X(r.dn).toFixed(1)},${Y(r.p10Ms).toFixed(1)}`);
      parts.push(`<polygon points="${up.concat(dn).join(' ')}" fill="rgba(1,160,224,0.17)" stroke="rgba(1,160,224,0.34)" stroke-width="1"/>`);
    }

    // p50 line — one polyline per run, so gaps stay gaps
    for (const seg of segs) {
      if (seg.length === 1) {
        const r = seg[0];
        parts.push(`<circle cx="${X(r.dn).toFixed(1)}" cy="${Y(r.p50Ms).toFixed(1)}" r="2.6" fill="#29b6f0"/>`);
        continue;
      }
      const line = seg.map((r) => `${X(r.dn).toFixed(1)},${Y(r.p50Ms).toFixed(1)}`).join(' ');
      parts.push(`<polyline points="${line}" fill="none" stroke="#29b6f0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }

    // x labels — a handful, always including both ends
    const want = W < 520 ? 3 : Math.min(6, pts.length);
    const idxs = new Set([0, pts.length - 1]);
    for (let i = 1; i < want - 1; i++) idxs.add(Math.round((pts.length - 1) * (i / (want - 1))));
    for (const i of [...idxs].sort((a, b) => a - b)) {
      const r = pts[i];
      const anchor = i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
      parts.push(`<text x="${X(dayNum(r.date)).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" font-family="'Fira Code',monospace" font-size="10" fill="rgba(255,255,255,0.34)">${esc(fmtDay(r.date))}</text>`);
    }

    // hover guide, moved by JS
    parts.push(`<line id="fc-guide" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + ih}" stroke="rgba(255,255,255,0.22)" stroke-width="1" opacity="0"/>`);
    parts.push(`<circle id="fc-dot" cx="0" cy="0" r="3.6" fill="#29b6f0" stroke="#08080f" stroke-width="1.5" opacity="0"/>`);

    const label = `Median time to finality, ${pts.length} days from ${fmtDayYear(pts[0].date)} to ${fmtDayYear(pts[pts.length - 1].date)}.`;
    host.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${parts.join('')}</svg>`;

    const row = (k, v, cls) => `<div class="r-row ${cls || ''}"><span>${k}</span><b>${esc(v)}</b></div>`;
    wireHover(host, pts, X, (r) => Y(r.p50Ms),
      { guide: 'fc-guide', dot: 'fc-dot', box: 'readout', wrap: 'chart-wrap' },
      (r) => row('p90', fmtSec(r.p90Ms)) + row('median', fmtSec(r.p50Ms), 'r-p50')
           + row('p10', fmtSec(r.p10Ms)) + row('tx', fmtInt(r.samples)));
    buildTable(pts);
  }

  /* ------------------------------------------- volume + under-3s combo chart */

  // Bars are the day's transaction count, the line is the share finalised
  // within 3s. Pairing them is the point: a median that slipped on a day the
  // network was idle says something different from the same median under load,
  // and a lone trend line cannot tell you which happened.
  function drawVolume() {
    const host = el('vol');
    const d = state.data;
    if (!host || !d || !Array.isArray(d.series)) return;

    const pts = d.series.filter((r) => dayNum(r.date) !== null);
    if (!pts.length) { host.innerHTML = '<div class="cw-msg">No usable days in the record.</div>'; return; }

    const W = Math.max(320, host.clientWidth || 640);
    const H = W < 520 ? 200 : 260;
    const PAD = { t: 14, r: W < 520 ? 38 : 52, b: 26, l: W < 520 ? 34 : 42 };
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;

    const d0 = dayNum(pts[0].date), d1 = dayNum(pts[pts.length - 1].date);
    const span = Math.max(1, d1 - d0);
    const X = (dn) => PAD.l + ((dn - d0) / span) * iw;

    // Left axis is the share, 0-100, fixed. A share axis that rescales to the
    // data makes 97% and 62% look identical, which is the opposite of useful.
    const YP = (frac) => PAD.t + ih - Math.max(0, Math.min(1, frac)) * ih;
    // Right axis is volume, its own nice top.
    let vmax = 0;
    for (const r of pts) if (typeof r.samples === 'number' && r.samples > vmax) vmax = r.samples;
    const vtop = vmax > 0 ? Math.ceil(vmax / Math.pow(10, String(Math.round(vmax)).length - 2))
                            * Math.pow(10, String(Math.round(vmax)).length - 2) : 1;
    const YV = (n) => PAD.t + ih - (Math.min(n, vtop) / vtop) * ih;

    const withU3 = pts.filter((r) => typeof r.under3s === 'number');
    const parts = [];

    for (let i = 0; i <= 4; i++) {
      const frac = i / 4, y = YP(frac).toFixed(1);
      parts.push(`<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`);
      parts.push(`<text x="${PAD.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" font-family="'Fira Code',monospace" font-size="10" fill="rgba(255,255,255,0.34)">${Math.round(frac * 100)}%</text>`);
      parts.push(`<text x="${W - PAD.r + 8}" y="${y}" text-anchor="start" dominant-baseline="middle" font-family="'Fira Code',monospace" font-size="10" fill="rgba(255,255,255,0.22)">${esc(compact(vtop * frac))}</text>`);
    }

    // bars — width from the real day spacing, so a gap stays visibly empty
    const bw = Math.max(2, Math.min(22, (iw / (span + 1)) * 0.66));
    for (const r of pts) {
      if (typeof r.samples !== 'number') continue;
      const x = X(dayNum(r.date)) - bw / 2, y = YV(r.samples);
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(PAD.t + ih - y).toFixed(1)}" fill="rgba(1,160,224,0.30)" stroke="rgba(1,160,224,0.45)" stroke-width="0.75" rx="1.5"/>`);
    }

    // under-3s line, broken across days that carry no figure
    for (const seg of segment(withU3, 'under3s')) {
      if (seg.length === 1) {
        parts.push(`<circle cx="${X(seg[0].dn).toFixed(1)}" cy="${YP(seg[0].under3s).toFixed(1)}" r="2.6" fill="#00e781"/>`);
        continue;
      }
      const line = seg.map((r) => `${X(r.dn).toFixed(1)},${YP(r.under3s).toFixed(1)}`).join(' ');
      parts.push(`<polyline points="${line}" fill="none" stroke="#00e781" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }

    const want = W < 520 ? 3 : Math.min(6, pts.length);
    const idxs = new Set([0, pts.length - 1]);
    for (let i = 1; i < want - 1; i++) idxs.add(Math.round((pts.length - 1) * (i / (want - 1))));
    for (const i of [...idxs].sort((a, b) => a - b)) {
      const r = pts[i];
      const anchor = i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
      parts.push(`<text x="${X(dayNum(r.date)).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" font-family="'Fira Code',monospace" font-size="10" fill="rgba(255,255,255,0.34)">${esc(fmtDay(r.date))}</text>`);
    }

    parts.push(`<line id="vc-guide" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + ih}" stroke="rgba(255,255,255,0.22)" stroke-width="1" opacity="0"/>`);
    parts.push(`<circle id="vc-dot" cx="0" cy="0" r="3.6" fill="#00e781" stroke="#08080f" stroke-width="1.5" opacity="0"/>`);

    const label = `Transactions per day as bars, and the share finalised within three seconds as a line, over ${pts.length} days.`;
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${parts.join('')}</svg>`;

    const row = (k, v, cls) => `<div class="r-row ${cls || ''}"><span>${k}</span><b>${esc(v)}</b></div>`;
    wireHover(host, pts, X, (r) => (typeof r.under3s === 'number' ? YP(r.under3s) : null),
      { guide: 'vc-guide', dot: 'vc-dot', box: 'vol-readout', wrap: 'vol-wrap' },
      (r) => row('tx', fmtInt(r.samples))
           + row('&lt; 3s', typeof r.under3s === 'number' ? (r.under3s * 100).toFixed(1) + '%' : 'not recorded', 'r-u3'));

    // Say plainly when the line is absent rather than leaving an empty axis.
    const note = document.getElementById('vol-note');
    if (note) note.remove();
    if (!withU3.length) {
      const n = document.createElement('div');
      n.id = 'vol-note';
      n.className = 'chart-note';
      n.textContent = 'The under-3s share is not in the record for these days. '
        + 'The relay began writing it per day only recently, and rows already '
        + 'written are never rewritten — so the line starts from the first day '
        + 'that carries it rather than being reconstructed backwards.';
      host.parentElement.parentElement.appendChild(n);
    }
  }

  /* ----------------------------------------------------------------- hover */

  // Shared by both charts. `rows` renders the body for whichever chart called
  // it; everything else — nearest-RECORDED-day snapping, the guide, keeping the
  // box inside the panel — is identical and should not be written twice.
  function wireHover(host, pts, X, Y, ids, rows) {
    const svg = host.querySelector('svg');
    const guide = host.querySelector('#' + ids.guide);
    const dot = host.querySelector('#' + ids.dot);
    const box = el(ids.box);
    const wrap = el(ids.wrap);
    if (!svg || !box || !wrap) return;

    const hide = () => { box.classList.remove('on'); guide.setAttribute('opacity', '0'); dot.setAttribute('opacity', '0'); };

    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / svg.viewBox.baseVal.width;
      const x = (ev.clientX - rect.left) / scale;
      // nearest recorded day — never the nearest *position*, so hovering over a
      // gap snaps to a day that exists rather than inventing one.
      let best = null, bestD = Infinity;
      for (const r of pts) {
        const dx = Math.abs(X(dayNum(r.date)) - x);
        if (dx < bestD) { bestD = dx; best = r; }
      }
      if (!best) return hide();

      const px = X(dayNum(best.date)), py = Y(best);
      guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.setAttribute('opacity', '1');
      if (py == null) { dot.setAttribute('opacity', '0'); }
      else { dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('opacity', '1'); }

      box.innerHTML = `<div class="r-date">${esc(fmtDayYear(best.date))}</div>` + rows(best);
      box.classList.add('on');

      // keep the box inside the panel
      const bw = box.offsetWidth || 160;
      const left = Math.min(Math.max(px * scale - bw / 2, 4), wrap.clientWidth - bw - 4);
      box.style.left = left + 'px';
      const anchorY = py == null ? svg.viewBox.baseVal.height * 0.35 : py;
      box.style.top = Math.max(4, anchorY * scale - box.offsetHeight - 14) + 'px';
    };

    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', hide);
  }

  /* ------------------------------------------------------------------- a11y */

  // A chart that only exists as pixels is unreadable to a screen reader, and
  // this page's whole purpose is to be checkable. The table carries the same
  // numbers, visually hidden.
  function buildTable(pts) {
    const t = el('chart-table');
    if (!t) return;
    const head = '<thead><tr><th>Date</th><th>p10</th><th>Median</th><th>p90</th><th>Transactions</th></tr></thead>';
    const body = pts.map((r) =>
      `<tr><td>${esc(fmtDayYear(r.date))}</td><td>${esc(fmtSec(r.p10Ms))}</td><td>${esc(fmtSec(r.p50Ms))}</td><td>${esc(fmtSec(r.p90Ms))}</td><td>${esc(fmtInt(r.samples))}</td></tr>`).join('');
    t.innerHTML = '<caption>Daily finality measurements</caption>' + head + '<tbody>' + body + '</tbody>';
  }

  /* ----------------------------------------------------------------- stats */

  function drawStats() {
    const host = el('stats');
    const d = state.data;
    if (!host || !d || !Array.isArray(d.series)) return;
    const withP50 = d.series.filter((r) => typeof r.p50Ms === 'number');
    if (!withP50.length) { host.innerHTML = ''; return; }

    let best = withP50[0], worst = withP50[0];
    for (const r of withP50) {
      if (r.p50Ms < best.p50Ms) best = r;
      if (r.p50Ms > worst.p50Ms) worst = r;
    }
    const totalTx = withP50.reduce((a, r) => a + (typeof r.samples === 'number' ? r.samples : 0), 0);

    const card = (k, v, note, cls) =>
      `<div class="stat ${cls || ''}"><div class="stat-k">${esc(k)}</div>` +
      `<div class="stat-v">${v}</div><div class="stat-note">${esc(note)}</div></div>`;

    host.innerHTML =
      card('Best day', esc(fmtSec(best.p50Ms)), fmtDayYear(best.date), 'good') +
      card('Worst day', esc(fmtSec(worst.p50Ms)), fmtDayYear(worst.date), 'bad') +
      card('Days recorded', esc(String(d.days)), `${fmtDayYear(d.from)} → ${fmtDayYear(d.to)}`) +
      card('Transactions', esc(fmtInt(totalTx)), 'finalised across the window');
  }

  /* ------------------------------------------------------------------ load */

  function message(html) {
    const host = el('chart');
    if (host) host.innerHTML = `<div class="cw-msg">${html}</div>`;
  }

  async function load(days) {
    if (state.busy) return;
    state.busy = true;
    message('Loading…');
    try {
      const r = await fetch(`${API}?days=${encodeURIComponent(days)}&v=${API_V}`);
      const j = await r.json().catch(() => null);

      // "not enough history" is a real answer, not a failure: the endpoint
      // refuses to summarise fewer than seven recorded days. Say that rather
      // than draw a chart from a handful of points.
      if (!r.ok || !j || j.error) {
        message(j && j.error === 'not enough history'
          ? 'Not enough recorded days yet to publish a series.<br>The node needs at least seven.'
          : 'The record is unavailable right now.<br>The live dashboard is unaffected.');
        el('hero-coverage').textContent = 'Record unavailable';
        return;
      }
      if (!Array.isArray(j.series)) {
        message('This deployment of the API does not publish the daily series yet.');
        return;
      }

      state.data = j;
      el('hero-figure').innerHTML = `${esc(fmtSec(j.medianTtfMs)).replace(/(s|min)$/, '')}<span class="unit">${/min$/.test(fmtSec(j.medianTtfMs)) ? 'min' : 's'}</span>`;
      el('hero-coverage').innerHTML =
        `<b>${esc(String(j.days))}</b> days recorded · ${esc(fmtDayYear(j.from))} → ${esc(fmtDayYear(j.to))} · <b>${esc(fmtInt(j.samples))}</b> transactions`;
      el('foot-updated').textContent = `Last recorded day: ${fmtDayYear(j.to)}`;
      drawChart();
      drawVolume();
      drawStats();
    } catch {
      message('Could not reach the record.<br>The live dashboard is unaffected.');
    } finally {
      state.busy = false;
    }
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    const range = el('range');
    if (range) {
      range.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-days]');
        if (!b) return;
        const days = parseInt(b.dataset.days, 10);
        if (!days || days === state.days) return;
        state.days = days;
        for (const x of range.querySelectorAll('button')) {
          x.setAttribute('aria-pressed', String(x === b));
        }
        load(days);
      });
    }

    // Redraw at the new width rather than letting the browser stretch a fixed
    // viewBox — scaled 10px axis labels turn to mush on a phone.
    //
    // Width only. Redrawing changes the SVG's aspect ratio, which changes the
    // host's HEIGHT, which is itself a resize — so reacting to every box change
    // means each redraw schedules the next one. It converges rather than
    // spinning, but a chart that repaints twice for one gesture is a bug
    // waiting to become a loop the first time the layout gets more complicated.
    const host = el('chart');
    let t = 0, lastW = 0;
    if (host) {
      const ro = new ResizeObserver(() => {
        const w = host.clientWidth;
        if (Math.abs(w - lastW) < 2) return;   // height-only change: nothing to do
        lastW = w;
        clearTimeout(t);
        t = setTimeout(() => { if (state.data) { drawChart(); drawVolume(); } }, 120);
      });
      ro.observe(host);
    }

    load(state.days);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
