// ===== DeCloud procedural agent avatars =====
// MIT-licensed, written from scratch for DeCloud. Deterministic per agent name:
// same name -> same avatar, forever, on any machine. No external assets, no AI.
//
// Idea (procedural blob + eyes) is inspired by the "Bible Strong Avatar Lab"
// concept, but this is an independent implementation: no code is copied from
// that AGPL project. Only the *format* of "a shape + two eyes + colors" is
// shared, which is an idea, not copyrightable expression.

(function (global) {
  'use strict';

  // ── Seeded PRNG (FNV-1a hash -> mulberry32) ──────────────────────
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

  const SHAPES = ['sphere', 'cube', 'capsule', 'cone', 'diamond', 'mickey', 'cursor'];

  // ── Color helpers ─────────────────────────────────────────────────
  function hsl(h, s, l) {
    return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
  }
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  // ── Generator: name -> definition ────────────────────────────────
  function generate(name) {
    const seed = hash32(String(name || 'agent'));
    const rnd = mulberry32(seed);

    const shape = SHAPES[Math.floor(rnd() * SHAPES.length)];

    // Body color: vivid but tasteful. Hue from seed, sat/light in a nice band.
    const hue = Math.floor(rnd() * 360);
    const sat = 55 + Math.floor(rnd() * 25);   // 55-80
    const light = 48 + Math.floor(rnd() * 14); // 48-62
    const bodyHex = hslToHex(hue, sat, light);

    // Eye color: contrast against body. Dark body -> light eyes, light body -> dark eyes.
    const dark = luminance(bodyHex) < 0.5;
    const eyeHex = dark ? '#f5f7fa' : '#14161a';

    // Eyes: small vertical ellipses, clearly separated. Body is ~96 wide
    // (radius ~48), so eyes stay proportionally small and never touch.
    const eyeW = 5 + rnd() * 3;     // 5-8
    const eyeH = 12 + rnd() * 8;    // 12-20
    const spacing = 30 + rnd() * 14; // 30-44 center-to-center (half 15-22)
    const eyeY = -2 + rnd() * 4;     // -2..2 vertical offset
    const angle = (rnd() - 0.5) * 10; // -5..5 degrees tilt

    // Optional secondary nodes (ears / horns / antenna) for some shapes.
    const nodes = [];
    if (shape === 'mickey') {
      nodes.push({ kind: 'ear', x: -34, y: -34, r: 16 + rnd() * 6 });
      nodes.push({ kind: 'ear', x: 34, y: -34, r: 16 + rnd() * 6 });
    } else if (shape === 'cursor') {
      nodes.push({ kind: 'tip', x: 0, y: -52, r: 0 });
    } else if (rnd() < 0.3) {
      // occasional antenna
      nodes.push({ kind: 'antenna', x: (rnd() - 0.5) * 20, y: -46, r: 3 + rnd() * 3 });
    }

    return {
      name: String(name),
      shape,
      body: bodyHex,
      bodyHue: hue,
      bodySat: sat,
      bodyLight: light,
      eyes: eyeHex,
      eye: { w: eyeW, h: eyeH, spacing, y: eyeY, angle },
      nodes,
      blink: rnd() < 0.85, // most avatars blink
    };
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = n => Math.round(255 * f(n)).toString(16).padStart(2, '0');
    return `#${to(0)}${to(8)}${to(4)}`;
  }

  // ── Renderer: definition -> SVG string ────────────────────────────
  function render(def, size) {
    const s = size || 96;
    const id = 'dca' + hash32(def.name).toString(36);

    // Body silhouette path per shape (centered at 0,0 in a 100x100 box).
    const bodyPath = shapePath(def.shape);

    // Shading: radial gradient, lighter top-left, darker bottom-right.
    const light = hsl(def.bodyHue, def.bodySat, Math.min(92, def.bodyLight + 30));
    const dark = hsl(def.bodyHue, def.bodySat, Math.max(12, def.bodyLight - 22));

    const eye = def.eye;
    const halfSpacing = eye.spacing / 2;
    const eyeTransform = `rotate(${eye.angle})`;

    const nodesSvg = def.nodes.map(n => {
      if (n.kind === 'ear') {
        return `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${def.body}"/>`;
      }
      if (n.kind === 'antenna') {
        return `<line x1="${n.x}" y1="${n.y}" x2="${n.x}" y2="${n.y - 14}" stroke="${def.body}" stroke-width="3" stroke-linecap="round"/><circle cx="${n.x}" cy="${n.y - 16}" r="${n.r}" fill="${def.body}"/>`;
      }
      return '';
    }).join('');

    const blinkClass = def.blink ? ' dca-blink' : '';

    return `<svg class="dca-avatar" viewBox="-60 -60 120 120" width="${s}" height="${s}" role="img" aria-label="${esc(def.name)} avatar" style="display:block;overflow:visible">
  <defs>
    <radialGradient id="${id}-g" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${light}"/>
      <stop offset="100%" stop-color="${dark}"/>
    </radialGradient>
  </defs>
  <g class="dca-body">
    ${nodesSvg}
    <path d="${bodyPath}" fill="url(#${id}-g)" stroke="${dark}" stroke-width="1.5"/>
  </g>
  <g class="dca-eyes${blinkClass}">
    <ellipse cx="${-halfSpacing}" cy="${eye.y}" rx="${eye.w}" ry="${eye.h}" fill="${def.eyes}" transform="${eyeTransform}"/>
    <ellipse cx="${halfSpacing}" cy="${eye.y}" rx="${eye.w}" ry="${eye.h}" fill="${def.eyes}" transform="${eyeTransform}"/>
  </g>
</svg>`;
  }

  function shapePath(shape) {
    switch (shape) {
      case 'sphere':
        return 'M0,-48 A48,48 0 1 1 0,48 A48,48 0 1 1 0,-48 Z';
      case 'cube': {
        // rounded square (squircle-ish)
        const r = 16, h = 44;
        return `M${-h + r},${-h} L${h - r},${-h} Q${h},${-h} ${h},${-h + r} L${h},${h - r} Q${h},${h} ${h - r},${h} L${-h + r},${h} Q${-h},${h} ${-h},${h - r} L${-h},${-h + r} Q${-h},${-h} ${-h + r},${-h} Z`;
      }
      case 'capsule': {
        const w = 38, h = 50, r = 19;
        return `M${-w},${-h + r} A${r},${r} 0 0 1 ${w},${-h + r} L${w},${h - r} A${r},${r} 0 0 1 ${-w},${h - r} Z`;
      }
      case 'cone': {
        // rounded teardrop/cone: soft tip, rounded base
        return `M0,${-50} Q${20},${-30} ${40},${-6} Q${46},${6} ${40},${18} Q${34},${30} ${22},${34} L${-22},${34} Q${-34},${30} ${-40},${18} Q${-46},${6} ${-40},${-6} Q${-20},${-30} 0,${-50} Z`;
      }
      case 'diamond': {
        // rounded diamond (kite with soft corners)
        return `M0,${-50} Q${14},${-14} ${44},0 Q${14},${14} 0,${50} Q${-14},${14} ${-44},0 Q${-14},${-14} 0,${-50} Z`;
      }
      case 'mickey': {
        return 'M0,-40 A40,40 0 1 1 0,40 A40,40 0 1 1 0,-40 Z';
      }
      case 'cursor': {
        // rounded blob with a soft point on top (like a speech-bubble tail)
        return `M0,${-52} Q${10},${-34} ${18},${-22} Q${30},${-8} ${40},${-2} Q${48},${4} ${40},${12} Q${30},${22} ${16},${26} L${-16},${26} Q${-30},${22} ${-40},${12} Q${-48},${4} ${-40},${-2} Q${-30},${-8} ${-18},${-22} Q${-10},${-34} 0,${-52} Z`;
      }
      default:
        return 'M0,-48 A48,48 0 1 1 0,48 A48,48 0 1 1 0,-48 Z';
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Public API ───────────────────────────────────────────────────
  const DeCloudAvatar = {
    generate,
    render,
    // Convenience: name -> full SVG string
    svg(name, size) {
      return render(generate(name), size);
    },
    // Inject the blink keyframes once
    injectStyles() {
      if (document.getElementById('dca-styles')) return;
      const style = document.createElement('style');
      style.id = 'dca-styles';
      style.textContent = `
        .dca-avatar .dca-eyes { transform-origin: center; }
        .dca-avatar .dca-blink { animation: dca-blink 4.5s infinite; }
        @keyframes dca-blink {
          0%, 92%, 100% { transform: scaleY(1); }
          95% { transform: scaleY(0.08); }
        }
        .dca-avatar .dca-body { transform-origin: center; }
        .dca-avatar:hover .dca-body { animation: dca-bob 1.6s ease-in-out infinite; }
        @keyframes dca-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
      `;
      document.head.appendChild(style);
    },
  };

  global.DeCloudAvatar = DeCloudAvatar;
  if (typeof module !== 'undefined' && module.exports) module.exports = DeCloudAvatar;
})(typeof window !== 'undefined' ? window : globalThis);
