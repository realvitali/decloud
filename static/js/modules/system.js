// ===== Module: system — Lab overview =====
// The lab as a showcase: big lab name, every device on a shelf, lab-wide
// totals and the services running. Fits one screen. Data: /api/lab/overview.

// ── Formatting ──
const labGB = (b) => b >= 1e12 ? (b / 1e12).toFixed(b >= 1e13 ? 0 : 1) + ' TB' : Math.round(b / 1e9) + ' GB';
const labDur = (s) => s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
const labCpu = (n) => (n || '').replace(/\(R\)|\(TM\)|Processor|CPU|@.*$|\d+-Core/gi, '').replace(/w\/.*$/i, '').replace(/\s+/g, ' ').trim();
const labGpu = (n) => (n || '').replace(/Advanced Micro Devices, Inc\. \[AMD\/ATI\]/, 'AMD').replace(/NVIDIA Corporation|Intel Corporation/, (m) => m.split(' ')[0]).replace(/\[|\]/g, '').trim();
const labOs = (o) => (o || '').replace(/ GNU\/Linux| Linux(?= \d)|\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
const labPct = (u, t) => t ? Math.round(u / t * 100) : 0;
const labClamp = (p) => Math.max(0, Math.min(100, Math.round(p || 0)));

// ── Appearance (saved in lab prefs; the server keeps the same lists) ──
const LAB_FONTS = [['bold', 'Bold'], ['grotesk', 'Grotesk'], ['wide', 'Wide'], ['scifi', 'Sci-fi'], ['tech', 'Tech'], ['syne', 'Syne'],
  ['bricolage', 'Bricolage'], ['archivo', 'Archivo'], ['poster', 'Poster'], ['outfit', 'Outfit'], ['sora', 'Sora'], ['michroma', 'Michroma'],
  ['tall', 'Tall'], ['round', 'Rounded']];
const LAB_ACCENTS = { amber: ['Amber', '#ffb454'], green: ['Green', '#76b900'], ice: ['Ice', '#7dd3fc'], mono: ['Mono', '#e5e5ea'] };

// Each device gets its own shade of the accent: small hue and lightness steps,
// so devices can be told apart in the totals but still look like one theme.
const LAB_STEPS = [[0, 0], [-13, -5], [8, 11], [-6, -13], [-17, 5], [4, -8], [12, 3], [-3, 15]];
function labShade(hex, i) {
  const [r, g, b] = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0; const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const [dh, dl] = LAB_STEPS[i % LAB_STEPS.length];
  return `hsl(${Math.round((h * 60 + dh + 360) % 360)} ${Math.round(s * 100)}% ${Math.max(30, Math.min(88, Math.round(l * 100 + dl)))}%)`;
}
const labAccent = () => (LAB_ACCENTS[LAB?.prefs?.accent] || LAB_ACCENTS.amber)[1];

// ── Services: apps the devices report, plus what the hub knows ──
const LAB_ICONS = {
  ai: '<path d="M12 3l1.9 4.6 4.6 1.9-4.6 1.9L12 16l-1.9-4.6-4.6-1.9 4.6-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  net: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M10.8 7.2l-4.5 8.6M13.2 7.2l4.5 8.6M7.5 18h9"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.5A3.8 3.8 0 0 1 17.5 18z"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 8"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  disk: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 14h18"/><circle cx="17" cy="17" r=".8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  down: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  game: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16" cy="11.5" r=".9"/><circle cx="18" cy="13.8" r=".9"/>',
};
const LAB_APPS = {
  ollama: ['Ollama', 'ai'], vllm: ['vLLM', 'ai'], 'open-webui': ['Open WebUI', 'ai'], comfyui: ['ComfyUI', 'ai'],
  docker: ['Docker', 'box'], portainer: ['Portainer', 'box'], jellyfin: ['Jellyfin', 'play'], plex: ['Plex', 'play'],
  'home-assistant': ['Home Assistant', 'home'], immich: ['Immich', 'photo'], nextcloud: ['Nextcloud', 'cloud'],
  pihole: ['Pi-hole', 'shield'], adguard: ['AdGuard Home', 'shield'], syncthing: ['Syncthing', 'sync'], samba: ['File sharing', 'disk'],
  nginx: ['Nginx', 'globe'], caddy: ['Caddy', 'globe'], traefik: ['Traefik', 'globe'], postgres: ['PostgreSQL', 'db'], mysql: ['MySQL', 'db'],
  redis: ['Redis', 'db'], grafana: ['Grafana', 'chart'], prometheus: ['Prometheus', 'chart'], qbittorrent: ['qBittorrent', 'down'],
  transmission: ['Transmission', 'down'], minecraft: ['Minecraft', 'game'], tailscale: ['Tailscale', 'net'], decloud: ['DeCloud', 'cloud'],
};
const labIcon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LAB_ICONS[k] || LAB_ICONS.box}</svg>`;

// Everything the lab serves: one tile per app, plus one per running container.
function labServiceTiles(L) {
  const on = L.nodes.filter(n => !n.error);
  const by = {};
  const add = (k, n) => { (by[k] = by[k] || []).includes(n) || by[k].push(n); };
  for (const n of on) {
    (n.apps || []).forEach(k => LAB_APPS[k] && add(k, n));
    if (n.ollama?.ok) add('ollama', n);
    if (/^100\./.test(n.address || '')) add('tailscale', n);
  }
  const containers = on.flatMap(n => (n.running?.containers || []).map(c => ({ c, n })));
  const tiles = [];
  for (const [k, devs] of Object.entries(by)) {
    if (k === 'docker' && containers.length) continue;          // the containers speak for Docker
    if (k === 'tailscale') continue;
    let note = '';
    if (k === 'ollama') {
      const models = new Set(devs.flatMap(d => (d.ollama?.installed || []).map(m => m.name)));
      const loaded = devs.reduce((a, d) => a + (d.ollama?.loaded?.length || 0), 0);
      note = loaded ? `${loaded} model${loaded > 1 ? 's' : ''} running` : `${models.size} model${models.size === 1 ? '' : 's'}`;
    }
    tiles.push({ name: LAB_APPS[k][0], icon: LAB_APPS[k][1], note, devs, rank: LAB_APPS[k][1] === 'ai' ? 0 : 2 });
  }
  for (const { c, n } of containers) tiles.push({ name: c.name, icon: 'box', note: (c.image || '').split('/').pop().split(':')[0], devs: [n], rank: 1 });
  tiles.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  if (by.tailscale) tiles.push({ name: 'Tailscale', icon: 'net', note: `${L.totals.online} of ${L.totals.nodes} connected`, devs: by.tailscale, rank: 3 });
  const hub = L.nodes.find(n => n.hub);
  if (hub) tiles.push({ name: 'DeCloud', icon: 'cloud', note: 'This lab', devs: [hub], rank: 3 });
  return tiles;
}

// ── Device identity: what kind of machine, drawn by device-art.js ──
function labDevType(n) {
  return n.device?.type || ((n.gpus || []).some(g => /GB10/.test(g.name)) ? 'spark' : 'computer');
}
function labDevLabel(n) { return n.device?.model || DEVICE_LABEL[labDevType(n)] || 'Computer'; }
function labGpuUtil(n) {
  const u = (n.gpus || []).map(g => g.util).filter(v => v != null);
  return u.length ? Math.round(u.reduce((a, b) => a + b, 0) / u.length) : null;
}
const labGpuHeld = (n) => (n.gpus || []).reduce((a, g) => a + (g.mem_used_gb || 0), 0);

// What a device is, short: "NVIDIA DGX Spark" -> "DGX Spark", "HP OmniBook X Flip Laptop 14-kc0xxx" -> "HP OmniBook X Flip"
const LAB_TYPE_NAME = { desktop: 'Desktop PC', laptop: 'Laptop', mini: 'Mini PC', server: 'Server', pi: 'Raspberry Pi', mac: 'Mac', macbook: 'MacBook',
  vm: 'Virtual machine', spark: 'DGX Spark', dgx: 'NVIDIA DGX', iphone: 'iPhone', android: 'Android phone', computer: 'Computer' };
function labKind(n) {
  let m = (n.device?.model || '').replace(/^NVIDIA (?=DGX)/, '').replace(/\b(Laptop|Notebook|Desktop|PC|Computer)\b/gi, '');
  while (/\s\S*\d\S*$/.test(m.trim())) m = m.trim().replace(/\s\S*\d\S*$/, '');
  return m.replace(/\s+/g, ' ').trim() || LAB_TYPE_NAME[labDevType(n)] || 'Computer';
}
const labGpuMem = (n) => (n.gpus || []).reduce((a, g) => a + (g.vram_gb || 0), 0) || ((n.gpus || []).length ? n.ram_total / 1e9 : 0);
const labIsLight = () => {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || (t !== 'dark' && !matchMedia('(prefers-color-scheme: dark)').matches);
};

// ── The showcase: name, 3D devices, then swipeable pages of tiles ──
let LAB = null;
let labDrawn = false;   // first draw of this visit: count numbers up
let lab3d = null;       // the 3D stage (lab3d.js), or null while loading / when 3D isn't available
let labColors = new Map();

function labShelf(L) {
  const acc = labAccent(), all = [...L.nodes, ...(L.phones || [])];
  labColors = new Map(all.map((n, i) => [n.id, labShade(acc, i)]));
  return all.map(n => ({ id: n.id, name: n.name, kind: labKind(n), type: labDevType(n), color: labColors.get(n.id),
    phone: n.kind === 'phone', off: !!n.error || (n.kind === 'phone' && !n.online) }));
}

// A total as a ring split into one piece per device (its share), lit as far as it's used.
// Offline devices keep a dark piece so the lab's full size stays visible.
function labRing(parts, offline) {
  const all = parts.filter(p => p.size > 0), total = all.reduce((a, p) => a + p.size, 0) + (offline || 0), gap = all.length + (offline ? 1 : 0) > 1 ? .1 : 0;
  if (!total) return '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="var(--hairline-strong)" stroke-width="7"/></svg>';
  const P = (a) => `${(50 + 44 * Math.sin(a)).toFixed(2)} ${(50 - 44 * Math.cos(a)).toFixed(2)}`;
  const arc = (a0, a1) => a1 - a0 >= Math.PI * 2 - .001 ? `M50 6 A44 44 0 1 1 49.99 6` : `M${P(a0)} A44 44 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${P(a1)}`;
  let a = 0, out = '';
  for (const p of all) {
    const span = p.size / total * Math.PI * 2, a0 = a + gap / 2, a1 = a + span - gap / 2, lit = a0 + (a1 - a0) * Math.max(0, Math.min(1, p.used / p.size));
    a += span;
    out += `<g data-dev="${escapeHtml(p.id)}" style="color:${p.color}"><path d="${arc(a0, a1)}" stroke="${p.color}" stroke-opacity=".22" stroke-width="7" fill="none"/>`
      + (lit - a0 > .01 ? `<path class="lab-ring-lit" d="${arc(a0, lit)}" stroke="${p.color}" stroke-width="7" fill="none"/>` : '') + '</g>';
  }
  if (offline) out += `<path class="lab-ring-off" d="${arc(a + gap / 2, Math.PI * 2 - gap / 2)}" stroke="var(--text-faint)" stroke-opacity=".25" stroke-width="7" fill="none"/>`;
  return `<svg viewBox="0 0 100 100">${out}</svg>`;
}

function labTotals(L) {
  const t = L.totals, on = L.nodes.filter(n => !n.error), off = t.offline || {}, col = (n) => labColors.get(n.id);
  const gpuMem = on.reduce((a, n) => a + labGpuMem(n), 0), held = on.reduce((a, n) => a + labGpuHeld(n), 0);
  const [rv, ru] = labGB(t.ram_total).split(' '), [sv, su] = labGB(t.storage_total).split(' ');
  const powered = on.filter(n => n.power);
  return [
    ['CPU', String(t.cores), 'threads', on.map(n => ({ id: n.id, color: col(n), size: n.cores, used: n.cores * n.cpu_percent / 100 })), off.cores, `${Math.round(t.cpu_percent)}% busy`],
    ['GPU', String(t.gpus.length), t.gpus.length === 1 ? 'GPU' : 'GPUs', on.map(n => ({ id: n.id, color: col(n), size: labGpuMem(n), used: labGpuHeld(n) })), off.gpu_mem_gb,
      held >= 1 ? `${Math.round(held)} / ${Math.round(gpuMem)} GB used` : `${Math.round(gpuMem)} GB GPU memory`],
    ['Memory', rv, ru, on.map(n => ({ id: n.id, color: col(n), size: n.ram_total, used: n.ram_used })), off.ram_total, `${labGB(t.ram_used)} in use`],
    ['Storage', sv, su, on.map(n => ({ id: n.id, color: col(n), size: n.storage?.total || 0, used: n.storage?.used || 0 })), off.storage_total, `${labGB(t.storage_used)} used`],
    ['Power', powered.length ? String(Math.round(t.power_w)) : '—', powered.length ? 'W' : '', powered.map(n => ({ id: n.id, color: col(n), size: n.power.watts || .1, used: n.power.watts || .1 })), 0,
      powered.length ? `${powered.length} device${powered.length > 1 ? 's' : ''} measured` : 'Not reported'],
  ];
}

// What one device adds to a total, shown in the tile while it's hovered or tapped
function labFocusText(n, tile) {
  if (!n) return '';
  if (n.kind === 'phone') return "Phones don't add resources";
  if (n.error) return 'Offline';
  const held = labGpuHeld(n), mem = labGpuMem(n);
  if (tile === 'CPU') return `${n.cores} threads · ${labClamp(n.cpu_percent)}%`;
  if (tile === 'GPU') return n.gpus.length ? `${Math.round(held)} / ${Math.round(mem)} GB · ${labGpuUtil(n) ?? 0}%` : 'No GPU';
  if (tile === 'Memory') return `${Math.round(n.ram_used / 1e9)} / ${labGB(n.ram_total)}`;
  if (tile === 'Storage') return `${labGB(n.storage?.used || 0)} / ${labGB(n.storage?.total || 0)}`;
  if (!n.power) return 'Not reported';
  const p = n.power.parts || {};
  return p.battery ? `${Math.round(p.battery)} W on battery` : [p.gpu != null ? `GPU ${Math.round(p.gpu)} W` : '', p.cpu != null ? `CPU ${Math.round(p.cpu)} W` : ''].filter(Boolean).join(' · ');
}

function labPanels(L, wide) {
  const stats = labTotals(L).map(([k, big, unit, parts, off, sub]) => `<div class="lab-tile" data-tile="${k}"><div class="lab-ring">${labRing(parts, off)}</div>
    <div class="lab-tile-text"><em>${k}</em><strong><span data-count="${escapeHtml(big)}">${escapeHtml(big)}</span><small>${unit}</small></strong><span class="lab-use" data-all="${escapeHtml(sub)}">${escapeHtml(sub)}</span></div></div>`);
  const svc = labServiceTiles(L).map(s => `<div class="lab-tile lab-svc" data-devs="${escapeHtml(s.devs.map(d => d.id).join(' '))}" title="${escapeHtml(s.note)}">
    <span class="lab-ic">${labIcon(s.icon)}</span><div class="lab-tile-text"><b>${escapeHtml(s.name)}</b><span class="lab-use">${escapeHtml(s.devs.map(d => d.name).join(', '))}</span></div></div>`);
  const per = wide ? 5 : 6, pages = [stats];
  for (let i = 0; i < svc.length; i += per) pages.push(svc.slice(i, i + per));
  return `<div class="lab-pages" id="lab-pages"><div class="lab-track">${pages.map((p, i) => `<div class="lab-page${i ? ' services' : ''}">${p.join('')}</div>`).join('')}</div></div>
    <div class="lab-dots" role="tablist">${pages.map((_, i) => `<button class="lab-dot" role="tab" data-p="${i}" aria-label="${i ? 'Services, page ' + i : 'Totals'}" data-onclick="cf388b45"></button>`).join('')}</div>`;
}

// ── Tile carousel: slides by transform, follows a finger/trackpad, one page per wheel gesture ──
let labPageAt = 0;
function labGoPage(i, instant) {
  const pages = document.getElementById('lab-pages'), track = pages?.firstElementChild;
  if (!track) return;
  labPageAt = Math.max(0, Math.min(track.children.length - 1, i));
  track.style.transition = instant ? 'none' : '';
  track.style.transform = `translateX(${-labPageAt * 100}%)`;
  labSyncDots();
}
function labSyncDots() {
  document.querySelectorAll('.lab-dot').forEach((d, k) => { d.classList.toggle('on', k === labPageAt); d.setAttribute('aria-selected', k === labPageAt); });
}

let labWheelSum = 0, labWheelLock = 0, labWheelIdle = 0;
function labWheel(e) {
  const track = e.currentTarget.firstElementChild;
  if (!track || track.children.length < 2 || e.ctrlKey) return;
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  e.preventDefault();
  const now = performance.now();
  clearTimeout(labWheelIdle);
  labWheelIdle = setTimeout(() => { labWheelSum = 0; }, 180);   // a pause ends the gesture
  if (now < labWheelLock) return;                               // the rest of a trackpad flick
  labWheelSum += d;
  if (Math.abs(labWheelSum) < 30) return;
  const next = labPageAt + Math.sign(labWheelSum);
  labWheelSum = 0;
  if (next < 0 || next >= track.children.length) return;
  labWheelLock = now + 600;
  labGoPage(next);
}

function labDragPages(pages) {
  let start = null;
  pages.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now(), w: pages.clientWidth, on: false, id: e.pointerId };
  });
  pages.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.on) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;   // vertical: let the page scroll
      start.on = true; pages.setPointerCapture(e.pointerId);
    }
    const track = pages.firstElementChild, last = track.children.length - 1;
    const edge = (labPageAt === 0 && dx > 0) || (labPageAt === last && dx < 0) ? .3 : 1;   // rubber band at the ends
    track.style.transition = 'none';
    track.style.transform = `translateX(calc(${-labPageAt * 100}% + ${dx * edge}px))`;
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, fast = Math.abs(dx) / Math.max(1, performance.now() - start.t) > .5;
    const moved = start.on;
    start = null;
    if (!moved) return;
    labGoPage(labPageAt + (Math.abs(dx) > pages.clientWidth * .2 || fast ? -Math.sign(dx) : 0));
  };
  pages.addEventListener('pointerup', end); pages.addEventListener('pointercancel', end);
}

let labFocusId = null;
function labFocus(id) {
  labFocusId = id;
  const show = document.getElementById('lab-show');
  if (!show || !LAB) return;
  const n = id && (LAB.nodes.find(x => x.id === id) || LAB.phones?.find(x => x.id === id));
  show.classList.toggle('focus', !!n);
  show.querySelectorAll('[data-dev]').forEach(el => el.classList.toggle('hi', !!n && el.dataset.dev === id));
  show.querySelectorAll('[data-devs]').forEach(el => el.classList.toggle('hi', !!n && el.dataset.devs.split(' ').includes(id)));
  show.querySelectorAll('.lab-tile[data-tile]').forEach(t => { const u = t.querySelector('.lab-use'); u.textContent = n ? labFocusText(n, t.dataset.tile) : u.dataset.all; });
}

// Copy text and attributes from a fresh render onto the live one. Returns false
// when the shape differs (a device or service came or went), so the caller redraws.
function labPatch(a, b) {
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let i = 0; i < a.childNodes.length; i++) {
    const x = a.childNodes[i], y = b.childNodes[i];
    if (x.nodeType !== y.nodeType) return false;
    if (x.nodeType === 3) { if (x.data !== y.data && !x.parentElement?.hasAttribute('data-count')) x.data = y.data; continue; }
    if (x.nodeType !== 1) continue;
    if (x.tagName !== y.tagName || (x.getAttribute('class') || '').replace(/\b(hi|on)\b/g, '').trim() !== (y.getAttribute('class') || '').trim()) return false;
    for (const at of y.attributes) if (at.name !== 'class' && x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    if (x.hasAttribute('data-count')) x.textContent = y.textContent;
    if (!labPatch(x, y)) return false;
  }
  return true;
}

function labRender() {
  const show = document.getElementById('lab-show');
  if (!show || !LAB) return;
  labApplyLook();
  show.querySelector('.lab-name span').textContent = LAB.prefs.name;
  const shelf = labShelf(LAB);
  labStage(shelf);
  const panels = document.getElementById('lab-panels'), fresh = document.createElement('div');
  fresh.innerHTML = labPanels(LAB, show.clientWidth >= 700);
  const pages = document.getElementById('lab-pages');
  if (!(pages && labPatch(panels, fresh))) {
    panels.replaceChildren(...fresh.childNodes);
    const np = document.getElementById('lab-pages');
    np.addEventListener('wheel', labWheel, { passive: false });
    labDragPages(np);
    labGoPage(labPageAt, true);
    if (!labDrawn) { labDrawn = true; if (!labIntroArmed && !labIntroOn()) labCountUp(panels); }
  }
  labSyncDots();
  labFocus(labFocusId);
  labFit();
}

// The device stage: 3D models (default), or the flat drawings for Classic or when 3D isn't available
let lab3dLoading = false, lab3dFailed = false, lab3dMod = null;
// Start fetching three.js as the app opens, alongside the stats, so 3D is ready when they land
const labLoad3D = () => lab3dMod || (lab3dMod = import('/static/js/modules/lab3d.js?v=4'));
function labStage(shelf) {
  try { localStorage.setItem('lab_view', LAB.prefs.view === 'classic' ? 'classic' : '3d'); } catch { /* storage blocked */ }
  const want3d = LAB.prefs.view !== 'classic' && !lab3dFailed;
  if (!want3d) {
    if (lab3d) { lab3d.destroy(); lab3d = null; }
    labFlatShelf(shelf);
    if (labIntroArmed) { labIntroArmed = false; labIntroGo(); }
    return;
  }
  if (lab3d) { lab3d.update(shelf, labIsLight()); if (labIntroArmed) { labIntroArmed = false; lab3d.playIntro(labIntroGo); } return; }
  if (lab3dLoading) return;   // the stage stays empty until 3D is ready: no Classic flash first
  lab3dLoading = true;
  labLoad3D().then(m => {
    if (LAB.prefs.view === 'classic') return;
    const stage = document.getElementById('lab-stage');
    stage.querySelector('.lab-flat')?.remove();
    lab3d = m.mountLab3D(stage, { onFocus: labFocus, onOpen: labOpenDevice });
    lab3d.update(labShelf(LAB), labIsLight());
    if (labIntroArmed) { labIntroArmed = false; lab3d.playIntro(labIntroGo); }
  }).catch(() => { lab3dFailed = true; lab3d = null; labFlatShelf(labShelf(LAB)); if (labIntroArmed) { labIntroArmed = false; labIntroGo(); } })
    .finally(() => { lab3dLoading = false; });
}

// The flat drawings, in a row
function labFlatShelf(shelf) {
  const stage = document.getElementById('lab-stage');
  if (!stage || stage.querySelector('canvas')) return;
  stage.innerHTML = `<div class="lab-flat" style="--n:${shelf.length}">${shelf.map(d => `<button class="lab-flat-dev${d.off ? ' off' : ''}" data-id="${escapeHtml(d.id)}" data-onclick="ceb86689">
    ${deviceArt(d.type, 'lab-flat-art')}<b>${escapeHtml(d.name)}</b><span>${escapeHtml(d.kind)}</span></button>`).join('')}</div>`;
}

// ── Opening: the name lights up first, then each device (lab3d.js playIntro), then the stats ──
// CSS: #system-screen.lab-intro hides them; .go starts the timeline.
let labIntroArmed = false, labIntroTimer = 0;
const labIntroOn = () => document.getElementById('system-screen')?.classList.contains('lab-intro');
function labIntroBegin() {
  const screen = document.getElementById('system-screen');
  clearTimeout(labIntroTimer);
  screen.classList.remove('lab-intro', 'go');
  labIntroArmed = false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  screen.classList.add('lab-intro');
  labIntroArmed = true;
  labIntroTimer = setTimeout(labIntroGo, 2500);   // a slow 3D load doesn't hold the page back
}
function labIntroGo() {
  const screen = document.getElementById('system-screen');
  if (!labIntroOn() || screen.classList.contains('go')) return;
  clearTimeout(labIntroTimer);
  screen.querySelectorAll('.lab-page').forEach(pg => pg.querySelectorAll('.lab-tile').forEach((t, i) => t.style.setProperty('--d', (2300 + i * 80) + 'ms')));
  screen.classList.add('go');
  setTimeout(() => { const p = document.getElementById('lab-panels'); if (p && labIntroOn()) labCountUp(p); }, 2300);
  labIntroTimer = setTimeout(() => screen.classList.remove('lab-intro', 'go'), 4500);
}

// Big numbers count up from zero the first time the lab opens
function labCountUp(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('[data-count]').forEach(el => {
    const target = parseFloat(el.dataset.count), dec = (el.dataset.count.split('.')[1] || '').length;
    if (!isFinite(target)) return;
    const t0 = performance.now(), dur = 1100;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = (target * e).toFixed(dec);
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// Long lab names shrink to fit the width
function labFit() {
  const name = document.querySelector('#lab-show .lab-name'), span = name?.firstElementChild;
  if (!span) return;
  name.style.removeProperty('--name-fit');
  if (span.scrollWidth > name.clientWidth) name.style.setProperty('--name-fit', (name.clientWidth / span.scrollWidth).toFixed(3));
}

function labApplyLook() {
  const screen = document.getElementById('system-screen');
  if (!screen || !LAB) return;
  const font = LAB_FONTS.some(([k]) => k === LAB.prefs.font) ? LAB.prefs.font : 'bold';
  LAB_FONTS.forEach(([k]) => screen.classList.toggle('lab-font-' + k, k === font));
  screen.style.setProperty('--lab-acc', labAccent());
}

async function labRefresh() {
  const r = await fetch('/api/lab/overview');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  LAB = await r.json();
  labRender();
  if (labOpenId) labRenderDeviceSheet();
  renderDeviceTitle(LAB.prefs);
}

// Home top bar: lab name (big) + device name (small, light)
async function refreshDeviceTitle() {
  try {
    const r = await fetch('/api/lab/prefs');
    if (!r.ok) return;
    renderDeviceTitle(await r.json());
  } catch { /* offline or signed out — keep whatever is there */ }
}

function renderDeviceTitle(prefs) {
  if (!prefs) return;
  const nameEl = document.getElementById('device-title-name');
  const labEl = document.getElementById('device-title-lab');
  if (nameEl) nameEl.textContent = prefs.name || '';
  if (labEl) labEl.textContent = prefs.device_name || '';
  const t = document.getElementById('device-title');
  if (t) t.title = ((prefs.name || '') + (prefs.device_name ? ' — ' + prefs.device_name : '')).trim();
}

const LAB_AGENT_VERSION = 6;  // keep in step with lab_report.AGENT_VERSION
let labOpenId = null;          // device shown in the detail sheet

async function loadSystem() {
  const host = document.getElementById('system-content');
  if (!document.getElementById('lab-show')) {
    host.innerHTML = `<div id="lab-show" class="lab-show">
      <h2 class="lab-name" role="button" tabindex="0" title="Show off: full screen" data-onclick="c3e356eb"
        data-onkeydown="k56b336e"><span></span></h2>
      <div id="lab-stage" class="lab-stage"></div>
      <div id="lab-panels" class="lab-panels"><p class="lab-loading">Gathering your lab…</p></div></div>`;
  }
  labDrawn = false;
  labIntroBegin();
  let lastView = null; try { lastView = localStorage.getItem('lab_view'); } catch { /* storage blocked */ }
  if (lastView !== 'classic') labLoad3D().catch(() => {});
  try { await labRefresh(); } catch {
    document.getElementById('lab-panels').innerHTML = '<p class="lab-loading">Couldn\'t read this machine\'s stats. Is DeCloud still running?</p>';
  }
  if (!loadSystem._resize) {
    let pending = 0;
    loadSystem._resize = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(() => {
      const show = document.getElementById('lab-show');
      if (!show || !document.getElementById('system-screen')?.classList.contains('active')) return;
      const wide = show.clientWidth >= 700;
      if (wide !== loadSystem._wide) { loadSystem._wide = wide; labRender(); } else labFit();
    }); };
    window.addEventListener('resize', loadSystem._resize);
  }
  if (!loadSystem._t) loadSystem._t = setInterval(() => {
    if (!document.getElementById('system-screen')?.classList.contains('active')) { clearInterval(loadSystem._t); loadSystem._t = null; return; }
    labRefresh().catch(() => {});
  }, 6000);
}

// ── Settings menu (top right): Add device, Appearance ──
function labMenu(btn) {
  const open = document.getElementById('lab-menu');
  if (open) { labCloseMenu(); return; }
  const m = document.createElement('div');
  m.id = 'lab-menu';
  m.className = 'lab-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `<button role="menuitem" data-onclick="ce7f0a97">${labIcon('box').replace('<svg', '<svg class="lab-menu-ic"')}Add device</button>
    <button role="menuitem" data-onclick="c87afb79"><svg class="lab-menu-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A5.6 5.6 0 0 0 22 9.8C22 5.5 17.5 2 12 2z"/></svg>Appearance</button>`;
  btn.after(m);
  btn.setAttribute('aria-expanded', 'true');
  m.querySelector('button').focus();
  setTimeout(() => document.addEventListener('click', labMenuOutside), 0);
  document.addEventListener('keydown', labMenuKey);
}
function labMenuOutside(e) { if (!e.target.closest('#lab-menu, .lab-gear')) labCloseMenu(); }
function labMenuKey(e) { if (e.key === 'Escape') { labCloseMenu(); document.querySelector('.lab-gear')?.focus(); } }
function labCloseMenu() {
  document.getElementById('lab-menu')?.remove();
  document.querySelector('.lab-gear')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', labMenuOutside);
  document.removeEventListener('keydown', labMenuKey);
}

// ── Appearance sheet: lab name, name font, accent color ──
function labOpenLook() {
  if (!LAB) return;
  const p = LAB.prefs;
  labSheet(`<h3>Appearance</h3>
    <label for="lab-look-name">Lab name</label>
    <div class="lab-row"><input id="lab-look-name" maxlength="24" value="${escapeHtml(p.name)}" autocomplete="off"><button class="lab-btn primary" data-onclick="c1a5cac5">Save</button></div>
    <h4>Style</h4>
    <div class="lab-look-accents">${[['3d', '3D'], ['classic', 'Classic']].map(([k, label]) => `<button class="lab-look-acc${(p.view || '3d') === k ? ' on' : ''}" data-v="${k}" data-k="view" aria-pressed="${(p.view || '3d') === k}" data-onclick="cfe534d2">${label}</button>`).join('')}</div>
    <h4>Name font</h4>
    <div class="lab-look-fonts">${LAB_FONTS.map(([k, label]) => `<button class="lab-look-font lab-font-${k}${p.font === k ? ' on' : ''}" data-v="${k}" aria-pressed="${p.font === k}" data-onclick="ce7044ef">
      <span class="lab-look-sample">${escapeHtml(p.name)}</span><em>${label}</em></button>`).join('')}</div>
    <h4>Accent color</h4>
    <div class="lab-look-accents">${Object.entries(LAB_ACCENTS).map(([k, [label, hex]]) => `<button class="lab-look-acc${p.accent === k ? ' on' : ''}" data-v="${k}" aria-pressed="${p.accent === k}" data-onclick="cc2f034e">
      <span>${[0, 1, 2].map(i => `<i style="background:${labShade(hex, i)}"></i>`).join('')}</span>${label}</button>`).join('')}</div>`);
}

async function labSaveLook(change) {
  if (!LAB || (change.name !== undefined && !change.name)) return;
  Object.assign(LAB.prefs, change);
  labRender();
  renderDeviceTitle(LAB.prefs);
  document.querySelectorAll('#lab-sheet [data-v]').forEach(b => {
    const on = b.dataset.k === 'view' ? b.dataset.v === (LAB.prefs.view || '3d') : b.dataset.v === LAB.prefs.font || b.dataset.v === LAB.prefs.accent;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
  });
  document.querySelectorAll('#lab-sheet .lab-look-sample').forEach(el => { el.textContent = LAB.prefs.name; });
  const r = await fetch('/api/lab/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) }).catch(() => null);
  if (!r || !r.ok) showToast('Could not save. Try again.');
}

// ── Sheet (dialog) used by device details and Add device ──
function labSheet(html, onClose) {
  labCloseSheet();
  const wrap = document.createElement('div');
  wrap.className = 'lab-sheet-overlay';
  wrap.id = 'lab-sheet';
  wrap.innerHTML = `<div class="lab-sheet" role="dialog" aria-modal="true"><button class="lab-sheet-close" aria-label="Close" data-onclick="cadeb8c8">&times;</button><div class="lab-sheet-body">${html}</div></div>`;
  wrap.onclick = (e) => { if (e.target === wrap) labCloseSheet(); };
  wrap._onClose = onClose;
  document.body.appendChild(wrap);
  document.addEventListener('keydown', labSheetKey);
  return wrap.querySelector('.lab-sheet-body');
}

function labSheetKey(e) { if (e.key === 'Escape') labCloseSheet(); }

function labCloseSheet() {
  const s = document.getElementById('lab-sheet');
  document.removeEventListener('keydown', labSheetKey);
  labOpenId = null;
  if (!s) return;
  s.remove();
  if (s._onClose) s._onClose();
}

// ── Device details ──
function labOpenDevice(id) {
  labSheet('');
  labOpenId = id;
  labRenderDeviceSheet();
}

function labRenderDeviceSheet() {
  const body = document.querySelector('#lab-sheet .lab-sheet-body');
  const n = LAB?.nodes.find(x => x.id === labOpenId) || LAB?.phones?.find(x => x.id === labOpenId);
  if (!body || !n) return;
  if (n.kind === 'phone') { labRenderPhoneSheet(body, n); return; }
  if (body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;  // don't clobber typing
  const kv = (k, v) => v ? `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>` : '';
  const head = `<div class="lab-dsheet-head">${deviceArt(labDevType(n), 'lab-dsheet-os')}
    <div><h3>${escapeHtml(n.name)}</h3><span class="lab-dim">${n.error ? 'Offline' : escapeHtml(labDevLabel(n)) + (n.hub ? ' · DeCloud host' : '')}${n.address ? ' · ' + escapeHtml(n.address) : ''}</span></div>
    <button class="lab-btn" data-onclick="ca30327d">Rename</button></div>
    <div id="lab-rename" class="lab-row" hidden><input id="lab-rename-input" maxlength="40" aria-label="Device name" value="${escapeHtml(n.name)}"><button class="lab-btn primary" data-id="${escapeHtml(n.id)}" data-onclick="c2f8587c">Save</button></div>
    <p class="lab-msg" id="lab-dmsg" role="status"></p>`;
  if (n.error) {
    body.innerHTML = head + `<p class="lab-dim">${escapeHtml(n.error)}. Check that the device is on and connected to Tailscale.</p>` + labRemoveBtn(n);
    return;
  }
  const outdated = !n.hub && n.kind === 'agent' && (n.agent_version || 0) < LAB_AGENT_VERSION;
  const ai = n.ollama || { ok: false, installed: [], loaded: [] };
  const loadedNames = new Set(ai.loaded.map(m => m.name));
  const models = ai.ok
    ? (ai.installed.length ? [...ai.installed].sort((a, b) => loadedNames.has(b.name) - loadedNames.has(a.name)).map(m => `<div class="lab-item"><div><b>${escapeHtml(m.name)}</b><span>${labGB(m.size)}${loadedNames.has(m.name) ? ' · loaded in memory' : ''}</span></div>
        ${loadedNames.has(m.name) ? `<button class="lab-btn" data-id="${escapeHtml(n.id)}" data-t="${escapeHtml(m.name)}" data-onclick="c6ce4730">Unload</button>` : ''}</div>`).join('')
        : '<p class="lab-dim">No models yet.</p>')
      + `<button class="lab-btn" data-id="${escapeHtml(n.id)}" data-onclick="ce102b9c">Get models for this device</button>`
    : (outdated ? '<p class="lab-dim">Update this device (below) to use it for AI.</p>'
      : '<p class="lab-dim">Ollama is not running here. Install it from ollama.com to use this device for AI Chat.</p>');
  const ctrs = n.running.containers;
  const procs = n.running.processes;
  body.innerHTML = head + `
    ${outdated ? (n.auto_update
      ? `<div class="lab-help"><b>Update available</b><p>A newer DeCloud agent is ready. The device installs it only if it is signed with the DeCloud release key, tests it, and switches back by itself if it fails to start.</p>
          <button class="lab-btn primary" data-id="${escapeHtml(n.id)}" data-onclick="cd9ed946">Update now</button></div>`
      : `<div class="lab-help"><b>Update available</b><p>Run the setup command on this device once more (Add device shows it) to update it. Once signed releases are set up, devices that allow updates update themselves.</p></div>`) : ''}
    <dl class="lab-kv">
      ${kv('System', `${labOs(n.os)} · ${n.arch}`)}
      ${kv('CPU', `${labCpu(n.cpu_name) || n.cores + ' threads'} · ${Math.round(n.cpu_percent)}%`)}
      ${n.gpus.map(g => kv('GPU', labGpu(g.name) + (g.vram_gb ? ` · ${g.vram_gb} GB` : '') + (g.util != null ? ` · ${Math.round(g.util)}%` : '') + (g.mem_used_gb >= 1 ? ` · ${Math.round(g.mem_used_gb)} GB held` : ''))).join('')}
      ${kv('Memory', `${labGB(n.ram_used)} / ${labGB(n.ram_total)} (${labPct(n.ram_used, n.ram_total)}%)`)}
      ${kv('Storage', `${labGB(n.storage.used)} / ${labGB(n.storage.total)}`)}
      ${kv('Uptime', labDur(n.uptime_s))}
      ${n.temp ? kv('Temp', `${n.temp}°C`) : ''}
    </dl>
    <h4>AI models</h4><div class="lab-list">${models}</div>
    ${ctrs.length ? `<h4>Containers</h4><div class="lab-list">${ctrs.map(c => `<div class="lab-item"><div><b>${escapeHtml(c.name)}</b><span>${escapeHtml(c.image)}</span></div>
      ${outdated ? '' : `<button class="lab-btn" data-id="${escapeHtml(n.id)}" data-t="${escapeHtml(c.name)}" data-onclick="c7e4d5d6">Restart</button>`}</div>`).join('')}</div>` : ''}
    ${procs.length ? `<h4>Busiest apps</h4><div class="lab-list">${procs.map(x => `<div class="lab-item"><div><b>${escapeHtml(x.name)}</b><span>CPU ${x.cpu}% · memory ${x.mem}%</span></div></div>`).join('')}</div>` : ''}
    ${labRemoveBtn(n)}`;
}

// A phone has no agent: show what Tailscale knows and what the phone can do here
function labRenderPhoneSheet(body, n) {
  if (body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const android = n.device?.type === 'android';
  const seen = n.last_seen && !n.online ? new Date(n.last_seen) : null;
  const status = n.online ? 'Online' : seen && !isNaN(seen) ? `Last seen ${seen.toLocaleString()}` : 'Offline';
  const install = android ? 'In Chrome, open the menu and tap <b>Install app</b>.' : 'In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.';
  body.innerHTML = `<div class="lab-dsheet-head">${deviceArt(labDevType(n), 'lab-dsheet-os')}
    <div><h3>${escapeHtml(n.name)}</h3><span class="lab-dim">${escapeHtml(DEVICE_LABEL[labDevType(n)])} · ${escapeHtml(status)}</span></div>
    <button class="lab-btn" data-onclick="ca30327d">Rename</button></div>
    <div id="lab-rename" class="lab-row" hidden><input id="lab-rename-input" maxlength="40" aria-label="Device name" value="${escapeHtml(n.name)}"><button class="lab-btn primary" data-id="${escapeHtml(n.id)}" data-onclick="c2f8587c">Save</button></div>
    <p class="lab-msg" id="lab-dmsg" role="status"></p>
    <dl class="lab-kv"><dt>Tailscale</dt><dd>${escapeHtml(n.ip)}</dd><dt>System</dt><dd>${escapeHtml(n.os)}</dd></dl>
    <p class="lab-dim">Phones can't share their CPU or memory with the lab. DeCloud shows when this one is online, and the phone becomes your way into the lab from anywhere.</p>
    <h4>Use your lab from this phone</h4>
    <div class="lab-list">
      <div class="lab-item"><div><b>Put DeCloud on the home screen</b><span>On the phone, open ${escapeHtml(location.origin)}. ${install}</span></div></div>
      <div class="lab-item"><div><b>Chat with your lab's AI</b><span>AI Chat runs on your lab's computers, so it works the same on the phone, from anywhere.</span></div></div>
      <div class="lab-item"><div><b>Send files to a lab computer</b><span>Share a photo or file, pick <b>Tailscale</b>, then pick the computer.</span></div></div>
    </div>
    ${labRemoveBtn(n)}`;
}

async function labUpdateAgent(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  const r = await fetch('/api/lab/devices/' + encodeURIComponent(id) + '/update', { method: 'POST' }).catch(() => null);
  const d = await r?.json().catch(() => ({})) || {};
  showToast(r && r.ok ? d.message || 'Updating.' : d.error || 'Could not update. Try again.');
  if (btn) { btn.disabled = false; btn.textContent = 'Update now'; }
  setTimeout(() => labRefresh().catch(() => {}), 8000);
}

function labRemoveBtn(n) {
  return n.hub ? '' : `<button class="lab-btn danger" data-id="${escapeHtml(n.id)}" data-name="${escapeHtml(n.name)}" data-onclick="c0e71525">Remove from lab</button>`;
}

function labRenameStart() {
  const row = document.getElementById('lab-rename');
  row.hidden = !row.hidden;
  if (!row.hidden) document.getElementById('lab-rename-input').focus();
}

async function labRename(id) {
  const name = document.getElementById('lab-rename-input').value.trim();
  const r = await fetch('/api/lab/devices/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => null);
  const d = await r?.json().catch(() => ({})) || {};
  if (!r || !r.ok) { document.getElementById('lab-dmsg').textContent = d.error || 'Could not rename.'; return; }
  document.activeElement?.blur();
  await labRefresh().catch(() => {});
}

async function labAction(id, action, target) {
  const verb = action === 'restart-container' ? `Restart ${target}?` : `Unload ${target} from memory?`;
  if (!await appConfirm(verb, { ok: action === 'restart-container' ? 'Restart' : 'Unload' })) return;
  const msg = document.getElementById('lab-dmsg');
  if (msg) msg.textContent = 'Working…';
  const r = await fetch(`/api/lab/devices/${encodeURIComponent(id)}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, target }) }).catch(() => null);
  const d = await r?.json().catch(() => ({})) || {};
  if (msg) msg.textContent = r?.ok ? d.message : (d.error || 'Something went wrong. Try again.');
  labRefresh().catch(() => {});
}

