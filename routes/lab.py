"""Lab overview: this machine + paired devices on one screen.

Paired devices (full DeCloud with sharing on, or the standalone agent) run
lab_report.LabServer: pinned HTTPS + Bluetooth-style pairing. This module is
the hub side (discover, pair, poll) plus the device side's approval prompts
and on/off switch. DeCloud itself stays localhost-only; the lab port opens
only while "Let other devices add this computer" is on.
"""
import os
import platform
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

import lab_report
from shared import BASE_DIR, load_settings, save_settings

bp = Blueprint('lab', __name__)
_pool = ThreadPoolExecutor(max_workers=8)
STYLES = ('neofetch', 'rack', 'constellation')
LAB_PORT = int(os.environ.get('DECLOUD_LAB_PORT', lab_report.AGENT_PORT))
_state = None
_server = None
_server_lock = threading.Lock()
_requests_in = {}   # device side: pairing prompts waiting for Allow/Deny
_jobs = {}          # hub side: pairings in progress


def state():
    global _state
    if _state is None:
        _state = lab_report.State(BASE_DIR / 'lab-state')
    return _state


def _prefs(settings):
    p = settings.get('lab') or {}
    return {
        'name': str(p.get('name') or platform.node() or 'my lab')[:24],
        'accent': p.get('accent') if re.fullmatch(r'#[0-9a-fA-F]{6}', str(p.get('accent'))) else '#ffb454',
        'style': p.get('style') if p.get('style') in STYLES else 'neofetch',
        'services': [s for s in p.get('services', []) if isinstance(s, str)][:20],
        'shareable': p.get('shareable') is True,
    }


# ─── Device side ─────────────────────────────────────────────────
def _approve(hub, number):
    """Called on a LabServer thread: park the request until someone taps Allow/Deny in the UI."""
    rid = uuid.uuid4().hex[:8]
    req = {'hub': hub, 'number': number, 'event': threading.Event(), 'ok': False, 't': time.time()}
    _requests_in[rid] = req
    req['event'].wait(lab_report.PAIR_TTL)
    _requests_in.pop(rid, None)
    return req['ok']


def sync_server():
    """Start or stop the lab port to match the 'shareable' setting."""
    global _server
    want = _prefs(load_settings())['shareable']
    with _server_lock:
        if want and not _server:
            try:
                _server = lab_report.LabServer(state(), platform.node(), lambda: lab_report.report(_prefs(load_settings())['services']),
                                               _approve, port=LAB_PORT).start()
            except OSError as e:
                print(f'[DeCloud] Lab sharing could not open port {LAB_PORT}: {e}')
                return False
        elif not want and _server:
            _server.stop()
            _server = None
    return True


@bp.route('/api/lab/pair-requests')
def pair_requests():
    now = time.time()
    return jsonify({'shareable': _server is not None,
                    'requests': [{'id': k, 'hub': r['hub'], 'number': r['number'], 'expires_in': int(lab_report.PAIR_TTL - (now - r['t']))}
                                 for k, r in list(_requests_in.items())]})


@bp.route('/api/lab/pair-requests/<rid>', methods=['POST'])
def answer_pair_request(rid):
    r = _requests_in.get(rid)
    if not r:
        return jsonify({'error': 'That request expired. Start again from the hub.'}), 404
    r['ok'] = (request.get_json(silent=True) or {}).get('allow') is True
    r['event'].set()
    return jsonify({'ok': True})


@bp.route('/api/lab/pair-code')
def pair_code():
    if not _prefs(load_settings())['shareable']:
        return jsonify({'error': 'Turn on "Let other devices add this computer" first.'}), 400
    url = request.args.get('url') or f'https://{lab_report.lan_ip()}:{LAB_PORT}'
    if not url.startswith('https://'):
        return jsonify({'error': 'Address must start with https://'}), 400
    return jsonify({'code': lab_report.pairing_code(url.rstrip('/'), state().token, platform.node(), state().fp), 'url': url})


@bp.route('/api/lab/reset-key', methods=['POST'])
def reset_key():
    """Revoke every hub that added this device; they must pair again."""
    state().reset_token()
    return jsonify({'ok': True})


@bp.route('/lab-agent.py')
def agent_file():
    # Public on purpose: it's this repo's own source, fetched by `curl` on the device being added.
    return send_file(Path(lab_report.__file__), mimetype='text/x-python', as_attachment=True,
                     download_name='decloud-agent.py')


