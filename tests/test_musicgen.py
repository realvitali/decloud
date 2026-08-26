"""Music generator backend tests (no real ComfyUI needed)."""
import json
import time

import pytest

import routes.musicgen as mg


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Point the library and workflow at temp paths, clear in-flight."""
    monkeypatch.setattr(mg, 'MUSICGEN_DIR', tmp_path / 'lib')
    mg.MUSICGEN_DIR.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(mg, 'MUSICGEN_INDEX', mg.MUSICGEN_DIR / 'index.json')
    monkeypatch.setattr(mg, 'WORKFLOW_FILE', tmp_path / 'workflow.json')
    mg._INFLIGHT.clear()
    yield


def _make_workflow(tmp_path):
    wf = {
        '1': {'class_type': 'MiniMaxMusic3TextToMusic',
              'inputs': {'prompt': 'placeholder', 'lyrics': '',
                         'instrumental': False, 'duration': 45, 'seed': 1}},
        '2': {'class_type': 'SaveAudio',
              'inputs': {'filename_prefix': 'x', 'audio': ['1', 0]}},
    }
    wf_path = tmp_path / 'workflow.json'
    wf_path.write_text(json.dumps(wf))
    return wf, wf_path


class TestAuthRequired:
    def test_status_requires_auth(self, client):
        assert client.get('/api/musicgen/status').status_code == 401

    def test_generate_requires_auth(self, client):
        r = client.post('/api/musicgen/generate', json={'prompt': 'x'})
        assert r.status_code == 401

    def test_history_requires_auth(self, client):
        assert client.get('/api/musicgen/history').status_code == 401

    def test_delete_requires_auth(self, client):
        assert client.delete('/api/musicgen/history/abc').status_code == 401


class TestGenerate:
    def test_needs_prompt_or_lyrics(self, client, auth_headers):
        r = client.post('/api/musicgen/generate', json={}, headers=auth_headers)
        assert r.status_code == 400

    def test_no_workflow_gives_setup_hint(self, client, auth_headers):
        r = client.post('/api/musicgen/generate', json={'prompt': 'lo-fi'},
                        headers=auth_headers)
        assert r.status_code == 409
        assert r.get_json()['code'] == 'NO_WORKFLOW'

    def test_comfy_down_returns_503(self, client, auth_headers, tmp_path, monkeypatch):
        _make_workflow(tmp_path)
        monkeypatch.setattr(mg, 'WORKFLOW_FILE', tmp_path / 'workflow.json')
        def boom(*a, **k):
            raise Exception('connection refused')
        monkeypatch.setattr(mg._requests, 'post', boom)
        r = client.post('/api/musicgen/generate', json={'prompt': 'x'},
                        headers=auth_headers)
        assert r.status_code == 503

    def test_queues_with_patched_workflow(self, client, auth_headers, tmp_path, monkeypatch):
        _, wf_path = _make_workflow(tmp_path)
        monkeypatch.setattr(mg, 'WORKFLOW_FILE', wf_path)
        sent = {}
        class FakeResp:
            status_code = 200
            def json(self): return {'prompt_id': 'p123'}
        monkeypatch.setattr(mg._requests, 'post',
                            lambda url, json=None, timeout=15: sent.update(json or {}) or FakeResp())
        r = client.post('/api/musicgen/generate',
                        json={'prompt': 'jazzy', 'lyrics': 'la la la',
                              'instrumental': False, 'duration': 45},
                        headers=auth_headers)
        assert r.status_code == 200
        assert r.get_json()['prompt_id'] == 'p123'
        assert 'p123' in mg._INFLIGHT
        wf = sent['prompt']
        assert wf['1']['inputs']['prompt'] == 'jazzy'
        assert wf['1']['inputs']['lyrics'] == 'la la la'
        assert wf['1']['inputs']['instrumental'] is False
        assert wf['1']['inputs']['duration'] == 45
        assert wf['2']['inputs']['filename_prefix'] == 'decloud_music'


class TestWorkflowPatch:
    def test_patch_by_keyword(self):
        wf = {
            'a': {'class_type': 'X', 'inputs': {'prompt': 'old', 'seed': 5,
                                                'instrumental': False}},
            'b': {'class_type': 'SaveAudio',
                  'inputs': {'filename_prefix': 'z'}},
        }
        out = mg._patch_workflow(wf, {'prompt': 'new', 'lyrics': 'l',
                                      'instrumental': True,
                                      'filename_prefix': 'decloud_music'})
        assert out['a']['inputs']['prompt'] == 'new'
        assert out['a']['inputs']['instrumental'] is True
        assert out['b']['inputs']['filename_prefix'] == 'decloud_music'
        assert out['a']['inputs']['seed'] != 5  # randomized

    def test_ui_format_converted(self):
        ui = {'nodes': [{'id': 7, 'type': 'Note', 'widgets_values': {'text': 'hi'}}]}
        api = mg._ui_to_api(ui)
        assert api['7']['class_type'] == 'Note'
        assert api['7']['inputs']['text'] == 'hi'


class TestHistory:
    def test_roundtrip_and_delete(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(mg, 'MUSICGEN_INDEX', mg.MUSICGEN_DIR / 'index.json')
        idx = [{'id': 'song_one', 'file': 'song_one.mp3', 'prompt': 'rainy',
                'lyrics': '', 'instrumental': True, 'duration_sec': 42.0,
                'created': time.time()}]
        mg._save_index(idx)
        (mg.MUSICGEN_DIR / 'song_one.mp3').write_bytes(b'fake-audio')

        r = client.get('/api/musicgen/history', headers=auth_headers)
        assert r.status_code == 200
        assert r.get_json()['songs'][0]['id'] == 'song_one'

        r = client.get('/api/musicgen/audio/song_one', headers=auth_headers)
        assert r.status_code == 200

        r = client.delete('/api/musicgen/history/song_one', headers=auth_headers)
        assert r.status_code == 200
        assert mg._load_index() == []
        assert not (mg.MUSICGEN_DIR / 'song_one.mp3').exists()

    def test_audio_id_validated(self, client, auth_headers):
        r = client.get('/api/musicgen/audio/..%2F..%2Fetc', headers=auth_headers)
        assert r.status_code in (400, 404)


class TestStatus:
    def test_status_shape(self, client, auth_headers):
        r = client.get('/api/musicgen/status', headers=auth_headers)
        assert r.status_code == 200
        d = r.get_json()
        assert 'comfy_online' in d
        assert 'workflow_configured' in d
        assert 'history_count' in d


class TestComfyLifecycle:
    def test_auth_required(self, client):
        assert client.post('/api/comfy/start').status_code == 401
        assert client.post('/api/comfy/stop').status_code == 401
        assert client.get('/api/comfy/log').status_code == 401

    def test_start_not_installed(self, client, auth_headers, monkeypatch):
        import routes.comfy as comfy_module
        monkeypatch.setattr(comfy_module, '_comfy_strategy', lambda: (None, []))
        monkeypatch.setattr(comfy_module, '_comfy_online', lambda: False)
        r = client.post('/api/comfy/start', headers=auth_headers)
        assert r.status_code == 409
        assert r.get_json()['code'] == 'NOT_INSTALLED'

    def test_start_already_running(self, client, auth_headers, monkeypatch):
        import routes.comfy as comfy_module
        monkeypatch.setattr(comfy_module, '_comfy_online', lambda: True)
        r = client.post('/api/comfy/start', headers=auth_headers)
        assert r.status_code == 200
        assert 'already running' in r.get_json()['message']

    def test_strategy_detection(self, monkeypatch, tmp_path):
        import routes.comfy as comfy_module
        # env cmd wins
        monkeypatch.setenv('DECLOUD_COMFY_CMD', '/usr/bin/python /opt/comfy/main.py --listen')
        monkeypatch.setattr(comfy_module.subprocess, 'run', lambda *a, **k: type('R', (), {'returncode': 1})())
        strategy, argv = comfy_module._comfy_strategy()
        assert strategy == 'cmd'
        assert argv[0] == '/usr/bin/python'
