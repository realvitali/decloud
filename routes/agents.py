"""Agents (Hermes profiles) management routes.

Optional module. Set DECLOUD_HERMES_HOME in .env to your Hermes home
directory (e.g. ~/.hermes) to enable. If not configured, endpoints
return helpful errors.

The agent list is discovered dynamically from the Hermes home:
  - profiles/    -> named agent personalities
  - config.yaml  -> enabled platforms + default model
  - channel_directory.json -> channels/contacts per platform
"""
import os, json, re, shutil, subprocess
from pathlib import Path
from flask import Blueprint, jsonify, request

bp = Blueprint('agents', __name__)

HERMES_HOME = os.environ.get('DECLOUD_HERMES_HOME', '').rstrip('/')


def _not_configured():
    return jsonify({
        'error': 'Hermes not configured. Set DECLOUD_HERMES_HOME in .env.'
    }), 503


def _hermes_bin():
    """Locate the hermes CLI: HERMES_HOME/hermes-agent/venv/bin/hermes or PATH."""
    cand = os.path.join(HERMES_HOME, 'hermes-agent', 'venv', 'bin', 'hermes')
    if os.path.exists(cand):
        return cand
    return shutil.which('hermes') or 'hermes'


def _load_yaml(path):
    try:
        import yaml
        with open(path) as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _load_json(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return {}


def _hermes_config():
    return _load_yaml(Path(HERMES_HOME) / 'config.yaml')


def _enabled_platforms():
    cfg = _hermes_config()
    platforms = cfg.get('platforms') or {}
    return [p for p, c in platforms.items() if isinstance(c, dict) and c.get('enabled')]


def _default_model():
    cfg = _hermes_config()
    return (cfg.get('model') or {}).get('default', '')


def _discover_profiles():
    """Named profiles under profiles/, plus 'default' for the root SOUL.md."""
    names = []
    profiles_dir = Path(HERMES_HOME) / 'profiles'
    if profiles_dir.is_dir():
        names = sorted(d.name for d in profiles_dir.iterdir() if d.is_dir())
    if (Path(HERMES_HOME) / 'SOUL.md').exists():
        names.insert(0, 'default')
    return names


def _load_jobs(profile_name):
    """Cron jobs for a profile. Newer Hermes stores cron in SQLite, so this
    returns [] unless a jobs.json exists (pre-profile-isolation layout)."""
    for p in (Path(HERMES_HOME) / 'profiles' / profile_name / 'cron' / 'jobs.json',
              Path(HERMES_HOME) / 'cron' / 'jobs.json'):
        if p.exists():
            data = _load_json(p)
            return data.get('jobs', []) if isinstance(data, dict) else []
    return []


def _job_status(jobs):
    if any(j.get('last_status') == 'error' for j in jobs):
        return 'error'
    if any(j.get('state') == 'paused' for j in jobs):
        return 'paused'
    return 'ready'


@bp.route('/api/agents/jobs/<job_id>/<action>', methods=['POST'])
def toggle_job(job_id, action):
    if action not in ('pause', 'resume'):
        return jsonify({'error': 'Must be pause or resume'}), 400
    if not HERMES_HOME:
        return _not_configured()
    profile = request.args.get('profile', 'default')
    # Validate job_id (alphanumeric + dash/underscore only, no shell metachars)
    if not re.match(r'^[a-zA-Z0-9_-]+$', job_id):
        return jsonify({'error': 'Invalid job ID'}), 400
    env = dict(os.environ, HERMES_HOME=HERMES_HOME)
    try:
        result = subprocess.run([_hermes_bin(), '-p', profile, 'cron', action, job_id],
                                capture_output=True, text=True, env=env, timeout=30)
    except FileNotFoundError:
        return jsonify({'ok': False, 'error': 'hermes binary not found'}), 503
    return jsonify({'ok': result.returncode == 0, 'output': result.stdout, 'error': result.stderr})


@bp.route('/api/agents/logs', methods=['GET'])
def get_agent_logs():
    import datetime
    if not HERMES_HOME:
        return _not_configured()

    try:
        n = int(request.args.get('n', 20))
    except (TypeError, ValueError):
        n = 20
    events = []
    log_file = Path(HERMES_HOME) / 'logs' / 'gateway.log'
    if not log_file.exists():
        return jsonify({'events': []})

    with open(log_file) as f:
        lines = f.readlines()

    for line in lines[-2000:]:
        try:
            if '{' in line:
                continue
            info_marker = line.find('INFO ')
            if info_marker == -1:
                continue
            rest = line[info_marker + 5:].rstrip()
            ts_part = line[:19]

            if 'Sending response' in rest:
                try:
                    ts = datetime.datetime.strptime(ts_part, '%Y-%m-%d %H:%M:%S')
                    chars = rest.split('(')[1].split(')')[0] if '(' in rest else '?'
                    bracket = rest.find('] ')
                    text = rest[bracket+2:].split(' to ')[0] if bracket > 0 else rest
                    text = f'response ({chars})'
                    events.append({'ts': ts.isoformat(), 'dir': 'out', 'chars': chars, 'text': text})
                except:
                    pass
            elif 'inbound message' in rest:
                try:
                    ts = datetime.datetime.strptime(ts_part, '%Y-%m-%d %H:%M:%S')
                    msg_start = rest.find("msg='") + 5
                    msg_end = rest.find("'", msg_start)
                    msg = rest[msg_start:msg_end][:100] if msg_start > 4 else rest[:80]
                    events.append({'ts': ts.isoformat(), 'dir': 'in', 'text': msg})
                except:
                    pass
        except:
            pass

    events.reverse()
    return jsonify({'events': events[:n]})


@bp.route('/api/agents', methods=['GET'])
def get_agents():
    if not HERMES_HOME:
        return _not_configured()

    platforms = _enabled_platforms()
    model = _default_model()
    channels = _load_json(Path(HERMES_HOME) / 'channel_directory.json')
    channels = channels.get('platforms', {}) if isinstance(channels, dict) else {}

    agents = []
    for name in _discover_profiles():
        jobs = _load_jobs(name)
        agents.append({
            'id': name,
            'name': name,
            'profile': name,
            'platforms': platforms,
            'platform': ', '.join(platforms),
            'model': model,
            'status': _job_status(jobs),
            'jobs': jobs,
        })

    # This workstation (DeCloud) is always present and always-on.
    agents.append({
        'id': 'decloud',
        'name': 'DeCloud',
        'profile': 'local',
        'platforms': [],
        'platform': 'this machine',
        'model': '',
        'status': 'ready',
        'jobs': [],
    })

    return jsonify({
        'agents': agents,
        'platforms': channels,
        'default': {'jobs': _load_jobs('default') or _load_jobs('agent2')},
    })
