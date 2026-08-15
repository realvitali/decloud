"""Agents (Hermes cron jobs) management routes.

Optional module. Set DECLOUD_HERMES_HOME in .env to your .hermes directory
to enable. If not configured, endpoints return helpful errors.
"""
import os, json, subprocess
from pathlib import Path
from flask import Blueprint, jsonify, request

bp = Blueprint('agents', __name__)

HERMES_HOME = os.environ.get('DECLOUD_HERMES_HOME', '')

def _not_configured():
    return jsonify({
        'error': 'Hermes not configured. Set DECLOUD_HERMES_HOME in .env.'
    }), 503

@bp.route('/api/agents/jobs/<job_id>/<action>', methods=['POST'])
def toggle_job(job_id, action):
    if action not in ('pause', 'resume'):
        return jsonify({'error': 'Must be pause or resume'}), 400
    if not HERMES_HOME:
        return _not_configured()
    profile = request.args.get('profile', 'agent2')
    hermes_bin = os.path.join(os.path.dirname(HERMES_HOME), 'hermes-agent', 'venv', 'bin', 'hermes')
    # Validate job_id (alphanumeric + dash/underscore only, no shell metachars)
    import re
    if not re.match(r'^[a-zA-Z0-9_-]+$', job_id):
        return jsonify({'error': 'Invalid job ID'}), 400
    env = dict(os.environ, HERMES_HOME=HERMES_HOME)
    result = subprocess.run([hermes_bin, 'cron', action, job_id], capture_output=True, text=True, env=env)
    return jsonify({'ok': result.returncode == 0, 'output': result.stdout, 'error': result.stderr})


@bp.route('/api/agents/logs', methods=['GET'])
def get_agent_logs():
    import datetime
    if not HERMES_HOME:
        return _not_configured()

    n = int(request.args.get('n', 20))
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

    def load_jobs(profile_name):
        jobs_file = Path(HERMES_HOME) / 'cron' / 'jobs.json'
        if not jobs_file.exists():
            return []
        with open(jobs_file) as f:
            data = json.load(f)
        return data.get('jobs', [])

    def job_status(jobs):
        has_error = any(j.get('last_status') == 'error' for j in jobs)
        has_paused = any(j.get('state') == 'paused' for j in jobs)
        if has_error:
            return 'error'
        elif has_paused:
            return 'paused'
        return 'ready'

    jobs = load_jobs('default')

    return jsonify({
        'agents': [],
        'default': {'jobs': jobs},
    })
