// ===== DeCloud procedural agent avatars — animated silhouette renderer =====
// MIT-licensed, written from scratch. Renders a smooth flat-colored silhouette
// (convex hull of a projected 3D superellipsoid, smoothed with Catmull-Rom
// curves) with eyes projected onto the curved surface and clipped to the head.
//
// Live idle motion, matching the "alive" feel of the Bible Strong editor:
//   - body slow-drift: subtle head rotation via smooth noise
//   - eye micro-saccades: quick small eye jumps
//   - blinking: periodic eye-height collapse
// Same math idea, independent implementation (no AGPL code copied).

(function (global) {
  'use strict';

  // ── Seeded PRNG ─────────────────────────────────────────────────
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0');
    return `#${to(0)}${to(8)}${to(4)}`;
  }
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  // ── 3D surface math ────────────────────────────────────────────
  const signedPow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
  function superellipsoid(lon, lat, w, h, d, ex, ey) {
    const latCos = signedPow(Math.cos(lat), ey);
    return [
      (w / 2) * latCos * signedPow(Math.sin(lon), ex),
      (h / 2) * signedPow(Math.sin(lat), ey),
      (d / 2) * latCos * signedPow(Math.cos(lon), ex),
    ];
  }

  const FOCAL = 620;
  function project(p, persp) {
    const denom = FOCAL - p[2] * persp;
    const scale = Math.abs(denom) < 0.0001 ? FOCAL / 0.0001 : FOCAL / denom;
    return [p[0] * scale, p[1] * scale];
  }

  // ── Quaternion rotation (for head drift) ───────────────────────
  function qAxisAngle(axis, angle) {
    const h = angle / 2, s = Math.sin(h);
    return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
  }
  function qMul(a, b) {
    const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
    return [
      aw * bw - ax * bx - ay * by - az * bz,
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
    ];
  }
  function qFromEuler(x, y, z) {
    const xr = qAxisAngle([1, 0, 0], x), yr = qAxisAngle([0, 1, 0], y), zr = qAxisAngle([0, 0, 1], z);
    return qMul(qMul(zr, xr), yr);
  }
  function qRotate(q, p) {
    const [w, x, y, z] = q, [px, py, pz] = p;
    const tx = 2 * (y * pz - z * py), ty = 2 * (z * px - x * pz), tz = 2 * (x * py - y * px);
    return [px + w * tx + (y * tz - z * ty), py + w * ty + (z * tx - x * tz), pz + w * tz + (x * ty - y * tx)];
  }

  // ── Shape families ──────────────────────────────────────────────
  const FAMILIES = ['sphere', 'cube', 'capsule', 'diamond', 'mickey', 'cone', 'cylinder'];
  function shapeParams(shape, rnd) {
    switch (shape) {
      case 'sphere': return { ex: 1, ey: 1, w: 96, h: 96, d: 96 };
      case 'cube': return { ex: 0.14 + rnd() * 0.18, ey: 0.14 + rnd() * 0.18, w: 88, h: 88, d: 80 };
      case 'capsule': return { ex: 1, ey: 0.42 + rnd() * 0.22, w: 78, h: 102, d: 78 };
      case 'diamond': return { ex: 1.4 + rnd() * 0.5, ey: 1.4 + rnd() * 0.5, w: 90, h: 100, d: 90 };
      case 'mickey': return { ex: 1, ey: 1, w: 88, h: 88, d: 88, ears: true };
      case 'cone': return { ex: 1, ey: 1.5 + rnd() * 0.5, w: 88, h: 104, d: 88 };
      case 'cylinder': return { ex: 0.5 + rnd() * 0.3, ey: 0.5 + rnd() * 0.3, w: 84, h: 96, d: 84 };
      default: return { ex: 1, ey: 1, w: 96, h: 96, d: 96 };
    }
  }

  // ── Generator ───────────────────────────────────────────────────
  function generate(name) {
    const seed = hash32(String(name || 'agent'));
    const rnd = mulberry32(seed);

    const shape = FAMILIES[Math.floor(rnd() * FAMILIES.length)];
    const sp = shapeParams(shape, rnd);

    const hue = Math.floor(rnd() * 360);
    const sat = 55 + Math.floor(rnd() * 25);
    const light = 48 + Math.floor(rnd() * 14);
    const bodyHex = hslToHex(hue, sat, light);
    const dark = luminance(bodyHex) < 0.5;
    const eyeHex = dark ? '#f5f7fa' : '#14161a';

    const eyeW = 7 + rnd() * 4;
    const eyeH = 18 + rnd() * 10;
    const spacing = 30 + rnd() * 12;
    const eyeY = -3 + rnd() * 6;
    const angle = (rnd() - 0.5) * 8;

    return {
      name: String(name),
      shape,
      body: bodyHex,
      eye: eyeHex,
      eyeW, eyeH, spacing, eyeY, angle,
      sp,
      // per-avatar motion seed so each drifts differently
      motionSeed: rnd() * 1000,
      blinkInterval: 3000 + rnd() * 3000,
    };
  }

  // ── Convex hull + Catmull-Rom smoothing ────────────────────────
  function convexHull(points) {
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (src) => {
      const res = [];
      for (const p of src) {
        while (res.length >= 2 && cross(res[res.length - 2], res[res.length - 1], p) <= 0) res.pop();
        res.push(p);
      }
      return res;
    };
    const lower = half(sorted), upper = half(sorted.reverse());
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
  }
  function smoothClosedPath(points) {
    if (points.length < 3) return '';
    const at = (i) => points[(i + points.length) % points.length];
    let d = `M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
    for (let i = 0; i < points.length; i++) {
      const prev = at(i - 1), cur = at(i), next = at(i + 1), after = at(i + 2);
      const c1x = cur[0] + (next[0] - prev[0]) / 6, c1y = cur[1] + (next[1] - prev[1]) / 6;
      const c2x = next[0] - (after[0] - cur[0]) / 6, c2y = next[1] - (after[1] - cur[1]) / 6;
      d += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${next[0].toFixed(2)} ${next[1].toFixed(2)}`;
    }
    return d + 'Z';
  }

  // ── Smooth noise + saccade (idle motion) ───────────────────────
  const smoothstep = (v) => v * v * (3 - 2 * v);
  const noiseHash = (v) => {
    const r = Math.sin(v * 127.1 + 311.7) * 43758.5453;
    return (r - Math.floor(r)) * 2 - 1;
  };
  function smoothNoise(elapsedMs, axis, seed, interval) {
    const progress = elapsedMs / interval;
    const step = Math.floor(progress);
    const blend = smoothstep(progress - step);
    const prev = noiseHash(step * 3 + axis + seed);
    const next = noiseHash((step + 1) * 3 + axis + seed);
    return prev + (next - prev) * blend;
  }
  function saccade(elapsedMs, axis, seed) {
    const interval = 1100, duration = 140;
    if (elapsedMs <= 0) return 0;
    const step = Math.floor(elapsedMs / interval);
    const progress = (elapsedMs - step * interval) / duration;
    const blend = smoothstep(Math.min(progress, 1));
    const prev = step === 0 ? 0 : noiseHash((step - 1) * 2 + axis + seed);
    const next = noiseHash(step * 2 + axis + seed);
    return prev + (next - prev) * blend;
  }

  const easeInOut = (v) => (v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2);

  // ── Gaze controller: natural "look around" behavior ─────────────
  // A state machine of pauses and glances, not a constant oscillation:
  //   hold still → glance to a new angle (varied speed) → hold → glance back…
  // Produces the organic "idle person looking around" feel.
  function createGaze(seed) {
    const rnd = mulberry32(seed);
    let yaw = 0, fromYaw = 0, targetYaw = 0;
    let phase = 'hold', phaseStart = 0, phaseDur = 0.6 + rnd() * 1.2;
    return function (now) {
      while (now >= phaseStart + phaseDur) {
        phaseStart += phaseDur;
        if (phase === 'hold') {
          fromYaw = yaw;
          const r = rnd();
          if (r < 0.55) targetYaw = (rnd() - 0.5) * 28;        // small glance ±14°
          else if (r < 0.88) targetYaw = (rnd() - 0.5) * 52;    // bigger look ±26°
          else targetYaw = (rnd() - 0.5) * 14;                  // tiny shift ±7°
          const sp = rnd();
          phaseDur = sp < 0.35 ? 0.25 + rnd() * 0.35 : 0.7 + rnd() * 1.6; // quick vs slow
          phase = 'move';
        } else {
          yaw = targetYaw;
          phaseDur = 0.5 + rnd() * 2.4; // pause
          phase = 'hold';
        }
      }
      if (phase === 'move') {
        const p = Math.max(0, Math.min(1, (now - phaseStart) / phaseDur));
        yaw = fromYaw + (targetYaw - fromYaw) * easeInOut(p);
      }
      return yaw;
    };
  }

  // ── Rounded rectangle (eye shape) ──────────────────────────────
  function roundedRect(w, h) {
    const hw = w / 2, hh = h / 2, r = Math.min(hw, hh);
    const pts = [];
    const line = (sx, sy, ex, ey) => {
      const n = Math.max(2, Math.ceil(Math.hypot(ex - sx, ey - sy) / 1.5));
      for (let i = 0; i < n; i++) pts.push([sx + (ex - sx) * i / n, sy + (ey - sy) * i / n]);
    };
    const arc = (cx, cy, a0) => {
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI / 2;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
    };
    line(-hw + r, -hh, hw - r, -hh); arc(hw - r, -hh + r, -Math.PI / 2);
    line(hw, -hh + r, hw, hh - r); arc(hw - r, hh - r, 0);
    line(hw - r, hh, -hw + r, hh); arc(-hw + r, hh - r, Math.PI / 2);
    line(-hw, hh - r, -hw, -hh + r); arc(-hw + r, -hh + r, Math.PI);
    return pts;
  }

  // ── Live avatar component ──────────────────────────────────────
  function createAvatar(target, def, size) {
    const s = size || 96;
    const sp = def.sp;
    const id = 'dca' + hash32(def.name).toString(36) + Math.floor(Math.random() * 1e6).toString(36);

    // Cache local surface samples (recomputed only once).
    const headLocal = [];
    {
      const LAT = 25, LON = 73;
      for (let j = 0; j < LAT; j++) {
        const lat = -Math.PI / 2 + (j / (LAT - 1)) * Math.PI;
        for (let i = 0; i < LON; i++) {
          const lon = -Math.PI + (i / (LON - 1)) * Math.PI * 2;
          headLocal.push(superellipsoid(lon, lat, sp.w, sp.h, sp.d, sp.ex, sp.ey));
        }
      }
    }
    const earLocal = [];
    if (sp.ears) {
      const r = Math.min(sp.w, sp.h) * 0.23;
      const cx = sp.w * 0.37, cy = -sp.h * 0.39, cz = -sp.d * 0.12;
      for (const side of [-1, 1]) {
        const LAT = 17, LON = 49, pts = [];
        for (let j = 0; j < LAT; j++) {
          const lat = -Math.PI / 2 + (j / (LAT - 1)) * Math.PI;
          for (let i = 0; i < LON; i++) {
            const lon = -Math.PI + (i / (LON - 1)) * Math.PI * 2;
            const p = superellipsoid(lon, lat, r * 2, r * 2, r * 2, 1, 1);
            pts.push([p[0] + side * cx, p[1] + cy, p[2] + cz]);
          }
        }
        earLocal.push(pts);
      }
    }

    // Build SVG skeleton.
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error('Avatar target not found');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '-60 -60 120 120');
    svg.setAttribute('width', s); svg.setAttribute('height', s);
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', def.name + ' avatar');
    svg.style.display = 'block'; svg.style.overflow = 'visible';
    svg.classList.add('dca-avatar');

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    clip.id = id + '-clip';
    const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    clip.appendChild(clipPath); defs.appendChild(clip); svg.appendChild(defs);

    const bodyG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    bodyG.classList.add('dca-body');
    const earPaths = earLocal.map(() => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('fill', def.body); bodyG.appendChild(p); return p;
    });
    const headPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    headPath.setAttribute('fill', def.body); bodyG.appendChild(headPath);
    svg.appendChild(bodyG);

    const eyeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    eyeG.setAttribute('clip-path', 'url(#' + id + '-clip)');
    const leftPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const rightPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    leftPath.setAttribute('fill', def.eye); rightPath.setAttribute('fill', def.eye);
    eyeG.appendChild(leftPath); eyeG.appendChild(rightPath);
    svg.appendChild(eyeG);

    host.appendChild(svg);

    // ── Per-frame render ──────────────────────────────────────────
    const start = performance.now();
    let raf = null, destroyed = false;
    const gaze = createGaze(def.motionSeed);

    function eyePath(side, blink, saccX, saccY, q) {
      const rx = sp.w / 2, ry = sp.h / 2, rz = sp.d / 2;
      const centerX = (side * def.spacing) / 2 + saccX;
      const centerY = def.eyeY + saccY;
      const angle = (def.angle * Math.PI) / 180;
      const h = 5 + (def.eyeH - 5) * blink; // blink collapses height toward 5
      const rect = roundedRect(def.eyeW, h);
      const pts = [];
      for (const [lx, ly] of rect) {
        const rotX = lx * Math.cos(angle) - ly * Math.sin(angle);
        const rotY = lx * Math.sin(angle) + ly * Math.cos(angle);
        const fx = centerX + rotX, fy = centerY + rotY;
        const nx = Math.max(-1, Math.min(1, fx / rx));
        const ny = Math.max(-1, Math.min(1, fy / ry));
        const rem = Math.max(0, 1 - nx * nx - ny * ny);
        const z = rz * Math.sqrt(rem);
        // rotate the 3D surface point with the head, then project
        pts.push(project(qRotate(q, [fx, fy, z]), 1));
      }
      return smoothClosedPath(convexHull(pts));
    }

    function tick(now) {
      raf = null;
      if (destroyed) return;
      const elapsed = now - start;
      const seed = def.motionSeed;

      // Head turn: natural gaze (pauses + glances), not a constant drift.
      const t = elapsed / 1000;
      const yaw = gaze(t);
      const pitch = smoothNoise(elapsed, 1, seed, 3300) * 6;   // ±6° drift
      const roll = smoothNoise(elapsed, 2, seed, 4100) * 4;     // ±4° drift
      const q = qFromEuler(pitch * Math.PI / 180, yaw * Math.PI / 180, roll * Math.PI / 180);

      // Head silhouette.
      const headPts = headLocal.map((p) => project(qRotate(q, p), 1));
      const headD = smoothClosedPath(convexHull(headPts));
      headPath.setAttribute('d', headD);
      clipPath.setAttribute('d', headD);

      // Ears (rotate with head).
      earPaths.forEach((pathEl, i) => {
        const pts = earLocal[i].map((p) => project(qRotate(q, p), 1));
        pathEl.setAttribute('d', smoothClosedPath(convexHull(pts)));
      });

      // Eye micro-saccades.
      const saccX = saccade(elapsed, 0, 17.29) * 1.5;
      const saccY = saccade(elapsed, 1, 17.29) * 0.9;

      // Blink: periodic.
      const cycle = elapsed % def.blinkInterval;
      const blinkDur = 150;
      let blink = 1;
      if (cycle < blinkDur) {
        const p = cycle / blinkDur;
        blink = 1 - Math.sin(p * Math.PI); // 1 -> 0 -> 1
      }

      leftPath.setAttribute('d', eyePath(-1, blink, saccX, saccY, q));
      rightPath.setAttribute('d', eyePath(1, blink, saccX, saccY, q));

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);

    return {
      destroy() { destroyed = true; if (raf) cancelAnimationFrame(raf); svg.remove(); },
      element: svg,
    };
  }

  // ── Static render (for previews / non-animated contexts) ───────
  function render(def, size) {
    const s = size || 96;
    const id = 'dca' + hash32(def.name).toString(36);
    const sp = def.sp;
    const head = smoothClosedPath(convexHull(headSamples(sp)));
    const ears = sp.ears ? earSamples(sp).map((pts) => smoothClosedPath(convexHull(pts))).join('') : '';
    const left = staticEye(sp, -1, def);
    const right = staticEye(sp, 1, def);
    return `<svg class="dca-avatar" viewBox="-60 -60 120 120" width="${s}" height="${s}" role="img" aria-label="${esc(def.name)} avatar" style="display:block;overflow:visible">
  <defs><clipPath id="${id}-clip"><path d="${head}"/></clipPath></defs>
  <g class="dca-body">${ears ? `<path d="${ears}" fill="${def.body}"/>` : ''}<path d="${head}" fill="${def.body}"/></g>
  <g clip-path="url(#${id}-clip)"><path d="${left}" fill="${def.eye}"/><path d="${right}" fill="${def.eye}"/></g>
</svg>`;
  }

  function headSamples(sp) {
    const LAT = 25, LON = 73, pts = [];
    for (let j = 0; j < LAT; j++) {
      const lat = -Math.PI / 2 + (j / (LAT - 1)) * Math.PI;
      for (let i = 0; i < LON; i++) {
        const lon = -Math.PI + (i / (LON - 1)) * Math.PI * 2;
        pts.push(project(superellipsoid(lon, lat, sp.w, sp.h, sp.d, sp.ex, sp.ey), 1));
      }
    }
    return pts;
  }
  function earSamples(sp) {
    const r = Math.min(sp.w, sp.h) * 0.23;
    const cx = sp.w * 0.37, cy = -sp.h * 0.39, cz = -sp.d * 0.12;
    return [-1, 1].map((side) => {
      const LAT = 17, LON = 49, pts = [];
      for (let j = 0; j < LAT; j++) {
        const lat = -Math.PI / 2 + (j / (LAT - 1)) * Math.PI;
        for (let i = 0; i < LON; i++) {
          const lon = -Math.PI + (i / (LON - 1)) * Math.PI * 2;
          const p = superellipsoid(lon, lat, r * 2, r * 2, r * 2, 1, 1);
          pts.push(project([p[0] + side * cx, p[1] + cy, p[2] + cz], 1));
        }
      }
      return pts;
    });
  }
  function staticEye(sp, side, def) {
    const rx = sp.w / 2, ry = sp.h / 2, rz = sp.d / 2;
    const centerX = (side * def.spacing) / 2, centerY = def.eyeY;
    const angle = (def.angle * Math.PI) / 180;
    const pts = [];
    for (const [lx, ly] of roundedRect(def.eyeW, def.eyeH)) {
      const rotX = lx * Math.cos(angle) - ly * Math.sin(angle);
      const rotY = lx * Math.sin(angle) + ly * Math.cos(angle);
      const fx = centerX + rotX, fy = centerY + rotY;
      const nx = Math.max(-1, Math.min(1, fx / rx));
      const ny = Math.max(-1, Math.min(1, fy / ry));
      const rem = Math.max(0, 1 - nx * nx - ny * ny);
      pts.push(project([fx, fy, rz * Math.sqrt(rem)], 1));
    }
    return smoothClosedPath(convexHull(pts));
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const DeCloudAvatar3D = {
    generate,
    render,
    createAvatar,
    svg(name, size) { return render(generate(name), size); },
  };

  global.DeCloudAvatar3D = DeCloudAvatar3D;
  if (typeof module !== 'undefined' && module.exports) module.exports = DeCloudAvatar3D;
})(typeof window !== 'undefined' ? window : globalThis);
