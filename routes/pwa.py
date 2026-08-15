"""PWA routes: index, manifest, service worker, icons."""
from flask import Blueprint, send_from_directory

bp = Blueprint('pwa', __name__)

@bp.route('/')
def index():
    resp = send_from_directory('templates', 'index.html')
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp

@bp.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json')

@bp.route('/sw.js')
def sw():
    resp = send_from_directory('static', 'sw.js', mimetype='application/javascript')
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return resp

@bp.route('/kill-cache')
def kill_cache():
    """Nuclear cache reset page. Visiting this unregisters all service workers
    and clears all caches, then redirects to the app."""
    return '''<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Clearing Cache...</title>
<style>body{background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif;
display:flex;flex-direction:column;align-items:center;justify-content:center;
min-height:100vh;margin:0;text-align:center;padding:24px}
.dot{font-size:48px;margin-bottom:16px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
p{opacity:0.7;font-size:14px}</style></head><body>
<div class="dot">🔄</div>
<h2>Clearing DeCloud cache...</h2>
<p id="status">Working...</p>
<script>
(async function(){
  var s = document.getElementById('status');
  try {
    if ('serviceWorker' in navigator) {
      var regs = await navigator.serviceWorker.getRegistrations();
      for (var r of regs) { await r.unregister(); }
      s.textContent += ' Unregistered ' + regs.length + ' service worker(s).';
    }
    if ('caches' in window) {
      var keys = await caches.keys();
      for (var k of keys) { await caches.delete(k); }
      s.textContent += ' Deleted ' + keys.length + ' cache(s).';
    }
    s.textContent += ' Redirecting...';
    setTimeout(function(){ window.location.href = '/'; }, 1500);
  } catch(e) {
    s.textContent = 'Error: ' + e.message + ' — try force-closing the app and reopening.';
  }
})();
</script></body></html>'''

@bp.route('/icons/<path:filename>')
def icons(filename):
    return send_from_directory('static/icons', filename)

