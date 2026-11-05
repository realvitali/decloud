"""AI across lab devices: placement, memory guard, fit scoring, chat + pulls via a node."""
import json
import time

import lab_report
import routes.ai_devices as ai
import routes.lab as lab
from tests.test_lab_node_api import fake_ollama, node  # noqa: F401  (fixtures)

GB = 1e9
SPARK = {'arch': 'aarch64', 'gpus': [{'name': 'NVIDIA GB10', 'vram_gb': None}], 'ram_total': 121 * GB, 'ram_used': 10 * GB,
         'ollama': {'loaded': []}}
DESKTOP = {'arch': 'x86_64', 'gpus': [{'name': 'RTX 5060 Ti', 'vram_gb': 16}], 'ram_total': 61 * GB, 'ram_used': 5 * GB,
           'ollama': {'loaded': []}}
CPU_ONLY = {'arch': 'x86_64', 'gpus': [], 'ram_total': 16 * GB, 'ram_used': 4 * GB, 'ollama': {'loaded': []}}


def test_fit_tiers():
    assert ai.fit(81 * GB, SPARK) == 'fast'          # unified memory: big models run on the GPU
    assert ai.fit(110 * GB, SPARK) == 'too-big'
    assert ai.fit(6 * GB, DESKTOP) == 'fast'
    assert ai.fit(20 * GB, DESKTOP) == 'ok'          # spills into system RAM
    assert ai.fit(65 * GB, DESKTOP) == 'too-big'
    assert ai.fit(2 * GB, CPU_ONLY) == 'slow'
    assert ai.fit(None or 0, None) == 'unknown'


def _fake_inventory(monkeypatch, rows, reports):
    devices = [ai.Target('self', 'cabin'), ai.Target('d1', 'spark', {'id': 'd1'})]
    monkeypatch.setattr(ai, 'targets', lambda: devices)
    monkeypatch.setattr(ai, 'inventory', lambda max_age=8: {'models': rows, 'devices': []})
    monkeypatch.setattr(ai, 'device_report', lambda t, max_age=20: reports.get(t.id))


def test_choose_prefers_loaded_then_most_free_memory_and_refuses_when_nothing_fits(monkeypatch):
    rows = [{'name': 'big:70b', 'size': 42 * GB, 'is_cloud': False,
             'devices': [{'id': 'self', 'name': 'cabin', 'loaded': False}, {'id': 'd1', 'name': 'spark', 'loaded': False}]},
            {'name': 'small:8b', 'size': 5 * GB, 'is_cloud': False,
             'devices': [{'id': 'self', 'name': 'cabin', 'loaded': True}, {'id': 'd1', 'name': 'spark', 'loaded': False}]},
            {'name': 'x:cloud', 'size': 0, 'is_cloud': True, 'devices': [{'id': 'self', 'name': 'cabin', 'loaded': False}]}]
    _fake_inventory(monkeypatch, rows, {'self': DESKTOP, 'd1': SPARK})
    assert ai.choose('small:8b')[0].id == 'self'      # already loaded: no second copy
    assert ai.choose('big:70b')[0].id == 'd1'         # the Spark has far more free memory
    assert ai.choose('small:8b', 'd1')[0].id == 'd1'  # explicit choice wins
    assert ai.choose('x:cloud')[0].id == 'self'
    assert ai.choose('missing:1b')[1]

    busy = {**SPARK, 'ram_used': 110 * GB}
    _fake_inventory(monkeypatch, rows, {'self': {**DESKTOP, 'ram_used': 58 * GB}, 'd1': busy})
    target, problem = ai.choose('big:70b')
    assert target is None and 'Not enough free memory' in problem and 'spark' in problem


def test_chat_runs_on_the_paired_node(client, auth_headers, node, monkeypatch):
    settings = {'lab_devices': [{'id': 'd1', 'name': 'spark', **node}], 'lab': {'device_name': 'cabin'}}
    monkeypatch.setattr(lab, 'load_settings', lambda: settings)
    monkeypatch.setattr(ai, 'OLLAMA_URL', 'http://127.0.0.1:9')  # this host has no Ollama
    models = client.get('/api/ollama/models', headers=auth_headers).get_json()
    assert [m['name'] for m in models['models']] == ['qwen3:8b']
    assert models['models'][0]['devices'] == [{'id': 'd1', 'name': 'spark', 'loaded': True}]
    r = client.post('/api/ollama/chat', headers=auth_headers,
                    json={'model': 'qwen3:8b', 'messages': [{'role': 'user', 'content': 'hey'}]})
    events = [json.loads(l[6:]) for l in r.get_data(as_text=True).splitlines() if l.startswith('data: ')]
    assert events[0] == {'device': 'spark', 'device_id': 'd1'}
    assert ''.join(e.get('content', '') for e in events) == 'hi there'
    assert events[-1] == {'done': True}


def test_pull_on_node_reports_progress(client, auth_headers, node, fake_ollama, monkeypatch):
    settings = {'lab_devices': [{'id': 'd1', 'name': 'spark', **node}]}
    monkeypatch.setattr(lab, 'load_settings', lambda: settings)
    assert client.post('/api/ai/pull', json={'device': 'd1', 'model': 'rm -rf'}, headers=auth_headers).status_code == 400
    assert client.post('/api/ai/pull', json={'device': 'nope', 'model': 'qwen3:8b'}, headers=auth_headers).status_code == 404
    jid = client.post('/api/ai/pull', json={'device': 'd1', 'model': 'qwen3.5:9b'}, headers=auth_headers).get_json()['id']
    for _ in range(50):
        job = next(j for j in client.get('/api/ai/pulls', headers=auth_headers).get_json()['pulls'] if j['id'] == jid)
        if job['state'] != 'running':
            break
        time.sleep(0.1)
    assert job['state'] == 'done' and job['device_name'] == 'spark', job
    assert ('POST', '/api/pull', {'model': 'qwen3.5:9b', 'stream': True}) in fake_ollama


def test_ai_routes_require_auth(client):
    for path in ('/api/ai/devices', '/api/ai/library', '/api/ai/pulls'):
        assert client.get(path).status_code == 401
    assert client.post('/api/ai/pull', json={}).status_code == 401
    assert client.post('/api/ai/delete', json={}).status_code == 401
