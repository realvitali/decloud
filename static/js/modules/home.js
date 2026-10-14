// ===== Module: home =====

function agentAvatarStyle(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `background:linear-gradient(135deg,hsl(${h},60%,45%),hsl(${(h + 40) % 360},70%,60%))`;
}

async function loadAgents() {
  const listEl = document.getElementById('agents-list');
  if (!listEl) return;
  try {
    const r = await fetch('/api/agents');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const agents = data.agents || [];

    if (!agents.length) {
      listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🤖</div><h3>No agents found</h3><p>To manage agents, set the Hermes path in Settings → Voice.</p></div>';
      return;
    }

    listEl.innerHTML = agents.map(a => {
      const name = a.name || a.id || '?';
      const tag = a.platform && a.platform !== 'this machine' ? `<span class="agent-tag">${escapeHtml(a.platform)}</span>` : '';
      const platformLine = [a.profile && a.profile !== 'local' ? 'Hermes · ' + a.profile : '', a.model].filter(Boolean).map(escapeHtml).join(' · ') || 'this machine';
      const hasJobs = a.jobs && a.jobs.length;
      const note = a.profile === 'local' ? 'This workstation — always on' : 'No cron jobs configured';
      return `
      <div class="agent-card" role="button" tabindex="0" data-id="${escapeHtml(a.id)}" onclick="toggleAgentDetail(this.dataset.id)">
        <div class="agent-header">
          <div class="agent-avatar" style="${agentAvatarStyle(name)}">${escapeHtml(name.charAt(0).toUpperCase())}</div>
          <div class="agent-info">
            <div class="agent-name">${escapeHtml(name)} ${tag}</div>
            <div class="agent-platform">${platformLine}</div>
          </div>
          <div class="agent-status ${escapeHtml(a.status || 'unknown')}">●</div>
          <div class="agent-expand" id="expand-${escapeHtml(a.id)}">▼</div>
        </div>
        <div class="agent-detail" id="agent-${escapeHtml(a.id)}">
          ${hasJobs ? `<div class="agent-jobs" id="jobs-${escapeHtml(a.id)}"></div>` : `<div class="agent-note">${note}</div>`}
        </div>
      </div>`;
    }).join('');

    for (const a of agents) {
      if (a.jobs && a.jobs.length) {
        const jobsEl = document.getElementById(`jobs-${a.id}`);
        if (jobsEl) renderJobs(jobsEl, a.jobs, a.profile || 'default');
      }
    }

    for (const [id, open] of Object.entries(agentDetailsOpen)) {
      const detail = document.getElementById(`agent-${id}`);
      if (detail) detail.classList.toggle('open', open);
    }
  } catch(e) {
    console.error('loadAgents failed', e);
    listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🤖</div><h3>Agents not set up</h3><p>To manage agents, set the Hermes path in Settings → Voice.</p></div>';
  }
}

