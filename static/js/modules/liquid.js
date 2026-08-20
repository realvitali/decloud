// ===== Module: liquid =====
// Project-wide "liquid glass" interaction system, ported from the
// morphing/anchored dropdowns of liquid-taffy:
//   https://github.com/arknow91/liquid-taffy  (MIT, (c) 2026 arknow91)
//
// Dependency-free (React/GSAP replaced by a small tween engine):
//   1. Every <select> in the app becomes a liquid anchored dropdown
//      (options mirrored live; picking dispatches the native change).
//   2. Every button/clickable gets a liquid press-squash and a goo
//      click ripple from one shared overlay canvas.
//   3. The home-screen + button is the morphing-dropdown showcase.
//
// Reduced-motion users get instant transitions, no physics.

(function () {
  'use strict';

  // ─── Curves ─────────────────────────────────────────────────────
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

  // ─── Tween engine ───────────────────────────────────────────────
  const reducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  class Timeline {
    constructor() {
      this._entries = [];
      this._raf = 0;
      this._killed = false;
    }
    set(targets, vars, at) { this._entries.push({ at: at || 0, set: true, targets, vars }); return this; }
    to(targets, vars, at) { this._entries.push({ at: at || 0, targets, vars }); return this; }
    call(fn, at) { this._entries.push({ at: at || 0, fn }); return this; }
    kill() { this._killed = true; if (this._raf) cancelAnimationFrame(this._raf); }
    play() {
      if (reducedMotion) {
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
      if (v.opacity !== undefined) st.opacity = lerp(v.opacity, st.oFrom || st.opacity, k);
      if (v.autoAlpha !== undefined) {
        st.opacity = lerp(v.autoAlpha, st.oFrom || st.opacity, k);
        el.style.visibility = st.opacity > 0.01 ? 'visible' : 'hidden';
      }
      if (v.attr) { for (const key in v.attr) el.setAttribute(key, v.attr[key]); }
      writeState(el, st);
    }
  }

  function getState(el) {
    if (!el._lqd) {
      el._lqd = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };
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
  }

  function lerp(to, from, k) { return from + (to - from) * k; }

  // ─── Squircle path (Apple continuous corner) ────────────────────
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

  // ─── Goo filter table ───────────────────────────────────────────
  const GOO_RIM_THRESHOLDS = {
    1: [-14.5146, -24.6721],
    4: [-12.25, -14.25],
    5: [-12.7296, -15.063],
    7: [-11.6925, -13.245],
  };
  const gooThreshold = (offset) =>
    `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 30 ${offset}`;

  function buildGooFilter(id, w, h) {
    return `
      <defs>
        <filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"
                color-interpolation-filters="sRGB">
          <feGaussianBlur class="lqd-blur" in="SourceGraphic" stdDeviation="1" result="blur"/>
          <feColorMatrix class="lqd-rim" in="blur" type="matrix"
            values="${gooThreshold(GOO_RIM_THRESHOLDS[1][0])}" result="goo"/>
          <feColorMatrix class="lqd-inner" in="blur" type="matrix"
            values="${gooThreshold(GOO_RIM_THRESHOLDS[1][1])}" result="inner"/>
          <feFlood style="flood-color: var(--lqd-rim)" result="rimColor"/>
          <feComposite in="rimColor" in2="goo" operator="in" result="rimFull"/>
          <feMerge>
            <feMergeNode in="rimFull"/>
            <feMergeNode in="inner"/>
          </feMerge>
        </filter>
      </defs>`;
  }

  function setGooBlur(svgRoot, blur) {
    const [outer, inner] = GOO_RIM_THRESHOLDS[blur];
    const b = svgRoot.querySelector('.lqd-blur');
    const r = svgRoot.querySelector('.lqd-rim');
    const i = svgRoot.querySelector('.lqd-inner');
    if (b) b.setAttribute('stdDeviation', String(blur));
    if (r) r.setAttribute('values', gooThreshold(outer));
    if (i) i.setAttribute('values', gooThreshold(inner));
  }

  // ─── Sound (tiny synthesized pops) ──────────────────────────────
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
  window.liquidSfx = sfx;

  // ═══ 1. SHARED RIPPLE OVERLAY + UNIVERSAL PRESS SQUASH ═══════════

  const overlaySVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlaySVG.setAttribute('class', 'lqd-overlay');
  overlaySVG.setAttribute('aria-hidden', 'true');
  overlaySVG.innerHTML = buildGooFilter('lqd-overlay-goo', window.innerWidth, window.innerHeight) +
    '<g filter="url(#lqd-overlay-goo)"></g>';
  document.body.appendChild(overlaySVG);
  const overlayGroup = overlaySVG.querySelector('g');

  function spawnRipple(x, y) {
    if (reducedMotion) return;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', '8');
    c.setAttribute('class', 'lqd-ripple');
    overlayGroup.appendChild(c);
    const tl = new Timeline();
    tl.to(c, { attr: { r: 26 }, opacity: 0.55, duration: 0.16, ease: P2_OUT }, 0);
    tl.to(c, { attr: { r: 34 }, opacity: 0, duration: 0.3, ease: P2_OUT }, 0.12);
    tl.call(() => c.remove(), 0.45);
    tl.play();
  }

  const PRESS_SELECTOR = 'button, .app-icon, .lego-card, .settings-tab, .theme-option, .app-tile';
  function isLiquidInside(el) { return !!(el && el.closest && el.closest('.lqd-anchor, .lqd-selwrap, .lqd-panel')); }

  document.addEventListener('pointerdown', (e) => {
    if (reducedMotion) return;
    const el = e.target.closest && e.target.closest(PRESS_SELECTOR);
    if (!el || isLiquidInside(el)) return;
    const tl = new Timeline();
    tl.to(el, { scale: 0.93, duration: 0.09, ease: OUT_STRONG }, 0);
    tl.play();
    const restore = () => {
      const t2 = new Timeline();
      t2.to(el, { scale: 1, duration: 0.3, ease: SPRING }, 0);
      t2.play();
      window.removeEventListener('pointerup', restore);
    };
    window.addEventListener('pointerup', restore, { once: true });
  }, { passive: true });

  document.addEventListener('click', (e) => {
    if (reducedMotion) return;
    const el = e.target.closest && e.target.closest(PRESS_SELECTOR);
    if (!el || isLiquidInside(el)) return;
    spawnRipple(e.clientX, e.clientY);
  }, { passive: true });

  // ═══ 2. LIQUIDIFY EVERY NATIVE SELECT (anchored dropdown) ════════

  function liquidifySelect(sel) {
    if (sel._lqdified) return;
    sel._lqdified = true;

    // Wrap so the liquid UI replaces the select in place
    const wrap = document.createElement('div');
    wrap.className = 'lqd-selwrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.hidden = true;      // native select stays as the source of truth
    sel.tabIndex = -1;

    const host = document.createElement('button');
    host.type = 'button';
    host.className = 'lqd-selhost';
    host.setAttribute('aria-haspopup', 'listbox');
    host.innerHTML = '<span class="lqd-sellabel"></span><span class="lqd-selchevron">▾</span>';
    wrap.appendChild(host);

    let open = false;
    let tl = null;
    let gooRoot = null;
    let panel = null;
    let panelBody = null;
    let panelShape = null;
    let blobPanel = null;
    let blobTrigger = null;
    const GAP = 14;        // panel hangs 14px above the host (reference)
    const ROW_H = 32;
    const MAX_PANEL_H = 208;

    function currentLabel() {
      const opt = sel.options[sel.selectedIndex];
      return opt ? opt.text : '—';
    }
    function refreshLabel() { host.querySelector('.lqd-sellabel').textContent = currentLabel(); }

    function buildUI() {
      host.querySelector('.lqd-sellabel').textContent = currentLabel();
      if (!panel) return;
      const count = sel.options.length || 1;
      const panelH = Math.min(MAX_PANEL_H, count * ROW_H + 14);
      const panelW = Math.max(200, host.offsetWidth);
      panel.style.width = panelW + 'px';
      panel.style.height = panelH + 'px';
      panelBody.setAttribute('width', panelW);
      panelBody.setAttribute('height', panelH);
      panelShape.setAttribute('d', squirclePath(0.5, 0.5, panelW - 1, panelH - 1, 16));
      blobPanel.setAttribute('d', squirclePath(0, 0, panelW, panelH, 16));
      panel.innerHTML = '';
      Array.from(sel.options).forEach((opt, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'lqd-item';
        row.setAttribute('role', 'option');
        if (i === sel.selectedIndex) row.setAttribute('data-active', '');
        row.innerHTML = `<span class="lqd-item-inner"><span class="lqd-item-label">${opt.text}</span></span>`;
        row.addEventListener('click', () => {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          refreshLabel();
          closeDropdown();
        });
        panel.appendChild(row);
      });
    }

    function openDropdown() {
      if (open) return;
      open = true;
      if (tl) tl.kill();
      buildUI();

      const count = sel.options.length || 1;
      const panelH = Math.min(MAX_PANEL_H, count * ROW_H + 14);
      const panelW = Math.max(200, host.offsetWidth);
      const hostH = host.offsetHeight || 32;
      const hostW = host.offsetWidth || 100;

      // Canvas covers the panel + the host + padding, anchored top-left.
      // Wrap coords: panel top = -(panelH + GAP), panel left = 0.
      const CANVAS_PAD = 40;
      const canvasW = panelW + CANVAS_PAD * 2;
      const canvasH = panelH + GAP + hostH + CANVAS_PAD * 2;
      // Panel top-left and button center, in canvas coordinates
      const panelCX = CANVAS_PAD;
      const panelCY = CANVAS_PAD;
      const triggerCX = CANVAS_PAD + hostW / 2;
      const triggerCY = CANVAS_PAD + panelH + GAP + hostH / 2;

      gooRoot.setAttribute('width', canvasW);
      gooRoot.setAttribute('height', canvasH);
      gooRoot.style.width = canvasW + 'px';
      gooRoot.style.height = canvasH + 'px';
      gooRoot.style.left = -CANVAS_PAD + 'px';
      gooRoot.style.top = -(panelH + GAP + CANVAS_PAD) + 'px';
      gooRoot.querySelector('filter').setAttribute('width', canvasW);
      gooRoot.querySelector('filter').setAttribute('height', canvasH);

      blobPanel.setAttribute('d', squirclePath(panelCX, panelCY, panelW, panelH, 16));
      blobPanel.style.transformOrigin = `${triggerCX}px ${panelCY + panelH + GAP}px`;
      blobTrigger.setAttribute('cx', triggerCX);
      blobTrigger.setAttribute('cy', triggerCY);

      const restScale = 0.11;
      // Crisp trio's origin: the button's top center, in panel coords
      const originX = panelW / 2;
      const originY = panelH + GAP + hostH / 2;
      wrap._lqdGeo = { panelW, panelH, hostH, originX, originY };
      panel.style.transformOrigin = `${originX}px ${originY}px`;
      panelBody.style.transformOrigin = `${originX}px ${originY}px`;

      tl = new Timeline();
      gooRoot.style.opacity = '1';
      gooRoot.style.visibility = 'visible';
      setGooBlur(gooRoot, 7);      // σ7 bridges the 14px gap
      wrap.setAttribute('data-liquid', '');

      tl.set([panelBody, panel, blobPanel], { x: 0, y: 0 }, 0);
      tl.set(blobPanel, { scale: restScale }, 0);
      tl.set([panelBody, panel], { scale: restScale }, 0);
      tl.to(blobPanel, { scale: 0.38, duration: 0.13, ease: P1_INOUT }, 0.02);
      tl.to(blobPanel, { scaleY: 1, duration: 0.32, ease: POP }, 0.15);
      tl.to(blobPanel, { scaleX: 1, duration: 0.32, ease: POP }, 0.2);
      tl.to([panelBody, panel], { scaleY: 1, duration: 0.32, ease: POP }, 0.15);
      tl.to([panelBody, panel], { scaleX: 1, duration: 0.32, ease: POP }, 0.2);
      const inners = Array.from(panel.querySelectorAll('.lqd-item-inner'));
      if (inners.length && getState(inners[0]).opacity < 0.05) {
        tl.set(inners, { autoAlpha: 0, y: 10 }, 0);
      }
      inners.forEach((row, i) => {
        tl.to(row, { autoAlpha: 1, y: 0, duration: 0.18, ease: BACK_OUT },
          0.22 + (inners.length - 1 - i) * 0.02);
      });
      tl.call(() => setGooBlur(gooRoot, 1), 0.66);
      tl.call(() => wrap.removeAttribute('data-liquid'), 0.65);
      sfx.pop(700, 0.08);
      tl.play();
    }

    function closeDropdown() {
      if (!open) return;
      open = false;
      if (tl) tl.kill();

      tl = new Timeline();
      gooRoot.style.opacity = '1';
      gooRoot.style.visibility = 'visible';
      setGooBlur(gooRoot, 7);
      wrap.setAttribute('data-liquid', '');
      tl.to([panelBody, panel, blobPanel], { x: 0, y: 0, duration: 0.12, ease: OUT_STRONG }, 0);
      tl.to([panelBody, panel, blobPanel], { scaleX: 0.32, duration: 0.16, ease: ANTICIPATE }, 0);
      tl.to([panelBody, panel, blobPanel], { scaleY: 0.36, duration: 0.16, ease: ANTICIPATE }, 0.045);
      const inners = Array.from(panel.querySelectorAll('.lqd-item-inner'));
      inners.forEach((row, i) => {
        tl.to(row, { autoAlpha: 0, y: 4, duration: 0.06, ease: P1_IN }, 0.05 + i * 0.004);
      });
      tl.to([panelBody, panel, blobPanel], { scale: 0.11, duration: 0.07, ease: P2_IN }, 0.21);
      tl.set([panelBody, panel], { autoAlpha: 0 }, 0.28);
      tl.to(gooRoot, { autoAlpha: 0, duration: 0.12, ease: P1_OUT }, 0.3);
      tl.call(() => setGooBlur(gooRoot, 1), 0.42);
      tl.call(() => wrap.removeAttribute('data-liquid'), 0.41);
      sfx.pop(430, 0.1);
      tl.play();
    }

    // Build the goo canvas once, rebuild panel contents per open
    gooRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    gooRoot.setAttribute('class', 'lqd-selgoo');
    gooRoot.setAttribute('aria-hidden', 'true');
    gooRoot.innerHTML = buildGooFilter('lqd-selgoo-filter', 300, 300) +
      `<g filter="url(#lqd-selgoo-filter)">
         <path class="lqd-blob lqd-blob-panel"></path>
         <circle class="lqd-blob lqd-blob-trigger" r="16"></circle>
       </g>`;
    wrap.appendChild(gooRoot);
    blobPanel = gooRoot.querySelector('.lqd-blob-panel');
    blobTrigger = gooRoot.querySelector('.lqd-blob-trigger');
    gooRoot.querySelector('filter').id = 'lqd-selgoo-filter-' + Math.random().toString(36).slice(2, 8);
    gooRoot.querySelector('g').setAttribute('filter', 'url(#' + gooRoot.querySelector('filter').id + ')');

    // Crisp bodies + rows
    panelBody = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    panelBody.setAttribute('class', 'lqd-selpanelbody');
    panelShape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    panelShape.setAttribute('class', 'lqd-panel-body-shape');
    panelBody.appendChild(panelShape);
    wrap.appendChild(panelBody);
    panel = document.createElement('div');
    panel.className = 'lqd-panel lqd-selpanel';
    panel.setAttribute('role', 'listbox');
    wrap.appendChild(panel);

    host.addEventListener('click', () => { if (open) closeDropdown(); else openDropdown(); });

    // Outside click closes
    document.addEventListener('click', (e) => {
      if (open && !wrap.contains(e.target)) closeDropdown();
    }, true);

    // Mirror future option changes
    new MutationObserver(() => {
      if (open) buildUI();
      refreshLabel();
    }).observe(sel, { childList: true, subtree: true });

    refreshLabel();
  }

  function liquidifyAllSelects() {
    document.querySelectorAll('select').forEach(liquidifySelect);
  }
  window.liquidifyAllSelects = liquidifyAllSelects;

  // ═══ 3. HOME FAB (morphing-dropdown showcase) ════════════════════

  const BUTTON_SIZE = 32;
  const PANEL_WIDTH = 141;
  const PANEL_HEIGHT = 164;
  const PANEL_ORIGIN_X = PANEL_WIDTH / 2;
  const PANEL_ORIGIN_Y = PANEL_HEIGHT - 16;
  const PANEL_REST_SCALE = 0.11;
  const GOO_BLUR_ACTIVE = 4;
  const GOO_BLUR_REST = 1;
  const GOO_BLUR_GRAB = 5;
  const GOO_WIDTH = 320;
  const GOO_HEIGHT = 308;
  const TRIGGER_CX = 160;
  const TRIGGER_CY = 220;
  const PANEL_GOO_X = TRIGGER_CX - PANEL_WIDTH / 2;
  const PANEL_GOO_Y = TRIGGER_CY - PANEL_ORIGIN_Y;
  const GRAB_MAX = 44;
  const GRAB_CHAIN = [
    { follow: 1, size: 0.85, thin: 0.06, lag: 0.16 },
    { follow: 0.84, size: 0.72, thin: 0.16, lag: 0.18 },
    { follow: 0.68, size: 0.65, thin: 0.19, lag: 0.2 },
    { follow: 0.52, size: 0.64, thin: 0.19, lag: 0.22 },
    { follow: 0.36, size: 0.7, thin: 0.14, lag: 0.24 },
    { follow: 0.2, size: 0.8, thin: 0.08, lag: 0.26 },
  ];

  const root = document.getElementById('liquid-fab-root');
  if (root) {
    root.innerHTML = `
      <div class="lqd-anchor">
        <div class="lqd-bodies">
          <div class="lqd-trigger-body"></div>
          <svg class="lqd-panel-body" width="${PANEL_WIDTH}" height="${PANEL_HEIGHT}" viewBox="0 0 ${PANEL_WIDTH} ${PANEL_HEIGHT}">
            <path class="lqd-panel-body-shape" d="${squirclePath(0.5, 0.5, PANEL_WIDTH - 1, PANEL_HEIGHT - 1, 16)}"></path>
          </svg>
        </div>
        <svg class="lqd-goo" width="${GOO_WIDTH}" height="${GOO_HEIGHT}" viewBox="0 0 ${GOO_WIDTH} ${GOO_HEIGHT}" aria-hidden="true">
          ${buildGooFilter('lqd-goo-filter', GOO_WIDTH, GOO_HEIGHT)}
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
    const goo = root.querySelector('.lqd-goo');
    const gooSVG = goo;
    const blobTrigger = root.querySelector('.lqd-blob-trigger');
    const blobPanel = root.querySelector('.lqd-blob-panel');
    const panel = root.querySelector('.lqd-panel');
    const trigger = root.querySelector('.lqd-trigger');
    const triggerIcon = root.querySelector('.lqd-trigger-icon');
    const chainEls = Array.from(root.querySelectorAll('.lqd-chain'));

    const THEME_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    const ITEMS = [
      { label: 'Books', icon: (window.ICONS && ICONS.book) || '', action: () => openApp('audiobooks') },
      { label: 'AI Chat', icon: (window.ICONS && ICONS.brain) || '', action: () => openApp('ollama') },
      { label: 'Files', icon: (window.ICONS && ICONS.lego) || '', action: () => openApp('files') },
      { label: 'Terminal', icon: (window.ICONS && ICONS.terminal) || '', action: () => openApp('terminal') },
      { label: 'Theme', icon: THEME_ICON, action: toggleThemeQuick },
    ];

    ITEMS.forEach((item) => {
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

    applyVars(Array.from(panel.querySelectorAll('.lqd-item-inner')), { autoAlpha: 0, y: 10 }, true);
    applyVars(chainEls, { scale: 0 }, true);

    function toggleThemeQuick() {
      fetch('/api/settings/theme').then((r) => r.json()).then((d) => {
        const next = (d.theme || 'auto') === 'dark' ? 'light' : 'dark';
        if (typeof setTheme === 'function') setTheme(next);
      }).catch(() => {});
    }

    let open = false;
    let tl = null;
    const panelTrio = [panelBody, panel, blobPanel];
    const triggerBits = [blobTrigger, triggerBody];
    const triggerStretchBits = [blobTrigger, triggerBody];

    function liquidOn(blur) {
      anchor.setAttribute('data-liquid', '');
      goo.style.opacity = '1';
      goo.style.visibility = 'visible';
      setGooBlur(gooSVG, blur);
      bodies.style.visibility = 'hidden';
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
      const rowInners = Array.from(panel.querySelectorAll('.lqd-item-inner'));
      if (rowInners[0] && getState(rowInners[0]).opacity < 0.05) {
        tl.set(rowInners, { autoAlpha: 0, y: 10 }, 0);
      }
      rowInners.forEach((row, i) => {
        tl.to(row, { autoAlpha: 1, y: 0, duration: 0.18, ease: BACK_OUT },
          0.22 + (rowInners.length - 1 - i) * 0.03);
      });
      tl.set(triggerBody, { autoAlpha: 0 }, 0.34);
      tl.set(bodies, { autoAlpha: 1 }, 0.5);
      tl.to(goo, { autoAlpha: 0, duration: 0.14, ease: P1_OUT }, 0.5);
      tl.call(() => { setGooBlur(gooSVG, GOO_BLUR_REST); }, 0.66);
      tl.call(() => anchor.removeAttribute('data-liquid'), 0.65);
      liquidOn(GOO_BLUR_ACTIVE);
      trigger.setAttribute('aria-expanded', 'true');
      sfx.pop(660, 0.09);
      tl.play();
    }

    function closeMenu() {
      if (!open) return;
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
      tl.call(() => { setGooBlur(gooSVG, GOO_BLUR_REST); }, 0.47);
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

    const stretch = (function makeStretch() {
      let pressed = false;
      let suppressClick = false;
      let stretchDist = 0;

      function beginGrab(e) {
        if (reducedMotion || e.button !== 0 || open) return;
        pressed = true;
        suppressClick = false;
        stretchDist = 0;
        try { trigger.setPointerCapture(e.pointerId); } catch (_) {}
        window.addEventListener('pointerup', release, { once: true });
        liquidOn(GOO_BLUR_GRAB);
        chainEls.forEach((c) => {
          const st = getState(c); st.x = st.y = 0; st.scaleX = st.scaleY = 0.4; writeState(c, st);
        });
        const t = new Timeline();
        t.to(triggerBits, { scale: 0.85, duration: 0.1, ease: OUT_STRONG }, 0);
        t.play();
      }

      function pointerMove(e) {
        if (!pressed || reducedMotion) return;
        const rect = anchor.getBoundingClientRect();
        const half = BUTTON_SIZE / 2;
        const dx = e.clientX - (rect.left + half);
        const dy = e.clientY - (rect.top + half);
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
        t.call(() => {
          setGooBlur(gooSVG, GOO_BLUR_REST);
          anchor.removeAttribute('data-liquid');
        }, wasStretched ? 0.6 : 0.44);
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

    document.addEventListener('pointerdown', () => sfx.ensure(), { once: true });
  }

  // ═══ 4. AI SPREAD → LIQUID SPEED DIAL ═════════════════════════
  // The AI tile's radial spread becomes the reference's speed dial:
  // satellites (AI Chat / Generate / Agents) ooze out of the tile,
  // launch past full size and ring still; they can be grabbed and
  // stretched like taffy; closing dives them back with a splat.
  // The existing fan math (direction away from screen center, arc
  // spread, radius) and navigation are reused untouched.

  (function setupAISpeedDial() {
    if (typeof openAISpread !== 'function') return;
    const SUBAPPS = (typeof AI_SUBAPPS !== 'undefined') ? AI_SUBAPPS : [];
    if (!SUBAPPS.length) return;
    const ITEM = 72;           // satellite size (matches the old spread)
    const SAT_R = ITEM / 2;    // 36
    const TRIG_R = 28;         // trigger circle drawn over the tile
    const GOO_BLUR_SPREAD = 5;

    let overlay = null;
    let tl = null;
    let isOpen = false;

    function findTile() { return document.querySelector('[data-app-id="ai"]'); }

    function fanGeometry() {
      const btn = findTile();
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const n = SUBAPPS.length;
      const margin = 16;
      let fanAngle = Math.atan2(window.innerHeight / 2 - cy, window.innerWidth / 2 - cx);
      if (fanAngle < 0) fanAngle += 2 * Math.PI;
      const arcDeg = Math.min(140, 30 + (n - 1) * 25);
      const halfArc = (arcDeg / 2) * Math.PI / 180;
      let r = 130;
      const cosF = Math.cos(fanAngle), sinF = Math.sin(fanAngle);
      let maxR = Infinity;
      if (cosF > 0.01) maxR = Math.min(maxR, (window.innerWidth - margin - cx) / cosF);
      if (cosF < -0.01) maxR = Math.min(maxR, (cx - margin) / -cosF);
      if (sinF > 0.01) maxR = Math.min(maxR, (window.innerHeight - margin - cy) / sinF);
      if (sinF < -0.01) maxR = Math.min(maxR, (cy - margin) / -sinF);
      maxR -= ITEM;
      const cosE = Math.cos(fanAngle + halfArc), sinE = Math.sin(fanAngle + halfArc);
      let maxRE = Infinity;
      if (cosE > 0.01) maxRE = Math.min(maxRE, (window.innerWidth - margin - cx - ITEM / 2) / cosE);
      if (cosE < -0.01) maxRE = Math.min(maxRE, (cx - margin + ITEM / 2) / -cosE);
      if (sinE > 0.01) maxRE = Math.min(maxRE, (window.innerHeight - margin - cy - ITEM / 2) / sinE);
      if (sinE < -0.01) maxRE = Math.min(maxRE, (cy - margin + ITEM / 2) / -sinE);
      r = Math.max(70, Math.min(r, maxR, maxRE - ITEM));
      const targets = SUBAPPS.map((_sub, i) => {
        const frac = n === 1 ? 0.5 : i / (n - 1);
        const angle = fanAngle - halfArc + frac * (halfArc * 2);
        return { dx: Math.cos(angle) * r, dy: Math.sin(angle) * r };
      });
      return { cx, cy, targets };
    }

    function buildOverlay() {
      const geo = fanGeometry();
      if (!geo) return;
      const { cx, cy, targets } = geo;
      const pad = 80;
      const xs = [cx - TRIG_R, cx + TRIG_R];
      const ys = [cy - TRIG_R, cy + TRIG_R];
      targets.forEach((t) => {
        xs.push(cx + t.dx - SAT_R, cx + t.dx + SAT_R);
        ys.push(cy + t.dy - SAT_R, cy + t.dy + SAT_R);
      });
      const left = Math.min.apply(null, xs) - pad;
      const top = Math.min.apply(null, ys) - pad;
      const w = Math.max.apply(null, xs) - left + pad;
      const h = Math.max.apply(null, ys) - top + pad;
      const tCX = cx - left;   // trigger center in canvas coords
      const tCY = cy - top;

      overlay = document.createElement('div');
      overlay.className = 'lqd-ai';
      overlay.style.left = left + 'px';
      overlay.style.top = top + 'px';
      overlay.style.width = w + 'px';
      overlay.style.height = h + 'px';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('class', 'lqd-ai-goo');
      svg.innerHTML = buildGooFilter('lqd-ai-goo-filter', w, h) +
        `<g filter="url(#lqd-ai-goo-filter)">
           <circle class="lqd-blob lqd-ai-trigger-blob" cx="${tCX}" cy="${tCY}" r="${TRIG_R}"></circle>
           ${targets.map((_t, i) => `<circle class="lqd-blob lqd-ai-sat-blob" data-i="${i}" cx="${tCX}" cy="${tCY}" r="${SAT_R}"></circle>`).join('')}
           ${GRAB_CHAIN.map((_l, i) => `<circle class="lqd-chain lqd-ai-chain" data-i="${i}" cx="${tCX}" cy="${tCY}" r="11"></circle>`).join('')}
         </g>`;
      overlay.appendChild(svg);

      // Crisp trigger body + hit area over the tile
      const trigBody = document.createElement('div');
      trigBody.className = 'lqd-ai-triggerbody';
      trigBody.style.left = (tCX - TRIG_R) + 'px';
      trigBody.style.top = (tCY - TRIG_R) + 'px';
      trigBody.style.width = (TRIG_R * 2) + 'px';
      trigBody.style.height = (TRIG_R * 2) + 'px';
      overlay.appendChild(trigBody);

      const trigBtn = document.createElement('button');
      trigBtn.type = 'button';
      trigBtn.className = 'lqd-ai-trigger';
      trigBtn.setAttribute('aria-label', 'Close AI menu');
      trigBtn.style.left = (tCX - TRIG_R) + 'px';
      trigBtn.style.top = (tCY - TRIG_R) + 'px';
      trigBtn.style.width = (TRIG_R * 2) + 'px';
      trigBtn.style.height = (TRIG_R * 2) + 'px';
      trigBtn.innerHTML = '<span class="lqd-ai-triggericon">' + ((window.ICONS && ICONS.brain) || '') + '</span>';
      trigBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (trigBtn._lqdConsume && trigBtn._lqdConsume()) return;
        close();
      });
      overlay.appendChild(trigBtn);

      // Satellites (crisp): body + icon + label, starting inside the trigger
      SUBAPPS.forEach((sub, i) => {
        const t = targets[i];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lqd-ai-sat';
        b.style.left = (tCX - SAT_R) + 'px';
        b.style.top = (tCY - SAT_R) + 'px';
        b.style.width = ITEM + 'px';
        b.style.height = ITEM + 'px';
        b.innerHTML = `<span class="lqd-ai-saticon" style="color:${sub.color}">${sub.svg}</span>` +
          `<span class="lqd-ai-satlabel">${sub.label}</span>`;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (b._lqdConsume && b._lqdConsume()) return;
          close();
          setTimeout(() => {
            showScreen(sub.screen);
            if (sub.id === 'ollama') { location.hash = '#ollama'; loadOllamaModels(); }
            if (sub.id === 'comfy') { location.hash = '#comfy'; loadComfyStatus(); loadComfyModels(); loadComfyGallery(); }
            if (sub.id === 'agents') { location.hash = '#agents'; }
          }, 50);
        });
        overlay.appendChild(b);
        wireGrab(b);
      });

      overlay.addEventListener('click', () => close());
      document.body.appendChild(overlay);
      wireGrab(trigBtn);
      return { tCX, tCY, targets };
    }

    // Shared grab: rigid lean + chain from the grabbed body's rim
    function wireGrab(el) {
      let pressed = false;
      let suppressClick = false;
      let stretchDist = 0;
      let canvasBase = null;

      function canvasPoint(e) {
        const rect = el.getBoundingClientRect();
        const olRect = overlay.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2 - olRect.left,
          y: rect.top + rect.height / 2 - olRect.top,
          clientX: e.clientX, clientY: e.clientY,
        };
      }

      function beginGrab(e) {
        if (reducedMotion || e.button !== 0) return;
        pressed = true;
        suppressClick = false;
        stretchDist = 0;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        window.addEventListener('pointerup', release, { once: true });
        overlay.setAttribute('data-liquid', '');
        const svg = overlay.querySelector('.lqd-ai-goo');
        svg.style.opacity = '1';
        svg.style.visibility = 'visible';
        setGooBlur(svg, GOO_BLUR_SPREAD);
        const p = canvasPoint(e);
        canvasBase = p;
        const chains = Array.from(overlay.querySelectorAll('.lqd-ai-chain'));
        chains.forEach((c) => {
          c.setAttribute('cx', p.x);
          c.setAttribute('cy', p.y);
          const st = getState(c); st.x = st.y = 0; st.scaleX = st.scaleY = 0.4; writeState(c, st);
        });
      }

      function pointerMove(e) {
        if (!pressed || reducedMotion) return;
        const rect = el.getBoundingClientRect();
        const baseX = rect.left + rect.width / 2;
        const baseY = rect.top + rect.height / 2;
        const dx = e.clientX - baseX;
        const dy = e.clientY - baseY;
        const dist = Math.hypot(dx, dy);
        stretchDist = dist;
        const reach = Math.max(0, dist - 6);
        const pull = Math.min(reach * 0.7, GRAB_MAX);
        const tension = pull / GRAB_MAX;
        const ux = dist > 0 ? dx / dist : 0;
        const uy = dist > 0 ? dy / dist : 0;
        const chains = Array.from(overlay.querySelectorAll('.lqd-ai-chain'));
        chains.forEach((c, i) => {
          const link = GRAB_CHAIN[i];
          const st = getState(c);
          st.x = ux * pull * link.follow;
          st.y = uy * pull * link.follow;
          st.scaleX = st.scaleY = link.size * (1 - tension * link.thin);
          writeState(c, st);
        });
        const st = getState(el);
        st.x = ux * pull * 0.22;
        st.y = uy * pull * 0.22;
        writeState(el, st);
      }

      function release() {
        if (!pressed) return;
        pressed = false;
        const wasStretched = stretchDist > 12;
        suppressClick = wasStretched;
        stretchDist = 0;
        const t = new Timeline();
        const chains = Array.from(overlay.querySelectorAll('.lqd-ai-chain'));
        if (wasStretched) {
          chains.forEach((c, i) => {
            t.to(c, { x: 0, y: 0, duration: 0.5, ease: SPRING }, i * 0.025);
            t.to(c, { scale: 0, duration: 0.2, ease: P2_IN }, 0.16 + i * 0.025);
          });
        } else {
          t.set(chains, { scale: 0 }, 0);
        }
        t.to(el, { x: 0, y: 0, duration: 0.5, ease: SPRING }, 0);
        t.call(() => {
          const svg = overlay.querySelector('.lqd-ai-goo');
          if (svg) {
            setGooBlur(svg, 1);
            t.to(svg, { autoAlpha: 0, duration: 0.14, ease: P1_OUT }, 0);
          }
          overlay.removeAttribute('data-liquid');
        }, 0.45);
        if (wasStretched) sfx.pop(520, 0.07);
        t.play();
      }

      function consumeClick() {
        if (suppressClick) { suppressClick = false; return true; }
        return false;
      }

      el.addEventListener('pointerdown', beginGrab);
      el.addEventListener('pointermove', pointerMove);
      el._lqdConsume = consumeClick;
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      if (tl) tl.kill();
      if (overlay) overlay.remove();
      const parts = buildOverlay();
      if (!parts) { isOpen = false; return; }
      const svg = overlay.querySelector('.lqd-ai-goo');
      const trigBtn = overlay.querySelector('.lqd-ai-trigger');
      const trigIcon = overlay.querySelector('.lqd-ai-triggericon');
      const trigBody = overlay.querySelector('.lqd-ai-triggerbody');
      const satBlobs = Array.from(overlay.querySelectorAll('.lqd-ai-sat-blob'));
      const sats = Array.from(overlay.querySelectorAll('.lqd-ai-sat'));
      const chains = Array.from(overlay.querySelectorAll('.lqd-ai-chain'));

      overlay.setAttribute('data-liquid', '');
      svg.style.opacity = '1';
      svg.style.visibility = 'visible';
      setGooBlur(svg, GOO_BLUR_SPREAD);

      tl = new Timeline();
      tl.set(satBlobs, { x: 0, y: 0, scale: 0.11 }, 0);
      tl.set(sats, { x: 0, y: 0, scale: 0.11 }, 0);
      tl.set(chains, { scale: 0 }, 0);
      tl.to(trigIcon, { autoAlpha: 0, rotation: 135, duration: 0.12, ease: P2_IN }, 0);
      satBlobs.forEach((blob, i) => {
        const t = parts.targets[i];
        // ooze out, launch past full size, ring still
        tl.to(blob, { x: t.dx, y: t.dy, duration: 0.12, ease: OUT_STRONG }, 0.02 + i * 0.04);
        tl.to(blob, { scale: 1.08, duration: 0.4, ease: POP }, 0.12 + i * 0.04);
        tl.to(blob, { scale: 1, duration: 0.28, ease: SPRING }, 0.5 + i * 0.04);
      });
      sats.forEach((b, i) => {
        const t = parts.targets[i];
        tl.to(b, { x: t.dx, y: t.dy, duration: 0.12, ease: OUT_STRONG }, 0.02 + i * 0.04);
        tl.to(b, { scale: 1.08, duration: 0.4, ease: POP }, 0.12 + i * 0.04);
        tl.to(b, { scale: 1, duration: 0.28, ease: SPRING }, 0.5 + i * 0.04);
      });
      tl.call(() => setGooBlur(svg, 1), 0.85);
      tl.call(() => overlay.removeAttribute('data-liquid'), 0.84);
      sfx.pop(700, 0.09);
      tl.play();
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      if (tl) tl.kill();
      if (!overlay) return;
      const svg = overlay.querySelector('.lqd-ai-goo');
      const trigIcon = overlay.querySelector('.lqd-ai-triggericon');
      const trigBody = overlay.querySelector('.lqd-ai-triggerbody');
      const satBlobs = Array.from(overlay.querySelectorAll('.lqd-ai-sat-blob'));
      const sats = Array.from(overlay.querySelectorAll('.lqd-ai-sat'));

      overlay.setAttribute('data-liquid', '');
      svg.style.opacity = '1';
      svg.style.visibility = 'visible';
      setGooBlur(svg, GOO_BLUR_SPREAD);

      tl = new Timeline();
      // gather (anticipate), then dive into the trigger
      tl.to(sats, { scale: 1.06, duration: 0.12, ease: ANTICIPATE }, 0);
      tl.to(satBlobs, { scale: 1.06, duration: 0.12, ease: ANTICIPATE }, 0);
      tl.to(sats, { x: 0, y: 0, scale: 0.11, duration: 0.16, ease: P2_IN }, 0.12);
      tl.to(satBlobs, { x: 0, y: 0, scale: 0.11, duration: 0.16, ease: P2_IN }, 0.12);
      tl.to(trigIcon, { autoAlpha: 1, rotation: 0, duration: 0.16, ease: OUT_STRONG }, 0.18);
      // splat on the trigger
      tl.to(trigBody, { scaleX: 1.18, scaleY: 0.84, duration: 0.08, ease: P2_OUT }, 0.24);
      tl.to(trigBody, { scaleX: 0.95, scaleY: 1.06, duration: 0.1, ease: P1_INOUT }, 0.32);
      tl.to(trigBody, { scaleX: 1, scaleY: 1, duration: 0.3, ease: SPRING }, 0.42);
      tl.to(svg, { autoAlpha: 0, duration: 0.14, ease: P1_OUT }, 0.5);
      tl.call(() => { if (overlay) overlay.remove(); overlay = null; }, 0.7);
      sfx.pop(430, 0.11);
      tl.play();
    }

    window.toggleAISpread = function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      if (isOpen) close(); else open();
    };
    window.openAISpread = open;
    window.closeAISpread = close;
  })();

  // ─── Init ───────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', liquidifyAllSelects);
  } else {
    liquidifyAllSelects();
  }
})();
