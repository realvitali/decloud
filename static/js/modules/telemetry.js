// ===== Module: telemetry =====
var _currentApp = null;
var _appOpenTime = 0;    // when the current stretch of on-screen time began (0 = tab hidden)
var _appSeen = 0;        // seconds already counted for the current app

function trackAppOpen(appId) {
  if (_currentApp === appId) return;
  if (_currentApp) trackAppClose();
  _currentApp = appId;
  _appSeen = 0;
  _appOpenTime = document.hidden ? 0 : Date.now();
  fetch('/api/telemetry/app-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, action: 'open' })
  }).catch(function() {});
}

function trackAppClose() {
  if (!_currentApp) return;
  var duration = _appSeen + (_appOpenTime ? (Date.now() - _appOpenTime) / 1000 : 0);
  fetch('/api/telemetry/app-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,   // still sent when the tab is closing
    body: JSON.stringify({ app_id: _currentApp, action: 'close', duration: duration })
  }).catch(function() {});
  _currentApp = null;
  _appOpenTime = 0;
  _appSeen = 0;
}

// A background tab doesn't count as using the app
document.addEventListener('visibilitychange', function() {
  if (!_currentApp) return;
  if (document.hidden) {
    if (_appOpenTime) _appSeen += (Date.now() - _appOpenTime) / 1000;
    _appOpenTime = 0;
  } else {
    _appOpenTime = Date.now();
  }
});
window.addEventListener('pagehide', function() { trackAppClose(); });

// Apply theme on load (applyTheme is defined in settings.js which loads after this)
// Use a small delay to ensure settings.js has loaded
setTimeout(function() { if (typeof applyTheme === 'function') applyTheme(); }, 0);


// ─── Desktop Mode Detection & Keyboard Navigation ──────

