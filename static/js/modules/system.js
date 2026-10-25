// ===== Module: system =====
function fmtBytes(n) {
  if (n == null) return 'N/A';
  const g = 1024 * 1024 * 1024;
  if (n >= g) return (n / g).toFixed(1) + ' GB';
  return (n / (1024 * 1024)).toFixed(0) + ' MB';
}

async function loadSystem() {
  try {
    const r = await fetch('/api/system');
    const d = await r.json();
    const temps = d.temps && Object.keys(d.temps).length > 0
      ? Object.entries(d.temps).map(([k,v]) => v.map(s => `${s.label||k}: ${s.current}°C`).join('<br>')).join('')
      : 'N/A';
    const specs = [
      ['OS', d.os || 'N/A'],
      ['Kernel', d.os_kernel || 'N/A'],
      ['CPU', d.cpu_model || 'N/A'],
      ['Cores', d.cpu_cores != null ? d.cpu_cores : 'N/A'],
      ['GPU', d.gpu || 'N/A'],
      ['RAM', d.ram_total ? fmtBytes(d.ram_total) : 'N/A'],
      ['Disk', d.disk_total ? fmtBytes(d.disk_total) : 'N/A'],
      ['Host', d.hostname || 'N/A'],
    ];
    const specRows = specs.map(([k, v]) =>
      `<div class="spec-row"><span class="spec-key">${k}</span><span class="spec-val">${v}</span></div>`
    ).join('');
    document.getElementById('system-content').innerHTML = `
      <div class="spec-tile">
        <div class="spec-tile-head">System Specs</div>
        <div class="spec-tile-body">${specRows}</div>
      </div>
      <div class="stat-card"><div class="stat-label">CPU</div><div class="stat-value">${d.cpu_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.cpu_percent}%;background:${d.cpu_percent>80?'var(--red)':'var(--green)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Memory</div><div class="stat-value">${d.ram_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.ram_percent}%;background:${d.ram_percent>80?'var(--red)':'var(--accent)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Disk</div><div class="stat-value">${d.disk_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.disk_percent}%;background:${d.disk_percent>80?'var(--red)':'var(--orange)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value" style="font-size:20px">${d.uptime}</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:4px">${d.hostname}</div></div>
      <div class="stat-card"><div class="stat-label">Temps</div><div style="font-size:15px;line-height:1.8">${temps}</div></div>
    `;
  } catch { document.getElementById('system-content').innerHTML = '<p style="color:var(--red)">Failed to load system info.</p>'; }
}


