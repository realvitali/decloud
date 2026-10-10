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
  if (panelId === 'st-panel-voice') loadVoicePanel();
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
  checkForUpdates(false);
}

function loadSettings() {
  // Load current theme
  fetch('/api/settings/theme').then(function(r) { return r.json(); }).then(function(d) {
    var theme = d.theme || 'auto';
    document.querySelectorAll('.theme-option').forEach(function(btn) {
      btn.classList.toggle('selected', btn.dataset.theme === theme);
    });
  }).catch(function() {});
  // Load experimental-apps flag
  fetch('/api/settings/experimental').then(function(r) { return r.json(); }).then(function(d) {
    experimentalApps = !!d.experimental;
    var toggle = document.getElementById('experimental-toggle');
    if (toggle) toggle.checked = experimentalApps;
    applyExperimentalApps();
  }).catch(function() {});
  // Apply theme on load
  applyTheme();
}

function setExperimentalApps(enabled) {
  experimentalApps = !!enabled;
  fetch('/api/settings/experimental', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experimental: experimentalApps })
  }).catch(function() {});
  applyExperimentalApps();
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
        el.textContent = '✓ Saved — applied immediately';
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

function changePin() {
  var current = document.getElementById('pin-current').value.trim();
  var newPin = document.getElementById('pin-new').value.trim();
  var confirm = document.getElementById('pin-confirm').value.trim();
  var note = document.getElementById('pin-note');
  if (!note) return;

  if (newPin !== confirm) {
    note.textContent = '✗ New passcodes do not match';
    note.className = 'settings-note settings-note-err';
    return;
  }
  if (newPin.length < 8) {
    note.textContent = '✗ New passcode must be at least 8 characters';
    note.className = 'settings-note settings-note-err';
    return;
  }

  fetch('/api/auth/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_pin: current, new_pin: newPin })
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(res) {
    if (res.ok) {
      note.textContent = '✓ Passcode updated — signing out…';
      note.className = 'settings-note settings-note-ok';
      document.getElementById('pin-current').value = '';
      document.getElementById('pin-new').value = '';
      document.getElementById('pin-confirm').value = '';
      setTimeout(function() { location.reload(); }, 1500);
    } else {
      note.textContent = '✗ ' + (res.d.error || 'Failed to change passcode');
      note.className = 'settings-note settings-note-err';
    }
  }).catch(function() {
    note.textContent = '✗ Network error';
    note.className = 'settings-note settings-note-err';
  });
}

// ─── Voice Assistant engine config (Settings → Voice) ──────────

var _voiceStatus = null;

