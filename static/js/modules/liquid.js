// ===== Module: liquid =====
// DeCloud motion layer — REAL elements only. No goo filters, no clones:
// a goo/metaball effect fundamentally requires rendered copies of the
// shapes, so this version animates the actual DOM elements instead.
//
//   1. Press-squash on real buttons/tiles (transform-safe: never
//      touches an element that already has its own inline transform,
//      so swipe mode and other app animations are never clobbered).
//   2. A subtle rounded-square click ripple on one shared canvas.
//   3. The AI tile itself stretches and splats (the real tile in the
//      grid — nothing drawn over it), while its satellites pop out
//      with spring physics and ring still.
//
// Spring curves and easing shapes ported from liquid-taffy
// (MIT, (c) 2026 arknow91); reduced-motion users get instant versions.

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
        if (dx <= 0) return prev[1];
        return prev[1] + ((t - prev[0]) / dx) * (points[i][1] - prev[1]);
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

  // ─── Tween engine (real elements only, exception-guarded) ──────
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
        this._entries.forEach((e) => {
          try { if (e.fn) e.fn(); else applyVars(e.targets, e.vars, false); } catch (err) { console.error('[liquid]', err); }
        });
        return;
      }
      const start = performance.now();
      const step = () => {
        if (this._killed) return;
        try {
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
        } catch (err) {
          console.error('[liquid] timeline error:', err);
        }
      };
      this._raf = requestAnimationFrame(step);
    }
  }

  function applyVars(targets, vars, isSet, t) {
    const list = Array.isArray(targets) ? targets : [targets];
    const k = (isSet || t === undefined) ? 1 : t;
    for (const el of list) {
      if (!el || !el.style) continue;
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

  // ─── 1. PRESS-SQUASH (transform-safe) ───────────────────────────
  // Only touches elements with no inline transform of their own, so
  // swipe mode, drags, and other app animations are never clobbered.
  const PRESS_SELECTOR = 'button, .app-icon';

  document.addEventListener('pointerdown', (e) => {
    if (reducedMotion) return;
    const el = e.target.closest && e.target.closest(PRESS_SELECTOR);
    if (!el || el.style.transform) return;   // another system owns this element's transform
    const tl = new Timeline();
    tl.to(el, { scale: 0.93, duration: 0.09, ease: OUT_STRONG }, 0);
    tl.play();
    const restore = () => {
      const t2 = new Timeline();
      t2.to(el, { scale: 1, duration: 0.3, ease: SPRING }, 0);
      t2.play();
    };
    window.addEventListener('pointerup', restore, { once: true });
  }, { passive: true });

  // ─── 2. CLICK RIPPLE (one shared canvas, subtle squircle drop) ──
  const overlaySVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlaySVG.setAttribute('class', 'lqd-overlay');
  overlaySVG.setAttribute('aria-hidden', 'true');
  overlaySVG.innerHTML =
    `<defs><filter id="lqd-overlay-goo" filterUnits="userSpaceOnUse" x="0" y="0" width="${window.innerWidth}" height="${window.innerHeight}" color-interpolation-filters="sRGB">
       <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur"/>
       <feColorMatrix in="blur" type="matrix"
         values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 30 -14.5146" result="goo"/>
       <feFlood style="flood-color: var(--lqd-rim)" result="rimColor"/>
       <feComposite in="rimColor" in2="goo" operator="in" result="rimFull"/>
       <feMerge><feMergeNode in="rimFull"/><feMergeNode in="goo"/></feMerge>
     </filter></defs><g filter="url(#lqd-overlay-goo)"></g>`;
  document.body.appendChild(overlaySVG);
  const overlayGroup = overlaySVG.querySelector('g');

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

  function spawnRipple(x, y) {
    if (reducedMotion) return;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', squirclePath(-9, -9, 18, 18, 8));
    p.setAttribute('class', 'lqd-ripple');
    p.style.transformOrigin = 'center';
    p.style.transform = `translate(${x}px, ${y}px) scale(0.4)`;
    overlayGroup.appendChild(p);
    const tl = new Timeline();
    tl.to(p, { scale: 1.4, opacity: 0.45, duration: 0.15, ease: P2_OUT }, 0);
    tl.to(p, { scale: 2, opacity: 0, duration: 0.3, ease: P2_OUT }, 0.11);
    tl.call(() => { try { p.remove(); } catch (e) {} }, 0.44);
    tl.play();
  }

  document.addEventListener('click', (e) => {
    if (reducedMotion) return;
    const el = e.target.closest && e.target.closest(PRESS_SELECTOR);
    if (!el) return;
    spawnRipple(e.clientX, e.clientY);
  }, { passive: true });

  // ─── 3. AI SPREAD: THE REAL TILE STRETCHES ──────────────────────
  // No overlay drawn over the tile — the tile you press is the tile
  // that moves. Satellites are real buttons that spring out and ring.

  (function setupAISpread() {
    if (typeof openAISpread !== 'function') return;
    const SUBAPPS = (typeof AI_SUBAPPS !== 'undefined') ? AI_SUBAPPS : [];
    if (!SUBAPPS.length) return;
    const ITEM = 72;
    const HALF = ITEM / 2;

    let wrap = null;
    let tl = null;
    let isOpen = false;

    function findTile() { return document.querySelector('[data-app-id="ai"]'); }

    function fanGeometry() {
      const tile = findTile();
      if (!tile) return null;
      const rect = tile.getBoundingClientRect();
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
      if (cosE > 0.01) maxRE = Math.min(maxRE, (window.innerWidth - margin - cx - HALF) / cosE);
      if (cosE < -0.01) maxRE = Math.min(maxRE, (cx - margin + HALF) / -cosE);
      if (sinE > 0.01) maxRE = Math.min(maxRE, (window.innerHeight - margin - cy - HALF) / sinE);
      if (sinE < -0.01) maxRE = Math.min(maxRE, (cy - margin + HALF) / -sinE);
      r = Math.max(70, Math.min(r, maxR, maxRE - ITEM));
      const targets = SUBAPPS.map((_sub, i) => {
        const frac = n === 1 ? 0.5 : i / (n - 1);
        const angle = fanAngle - halfArc + frac * (halfArc * 2);
        return { dx: Math.cos(angle) * r, dy: Math.sin(angle) * r };
      });
      return { cx, cy, targets };
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      if (tl) tl.kill();
      const geo = fanGeometry();
      const tile = findTile();
      if (!geo || !tile) { isOpen = false; return; }

      wrap = document.createElement('div');
      wrap.className = 'lqd-ai2-wrap';
      wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

      const satellites = SUBAPPS.map((sub, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lqd-ai2-item';
        b.style.left = (geo.cx - HALF) + 'px';
        b.style.top = (geo.cy - HALF) + 'px';
        b.innerHTML = `<span class="lqd-ai2-icon" style="color:${sub.color}">${sub.svg}</span>` +
          `<span class="lqd-ai2-label">${sub.label}</span>`;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          close();
          setTimeout(() => {
            showScreen(sub.screen);
            if (sub.id === 'ollama') { location.hash = '#ollama'; loadOllamaModels(); }
            if (sub.id === 'comfy') { location.hash = '#comfy'; loadComfyStatus(); loadComfyModels(); loadComfyGallery(); }
            if (sub.id === 'musicgen') { location.hash = '#musicgen'; loadMusicGen(); }
            if (sub.id === 'agents') { location.hash = '#agents'; }
          }, 50);
        });
        wrap.appendChild(b);
        return b;
      });
      document.body.appendChild(wrap);

      // The real tile: stretch up into the pour, icon becomes an X
      const icon = tile.querySelector('svg');
      tile.classList.add('ai-spread-active');
      tl = new Timeline();
      tl.set(satellites, { x: 0, y: 0, scale: 0.11 }, 0);
      tl.to(tile, { scaleX: 1.06, scaleY: 1.2, duration: 0.12, ease: OUT_STRONG }, 0);
      tl.to(tile, { scaleX: 1, scaleY: 1, duration: 0.34, ease: SPRING }, 0.14);
      if (icon) tl.to(icon, { rotation: 135, duration: 0.22, ease: SPRING }, 0.05);
      satellites.forEach((b, i) => {
        const t = geo.targets[i];
        tl.to(b, { x: t.dx, y: t.dy, duration: 0.12, ease: OUT_STRONG }, 0.02 + i * 0.04);
        tl.to(b, { scale: 1.08, duration: 0.4, ease: POP }, 0.12 + i * 0.04);
        tl.to(b, { scale: 1, duration: 0.28, ease: SPRING }, 0.5 + i * 0.04);
      });
      tl.play();
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      if (tl) tl.kill();
      const tile = findTile();
      const icon = tile ? tile.querySelector('svg') : null;
      const satellites = wrap ? Array.from(wrap.querySelectorAll('.lqd-ai2-item')) : [];
      const w = wrap;
      wrap = null;

      tl = new Timeline();
      satellites.forEach((b) => {
        tl.to(b, { scale: 1.05, duration: 0.1, ease: ANTICIPATE }, 0);
        tl.to(b, { x: 0, y: 0, scale: 0.11, duration: 0.14, ease: P2_IN }, 0.1);
      });
      if (icon) tl.to(icon, { rotation: 0, duration: 0.16, ease: OUT_STRONG }, 0.12);
      if (tile) {
        tl.to(tile, { scaleX: 1.16, scaleY: 0.84, duration: 0.07, ease: P2_OUT }, 0.2);
        tl.to(tile, { scaleX: 0.95, scaleY: 1.05, duration: 0.09, ease: P1_INOUT }, 0.27);
        tl.to(tile, { scaleX: 1, scaleY: 1, duration: 0.3, ease: SPRING }, 0.36);
        tl.call(() => tile.classList.remove('ai-spread-active'), 0.66);
      }
      tl.call(() => { try { w.remove(); } catch (e) {} }, 0.3);
      tl.play();
    }

    window.toggleAISpread = function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      if (isOpen) close(); else open();
    };
    window.openAISpread = open;
    window.closeAISpread = close;
  })();
})();
