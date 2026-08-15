// ===== Module: home =====

async function loadAgents() {
  try {
    const r = await fetch('/api/agents');
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }
    const data = await r.json();

    // Update status dots
    for (const a of data.agents || []) {
      const el = document.getElementById(`status-${a.id}`);
      if (el) {
        el.className = `agent-status ${a.status}`;
        el.textContent = '●';
      }
    }

    // Render jobs (generic — works with any agent config)
    if (data.default?.jobs) {
      const jobsEl = document.getElementById('jobs-default') || document.getElementById('jobs-nika');
      if (jobsEl) renderJobs(jobsEl, data.default.jobs, 'default');
    }

    // Restore open state
    for (const [id, open] of Object.entries(agentDetailsOpen)) {
      const detail = document.getElementById(`agent-${id}`);
      if (detail) detail.classList.toggle('open', open);
    }
  } catch(e) {
    console.error('loadAgents failed', e);
    // Show empty state instead of hanging
    const container = document.getElementById('jobs-default') || document.getElementById('jobs-nika');
    if (container) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">🤖</div><h3>Agents not configured</h3><p>Set DECLOUD_HERMES_HOME in .env to enable agent management.</p></div>';
    }
  }
}

function renderJobs(container, jobs, profile) {
  container.innerHTML = jobs.map(j => {
    const dot = j.last_status === 'ok' ? 'ok' : j.last_status === 'error' ? 'error' : 'paused';
    const rowClass = j.last_status === 'error' ? 'error' : '';
    const last = j.last_run ? `Last: ${relTime(j.last_run)}` : '';
    const next = j.next_run ? `Next: ${relTime(j.next_run)}` : '';
    const err = j.last_error ? `<div class="job-error">${j.last_error}</div>` : '';
    return `
      <div class="job-row ${rowClass}">
        <div class="job-dot ${dot}"></div>
        <div class="job-info">
          <div class="job-name">${j.name}</div>
          <div class="job-schedule">${j.schedule_display}</div>
          ${last ? `<div class="job-last">${last}</div>` : ''}
          ${next ? `<div class="job-next">${next}</div>` : ''}
          ${err}
        </div>
        <label class="job-toggle" onclick="event.stopPropagation(); toggleJob('${j.id}', !this.previousElementSibling.checked, '${profile}')">
          <input type="checkbox" ${j.enabled ? 'checked' : ''}>
          <span class="job-toggle-slider"></span>
        </label>
      </div>
    `;
  }).join('');
}

async function toggleJob(jobId, enabled, profile) {
  const action = enabled ? 'resume' : 'pause';
  try {
    const r = await fetch(`/api/agents/jobs/${jobId}/${action}?profile=${profile}`, { method: 'POST' });
    const d = await r.json();
    if (!d.ok) {
      console.error('toggle failed:', d.error);
      loadAgents(); // revert on error
    }
  } catch(e) {
    console.error('toggleJob failed', e);
    loadAgents(); // revert on error
  }
}

