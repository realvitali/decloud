"""Lab overview: this machine + paired devices on one screen.

Paired devices (full DeCloud with sharing on, or the standalone agent) run
lab_report.LabServer: pinned HTTPS + Bluetooth-style pairing. This module is
the hub side (discover, pair, poll) plus the device side's approval prompts
and on/off switch. DeCloud itself stays localhost-only; the lab port opens
only while "Let other devices add this computer" is on.
"""
import base64
import json
import hashlib
import os
import ipaddress
import platform
import re
import threading
import time
import uuid
from urllib.parse import urlsplit
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

import lab_report
from .devices import _tailscale_status
from shared import BASE_DIR, limiter, load_settings, save_settings

bp = Blueprint('lab', __name__)
_pool = ThreadPoolExecutor(max_workers=8)
_settings_rw = threading.RLock()  # every Lab settings change is load→modify→save under this, so writers can't undo each other
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


# Appearance choices for the Lab screen (the page has the matching fonts and colors)
LAB_FONTS = ('bold', 'grotesk', 'wide', 'scifi', 'tech', 'syne', 'bricolage', 'archivo', 'poster', 'outfit', 'sora', 'michroma', 'tall', 'round')
LAB_ACCENTS = ('amber', 'green', 'ice', 'mono')
LAB_VIEWS = ('3d', 'classic')


def _prefs(settings):
    p = settings.get('lab') or {}
    return {
        'name': str(p.get('name') or 'my lab')[:24],
        'device_name': str(p.get('device_name') or platform.node() or 'this computer')[:40],
        'services': [s for s in p.get('services', []) if isinstance(s, str)][:20],
        'shareable': p.get('shareable') is True,
        'font': p.get('font') if p.get('font') in LAB_FONTS else LAB_FONTS[0],
        'accent': p.get('accent') if p.get('accent') in LAB_ACCENTS else LAB_ACCENTS[0],
        'view': p.get('view') if p.get('view') in LAB_VIEWS else LAB_VIEWS[0],
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
                _server = lab_report.LabServer(state(), _prefs(load_settings())['device_name'], lambda: lab_report.report(_prefs(load_settings())['services']),
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
    return jsonify({'code': lab_report.pairing_code(url.rstrip('/'), state().token, _prefs(load_settings())['device_name'], state().fp), 'url': url})


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


MODEL_NAME = re.compile(r'[A-Za-z0-9._:/@+-]{1,200}')


def _clean_ollama(o):
    if not isinstance(o, dict):
        return {'ok': False, 'installed': [], 'loaded': []}
    rows = lambda k, n: [m for m in (o.get(k) or [])[:n] if isinstance(m, dict) and MODEL_NAME.fullmatch(str(m.get('name', '')))]
    return {
        'ok': o.get('ok') is True,
        'installed': [{'name': str(m['name']), 'size': _num(m.get('size'))} for m in rows('installed', 100)],
        'loaded': [{'name': str(m['name']), 'size': _num(m.get('size')), 'size_vram': _num(m.get('size_vram'))} for m in rows('loaded', 20)],
    }


def _clean_device(r):
    d = r.get('device') if isinstance(r.get('device'), dict) else {}
    kind = d.get('type') if d.get('type') in lab_report.DEVICE_TYPES else 'computer'
    if kind == 'computer' and any('GB10' in str(g.get('name', '')) for g in r.get('gpus') or [] if isinstance(g, dict)):
        kind = 'spark'  # older agents don't say; the GB10 chip only ships in DGX Spark-class boxes
    return {'type': kind, 'model': _str(d.get('model'), 60) or ('NVIDIA DGX Spark' if kind == 'spark' else '')}


def _clean_power(p):
    if not isinstance(p, dict) or not isinstance(p.get('parts'), dict):
        return None
    parts = {k: round(max(0, min(5000, _num(p['parts'].get(k)))), 1) for k in ('gpu', 'cpu', 'battery') if p['parts'].get(k) is not None}
    return {'watts': round(max(0, min(20000, _num(p.get('watts')))), 1), 'parts': parts} if parts else None


def _spec(r):
    """What a device brings to the lab, kept so it still counts (dimmed) while offline."""
    unified = not any(g.get('vram_gb') for g in r['gpus'])
    return {'model': r['device'].get('model', ''), 'cores': r['cores'], 'ram_total': r['ram_total'],
            'storage_total': r['storage']['total'],
            'gpu_mem_gb': round(sum(g.get('vram_gb') or 0 for g in r['gpus']) or (r['ram_total'] / 1e9 if r['gpus'] and unified else 0), 1)}


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
                  'util': _num(g.get('util'), None), 'temp': _num(g.get('temp'), None),
                  'mem_used_gb': _num(g.get('mem_used_gb'), None)}
                 for g in (r.get('gpus') or [])[:8] if isinstance(g, dict)],
        'ram_total': _num(r.get('ram_total')), 'ram_used': _num(r.get('ram_used')),
        'storage': {'total': _num(st.get('total')), 'used': _num(st.get('used')), 'volumes': int(_num(st.get('volumes')))},
        'uptime_s': int(_num(r.get('uptime_s'))),
        'agent_version': int(_num(r.get('agent_version'))),
        'device': _clean_device(r),
        'ollama': _clean_ollama(r.get('ollama')),
        'apps': [a for a in (r.get('apps') or [])[:40] if a in lab_report.APPS] if isinstance(r.get('apps'), list) else [],
        'power': _clean_power(r.get('power')),
        'auto_update': r.get('auto_update') is True,
        'running': {
            'containers': [{'name': _str(c.get('name')), 'image': _str(c.get('image'))} for c in lst('containers') if isinstance(c, dict)],
            'models': [_str(m) for m in lst('models') if isinstance(m, str)],
            'services': [{'name': _str(x.get('name')), 'active': x.get('active') is True} for x in lst('services') if isinstance(x, dict)],
            'processes': [{'name': _str(x.get('name'), 40), 'cpu': _num(x.get('cpu')), 'mem': _num(x.get('mem'))} for x in lst('processes') if isinstance(x, dict)],
        },
    }


