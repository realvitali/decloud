"""Settings/theme route."""
from flask import Blueprint, jsonify, request
import json, os
import shared

bp = Blueprint('settings', __name__)

_ENV_PATH_KEYS = {
    'books': 'DECLOUD_BOOKS_DIR',
    'files': 'DECLOUD_FILES_DIR',
    'music': 'DECLOUD_MUSIC_DIR',
}

def _update_env_file(updates):
    """Persist DECLOUD_*_DIR values to .env, preserving everything else."""
    env_path = shared.BASE_DIR / '.env'
    try:
        lines = env_path.read_text(errors='replace').splitlines() if env_path.exists() else []
    except Exception:
        return False
    written = set()
    out = []
    for line in lines:
        stripped = line.strip()
        matched = False
        for field, key in _ENV_PATH_KEYS.items():
            if field in updates and stripped.startswith(key + '='):
                out.append(f'{key}={updates[field]}')
                written.add(field)
                matched = True
                break
        if not matched:
            out.append(line)
    for field, key in _ENV_PATH_KEYS.items():
        if field in updates and field not in written:
            out.append(f'{key}={updates[field]}')
    try:
        env_path.write_text('\n'.join(out) + '\n')
        return True
    except Exception:
        return False


@bp.route('/api/settings/theme', methods=['GET', 'POST'])
def settings_theme():
    if request.method == 'GET':
        theme = 'auto'
        if shared.SETTINGS_FILE.exists():
            try:
                theme = json.loads(shared.SETTINGS_FILE.read_text()).get('theme', 'auto')
            except Exception:
                pass
        return jsonify({'theme': theme})
    # POST
    data = request.get_json(silent=True) or {}
    theme = data.get('theme', 'auto')
    if theme not in ('auto', 'light', 'dark'):
        return jsonify({'error': 'invalid theme'}), 400
    settings = {}
    if shared.SETTINGS_FILE.exists():
        try:
            settings = json.loads(shared.SETTINGS_FILE.read_text())
        except Exception:
            pass
    settings['theme'] = theme
    shared.SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
    return jsonify({'theme': theme})


@bp.route('/api/settings/experimental', methods=['GET', 'POST'])
def settings_experimental():
    """Experimental-apps flag (stored in settings.json alongside theme)."""
    if request.method == 'GET':
        experimental = False
        if shared.SETTINGS_FILE.exists():
            try:
                experimental = json.loads(shared.SETTINGS_FILE.read_text()).get('experimental', False)
            except Exception:
                pass
        return jsonify({'experimental': experimental})
    data = request.get_json(silent=True) or {}
    experimental = bool(data.get('experimental'))
    settings = {}
    if shared.SETTINGS_FILE.exists():
        try:
            settings = json.loads(shared.SETTINGS_FILE.read_text())
        except Exception:
            pass
    settings['experimental'] = experimental
    try:
        shared.SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
    except Exception:
        return jsonify({'error': 'could not write settings.json'}), 500
    return jsonify({'experimental': experimental})


@bp.route('/api/settings/paths', methods=['GET', 'POST'])
def settings_paths():
    if request.method == 'GET':
        paths = {
            'books': str(shared.BOOKS_DIR),
            'files': str(shared.FILES_DIR),
            'music': str(shared.MUSIC_DIR),
        }
        return jsonify(paths)
    # POST — persist to .env; takes effect after restart
    data = request.get_json(silent=True) or {}
    updates = {}
    for field, key in _ENV_PATH_KEYS.items():
        val = (data.get(field) or '').strip()
        if val:
            updates[field] = val
    if not updates:
        return jsonify({'error': 'no valid paths provided'}), 400
    if not _update_env_file(updates):
        return jsonify({'error': 'could not write .env (check permissions)'}), 500
    # Apply immediately: update the process env + shared globals so the
    # saved paths take effect without a restart.
    for field, key in _ENV_PATH_KEYS.items():
        if field in updates:
            os.environ[key] = updates[field]
    from shared import reload_env_paths
    reload_env_paths()
    return jsonify({'status': 'saved', 'note': 'Applied immediately'})
