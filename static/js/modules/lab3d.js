// ===== Module: lab3d — the Lab's devices as 3D models on pedestals =====
// mountLab3D(stage, opts) draws every device, lets people drag/throw them, and
// reports hover (desktop) or tap (touch) through opts.onFocus / opts.onOpen.
// Models are built from simple shapes here; no model files are downloaded.
import * as THREE from '/static/vendor/three/three.module.min.js';
import { RoundedBoxGeometry } from '/static/vendor/three/RoundedBoxGeometry.js';
import { RoomEnvironment } from '/static/vendor/three/RoomEnvironment.js';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FRONT = new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, -.55, 0));   // three-quarter view, facing the viewer
const MASS = { desktop: 1.7, server: 1.8, spark: 1.25, dgx: 1.6, mini: 1, mac: 1, pi: .6, laptop: .95, macbook: .95, iphone: .55, android: .55 };

// ── Textures drawn on a canvas ──
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let TEX = null;
function textures() {
  if (TEX) return TEX;
  TEX = {
    foam: canvasTex(1024, 340, (g, w, h) => {   // DGX Spark front: gold open-cell metal foam
      g.fillStyle = '#b8924f'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) {
        const x = rnd() * w, y = rnd() * h, r = 2 + rnd() * 5.5;
        g.fillStyle = `rgba(${40 + rnd() * 25},${28 + rnd() * 15},10,${.75 + rnd() * .25})`;
        g.beginPath(); g.ellipse(x, y, r, r * (.7 + rnd() * .5), rnd() * 3, 0, 7); g.fill();
      }
      g.strokeStyle = 'rgba(255,236,190,.25)'; g.lineWidth = 1;
      for (let i = 0; i < 2500; i++) { const x = rnd() * w, y = rnd() * h; g.beginPath(); g.arc(x, y, 3 + rnd() * 3, 3.6, 5.4); g.stroke(); }
    }),
    mesh: canvasTex(256, 512, (g, w, h) => {     // PC front mesh
      g.fillStyle = '#20242b'; g.fillRect(0, 0, w, h); g.fillStyle = '#07080a';
      for (let y = 4; y < h; y += 8) for (let x = 4 + (y / 8 % 2) * 4; x < w; x += 8) { g.beginPath(); g.arc(x, y, 2.6, 0, 7); g.fill(); }
    }),
    screen: canvasTex(512, 340, (g, w, h) => {   // neutral slate screen
      const gr = g.createLinearGradient(0, h, w, 0); gr.addColorStop(0, '#20252e'); gr.addColorStop(.6, '#3a4250'); gr.addColorStop(1, '#5b6576');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.12)'; for (let i = 0; i < 6; i++) g.fillRect(40 + (i % 3) * 150, 70 + Math.floor(i / 3) * 110, 120, 80);
    }),
    phone: canvasTex(256, 520, (g, w, h) => {
      const gr = g.createLinearGradient(0, h, w, 0); gr.addColorStop(0, '#1f242d'); gr.addColorStop(1, '#55607a');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = '#05060a'; g.beginPath(); g.roundRect(w / 2 - 40, 18, 80, 22, 11); g.fill();
      g.fillStyle = 'rgba(255,255,255,.16)'; for (let i = 0; i < 16; i++) { g.beginPath(); g.roundRect(28 + (i % 4) * 52, 90 + Math.floor(i / 4) * 64, 38, 38, 10); g.fill(); }
      g.fillStyle = 'rgba(255,255,255,.6)'; g.beginPath(); g.roundRect(w / 2 - 45, h - 20, 90, 6, 3); g.fill();
    }),
    soft: canvasTex(256, 256, (g, w, h) => {     // soft round shadow
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(.45, 'rgba(255,255,255,.25)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }),
  };
  return TEX;
}

// ── Models (about 1.6 units across) ──
const metal = (color, rough = .35, m = 1) => new THREE.MeshPhysicalMaterial({ color, metalness: m, roughness: rough, clearcoat: m > .5 ? .35 : 0, clearcoatRoughness: .25, envMapIntensity: 1.5 });
const box = (w, h, d, r, mat) => new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);