async function labRemove(id, name) {
  if (!await appConfirm(`Remove ${name} from your lab?`, { danger: true, ok: 'Remove' })) return;
  try {
    const r = await fetch('/api/lab/devices/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Something went wrong. Try again.');
    labCloseSheet();
  } catch (e) { showToast(friendlyError(e)); }
  labRefresh();
}

function labGetModels(id) {
  labCloseSheet();
  openApp('ollama');
  openChatLibrary(id);
}

// ── Add device: pick from Tailscale, run one command, confirm a number ──
let labAddJob = null;

async function labOpenAdd() {
  const body = labSheet('<h3>Add a device</h3><p class="lab-dim">Looking for your devices on Tailscale…</p>', labCancelAdd);
  let data;
  try {
    const r = await fetch('/api/lab/tailnet');
    data = await r.json();
    if (!r.ok) throw new Error(data.error);
  } catch (e) {
    body.innerHTML = `<h3>Add a device</h3><div class="lab-help"><b>Tailscale is needed</b><p>DeCloud connects your devices through Tailscale, a free private network. Install it on this computer and on each device you want to add, sign in with the same account, then try again.</p><p><a href="https://tailscale.com/download" target="_blank" rel="noopener">Get Tailscale</a></p></div>` + labMoreOptions();
    labInitMoreOptions();
    return;
  }
  labOpenAdd.command = data.command;
  const rows = data.devices.map(d => {
    const os = (d.os || '').toLowerCase(), linux = os === 'linux', phone = os === 'ios' || os === 'android';
    const status = d.added ? 'In your lab' : phone ? (os === 'ios' ? 'iPhone or iPad' : 'Android') + ' · nothing to install'
      : !d.online ? 'Offline' : !linux ? 'Only Linux computers for now' : 'Ready to add';
    const btn = d.added ? '' : phone
      ? `<button class="lab-btn primary" data-ip="${escapeHtml(d.ip)}" data-onclick="cf833bc6">Add</button>`
      : !d.online || !linux ? ''
      : `<button class="lab-btn primary" data-ip="${escapeHtml(d.ip)}" data-name="${escapeHtml(d.name)}" data-onclick="cf369059">Add</button>`;
    return `<div class="lab-item${btn ? '' : ' muted'}"><span class="lab-dot ${d.online ? '' : 'off'}"></span><div><b>${escapeHtml(d.name)}</b><span>${escapeHtml(status)}</span></div>${btn}</div>`;
  }).join('');
  body.innerHTML = `<h3>Add a device</h3>
    <p class="lab-dim">These are the devices on your Tailscale network. Pick one to bring into your lab. Its stats, AI models and containers will show up here, and AI apps can run on it.</p>
    <div class="lab-list">${rows || '<p class="lab-dim">No other devices yet. Install Tailscale on the device you want to add and sign in with the same account.</p>'}</div>
    ${labMoreOptions()}`;
  labInitMoreOptions();
}

