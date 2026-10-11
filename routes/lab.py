"""Lab overview: this machine + paired devices on one screen.

Each device (full DeCloud or the standalone lab_report.py agent) serves
/api/lab/report behind a read-only lab token. The hub polls them in
parallel and sums them up.
"""
import hmac
import re
import os
import platform
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests as _requests
from flask import Blueprint, jsonify, request, send_file

import lab_report
from shared import load_settings, save_settings, _is_authenticated

bp = Blueprint('lab', __name__)
_pool = ThreadPoolExecutor(max_workers=8)
STYLES = ('neofetch', 'rack', 'constellation')


def _lab_token(settings):
    if not settings.get('lab_token'):
        settings['lab_token'] = secrets.token_urlsafe(24)
        save_settings(settings)
    return settings['lab_token']


def _prefs(settings):
    p = settings.get('lab') or {}
    return {
        'name': str(p.get('name') or platform.node() or 'my lab')[:24],
        'accent': p.get('accent') if re.fullmatch(r'#[0-9a-fA-F]{6}', str(p.get('accent'))) else '#ffb454',
        'style': p.get('style') if p.get('style') in STYLES else 'neofetch',
        'services': [s for s in p.get('services', []) if isinstance(s, str)][:20],
    }


@bp.route('/api/lab/report')
def lab_report_route():
    # Exempt from the session gate in shared._require_auth: a paired hub
    # authenticates with the read-only lab token instead.
    settings = load_settings()
    auth = request.headers.get('Authorization', '')
    token_ok = settings.get('lab_token') and hmac.compare_digest(auth, f"Bearer {settings['lab_token']}")
    if not token_ok and not _is_authenticated():
        return jsonify({'error': 'Authentication required'}), 401
    return jsonify(lab_report.report(_prefs(settings)['services']))


@bp.route('/lab-agent.py')
def agent_file():
    # Public on purpose: it's this repo's own source, fetched by `curl` on the device being added.
    return send_file(Path(lab_report.__file__), mimetype='text/x-python', as_attachment=True,
                     download_name='decloud-agent.py')


@bp.route('/api/lab/pair-code')
def pair_code():
    settings = load_settings()
    port = os.environ.get('DECLOUD_PORT', '8899')
    url = request.args.get('url') or f'http://{lab_report.lan_ip()}:{port}'
    return jsonify({'code': lab_report.pairing_code(url.rstrip('/'), _lab_token(settings), platform.node()),
                    'url': url})


def _num(v, default=0):
    try:
        f = float(v)
        return f if f == f and abs(f) < 1e18 else default  # drop NaN / absurd values
    except (TypeError, ValueError):
        return default


def _str(v, n=80):
    return str(v)[:n] if v is not None else ''


def _clean(r):
    """Rebuild a peer's report from known fields with forced types.
    A peer is another machine: never pass its JSON through to the page as-is."""
    if not isinstance(r, dict):
        raise ValueError
    run = r.get('running') if isinstance(r.get('running'), dict) else {}
    lst = lambda k: [x for x in run.get(k, []) if isinstance(x, (dict, str))][:30] if isinstance(run.get(k), list) else []
    st = r.get('storage') if isinstance(r.get('storage'), dict) else {}
    return {
        'kind': 'agent' if r.get('kind') == 'agent' else 'decloud',
        'hostname': _str(r.get('hostname'), 64), 'os': _str(r.get('os')), 'kernel': _str(r.get('kernel')),
        'arch': _str(r.get('arch'), 20), 'cpu_name': _str(r.get('cpu_name')),
        'cores': int(_num(r.get('cores'))), 'cpu_percent': max(0, min(100, _num(r.get('cpu_percent')))),
        'load': None, 'temp': _num(r.get('temp'), None),
        'gpus': [{'name': _str(g.get('name')), 'vram_gb': _num(g.get('vram_gb'), None),
                  'util': _num(g.get('util'), None), 'temp': _num(g.get('temp'), None)}
                 for g in (r.get('gpus') or [])[:8] if isinstance(g, dict)],
        'ram_total': _num(r.get('ram_total')), 'ram_used': _num(r.get('ram_used')),
        'storage': {'total': _num(st.get('total')), 'used': _num(st.get('used')), 'volumes': int(_num(st.get('volumes')))},
        'uptime_s': int(_num(r.get('uptime_s'))),
        'running': {
            'containers': [{'name': _str(c.get('name')), 'image': _str(c.get('image'))} for c in lst('containers') if isinstance(c, dict)],
            'models': [_str(m) for m in lst('models') if isinstance(m, str)],
            'services': [{'name': _str(x.get('name')), 'active': x.get('active') is True} for x in lst('services') if isinstance(x, dict)],
            'processes': [{'name': _str(x.get('name'), 40), 'cpu': _num(x.get('cpu')), 'mem': _num(x.get('mem'))} for x in lst('processes') if isinstance(x, dict)],
        },
    }