_reports = {}  # dev id -> (time, cleaned report): lets AI apps pick a device without re-polling


def cached_report(dev_id, max_age=20):
    hit = _reports.get(dev_id)
    return hit[1] if hit and time.time() - hit[0] < max_age else None


_last_good = {}   # dev id -> last good report: an offline device keeps its picture
_retrying = set()
OFFLINE_RETRY = 20  # seconds an unreachable device is answered from memory


def _fetch(dev):
    did = dev.get('id')
    hit = _reports.get(did) if did else None
    if hit and hit[1].get('error') and time.time() - hit[0] < OFFLINE_RETRY:
        if did not in _retrying:  # retry in the background; don't make the page wait on a dead device
            _retrying.add(did)
            _pool.submit(_refetch, dev)
        return hit[1]
    return _refetch(dev)


_inflight, _inflight_lock = set(), threading.Lock()


def _refetch(dev):
    did = dev.get('id')
    with _inflight_lock:   # one read per device at a time: a slow peer can't pile up workers
        busy = did in _inflight
        if not busy and did:
            _inflight.add(did)
    if busy:
        hit = _reports.get(did)
        return hit[1] if hit else {'error': 'Offline or unreachable'}
    try:
        r = _fetch_uncached(dev)
        if r.get('error'):
            last = dev.get('last') if isinstance(dev.get('last'), dict) else {}
            known = _last_good.get(did, {}).get('device') or ({'type': dev['device_type'], 'model': str(last.get('model', ''))[:60]}
                                                              if dev.get('device_type') in lab_report.DEVICE_TYPES else None)
            if known:
                r = {**r, 'device': known}
            if last:
                r = {**r, 'last': last}
        elif did:
            _last_good[did] = r
            _maybe_update(dev, r)
            spec = _spec(r)
            if r['device']['type'] != dev.get('device_type') or spec != dev.get('last'):
                _remember(did, r['device']['type'], spec)
        if did:
            _reports[did] = (time.time(), r)
        return r
    finally:
        _retrying.discard(did)
        with _inflight_lock:
            _inflight.discard(did)


