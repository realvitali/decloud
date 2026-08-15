"""Settings/theme route."""
from flask import Blueprint, jsonify, request
import json
from shared import BASE_DIR, SETTINGS_FILE, BOOKS_DIR, FILES_DIR, MUSIC_DIR

bp = Blueprint('settings', __name__)

_ENV_PATH_KEYS = {
    'books': 'DECLOUD_BOOKS_DIR',
    'files': 'DECLOUD_FILES_DIR',
    'music': 'DECLOUD_MUSIC_DIR',
}

def _update_env_file(updates):
    """Persist DECLOUD_*_DIR values to .env, preserving everything else."""
    env_path = BASE_DIR / '.env'
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
        if SETTINGS_FILE.exists():
            try:
                theme = json.loads(SETTINGS_FILE.read_text()).get('theme', 'auto')
            except Exception:
                pass
        return jsonify({'theme': theme})
    # POST
    data = request.get_json(silent=True) or {}
    theme = data.get('theme', 'auto')
    if theme not in ('auto', 'light', 'dark'):
        return jsonify({'error': 'invalid theme'}), 400
    settings = {}
    if SETTINGS_FILE.exists():
        try:
            settings = json.loads(SETTINGS_FILE.read_text())
        except Exception:
            pass
    settings['theme'] = theme
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
    return jsonify({'theme': theme})


@bp.route('/api/settings/paths', methods=['GET', 'POST'])
def settings_paths():
    if request.method == 'GET':
        paths = {
            'books': str(BOOKS_DIR),
            'files': str(FILES_DIR),
            'music': str(MUSIC_DIR),
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
    return jsonify({'status': 'saved', 'note': 'restart required'})