function spark() {
  const g = new THREE.Group(), T = textures();
  g.add(box(1.5, .5, 1.5, .05, metal('#c7a263', .28)));
  const foam = new THREE.MeshStandardMaterial({ map: T.foam, bumpMap: T.foam, bumpScale: 3, metalness: .85, roughness: .45 });
  for (const z of [.7505, -.7505]) { const f = new THREE.Mesh(new THREE.PlaneGeometry(1.42, .4), foam); f.position.set(0, .02, z); if (z < 0) f.rotation.y = Math.PI; g.add(f); }
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.46, .05, 1.46), metal('#2a2116', .6, .3)); base.position.y = -.245; g.add(base);
  return g;
}
function tower() {
  const g = new THREE.Group(), T = textures();
  g.add(box(.72, 1.55, 1.45, .03, metal('#1e2228', .45, .7)));
  const front = new THREE.Mesh(new THREE.PlaneGeometry(.62, 1.42), new THREE.MeshStandardMaterial({ map: T.mesh, metalness: .5, roughness: .6 })); front.position.z = .726; g.add(front);
  for (const y of [.42, 0, -.42]) { const fan = new THREE.Mesh(new THREE.TorusGeometry(.2, .012, 8, 48), new THREE.MeshBasicMaterial({ color: '#cfd6e2', transparent: true, opacity: .35 })); fan.position.set(0, y, .735); g.add(fan); }
  const inside = new THREE.Group(); inside.position.x = .1; g.add(inside);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.3), metal('#15181d', .7, .4)); board.rotation.y = Math.PI / 2; board.position.x = -.25; inside.add(board);
  const gpu = new THREE.Mesh(new THREE.BoxGeometry(.3, .16, 1.05), metal('#2b3038', .4, .8)); gpu.position.set(0, -.1, .05); inside.add(gpu);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(.302, .015, 1.0), new THREE.MeshBasicMaterial({ color: '#e5e7eb' })); strip.position.set(0, -.02, .05); inside.add(strip);
  const cooler = new THREE.Mesh(new THREE.CylinderGeometry(.17, .17, .14, 32), metal('#9aa3b2', .3)); cooler.rotation.z = Math.PI / 2; cooler.position.set(-.12, .38, .1); inside.add(cooler);
  for (const z of [-.25, -.33]) { const ram = new THREE.Mesh(new THREE.BoxGeometry(.06, .34, .03), new THREE.MeshBasicMaterial({ color: '#f1f3f7' })); ram.position.set(-.16, .38, z); inside.add(ram); }
  const psu = new THREE.Mesh(new THREE.BoxGeometry(.6, .32, 1.4), metal('#191c21', .5, .6)); psu.position.set(-.06, -.6, 0); inside.add(psu);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.38, 1.46), new THREE.MeshPhysicalMaterial({ color: '#0e1117', metalness: 0, roughness: .05, transparent: true, opacity: .32, clearcoat: 1 }));
  glass.rotation.y = Math.PI / 2; glass.position.x = .362; g.add(glass);
  return g;
}
function laptop(silver) {
  const g = new THREE.Group(), T = textures();
  const shell = metal(silver ? '#b9bcc2' : '#5c6068', .4, .8);
  g.add(box(1.6, .06, 1.05, .025, shell));
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(1.4, .5), new THREE.MeshStandardMaterial({ color: '#1b1e23', roughness: .8 })); deck.rotation.x = -Math.PI / 2; deck.position.set(0, .031, -.12); g.add(deck);
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(.5, .28), new THREE.MeshStandardMaterial({ color: '#4a4f58', roughness: .5, metalness: .4 })); pad.rotation.x = -Math.PI / 2; pad.position.set(0, .031, .3); g.add(pad);
  const hinge = new THREE.Group(); hinge.position.set(0, .03, -.52); hinge.rotation.x = -.32; g.add(hinge);
  const lid = box(1.6, 1.02, .04, .02, shell); lid.position.y = .51; hinge.add(lid);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.48, .9), new THREE.MeshBasicMaterial({ map: T.screen })); scr.position.set(0, .51, .021); hinge.add(scr);
  return g;
}
function phone(android) {
  const g = new THREE.Group(), T = textures();
  g.add(new THREE.Mesh(new RoundedBoxGeometry(.56, 1.16, .065, 6, .07), metal(android ? '#2b2f37' : '#c9c4bb', .3)));
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(.52, 1.12), new THREE.MeshBasicMaterial({ map: T.phone })); scr.position.z = .034; g.add(scr);
  const bump = new THREE.Mesh(new RoundedBoxGeometry(.24, .24, .03, 3, .04), metal(android ? '#23262d' : '#b8b2a8', .25)); bump.position.set(-.11, .4, -.045); g.add(bump);
  for (const [x, y] of [[-.165, .455], [-.055, .455], [-.11, .345]]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, .03, 24), metal('#0b0c10', .1)); l.rotation.x = Math.PI / 2; l.position.set(x, y, -.065); g.add(l); }
  return g;
}
function server() {
  const g = new THREE.Group();
  [-.36, 0, .36].forEach((y, i) => {
    const u = box(1.5, .3, 1.2, .02, metal('#2a2f38', .45, .7)); u.position.y = y; g.add(u);
    const led = new THREE.Mesh(new THREE.BoxGeometry(.05, .05, .01), new THREE.MeshBasicMaterial({ color: i === 2 ? '#fbbf24' : '#34d399' })); led.position.set(-.6, y, .605); g.add(led);
  });
  return g;
}
function mini(silver) {
  const g = new THREE.Group();
  g.add(box(1.1, .42, 1.1, .12, metal(silver ? '#c9ccd2' : '#2c313a', .35, .8)));
  const led = new THREE.Mesh(new THREE.BoxGeometry(.06, .03, .01), new THREE.MeshBasicMaterial({ color: '#e5e7eb' })); led.position.set(.4, -.1, .555); g.add(led);
  return g;
}
function pi() {
  const g = new THREE.Group();
  g.add(box(1.3, .06, .9, .02, new THREE.MeshStandardMaterial({ color: '#1f8a4c', roughness: .6 })));
  const chip = new THREE.Mesh(new THREE.BoxGeometry(.3, .05, .3), metal('#2b2f36', .4, .6)); chip.position.set(-.2, .05, 0); g.add(chip);
  const usb = new THREE.Mesh(new THREE.BoxGeometry(.25, .22, .3), metal('#c0c5cc', .3)); usb.position.set(.5, .14, .2); g.add(usb);
  return g;
}
function model(d) {
  const t = d.type;
  const m = t === 'spark' || t === 'dgx' ? spark() : t === 'desktop' || t === 'computer' ? tower() : t === 'laptop' ? laptop(false) : t === 'macbook' ? laptop(true)
    : t === 'iphone' ? phone(false) : t === 'android' ? phone(true) : t === 'server' ? server() : t === 'mini' ? mini(false) : t === 'mac' ? mini(true) : t === 'pi' ? pi() : tower();
  if (d.off) m.traverse(o => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: '#0d0e12', roughness: .9, metalness: 0, transparent: true, opacity: .55 }); });
  return m;
}
const colorOf = (css) => {
  const m = /hsl\((\d+)\s+(\d+)%\s+(\d+)%\)/.exec(css || '');
  return m ? new THREE.Color().setHSL(+m[1] / 360, +m[2] / 100, +m[3] / 100) : new THREE.Color(css || '#ffb454');
};