def _fetch_uncached(dev):
    if not dev.get('fp'):
        return {'error': 'Added with an old version — remove and add it again'}
    try:
        return _clean(lab_report.fetch_report(dev['url'], dev['token'], dev['fp']))
    except lab_report.PinError:
        return {'error': 'Identity changed — remove and add it again if you reinstalled it'}
    except PermissionError:
        return {'error': 'Key was reset — remove and add it again'}
    except Exception:   # anything a broken or hostile peer sends must not take the Lab page down
        return {'error': 'Offline or unreachable'}


# ─── Signed agent updates ──────────────────────────────────────────
# The hub hands a device the agent file plus the release record signed on the
# maintainer's machine; the device checks the signature itself and refuses
# anything else, so a compromised hub still can't run its own code there.
_update_tried = {}  # dev id -> time of the last automatic attempt
UPDATE_RETRY = 3600


def agent_release():
    """(payload, '') with the signed agent for this DeCloud version, or (None, why not).
    Devices accept nothing unsigned, so without a release key there is nothing to push."""
    from routes import update
    from routes.version import VERSION
    if not update.signing_enabled():
        return None, 'Updating devices from DeCloud needs signed releases (scripts/sign_release.py init). Until then, run the setup command on the device.'
    rel = update.verified_release('v' + VERSION)
    if not rel['ok']:
        return None, f'DeCloud v{VERSION} has no signed release, so it cannot update devices.'
    agent = Path(lab_report.__file__).read_bytes()
    if hashlib.sha256(agent).hexdigest() != rel['manifest']['agent_sha256']:
        return None, "This hub's copy of the agent differs from the signed release."
    return {'agent': base64.b64encode(agent).decode(), 'manifest': rel['raw'].decode(), 'sig': rel['sig'].decode()}, ''


def push_update(dev):
    payload, why = agent_release()
    if not payload:
        return 409, why
    try:
        status, data = lab_report.call(dev['url'], dev['token'], dev['fp'], 'POST', '/api/lab/update', payload, timeout=90)
    except (OSError, ValueError) as e:
        return 502, f'Could not reach the device ({e}).'
    if status == 404:
        return 409, 'This device runs an agent from before automatic updates. Run the setup command on it once.'
    return status, (data or {}).get('message') or (data or {}).get('error') or f'Device answered {status}.'


def _maybe_update(dev, r):
    did, now = dev.get('id'), time.time()
    if (r.get('kind') == 'agent' and r.get('auto_update') and r.get('agent_version', 0) < lab_report.AGENT_VERSION
            and now - _update_tried.get(did, 0) > UPDATE_RETRY):
        _update_tried[did] = now
        _pool.submit(push_update, dev)


def _remember(dev_id, kind, spec):
    """Keep what kind of machine a device is and what it brings, so it keeps its
    picture and its place in the totals while offline."""
    with _settings_rw:   # load→change→save as one step
        settings = load_settings()
        for d in settings.get('lab_devices', []):
            if d.get('id') == dev_id:
                d['device_type'] = kind
                d['last'] = spec
                save_settings(settings)
                return


def _addr(dev):
    try:
        return urlsplit(dev.get('url', '')).hostname or ''
    except ValueError:
        return ''


def paired_devices():
    return [d for d in load_settings().get('lab_devices', []) if d.get('fp') and d.get('token')]


def find_device(dev_id):
    return next((d for d in paired_devices() if d.get('id') == dev_id), None)


def _save_device(name, url, token, fp):
    with _settings_rw:   # load→change→save as one step
        settings = load_settings()
        devices = [d for d in settings.get('lab_devices', []) if d.get('fp') != fp and d['url'] != url]
        dev = {'id': uuid.uuid4().hex[:8], 'name': name[:40] or 'device', 'url': url, 'token': token, 'fp': fp}
        settings['lab_devices'] = devices + [dev]
        save_settings(settings)
    return dev


