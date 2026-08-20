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


def _run_hermes(args, timeout=240, profile=None):
    """Run hermes CLI. If profile is given, set HERMES_HOME to the profile dir
    so SOUL.md and other profile-scoped files are read correctly."""
    if profile:
        profile_home = os.path.join(HERMES_HOME, 'profiles', profile)
        env = dict(os.environ, HERMES_HOME=profile_home)
    else:
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

@bp.route('/api/bots/models', methods=['GET'])
def list_models():
    """List available ollama models for the model picker."""
    import subprocess
    try:
        r = subprocess.run(['ollama', 'list', '--json'], capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            import json
            models = json.loads(r.stdout)
            result = []
            for m in models:
                name = m.get('name', '')
                size = m.get('size', 0)
                # Mark cloud vs local
                is_cloud = ':cloud' in name or any(x in name for x in ['cloud', ':sky'])
                result.append({
                    'name': name,
                    'size_gb': round(size / 1e9, 1) if size else 0,
                    'cloud': is_cloud
                })
            return jsonify({'models': result})
    except Exception:
        pass
    # Fallback: parse text output
    try:
        r = subprocess.run(['ollama', 'list'], capture_output=True, text=True, timeout=10)
        models = []
        for line in r.stdout.strip().splitlines()[1:]:  # skip header
            parts = line.split()
            if parts:
                name = parts[0]
                size = parts[1] if len(parts) > 1 else ''
                is_cloud = ':cloud' in name or 'cloud' in name
                models.append({'name': name, 'size_gb': 0, 'cloud': is_cloud})
        return jsonify({'models': models})
    except Exception as e:
        return jsonify({'models': [], 'error': str(e)}), 500


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
        # Grab last message for chat preview
        preview = ''
        last_ts = ''
        log = _chat_log(name)
        if log.exists():
            try:
                lines = log.read_text().strip().splitlines()
                if lines:
                    last = json.loads(lines[-1])
                    preview = (last.get('text') or '')[:120]
                    last_ts = last.get('ts') or ''
            except Exception:
                pass
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
            'last_preview': preview,
            'last_ts': last_ts,
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
            '--create-if-missing', '-Q', '--max-turns', '12',
            '-t', 'web,terminal,file,browser,code_execution,skills,memory,session_search,a2a',
            '--yolo']
    model = data.get('model')
    if model and re.match(r'^[\w.:/-]+$', model):
        args += ['-m', model]

    _append_log(name, 'user', msg)
    rc, out, err = _run_hermes(args, profile=name)
    reply = _parse_reply(out)
    if not reply:
        # Parse error type from stderr/stdout for user-friendly message
        raw = (err or out or '').strip()
        raw_lower = raw.lower()
        if rc == 124:
            reply = '⏱ The agent timed out. Try again or use a simpler question.'
        elif '402' in raw_lower or 'payment required' in raw_lower or 'balance is empty' in raw_lower:
            reply = '💳 This model is out of credits. Tell Vitali to top up the ollama balance or switch models.'
        elif '429' in raw_lower or 'rate limit' in raw_lower or 'usage limit' in raw_lower:
            reply = '🚦 This model hit a rate limit. It will reset later. Try again in a bit.'
        elif '401' in raw_lower or 'unauthorized' in raw_lower or 'token expired' in raw_lower:
            reply = '🔑 API key is expired or invalid. Tell Vitali to refresh the key.'
        elif 'connection' in raw_lower or 'refused' in raw_lower or 'timeout' in raw_lower:
            reply = '🔌 Could not connect to the model server. It might be down.'
        elif 'model' in raw_lower and 'not found' in raw_lower:
            reply = '❓ The configured model was not found. It may have been removed.'
        else:
            last_line = (raw.splitlines() or ['unknown error'])[-1][:300]
            reply = f'⚠ Agent error: {last_line}'
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