function loadVoicePanel() {
  fetch('/api/voice/status').then(function(r) { return r.json(); }).then(function(d) {
    _voiceStatus = d;
    var cfg = d.config || {};

    // Name
    var nameInput = document.getElementById('voicecfg-name');
    if (nameInput) nameInput.value = cfg.agent_name || 'DeCloud';

    // Brain (Hermes vs LLM fallback)
    var hermes = d.hermes || {};
    var brainEl = document.getElementById('voice-brain-status');
    if (brainEl) {
      brainEl.textContent = hermes.available
        ? '✓ Using Hermes (' + hermes.bin + ')'
        : '• Hermes not detected — falling back to the LLM below. Set the Hermes path or install Hermes for a smarter agent.';
    }
    var hermesHome = document.getElementById('voicecfg-hermes-home');
    if (hermesHome) hermesHome.value = hermes.home || '~/.hermes';

    // Access level
    var accessSel = document.getElementById('voicecfg-access');
    if (accessSel) accessSel.value = cfg.voice_access || 'basic';

    // STT select
    var sttSel = document.getElementById('voicecfg-stt');
    if (sttSel) sttSel.innerHTML = (d.engines.stt || []).map(function(e) {
      return '<option value="' + e.id + '"' + (e.id === cfg.stt ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>';
    }).join('');

    // TTS select
    var ttsSel = document.getElementById('voicecfg-tts');
    if (ttsSel) ttsSel.innerHTML = (d.engines.tts || []).map(function(e) {
      var label = e.name + (e.installed === false ? ' (not installed)' : '');
      return '<option value="' + e.id + '"' + (e.id === cfg.tts ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');

    // Backend
    var backendSel = document.getElementById('voicecfg-backend');
    if (backendSel) backendSel.value = cfg.llm_backend || 'local';

    // Local model select
    var modelSel = document.getElementById('voicecfg-local-model');
    if (modelSel) {
      var models = d.models || [];
      if (models.indexOf(cfg.llm_local_model) === -1 && cfg.llm_local_model) models.push(cfg.llm_local_model);
      modelSel.innerHTML = models.map(function(m) {
        return '<option value="' + escapeHtml(m) + '"' + (m === cfg.llm_local_model ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
      }).join('') || '<option value="">(no models — install below)</option>';
    }

    // Cloud fields
    var cp = document.getElementById('voicecfg-cloud-provider');
    if (cp) cp.value = cfg.llm_cloud_provider || 'openai';
    var cm = document.getElementById('voicecfg-cloud-model');
    if (cm) cm.value = cfg.llm_cloud_model || '';
    var cb = document.getElementById('voicecfg-cloud-base');
    if (cb) cb.value = cfg.llm_cloud_base_url || '';
    var ak = document.getElementById('voicecfg-api-key');
    if (ak) { ak.value = ''; ak.placeholder = d.api_key && d.api_key.set ? (d.api_key.hint || 'key saved') : 'sk-…'; }

    // Status line
    renderVoiceSetupStatus(d);

    voiceBackendChanged();
    voiceCloudProviderChanged();
  }).catch(function() {
    var el = document.getElementById('voice-setup-status');
    if (el) el.textContent = 'Could not load voice settings.';
  });
}

function renderVoiceSetupStatus(d) {
  var el = document.getElementById('voice-setup-status');
  if (!el) return;
  var parts = [];
  parts.push(d.ollama.running
    ? '✓ Ollama running (local AI ready)'
    : (d.ollama.installed ? '⚠ Ollama installed but not running' : '• Ollama not installed — use the button below for local AI'));
  parts.push(d.piper_available ? '✓ Piper TTS ready' : '• Piper TTS missing');
  parts.push(d.whisper_available ? '✓ Whisper STT ready' : '• Whisper STT not installed (browser speech is default)');
  parts.push(d.api_key && d.api_key.set ? '✓ Cloud API key saved' : '• No cloud API key');
  el.textContent = parts.join('  •  ');
  var ollamaNote = document.getElementById('voice-ollama-note');
  if (ollamaNote) {
    var j = d.setup_jobs || {};
    var active = Object.keys(j).filter(function(k) { return j[k].state === 'running'; });
    if (active.length) ollamaNote.textContent = j[active[0]].message;
    else if (!d.ollama.running) ollamaNote.textContent = 'Install Ollama, then download a small model like llama3.2:3b to get started.';
    else ollamaNote.textContent = 'Local models run on this machine — private, no API costs.';
  }
}

function voiceBackendChanged() {
  var backend = document.getElementById('voicecfg-backend');
  if (!backend) return;
  var isCloud = backend.value === 'cloud';
  var localBlock = document.getElementById('voicecfg-local-block');
  var cloudBlock = document.getElementById('voicecfg-cloud-block');
  if (localBlock) localBlock.style.display = isCloud ? 'none' : '';
  if (cloudBlock) cloudBlock.style.display = isCloud ? '' : 'none';
}

function clearVoiceMemory() {
  fetch('/api/voice/reset', { method: 'POST' }).then(function() {
    loadVoicePanel();
  }).catch(function() {});
}

function saveHermesHome() {
  var val = document.getElementById('voicecfg-hermes-home')?.value.trim();
  if (!val) return;
  fetch('/api/voice/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hermes_home: val })
  }).then(function(r) { return r.json(); }).then(function(d) {
    loadVoicePanel();
  }).catch(function() {});
}

function voiceAccessChanged() {
  var sel = document.getElementById('voicecfg-access');
  if (!sel) return;
  if (sel.value === 'full') {
    // Require explicit confirmation before enabling unrestricted access.
    document.getElementById('full-access-modal').style.display = 'flex';
    return;
  }
  saveVoiceConfig();
}

function fullAccessConfirm(approved) {
  document.getElementById('full-access-modal').style.display = 'none';
  if (approved) {
    saveVoiceConfig();
  } else {
    // Revert the select back to the previous (safe) value.
    fetch('/api/voice/config').then(function(r) { return r.json(); }).then(function(d) {
      var sel = document.getElementById('voicecfg-access');
      if (sel) sel.value = (d.config && d.config.voice_access) || 'basic';
    }).catch(function() {});
  }
}

function voiceCloudProviderChanged() {
  var cp = document.getElementById('voicecfg-cloud-provider');
  var row = document.getElementById('voicecfg-cloud-base-row');
  if (cp && row) row.style.display = cp.value === 'openai-compatible' ? '' : 'none';
}

function saveVoiceConfig() {
  var payload = {
    agent_name: document.getElementById('voicecfg-name')?.value,
    stt: document.getElementById('voicecfg-stt')?.value,
    tts: document.getElementById('voicecfg-tts')?.value,
    voice_access: document.getElementById('voicecfg-access')?.value,
    llm_backend: document.getElementById('voicecfg-backend')?.value,
    llm_local_model: document.getElementById('voicecfg-local-model')?.value,
    llm_cloud_provider: document.getElementById('voicecfg-cloud-provider')?.value,
    llm_cloud_model: document.getElementById('voicecfg-cloud-model')?.value,
    llm_cloud_base_url: document.getElementById('voicecfg-cloud-base')?.value
  };
  var apiKey = document.getElementById('voicecfg-api-key')?.value;
  if (apiKey && apiKey.trim()) payload.api_key = apiKey.trim();
  fetch('/api/voice/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.config && typeof window.onVoiceConfigChanged === 'function') window.onVoiceConfigChanged(d.config);
    var note = document.getElementById('voice-api-key-note');
    if (note) note.textContent = '✓ Saved';
    setTimeout(function() { if (note) note.textContent = 'Your key is stored in .env on this machine only.'; }, 2000);
    if (payload.api_key) { var ak = document.getElementById('voicecfg-api-key'); if (ak) ak.value = ''; }
    if (_voiceStatus) renderVoiceSetupStatus(_voiceStatus);
  }).catch(function() {
    var note = document.getElementById('voice-api-key-note');
    if (note) note.textContent = '✗ Save failed';
  });
}

function installOllama() {
  var note = document.getElementById('voice-ollama-note');
  if (note) note.textContent = 'Starting Ollama install… (may require your sudo password in the terminal)';
  fetch('/api/voice/ollama/install', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
    if (note) note.textContent = d.status === 'started' ? 'Installing… check back in a minute.' : (d.message || 'Started');
    pollVoiceSetup();
  }).catch(function() {
    if (note) note.textContent = '✗ Could not start install';
  });
}

function pullOllamaModel() {
  var sel = document.getElementById('voicecfg-local-model');
  var model = sel && sel.value ? sel.value : 'llama3.2:3b';
  if (!model) return;
  var note = document.getElementById('voice-ollama-note');
  if (note) note.textContent = 'Downloading ' + model + '…';
  fetch('/api/voice/ollama/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { if (note) note.textContent = '✗ ' + d.error; return; }
    if (note) note.textContent = 'Downloading ' + model + '… check back in a minute.';
    pollVoiceSetup();
  }).catch(function() {
    if (note) note.textContent = '✗ Could not start download';
  });
}

function installVoice() {
  var sel = document.getElementById('voicecfg-tts');
  var engine = sel ? sel.value : '';
  var note = document.getElementById('voice-tts-note');
  if (!engine) return;
  if (note) note.textContent = 'Downloading voice…';
  fetch('/api/voice/tts/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: engine })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { if (note) note.textContent = '✗ ' + d.error; return; }
    if (note) note.textContent = 'Downloading… check back in a minute.';
    pollVoiceSetup();
  }).catch(function() {
    if (note) note.textContent = '✗ Could not start download';
  });
}