def _avg(vals):
    return round(sum(vals) / len(vals)) if vals else None


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
        # Unified-memory GPUs (DGX Spark, Apple) use system RAM as GPU memory.
        'unified_gb': round(sum(n['ram_total'] for n in up if n['gpus'] and not any(g['vram_gb'] for g in n['gpus'])
                                and str(n.get('arch', '')).lower() in ('aarch64', 'arm64')) / 1e9),
        'gpu_util': _avg([g['util'] for n in up for g in n['gpus'] if g.get('util') is not None]),
        'models_loaded': sum(len((n.get('ollama') or {}).get('loaded', [])) for n in up),
        'uptime_s': max((n['uptime_s'] for n in up), default=0),
        'power_w': round(sum((n.get('power') or {}).get('watts', 0) for n in up), 1),
        'power_devices': sum(1 for n in up if n.get('power')),
        'offline': {k: sum(_num((n.get('last') or {}).get(k)) for n in nodes if n.get('error'))
                    for k in ('cores', 'ram_total', 'storage_total', 'gpu_mem_gb')},
    }


@bp.route('/api/lab/overview')
def overview():
    settings = load_settings()
    prefs = _prefs(settings)
    devices = settings.get('lab_devices', [])
    futures = [_pool.submit(_fetch, d) for d in devices]
    own = lab_report.report(prefs['services'])
    _reports['self'] = (time.time(), own)
    nodes = [{**own, 'id': 'self', 'name': prefs['device_name'], 'hub': True}]
    for d, f in zip(devices, futures):
        nodes.append({**f.result(), 'id': d['id'], 'name': d['name'], 'address': _addr(d)})
    return jsonify({'prefs': prefs, 'nodes': nodes, 'phones': _phone_nodes(settings), 'totals': _totals(nodes)})


@bp.route('/api/lab/prefs', methods=['GET', 'POST'])
def set_prefs():
    if request.method == 'GET':
        return jsonify(_prefs(load_settings()))
    data = request.get_json(silent=True) or {}
    with _settings_rw:   # load→change→save as one step
        settings = load_settings()
        p = _prefs(settings)
        if isinstance(data.get('name'), str) and data['name'].strip():
            p['name'] = data['name'].strip()[:24]
        if isinstance(data.get('device_name'), str) and data['device_name'].strip():
            p['device_name'] = data['device_name'].strip()[:40]
        if isinstance(data.get('services'), str):
            p['services'] = [s for s in data['services'].replace(',', ' ').split() if s][:20]
        if data.get('font') in LAB_FONTS:
            p['font'] = data['font']
        if data.get('accent') in LAB_ACCENTS:
            p['accent'] = data['accent']
        if data.get('view') in LAB_VIEWS:
            p['view'] = data['view']
        if isinstance(data.get('shareable'), bool):
            p['shareable'] = data['shareable'] is True
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


def _tailnet_peers():
    """Return only real devices belonging to this tailnet, not exit nodes."""
    status = _tailscale_status()
    own = status.get('Self') or {}
    suffix = str(status.get('MagicDNSSuffix') or '').rstrip('.').lower()
    if not own or status.get('BackendState') not in (None, 'Running'):
        return None, []
    owner = own.get('UserID')
    known = set()
    settings = load_settings()
    for device in settings.get('lab_devices', []):
        try:
            known.add(urlsplit(device.get('url', '')).hostname)
        except ValueError:
            continue
    known.update(ph.get('ip') for ph in settings.get('lab_phones', []))
    peers = []
    for peer in (status.get('Peer') or {}).values():
        if not isinstance(peer, dict):
            continue
        dns = str(peer.get('DNSName') or '').rstrip('.').lower()
        same_owner = owner is not None and peer.get('UserID') == owner
        same_tailnet = bool(suffix and dns.endswith('.' + suffix))
        if not (same_owner or same_tailnet):
            continue
        ip = None
        for candidate in peer.get('TailscaleIPs') or []:
            try:
                parsed = ipaddress.ip_address(candidate)
                if parsed.version == 4 and parsed in ipaddress.ip_network('100.64.0.0/10'):
                    ip = str(parsed)
                    break
            except (ValueError, TypeError):
                continue
        if not ip:
            continue
        peers.append({'name': str(peer.get('HostName') or dns.split('.')[0] or ip)[:80],
                      'ip': ip, 'os': str(peer.get('OS') or '')[:40],
                      'online': bool(peer.get('Online')), 'added': ip in known,
                      'last_seen': str(peer.get('LastSeen') or '')[:40]})
    peers.sort(key=lambda p: (not p['online'], p['name'].lower()))
    return own, peers