function renderJobs(container, jobs, profile) {
  container.innerHTML = jobs.map(j => {
    const dot = j.last_status === 'ok' ? 'ok' : j.last_status === 'error' ? 'error' : 'paused';
    const rowClass = j.last_status === 'error' ? 'error' : '';
    const last = j.last_run ? `Last: ${escapeHtml(relTime(j.last_run))}` : '';
    const next = j.next_run ? `Next: ${escapeHtml(relTime(j.next_run))}` : '';
    const err = j.last_error ? `<div class="job-error">${escapeHtml(j.last_error)}</div>` : '';
    return `
      <div class="job-row ${rowClass}">
        <div class="job-dot ${dot}"></div>
        <div class="job-info">
          <div class="job-name">${escapeHtml(j.name)}</div>
          <div class="job-schedule">${escapeHtml(j.schedule_display)}</div>
          ${last ? `<div class="job-last">${last}</div>` : ''}
          ${next ? `<div class="job-next">${next}</div>` : ''}
          ${err}
        </div>
        <label class="job-toggle" data-id="${escapeHtml(j.id)}" data-profile="${escapeHtml(profile)}" onclick="event.stopPropagation(); toggleJob(this.dataset.id, !this.previousElementSibling.checked, this.dataset.profile)">
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
    const r = await fetch(`/api/agents/jobs/${encodeURIComponent(jobId)}/${action}?profile=${encodeURIComponent(profile)}`, { method: 'POST' });
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
    if (!el) return;
    if (!d.events?.length) { el.innerHTML = '<span class="text-dim">No activity yet.</span>'; return; }
    el.innerHTML = d.events.map(ev => {
      const t = ev.ts ? relTime(ev.ts) : '';
      const label = ev.dir === 'in' ? 'IN' : 'OUT';
      return `
        <div class="activity-item ${ev.dir === 'in' ? 'in' : 'out'}">
          <span class="activity-dir ${ev.dir === 'in' ? 'in' : 'out'}">${label}</span>
          <span class="activity-time">${escapeHtml(t)}</span>
          <span class="activity-text">${escapeHtml(ev.text || '')}</span>
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
setInterval(() => { if (!document.hidden) updateClock(); }, 1000);
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
    return '<div class="stat-chip" role="button" tabindex="0" id="chip-' + c.key + '" data-key="' + c.key + '" onclick="toggleChipGraph(this.dataset.key)">' +
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
    // GPU chip only when the server reports one (NVIDIA)
    var gpuChip = document.getElementById('chip-gpu');
    if (gpuChip) gpuChip.style.display = d.gpu ? '' : 'none';
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
      '<div class="notif-item-text">' + escapeHtml(n.text) + '</div>' +
      '<div class="notif-item-time">' + escapeHtml(n.time) + '</div>' +
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
  document.getElementById('app-grid').innerHTML = visibleApps(APPS).map(app => `
    <div class="app-icon" role="button" tabindex="0" data-app-id="${app.id}" onclick="openApp(this.dataset.appId)">
      <div class="app-icon-visual" style="color:${app.color}">${app.svg}</div>
      <div class="app-label">${app.label}</div>
    </div>
  `).join('');
}

function applyExperimentalApps() {
  buildAppGrid();
}

function openApp(id) {
  const app = APPS.find(a => a.id === id) || AI_SUBAPPS.find(a => a.id === id);
  if (!app) return;
  // AI spread menu
  if (app.spread) {
    toggleAISpread(window.event);
    return;
  }
  if (!app.screen) return;
  if (typeof closeAISpread === 'function') closeAISpread();
  showScreen(app.screen);
  if (id !== 'files') location.hash = '#' + id;  // files sets its own #lego/<path>
  if (id === 'audiobooks') loadBooks();
  if (id === 'music') loadMusic();
  if (id === 'files') loadLego('');
  if (id === 'journal') switchJournalTab('journal-tab-voice');
  if (id === 'legos') initLegos3D();
  if (id === 'ollama') loadOllamaModels();
  if (id === 'comfy') { loadComfyStatus(); loadComfyModels(); loadComfyGallery(); }
  if (id === 'musicgen') loadMusicGen();
  if (id === 'system') loadSystem();
  if (id === 'projects') openProjectList();
  if (id === 'settings') loadSettings();
}

// ─── Screen Management ───────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  // Track app usage
  var appMap = { 'book-screen': 'books', 'music-screen': 'music', 'lego-screen': 'files', 'ollama-screen': 'ai-chat', 'comfy-screen': 'ai-gen', 'agents-screen': 'agents', 'project-screen': 'projects', 'system-screen': 'system', 'terminal-screen': 'terminal', 'osint-screen': 'privacy', 'musicgen-screen': 'musicgen', 'journal-screen': 'journal', 'legos-screen': 'legos', 'settings-screen': 'settings' };
  if (appMap[id] && typeof trackAppOpen === 'function') trackAppOpen(appMap[id]);  // hash restore runs before telemetry.js loads
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
    // Safari records mp4, not webm
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    vjRecorder = new MediaRecorder(vjStream, mime ? { mimeType: mime } : {});

    vjRecorder.ondataavailable = (e) => { if (e.data.size > 0) vjChunks.push(e.data); };
    vjRecorder.onstop = async () => {
      const type = vjRecorder.mimeType || mime || 'audio/webm';
      const blob = new Blob(vjChunks, { type });
      vjStream.getTracks().forEach(t => t.stop());
      vjStream = null;
      vjRecording = false;
      updateJournalRecordBtn(false);

      const fd = new FormData();
      fd.append('audio', blob, type.includes('mp4') ? 'journal.m4a' : 'journal.webm');
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
        if (statusEl) statusEl.textContent = friendlyError(e);
      }
    };

    vjRecorder.start();
    vjRecording = true;
    updateJournalRecordBtn(true);
  } catch (e) {
    if (vjStream) { vjStream.getTracks().forEach(t => t.stop()); vjStream = null; }
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') showToast("This browser can't record audio");
    else if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) showToast('Microphone access was blocked — allow it in your browser settings');
    else if (e && e.name === 'NotFoundError') showToast('No microphone found');
    else showToast("Couldn't start recording: " + friendlyError(e));
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

