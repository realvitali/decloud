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
<div class="dot"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#e0e0e0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></div>
<h2>Clearing DeCloud cache...</h2>
<p id="status">Working...</p>
<script src="/static/js/kill-cache.js"></script></body></html>'''

@bp.route('/icons/<path:filename>')
def icons(filename):
    return send_from_directory('static/icons', filename)

