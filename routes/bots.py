"""Bots — named Hermes profiles as chat agents, Bot Mode for DeCloud.

Optional module, same pattern as routes/agents.py. Set DECLOUD_HERMES_HOME
(in .env) to the Hermes root (e.g. /home/vitali/.hermes) to enable.

How it works:
  - A bot IS a Hermes profile, created via `hermes profile create --clone-from`.
  - Chat runs `hermes -p <bot> chat -q <msg> --continue bots-<bot> -Q`
    headlessly; the named session gives each bot persistent memory.
  - DeCloud also appends each turn to data/bot-chats/<bot>.jsonl so history
    renders instantly without touching Hermes session internals.
"""
import os, re, json, shutil, subprocess, datetime
from pathlib import Path
from flask import Blueprint, jsonify, request

bp = Blueprint('bots', __name__)

HERMES_HOME = os.environ.get('DECLOUD_HERMES_HOME', '').rstrip('/')
# Profiles that DeCloud itself depends on — never deletable via the API
_PROTECTED = {'agent2', 'pengy', 'sentinel', 'qwen-test', 'default'}


def _not_configured():
    return jsonify({'error': 'Hermes not configured. Set DECLOUD_HERMES_HOME in .env.'}), 503


def _hermes_bin():
    cand = os.path.join(HERMES_HOME, 'hermes-agent', 'venv', 'bin', 'hermes')
    if os.path.exists(cand):
        return cand
    return shutil.which('hermes') or cand


def _profile_ok(name):
    return bool(re.match(r'^[a-z0-9][a-z0-9_-]*$', name or '')) and len(name) <= 32


def _run_hermes(args, timeout=240):
    env = dict(os.environ, HERMES_HOME=HERMES_HOME)
    try:
        r = subprocess.run([_hermes_bin()] + args, capture_output=True,
                           text=True, env=env, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, '', 'Agent run timed out'
    except FileNotFoundError:
        return 127, '', 'hermes binary not found'


def _parse_reply(stdout):
    """With -Q the CLI prints just the reply; strip banners/footer as fallback."""
    text = stdout.replace('\r', '')
    lines = [l for l in text.splitlines()]
    # Drop leading init/status lines
    while lines and (not lines[0].strip() or lines[0].startswith(('Initializing', 'Query:', 'Session '))):
        lines.pop(0)
    # Drop footer stats
    out = []
    for l in lines:
        if re.match(r'^(Session:|Title:|Duration:|Messages:|Resume this session|\s*hermes |-{10,}|╭|╰)', l):
            break
        out.append(l)
    return '\n'.join(out).strip()


# ─── Registry: data/bots.json ────────────────────────────────────

def _data_dir():
    from shared import BASE_DIR
    d = Path(BASE_DIR) / 'data' / 'bot-chats'
    d.mkdir(parents=True, exist_ok=True)
    return Path(BASE_DIR) / 'data'


def _load_registry():
    f = _data_dir() / 'bots.json'
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text())
    except Exception:
        return {}


def _save_registry(reg):
    f = _data_dir() / 'bots.json'
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(reg, indent=2))


def _chat_log(name):
    return _data_dir() / 'bot-chats' / f'{name}.jsonl'


def _append_log(name, role, text):
    entry = {'ts': datetime.datetime.now().isoformat(timespec='seconds'), 'role': role, 'text': text[:8000]}
    with open(_chat_log(name), 'a') as f:
        f.write(json.dumps(entry) + '\n')


# ─── Routes ──────────────────────────────────────────────────────

@bp.route('/api/bots', methods=['GET'])
def list_bots():
    if not HERMES_HOME:
        return _not_configured()
    reg = _load_registry()
    rc, out, _ = _run_hermes(['profile', 'list'], timeout=30)
    profiles = {}
    if rc == 0:
        for line in out.splitlines():
            m = re.match(r'\s*[◆*\s]?([a-z0-9][a-z0-9_-]*)\s{2,}(\S+)', line)
            if m and m.group(2) not in ('—', 'Model'):
                profiles[m.group(1)] = m.group(2)
    bots = []
    for name, meta in sorted(reg.items()):
        bots.append({
            'name': name,
            'title': meta.get('title', name),
            'description': meta.get('description', ''),
            'color': meta.get('color', '#7c6ff0'),
            'emoji': meta.get('emoji', '🤖'),
            'model': profiles.get(name) or meta.get('model', ''),
            'has_profile': (Path(HERMES_HOME) / 'profiles' / name).exists(),
            'protected': name in _PROTECTED,
            'created': meta.get('created', ''),
        })
    return jsonify({'bots': bots, 'hermes_configured': True})


