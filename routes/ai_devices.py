"""AI across the lab: which Ollama models live on which device, where a chat
should run, and downloading/removing models on any paired device.

Remote devices are reached only through their paired node agent (pinned TLS +
token, see lab_report.LabServer), so a node's Ollama never has to listen on the
network. "self" is this host's own Ollama.
"""
import json
import re
import socket
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from flask import Blueprint, jsonify, request

import lab_report
from shared import _requests, OLLAMA_URL
from . import lab

bp = Blueprint('ai_devices', __name__)
_pool = ThreadPoolExecutor(max_workers=8)
MODEL_NAME = lab.MODEL_NAME
GB = 1e9


# ─── Talking to one device's Ollama ──────────────────────────────
class Stream:
    """A streaming Ollama response: .status, .lines(), .error_text(), .close()."""

    def __init__(self, status, lines, read_all, close):
        self.status, self._lines, self._read_all, self._close = status, lines, read_all, close

    def lines(self):
        return self._lines()

    def error_text(self):
        try:
            raw = self._read_all()
            return str(json.loads(raw).get('error') or raw[:200])
        except Exception:
            return ''

    def close(self):
        self._close()


class Target:
    def __init__(self, dev_id, name, dev=None):
        self.id, self.name, self.dev = dev_id, name, dev

    @property
    def local(self):
        return self.dev is None

    def call(self, method, path, body=None, timeout=10):
        if self.local:
            send = {'GET': _requests.get, 'POST': _requests.post, 'DELETE': _requests.delete}[method]
            r = send(OLLAMA_URL + path, **({'json': body} if body is not None else {}), timeout=timeout)
            try:
                return r.status_code, r.json()
            except ValueError:
                return r.status_code, None
        return lab_report.call(self.dev['url'], self.dev['token'], self.dev['fp'], method, '/ollama' + path, body, timeout)

    def stream(self, path, body, timeout=lab_report.OLLAMA_PROXY_TIMEOUT):
        if self.local:
            r = _requests.post(OLLAMA_URL + path, json=body, stream=True, timeout=timeout)
            return Stream(r.status_code, lambda: (l for l in r.iter_lines() if l), lambda: r.text, r.close)
        conn, r = lab_report.open_stream(self.dev['url'], self.dev['token'], self.dev['fp'], 'POST',
                                         '/ollama' + path, body)

        def lines():
            while True:
                line = r.readline(1_000_000)
                if not line:
                    return
                if line.strip():
                    yield line

        def close():
            try:
                conn.sock and conn.sock.shutdown(socket.SHUT_RDWR)  # wakes a read blocked in another thread
            except OSError:
                pass
            conn.close()
        return Stream(r.status, lines, lambda: r.read(100_000).decode('utf-8', 'replace'), close)


def targets():
    prefs = lab._prefs(lab.load_settings())
    return [Target('self', prefs['device_name'])] + [Target(d['id'], d['name'], d) for d in lab.paired_devices()]


def target(dev_id):
    return next((t for t in targets() if t.id == dev_id), None)


# ─── Inventory: models on every device ───────────────────────────
_inv = {'t': 0, 'data': None}
_inv_lock = threading.Lock()


def _is_cloud(m):
    return bool(m.get('remote_host') or m.get('remote_model') or str(m.get('name', '')).endswith((':cloud', '-cloud')))


def _num(v):
    try:
        f = float(v)
        return f if f == f and f not in (float('inf'), float('-inf')) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _probe(t):
    try:
        status, tags = t.call('GET', '/api/tags', timeout=4)
        if status != 200 or not isinstance(tags, dict):
            raise OSError
        try:
            _, ps = t.call('GET', '/api/ps', timeout=3)
        except Exception:
            ps = {}
        ps_models = (ps or {}).get('models', []) if isinstance(ps, dict) else []
        loaded = {str(m.get('name')) for m in ps_models[:50] if isinstance(m, dict)} if isinstance(ps_models, list) else set()
        rows = tags.get('models', [])
        # a remote device is untrusted: keep only known fields, with forced types
        models = [{'name': str(m['name']), 'size': max(0.0, _num(m.get('size'))),
                   'details': {'family': str((m.get('details') or {}).get('family') or 'unknown')[:40] if isinstance(m.get('details'), dict) else 'unknown'},
                   'remote_host': str(m.get('remote_host') or '')[:200], 'remote_model': str(m.get('remote_model') or '')[:200]}
                  for m in (rows[:200] if isinstance(rows, list) else [])
                  if isinstance(m, dict) and MODEL_NAME.fullmatch(str(m.get('name', '')))]
        return {'online': True, 'models': models, 'loaded': loaded}
    except Exception:
        return {'online': False, 'models': [], 'loaded': set()}