# ─── Phones ──────────────────────────────────────────────────────
# Phones can't run the agent, so they join the lab as Tailscale peers only:
# name, kind and online status come from `tailscale status`. No token, no access.
PHONE_OS = {'ios': 'iphone', 'android': 'android'}


def _phone_nodes(settings):
    phones = settings.get('lab_phones', [])
    if not phones:
        return []
    _, peers = _tailnet_peers()
    by_ip = {p['ip']: p for p in peers}
    out = []
    for ph in phones:
        peer = by_ip.get(ph.get('ip'), {})
        out.append({'id': ph['id'], 'name': ph['name'], 'ip': ph['ip'], 'kind': 'phone', 'os': ph.get('os', ''),
                    'device': {'type': PHONE_OS.get(str(ph.get('os', '')).lower(), 'iphone'), 'model': ''},
                    'online': bool(peer.get('online')), 'last_seen': peer.get('last_seen', '')})
    return out


@bp.route('/api/lab/phones', methods=['POST'])
def add_phone():
    ip = str((request.get_json(silent=True) or {}).get('ip') or '')
    own, peers = _tailnet_peers()
    if own is None:
        return jsonify({'error': 'Tailscale is not connected on this host.'}), 503
    peer = next((p for p in peers if p['ip'] == ip), None)
    if not peer or peer['os'].lower() not in PHONE_OS:
        return jsonify({'error': 'That is not a phone on your Tailscale network.'}), 400
    with _settings_rw:   # load→change→save as one step
        settings = load_settings()
        phones = settings.get('lab_phones', [])
        if any(ph.get('ip') == ip for ph in phones):
            return jsonify({'error': 'That phone is already in your lab.'}), 409
        phone = {'id': 'ph-' + uuid.uuid4().hex[:10], 'name': peer['name'][:40], 'ip': ip, 'os': peer['os']}
        settings['lab_phones'] = phones + [phone]
        save_settings(settings)
    return jsonify(phone)


_host_cache = {'t': 0.0, 'url': ''}


def _host_url():
    """This hub's private Tailscale HTTPS address, or '' if Tailscale isn't up.
    Cached briefly: the public /lab-node.sh calls it, and each call runs tailscale."""
    if time.time() - _host_cache['t'] < 30:
        return _host_cache['url']
    status = _tailscale_status()
    dns = str((status.get('Self') or {}).get('DNSName') or '').rstrip('.').lower()
    url = f'https://{dns}' if re.fullmatch(r'[a-z0-9.-]+\.ts\.net', dns) else ''
    _host_cache.update(t=time.time(), url=url)
    return url


@bp.route('/api/lab/tailnet')
def tailnet_devices():
    own, peers = _tailnet_peers()
    if own is None:
        return jsonify({'error': 'Tailscale is not connected on this host.'}), 503
    dns = str(own.get('DNSName') or '').rstrip('.').lower()
    host_url = f'https://{dns}' if re.fullmatch(r'[a-z0-9.-]+\.ts\.net', dns) else ''
    return jsonify({'devices': peers, 'host_url': host_url,
                    'command': f'curl -fsSL {host_url}/lab-node.sh | sh' if host_url else ''})