# ─── Hub side ────────────────────────────────────────────────────
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


def _fetch(dev):
    if not dev.get('fp'):
        return {'error': 'Added with an old version — remove and add it again'}
    try:
        return _clean(lab_report.fetch_report(dev['url'], dev['token'], dev['fp']))
    except lab_report.PinError:
        return {'error': 'Identity changed — remove and add it again if you reinstalled it'}
    except PermissionError:
        return {'error': 'Key was reset — remove and add it again'}
    except (OSError, ValueError, TypeError, AttributeError):
        return {'error': 'Offline or unreachable'}


def _save_device(name, url, token, fp):
    settings = load_settings()
    devices = [d for d in settings.get('lab_devices', []) if d.get('fp') != fp and d['url'] != url]
    dev = {'id': uuid.uuid4().hex[:8], 'name': name[:40] or 'device', 'url': url, 'token': token, 'fp': fp}
    settings['lab_devices'] = devices + [dev]
    save_settings(settings)
    return dev


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
    if isinstance(data.get('shareable'), bool):
        p['shareable'] = data['shareable']
    settings['lab'] = p
    save_settings(settings)
    if 'shareable' in data and not sync_server():
        return jsonify({**p, 'error': f'Port {LAB_PORT} is in use by another program.'}), 409
    return jsonify(p)


@bp.route('/api/lab/discover', methods=['POST'])
def discover():
    known = {d.get('fp') for d in load_settings().get('lab_devices', [])}
    own = state().fp
    return jsonify([{**f, 'added': f['fp'] in known} for f in lab_report.discover(port=LAB_PORT) if f['fp'] != own])


@bp.route('/api/lab/pair', methods=['POST'])
def start_pair():
    data = request.get_json(silent=True) or {}
    ip, port = str(data.get('ip', '')), data.get('port', LAB_PORT)
    if not re.fullmatch(r'[0-9a-fA-F.:]{3,45}', ip) or not isinstance(port, int) or not 0 < port < 65536:
        return jsonify({'error': 'Bad address'}), 400
    host = f'[{ip}]' if ':' in ip else ip
    try:
        job = lab_report.pair_start(f'https://{host}:{port}', _prefs(load_settings())['name'])
    except (OSError, ValueError) as e:
        return jsonify({'error': f'Could not reach that device ({e}).'}), 400
    jid = uuid.uuid4().hex[:8]
    _jobs[jid] = {'state': 'waiting', 'number': job['number'], 'name': job['name'], 'kind': job['kind'], 't': time.time()}

    def finish():
        try:
            token = lab_report.pair_finish(job)
            _save_device(job['name'], job['url'], token, job['fp'])
            _jobs[jid]['state'] = 'done'
        except (OSError, PermissionError, lab_report.PinError) as e:
            _jobs[jid].update(state='failed', error=str(e) or 'Pairing failed')

    threading.Thread(target=finish, daemon=True).start()
    for k in [k for k, j in _jobs.items() if time.time() - j['t'] > 600]:
        _jobs.pop(k, None)
    return jsonify({'job': jid, 'number': job['number'], 'name': job['name'], 'kind': job['kind']})


@bp.route('/api/lab/pair/<jid>')
def pair_status(jid):
    j = _jobs.get(jid)
    if not j:
        return jsonify({'state': 'failed', 'error': 'Pairing expired'}), 404
    return jsonify({k: v for k, v in j.items() if k != 't'})


@bp.route('/api/lab/devices', methods=['POST'])
def add_device():
    """Manual fallback: paste a dcl1. code (remote / Tailscale)."""
    data = request.get_json(silent=True) or {}
    try:
        p = lab_report.parse_pairing_code(data.get('code'))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    test = _fetch({'url': p['u'], 'token': p['t'], 'fp': p['f']})
    if test.get('error'):
        return jsonify({'error': f"Couldn't reach {p['u']}: {test['error']}"}), 400
    dev = _save_device(p['n'], p['u'], p['t'], p['f'])
    return jsonify({'id': dev['id'], 'name': dev['name'], 'url': dev['url']})


@bp.route('/api/lab/devices/<dev_id>', methods=['DELETE'])
def remove_device(dev_id):
    settings = load_settings()
    settings['lab_devices'] = [d for d in settings.get('lab_devices', []) if d['id'] != dev_id]
    save_settings(settings)
    return jsonify({'ok': True})