// ── The scene ──
export function mountLab3D(stage, opts) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'lab3d-canvas';
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), .04).texture;
  const key = new THREE.DirectionalLight('#fff2dd', 2.2); key.position.set(3, 7, 4); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 6; key.shadow.bias = -.0005;
  Object.assign(key.shadow.camera, { left: -14, right: 14, top: 9, bottom: -9, near: .5, far: 40 });
  scene.add(key);
  const rim = new THREE.DirectionalLight('#dfe8ff', 1.8); rim.position.set(-4, 3, -5); scene.add(rim);   // edge light from behind
  const ambient = new THREE.AmbientLight('#ffffff', .25); scene.add(ambient);
  const camera = new THREE.PerspectiveCamera(26, 1, .1, 100);
  const world = new THREE.Group(); scene.add(world);
  let items = [], devices = [], light = false, sig = '', floor = -1.3, cols = 1, rows = 1, focusId = null, running = true;
  const sx = 3.1;

  function clear() {
    world.clear();
    items.forEach(it => { it.label.remove(); it.ghost?.remove(); });
    items = [];
  }

  function build() {
    // keep each device's pose and spin across rebuilds (a device going on/offline
    // shouldn't make every model snap back to its start)
    const was = new Map(items.map(it => [it.d.id, { q: it.spin.quaternion.clone(), w: it.w.clone(), dimAt: it.dimAt, glowAt: it.glowAt }]));
    clear();
    const wide = stage.clientWidth >= 700, n = devices.length;
    cols = wide ? Math.min(n, 8) : Math.min(n, 3); rows = Math.ceil(n / Math.max(1, cols));
    const sy = wide ? 4.2 : 5.4, track = light ? '#000000' : '#ffffff';
    renderer.toneMappingExposure = light ? .95 : 1.05; ambient.intensity = light ? .5 : .25;
    items = devices.map((d, i) => {
      const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - r * cols : cols, c = i - r * cols;
      const holder = new THREE.Group(); holder.position.set((c - (inRow - 1) / 2) * sx, -(r - (rows - 1) / 2) * sy, 0); world.add(holder);
      const spin = new THREE.Group(); holder.add(spin);
      const m = model(d); m.scale.setScalar((d.phone ? 1.3 : 1) * (wide ? 1 : 1.2));   // phones: bigger models fill the narrow slots
      m.traverse(o => { if (o.isMesh && !o.material.transparent) o.castShadow = true; });
      m.position.sub(new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()));   // turn around its real middle
      const core = new THREE.Group(); core.add(m); spin.add(core);
      const color = colorOf(d.color);
      // hover outline: a slightly bigger, inside-out copy that shows only around the silhouette
      const shell = (scale, opacity) => {
        const o = core.clone(true); o.scale.setScalar(scale); o.visible = false;
        o.traverse(x => { if (!x.isMesh) return;
          const flat = x.geometry.type === 'PlaneGeometry' || x.geometry.type === 'CircleGeometry' || x.material.transparent;
          x.visible = !flat; x.castShadow = false;
          x.material = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
            blending: opacity < .5 ? THREE.AdditiveBlending : THREE.NormalBlending });
          x.material.userData.o = opacity; });
        spin.add(o); return o;
      };
      const outline = [shell(1.035, .95), shell(1.09, .22)];
      const mats = []; core.traverse(x => { if (x.isMesh) { mats.push(x.material); x.material.userData = { c: x.material.color.clone(), e: x.material.envMapIntensity ?? 1, cc: x.material.clearcoat || 0, r: x.material.roughness }; } });
      const reach = new THREE.Box3().setFromObject(m).getBoundingSphere(new THREE.Sphere()).radius;
      // pedestal: a shadow-catching floor and three thin, unlit rings
      const base = new THREE.Group(); holder.add(base);
      const catcher = new THREE.Mesh(new THREE.CircleGeometry(1.3, 48), new THREE.ShadowMaterial({ opacity: light ? .22 : .55 }));
      catcher.rotation.x = -Math.PI / 2; catcher.receiveShadow = true; base.add(catcher);
      for (const rad of [1.42, 1.3, 1.18]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(rad, .007, 6, 160), new THREE.MeshBasicMaterial({ color: track, transparent: true, opacity: .16, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = .01; base.add(ring);
      }
      const prev = was.get(d.id);
      spin.quaternion.copy(prev ? prev.q : FRONT);
      const label = document.createElement('div'); label.className = 'lab3d-label' + (d.off ? ' off' : '');
      label.innerHTML = '<b></b><span></span>'; stage.appendChild(label);
      let ghost = null;
      if (d.off) { ghost = document.createElement('div'); ghost.className = 'lab3d-ghost'; ghost.dataset.t = 'OFFLINE'; ghost.textContent = 'OFFLINE'; stage.appendChild(ghost); }
      // the drift phase follows the device, not its place in the row
      const phase = [...d.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7) / 97;
      return { d, holder, spin, base, reach, mats, outline, label, ghost, mass: MASS[d.type] || 1.1, phase,
        w: prev ? prev.w : new THREE.Vector3(), dv: new THREE.Vector3(), held: false, dimAt: 0, dimTo: 0, glowAt: 0, glowTo: 0 };
    });
    floor = -(Math.max(.6, ...items.map(it => it.reach)) + .17);   // below every corner's swing plus the float
    items.forEach(it => { it.base.position.y = floor; });
    labels();
    resize();
    applyFocus();
  }

  function labels() {
    items.forEach(it => { it.label.querySelector('b').textContent = it.d.name; it.label.querySelector('span').textContent = it.d.kind; });
  }

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    const sy = w >= 700 ? 4.2 : 5.4, needW = cols * sx + .4, needH = rows * sy;
    const vf = THREE.MathUtils.degToRad(camera.fov), dist = Math.max(needH / 2 / Math.tan(vf / 2), needW / 2 / Math.tan(vf / 2) / camera.aspect);
    camera.position.set(0, dist * .32, dist); camera.lookAt(0, -.35, 0); camera.updateProjectionMatrix();
    if ((w >= 700) !== resize.wide) { resize.wide = w >= 700; if (items.length) build(); }
  }
  const ro = new ResizeObserver(() => resize()); ro.observe(stage);

  // ── Focus: hover on desktop, tap on touch ──
  function applyFocus() {
    items.forEach(it => {
      const me = it.d.id === focusId, dim = !!focusId && !me;
      it.dimTo = dim ? 1 : 0; it.glowTo = me ? 1 : 0;
      it.label.classList.toggle('dim', dim); it.label.classList.toggle('hi', me);
      it.ghost?.classList.toggle('dim', dim);
    });
  }
  function setFocus(id) {
    if (focusId === id) return;
    focusId = id; applyFocus(); opts.onFocus?.(id);
  }
  const _v = new THREE.Vector3();
  function pick(e) {
    const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 2 - 1, y = -((e.clientY - r.top) / r.height * 2 - 1);
    let best = null;
    for (const it of items) {
      const c = it.holder.position.clone().add(it.spin.position).project(camera), edge = it.holder.position.clone().add(_v.set(it.reach * 1.1, 0, 0)).project(camera);
      const R = Math.abs(edge.x - c.x), dd = Math.hypot(c.x - x, (c.y - y) / camera.aspect);
      if (dd < R && (!best || dd < best.dd)) best = { it, dd };
    }
    return best?.it || null;
  }
  let held = null, last = null, down = null;
  const onDown = (e) => {
    const hit = pick(e);
    down = { x: e.clientX, y: e.clientY, t: performance.now(), again: !!hit && focusId === hit.d.id };
    held = hit; if (!held) return;
    held.held = true; held.dv.set(0, 0, 0); last = { x: e.clientX, y: e.clientY, t: performance.now() };
    stage.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (!held) { if (e.pointerType === 'mouse') { const it = pick(e); setFocus(it ? it.d.id : null); stage.style.cursor = it ? 'grab' : ''; } return; }
    const now = performance.now(), dt = Math.max(1, now - last.t) / 1000, sc = 3.2 / stage.getBoundingClientRect().width * (camera.aspect > 1 ? 1.4 : 2.4) * 2.2;
    held.dv.lerp(_v.set((e.clientY - last.y) * sc / dt, (e.clientX - last.x) * sc / dt, 0), .6);   // the spin the hand asks for
    last = { x: e.clientX, y: e.clientY, t: now };
  };
  const onUp = (e) => {
    const tap = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && performance.now() - down.t < 450;
    if (held) { held.held = false; held.w.clampLength(0, 7); }
    if (tap) {
      const it = pick(e);
      if (e.pointerType === 'mouse') { if (it) opts.onOpen?.(it.d.id); }
      else if (it && down.again) opts.onOpen?.(it.d.id);   // second tap on the selected device
      else setFocus(it ? it.d.id : null);
    }
    held = null; down = null;
  };
  const onLeave = (e) => { if (e.pointerType === 'mouse' && !held) setFocus(null); };
  stage.style.touchAction = 'pan-y';
  stage.addEventListener('pointerdown', onDown); stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp); stage.addEventListener('pointercancel', onUp); stage.addEventListener('pointerleave', onLeave);

  // ── Opening: each device starts dark and resting low, then in turn its light comes on,
  // it rises and starts to float. The first frames compile shaders and stutter, so the
  // clock starts after them; opts.onStart then starts the page's part (name, stats). ──
  let intro = null;
  const _lift = new THREE.Vector3();
  const ease4 = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 4);
  function lit(it, k) {                      // 0 = lights off (a dark silhouette), 1 = lit as normal
    const f = 1 - k; it.dimAt = it.dimTo = 0;
    it.mats.forEach(mt => { const u = mt.userData; mt.color.copy(u.c).multiplyScalar(1 - .9 * f);
      if ('envMapIntensity' in mt) mt.envMapIntensity = u.e * (1 - .95 * f); if ('clearcoat' in mt) mt.clearcoat = u.cc * (1 - f); });
  }
  function introFrame(t) {
    if (intro.t0 === null) {
      items.forEach(it => { lit(it, 0); it.spin.position.set(0, -.3, 0); it.label.style.opacity = 0; if (it.ghost) it.ghost.style.opacity = 0; });
      if (++intro.n < 4) return;
      intro.t0 = t; intro.onStart?.();
    }
    const e = t - intro.t0;
    let done = true;
    items.forEach((it, i) => {
      const on = 1 + i * .16, up = on + .3, r = ease4((e - up) / 1.3), l = Math.max(0, Math.min(1, (e - up - .6) / .6));
      lit(it, ease4((e - on) / .8));
      it.spin.position.multiplyScalar(r).add(_lift.set(0, -.3 * (1 - r), 0));   // resting low, no drift, until it rises
      it.label.style.opacity = l; if (it.ghost) it.ghost.style.opacity = l;
      if (l < 1) done = false;
    });
    if (done) { items.forEach(it => { it.label.style.opacity = ''; if (it.ghost) it.ghost.style.opacity = ''; }); intro = null; applyFocus(); }
  }

  // ── Motion: drift, weight, the pull back to facing front, eased hover ──
  const clock = new THREE.Clock();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), eu = new THREE.Euler();
  function tick() {
    if (!running) return;
    requestAnimationFrame(tick);
    if (document.hidden || !stage.isConnected || !stage.offsetParent) return;
    const dt = Math.min(.05, clock.getDelta()), t = clock.elapsedTime;
    for (const it of items) {
      const live = !it.d.off, k = live ? 1 : .45, p = (t + it.phase * 6) * k, m = it.mass;
      if (!REDUCED) it.spin.position.set(Math.sin(p * .09) * .04, Math.sin(p * .15 / Math.sqrt(m)) * .1 / Math.sqrt(m), Math.cos(p * .11) * .05);
      if (it.held) {
        it.w.lerp(it.dv, 1 - Math.exp(-dt * 7 / m));       // heavy: catches up with the hand
        it.dv.multiplyScalar(Math.exp(-dt * 9));
      } else {
        qa.copy(FRONT);
        if (!REDUCED) qa.multiply(qb.setFromEuler(eu.set(Math.sin(p * .13) * .12, Math.sin(p * .09) * .3, Math.sin(p * .07) * .05)));
        qb.copy(it.spin.quaternion).invert(); qa.multiply(qb);
        if (qa.w < 0) { qa.x *= -1; qa.y *= -1; qa.z *= -1; qa.w *= -1; }
        const ang = 2 * Math.acos(Math.min(1, qa.w)), sn = Math.sqrt(1 - qa.w * qa.w);
        if (sn > 1e-5) it.w.addScaledVector(_v.set(qa.x / sn, qa.y / sn, qa.z / sn), ang * .75 * k * k / m * dt);
        it.w.multiplyScalar(Math.exp(-(.75 / m + .25) * dt));   // momentum carries; heavier coasts longer
      }
      const sp = it.w.length();
      if (sp > 1e-6) it.spin.quaternion.premultiply(qb.setFromAxisAngle(_v.copy(it.w).divideScalar(sp), sp * dt)).normalize();
      const ease = 1 - Math.exp(-dt * 7);
      if (Math.abs(it.dimTo - it.dimAt) > .001) {
        it.dimAt += (it.dimTo - it.dimAt) * ease; const f = it.dimAt;
        it.mats.forEach(mt => { const u = mt.userData; mt.color.copy(u.c).multiplyScalar(1 - .78 * f);
          if ('envMapIntensity' in mt) mt.envMapIntensity = u.e * (1 - .85 * f); if ('clearcoat' in mt) mt.clearcoat = u.cc * (1 - f); if ('roughness' in mt) mt.roughness = u.r + (1 - u.r) * f; });
      }
      if (Math.abs(it.glowTo - it.glowAt) > .001) {
        it.glowAt += (it.glowTo - it.glowAt) * ease; const g = it.glowAt;
        it.outline.forEach(o => { o.visible = g > .01; o.traverse(x => { if (x.isMesh) x.material.opacity = x.material.userData.o * g; }); });
      }
    }
    if (intro) introFrame(t);
    renderer.render(scene, camera);
    const w = stage.clientWidth, h = stage.clientHeight;
    for (const it of items) {
      const v = it.holder.position.clone().add(_v.set(0, floor - .95, 0)).project(camera);
      it.label.style.transform = `translate(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px) translateX(-50%)`;
      if (it.ghost) { const g = it.holder.position.clone().add(it.spin.position).project(camera); it.ghost.style.transform = `translate(${((g.x + 1) / 2 * w).toFixed(1)}px, ${((1 - g.y) / 2 * h).toFixed(1)}px) translate(-50%, -50%)`; }
    }
  }
  requestAnimationFrame(tick);

  return {
    update(list, isLight) {
      devices = list; light = !!isLight;
      const s = JSON.stringify([light, list.map(d => [d.id, d.type, d.off, d.color, d.phone])]);
      if (s !== sig) { sig = s; build(); } else labels();
    },
    setFocus,
    playIntro(onStart) {                     // replay the opening; onStart fires when its clock starts
      if (REDUCED) { onStart?.(); return; }
      intro = { n: 0, t0: null, onStart };
    },
    destroy() {
      running = false; ro.disconnect(); clear();
      stage.removeEventListener('pointerdown', onDown); stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp); stage.removeEventListener('pointercancel', onUp); stage.removeEventListener('pointerleave', onLeave);
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); pmrem.dispose();
    },
  };
}