function pollVoiceSetup() {
  fetch('/api/voice/status').then(function(r) { return r.json(); }).then(function(d) {
    _voiceStatus = d;
    renderVoiceSetupStatus(d);
    var jobs = d.setup_jobs || {};
    var active = Object.keys(jobs).filter(function(k) { return jobs[k].state === 'running'; });
    if (active.length) setTimeout(pollVoiceSetup, 5000);
    else loadVoicePanel();
  }).catch(function() {});
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

function devicePlatformLabel(osName, isLocal) {
  var os = (osName || '').toLowerCase();
  if (os === 'ios' || os === 'ipados') return 'iOS';
  if (os === 'macos' || os === 'darwin') return 'macOS';
  if (os === 'windows') return 'Windows';
  if (os === 'linux') return isLocal ? 'This device' : 'Linux';
  if (os === 'android') return 'Android';
  if (isLocal) return 'This device';
  return '';
}

function loadSettingsDevices() {
  fetch('/api/devices').then(function(r) { return r.json(); }).then(function(devices) {
    var el = document.getElementById('settings-devices-list');
    if (!el) return;
    if (!devices || devices.length === 0) {
      el.innerHTML = '<div class="settings-empty">No devices found</div>';
      return;
    }
    // Tailscale IP row — from this machine's own tailnet IP
    var self = devices.find(function(d) { return d.is_local; });
    var ipEl = document.getElementById('settings-tailscale-ip');
    if (ipEl) ipEl.textContent = (self && self.ip) ? self.ip : '--';

    el.innerHTML = devices.map(function(d) {
      var platform = devicePlatformLabel(d.os, d.is_local);
      var label = d.is_local ? 'This device' : (d.name || d.ip || 'unknown');
      var sub = d.dns && d.dns !== d.name ? d.dns : (d.ip || '');
      return '<div class="settings-device-row">' +
        '<div class="settings-device-icon">' + escapeHtml(platform || '·') + '</div>' +
        '<div class="settings-device-info"><div class="settings-device-name">' + escapeHtml(label) + '</div>' +
        '<div class="settings-device-ip">' + escapeHtml(sub) + '</div></div>' +
        '<div class="settings-device-status ' + (d.online ? 'online' : 'offline') + '">' + (d.online ? 'online' : 'offline') + '</div>' +
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

// ─── Self-update (Settings → About) ──────────────────────
var _updateState = null;

async function checkForUpdates(manual) {
  var status = document.getElementById('update-status');
  var actions = document.getElementById('update-actions');
  if (status) status.textContent = 'Checking for updates…';
  try {
    var r = await fetch('/api/system/update/check');
    var d = await r.json();
    _updateState = d;

    if (!d.is_git) {
      if (status) status.textContent = 'Updates unavailable — this install is not a git checkout.';
      if (actions) actions.style.display = 'none';
      return;
    }
    if (!d.tree_clean) {
      if (status) status.textContent = 'Local files have been modified — updates are paused to protect your changes.';
      if (actions) actions.style.display = 'none';
      return;
    }
    if (d.update_available && d.latest && d.latest.tag) {
      var notes = d.latest.notes ? ' — ' + d.latest.notes.split('\n')[0].slice(0, 120) : '';
      if (status) status.textContent = 'Update available: ' + d.latest.tag +
        ' (you are on v' + d.current_version + ')' + notes;
      var go = document.getElementById('update-go-btn');
      if (go) go.setAttribute('data-ref', d.latest.tag);
      if (actions) actions.style.display = '';
    } else {
      if (status) status.textContent = 'You are up to date (v' + d.current_version + ').';
      if (actions) actions.style.display = d.can_rollback ? '' : 'none';
    }
    var rb = document.getElementById('update-rollback-btn');
    if (rb) rb.style.display = d.can_rollback ? '' : 'none';
  } catch (e) {
    if (status) status.textContent = 'Could not check for updates: ' + (e.message || 'network error');
  }
}

async function performUpdate() {
  var go = document.getElementById('update-go-btn');
  var ref = go ? go.getAttribute('data-ref') : '';
  if (!ref) return;
  if (!confirm('Update DeCloud to ' + ref + '?\n\nThe new version is downloaded, verified, and test-booted before anything restarts. Your passcode, settings, books, and files are untouched. If the new version fails to start, DeCloud reverts automatically.')) return;
  var status = document.getElementById('update-status');
  if (status) status.textContent = 'Updating to ' + ref + '… (this can take a minute)';
  try {
    var r = await fetch('/api/system/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: ref })
    });
    var d = await r.json();
    if (!r.ok) {
      if (status) status.textContent = 'Update did not apply: ' + (d.error || r.status);
      return;
    }
    if (status) status.textContent = d.message + ' — ' + (d.to || ref);
    if (d.restart === 'scheduled') {
      _waitForRestart(ref);
    }
  } catch (e) {
    if (status) status.textContent = 'Update error: ' + (e.message || 'network');
  }
}

async function performRollback() {
  if (!confirm('Revert to the version from before the last update? DeCloud will restart.')) return;
  var status = document.getElementById('update-status');
  if (status) status.textContent = 'Reverting…';
  try {
    var r = await fetch('/api/system/update/rollback', { method: 'POST' });
    var d = await r.json();
    if (!r.ok) {
      if (status) status.textContent = 'Revert did not apply: ' + (d.error || r.status);
      return;
    }
    if (status) status.textContent = 'Reverted — restarting…';
    _waitForRestart(null);
  } catch (e) {
    if (status) status.textContent = 'Revert error: ' + (e.message || 'network');
  }
}

async function _waitForRestart(toRef) {
  // The server kills itself ~2s after responding; poll until it's back
  // (systemd restarts it in ~3s), then reload the page for fresh assets.
  for (var i = 0; i < 30; i++) {
    await new Promise(function(res) { setTimeout(res, 3000); });
    try {
      var r = await fetch('/api/version');
      if (r.ok) {
        var d = await r.json();
        if (!toRef || d.version === toRef.replace(/^v/, '')) {
          setTimeout(function() { location.reload(); }, 500);
          return;
        }
      }
    } catch (e) { /* still down */ }
  }
  var status = document.getElementById('update-status');
  if (status) status.textContent = 'The app is taking a while to come back — refresh the page in a minute. If it is still down, DeCloud has automatically reverted; check again shortly.';
}

// Expose for inline onclick handlers
window.checkForUpdates = checkForUpdates;
window.performUpdate = performUpdate;
window.performRollback = performRollback;
