"""Settings/theme route."""
from flask import Blueprint, jsonify, request
import shared

bp = Blueprint('settings', __name__)

_ENV_PATH_KEYS = {
    'books': 'DECLOUD_BOOKS_DIR',
    'files': 'DECLOUD_FILES_DIR',
    'music': 'DECLOUD_MUSIC_DIR',
}

@bp.route('/api/settings/theme', methods=['GET', 'POST'])
def settings_theme():
    if request.method == 'GET':
        return jsonify({'theme': shared.load_settings().get('theme', 'auto')})
    data = request.get_json(silent=True) or {}
    theme = data.get('theme', 'auto')
    if theme not in ('auto', 'light', 'dark'):
        return jsonify({'error': 'invalid theme'}), 400
    settings = shared.load_settings()
    settings['theme'] = theme
    if not shared.save_settings(settings):
        return jsonify({'error': 'could not write settings.json'}), 500
    return jsonify({'theme': theme})


@bp.route('/api/settings/experimental', methods=['GET', 'POST'])
def settings_experimental():
    """Experimental-apps flag (stored in settings.json alongside theme)."""
    if request.method == 'GET':
        return jsonify({'experimental': shared.load_settings().get('experimental', False)})
    data = request.get_json(silent=True) or {}
    experimental = bool(data.get('experimental'))
    settings = shared.load_settings()
    settings['experimental'] = experimental
    if not shared.save_settings(settings):
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
    if any(c in v for v in updates.values() for c in '\r\n\0'):
        return jsonify({'error': 'paths cannot contain line breaks'}), 400
    # set_env_value also updates os.environ, so reload applies them now.
    for field, val in updates.items():
        if not shared.set_env_value(_ENV_PATH_KEYS[field], val):
            return jsonify({'error': 'could not write .env (check permissions)'}), 500
    shared.reload_env_paths()
    return jsonify({'status': 'saved', 'note': 'Applied immediately'})
