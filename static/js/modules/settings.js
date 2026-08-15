// ===== Module: settings =====
function switchSettingsTab(tabId) {
  document.querySelectorAll('.settings-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById(tabId)?.classList.add('active');
  var panelId = 'st-panel-' + tabId.replace('st-tab-', '');
  document.querySelectorAll('.settings-panel').forEach(function(p) { p.style.display = 'none'; p.classList.remove('active'); });
  var panel = document.getElementById(panelId);
  if (panel) { panel.style.display = ''; panel.classList.add('active'); }
  if (panelId === 'st-panel-network') loadSettingsDevices();
  if (panelId === 'st-panel-telemetry') loadSettingsUsage();
  if (panelId === 'st-panel-logs') loadSettingsLogs();
  if (panelId === 'st-panel-about') loadAbout();
  if (panelId === 'st-panel-paths') loadPaths();
}

function loadAbout() {
  fetch('/api/version').then(r => r.json()).then(data => {
    document.getElementById('about-version').textContent = 'v' + data.version;
    document.getElementById('about-updated').textContent = data.date;
    const cl = document.getElementById('about-changelog');
    cl.innerHTML = data.changelog.map(entry =>
      '<h4>v' + entry.version + ' — ' + entry.date + '</h4>' +
      '<ul>' + entry.changes.map(c => '<li>' + c + '</li>').join('') + '</ul>'
    ).join('');
  }).catch(() => {
    document.getElementById('about-version').textContent = '?';
    document.getElementById('about-changelog').innerHTML = '<p>Unable to load version info.</p>';
  });
}

function loadSettings() {
  // Load current theme
  fetch('/api/settings/theme').then(function(r) { return r.json(); }).then(function(d) {
    var theme = d.theme || 'auto';
    document.querySelectorAll('.theme-option').forEach(function(btn) {
      btn.classList.toggle('selected', btn.dataset.theme === theme);
    });
  }).catch(function() {});
  // Apply theme on load
  applyTheme();
}

function loadPaths() {
  fetch('/api/settings/paths').then(function(r) { return r.json(); }).then(function(d) {
    document.getElementById('path-books').value = d.books || '';
    document.getElementById('path-files').value = d.files || '';
    document.getElementById('path-music').value = d.music || '';
  }).catch(function() {});
}

function savePaths() {
  var books = document.getElementById('path-books').value.trim();
  var files = document.getElementById('path-files').value.trim();
  var music = document.getElementById('path-music').value.trim();
  var note = document.getElementById('paths-save-note') || document.getElementById('path-books');
  fetch('/api/settings/paths', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ books: books, files: files, music: music })
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(res) {
    var el = document.getElementById('paths-save-note');
    if (el) {
      if (res.ok) {
        el.textContent = '✓ Saved — restart DeCloud to apply';
        el.className = 'settings-note settings-note-ok';
      } else {
        el.textContent = '✗ ' + (res.d.error || 'Save failed');
        el.className = 'settings-note settings-note-err';
      }
    }
  }).catch(function() {
    var el = document.getElementById('paths-save-note');
    if (el) {
      el.textContent = '✗ Network error';
      el.className = 'settings-note settings-note-err';
    }
  });
}

function setTheme(theme) {
  document.querySelectorAll('.theme-option').forEach(function(btn) {
    btn.classList.toggle('selected', btn.dataset.theme === theme);
  });
  fetch('/api/settings/theme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: theme })
  }).then(function() { applyTheme(); });
}

function applyTheme() {
  fetch('/api/settings/theme').then(function(r) { return r.json(); }).then(function(d) {
    var theme = d.theme || 'auto';
    var isDark;
    if (theme === 'dark') isDark = true;
    else if (theme === 'light') isDark = false;
    else isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#0a0a0f' : '#ffffff');
  }).catch(function() {});
}