async function loadActivity() {
  try {
    const r = await fetch('/api/agents/logs?n=15');
    const d = await r.json();
    const el = document.getElementById('activity-list');
    if (!el || !d.events?.length) return;
    el.innerHTML = d.events.map(ev => {
      const t = ev.ts ? relTime(ev.ts) : '';
      const label = ev.dir === 'in' ? 'IN' : 'OUT';
      return `
        <div class="activity-item ${ev.dir}">
          <span class="activity-dir ${ev.dir}">${label}</span>
          <span class="activity-time">${t}</span>
          <span class="activity-text">${ev.text || ''}</span>
        </div>
      `;
    }).join('');
  } catch(e) {
    const el = document.getElementById('activity-list');
    if (el) el.innerHTML = '<span class="text-dim">Could not load</span>';
  }
}

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h`;
  return `${Math.floor(diff/86400)}d`;
}

function toggleAgentDetail(id) {
  const detail = document.getElementById(`agent-${id}`);
  if (!detail) return;
  const isOpen = detail.classList.toggle('open');
  agentDetailsOpen[id] = isOpen;
  const arrow = document.getElementById(`expand-${id}`);
  if (arrow) arrow.textContent = isOpen ? '▲' : '▼';
}

function formatRelativeTime(iso) { return relTime(iso); }

// ─── Clock ──────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
}
setInterval(updateClock, 1000);
updateClock();

// ─── Status Chips (Kali-style) + Sparklines ────────────────
const STAT_HISTORY = { cpu: [], ram: [], gpu: [], disk: [] };
const CHIP_GRAPH_MODE = { cpu: false, ram: false, gpu: false, disk: false };
const MAX_HISTORY = 30;

function pushHistory(key, val) {
  const arr = STAT_HISTORY[key];
  arr.push(val);
  if (arr.length > MAX_HISTORY) arr.shift();
}

function buildSparkline(data, w, h, color, label, currentVal) {
  if (!data || data.length < 2) return '<div class="chip-graph-empty">--</div>';
  var max = 100;
  var min = 0;
  var range = max - min || 1;
  var step = w / (data.length - 1);
  var pts = data.map(function(v, i) { return (i * step).toFixed(1) + ',' + (h - ((v - min) / range) * h).toFixed(1); });
  var ptsStr = pts.join(' ');
  var fillPts = '0,' + h + ' ' + ptsStr + ' ' + w + ',' + h;
  var hl = getComputedStyle(document.documentElement).getPropertyValue('--hairline').trim() || 'rgba(0,0,0,0.06)';
  var dimText = getComputedStyle(document.documentElement).getPropertyValue('--text-faint').trim() || '#999';

  // Build gridlines (25%, 50%, 75%)
  var grid = '';
  [0.25, 0.5, 0.75].forEach(function(pct) {
    var y = (h * pct).toFixed(1);
    grid += '<line x1="0" y1="' + y + '" x2="' + w + '" y2="' + y + '" stroke="' + hl + '" stroke-width="0.5" stroke-dasharray="2,3"/>';
  });

  // Build labels
  var labelHtml = '<div class="chip-graph-labels">' +
    '<span class="chip-graph-name">' + label + '</span>' +
    '<span class="chip-graph-val">' + currentVal + '%</span>' +
    '</div>';

  // Time axis hint
  var axisHtml = '<div class="chip-graph-axis">last 60s</div>';

  return '<div class="chip-graph-wrap">' +
    labelHtml +
    '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    grid +
    '<polyline points="' + fillPts + '" fill="' + color + '" opacity="0.12" stroke="none"/>' +
    '<polyline points="' + ptsStr + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>' +
    axisHtml +
    '</div>';
}

function buildStatusChips() {
  const container = document.getElementById('status-chips');
  if (!container) return;
  const chips = [
    { key: 'cpu',  label: 'CPU' },
    { key: 'ram',  label: 'RAM' },
    { key: 'gpu',  label: 'GPU' },
    { key: 'disk', label: 'DISK' },
    { key: 'net',  label: 'NET' },
  ];
  container.innerHTML = chips.map(function(c) {
    return '<div class="stat-chip" id="chip-' + c.key + '" onclick="toggleChipGraph(\'' + c.key + '\')">' +
      '<div class="chip-percent">' +
      '<div class="stat-chip-label">' + c.label + '</div>' +
      '<div class="stat-chip-value" id="chip-val-' + c.key + '">--</div>' +
      '</div>' +
      '<div class="chip-sparkline" id="chip-graph-' + c.key + '"></div>' +
      '</div>';
  }).join('');
}

function toggleChipGraph(key) {
  if (key === 'net') return;
  CHIP_GRAPH_MODE[key] = !CHIP_GRAPH_MODE[key];
  var chip = document.getElementById('chip-' + key);
  if (!chip) return;
  chip.classList.toggle('graph-mode', CHIP_GRAPH_MODE[key]);
  if (CHIP_GRAPH_MODE[key]) updateChipGraph(key);
}

function updateChipGraph(key) {
  var el = document.getElementById('chip-graph-' + key);
  if (!el) return;
  var data = STAT_HISTORY[key];
  if (!data || data.length < 2) return;
  var stroke = getComputedStyle(document.documentElement).getPropertyValue('--sparkline-stroke').trim();
  var labels = { cpu: 'CPU', ram: 'RAM', gpu: 'GPU', disk: 'Disk' };
  var currentVal = data[data.length - 1];
  el.innerHTML = buildSparkline(data, 72, 32, stroke, labels[key] || key, currentVal);
}

async function loadQuickStats() {
  try {
    const r = await fetch('/api/system');
    const d = await r.json();
    const cpu = Math.round(d.cpu_percent || 0);
    const ram = Math.round(d.ram_percent || 0);
    const gpuPct = d.gpu ? Math.round(d.gpu.gpu_percent || 0) : 0;
    const disk = Math.round(d.disk_percent || 0);

    pushHistory('cpu', cpu);
    pushHistory('ram', ram);
    pushHistory('gpu', gpuPct);
    pushHistory('disk', disk);

    setChipValue('cpu', cpu);
    setChipValue('ram', ram);
    setChipValue('gpu', gpuPct);
    setChipValue('disk', disk);

    var netEl = document.getElementById('chip-val-net');
    if (netEl) {
      // Fetch real network stats
      fetch('/api/network/stats').then(r => r.json()).then(n => {
        var down = n.download_speed || n.download || 0;
        var up = n.upload_speed || n.upload || 0;
        var downStr = down >= 1048576 ? (down/1048576).toFixed(1) + ' MB/s' : (down/1024).toFixed(0) + ' KB/s';
        var upStr = up >= 1048576 ? (up/1048576).toFixed(1) + ' MB/s' : (up/1024).toFixed(0) + ' KB/s';
        netEl.innerHTML = '<span style="font-size:9px;line-height:1.3;display:flex;flex-direction:column;align-items:center"><span>' + downStr + '</span><span style="opacity:0.5">' + upStr + '</span></span>';
      }).catch(function() {
        if (netEl) netEl.innerHTML = '<span style="font-size:11px">--</span>';
      });
    }

    ['cpu','ram','gpu','disk'].forEach(function(key) {
      if (CHIP_GRAPH_MODE[key]) updateChipGraph(key);
    });
  } catch {}
}

function setChipValue(key, val) {
  var el = document.getElementById('chip-val-' + key);
  if (!el) return;
  el.textContent = val + '%';
  var chip = document.getElementById('chip-' + key);
  if (!chip) return;
  chip.classList.remove('warn', 'danger');
  if (val >= 90) chip.classList.add('danger');
  else if (val >= 75) chip.classList.add('warn');
}

// ─── Notifications ─────────────────────────────────────────
// Built from real system state — no fake entries.
var notifications = [];
var notifRead = false;

function buildNotifications(sys) {
  notifications = [];
  if (!sys || sys.error) return notifications;
  if (sys.ram_percent >= 85) {
    notifications.push({ text: 'RAM at ' + Math.round(sys.ram_percent) + '% — getting tight', type: 'warning', icon: 'server', time: 'now' });
  }
  if (sys.disk_percent >= 90) {
    notifications.push({ text: 'Disk at ' + Math.round(sys.disk_percent) + '% — consider cleaning up', type: 'warning', icon: 'alert', time: 'now' });
  }
  return notifications;
}

function refreshNotifications() {
  fetch('/api/system').then(function(r) { return r.json(); }).then(function(sys) {
    buildNotifications(sys);
    notifRead = false;
    updateNotifBadge();
    var panel = document.getElementById('notif-panel');
    if (panel && panel.classList.contains('open')) renderNotifications();
  }).catch(function() {});
}

function updateNotifBadge() {
  var badge = document.getElementById('notif-badge');
  if (!badge) return;
  badge.classList.toggle('visible', !notifRead && notifications.length > 0);
}

function toggleNotifications() {
  var panel = document.getElementById('notif-panel');
  if (!panel) return;
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderNotifications();
}

function renderNotifications() {
  var list = document.getElementById('notif-list');
  if (!list) return;
  if (notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }
  list.innerHTML = notifications.map(function(n) {
    var iconSvg = ICONS[n.icon] || ICONS.alert;
    return '<div class="notif-item">' +
      '<div class="notif-item-icon ' + n.type + '">' + iconSvg + '</div>' +
      '<div class="notif-item-body">' +
      '<div class="notif-item-text">' + n.text + '</div>' +
      '<div class="notif-item-time">' + n.time + '</div>' +
      '</div></div>';
  }).join('');
}

function clearNotifications() {
  notifRead = true;
  updateNotifBadge();
  var panel = document.getElementById('notif-panel');
  if (panel) panel.classList.remove('open');
}

document.addEventListener('click', function(e) {
  var panel = document.getElementById('notif-panel');
  var bell = document.getElementById('notif-bell');
  if (panel && bell && panel.classList.contains('open') && !panel.contains(e.target) && !bell.contains(e.target)) {
    panel.classList.remove('open');
  }
});

// ─── App Grid ────────────────────────────────────────────
function buildAppGrid() {
  document.getElementById('app-grid').innerHTML = APPS.map(app => `
    <div class="app-icon" data-app-id="${app.id}" onclick="openApp('${app.id}')">
      <div class="app-icon-visual" style="color:${app.color}">${app.svg}</div>
      <div class="app-label">${app.label}</div>
    </div>
  `).join('');
}

function openApp(id) {
  const app = APPS.find(a => a.id === id);
  if (!app) return;
  // AI spread menu
  if (app.spread) {
    toggleAISpread(event);
    return;
  }
  if (!app.screen) return;
  closeAISpread();
  showScreen(app.screen);
  if (id === 'audiobooks') { location.hash = '#audiobooks'; loadBooks(); }
  if (id === 'music') { location.hash = '#music'; loadMusic(); }
  if (id === 'files') { loadLego(''); }
  if (id === 'journal') { location.hash = '#journal'; switchJournalTab('journal-tab-voice'); }
  if (id === 'legos') { location.hash = '#legos'; initLegos3D(); }
  if (id === 'ollama') { location.hash = '#ollama'; loadOllamaModels(); }
  if (id === 'comfy') { location.hash = '#comfy'; loadComfyStatus(); loadComfyModels(); loadComfyGallery(); }
  if (id === 'system') { location.hash = '#system'; loadSystem(); }
  if (id === 'agents') { location.hash = '#agents'; }
  if (id === 'projects') { location.hash = '#projects'; openProjectList(); }
  if (id === 'settings') { location.hash = '#settings'; loadSettings(); }
}

// ─── AI Spread Menu ──────────────────────────────────────
let aiSpreadOpen = false;

function toggleAISpread(e) {
  if (e) e.stopPropagation();
  if (aiSpreadOpen) {
    closeAISpread();
  } else {
    openAISpread();
  }
}

function openAISpread() {
  aiSpreadOpen = true;
  const btn = document.querySelector('[data-app-id="ai"]');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  let overlay = document.getElementById('ai-spread-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'ai-spread-overlay';
    overlay.className = 'ai-spread-overlay';
    document.body.appendChild(overlay);
  }
  overlay.onclick = closeAISpread;

  const itemSize = 72;
  const margin = 16;
  const subapps = AI_SUBAPPS;
  const n = subapps.length;

  // Fan direction: away from screen center
  const screenCx = window.innerWidth / 2;
  const screenCy = window.innerHeight / 2;
  let fanAngle = Math.atan2(screenCy - cy, screenCx - cx);
  // Normalize to 0..2PI
  if (fanAngle < 0) fanAngle += 2 * Math.PI;

  // Arc spread: ~25deg per item after the first, capped at 140deg
  const arcDeg = Math.min(140, 30 + (n - 1) * 25);
  const halfArc = (arcDeg / 2) * Math.PI / 180;

  // Radius: measure available space in the fan direction
  // Cast a ray in the fan direction and see how far we can go
  let r = 130;
  // Simple: check space toward the nearest edge in the fan direction
  const cosF = Math.cos(fanAngle), sinF = Math.sin(fanAngle);
  // How far can we travel from button center before hitting an edge?
  let maxR = Infinity;
  if (cosF > 0.01) maxR = Math.min(maxR, (window.innerWidth - margin - cx) / cosF);
  if (cosF < -0.01) maxR = Math.min(maxR, (cx - margin) / -cosF);
  if (sinF > 0.01) maxR = Math.min(maxR, (window.innerHeight - margin - cy) / sinF);
  if (sinF < -0.01) maxR = Math.min(maxR, (cy - margin) / -sinF);
  // Account for item size and the arc width (edge items spread out)
  maxR -= itemSize;
  // Also need room for items at the arc edges
  const cosEdge = Math.cos(fanAngle + halfArc), sinEdge = Math.sin(fanAngle + halfArc);
  let maxREdge = Infinity;
  if (cosEdge > 0.01) maxREdge = Math.min(maxREdge, (window.innerWidth - margin - cx - itemSize/2) / cosEdge);
  if (cosEdge < -0.01) maxREdge = Math.min(maxREdge, (cx - margin + itemSize/2) / -cosEdge);
  if (sinEdge > 0.01) maxREdge = Math.min(maxREdge, (window.innerHeight - margin - cy - itemSize/2) / sinEdge);
  if (sinEdge < -0.01) maxREdge = Math.min(maxREdge, (cy - margin + itemSize/2) / -sinEdge);
  r = Math.max(70, Math.min(r, maxR, maxREdge - itemSize));

  overlay.innerHTML = subapps.map((sub, i) => {
    // Distribute items evenly across the arc
    const frac = n === 1 ? 0.5 : i / (n - 1);
    const angle = fanAngle - halfArc + frac * (halfArc * 2);
    const dx = Math.cos(angle) * r;
    const dy = Math.sin(angle) * r;
    const x = cx + dx - itemSize / 2;
    const y = cy + dy - itemSize / 2;
    return '<div class="ai-spread-item" style="left:' + (cx - itemSize/2) + 'px;top:' + (cy - itemSize/2) + 'px;--tx:' + dx + 'px;--ty:' + dy + 'px;--delay:' + (i * 0.07) + 's" onclick="event.stopPropagation(); openAISubApp(\'' + sub.id + '\',\'' + sub.screen + '\')">' +
      '<div class="ai-spread-item-visual" style="color:' + sub.color + '">' + sub.svg + '</div>' +
      '<div class="ai-spread-item-label">' + sub.label + '</div>' +
    '</div>';
  }).join('');

  requestAnimationFrame(() => {
    overlay.classList.add('active');
    overlay.querySelectorAll('.ai-spread-item').forEach(el => el.classList.add('show'));
  });

  btn.classList.add('ai-spread-active');
}

function closeAISpread() {
  aiSpreadOpen = false;
  const overlay = document.getElementById('ai-spread-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    overlay.querySelectorAll('.ai-spread-item').forEach(el => el.classList.remove('show'));
    setTimeout(() => { if (overlay) overlay.innerHTML = ''; }, 400);
  }
  const btn = document.querySelector('[data-app-id="ai"]');
  if (btn) btn.classList.remove('ai-spread-active');
}

function openAISubApp(id, screen) {
  closeAISpread();
  setTimeout(() => {
    showScreen(screen);
    if (id === 'ollama') { location.hash = '#ollama'; loadOllamaModels(); }
    if (id === 'comfy') { location.hash = '#comfy'; loadComfyStatus(); loadComfyModels(); loadComfyGallery(); }
    if (id === 'agents') { location.hash = '#agents'; }
  }, 50);
}

// ─── Screen Management ───────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  // Track app usage
  var appMap = { 'book-screen': 'books', 'music-screen': 'music', 'lego-screen': 'files', 'ollama-screen': 'ai-chat', 'comfy-screen': 'ai-gen', 'agents-screen': 'agents', 'project-screen': 'projects', 'system-screen': 'system', 'terminal-screen': 'terminal', 'osint-screen': 'privacy', 'universe-screen': 'universe', 'journal-screen': 'journal', 'legos-screen': 'legos', 'settings-screen': 'settings' };
  if (appMap[id]) trackAppOpen(appMap[id]);
  // Voice orb only shows on home screen
  const orb = document.getElementById('voice-orb');
  if (orb) {
    if (id === 'home-screen' && !voiceOpen) {
      orb.style.display = '';
    } else {
      orb.style.display = 'none';
    }
  }
  // Load OSINT profiles when opening that screen
  if (id === 'osint-screen') loadOsintProfiles();
  if (id === 'journal-screen') loadUniverse();
  if (id === 'legos-screen') initLegos3D();
  // Initialize xterm when opening terminal screen
  if (id === 'terminal-screen') {
    setTimeout(() => {
      if (!xterm) initXterm();
      if (xtermFit) { xtermFit.fit(); sendResize(); }
      if (xterm) xterm.focus();
    }, 100);
  }
}
function goHome() { location.hash = ''; showScreen('home-screen'); }

// Force refresh: unregister SW, clear all caches, reload
async function forceRefresh() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) { await reg.unregister(); }
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      for (const key of keys) { await caches.delete(key); }
    }
  } catch (e) { console.error('Refresh error:', e); }
  location.reload(true);
}

// ─── Voice Journal ───────────────────────────────────────

let vjRecorder = null;
let vjChunks = [];
let vjStream = null;
let vjRecording = false;

async function startVoiceJournal() {
  if (vjRecording) {
    stopVoiceJournal();
    return;
  }
  try {
    vjStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    vjChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    vjRecorder = new MediaRecorder(vjStream, { mimeType: mime });

    vjRecorder.ondataavailable = (e) => { if (e.data.size > 0) vjChunks.push(e.data); };
    vjRecorder.onstop = async () => {
      const blob = new Blob(vjChunks, { type: mime });
      vjStream.getTracks().forEach(t => t.stop());
      vjStream = null;
      vjRecording = false;
      updateJournalRecordBtn(false);

      const fd = new FormData();
      fd.append('audio', blob, 'journal.webm');
      const statusEl = document.getElementById('journal-voice-status');
      if (statusEl) statusEl.textContent = 'Transcribing...';

      try {
        const r = await fetch('/api/journal/voice', { method: 'POST', body: fd });
        const data = await r.json();
        if (data.ok) {
          if (statusEl) statusEl.textContent = 'Saved to ' + data.date + ': "' + (data.text || '').substring(0, 80) + '..."';
          showToast('Journal entry saved');
        } else {
          if (statusEl) statusEl.textContent = 'Error: ' + (data.error || 'failed');
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Error: ' + e.message;
      }
    };

    vjRecorder.start();
    vjRecording = true;
    updateJournalRecordBtn(true);
  } catch (e) {
    showToast('Mic access denied');
  }
}

function stopVoiceJournal() {
  if (vjRecorder && vjRecorder.state === 'recording') {
    vjRecorder.stop();
  }
}

function updateJournalRecordBtn(recording) {
  const btn = document.getElementById('journal-record-btn');
  const label = document.getElementById('journal-record-label');
  if (!btn) return;
  if (recording) {
    btn.classList.add('recording');
    if (label) label.textContent = 'Stop';
  } else {
    btn.classList.remove('recording');
    if (label) label.textContent = 'Tap to record';
  }
}

function showToast(msg) {
  let t = document.getElementById('vj-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'vj-toast';
    t.className = 'vj-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

