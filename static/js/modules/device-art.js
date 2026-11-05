// ===== Module: device-art — small 3D-style drawings of each kind of device =====
// deviceArt(type, cls) -> <svg>. Types come from lab_report.device_kind():
// spark, dgx, desktop, laptop, mini, server, pi, mac, macbook, vm, computer,
// plus iphone and android for phones added from Tailscale.
// Drawn on a 64x64 isometric grid; no dependencies so it can be previewed alone.

const DA_C = 0.866, DA_S = 0.5;
const DA_NS = 'vector-effect="non-scaling-stroke"';

// One isometric box. (x, y) is the back top corner; w runs down-right, d runs down-left.
// top/left/right: fill for each visible face; *Art: extra SVG drawn in that face's own
// flat coordinates (top: w x d, left: w x h, right: d x h).
function daBox(o) {
  const P0 = [o.x, o.y];
  const P1 = [o.x + o.w * DA_C, o.y + o.w * DA_S];
  const P3 = [o.x - o.d * DA_C, o.y + o.d * DA_S];
  const P2 = [P1[0] - o.d * DA_C, P1[1] + o.d * DA_S];
  const m = (a, b, c, d, p) => `matrix(${a} ${b} ${c} ${d} ${p[0].toFixed(2)} ${p[1].toFixed(2)})`;
  const edge = o.edge || 'rgba(0,0,0,.35)';
  const face = (t, wd, ht, fill, art) => `<g transform="${t}"><rect width="${wd}" height="${ht}" fill="${fill}" stroke="${edge}" stroke-width=".6" ${DA_NS}/>${art || ''}</g>`;
  return face(m(DA_C, DA_S, -DA_C, DA_S, P0), o.w, o.d, o.top, o.topArt)
    + face(m(DA_C, DA_S, 0, 1, P3), o.w, o.h, o.left, o.leftArt)
    + face(m(DA_C, -DA_S, 0, 1, P2), o.d, o.h, o.right, o.rightArt);
}

function daShadow(cx, cy, rx) {
  return `<ellipse class="da-shadow" cx="${cx}" cy="${cy}" rx="${rx}" ry="${rx * 0.36}" fill="#000" opacity=".18"/>`;
}

function daFoam(w, h, id, seed = 7) {
  // DGX Spark front: an open-cell metal foam. Irregular pores, seeded so it never changes.
  let r = seed, dots = '';
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  for (let y = .7; y < h - .3; y += .95) for (let x = .5 + (Math.round(y * 4) % 2) * .45; x < w - .2; x += .9) {
    const px = x + (rnd() - .5) * .45, py = y + (rnd() - .5) * .4, pr = .2 + rnd() * .2;
    dots += `<ellipse cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" rx="${pr.toFixed(2)}" ry="${(pr * (.75 + rnd() * .4)).toFixed(2)}"/>`;
  }
  return `<g fill="url(#${id})">${dots}</g><rect width="${w}" height="${h}" fill="url(#${id}-sheen)"/>`;
}