async function labAddPhone(ip, btn) {
  if (btn) btn.disabled = true;
  const r = await fetch('/api/lab/phones', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) }).catch(() => null);
  const d = await r?.json().catch(() => ({})) || {};
  if (!r || !r.ok) { if (btn) btn.disabled = false; showToast(d.error || 'Could not add the phone. Try again.'); return; }
  labCloseSheet();
  showToast(`${d.name} added to your lab`);
  labRefresh().catch(() => {});
}

function labMoreOptions() {
  return `<details class="lab-kind"><summary>Other ways to connect</summary>
    <p class="lab-msg" id="lab-msg" role="status"></p>
    <label class="lab-switch"><input type="checkbox" id="lab-shareable" data-onchange="c8b22f3b"><span>Let another DeCloud add this computer</span></label>
    <button class="lab-btn" data-onclick="c58066e5">Find devices on my local network</button>
    <div id="lab-found"></div>
    <label for="lab-code">Paste a code from the other device</label>
    <div class="lab-row"><input id="lab-code" placeholder="dcl1.…" autocomplete="off"><button class="lab-btn" data-onclick="c72d5f12">Add</button></div>
    <div class="lab-row"><button class="lab-btn" data-onclick="c28063f1">Show this computer's code</button><button class="lab-btn" data-onclick="c84c618b">Reset key</button></div>
    <pre class="lab-cmd" id="lab-own-code" hidden></pre>
    <p class="lab-dim">Treat a code like a password. Reset key disconnects every hub that added this computer.</p></details>`;
}