function loadSettingsDevices() {
  fetch('/api/devices').then(function(r) { return r.json(); }).then(function(devices) {
    var el = document.getElementById('settings-devices-list');
    if (!el) return;
    if (!devices || devices.length === 0) {
      el.innerHTML = '<div class="settings-empty">No devices found</div>';
      return;
    }
    el.innerHTML = devices.map(function(d) {
      return '<div class="settings-device-row">' +
        '<div class="settings-device-icon">' + (d.is_local ? 'Desktop' : 'Mobile') + '</div>' +
        '<div class="settings-device-info"><div class="settings-device-name">' + escapeHtml(d.name || d.ip) + '</div>' +
        '<div class="settings-device-ip">' + escapeHtml(d.ip) + '</div></div>' +
        '<div class="settings-device-status ' + (d.active ? 'online' : 'offline') + '">' + (d.active ? 'connected' : 'offline') + '</div>' +
      '</div>';
    }).join('');
  }).catch(function() {
    var el = document.getElementById('settings-devices-list');
    if (el) el.innerHTML = '<div class="settings-empty">Failed to load</div>';
  });
  // Net speed
  fetch('/api/network/stats').then(function(r) { return r.json(); }).then(function(n) {
    var el = document.getElementById('settings-net-speed');
    if (el) {
      var down = (n.download_speed || n.download || 0) / 1024;
      var up = (n.upload_speed || n.upload || 0) / 1024;
      el.textContent = down.toFixed(0) + ' KB/s down / ' + up.toFixed(0) + ' KB/s up';
    }
  }).catch(function() {});
}

function loadSettingsUsage() {
  fetch('/api/telemetry/app-usage').then(function(r) { return r.json(); }).then(function(data) {
    var el = document.getElementById('settings-usage-list');
    if (!el) return;
    var perApp = data.per_app || {};
    var apps = Object.entries(perApp).sort(function(a, b) { return (b[1].total_time || 0) - (a[1].total_time || 0); });
    if (apps.length === 0) {
      el.innerHTML = '<div class="settings-empty">No usage data yet</div>';
      return;
    }
    el.innerHTML = apps.map(function(entry) {
      var id = entry[0], stats = entry[1];
      var time = stats.total_time || 0;
      var mins = Math.round(time / 60);
      var secs = Math.round(time % 60);
      return '<div class="settings-usage-row">' +
        '<div class="settings-usage-app">' + escapeHtml(id) + '</div>' +
        '<div class="settings-usage-stats">' +
          '<span>' + (stats.opens || 0) + ' opens</span>' +
          '<span>' + (mins > 0 ? mins + 'm ' : '') + secs + 's</span>' +
        '</div></div>';
    }).join('');
  }).catch(function() {
    var el = document.getElementById('settings-usage-list');
    if (el) el.innerHTML = '<div class="settings-empty">Failed to load</div>';
  });
}

function loadSettingsLogs() {
  fetch('/api/logs?limit=50').then(function(r) { return r.json(); }).then(function(logs) {
    var el = document.getElementById('settings-logs');
    if (!el) return;
    if (!logs || logs.length === 0) {
      el.innerHTML = '<div class="settings-empty">No logs</div>';
      return;
    }
    el.innerHTML = logs.map(function(l) {
      var level = l.level || 'INFO';
      return '<div class="settings-log-row level-' + level.toLowerCase() + '">' +
        '<span class="log-time">' + escapeHtml(l.timestamp || '') + '</span>' +
        '<span class="log-level">' + level + '</span>' +
        '<span class="log-msg">' + escapeHtml(l.message || '') + '</span>' +
      '</div>';
    }).join('');
  }).catch(function() {
    var el = document.getElementById('settings-logs');
    if (el) el.innerHTML = '<div class="settings-empty">Failed to load</div>';
  });
}

function exportTelemetry() {
  window.open('/api/telemetry/export', '_blank');
}

function exportLogs() {
  window.open('/api/logs/export', '_blank');
}

// ─── App Usage Tracking ────────────────────────────────