def inventory(max_age=8):
    with _inv_lock:
        if _inv['data'] and time.time() - _inv['t'] < max_age:
            return _inv['data']
    ts = targets()
    probes = list(_pool.map(_probe, ts))
    merged, devices = {}, []
    for t, p in zip(ts, probes):
        devices.append({'id': t.id, 'name': t.name, 'local': t.local, 'online': p['online'],
                        'ollama': p['online'], 'models': len(p['models'])})
        for m in p['models']:
            cloud = _is_cloud(m)
            if cloud and not t.local:
                continue  # cloud models run on ollama.com either way; use this host's account
            name = str(m['name'])
            row = merged.setdefault(name, {
                'name': name, 'size': m.get('size', 0) or 0, 'family': (m.get('details') or {}).get('family', 'unknown'),
                'is_cloud': cloud, 'remote_host': str(m.get('remote_host') or '')[:200], 'devices': []})
            row['devices'].append({'id': t.id, 'name': t.name, 'loaded': name in p['loaded']})
    data = {'models': sorted(merged.values(), key=lambda r: r['name']), 'devices': devices}
    with _inv_lock:
        _inv.update(t=time.time(), data=data)
    return data


def forget_inventory():
    with _inv_lock:
        _inv['data'] = None


# ─── Memory: will a model fit, and how fast ──────────────────────
def device_report(t, max_age=20):
    r = lab.cached_report(t.id, max_age)
    if r is None:
        r = lab_report.report() if t.local else lab._fetch(t.dev)
        lab._reports[t.id] = (time.time(), r)
    return r if not r.get('error') else None


def memory(r):
    """{'unified', 'vram', 'ram', 'free'} in bytes from a device report."""
    gpus = r.get('gpus') or []
    vram = sum((g.get('vram_gb') or 0) for g in gpus) * GB
    unified = bool(gpus) and not vram and (str(r.get('arch', '')).lower() in ('aarch64', 'arm64'))
    ram, ram_free = r.get('ram_total', 0), max(0, r.get('ram_total', 0) - r.get('ram_used', 0))
    in_vram = sum(m.get('size_vram', 0) for m in (r.get('ollama') or {}).get('loaded', []))
    free = ram_free + (max(0, vram - in_vram) if vram else 0)
    return {'unified': unified, 'vram': vram, 'ram': ram, 'free': free}


def need_bytes(size):
    return size * 1.15 + 0.5 * GB  # weights + room for context


def fit(size, r):
    """'fast' | 'ok' (part on CPU, slower) | 'slow' (CPU only) | 'too-big'."""
    if not r:
        return 'unknown'
    m, need = memory(r), need_bytes(size)
    if m['unified']:
        return 'fast' if need <= m['ram'] * 0.85 else 'too-big'
    if m['vram']:
        if need <= m['vram']:
            return 'fast'
        return 'ok' if need <= m['vram'] + m['ram'] * 0.5 else 'too-big'
    return 'slow' if need <= m['ram'] * 0.5 else 'too-big'


