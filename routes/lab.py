"""Lab overview: this machine + paired devices on one screen.

Each device (full DeCloud or the standalone lab_report.py agent) serves
/api/lab/report behind a read-only lab token. The hub polls them in
parallel and sums them up.
"""
import hmac
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
        'accent': p.get('accent') or '#ffb454',
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


def _fetch(dev):
    try:
        r = _requests.get(dev['url'] + '/api/lab/report', timeout=4,
                          headers={'Authorization': f"Bearer {dev['token']}"})
        if r.status_code == 401:
            return {'error': 'Key rejected — pair this device again'}
        r.raise_for_status()
        return r.json()
    except _requests.RequestException:
        return {'error': 'Offline or unreachable'}
    except ValueError:
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
    if isinstance(data.get('accent'), str) and len(data['accent']) == 7 and data['accent'].startswith('#'):
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