NODE_SCRIPT = r"""#!/bin/sh
# DeCloud node setup. Installs the small DeCloud agent for this user (no root),
# then waits for you to confirm a six-digit number shown in DeCloud.
set -e
HOST=__HOST__
DIR="$HOME/.local/share/decloud-node"
say() { printf '%s\n' "$*"; }
[ "$(uname -s)" = Linux ] || { say "DeCloud nodes need Linux for now."; exit 1; }
command -v python3 >/dev/null 2>&1 || { say "Python 3 is missing. Install it (for example: sudo apt install python3) and run this again."; exit 1; }
if ! command -v tailscale >/dev/null 2>&1 || ! tailscale ip -4 >/dev/null 2>&1; then
  say "Connect this computer to Tailscale first (https://tailscale.com/download), then run this again."; exit 1
fi
mkdir -p "$DIR"
curl -fsSL "$HOST/lab-agent.py" -o "$DIR/decloud-agent.py.new"
mv "$DIR/decloud-agent.py.new" "$DIR/decloud-agent.py"
PY=python3
if ! python3 -c 'import psutil' 2>/dev/null; then
  if [ -x "$DIR/venv/bin/python" ] || python3 -m venv "$DIR/venv" >/dev/null 2>&1; then
    "$DIR/venv/bin/python" -m pip install -q psutil && PY="$DIR/venv/bin/python"
  else
    say "One package is missing. Run: sudo apt install python3-psutil  (or your system's equivalent), then run this again."; exit 1
  fi
fi
if ! command -v openssl >/dev/null 2>&1 && ! "$PY" -c 'import cryptography' 2>/dev/null; then
  say "OpenSSL is missing. Install it (for example: sudo apt install openssl) and run this again."; exit 1
fi
say "Installed. Starting pairing..."
exec "$PY" "$DIR/decloud-agent.py" --install-service --tailnet </dev/tty
"""


@bp.route('/lab-node.sh')
@limiter.limit('30 per minute')
def node_script():
    """Public on purpose (like /lab-agent.py): fetched by `curl | sh` on the device
    being added. Holds no secrets; pairing still needs the six-digit confirmation."""
    host = _host_url()
    if not host:
        body = '#!/bin/sh\necho "The DeCloud host is not connected to Tailscale, so it cannot add devices yet."\nexit 1\n'
    else:
        body = NODE_SCRIPT.replace('__HOST__', "'" + host + "'")
    return body, 200, {'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store'}


@bp.route('/api/lab/pair', methods=['POST'])
def start_pair():
    data = request.get_json(silent=True) or {}
    ip, port = str(data.get('ip', '')), data.get('port', LAB_PORT)
    if not re.fullmatch(r'[0-9a-fA-F.:]{3,45}', ip) or not isinstance(port, int) or not 0 < port < 65536:
        return jsonify({'error': 'Bad address'}), 400
    return _start_pair(ip, port)


CONNECT_WAIT = 900  # how long Add device waits for the setup command to be run


@bp.route('/api/lab/tailnet/pair', methods=['POST'])
def start_tailnet_pair():
    """Add device: wait (up to 15 min) for the node agent on that tailnet peer to
    come up in pairing mode, then run the six-digit confirmation."""
    data = request.get_json(silent=True) or {}
    ip = str(data.get('ip', ''))
    own, peers = _tailnet_peers()
    if own is None:
        return jsonify({'error': 'Tailscale is not connected on this host.'}), 503
    peer = next((p for p in peers if p['ip'] == ip), None)
    if not peer:
        return jsonify({'error': 'That device is not in this tailnet. Refresh the device list.'}), 400
    for k in [k for k, j in _jobs.items() if time.time() - j['t'] > CONNECT_WAIT + 300]:
        _jobs.pop(k, None)
    jid = uuid.uuid4().hex[:8]
    _jobs[jid] = {'state': 'waiting-device', 'name': peer['name'], 't': time.time(), 'cancel': threading.Event()}
    threading.Thread(target=_connect_worker, args=(jid, ip, lab_report.AGENT_PORT), daemon=True).start()
    return jsonify({'job': jid, 'name': peer['name']})


def _connect_worker(jid, ip, port):
    j = _jobs[jid]
    url = f'https://{ip}:{port}'
    deadline = time.time() + CONNECT_WAIT
    job = None
    while job is None:
        if j['cancel'].is_set():
            return
        if time.time() > deadline:
            j.update(state='failed', error='Stopped waiting. Run the setup command on that device, then try again.')
            return
        try:
            job = lab_report.pair_start(url, _prefs(load_settings())['name'])
        except (OSError, ValueError):
            j['cancel'].wait(2)  # not set up yet, or not in pairing mode: keep waiting
    j.update(state='confirm', number=job['number'], name=job['name'] or j['name'], kind=job['kind'])
    try:
        token = lab_report.pair_finish(job)
        if j['cancel'].is_set():
            return
        _save_device(j['name'], job['url'], token, job['fp'])
        j['state'] = 'done'
    except (OSError, PermissionError, lab_report.PinError) as e:
        j.update(state='failed', error=str(e) or 'Pairing failed')