function labInitMoreOptions() {
  const box = document.getElementById('lab-shareable');
  if (box && LAB) box.checked = !!LAB.prefs.shareable;
}

async function labStartAdd(ip, name) {
  const body = document.querySelector('#lab-sheet .lab-sheet-body');
  const r = await fetch('/api/lab/tailnet/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) }).catch(() => null);
  const d = await r?.json().catch(() => ({})) || {};
  if (!r || !r.ok) { showToast(d.error || 'Could not start. Try again.'); return; }
  labAddJob = d.job;
  body.innerHTML = `<h3>Add ${escapeHtml(name)}</h3>
    <ol class="lab-steps">
      <li><b>On ${escapeHtml(name)}, open a terminal</b> (or connect with SSH) and run this command:
        <button class="lab-copybox" aria-label="Copy command" data-onclick="c64bd9a7"><code id="lab-add-cmd"></code><span class="lab-copybox-icon">${LAB_COPY_ICON}</span></button>
        <span class="lab-dim">It installs a small DeCloud program for your user. No admin password needed.</span></li>
      <li><b>Compare the number.</b> DeCloud finds the device by itself and shows a six-digit number here and in that terminal.</li>
    </ol>
    <div class="lab-add-status" id="lab-add-status"><span class="lab-spin"></span>Waiting for ${escapeHtml(name)}…</div>
    <button class="lab-btn" data-onclick="cadeb8c8">Cancel</button>`;
  document.getElementById('lab-add-cmd').textContent = labOpenAdd.command;
  labPollAdd(d.job, name);
}

async function labPollAdd(job, name) {
  while (labAddJob === job) {
    await new Promise(res => setTimeout(res, 2000));
    if (labAddJob !== job) return;
    const r = await fetch('/api/lab/pair/' + job).catch(() => null);
    const j = await r?.json().catch(() => null) || { state: 'failed', error: 'Lost contact with DeCloud.' };
    const box = document.getElementById('lab-add-status');
    if (!box) return;
    if (j.state === 'confirm') {
      box.innerHTML = `<div class="lab-num">${escapeHtml(j.number.slice(0, 3))} ${escapeHtml(j.number.slice(3))}</div>
        <p>In the terminal on <b>${escapeHtml(name)}</b>, type <b>y</b> and press Enter if it shows this same number.</p>
        <p class="lab-dim">If the numbers don't match, type n. Something else may be pretending to be your device.</p>`;
    } else if (j.state === 'done') {
      labAddJob = null;
      document.querySelector('#lab-sheet .lab-sheet-body').innerHTML = `<h3>${escapeHtml(name)} is in your lab</h3>
        <p class="lab-dim">It now appears with your other devices. If it has Ollama models, you can use them in AI Chat.</p>
        <button class="lab-btn primary" data-onclick="cadeb8c8">Done</button>`;
      labRefresh().catch(() => {});
      return;
    } else if (j.state === 'failed') {
      labAddJob = null;
      box.innerHTML = `<p>${escapeHtml(j.error || 'Pairing failed.')}</p><button class="lab-btn primary" data-name="${escapeHtml(name)}" data-onclick="c87674c5">Try again</button>`;
      return;
    }
  }
}

function labCancelAdd() {
  if (!labAddJob) return;
  fetch('/api/lab/pair/' + labAddJob, { method: 'DELETE' }).catch(() => {});
  labAddJob = null;
}

function labSay(text) {
  const el = document.getElementById('lab-msg');
  if (el) el.textContent = text; else if (text) showToast(text);
}

async function labAddDevice() {
  const input = document.getElementById('lab-code');
  labSay('Connecting…');
  const r = await fetch('/api/lab/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: input.value }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { labSay(d.error || 'Could not add that device.'); return; }
  labSay(`Added ${d.name}.`);
  input.value = '';
  labRefresh();
}

async function labDiscover() {
  const box = document.getElementById('lab-found');
  labSay('Looking for devices on your network…');
  box.innerHTML = '';
  const found = await (await fetch('/api/lab/discover', { method: 'POST' })).json().catch(() => []);
  labSay(found.length ? '' : 'Nothing found. On the other computer, turn on "Let another DeCloud add this computer", then try again.');
  box.innerHTML = found.map(f => `
    <div class="lab-item"><span class="lab-dot"></span><div><b>${escapeHtml(f.name)}</b><span>${f.kind === 'agent' ? 'DeCloud agent' : 'DeCloud'} · ${escapeHtml(f.ip)}</span></div>
      ${f.added ? '<span class="lab-dim">Added</span>' : `<button class="lab-btn primary" data-ip="${escapeHtml(f.ip)}" data-port="${Number(f.port)}" data-onclick="c9625c8e">Add</button>`}</div>`).join('');
}

async function labPair(ip, port) {
  labSay('Contacting device…');
  let r;
  try {
    r = await fetch('/api/lab/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, port }) });
  } catch { labSay('Could not reach DeCloud. Try again.'); return; }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { labSay(d.error || 'Could not reach that device.'); return; }
  const num = `${d.number.slice(0, 3)} ${d.number.slice(3)}`;
  document.getElementById('lab-found').innerHTML = `<div class="lab-pairing"><div class="lab-num">${escapeHtml(num)}</div>
    <p>${d.kind === 'agent' ? `In the terminal on <b>${escapeHtml(d.name)}</b>, type <b>y</b> if it shows this number.`
      : `On <b>${escapeHtml(d.name)}</b>, open DeCloud and tap <b>Allow</b> if it shows this number.`}</p>
    <p class="lab-dim">If the numbers don't match, deny it. Someone may be pretending to be your device.</p></div>`;
  labSay('Waiting for you to approve on the other device…');
  for (let i = 0; i < 80; i++) {
    await new Promise(res => setTimeout(res, 2000));
    const j = await (await fetch('/api/lab/pair/' + d.job)).json().catch(() => ({ state: 'failed' }));
    if (j.state === 'waiting') continue;
    const found = document.getElementById('lab-found');
    if (found) found.innerHTML = '';
    labSay(j.state === 'done' ? `Added ${d.name}.` : (j.error || 'Pairing failed.'));
    labRefresh();
    return;
  }
}

// Pairing prompts pop up on whatever screen is open, so nobody has to find Lab first.
// Polls only while this computer is shareable; labSetShareable restarts it.
async function labPollRequests() {
  if (labPollRequests.on) return;
  labPollRequests.on = true;
  clearTimeout(labPollRequests.t);
  let d = { shareable: false, requests: [] }, retry = false;
  try { const r = await fetch('/api/lab/pair-requests'); retry = !r.ok; if (r.ok) d = await r.json(); } catch { retry = true; }
  let box = document.getElementById('lab-request-overlay');
  if (d.requests?.length && !box) { box = document.createElement('div'); box.id = 'lab-request-overlay'; document.body.appendChild(box); }
  if (box) box.innerHTML = (d.requests || []).map(q => `<div class="lab-panel lab-request" role="alertdialog" aria-label="Pairing request">
      <b>${escapeHtml(q.hub)} wants to add this computer to its lab</b>
      <div class="lab-num">${escapeHtml(q.number.slice(0, 3))} ${escapeHtml(q.number.slice(3))}</div>
      <p class="lab-dim">Only allow if ${escapeHtml(q.hub)} shows the same number. It will see this computer's stats, use and download or delete its Ollama AI models, and be able to restart its running containers. It can't open a shell or read files.</p>
      <div class="lab-row"><button class="lab-btn primary" data-id="${escapeHtml(q.id)}" data-onclick="ceff8cab">Allow</button>
        <button class="lab-btn" data-id="${escapeHtml(q.id)}" data-onclick="c3d6c1d7">Deny</button></div></div>`).join('');
  labPollRequests.on = false;
  if (d.shareable || retry) labPollRequests.t = setTimeout(labPollRequests, retry ? 10000 : 2500);  // retry: not logged in yet
}
labPollRequests();

async function labAnswer(id, allow) {
  await fetch('/api/lab/pair-requests/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow }) });
  const box = document.getElementById('lab-request-overlay');
  if (box) box.innerHTML = '';
}

async function labSetShareable(on) {
  const r = await fetch('/api/lab/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shareable: on }) });
  const d = await r.json().catch(() => ({}));
  if (LAB) LAB.prefs.shareable = !!d.shareable;
  if (d.shareable) labPollRequests();
  labSay(d.error || (on ? 'Another DeCloud can now find this computer. Nothing is shared until you tap Allow.' : 'This computer is hidden from other devices.'));
}


async function labShowCode() {
  const el = document.getElementById('lab-own-code');
  const r = await fetch('/api/lab/pair-code');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { labSay(d.error || 'Could not make a code.'); return; }
  el.textContent = d.code;
  el.hidden = false;
  labCopy(d.code);
}

async function labResetKey() {
  if (!await appConfirm('Disconnect every hub that added this computer?', { danger: true, ok: 'Disconnect' })) return;
  const r = await fetch('/api/lab/reset-key', { method: 'POST' }).catch(() => null);
  if (!r || !r.ok) { showToast("Couldn't reset — try again"); return; }
  document.getElementById('lab-own-code').hidden = true;
  labSay('Key reset. Hubs that had this computer must add it again.');
}

const LAB_COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const LAB_CHECK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

// Tap anywhere on the command box to copy; the icon turns into a check.
function labCopyBox(btn) {
  const icon = btn.querySelector('.lab-copybox-icon');
  navigator.clipboard?.writeText(btn.querySelector('code').textContent).then(() => {
    icon.innerHTML = LAB_CHECK_ICON;
    btn.classList.add('copied');
    btn.setAttribute('aria-label', 'Copied');
    setTimeout(() => { icon.innerHTML = LAB_COPY_ICON; btn.classList.remove('copied'); btn.setAttribute('aria-label', 'Copy command'); }, 1500);
  }).catch(() => showToast('Could not copy. Select the command and copy it by hand.'));
}

function labCopy(text, btn) {
  navigator.clipboard?.writeText(text).then(() => {
    if (btn) { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1500); }
    else labSay('Copied.');
  }).catch(() => {});
}

function labShare(on) {
  const s = document.getElementById('system-screen');
  if (on === s.classList.contains('lab-share')) return;
  s.classList.toggle('lab-share', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.getElementById('system-screen')?.classList.remove('lab-share');
});