const DEVICE_ART = {
  spark: () => `
    <defs><linearGradient id="da-gold-top" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1e3bf"/><stop offset=".6" stop-color="#dcc493"/><stop offset="1" stop-color="#c8ab72"/></linearGradient>
      <linearGradient id="da-gold-l" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#cfb27a"/><stop offset="1" stop-color="#a88a52"/></linearGradient>
      <linearGradient id="da-gold-r" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#b49359"/><stop offset=".5" stop-color="#c7a96f"/><stop offset="1" stop-color="#9c7d46"/></linearGradient>
      <linearGradient id="da-pore" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#5a4522"/><stop offset="1" stop-color="#33260f"/></linearGradient>
      <linearGradient id="da-pore-sheen" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".18"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    ${daShadow(32, 52, 26)}
    ${daBox({ x: 32, y: 17, w: 30, d: 30, h: 10.5, top: 'url(#da-gold-top)', left: 'url(#da-gold-l)', right: 'url(#da-gold-r)', edge: 'rgba(90,68,30,.5)',
      leftArt: daFoam(30, 9.6, 'da-pore') + '<rect y="9.6" width="30" height=".9" fill="#3a2d17"/>',
      rightArt: '<rect y="9.6" width="30" height=".9" fill="#3a2d17"/><rect width="30" height=".5" fill="#fff" opacity=".25"/>',
      topArt: '<rect x=".6" y=".6" width="28.8" height="28.8" rx="1.6" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width=".5"/>' })}`,

  dgx: () => `
    <defs><linearGradient id="da-dgx" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#d4b673"/><stop offset="1" stop-color="#8f6f3c"/></linearGradient>
      <linearGradient id="da-pore2" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#5b4523"/><stop offset="1" stop-color="#3b2c15"/></linearGradient></defs>
    ${daShadow(33, 57, 15)}
    ${daBox({ x: 38, y: 6, w: 16, d: 26, h: 34, top: '#e8d39f', left: 'url(#da-dgx)', right: '#9a7a44', edge: 'rgba(80,60,25,.55)',
      leftArt: daFoam(16, 34, 'da-pore2') })}`,

  desktop: () => `
    <defs><linearGradient id="da-case" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#2e333d"/><stop offset="1" stop-color="#191c22"/></linearGradient>
      <linearGradient id="da-glass" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#20252f"/><stop offset="1" stop-color="#0f1217"/></linearGradient>
      <linearGradient id="da-shine" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff" stop-opacity=".16"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <pattern id="da-mesh" width="1.4" height="1.4" patternUnits="userSpaceOnUse"><circle cx=".7" cy=".7" r=".38" fill="#0c0e12"/></pattern></defs>
    ${daShadow(31, 57, 16)}
    ${daBox({ x: 37, y: 6, w: 12, d: 26, h: 33, top: '#3a404b', left: 'url(#da-case)', right: 'url(#da-glass)', edge: 'rgba(0,0,0,.55)',
      topArt: '<rect x="1.5" y="3" width="9" height="20" rx="1" fill="url(#da-mesh)"/>',
      leftArt: '<rect x="1.2" y="1.4" width="9.6" height="30" rx="1" fill="url(#da-mesh)"/>'
        + [7.5, 16, 24.5].map(y => `<circle cx="6" cy="${y}" r="3.6" fill="none" stroke="#c8d0dc" stroke-opacity=".22" stroke-width=".5"/>`).join('')
        + '<circle cx="6" cy="32" r=".5" fill="#e5e7eb"/>',
      rightArt: '<rect x="1" y="1" width="24" height="31" rx=".8" fill="#14171d"/>'
        + '<rect x="9" y="2.2" width="15" height="19" rx=".6" fill="#1f242c"/>'
        + '<circle cx="16" cy="8" r="3.3" fill="#2a303a" stroke="#9aa6b8" stroke-opacity=".5" stroke-width=".5"/><circle cx="16" cy="8" r="1.2" fill="#c8d0dc" opacity=".55"/>'
        + '<rect x="20.4" y="3.6" width="1" height="7.5" rx=".3" fill="#cfd6e2" opacity=".7"/><rect x="22" y="3.6" width="1" height="7.5" rx=".3" fill="#cfd6e2" opacity=".7"/>'
        + '<rect x="4.5" y="14" width="19" height="4.2" rx=".6" fill="#2b313b"/><rect x="4.5" y="14" width="19" height=".6" fill="#e5e7eb" opacity=".5"/>'
        + '<circle cx="9.5" cy="16.2" r="1.6" fill="#161a20"/><circle cx="16.5" cy="16.2" r="1.6" fill="#161a20"/>'
        + '<circle cx="4.5" cy="6.5" r="2.6" fill="none" stroke="#9aa6b8" stroke-opacity=".35" stroke-width=".5"/>'
        + '<rect x="1" y="25" width="24" height="7" fill="#22272f"/>'
        + '<rect x="0" y="0" width="26" height="33" fill="url(#da-shine)"/>' })}`,

  laptop: (silver) => {
    const body = silver ? ['#e5e7eb', '#c4c8cf', '#a9aeb7'] : ['#4b5363', '#363c48', '#262b34'];
    const id = 'da-screen' + (silver ? 's' : '');
    const x = 34, y = 27;  // back corner of the keyboard deck; the screen hinges on its back edge
    return `
    <defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#262b35"/><stop offset=".6" stop-color="#3d4553"/><stop offset="1" stop-color="#5d6778"/></linearGradient></defs>
    ${daShadow(36, 52, 25)}
    <g transform="matrix(${DA_C} ${DA_S} 0.18 -1 ${x} ${y})"><rect width="28" height="21" rx="1.2" fill="${body[2]}" stroke="rgba(0,0,0,.4)" stroke-width=".6" ${DA_NS}/>
      <rect x="1.3" y="1.6" width="25.4" height="18" rx=".6" fill="url(#${id})"/></g>
    ${daBox({ x, y, w: 28, d: 19, h: 1.8, top: body[0], left: body[1], right: body[2],
      topArt: '<rect x="2" y="2" width="24" height="9" rx="1" fill="#000" opacity=".14"/><rect x="9" y="12.5" width="10" height="5" rx="1" fill="#000" opacity=".1"/>' })}`;
  },

  mini: () => `
    ${daShadow(32, 50, 20)}
    ${daBox({ x: 32, y: 22, w: 22, d: 22, h: 9, top: '#3f4654', left: '#2a303b', right: '#1f242d', edge: 'rgba(0,0,0,.5)',
      topArt: '<circle cx="11" cy="11" r="5" fill="none" stroke="#7c5cff" stroke-width="1" opacity=".8"/>',
      leftArt: '<circle cx="4" cy="4.5" r="1" fill="#34d399"/><rect x="8" y="3.6" width="5" height="1.6" rx=".8" fill="#11141a"/><rect x="15" y="3.6" width="3" height="1.6" rx=".8" fill="#11141a"/>' })}`,

  server: () => {
    const unit = (y, led) => daBox({ x: 34, y, w: 16, d: 28, h: 7, top: '#4a5262', left: '#2a303b', right: '#1f242d', edge: 'rgba(0,0,0,.55)',
      leftArt: `<circle cx="3" cy="3.5" r=".9" fill="${led}"/><circle cx="6" cy="3.5" r=".9" fill="#22d3ee"/><rect x="9" y="2.6" width="5" height="1.8" rx=".5" fill="#11141a"/>` });
    return `${daShadow(31, 55, 18)}${unit(24, '#34d399')}${unit(16, '#34d399')}${unit(8, '#fbbf24')}`;
  },

  pi: () => `
    ${daShadow(32, 48, 24)}
    ${daBox({ x: 32, y: 22, w: 28, d: 20, h: 2, top: '#1f8a4c', left: '#176b3a', right: '#12552e', edge: 'rgba(0,0,0,.45)',
      topArt: '<rect x="9" y="6" width="8" height="8" rx=".8" fill="#2b2f36"/><rect x="2" y="1.5" width="24" height="2" fill="#d4a017" opacity=".9"/><rect x="20" y="9" width="6" height="9" rx=".5" fill="#c0c5cc"/><rect x="3" y="12" width="4" height="5" rx=".5" fill="#c0c5cc"/>' })}`,

  mac: () => `
    ${daShadow(32, 50, 22)}
    ${daBox({ x: 32, y: 24, w: 24, d: 24, h: 6, top: '#e5e7eb', left: '#c9cdd3', right: '#a9aeb7', edge: 'rgba(0,0,0,.25)',
      topArt: '<rect x="0" y="0" width="24" height="24" rx="4" fill="#fff" opacity=".25"/>',
      leftArt: '<circle cx="20" cy="3" r=".7" fill="#34d399"/>' })}`,

  vm: () => `
    <g fill="none" stroke-width="1.4" stroke-linejoin="round">
      <path d="M32 10 L54 22.7 L54 45.3 L32 58 L10 45.3 L10 22.7 Z" stroke="#7c5cff" stroke-dasharray="3 2.2"/>
      <path d="M10 22.7 L32 35.4 L54 22.7 M32 35.4 V58" stroke="#22d3ee" opacity=".8"/></g>
    <path d="M32 10 L54 22.7 L32 35.4 L10 22.7 Z" fill="#7c5cff" opacity=".18"/>`,

  // Phones stand upright: the screen is the right face, the thin edge the left.
  phone: (android) => {
    const body = android ? ['#3a3f4a', '#2a2e36', '#1d2027'] : ['#d8d4cd', '#b5b0a8', '#8f8a82'];
    const id = 'da-phone' + (android ? 'a' : 'i');
    const cam = android ? '<circle cx="9.5" cy="2.6" r=".9" fill="#0b0d12"/>' : '<rect x="6.6" y="1.7" width="5.8" height="1.8" rx=".9" fill="#0b0d12"/>';
    return `
    <defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#262b35"/><stop offset=".6" stop-color="#3d4553"/><stop offset="1" stop-color="#5d6778"/></linearGradient></defs>
    ${daShadow(30, 55, 13)}
    ${daBox({ x: 27, y: 9, w: 2.6, d: 19, h: 38, top: body[0], left: body[1], right: body[2], edge: 'rgba(0,0,0,.45)',
      rightArt: `<rect x=".9" y=".9" width="17.2" height="36.2" rx="2.6" fill="#0b0d12"/><rect x="1.6" y="1.6" width="15.8" height="34.8" rx="2.1" fill="url(#${id})"/>${cam}
        <rect x="3.5" y="9" width="4.6" height="4.6" rx="1.2" fill="#fff" opacity=".28"/><rect x="10.2" y="9" width="4.6" height="4.6" rx="1.2" fill="#fff" opacity=".22"/>
        <rect x="3.5" y="15.6" width="4.6" height="4.6" rx="1.2" fill="#fff" opacity=".2"/><rect x="10.2" y="15.6" width="4.6" height="4.6" rx="1.2" fill="#fff" opacity=".26"/>
        <rect x="6.2" y="33.2" width="6.6" height=".8" rx=".4" fill="#fff" opacity=".55"/>` })}`;
  },

  computer: () => `
    ${daShadow(32, 56, 16)}
    <defs><linearGradient id="da-mon" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7c5cff"/><stop offset=".55" stop-color="#3b82f6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
    <rect x="8" y="12" width="48" height="31" rx="3" fill="#2a303b" stroke="rgba(0,0,0,.4)"/>
    <rect x="11" y="15" width="42" height="25" rx="1.5" fill="url(#da-mon)"/>
    <path d="M28 43h8l2 9h-12z" fill="#3a4150"/><rect x="21" y="52" width="22" height="3" rx="1.5" fill="#4a5262"/>`,
};

const DEVICE_LABEL = { spark: 'DGX Spark', dgx: 'NVIDIA DGX', desktop: 'Desktop', laptop: 'Laptop', mini: 'Mini PC', server: 'Server',
  pi: 'Raspberry Pi', mac: 'Mac', macbook: 'MacBook', vm: 'Virtual machine', computer: 'Computer', iphone: 'iPhone', android: 'Android phone' };

function deviceArt(type, cls) {
  const draw = type === 'macbook' ? () => DEVICE_ART.laptop(true) : type === 'iphone' ? () => DEVICE_ART.phone(false)
    : type === 'android' ? () => DEVICE_ART.phone(true) : DEVICE_ART[type] || DEVICE_ART.computer;
  return `<svg class="${cls || ''}" viewBox="0 0 64 64" aria-hidden="true">${draw()}</svg>`;
}
