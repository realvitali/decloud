"""Node agent v2: token-gated Ollama relay + safe actions, and the hub routes using them."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import lab_report
import routes.lab as lab


@pytest.fixture
def fake_ollama(monkeypatch):
    seen = []

    class H(BaseHTTPRequestHandler):
        def _reply(self, obj, lines=None):
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson' if lines else 'application/json')
            self.end_headers()
            if lines:
                for line in lines:
                    self.wfile.write((json.dumps(line) + '\n').encode())
                    self.wfile.flush()
            else:
                self.wfile.write(json.dumps(obj).encode())

        def do_GET(self):
            seen.append(('GET', self.path, None))
            if self.path == '/api/tags':
                return self._reply({'models': [{'name': 'qwen3:8b', 'size': 5e9}, {'name': 'gpt-oss:120b-cloud', 'remote_host': 'https://ollama.com'}]})
            if self.path == '/api/ps':
                return self._reply({'models': [{'name': 'qwen3:8b', 'size': 6e9, 'size_vram': 6e9}]})
            self._reply({'version': '1'})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            seen.append(('POST', self.path, body))
            if self.path == '/api/chat':
                return self._reply(None, [{'message': {'content': 'hi'}}, {'message': {'content': ' there'}}, {'done': True}])
            if self.path == '/api/pull':
                return self._reply(None, [{'status': 'pulling', 'total': 100, 'completed': 40},
                                          {'status': 'pulling', 'total': 100, 'completed': 100}, {'status': 'success'}])
            self._reply({})

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv('OLLAMA_HOST', f'http://127.0.0.1:{srv.server_address[1]}')
    yield seen
    srv.shutdown()


@pytest.fixture
def node(tmp_path, fake_ollama):
    state = lab_report.State(tmp_path / 'node')
    srv = lab_report.LabServer(state, 'spark', lambda: lab_report.report(kind='agent'), None, host='127.0.0.1', port=0).start()
    yield {'url': f'https://127.0.0.1:{srv.port}', 'token': state.token, 'fp': state.fp}
    srv.stop()


def test_relay_requires_token_and_allows_only_listed_paths(node):
    status, _, _ = lab_report._https(node['url'], node['fp'], 'GET', '/ollama/api/tags')
    assert status == 401
    status, data = lab_report.call(node['url'], node['token'], node['fp'], 'GET', '/ollama/api/tags')
    assert status == 200 and data['models'][0]['name'] == 'qwen3:8b'
    status, _ = lab_report.call(node['url'], node['token'], node['fp'], 'POST', '/ollama/api/create', {'model': 'x'})
    assert status == 404
    status, _ = lab_report.call(node['url'], node['token'], node['fp'], 'GET', '/ollama/../etc/passwd')
    assert status == 404


def test_relay_streams_chat(node, fake_ollama):
    conn, r = lab_report.open_stream(node['url'], node['token'], node['fp'], 'POST', '/ollama/api/chat',
                                     {'model': 'qwen3:8b', 'messages': [{'role': 'user', 'content': 'hey'}]}, timeout=10)
    try:
        lines = [json.loads(l) for l in r.read().splitlines() if l.strip()]
    finally:
        conn.close()
    assert ''.join(l.get('message', {}).get('content', '') for l in lines) == 'hi there'
    assert fake_ollama[-1][1] == '/api/chat' and fake_ollama[-1][2]['model'] == 'qwen3:8b'


def test_service_mode_refuses_pairing(node):
    status, data, _ = lab_report._https(node['url'], None, 'POST', '/pair/start', {'commit': 'a' * 64})
    assert status == 409 and data['code'] == 'NOT_PAIRING'


def test_report_lists_local_models_only(node):
    r = lab_report.fetch_report(node['url'], node['token'], node['fp'])
    assert r['agent_version'] == lab_report.AGENT_VERSION
    assert [m['name'] for m in r['ollama']['installed']] == ['qwen3:8b']
    assert r['ollama']['loaded'][0]['name'] == 'qwen3:8b'


def test_actions_only_touch_running_things(node, fake_ollama, monkeypatch):
    act = lambda a, t: lab_report.call(node['url'], node['token'], node['fp'], 'POST', '/api/lab/action', {'action': a, 'target': t})
    assert act('reboot', '')[0] == 400
    assert act('unload-model', 'llama3:70b')[0] == 400
    status, data = act('unload-model', 'qwen3:8b')
    assert status == 200 and 'Unloaded' in data['message']
    assert fake_ollama[-1][2] == {'model': 'qwen3:8b', 'keep_alive': 0}
    monkeypatch.setattr(lab_report, 'containers', lambda: [{'name': 'web', 'image': 'nginx'}])
    assert act('restart-container', 'not-running')[0] == 400
    unauth = lab_report._https(node['url'], node['fp'], 'POST', '/api/lab/action', {'action': 'unload-model', 'target': 'qwen3:8b'})
    assert unauth[0] == 401


def test_hub_forwards_actions_and_renames(client, auth_headers, node, monkeypatch):
    settings = {'lab_devices': [{'id': 'd1', 'name': 'spark', **node}]}
    monkeypatch.setattr(lab, 'load_settings', lambda: settings)
    monkeypatch.setattr(lab, 'save_settings', lambda value: settings.update(value))
    r = client.post('/api/lab/devices/d1/action', json={'action': 'unload-model', 'target': 'qwen3:8b'}, headers=auth_headers)
    assert r.status_code == 200, r.get_json()
    assert client.post('/api/lab/devices/d1/action', json={'action': 'shell', 'target': 'x'}, headers=auth_headers).status_code == 400
    assert client.post('/api/lab/devices/nope/action', json={'action': 'unload-model', 'target': 'x'}, headers=auth_headers).status_code == 404
    assert client.patch('/api/lab/devices/d1', json={'name': 'Big Spark'}, headers=auth_headers).status_code == 200
    assert settings['lab_devices'][0]['name'] == 'Big Spark'


def test_device_routes_require_auth(client):
    assert client.post('/api/lab/devices/d1/action', json={}).status_code == 401
    assert client.patch('/api/lab/devices/d1', json={'name': 'x'}).status_code == 401


def test_offline_device_answers_from_memory_and_keeps_its_type(node, monkeypatch):
    lab._reports.clear()
    lab._last_good.clear()
    dev = {'id': 'd9', 'name': 'spark', **node}
    assert lab._fetch(dev)['device']['type'] in lab_report.DEVICE_TYPES   # online: real report
    calls = []
    real = lab._fetch_uncached
    monkeypatch.setattr(lab, '_fetch_uncached', lambda d: calls.append(1) or {'error': 'Offline or unreachable'})
    lab._reports.pop('d9')
    first = lab._fetch(dev)
    assert first['error'] and first['device'] == lab._last_good['d9']['device']
    import time as _t
    start = _t.time()
    assert lab._fetch(dev)['error']          # answered from memory, retry runs in the background
    assert _t.time() - start < 0.5
    monkeypatch.setattr(lab, '_fetch_uncached', real)


def test_apps_found_by_process_or_image():
    found = lab_report.apps({'ollama': {}, 'tailscaled': {}}, [{'name': 'media', 'image': 'lscr.io/linuxserver/jellyfin:latest'}])
    assert found == ['ollama', 'tailscale', 'jellyfin', 'docker']
    assert lab_report.apps({}, []) == []


def test_hub_keeps_only_known_apps_and_gpu_memory():
    r = lab._clean({'apps': ['ollama', '<img src=x>', 'jellyfin'], 'gpus': [{'name': 'NVIDIA GB10', 'mem_used_gb': 76.6}]})
    assert r['apps'] == ['ollama', 'jellyfin']
    assert r['gpus'][0]['mem_used_gb'] == 76.6
    assert lab._clean({'apps': 'docker'})['apps'] == []


def test_appearance_prefs_only_accept_listed_choices(client, auth_headers, monkeypatch):
    settings = {}
    monkeypatch.setattr(lab, 'load_settings', lambda: settings)
    monkeypatch.setattr(lab, 'save_settings', lambda value: settings.update(value))
    p = client.post('/api/lab/prefs', json={'font': 'scifi', 'accent': 'ice'}, headers=auth_headers).get_json()
    assert (p['font'], p['accent']) == ('scifi', 'ice')
    p = client.post('/api/lab/prefs', json={'font': '../../x', 'accent': 'red;}'}, headers=auth_headers).get_json()
    assert (p['font'], p['accent']) == ('scifi', 'ice')
    assert client.get('/api/lab/prefs', headers=auth_headers).get_json()['font'] == 'scifi'


def test_phones_join_from_tailscale_without_an_agent(client, auth_headers, monkeypatch):
    settings = {}
    monkeypatch.setattr(lab, 'load_settings', lambda: settings)
    monkeypatch.setattr(lab, 'save_settings', lambda value: settings.update(value))
    peers = [{'name': 'pho', 'ip': '100.64.0.9', 'os': 'iOS', 'online': True, 'added': False, 'last_seen': ''},
             {'name': 'win', 'ip': '100.64.0.10', 'os': 'windows', 'online': True, 'added': False, 'last_seen': ''}]
    monkeypatch.setattr(lab, '_tailnet_peers', lambda: ({'ok': 1}, peers))
    assert client.post('/api/lab/phones', json={'ip': '100.64.0.10'}, headers=auth_headers).status_code == 400
    assert client.post('/api/lab/phones', json={'ip': '100.64.0.99'}, headers=auth_headers).status_code == 400
    ph = client.post('/api/lab/phones', json={'ip': '100.64.0.9'}, headers=auth_headers).get_json()
    assert ph['name'] == 'pho' and 'token' not in ph
    assert client.post('/api/lab/phones', json={'ip': '100.64.0.9'}, headers=auth_headers).status_code == 409
    nodes = lab._phone_nodes(settings)
    assert nodes[0]['device']['type'] == 'iphone' and nodes[0]['online'] is True
    assert lab.paired_devices() == []                       # never treated as an agent device
    assert client.patch(f"/api/lab/devices/{ph['id']}", json={'name': 'My iPhone'}, headers=auth_headers).status_code == 200
    assert settings['lab_phones'][0]['name'] == 'My iPhone'
    client.delete(f"/api/lab/devices/{ph['id']}", headers=auth_headers)
    assert settings['lab_phones'] == []
    assert client.post('/api/lab/phones', json={'ip': '100.64.0.9'}).status_code in (401, 403)


def test_power_and_offline_specs_reach_the_totals(monkeypatch):
    r = lab._clean({'power': {'watts': 40.5, 'parts': {'gpu': 30, 'cpu': 10.5, 'evil': 9}}, 'cores': 20, 'ram_total': 128e9, 'storage': {'total': 4e12},
                    'gpus': [{'name': 'NVIDIA GB10'}], 'device': {'type': 'spark', 'model': 'NVIDIA DGX Spark'}})
    assert r['power'] == {'watts': 40.5, 'parts': {'gpu': 30, 'cpu': 10.5}}
    assert lab._clean({'power': 'lots'})['power'] is None
    spec = lab._spec(r)
    assert spec['gpu_mem_gb'] == 128.0 and spec['cores'] == 20          # unified memory doubles as GPU memory
    up = {**r, 'cpu_percent': 10, 'ram_used': 1e9, 'storage': {'total': 4e12, 'used': 1e12, 'volumes': 1}, 'uptime_s': 5, 'ollama': {'loaded': []}}
    off = {'error': 'Offline or unreachable', 'last': {'cores': 8, 'ram_total': 16e9, 'storage_total': 1e12, 'gpu_mem_gb': 0}}
    t = lab._totals([up, off])
    assert t['power_w'] == 40.5 and t['power_devices'] == 1
    assert t['offline'] == {'cores': 8, 'ram_total': 16e9, 'storage_total': 1e12, 'gpu_mem_gb': 0}


def test_offline_device_keeps_its_specs(monkeypatch):
    dev = {'id': 'd7', 'device_type': 'laptop', 'last': {'model': 'HP OmniBook X Flip', 'cores': 8, 'ram_total': 16e9, 'storage_total': 1e12, 'gpu_mem_gb': 0}}
    lab._last_good.pop('d7', None)
    monkeypatch.setattr(lab, '_fetch_uncached', lambda d: {'error': 'Offline or unreachable'})
    r = lab._refetch(dev)
    assert r['device'] == {'type': 'laptop', 'model': 'HP OmniBook X Flip'} and r['last']['ram_total'] == 16e9


def test_style_pref(client, auth_headers, monkeypatch):
    settings = {}
    monkeypatch.setattr(lab, 'load_settings', lambda: settings)
    monkeypatch.setattr(lab, 'save_settings', lambda value: settings.update(value))
    assert client.get('/api/lab/prefs', headers=auth_headers).get_json()['view'] == '3d'
    assert client.post('/api/lab/prefs', json={'view': 'classic'}, headers=auth_headers).get_json()['view'] == 'classic'
    assert client.post('/api/lab/prefs', json={'view': 'vr'}, headers=auth_headers).get_json()['view'] == 'classic'