@bp.route('/api/bots', methods=['POST'])
def create_bot():
    if not HERMES_HOME:
        return _not_configured()
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip().lower()
    if not _profile_ok(name):
        return jsonify({'error': 'Lowercase letters, digits, dash only (max 32)'}), 400
    reg = _load_registry()
    if name in reg:
        return jsonify({'error': f'Bot "{name}" already exists'}), 409
    if (Path(HERMES_HOME) / 'profiles' / name).exists():
        return jsonify({'error': f'Hermes profile "{name}" already exists'}), 409

    clone_from = data.get('clone_from') or 'agent2'
    if not _profile_ok(clone_from) or not (Path(HERMES_HOME) / 'profiles' / clone_from).exists():
        return jsonify({'error': f'Clone source "{clone_from}" not found'}), 400

    rc, out, err = _run_hermes(
        ['profile', 'create', name, '--clone-from', clone_from, '--no-alias'], timeout=90)
    if rc != 0:
        return jsonify({'error': 'Failed to create Hermes profile',
                        'detail': (err or out)[-400:]}), 500

    reg[name] = {
        'title': (data.get('title') or name).strip()[:60],
        'description': (data.get('description') or '').strip()[:280],
        'color': data.get('color') or '#7c6ff0',
        'emoji': data.get('emoji') or '🤖',
        'model': data.get('model') or '',
        'clone_from': clone_from,
        'created': datetime.date.today().isoformat(),
    }
    _save_registry(reg)
    return jsonify({'ok': True, 'name': name})


@bp.route('/api/bots/<name>', methods=['DELETE'])
def delete_bot(name):
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name):
        return jsonify({'error': 'Invalid name'}), 400
    if name in _PROTECTED:
        return jsonify({'error': f'"{name}" is a core profile — refusing to delete'}), 403
    reg = _load_registry()
    if name not in reg:
        return jsonify({'error': 'Not found'}), 404
    _run_hermes(['profile', 'delete', name, '-y'], timeout=60)
    reg.pop(name, None)
    _save_registry(reg)
    try:
        _chat_log(name).unlink(missing_ok=True)
    except Exception:
        pass
    return jsonify({'ok': True})


@bp.route('/api/bots/<name>/chat', methods=['POST'])
def bot_chat(name):
    """Send a message, get the bot's reply. Blocking — bots can take a minute."""
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name):
        return jsonify({'error': 'Invalid name'}), 400
    reg = _load_registry()
    if name not in reg:
        return jsonify({'error': 'Not found'}), 404
    data = request.get_json(silent=True) or {}
    msg = (data.get('message') or '').strip()
    if not msg:
        return jsonify({'error': 'Empty message'}), 400
    if len(msg) > 4000:
        return jsonify({'error': 'Message too long (max 4000 chars)'}), 400

    suffix = reg[name].get('session_suffix', '')
    session = f'bots-{name}-{suffix}' if suffix else f'bots-{name}'
    args = ['-p', name, 'chat', '-q', msg, '--continue', session,
            '--create-if-missing', '-Q', '--max-turns', '8']
    model = data.get('model')
    if model and re.match(r'^[\w.:/-]+$', model):
        args += ['-m', model]

    _append_log(name, 'user', msg)
    rc, out, err = _run_hermes(args)
    reply = _parse_reply(out)
    if not reply:
        reply = f'⚠ Agent error: {((err or out).strip().splitlines() or ["unknown error"])[-1][:300]}'
    _append_log(name, 'assistant', reply)
    return jsonify({'ok': True, 'reply': reply})


@bp.route('/api/bots/<name>/history', methods=['GET'])
def bot_history(name):
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name):
        return jsonify({'error': 'Invalid name'}), 400
    if name not in _load_registry():
        return jsonify({'error': 'Not found'}), 404
    f = _chat_log(name)
    if not f.exists():
        return jsonify({'messages': []})
    msgs = []
    for line in f.read_text().splitlines():
        try:
            m = json.loads(line)
            if m.get('role') in ('user', 'assistant') and m.get('text'):
                msgs.append({'role': m['role'], 'text': m['text'][:4000], 'ts': m.get('ts', '')})
        except Exception:
            continue
    return jsonify({'messages': msgs[-100:]})


@bp.route('/api/bots/<name>/clear', methods=['POST'])
def clear_chat(name):
    """Clear the display log AND start a fresh Hermes session (new memory)."""
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name):
        return jsonify({'error': 'Invalid name'}), 400
    if name not in _load_registry():
        return jsonify({'error': 'Not found'}), 404
    stamp = datetime.datetime.now().strftime('%H%M%S')
    reg = _load_registry()
    reg[name]['session_suffix'] = stamp  # next chat starts a fresh Hermes session
    _save_registry(reg)
    try:
        _chat_log(name).unlink(missing_ok=True)
    except Exception:
        pass
    return jsonify({'ok': True, 'note': 'chat cleared'})