# ─── Persona (SOUL.md) editor ──────────────────────────────
@bp.route('/api/bots/<name>/persona', methods=['GET'])
def get_persona(name):
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name) or name not in _load_registry():
        return jsonify({'error': 'Not found'}), 404
    soul_path = Path(HERMES_HOME) / 'profiles' / name / 'SOUL.md'
    if not soul_path.exists():
        return jsonify({'persona': '', 'exists': False})
    try:
        content = soul_path.read_text(encoding='utf-8')
        return jsonify({'persona': content, 'exists': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/bots/<name>/persona', methods=['POST'])
def set_persona(name):
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name) or name not in _load_registry():
        return jsonify({'error': 'Not found'}), 404
    data = request.get_json(silent=True) or {}
    content = data.get('persona', '')
    if len(content) > 10000:
        return jsonify({'error': 'Persona too long (max 10000 chars)'}), 400
    soul_path = Path(HERMES_HOME) / 'profiles' / name / 'SOUL.md'
    try:
        soul_path.write_text(content, encoding='utf-8')
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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


@bp.route('/api/bots/<name>/relay', methods=['POST'])
def bot_relay(name):
    """@mention relay: ask another bot inside this bot's chat.

    Flow: user (in bot A's chat) @mentions bot B with a question.
      1. B answers the question in its own session (B keeps memory).
      2. A is told what B was asked + answered, and responds briefly.
    Both replies return; the frontend renders them in A's chat.
    """
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name):
        return jsonify({'error': 'Invalid name'}), 400
    reg = _load_registry()
    if name not in reg:
        return jsonify({'error': 'Not found'}), 404
    data = request.get_json(silent=True) or {}
    to = (data.get('to') or '').strip()
    msg = (data.get('message') or '').strip()
    if not _profile_ok(to) or to not in reg:
        return jsonify({'error': f'Unknown bot "@{to}"'}), 404
    if to == name:
        return jsonify({'error': 'Mention a different bot'}), 400
    if not msg or len(msg) > 4000:
        return jsonify({'error': 'Bad message'}), 400

    def _ask(bot, text):
        suffix = reg[bot].get('session_suffix', '')
        session = f'bots-{bot}-{suffix}' if suffix else f'bots-{bot}'
        rc, out, err = _run_hermes(['-p', bot, 'chat', '-q', text, '--continue',
                                    session, '--create-if-missing', '-Q',
                                    '--max-turns', '8',
                                    '-t', 'web,terminal,file,browser,skills,memory,a2a',
                                    '--yolo'], profile=bot)
        reply = _parse_reply(out)
        if not reply:
            reply = f'⚠ error: {((err or out).strip().splitlines() or ["unknown"])[-1][:200]}'
        return reply

    _append_log(name, 'user', msg)
    b_reply = _ask(to, f'{msg}\n\n(You were @mentioned in {reg[name].get("title", name)}\'s chat. Answer directly.)')
    _append_log(name, 'assistant', f'@{to}: {b_reply}')
    a_reply = _ask(name, f'In your chat, the user asked bot @{to}: "{msg}". '
                         f'@{to} replied: "{b_reply}"\n\n'
                         f'Add anything useful in one short message, or just acknowledge.')
    _append_log(name, 'assistant', a_reply)
    return jsonify({'ok': True, 'from': to, 'reply': b_reply, 'followup': a_reply})


# ─── Routines (per-bot Hermes cron jobs) ─────────────────────────

def _jobs_json_path(name):
    return Path(HERMES_HOME) / 'profiles' / name / 'cron' / 'jobs.json'


@bp.route('/api/bots/<name>/routines', methods=['GET'])
def list_routines(name):
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name) or name not in _load_registry():
        return jsonify({'error': 'Not found'}), 404
    f = _jobs_json_path(name)
    if not f.exists():
        return jsonify({'routines': []})
    try:
        jobs = json.loads(f.read_text()).get('jobs', [])
    except Exception:
        jobs = []
    out = []
    for j in jobs:
        sched = j.get('schedule_display') or j.get('schedule', '')
        if isinstance(sched, dict):
            sched = sched.get('display') or str(sched.get('run_at', ''))
        out.append({
            'id': j.get('job_id') or j.get('id'),
            'name': j.get('name') or 'untitled',
            'schedule': sched,
            'next_run': j.get('next_run_at'),
            'enabled': j.get('enabled', True),
            'last_status': j.get('last_status'),
            'prompt': (j.get('prompt') or '')[:200],
        })
    out.sort(key=lambda j: j.get('next_run') or '')
    return jsonify({'routines': out})


@bp.route('/api/bots/<name>/routines', methods=['POST'])
def create_routine(name):
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name) or name not in _load_registry():
        return jsonify({'error': 'Not found'}), 404
    data = request.get_json(silent=True) or {}
    rname = (data.get('name') or '').strip()[:60] or 'routine'
    schedule = (data.get('schedule') or '').strip()
    prompt = (data.get('prompt') or '').strip()
    # Passed to hermes as argv (no shell), so letters are fine — just cap it
    if not re.match(r'^[\w\s:,\*\/-]+$', schedule) or len(schedule) > 40:
        return jsonify({'error': 'Schedule looks invalid (try "30m", "every 2h", or "0 9 * * *")'}), 400
    if not prompt or len(prompt) > 2000:
        return jsonify({'error': 'Prompt required (max 2000 chars)'}), 400
    # Cron scheduler runs inside each profile's gateway process.
    # Bot profiles have their own gateways running, so create directly.
    rc, out, err = _run_hermes(['-p', name, 'cron', 'create', '--name', rname,
                                '--deliver', 'local', schedule, prompt], timeout=60, profile=name)
    if rc != 0:
        return jsonify({'error': 'Failed to create routine', 'detail': (err or out)[-300:]}), 500
    m = re.search(r'Created job: ([0-9a-f]+)', out)
    return jsonify({'ok': True, 'job_id': m.group(1) if m else None})


@bp.route('/api/bots/<name>/routines/<job_id>', methods=['DELETE'])
def delete_routine(name, job_id):
    if not HERMES_HOME:
        return _not_configured()
    if not _profile_ok(name) or name not in _load_registry():
        return jsonify({'error': 'Not found'}), 404
    if not re.match(r'^[0-9a-f]+$', job_id):
        return jsonify({'error': 'Bad job id'}), 400
    # Job lives on the bot's own profile cron (gateway runs there)
    rc, out, err = _run_hermes(['-p', name, 'cron', 'remove', job_id], timeout=60, profile=name)
    if rc != 0:
        return jsonify({'error': 'Failed to remove', 'detail': (err or out)[-300:]}), 500
    return jsonify({'ok': True})
