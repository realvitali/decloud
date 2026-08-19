// ===== Module: lego3d =====
let longPressFired = false;

function saveLegoFile(path) {
  // Use a hidden iframe to trigger download (more reliable on iOS than anchor click)
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = `/api/lego/download?path=${encodeURIComponent(path)}`;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 3000);
}

// Context menu = long-press on iOS Safari
document.addEventListener('contextmenu', e => {
  // On thumbnail with save path
  const thumb = e.target.closest('.lego-thumb[data-save-path]');
  if (thumb) {
    e.preventDefault();
    saveLegoFile(thumb.dataset.savePath);
    if (navigator.vibrate) navigator.vibrate(50);
    return;
  }
  // On full image viewer
  const viewer = document.getElementById('lego-image-viewer');
  if (viewer && viewer.style.display !== 'none' && legoCurrentImage) {
    e.preventDefault();
    saveLegoFile(legoCurrentImage);
    if (navigator.vibrate) navigator.vibrate(50);
    return;
  }
});

// ─── Service Worker ──────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js?v=90').catch(() => {});
}

// ─── Init (wrapped in try-catch so one failure doesn't brick everything) ─
// Delayed slightly so auth.js can check authentication first.
// If login screen is showing, skip init until user authenticates.
function decloudInit() {
  // Don't init if login screen is visible (not yet authenticated)
  var loginScreen = document.getElementById('login-screen');
  if (loginScreen && loginScreen.style.display !== 'none' && loginScreen.style.display !== '') {
    // Login screen is showing — retry in 500ms
    setTimeout(decloudInit, 500);
    return;
  }
  buildStatusChips();
  buildAppGrid();
  buildProjectsSection();
  loadQuickStats();
  updateNotifBadge();
  refreshNotifications();
  loadAgents();
  loadActivity();
  refreshProjectCards();
  setInterval(loadQuickStats, 2000);
  setInterval(loadAgents, 60000);
  setInterval(loadActivity, 30000);
  setInterval(refreshProjectCards, 120000);
  setInterval(refreshNotifications, 60000);
}
try { decloudInit(); } catch(e) { console.error('DeCloud init error:', e); showCrashRecovery(e); }

// Restore screen from URL hash on load/refresh
function restoreFromHash() {
  const hash = location.hash.slice(1); // remove #
  if (hash.startsWith('lego/')) {
    const path = decodeURIComponent(hash.slice(5)); // remove 'lego/' and decode %20 etc
    showScreen('lego-screen');
    loadLego(path);
  } else if (hash.startsWith('project/')) {
    const pid = decodeURIComponent(hash.slice(8));
    openProject(pid);
  } else if (hash === 'audiobooks') {
    openApp('audiobooks');
  } else if (hash === 'system') {
    openApp('system');
  } else if (hash === 'agents') {
    openApp('agents');
  } else if (hash === 'projects') {
    openProjectList();
  }
  // default: stay on home screen
}
restoreFromHash();

// ─── VOICE SYSTEM ───────────────────────────────────────
