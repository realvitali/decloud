// ===== Module: telemetry =====
var _currentApp = null;
var _appOpenTime = 0;

function trackAppOpen(appId) {
  if (_currentApp) trackAppClose();
  _currentApp = appId;
  _appOpenTime = Date.now();
  fetch('/api/telemetry/app-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, action: 'open' })
  }).catch(function() {});
}

function trackAppClose() {
  if (!_currentApp) return;
  var duration = (Date.now() - _appOpenTime) / 1000;
  fetch('/api/telemetry/app-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: _currentApp, action: 'close', duration: duration })
  }).catch(function() {});
  _currentApp = null;
}

// Apply theme on load (applyTheme is defined in settings.js which loads after this)
// Use a small delay to ensure settings.js has loaded
setTimeout(function() { if (typeof applyTheme === 'function') applyTheme(); }, 0);


// ─── Desktop Mode Detection & Keyboard Navigation ──────