def choose(model, requested='auto'):
    """Pick the device to run `model` on. Returns (Target, None) or (None, error)."""
    inv = inventory()
    row = next((m for m in inv['models'] if m['name'] == model), None)
    if not row:
        return None, f'{model} is not installed on any connected device.'
    by_id = {t.id: t for t in targets()}
    if row['is_cloud']:
        return by_id['self'], None
    on = [d for d in row['devices'] if d['id'] in by_id]
    if requested and requested != 'auto':
        on = [d for d in on if d['id'] == requested]
        if not on:
            return None, f'{model} is not installed on that device.'
    loaded = next((d for d in on if d['loaded']), None)
    if loaded:
        return by_id[loaded['id']], None
    need, best, short = need_bytes(row['size']), None, []
    for d in on:
        r = device_report(by_id[d['id']])
        if not r:
            continue
        free = memory(r)['free']
        if free >= need and (best is None or free > best[1]):
            best = (by_id[d['id']], free)
        short.append(f"{d['name']} has {free / GB:.0f} GB free")
    if best:
        return best[0], None
    if not short:
        return None, 'The device with this model is offline.'
    return None, (f'Not enough free memory to load {model} (needs about {need / GB:.0f} GB; '
                  + ', '.join(short) + '). Close another model or app, or pick a smaller model.')


@bp.route('/api/ai/devices')
def ai_devices():
    return jsonify(inventory(max_age=3))


# ─── Model library: what to download, scored per device ──────────
# Newest and most useful first; sizes come live from the Ollama registry.
LIBRARY = [
    ('gemma4:e4b', 'Gemma 4 E4B', 'Fast everyday assistant from Google. Runs on most computers.'),
    ('qwen3.5:9b', 'Qwen 3.5 9B', 'Strong all-rounder at a small size.'),
    ('gemma4:26b', 'Gemma 4 26B', 'Smarter Gemma for 24 GB+ GPUs or large unified memory.'),
    ('qwen3.5:27b', 'Qwen 3.5 27B', 'High quality answers, reasoning and code.'),
    ('qwen3.5:35b', 'Qwen 3.5 35B', 'Mixture-of-experts: fast for its size.'),
    ('gpt-oss:20b', 'gpt-oss 20B', "OpenAI's open model. Good reasoning, 16 GB+."),
    ('glm-4.7-flash:latest', 'GLM 4.7 Flash', 'Fast, capable general model.'),
    ('nemotron-3-nano:30b', 'Nemotron 3 Nano', "NVIDIA's efficient reasoning model."),
    ('qwen3-coder:30b', 'Qwen3 Coder 30B', 'Best pick for programming help.'),
    ('devstral-small-2:24b', 'Devstral Small 2', 'Coding agent model from Mistral.'),
    ('ministral-3:8b', 'Ministral 3 8B', 'Small and quick, from Mistral.'),
    ('qwen3-vl:8b', 'Qwen3 VL 8B', 'Understands images as well as text.'),
    ('gpt-oss:120b', 'gpt-oss 120B', 'Large and very capable: needs ~80 GB (DGX Spark class).'),
    ('qwen3.5:122b', 'Qwen 3.5 122B', 'Top quality: needs ~100 GB (DGX Spark class).'),
    ('llama3.2:3b', 'Llama 3.2 3B', 'Tiny: works even without a GPU.'),
]
_sizes = {}  # model -> (time, bytes)


def registry_size(model):
    hit = _sizes.get(model)
    if hit and time.time() - hit[0] < 86400:
        return hit[1]
    name, _, tag = model.partition(':')
    path = name if '/' in name else 'library/' + name
    try:
        r = _requests.get(f'https://registry.ollama.ai/v2/{path}/manifests/{tag or "latest"}', timeout=6,
                          headers={'Accept': 'application/vnd.docker.distribution.manifest.v2+json'})
        size = sum(int(l.get('size', 0)) for l in r.json().get('layers', [])) if r.status_code == 200 else None
    except Exception:
        size = None
    if size:
        _sizes[model] = (time.time(), size)
    return size


_TIER_ORDER = {'fast': 0, 'ok': 1, 'slow': 2, 'unknown': 3, 'too-big': 4}


@bp.route('/api/ai/library')
def ai_library():
    t = target(request.args.get('device', 'self'))
    if not t:
        return jsonify({'error': 'Device not found.'}), 404
    r = device_report(t)
    if r is None:
        return jsonify({'error': f'{t.name} is offline.'}), 502
    installed = {m['name'] for m in inventory()['models'] if any(d['id'] == t.id for d in m['devices'])}
    sizes = list(_pool.map(registry_size, [m for m, _, _ in LIBRARY]))
    rows = []
    for (model, label, note), size in zip(LIBRARY, sizes):
        if not size:
            continue
        rows.append({'model': model, 'label': label, 'note': note, 'size': size,
                     'fit': fit(size, r), 'installed': model in installed})
    rows.sort(key=lambda x: _TIER_ORDER[x['fit']])  # stable: keeps newest-first inside a tier
    m = memory(r)
    return jsonify({'device': {'id': t.id, 'name': t.name, 'ram': m['ram'], 'vram': m['vram'], 'unified': m['unified'],
                               'gpus': [g.get('name') for g in r.get('gpus') or []]},
                    'models': rows})