// ── Formatting ──
const labGB = (b) => b >= 1e12 ? (b / 1e12).toFixed(b >= 1e13 ? 0 : 1) + ' TB' : Math.round(b / 1e9) + ' GB';
const labDur = (s) => s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
const labCpu = (n) => (n || '').replace(/\(R\)|\(TM\)|Processor|CPU|@.*$|\d+-Core/gi, '').replace(/w\/.*$/i, '').replace(/\s+/g, ' ').trim();
const labGpu = (n) => (n || '').replace(/Advanced Micro Devices, Inc\. \[AMD\/ATI\]/, 'AMD').replace(/NVIDIA Corporation|Intel Corporation/, (m) => m.split(' ')[0]).replace(/\[|\]/g, '').trim();
const labOs = (o) => (o || '').replace(/ GNU\/Linux| Linux(?= \d)|\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
const labPct = (u, t) => t ? Math.round(u / t * 100) : 0;
const labIsSbc = (n) => /arm|aarch/i.test(n.arch || '') && n.ram_total <= 17e9;
const labRole = (n) => labIsSbc(n) ? 'sbc' : (n.storage && n.storage.total > 4e12 && !(n.gpus || []).some(g => g.vram_gb)) ? 'nas' : 'server';

function labShift(hex, deg) {
  let [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0; const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return `hsl(${(h * 60 + deg + 360) % 360} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

// 5x5 block font for the lab-name banner (neofetch style)
const LAB_FONT = {
  A:'.###.#...#######...##...#', B:'####.#...#####.#...#####.', C:'.#####....#....#.....####', D:'####.#...##...##...#####.',
  E:'######....####.#....#####', F:'######....####.#....#....', G:'.#####....#..###...#.####', H:'#...##...#######...##...#',
  I:'#####..#....#....#..#####', J:'..###...#....#.#..#..##..', K:'#...##..#.###..#..#.#...#', L:'#....#....#....#....#####',
  M:'#...###.###.#.##...##...#', N:'#...###..##.#.##..###...#', O:'.###.#...##...##...#.###.', P:'####.#...#####.#....#....',
  Q:'.###.#...##.#.##..#..##.#', R:'####.#...#####.#..#.#...#', S:'.#####.....###.....#####.', T:'#####..#....#....#....#..',
  U:'#...##...##...##...#.###.', V:'#...##...##...#.#.#...#..', W:'#...##...##.#.###.###...#', X:'#...#.#.#...#...#.#.#...#',
  Y:'#...#.#.#...#....#....#..', Z:'#####...#...#...#...#####', 0:'.###.#..###.#.###..#.###.', 1:'..#...##....#....#...###.',
  2:'####.....#.###.#....#####', 3:'####.....#.###.....#####.', 4:'#...##...######....#....#', 5:'######....####.....#####.',
  6:'.###.#....####.#...#.###.', 7:'#####....#...#...#....#..', 8:'.###.#...#.###.#...#.###.', 9:'.###.#...#.####....#.###.',
  '-':'...........###...........', ' ':'.........................', '.':'......................#..',
};
function labBanner(name) {
  const chars = name.toUpperCase().slice(0, 10).split('').map(c => (LAB_FONT[c] || LAB_FONT[' ']).padEnd(25, '.'));
  return [0, 1, 2, 3, 4].map(r => chars.map(g => g.slice(r * 5, r * 5 + 5).replace(/#/g, '█').replace(/\./g, ' ')).join(' ')).join('\n');
}

function labRunning(nodes) {
  const items = [];
  for (const n of nodes) {
    if (n.error || !n.running) continue;
    n.running.containers.forEach(c => items.push({ k: 'ctr', t: c.name, n: n.name }));
    n.running.models.forEach(m => items.push({ k: 'ai', t: m, n: n.name }));
    n.running.services.filter(s => s.active).forEach(s => items.push({ k: 'svc', t: s.name.replace(/\.service$/, ''), n: n.name }));
  }
  if (!items.length) {  // nothing declared → show the busiest processes so the strip is never empty
    const seen = new Set();
    for (const n of nodes) (n.running?.processes || []).slice(0, 3).forEach(p => { if (!seen.has(p.name)) { seen.add(p.name); items.push({ k: 'proc', t: p.name, n: n.name }); } });
  }
  return items;
}

function labLogo(n, cls) {
  const l = OS_LOGOS[osLogoKey(n.os || '', n.kernel)];
  return `<svg class="${cls}" viewBox="0 0 48 48" style="color:${l.color}" aria-hidden="true">${l.svg}</svg>`;
}

// ── Style A: neofetch ──
function labNeofetch(L) {
  const t = L.totals, hub = L.nodes[0], name = L.prefs.name;
  const banner = labBanner(name), cols = banner.split('\n')[0].length;
  const run = labRunning(L.nodes), shown = run.slice(0, 14);
  const gpus = t.gpus.map(labGpu);
  const kv = (k, v) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`;
  const nodes = L.nodes.slice(0, 8).map(n => n.error
    ? `<div class="lab-nf-node off"><svg class="lab-nf-os" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="14" fill="none" stroke="#56627f" stroke-width="4"/></svg><div><b>${escapeHtml(n.name)}</b><span>${escapeHtml(n.error)}</span></div></div>`
    : `<div class="lab-nf-node">${labLogo(n, 'lab-nf-os')}<div><b>${escapeHtml(n.name)}</b><span>${n.cores}t · ${labGB(n.ram_total)}${n.gpus.length ? ' · GPU' : ''}</span>
        <i class="lab-bar"><s style="width:${n.cpu_percent}%"></s></i><i class="lab-bar"><s style="width:${labPct(n.ram_used, n.ram_total)}%"></s></i></div></div>`).join('');
  return `
    <pre class="lab-nf-banner" style="font-size:${Math.min(5.2, 88 / (cols * 0.6)).toFixed(2)}cqw">${banner}</pre>
    <div class="lab-nf-who"><b>${escapeHtml(name.toLowerCase())}</b>@<b>lab</b></div>
    <div class="lab-nf-rule"></div>
    <dl class="lab-nf-kv">
      ${kv('Nodes', `${t.online} online${t.nodes > t.online ? ` · ${t.nodes - t.online} offline` : ''}`)}
      ${kv('Hub', `${labOs(hub.os)} · ${hub.kernel}`)}
      ${kv('CPU', `${t.cores} threads · ${t.cpu_percent}% load`)}
      ${gpus.length ? kv('GPU', gpus.slice(0, 2).join(' + ') + (gpus.length > 2 ? ` +${gpus.length - 2}` : '') + (t.vram_gb ? ` · ${t.vram_gb} GB` : '')) : ''}
      ${kv('Memory', `${labGB(t.ram_used)} / ${labGB(t.ram_total)} (${labPct(t.ram_used, t.ram_total)}%)`)}
      ${kv('Storage', `${labGB(t.storage_used)} / ${labGB(t.storage_total)}`)}
      ${kv('Uptime', labDur(t.uptime_s))}
      ${hub.temp ? kv('Temp', `${hub.temp}°C (hub)`) : ''}
    </dl>
    <div class="lab-nf-blocks">${[0, 40, 80, 160, 220, 280].map(d => `<i style="background:${labShift(L.prefs.accent, d)}"></i>`).join('')}</div>
    <div class="lab-nf-nodes">${nodes}</div>
    <div class="lab-run">${shown.map(i => `<span class="lab-chip ${i.k}"><i></i>${escapeHtml(i.t)}</span>`).join('')}${run.length > shown.length ? `<span class="lab-chip">+${run.length - shown.length} more</span>` : ''}</div>`;
}

// ── Style B: rack ──
function labRack(L) {
  const t = L.nodes.length > 7 ? L.nodes.slice(0, 6) : L.nodes, T = L.totals;
  const led = (n) => n.error ? '<i class="lab-led dim"></i>' : `<i class="lab-led" style="animation-duration:${(1.6 - Math.min(n.cpu_percent, 100) / 80).toFixed(2)}s"></i>`;
  const units = t.map(n => {
    const role = n.error ? 'server' : labRole(n);
    const spec = n.error ? escapeHtml(n.error)
      : [`${escapeHtml(labCpu(n.cpu_name))} · ${n.cores}t`,
         `${labGB(n.ram_total)} RAM${n.gpus.length ? ' · ' + escapeHtml(labGpu(n.gpus[0].name)) : ''}`,
         `CPU ${Math.round(n.cpu_percent)}%${n.temp ? ` · ${n.temp}°C` : ''} · ${labGB(n.storage.total)}`].slice(0, role === 'sbc' ? 1 : 3).join('<br>');
    const bays = role === 'nas' ? `<div class="lab-bays">${Array.from({ length: 8 }, (_, i) => `<i class="${i < n.storage.volumes ? '' : 'empty'}"></i>`).join('')}</div>` : '';
    return `<div class="lab-ru ${role}${n.error ? ' off' : ''}"><b>${escapeHtml(n.name.toUpperCase())}</b><div class="lab-ru-spec">${bays}<span>${spec}</span></div><div class="lab-leds">${led(n)}${n.error ? '' : '<i class="lab-led steady"></i>'}</div></div>`;
  }).join('') + (L.nodes.length > t.length ? `<div class="lab-ru sbc"><b>+${L.nodes.length - t.length} MORE</b></div>` : '');
  const run = labRunning(L.nodes).slice(0, 10);
  const tot = (v, k) => `<div><b>${v}</b><span>${k}</span></div>`;
  return `
    <div class="lab-rk-title">${escapeHtml(L.prefs.name.toUpperCase())}<small>${T.nodes} NODE${T.nodes > 1 ? 'S' : ''} · ${T.online} ONLINE · ${labDur(T.uptime_s).toUpperCase()} UP</small></div>
    <div class="lab-rk-frame">${units}</div>
    <div class="lab-rk-tot">${tot(T.cores, 'Threads')}${tot(labGB(T.ram_total), 'Memory')}${tot(labGB(T.storage_total), 'Storage')}
      ${tot(T.vram_gb ? T.vram_gb + ' GB' : T.gpus.length, T.vram_gb ? 'VRAM' : 'GPUs')}${tot(T.cpu_percent + '%', 'Lab load')}${tot(labPct(T.ram_used, T.ram_total) + '%', 'RAM used')}</div>
    <div class="lab-rk-run">${run.map(i => `<div class="${i.k}"><i>●</i> ${escapeHtml(i.t)} <em>${escapeHtml(i.n)}</em></div>`).join('')}</div>`;
}

// ── Style C: constellation (SVG, 900×1950 = iPhone portrait) ──
function labConstellation(L) {
  const T = L.totals, peers = L.nodes.slice(1, 9), hub = L.nodes[0];
  const cx = 450, cy = 950, a1 = L.prefs.accent, a2 = labShift(a1, -50);
  let seed = [...L.prefs.name].reduce((h, c) => h * 31 + c.charCodeAt(0) >>> 0, 7);
  const rnd = () => (seed = seed * 1103515245 + 12345 >>> 0) / 2 ** 32;
  const stars = Array.from({ length: 40 }, () => `<circle class="tw" cx="${(rnd() * 900).toFixed(0)}" cy="${(rnd() * 1950).toFixed(0)}" r="${(rnd() * 1.8 + .6).toFixed(1)}" style="animation-delay:${(rnd() * 3).toFixed(1)}s"/>`).join('');
  const ring = (r, pct, col) => `<circle class="rbg" r="${r}"/><circle class="ring" r="${r}" stroke="${col}" stroke-dasharray="${(2 * Math.PI * r * Math.min(pct, 100) / 100).toFixed(0)} 999"/>`;
  const sats = peers.map((n, i) => {
    const ang = -Math.PI / 2 + i * 2 * Math.PI / peers.length;  // first peer straight above the hub
    const x = cx + 300 * Math.cos(ang), y = cy + 500 * Math.sin(ang);
    const spec = n.error ? 'offline' : `${n.cores}t · ${labGB(n.ram_total)} · ${Math.round(n.cpu_percent)}%`;
    return `<line class="lnk${n.error ? ' off' : ''}" x1="${cx}" y1="${cy}" x2="${x.toFixed(0)}" y2="${y.toFixed(0)}"/>
      <g transform="translate(${x.toFixed(0)} ${y.toFixed(0)})"${n.error ? ' opacity=".4"' : ''}>${n.error ? '<circle class="rbg" r="34"/>' : ring(34, n.cpu_percent, a2)}<circle r="10" fill="${n.error ? '#56627f' : a2}"/>
        <text y="84" text-anchor="middle" class="nm">${escapeHtml(n.name)}</text><text y="116" text-anchor="middle" class="sp">${escapeHtml(spec)}</text></g>`;
  }).join('');
  const run = labRunning(L.nodes).map(i => i.t), lines = [];
  for (const r of run) { const l = lines[lines.length - 1]; if (l && (l + ' · ' + r).length < 44) lines[lines.length - 1] = l + ' · ' + r; else if (lines.length < 4) lines.push(r); }
  return `<svg viewBox="0 0 900 1950" preserveAspectRatio="xMidYMid slice">
    <defs><radialGradient id="lab-glow"><stop offset="0" stop-color="${a1}" stop-opacity=".5"/><stop offset="1" stop-color="${a1}" stop-opacity="0"/></radialGradient></defs>
    <g fill="#fff">${stars}</g>
    <ellipse class="orb" cx="${cx}" cy="${cy}" rx="300" ry="500"/><ellipse class="orb" cx="${cx}" cy="${cy}" rx="180" ry="300" opacity=".5"/>
    ${sats}
    <circle cx="${cx}" cy="${cy}" r="190" fill="url(#lab-glow)"/>
    <circle cx="${cx}" cy="${cy}" r="70" fill="#0b1124" stroke="${a1}" stroke-width="3"/>
    <g transform="translate(${cx} ${cy})">${ring(86, hub.cpu_percent, a1)}</g>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="big" style="font-size:44px">${Math.round(hub.cpu_percent)}%</text>
    <text x="${cx}" y="${cy + 140}" text-anchor="middle" class="nm">${escapeHtml(hub.name)}</text>
    <text x="${cx}" y="${cy + 172}" text-anchor="middle" class="sp">hub · ${hub.cores}t · ${labGB(hub.ram_total)}</text>
    <text x="60" y="150" class="big">${escapeHtml(L.prefs.name.toUpperCase())}</text>
    <text x="62" y="200" class="cap">${T.nodes} NODE${T.nodes > 1 ? 'S' : ''} · ${T.online} ONLINE · ${labDur(T.uptime_s).toUpperCase()} UP</text>
    <text x="62" y="262" class="nm">${T.cores} threads · ${labGB(T.ram_total)}</text>
    <text x="62" y="300" class="sp">${labGB(T.storage_total)} storage${T.vram_gb ? ` · ${T.vram_gb} GB VRAM` : ''} · ${T.cpu_percent}% load</text>
    <text x="60" y="1700" class="cap">RUNNING</text>
    ${lines.map((l, i) => `<text x="60" y="${1748 + i * 40}" class="sp">${escapeHtml(l)}</text>`).join('')}
  </svg>`;
}

const LAB_STYLES = { neofetch: labNeofetch, rack: labRack, constellation: labConstellation };
let LAB = null;

function labRender() {
  const card = document.getElementById('lab-card');
  if (!card || !LAB) return;
  const style = LAB.prefs.style;
  card.className = `lab-card lab-${style}`;
  card.style.setProperty('--a1', LAB.prefs.accent);
  card.style.setProperty('--a2', labShift(LAB.prefs.accent, -50));
  card.innerHTML = LAB_STYLES[style](LAB);
  document.querySelectorAll('.lab-style-btn').forEach(b => b.classList.toggle('active', b.dataset.style === style));
}

async function labRefresh() {
  const r = await fetch('/api/lab/overview');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  LAB = await r.json();
  labRender();
  labRenderDevices();
}

async function loadSystem() {
  const host = document.getElementById('system-content');
  if (!document.getElementById('lab-card')) {
    host.innerHTML = `
      <div class="lab-toolbar">
        <div class="lab-seg" role="group" aria-label="Card style">
          <button class="lab-style-btn" data-style="neofetch" onclick="labSetPref({style:this.dataset.style})">Neofetch</button>
          <button class="lab-style-btn" data-style="rack" onclick="labSetPref({style:this.dataset.style})">Rack</button>
          <button class="lab-style-btn" data-style="constellation" onclick="labSetPref({style:this.dataset.style})">Constellation</button>
        </div>
        <button class="lab-btn primary" onclick="labShare(true)">Screenshot mode</button>
      </div>
      <div class="lab-card-wrap" onclick="labShare(false)"><div id="lab-card" class="lab-card"><p class="lab-loading">Gathering your lab…</p></div></div>
      <details class="lab-panel" id="lab-customize">
        <summary>Customize</summary>
        <label for="lab-name">Lab name</label><input id="lab-name" maxlength="24">
        <label for="lab-accent">Accent colour</label><input id="lab-accent" type="color">
        <label for="lab-services">Services to show (systemd names, space separated)</label><input id="lab-services" placeholder="jellyfin nginx k3s">
        <button class="lab-btn primary" onclick="labSaveCustomize()">Save</button>
      </details>
      <details class="lab-panel" id="lab-devices" open>
        <summary>Devices</summary>
        <div id="lab-device-list"></div>
        <button class="lab-btn primary" onclick="labDiscover()">Find devices on my Wi-Fi</button>
        <div id="lab-found"></div>
        <p class="lab-msg" id="lab-msg" role="status"></p>
        <label class="lab-switch"><input type="checkbox" id="lab-shareable" onchange="labSetShareable(this.checked)">
          <span>Let other devices add this computer</span></label>
        <p class="lab-dim">Turn this on here to add this computer to another DeCloud's lab. When it asks, you'll tap Allow on this screen.</p>
        <details class="lab-sub">
          <summary>Computer without DeCloud (Pi, NAS, server)</summary>
          <p class="lab-dim">Run this on that computer. It installs a tiny program that only reports stats, then waits for you to tap Find devices here.</p>
          <pre class="lab-cmd" id="lab-agent-cmd"></pre>
          <button class="lab-btn" onclick="labCopy(document.getElementById('lab-agent-cmd').textContent)">Copy commands</button>
        </details>
        <details class="lab-sub">
          <summary>Not on the same Wi-Fi? Use a code</summary>
          <label for="lab-code">Paste a code from the other device</label>
          <div class="lab-row"><input id="lab-code" placeholder="dcl1.…" autocomplete="off"><button class="lab-btn" onclick="labAddDevice()">Add</button></div>
          <div class="lab-row"><button class="lab-btn" onclick="labShowCode()">Show this computer's code</button>
            <button class="lab-btn" onclick="labResetKey()">Reset key</button></div>
          <pre class="lab-cmd" id="lab-own-code" hidden></pre>
          <p class="lab-dim">Treat a code like a password. Reset key disconnects every hub that added this computer.</p>
        </details>
      </details>`;
    document.getElementById('lab-agent-cmd').textContent =
      `sudo apt install -y python3-psutil\ncurl -fsSL ${location.origin}/lab-agent.py -o decloud-agent.py\npython3 decloud-agent.py --install-service`;
  }
  try { await labRefresh(); } catch {
    document.getElementById('lab-card').innerHTML = '<p class="lab-loading">Couldn\'t read this machine\'s stats. Is DeCloud still running?</p>';
  }
  const p = LAB?.prefs;
  if (p) { document.getElementById('lab-shareable').checked = p.shareable; document.getElementById('lab-name').value = p.name; document.getElementById('lab-accent').value = p.accent; document.getElementById('lab-services').value = p.services.join(' '); }
  if (!loadSystem._t) loadSystem._t = setInterval(() => {
    if (!document.getElementById('system-screen')?.classList.contains('active')) { clearInterval(loadSystem._t); loadSystem._t = null; return; }
    labRefresh().catch(() => {});
  }, 6000);
}

function labRenderDevices() {
  const el = document.getElementById('lab-device-list');
  if (!el || !LAB) return;
  const peers = LAB.nodes.slice(1);
  el.innerHTML = peers.length ? peers.map(n => `
    <div class="lab-dev"><span class="lab-dot ${n.error ? 'off' : ''}"></span><div><b>${escapeHtml(n.name)}</b><span>${escapeHtml(n.error || `${labOs(n.os)} · ${n.kind === 'agent' ? 'agent' : 'DeCloud'}`)}</span></div>
      <button class="lab-btn" data-id="${escapeHtml(n.id)}" data-name="${escapeHtml(n.name)}" onclick="labRemove(this.dataset.id, this.dataset.name)">Remove</button></div>`).join('')
    : '<p class="lab-dim">Only this machine so far. Add another device to see your whole lab on one card.</p>';
}

async function labSetPref(data) {
  if (LAB) { Object.assign(LAB.prefs, data); labRender(); }
  await fetch('/api/lab/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function labSaveCustomize() {
  labSetPref({ name: document.getElementById('lab-name').value, accent: document.getElementById('lab-accent').value,
               services: document.getElementById('lab-services').value }).then(() => labRefresh());
  document.getElementById('lab-customize').open = false;
}

async function labAddDevice() {
  const msg = document.getElementById('lab-msg'), input = document.getElementById('lab-code');
  msg.textContent = 'Connecting…';
  const r = await fetch('/api/lab/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: input.value }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { msg.textContent = d.error || 'Could not add that device.'; return; }
  msg.textContent = `Added ${d.name}.`;
  input.value = '';
  labRefresh();
}

async function labDiscover() {
  const box = document.getElementById('lab-found'), msg = document.getElementById('lab-msg');
  msg.textContent = 'Looking for devices on your Wi-Fi…';
  box.innerHTML = '';
  const found = await (await fetch('/api/lab/discover', { method: 'POST' })).json().catch(() => []);
  msg.textContent = found.length ? '' : 'Nothing found. On the other computer, turn on "Let other devices add this computer" (or run the small program for computers without DeCloud), then try again.';
  box.innerHTML = found.map(f => `
    <div class="lab-dev"><span class="lab-dot"></span><div><b>${escapeHtml(f.name)}</b><span>${f.kind === 'agent' ? 'Stats program' : 'DeCloud'} · ${escapeHtml(f.ip)}</span></div>
      ${f.added ? '<span class="lab-dim">Added</span>' : `<button class="lab-btn primary" data-ip="${escapeHtml(f.ip)}" data-port="${Number(f.port)}" onclick="labPair(this.dataset.ip, +this.dataset.port)">Add</button>`}</div>`).join('');
}

async function labPair(ip, port) {
  const msg = document.getElementById('lab-msg');
  msg.textContent = 'Contacting device…';
  const r = await fetch('/api/lab/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, port }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { msg.textContent = d.error || 'Could not reach that device.'; return; }
  const num = `${d.number.slice(0, 3)} ${d.number.slice(3)}`;
  document.getElementById('lab-found').innerHTML = `<div class="lab-pairing"><div class="lab-num">${escapeHtml(num)}</div>
    <p>${d.kind === 'agent' ? `In the terminal on <b>${escapeHtml(d.name)}</b>, type <b>y</b> if it shows this number.`
      : `On <b>${escapeHtml(d.name)}</b>, open DeCloud → Lab and tap <b>Allow</b> if it shows this number.`}</p>
    <p class="lab-dim">If the numbers don't match, deny it. Someone may be pretending to be your device.</p></div>`;
  msg.textContent = 'Waiting for you to approve on the other device…';
  for (let i = 0; i < 80; i++) {
    await new Promise(res => setTimeout(res, 2000));
    const j = await (await fetch('/api/lab/pair/' + d.job)).json().catch(() => ({ state: 'failed' }));
    if (j.state === 'waiting') continue;
    document.getElementById('lab-found').innerHTML = '';
    msg.textContent = j.state === 'done' ? `Added ${d.name}. It's on your card now.` : (j.error || 'Pairing failed.');
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
      <p class="lab-dim">Only allow if ${escapeHtml(q.hub)} shows the same number. It will see this computer's stats, nothing else.</p>
      <div class="lab-row"><button class="lab-btn primary" data-id="${escapeHtml(q.id)}" onclick="labAnswer(this.dataset.id, true)">Allow</button>
        <button class="lab-btn" data-id="${escapeHtml(q.id)}" onclick="labAnswer(this.dataset.id, false)">Deny</button></div></div>`).join('');
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
  document.getElementById('lab-msg').textContent = d.error || (on ? 'Other devices on your Wi-Fi can now find this computer. Nothing is shared until you tap Allow.' : 'This computer is hidden from other devices.');
}

async function labRemove(id, name) {
  if (!await appConfirm(`Remove ${name} from your lab?`, { danger: true, ok: 'Remove' })) return;
  try {
    const r = await fetch('/api/lab/devices/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Something went wrong — try again');
  } catch (e) { showToast(friendlyError(e)); }
  labRefresh();
}

async function labShowCode() {
  const el = document.getElementById('lab-own-code');
  const r = await fetch('/api/lab/pair-code');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { document.getElementById('lab-msg').textContent = d.error || 'Could not make a code.'; return; }
  el.textContent = d.code;
  el.hidden = false;
  labCopy(d.code);
}

async function labResetKey() {
  if (!await appConfirm('Disconnect every hub that added this computer?', { danger: true, ok: 'Disconnect' })) return;
  const r = await fetch('/api/lab/reset-key', { method: 'POST' }).catch(() => null);
  if (!r || !r.ok) { showToast("Couldn't reset — try again"); return; }
  document.getElementById('lab-own-code').hidden = true;
  document.getElementById('lab-msg').textContent = 'Key reset. Hubs that had this computer must add it again.';
}

function labCopy(text) {
  navigator.clipboard?.writeText(text).then(() => { document.getElementById('lab-msg').textContent = 'Copied.'; }).catch(() => {});
}

function labShare(on) {
  const s = document.getElementById('system-screen');
  if (on === s.classList.contains('lab-share')) return;
  s.classList.toggle('lab-share', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
