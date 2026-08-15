"""OSINT watcher routes.

Requires an external osint-tools package. Set DECLOUD_OSINT_DIR in .env
to the directory containing osint_watcher.py. If not configured,
endpoints return helpful error messages.
"""
import os, sys, subprocess
from flask import Blueprint, jsonify, request

bp = Blueprint('osint', __name__)

OSINT_DIR = os.environ.get('DECLOUD_OSINT_DIR', '')

def _osint_available():
    """Check if osint tools are installed."""
    return bool(OSINT_DIR and os.path.isdir(OSINT_DIR))

def _load_osint():
    """Import osint_watcher if available."""
    if not _osint_available():
        return None
    if OSINT_DIR not in sys.path:
        sys.path.insert(0, OSINT_DIR)
    try:
        import osint_watcher
        return osint_watcher
    except ImportError:
        return None

def _not_configured():
    return jsonify({
        'error': 'OSINT tools not configured. Set DECLOUD_OSINT_DIR in your .env file.'
    }), 503

@bp.route('/api/osint/profiles', methods=['GET'])
def osint_profiles():
    mod = _load_osint()
    if not mod:
        return _not_configured()
    return jsonify(mod.list_profiles())

@bp.route('/api/osint/profiles', methods=['POST'])
def osint_create_profile():
    mod = _load_osint()
    if not mod:
        return _not_configured()
    data = request.json
    pid = mod.create_profile(data.get('name', ''), data.get('info', {}))
    return jsonify({'id': pid, 'profile': mod.get_profile(pid)})

@bp.route('/api/osint/profiles/<pid>', methods=['GET'])
def osint_get_profile(pid):
    mod = _load_osint()
    if not mod:
        return _not_configured()
    p = mod.get_profile(pid)
    if not p:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(p)

@bp.route('/api/osint/profiles/<pid>', methods=['DELETE'])
def osint_delete_profile(pid):
    mod = _load_osint()
    if not mod:
        return _not_configured()
    if mod.delete_profile(pid):
        return jsonify({'ok': True})
    return jsonify({'error': 'Not found'}), 404

@bp.route('/api/osint/scan', methods=['POST'])
def osint_run_scan():
    if not _osint_available():
        return _not_configured()
    data = request.json
    pid = data.get('profile_id', '')
    deep = data.get('deep', False)
    deep_flag = "--deep" if deep else ""
    try:
        proc = subprocess.run(
            [sys.executable, os.path.join(OSINT_DIR, 'osint_watcher.py'), 'scan', pid, deep_flag],
            capture_output=True, text=True, timeout=300,
            cwd=OSINT_DIR,
        )
        mod = _load_osint()
        if mod:
            scans = mod.list_scans(pid)
            if scans:
                result = mod.get_scan_result(scans[0]["scan_id"])
                return jsonify(result)
        return jsonify({"error": "Scan produced no results", "stdout": proc.stdout[:500], "stderr": proc.stderr[:500]})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Scan timed out (5 min limit)"})
    except Exception as e:
        return jsonify({"error": str(e)})

@bp.route('/api/osint/scans', methods=['GET'])
def osint_list_scans():
    mod = _load_osint()
    if not mod:
        return _not_configured()
    pid = request.args.get('profile_id', None)
    return jsonify(mod.list_scans(pid))

@bp.route('/api/osint/scans/<scan_id>', methods=['GET'])
def osint_get_scan(scan_id):
    mod = _load_osint()
    if not mod:
        return _not_configured()
    r = mod.get_scan_result(scan_id)
    if not r:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(r)

@bp.route('/api/osint/update-brokers', methods=['POST'])
def osint_update_brokers():
    return jsonify({'updated': False, 'error': 'Broker list is now built-in, no update needed'})

@bp.route('/api/osint/brokers', methods=['GET'])
def osint_list_brokers():
    mod = _load_osint()
    if not mod:
        return _not_configured()
    if hasattr(mod, 'MANUAL_OPT_OUT_SITES'):
        return jsonify(mod.MANUAL_OPT_OUT_SITES)
    return jsonify([])