@bp.route('/api/lab/pair/<jid>', methods=['DELETE'])
def cancel_pair(jid):
    j = _jobs.pop(jid, None)
    if j and j.get('cancel'):
        j['cancel'].set()
    return jsonify({'ok': True})


def _start_pair(ip, port):
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
    return jsonify({k: v for k, v in j.items() if k not in ('t', 'cancel')})


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
    with _settings_rw:   # load→change→save as one step
        settings = load_settings()
        settings['lab_devices'] = [d for d in settings.get('lab_devices', []) if d['id'] != dev_id]
        settings['lab_phones'] = [p for p in settings.get('lab_phones', []) if p.get('id') != dev_id]
        save_settings(settings)
    return jsonify({'ok': True})


def _device_or_404(dev_id):
    return find_device(dev_id) if dev_id != 'self' else {'id': 'self'}


@bp.route('/api/lab/devices/<dev_id>/action', methods=['POST'])
def device_action(dev_id):
    """Safe actions only: restart a running container, unload a loaded model."""
    data = request.get_json(silent=True) or {}
    action, target = data.get('action'), str(data.get('target') or '')[:200]
    if action not in lab_report.ACTIONS:
        return jsonify({'error': 'Unknown action.'}), 400
    dev = _device_or_404(dev_id)
    if not dev:
        return jsonify({'error': 'Device not found.'}), 404
    if dev_id == 'self':
        try:
            return jsonify({'ok': True, 'message': lab_report.run_action(action, target)})
        except (ValueError, OSError) as e:
            return jsonify({'error': str(e) or 'Action failed'}), 400
    try:
        status, d = lab_report.call(dev['url'], dev['token'], dev['fp'], 'POST', '/api/lab/action',
                                    {'action': action, 'target': target}, timeout=100)
    except lab_report.PinError:
        return jsonify({'error': 'Identity changed. Remove the device and add it again.'}), 502
    except PermissionError:
        return jsonify({'error': 'The device no longer accepts this hub. Add it again.'}), 502
    except (OSError, ValueError):
        return jsonify({'error': 'Device is offline or unreachable.'}), 502
    if status == 404:
        return jsonify({'error': 'This device runs an older agent. Run the setup command on it again to update.'}), 409
    if status != 200 or not isinstance(d, dict):
        return jsonify({'error': str((d or {}).get('error') if isinstance(d, dict) else 'Action failed')[:200]}), 400
    return jsonify({'ok': True, 'message': str(d.get('message') or 'Done.')[:200]})


@bp.route('/api/lab/devices/<dev_id>/update', methods=['POST'])
def update_device(dev_id):
    dev = find_device(dev_id)
    if not dev:
        return jsonify({'error': 'Device not found.'}), 404
    _update_tried[dev_id] = time.time()
    status, msg = push_update(dev)
    return jsonify({'ok': True, 'message': msg} if status == 200 else {'error': msg}), (200 if status == 200 else 409)


@bp.route('/api/lab/devices/<dev_id>', methods=['PATCH'])
def rename_device(dev_id):
    name = str((request.get_json(silent=True) or {}).get('name') or '').strip()[:40]
    if not name:
        return jsonify({'error': 'Give the device a name.'}), 400
    with _settings_rw:   # load→change→save as one step
        settings = load_settings()
        if dev_id == 'self':
            settings['lab'] = {**_prefs(settings), 'device_name': name}
        else:
            dev = next((d for d in settings.get('lab_devices', []) + settings.get('lab_phones', []) if d.get('id') == dev_id), None)
            if not dev:
                return jsonify({'error': 'Device not found.'}), 404
            dev['name'] = name
        save_settings(settings)
    return jsonify({'ok': True, 'name': name})