# ─── Downloading / removing models on a device ───────────────────
_pulls = {}
_pulls_lock = threading.Lock()


def _pull_worker(job, t):
    s = None
    try:
        s = t.stream('/api/pull', {'model': job['model'], 'stream': True}, timeout=600)
        job['_stream'] = s
        if s.status != 200:
            raise OSError(s.error_text() or f'HTTP {s.status}')
        for line in s.lines():
            if job['cancelled']:
                return
            d = json.loads(line)
            if d.get('error'):
                raise OSError(str(d['error'])[:200])
            if d.get('total'):
                job['total'], job['done'] = d['total'], d.get('completed', 0)
            job['status'] = str(d.get('status', ''))[:80]
            if d.get('status') == 'success':
                job['state'] = 'done'
                return
        if not job['cancelled']:
            raise OSError('The download stopped before it finished.')
    except (OSError, ValueError, PermissionError, lab_report.PinError) as e:
        if not job['cancelled']:
            job.update(state='failed', error=str(e) or 'Download failed')
    finally:
        if job['cancelled']:
            job['state'] = 'cancelled'
        if s:
            s.close()
        forget_inventory()


@bp.route('/api/ai/pull', methods=['POST'])
def ai_pull():
    data = request.get_json(silent=True) or {}
    model = str(data.get('model') or '').strip()
    t = target(str(data.get('device') or 'self'))
    if not MODEL_NAME.fullmatch(model):
        return jsonify({'error': 'Enter a model name like qwen3.5:9b.'}), 400
    if not t:
        return jsonify({'error': 'Device not found.'}), 404
    with _pulls_lock:
        if any(j['model'] == model and j['device'] == t.id and j['state'] == 'running' for j in _pulls.values()):
            return jsonify({'error': 'Already downloading.'}), 409
        jid = uuid.uuid4().hex[:10]
        job = _pulls[jid] = {'id': jid, 'model': model, 'device': t.id, 'device_name': t.name, 'state': 'running',
                             'status': 'starting', 'total': 0, 'done': 0, 'cancelled': False, 't': time.time()}
    threading.Thread(target=_pull_worker, args=(job, t), daemon=True).start()
    return jsonify({'id': jid})


@bp.route('/api/ai/pulls')
def ai_pulls():
    now = time.time()
    with _pulls_lock:
        for k in [k for k, j in _pulls.items() if j['state'] != 'running' and now - j['t'] > 3600]:
            _pulls.pop(k)
        return jsonify({'pulls': [{k: v for k, v in j.items() if not k.startswith('_') and k != 'cancelled'}
                                  for j in _pulls.values()]})


@bp.route('/api/ai/pulls/<jid>/cancel', methods=['POST'])
def ai_pull_cancel(jid):
    job = _pulls.get(jid)
    if not job:
        return jsonify({'error': 'Not found'}), 404
    job['cancelled'] = True
    if job.get('_stream'):
        threading.Thread(target=job['_stream'].close, daemon=True).start()
    return jsonify({'ok': True})


@bp.route('/api/ai/delete', methods=['POST'])
def ai_delete():
    data = request.get_json(silent=True) or {}
    model = str(data.get('model') or '')
    t = target(str(data.get('device') or ''))
    if not t or not MODEL_NAME.fullmatch(model):
        return jsonify({'error': 'Bad request'}), 400
    try:
        status, d = t.call('DELETE', '/api/delete', {'model': model}, timeout=30)
    except Exception:
        return jsonify({'error': f'{t.name} is unreachable.'}), 502
    forget_inventory()
    if status != 200:
        return jsonify({'error': str((d or {}).get('error') if isinstance(d, dict) else 'Could not remove it')[:200]}), 400
    return jsonify({'ok': True})