@bp.route('/api/lab/reset-key', methods=['POST'])
def reset_key():
    """Revoke every hub that paired with this device; they must re-pair with the new code."""
    settings = load_settings()
    settings['lab_token'] = secrets.token_urlsafe(24)
    save_settings(settings)
    return jsonify({'ok': True})


def _fetch(dev):
    try:
        r = _requests.get(dev['url'] + '/api/lab/report', timeout=4,
                          headers={'Authorization': f"Bearer {dev['token']}"})
        if r.status_code == 401:
            return {'error': 'Key rejected — pair this device again'}
        r.raise_for_status()
        return _clean(r.json())
    except _requests.RequestException:
        return {'error': 'Offline or unreachable'}
    except (ValueError, AttributeError, TypeError):
        return {'error': 'Not a DeCloud device'}


def _totals(nodes):
    up = [n for n in nodes if not n.get('error')]
    cores = sum(n['cores'] for n in up) or 1
    return {
        'nodes': len(nodes),
        'online': len(up),
        'cores': sum(n['cores'] for n in up),
        'cpu_percent': round(sum(n['cpu_percent'] * n['cores'] for n in up) / cores, 1),
        'ram_total': sum(n['ram_total'] for n in up),
        'ram_used': sum(n['ram_used'] for n in up),
        'storage_total': sum(n['storage']['total'] for n in up),
        'storage_used': sum(n['storage']['used'] for n in up),
        'gpus': [g['name'] for n in up for g in n['gpus']],
        'vram_gb': round(sum(g['vram_gb'] or 0 for n in up for g in n['gpus']), 1),
        'uptime_s': max((n['uptime_s'] for n in up), default=0),
    }


@bp.route('/api/lab/overview')
def overview():
    settings = load_settings()
    prefs = _prefs(settings)
    devices = settings.get('lab_devices', [])
    futures = [_pool.submit(_fetch, d) for d in devices]
    nodes = [{**lab_report.report(prefs['services']), 'id': 'self', 'name': platform.node(), 'hub': True}]
    for d, f in zip(devices, futures):
        nodes.append({**f.result(), 'id': d['id'], 'name': d['name']})
    return jsonify({'prefs': prefs, 'nodes': nodes, 'totals': _totals(nodes)})


@bp.route('/api/lab/prefs', methods=['POST'])
def set_prefs():
    data = request.get_json(silent=True) or {}
    settings = load_settings()
    p = _prefs(settings)
    if isinstance(data.get('name'), str) and data['name'].strip():
        p['name'] = data['name'].strip()[:24]
    if isinstance(data.get('accent'), str) and re.fullmatch(r'#[0-9a-fA-F]{6}', data['accent']):
        p['accent'] = data['accent']
    if data.get('style') in STYLES:
        p['style'] = data['style']
    if isinstance(data.get('services'), str):
        p['services'] = [s for s in data['services'].replace(',', ' ').split() if s][:20]
    settings['lab'] = p
    save_settings(settings)
    return jsonify(p)


@bp.route('/api/lab/devices')
def list_devices():
    return jsonify([{'id': d['id'], 'name': d['name'], 'url': d['url']}
                    for d in load_settings().get('lab_devices', [])])


@bp.route('/api/lab/devices', methods=['POST'])
def add_device():
    data = request.get_json(silent=True) or {}
    try:
        p = lab_report.parse_pairing_code(data.get('code'))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    dev = {'id': uuid.uuid4().hex[:8], 'name': (data.get('name') or p['n'] or 'device').strip()[:40],
           'url': p['u'], 'token': p['t']}
    test = _fetch(dev)
    if test.get('error'):
        return jsonify({'error': f"Couldn't reach {p['u']}: {test['error']}"}), 400
    settings = load_settings()
    devices = [d for d in settings.get('lab_devices', []) if d['url'] != dev['url']]
    settings['lab_devices'] = devices + [dev]
    save_settings(settings)
    return jsonify({'id': dev['id'], 'name': dev['name'], 'url': dev['url']})


@bp.route('/api/lab/devices/<dev_id>', methods=['DELETE'])
def remove_device(dev_id):
    settings = load_settings()
    settings['lab_devices'] = [d for d in settings.get('lab_devices', []) if d['id'] != dev_id]
    save_settings(settings)
    return jsonify({'ok': True})
