// ===== Module: liquid =====
// Gooey morph menu for the home screen — a faithful vanilla-JS port of the
// "morphing dropdown" from liquid-taffy:
//   https://github.com/arknow91/liquid-taffy  (MIT, (c) 2026 arknow91)
//
// Ported with permission of the technique: the solved goo-rim thresholds,
// the two spring polylines, the grab chain, the squircle path, and the
// open/close choreography timings are taken verbatim from the reference
// implementation. GSAP/React are replaced by a ~120-line tween engine so
// DeCloud stays dependency-free.
//
// Reduced-motion users get the menu instantly, without physics.

(function () {
  'use strict';

  // ─── Spring / easing curves (sampled piecewise-linear) ──────────
  const HOUSE_SPRING_POINTS = [
    [0.028, 0.0289], [0.056, 0.1062], [0.083, 0.2182], [0.111, 0.3519],
    [0.139, 0.4957], [0.167, 0.6396], [0.194, 0.7755], [0.222, 0.8974],
    [0.25, 1.0013], [0.278, 1.0849], [0.306, 1.1474], [0.333, 1.1896],
    [0.361, 1.213], [0.389, 1.22], [0.417, 1.2134], [0.444, 1.1961],
    [0.472, 1.1714], [0.5, 1.1419], [0.528, 1.1102], [0.556, 1.0786],
    [0.583, 1.0487], [0.611, 1.022], [0.639, 0.9992], [0.667, 0.981],
    [0.694, 0.9673], [0.722, 0.9581], [0.75, 0.9531], [0.778, 0.9516],
    [0.806, 0.9531], [0.833, 0.957], [0.861, 0.9624], [0.889, 0.969],
    [0.917, 0.9759], [0.944, 0.9829], [0.972, 0.9894], [1, 1],
  ];
  const POP_SPRING_POINTS = [
    [0.028, 0.0237], [0.056, 0.0875], [0.083, 0.1806], [0.111, 0.2931],
    [0.139, 0.416], [0.167, 0.5418], [0.194, 0.664], [0.222, 0.7777],
    [0.25, 0.8795], [0.278, 0.967], [0.306, 1.0389], [0.333, 1.0951],
    [0.361, 1.1359], [0.389, 1.1626], [0.417, 1.1767], [0.444, 1.1799],
    [0.472, 1.1742], [0.5, 1.1617], [0.528, 1.1442], [0.556, 1.1235],
    [0.583, 1.1012], [0.611, 1.0786], [0.639, 1.0569], [0.667, 1.0367],
    [0.694, 1.0188], [0.722, 1.0035], [0.75, 0.9911], [0.778, 0.9814],
    [0.806, 0.9745], [0.833, 0.9701], [0.861, 0.968], [0.889, 0.9677],
    [0.917, 0.9689], [0.944, 0.9714], [0.972, 0.9746], [1, 1],
  ];
  const SPRING = (t) => samplePolyline(HOUSE_SPRING_POINTS, t);
  const POP = (t) => samplePolyline(POP_SPRING_POINTS, t);
  const OUT_STRONG = bezier(0.23, 1, 0.32, 1);
  const ANTICIPATE = bezier(0.36, 0, 0.66, -0.56);
  const BACK_OUT = bezier(0.34, 1.6, 0.64, 1);
  const P1_IN = bezier(0.5, 0, 1, 1);
  const P1_OUT = bezier(0, 0, 0.5, 1);
  const P1_INOUT = bezier(0.455, 0.03, 0.515, 0.955);
  const P2_IN = bezier(0.55, 0, 1, 0.45);
  const P2_OUT = bezier(0, 0, 0.45, 1);

  function samplePolyline(points, t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let prev = [0, 0];
    for (let i = 0; i < points.length; i++) {
      if (t <= points[i][0]) {
        const dx = points[i][0] - prev[0];
        const dy = points[i][1] - prev[1];
        return prev[1] + ((t - prev[0]) / dx) * dy;
      }
      prev = points[i];
    }
    return 1;
  }

  function bezier(x1, y1, x2, y2) {
    // Newton-solve cubic bezier for y given x
    const A = (x) => 3 * (1 - x) * (1 - x) * x;
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const et = 1 - t;
        const xv = 3 * et * et * t * x1 + 3 * et * t * t * x2 + t * t * t;
        const dx = 3 * et * et * x1 + 6 * et * t * (x2 - x1) + 3 * t * t * (1 - x2);
        if (Math.abs(xv - x) < 1e-4) break;
        t -= (xv - x) / (dx || 1);
        t = Math.max(0, Math.min(1, t));
      }
      const et = 1 - t;
      return 3 * et * et * t * y1 + 3 * et * t * t * y2 + t * t * t;
    };
  }

  // ─── Tiny tween engine (timeline + transforms) ──────────────────
  const reducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  class Timeline {
    constructor() {
      this._entries = [];
      this._raf = 0;
      this._killed = false;
    }
    set(targets, vars, at) {
      this._entries.push({ at: at || 0, set: true, targets, vars });
      return this;
    }
    to(targets, vars, at) {
      this._entries.push({ at: at || 0, targets, vars });
      return this;
    }
    call(fn, at) {
      this._entries.push({ at: at || 0, fn });
      return this;
    }
    kill() { this._killed = true; if (this._raf) cancelAnimationFrame(this._raf); }
    play() {
      if (reducedMotion) {
        // Instant version: apply final state of every tween and set
        this._entries.forEach((e) => { if (e.fn) e.fn(); else applyVars(e.targets, e.vars, false); });
        return;
      }
      const start = performance.now();
      const step = () => {
        if (this._killed) return;
        const now = (performance.now() - start) / 1000;
        let alive = false;
        for (const e of this._entries) {
          const local = now - e.at;
          if (local < 0) { alive = true; continue; }
          if (e.fn) { if (!e.done) { e.done = true; e.fn(); } continue; }
          if (e.set) {
            if (!e.done) { e.done = true; applyVars(e.targets, e.vars, true); }
            continue;
          }
          const dur = e.vars.duration || 0.3;
          if (local >= dur) {
            if (!e.done) { e.done = true; applyVars(e.targets, e.vars, false); }
            continue;
          }
          alive = true;
          const ease = e.vars.ease || P2_OUT;
          applyVars(e.targets, e.vars, false, ease(Math.min(1, local / dur)));
        }
        if (alive) this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    }
  }

  function applyVars(targets, vars, isSet, t) {
    const list = Array.isArray(targets) ? targets : [targets];
    const k = (isSet || t === undefined) ? 1 : t;
    for (const el of list) {
      if (!el) continue;
      const st = getState(el);
      const v = vars;
      if (v.x !== undefined) st.x = lerp(v.x, st.xFrom || st.x, k);
      if (v.y !== undefined) st.y = lerp(v.y, st.yFrom || st.y, k);
      if (v.rotation !== undefined) st.rotation = lerp(v.rotation, st.rotFrom || st.rotation, k);
      if (v.scale !== undefined) { st.scaleX = st.scaleY = lerp(v.scale, st.scFrom || st.scaleX, k); }
      if (v.scaleX !== undefined) st.scaleX = lerp(v.scaleX, st.sxFrom || st.scaleX, k);
      if (v.scaleY !== undefined) st.scaleY = lerp(v.scaleY, st.syFrom || st.scaleY, k);
      if (v.autoAlpha !== undefined) {
        st.opacity = lerp(v.autoAlpha, st.oFrom || st.opacity, k);
        el.style.visibility = st.opacity > 0.01 ? 'visible' : 'hidden';
      }
      if (v.filter !== undefined) st.filter = v.filter;
      writeState(el, st);
    }
  }

  function getState(el) {
    if (!el._lqd) {
      el._lqd = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, filter: '' };
    }
    return el._lqd;
  }

  function writeState(el, st) {
    let tr = '';
    if (st.x || st.y) tr += `translate(${st.x}px, ${st.y}px) `;
    if (st.rotation) tr += `rotate(${st.rotation}deg) `;
    if (st.scaleX !== 1 || st.scaleY !== 1) tr += `scale(${st.scaleX}, ${st.scaleY})`;
    el.style.transform = tr.trim();
    el.style.opacity = String(st.opacity);
    if (st.filter !== '') el.style.filter = st.filter;
  }

  function lerp(to, from, k) {
    return from + (to - from) * k;
  }

  // ─── Squircle path (Apple continuous corner, PaintCode coeffs) ──
  function squirclePath(x, y, w, h, r) {
    const s = Math.min(r * 1.528665, w / 2, h / 2);
    const u = (k) => s * (k / 1.528665);
    const c = [1.528665, 1.08849, 0.86840, 0.63149, 0.37283, 0.16906, 0.07491].map(u);
    const [c0, c1, c2, c3, c4, c5, c6] = c;
    return [
      `M ${x + c0} ${y}`, `L ${x + w - c0} ${y}`,
      `C ${x + w - c1} ${y} ${x + w - c2} ${y} ${x + w - c3} ${y + c6}`,
      `C ${x + w - c4} ${y + c5} ${x + w - c5} ${y + c4} ${x + w - c6} ${y + c3}`,
      `C ${x + w} ${y + c2} ${x + w} ${y + c1} ${x + w} ${y + c0}`,
      `L ${x + w} ${y + h - c0}`,
      `C ${x + w} ${y + h - c1} ${x + w} ${y + h - c2} ${x + w - c6} ${y + h - c3}`,
      `C ${x + w - c5} ${y + h - c4} ${x + w - c4} ${y + h - c5} ${x + w - c3} ${y + h - c6}`,
      `C ${x + w - c2} ${y + h} ${x + w - c1} ${y + h} ${x + w - c0} ${y + h}`,
      `L ${x + c0} ${y + h}`,
      `C ${x + c1} ${y + h} ${x + c2} ${y + h} ${x + c3} ${y + h - c6}`,
      `C ${x + c4} ${y + h - c5} ${x + c5} ${y + h - c4} ${x + c6} ${y + h - c3}`,
      `C ${x} ${y + h - c2} ${x} ${y + h - c1} ${x} ${y + h - c0}`,
      `L ${x} ${y + c0}`,
      `C ${x} ${y + c1} ${x} ${y + c2} ${x + c6} ${y + c3}`,
      `C ${x + c5} ${y + c4} ${x + c4} ${y + c5} ${x + c3} ${y + c6}`,
      `C ${x + c2} ${y} ${x + c1} ${y} ${x + c0} ${y}`, 'Z',
    ].join(' ');
  }

  // ─── Goo filter ─────────────────────────────────────────────────
  const GOO_RIM_THRESHOLDS = {
    1: [-14.5146, -24.6721],
    4: [-12.25, -14.25],
    5: [-12.7296, -15.063],
  };
  const gooThreshold = (offset) =>
    `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 30 ${offset}`;

  function setGooBlur(els, blur) {
    const [outer, inner] = GOO_RIM_THRESHOLDS[blur];
    if (els.blur) els.blur.setAttribute('stdDeviation', String(blur));
    if (els.rim) els.rim.setAttribute('values', gooThreshold(outer));
    if (els.inner) els.inner.setAttribute('values', gooThreshold(inner));
  }

  // ─── Geometry (verbatim constants from the reference) ───────────
  const BUTTON_SIZE = 32;
  const PANEL_WIDTH = 141;
  const PANEL_HEIGHT = 164;             // 2×7 padding + 5 rows × 30
  const PANEL_ORIGIN_X = PANEL_WIDTH / 2;          // 70.5
  const PANEL_ORIGIN_Y = PANEL_HEIGHT - 16;        // 148
  const PANEL_REST_SCALE = 0.11;
  const GOO_BLUR_ACTIVE = 4;
  const GOO_BLUR_REST = 1;
  const GOO_BLUR_GRAB = 5;
  const GOO_WIDTH = 320;
  const GOO_HEIGHT = 308;
  const TRIGGER_CX = 160;
  const TRIGGER_CY = 220;
  const PANEL_GOO_X = TRIGGER_CX - PANEL_WIDTH / 2;   // 89.5
  const PANEL_GOO_Y = TRIGGER_CY - PANEL_ORIGIN_Y;    // 72
  const GRAB_MAX = 44;
  const GRAB_CHAIN = [
    { follow: 1, size: 0.85, thin: 0.06, lag: 0.16 },
    { follow: 0.84, size: 0.72, thin: 0.16, lag: 0.18 },
    { follow: 0.68, size: 0.65, thin: 0.19, lag: 0.2 },
    { follow: 0.52, size: 0.64, thin: 0.19, lag: 0.22 },
    { follow: 0.36, size: 0.7, thin: 0.14, lag: 0.24 },
    { follow: 0.2, size: 0.8, thin: 0.08, lag: 0.26 },
  ];

  // ─── Sound (tiny synthesized pops; silent until first touch) ────
  const sfx = {
    ctx: null, muted: false,
    ensure() {
      if (this.muted || reducedMotion) return null;
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    pop(freq, dur) {
      const ctx = this.ensure();
      if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(freq * 0.55, ctx.currentTime + dur);
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      o.connect(g).connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + dur);
    },
    mute() { this.muted = true; },
    unmute() { this.muted = false; },
  };

  // ─── Build the widget ───────────────────────────────────────────
  const root = document.getElementById('liquid-fab-root');
  if (!root) return;

  const svgNS = 'http://www.w3.org/2000/svg';
  root.innerHTML = `
    <div class="lqd-anchor">
      <div class="lqd-bodies">
        <div class="lqd-trigger-body"></div>
        <svg class="lqd-panel-body" width="${PANEL_WIDTH}" height="${PANEL_HEIGHT}" viewBox="0 0 ${PANEL_WIDTH} ${PANEL_HEIGHT}">
          <path class="lqd-panel-body-shape" d="${squirclePath(0.5, 0.5, PANEL_WIDTH - 1, PANEL_HEIGHT - 1, 16)}"></path>
        </svg>
      </div>
      <svg class="lqd-goo" width="${GOO_WIDTH}" height="${GOO_HEIGHT}" viewBox="0 0 ${GOO_WIDTH} ${GOO_HEIGHT}" aria-hidden="true">
        <defs>
          <filter id="lqd-goo-filter" filterUnits="userSpaceOnUse" x="0" y="0"
                  width="${GOO_WIDTH}" height="${GOO_HEIGHT}" color-interpolation-filters="sRGB">
            <feGaussianBlur class="lqd-blur" in="SourceGraphic" stdDeviation="${GOO_BLUR_REST}" result="blur"/>
            <feColorMatrix class="lqd-rim" in="blur" type="matrix"
              values="${gooThreshold(GOO_RIM_THRESHOLDS[GOO_BLUR_REST][0])}" result="goo"/>
            <feColorMatrix class="lqd-inner" in="blur" type="matrix"
              values="${gooThreshold(GOO_RIM_THRESHOLDS[GOO_BLUR_REST][1])}" result="inner"/>
            <feFlood style="flood-color: var(--lqd-rim)" result="rimColor"/>
            <feComposite in="rimColor" in2="goo" operator="in" result="rimFull"/>
            <feMerge>
              <feMergeNode in="rimFull"/>
              <feMergeNode in="inner"/>
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#lqd-goo-filter)">
          <path class="lqd-blob lqd-blob-panel" d="${squirclePath(PANEL_GOO_X, PANEL_GOO_Y, PANEL_WIDTH, PANEL_HEIGHT, 16)}"></path>
          <circle class="lqd-blob lqd-blob-trigger" cx="${TRIGGER_CX}" cy="${TRIGGER_CY}" r="16"></circle>
          ${GRAB_CHAIN.map((_l, i) => `<circle class="lqd-chain" data-i="${i}" cx="${TRIGGER_CX}" cy="${TRIGGER_CY}" r="11"></circle>`).join('')}
        </g>
      </svg>
      <div class="lqd-panel" role="menu" aria-label="Quick actions"></div>
      <button class="lqd-trigger" type="button" aria-label="Open menu" aria-expanded="false">
        <span class="lqd-trigger-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </span>
      </button>
    </div>`;

  const anchor = root.querySelector('.lqd-anchor');
  const bodies = root.querySelector('.lqd-bodies');
  const triggerBody = root.querySelector('.lqd-trigger-body');
  const panelBody = root.querySelector('.lqd-panel-body');
  const panelBodyShape = root.querySelector('.lqd-panel-body-shape');
  const goo = root.querySelector('.lqd-goo');
  const blurEl = root.querySelector('.lqd-blur');
  const rimEl = root.querySelector('.lqd-rim');
  const innerEl = root.querySelector('.lqd-inner');
  const blobTrigger = root.querySelector('.lqd-blob-trigger');
  const blobPanel = root.querySelector('.lqd-blob-panel');
  const panel = root.querySelector('.lqd-panel');
  const trigger = root.querySelector('.lqd-trigger');
  const triggerIcon = root.querySelector('.lqd-trigger-icon');
  const chainEls = Array.from(root.querySelectorAll('.lqd-chain'));

  const gooEls = { blur: blurEl, rim: rimEl, inner: innerEl };

  // ─── Menu items (Books-first wedge + essentials) ────────────────
  const THEME_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const ITEMS = [
    { label: 'Books', icon: (window.ICONS && ICONS.book) || '', action: () => openApp('audiobooks') },
    { label: 'AI Chat', icon: (window.ICONS && ICONS.brain) || '', action: () => openApp('ollama') },
    { label: 'Files', icon: (window.ICONS && ICONS.lego) || '', action: () => openApp('files') },
    { label: 'Terminal', icon: (window.ICONS && ICONS.terminal) || '', action: () => openApp('terminal') },
    { label: 'Theme', icon: THEME_ICON, action: toggleThemeQuick },
  ];

  ITEMS.forEach((item, i) => {
    const row = document.createElement('button');
    row.className = 'lqd-item';
    row.setAttribute('role', 'menuitem');
    row.innerHTML = `<span class="lqd-item-icon">${item.icon}</span>
      <span class="lqd-item-inner"><span class="lqd-item-label">${item.label}</span></span>`;
    row.addEventListener('click', () => {
      if (stretch && stretch.consumeClick()) return;
      closeMenu();
      item.action();
    });
    row.addEventListener('pointerenter', () => sfx.pop(880, 0.05));
    panel.appendChild(row);
  });

  // Initial rest states: rows below their slot, chain beads gone
  applyVars(Array.from(panel.querySelectorAll('.lqd-item-inner')), { autoAlpha: 0, y: 10 }, true);
  applyVars(chainEls, { scale: 0 }, true);

  function toggleThemeQuick() {
    fetch('/api/settings/theme').then((r) => r.json()).then((d) => {
      const next = (d.theme || 'auto') === 'dark' ? 'light' : 'dark';
      if (typeof setTheme === 'function') setTheme(next);
    }).catch(() => {});
  }

  // ─── State ──────────────────────────────────────────────────────
  let open = false;
  let tl = null;

  const panelTrio = [panelBody, panel, blobPanel];
  const triggerBits = [blobTrigger, triggerBody];
  const triggerStretchBits = [blobTrigger, triggerBody];

  function liquidOn(blur) {
    anchor.setAttribute('data-liquid', '');
    goo.style.opacity = '1';
    goo.style.visibility = 'visible';
    setGooBlur(gooEls, blur);
    bodies.style.visibility = 'hidden';   // crisp picture steps aside
  }

  function openMenu() {
    if (open) return;
    open = true;
    if (tl) tl.kill();
    tl = new Timeline();

    panelBody.style.visibility = 'visible';
    panel.style.visibility = 'visible';
    blobPanel.style.visibility = 'visible';
    panelBody.style.transformOrigin = `${PANEL_ORIGIN_X}px ${PANEL_ORIGIN_Y}px`;
    panel.style.transformOrigin = `${PANEL_ORIGIN_X}px ${PANEL_ORIGIN_Y}px`;

    tl.set(panelTrio, { x: 0, y: 0 }, 0);
    tl.set(chainEls, { x: 0, y: 0, scale: 0 }, 0);
    tl.to(triggerStretchBits, { x: 0, y: -2, scaleX: 1.05, scaleY: 1.18, duration: 0.12, ease: OUT_STRONG }, 0);
    tl.to(triggerBits, { scale: 1, y: 0, duration: 0.34, ease: SPRING }, 0.14);
    tl.to(triggerIcon, { autoAlpha: 0, rotation: 135, duration: 0.14, ease: P2_IN }, 0.04);
    tl.to(panelTrio, { scale: 0.38, duration: 0.13, ease: P1_INOUT }, 0.02);
    tl.to(panelTrio, { scaleY: 1, rotation: 0, duration: 0.32, ease: POP }, 0.15);
    tl.to(panelTrio, { scaleX: 1, duration: 0.32, ease: POP }, 0.2);
    // Rows condense bottom-up
    const rowInners = Array.from(panel.querySelectorAll('.lqd-item-inner'));
    if (rowInners[0] && getState(rowInners[0]).opacity < 0.05) {
      tl.set(rowInners, { autoAlpha: 0, y: 10 }, 0);
    }
    rowInners.forEach((row, i) => {
      tl.to(row, { autoAlpha: 1, y: 0, duration: 0.18, ease: BACK_OUT }, 0.22 + (rowInners.length - 1 - i) * 0.03);
    });
    tl.set(triggerBody, { autoAlpha: 0 }, 0.34);
    tl.set(bodies, { autoAlpha: 1 }, 0.5);
    tl.to(goo, { autoAlpha: 0, duration: 0.14, ease: P1_OUT }, 0.5);
    tl.call(() => { setGooBlur(gooEls, GOO_BLUR_REST); }, 0.66);
    tl.call(() => anchor.removeAttribute('data-liquid'), 0.65);

    liquidOn(GOO_BLUR_ACTIVE);
    trigger.setAttribute('aria-expanded', 'true');
    sfx.pop(660, 0.09);
    tl.play();
  }

  function closeMenu() {
    if (!open) { return; }
    open = false;
    if (tl) tl.kill();
    tl = new Timeline();

    tl.set(triggerBody, { autoAlpha: 1 }, 0);
    tl.set(blobPanel, { autoAlpha: 1 }, 0);
    tl.set(chainEls, { x: 0, y: 0, scale: 0 }, 0);
    tl.to(panelTrio, { x: 0, y: 0, duration: 0.12, ease: OUT_STRONG }, 0);
    tl.to(panelTrio, { scaleX: 0.32, duration: 0.16, ease: ANTICIPATE }, 0);
    tl.to(panelTrio, { scaleY: 0.36, rotation: -2, duration: 0.16, ease: ANTICIPATE }, 0.045);
    const rowInners = Array.from(panel.querySelectorAll('.lqd-item-inner'));
    rowInners.forEach((row, i) => {
      tl.to(row, { autoAlpha: 0, y: 4, duration: 0.06, ease: P1_IN }, 0.05 + i * 0.005);
    });
    tl.to(panelTrio, { scale: PANEL_REST_SCALE, duration: 0.07, ease: P2_IN }, 0.21);
    tl.set([panelBody, panel], { autoAlpha: 0 }, 0.28);
    tl.to(triggerBits, { scaleX: 1.2, scaleY: 0.82, duration: 0.06, ease: P2_OUT }, 0.24);
    tl.to(triggerBits, { scaleX: 0.94, scaleY: 1.07, duration: 0.08, ease: P1_INOUT }, 0.30);
    tl.to(triggerBits, { scaleX: 1, scaleY: 1, duration: 0.28, ease: SPRING }, 0.38);
    tl.to(triggerIcon, { autoAlpha: 1, rotation: 0, duration: 0.18, ease: OUT_STRONG }, 0.26);
    tl.set(bodies, { autoAlpha: 1 }, 0.34);
    tl.to(goo, { autoAlpha: 0, duration: 0.12, ease: P1_OUT }, 0.34);
    tl.call(() => { setGooBlur(gooEls, GOO_BLUR_REST); }, 0.47);
    tl.call(() => anchor.removeAttribute('data-liquid'), 0.46);

    liquidOn(GOO_BLUR_ACTIVE);
    trigger.setAttribute('aria-expanded', 'false');
    sfx.pop(420, 0.12);
    tl.play();
  }

  trigger.addEventListener('click', () => {
    if (stretch && stretch.consumeClick()) return;
    if (open) closeMenu(); else openMenu();
  });

  // ─── Stretch gesture (the taffy grab) ───────────────────────────
  const stretch = (function makeStretch() {
    let pressed = false;
    let suppressClick = false;
    let grabBase = { x: 0, y: 0 };
    let stretchDist = 0;

    function beginGrab(e) {
      if (reducedMotion || e.button !== 0 || open) return;
      pressed = true;
      suppressClick = false;
      stretchDist = 0;
      grabBase = { x: 0, y: 0 };
      try { trigger.setPointerCapture(e.pointerId); } catch (_) {}
      window.addEventListener('pointerup', release, { once: true });
      liquidOn(GOO_BLUR_GRAB);
      chainEls.forEach((c) => { const st = getState(c); st.x = st.y = 0; st.scaleX = st.scaleY = 0.4; writeState(c, st); });
      const t = new Timeline();
      t.to(triggerBits, { scale: 0.85, duration: 0.1, ease: OUT_STRONG }, 0);
      t.play();
    }

    function pointerMove(e) {
      if (!pressed || reducedMotion) return;
      const rect = anchor.getBoundingClientRect();
      const half = BUTTON_SIZE / 2;
      const dx = e.clientX - (rect.left + half + grabBase.x);
      const dy = e.clientY - (rect.top + half + grabBase.y);
      const dist = Math.hypot(dx, dy);
      stretchDist = dist;
      const reach = Math.max(0, dist - 6);
      const pull = Math.min(reach * 0.7, GRAB_MAX);
      const tension = pull / GRAB_MAX;
      const ux = dist > 0 ? dx / dist : 0;
      const uy = dist > 0 ? dy / dist : 0;

      chainEls.forEach((c, i) => {
        const link = GRAB_CHAIN[i];
        const st = getState(c);
        st.x = ux * pull * link.follow;
        st.y = uy * pull * link.follow;
        st.scaleX = st.scaleY = link.size * (1 - tension * link.thin);
        writeState(c, st);
      });

      const st = getState(triggerStretchBits[0]);
      st.x = ux * pull * 0.18;
      st.y = uy * pull * 0.18;
      st.rotation = (Math.atan2(dy, dx) * 180) / Math.PI;
      st.scaleX = (1 + tension * 0.12) * 0.85;
      st.scaleY = (1 - tension * 0.06) * 0.85;
      writeState(triggerStretchBits[0], st);
      writeState(triggerStretchBits[1], st);
      const ist = getState(triggerIcon);
      ist.x = ux * pull * 0.28;
      ist.y = uy * pull * 0.28;
      writeState(triggerIcon, ist);
    }

    function release() {
      if (!pressed) return;
      pressed = false;
      const wasStretched = stretchDist > 12;
      suppressClick = wasStretched;
      stretchDist = 0;

      const t = new Timeline();
      if (wasStretched) {
        chainEls.forEach((c, i) => {
          t.to(c, { x: 0, y: 0, duration: 0.5, ease: SPRING }, i * 0.025);
          t.to(c, { scale: 0, duration: 0.2, ease: P2_IN }, 0.16 + i * 0.025);
        });
      }
      t.to(triggerStretchBits, { x: 0, y: 0, rotation: 0, duration: 0.5, ease: SPRING }, 0);
      t.to(triggerIcon, { x: 0, y: 0, duration: 0.5, ease: SPRING }, 0);
      if (wasStretched) {
        t.to(triggerBits, { scaleX: 1.2, scaleY: 0.82, duration: 0.09, ease: P2_OUT }, 0.12);
        t.to(triggerBits, { scaleX: 0.93, scaleY: 1.09, duration: 0.11, ease: P1_INOUT }, 0.21);
        t.to(triggerBits, { scaleX: 1, scaleY: 1, duration: 0.4, ease: SPRING }, 0.32);
      } else {
        t.to(triggerBits, { scale: 1, duration: 0.45, ease: SPRING }, 0);
      }
      t.set(bodies, { autoAlpha: 1 }, wasStretched ? 0.45 : 0.3);
      t.to(goo, { autoAlpha: 0, duration: 0.14, ease: P1_OUT }, wasStretched ? 0.45 : 0.3);
      t.call(() => { setGooBlur(gooEls, GOO_BLUR_REST); anchor.removeAttribute('data-liquid'); }, wasStretched ? 0.6 : 0.44);
      if (wasStretched) sfx.pop(520, 0.07);
      t.play();
    }

    function consumeClick() {
      if (suppressClick) { suppressClick = false; return true; }
      return false;
    }

    trigger.addEventListener('pointerdown', beginGrab);
    trigger.addEventListener('pointermove', pointerMove);
    return { consumeClick };
  })();

  // Arm audio on the first interaction anywhere (autoplay policy)
  document.addEventListener('pointerdown', () => sfx.ensure(), { once: true });

  // Expose a mute toggle for power users
  window.liquidSfx = sfx;
})();
