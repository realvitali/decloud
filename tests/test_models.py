"""AI model advisor + download manager tests (HF calls mocked)."""
import json

import pytest

import routes.models as mod


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(mod, 'CHAT_DIR', tmp_path / 'models' / 'chat')
    monkeypatch.setattr(mod, 'MODELS_DIR', tmp_path / 'models')
    monkeypatch.setattr(mod, 'COMFY_MODELS_DIR', tmp_path / 'comfy' / 'models')
    for key, value in list(mod.CATEGORY_TARGETS.items()):
        monkeypatch.setattr(mod, 'CATEGORY_TARGETS', {
            **mod.CATEGORY_TARGETS,
            key: tmp_path / 'comfy' / 'models' / value.name,
        })
    mod._downloads.clear()
    yield


class TestFitTiers:
    SPECS = {'ram_total_gb': 32, 'ram_free_gb': 20, 'disk_free_gb': 100,
             'cpu': 8, 'gpus': [{'vram_total_gb': 8, 'vram_free_gb': 6}]}

    def test_chat_tiers(self):
        assert mod.fit_tier(4.0, 'chat', self.SPECS) == 'runs-well'      # 4+1.5 ≤ 7.2
        assert mod.fit_tier(6.5, 'chat', self.SPECS) == 'tight'          # 8.0 in (7.2, 8.4]
        assert mod.fit_tier(7.0, 'chat', self.SPECS) == 'cpu-only'       # 8.5 > 8.4 → RAM offload
        assert mod.fit_tier(14.0, 'chat', self.SPECS) == 'cpu-only'      # 15.5 ≤ 16
        assert mod.fit_tier(40.0, 'chat', self.SPECS) == 'too-big'

    def test_image_needs_gpu(self):
        assert mod.fit_tier(4.0, 'image', self.SPECS) == 'runs-well'
        no_gpu = {**self.SPECS, 'gpus': []}
        assert mod.fit_tier(4.0, 'image', no_gpu) == 'too-big'

    def test_cpu_only_chat(self):
        no_gpu = {**self.SPECS, 'gpus': []}
        assert mod.fit_tier(3.0, 'chat', no_gpu) == 'cpu-only'
        assert mod.fit_tier(30.0, 'chat', no_gpu) == 'too-big'


class TestAnalyze:
    def test_repo_not_found(self, monkeypatch):
        class R:
            status_code = 404
        monkeypatch.setattr(mod._requests, 'get', lambda *a, **k: R())
        out = mod.analyze_repo('nobody/nothing', 'chat', TestFitTiers.SPECS)
        assert 'error' in out

    def test_scores_files(self, monkeypatch):
        class R:
            status_code = 200
            def json(self):
                return [
                    {'type': 'file', 'path': 'model-Q4_K_M.gguf', 'size': str(int(4e9))},
                    {'type': 'file', 'path': 'model-Q8_0.gguf', 'size': str(int(9e9))},
                    {'type': 'file', 'path': 'README.md', 'size': '1000'},
                    {'type': 'directory', 'path': 'sub'},
                ]
            def raise_for_status(self): pass
        monkeypatch.setattr(mod._requests, 'get', lambda *a, **k: R())
        out = mod.analyze_repo('owner/repo', 'chat', TestFitTiers.SPECS)
        assert len(out['files']) == 2
        assert out['files'][0]['tier'] == 'runs-well'
        assert out['files'][1]['tier'] == 'cpu-only'   # 9GB Q8 offloads to RAM


class TestEndpoints:
    def test_auth_required(self, client):
        assert client.get('/api/models/catalog').status_code == 401
        assert client.get('/api/models/specs').status_code == 401
        assert client.get('/api/models/downloads').status_code == 401
        assert client.post('/api/models/analyze', json={}).status_code == 401
        assert client.post('/api/models/download', json={}).status_code == 401

    def test_analyze_validates_repo_name(self, client, auth_headers):
        for bad in ('../../etc', 'owner', 'a/b/c', 'a b/c'):
            r = client.post('/api/models/analyze', json={'repo': bad}, headers=auth_headers)
            assert r.status_code == 400, bad

    def test_download_validates_and_rejects_too_big(self, client, auth_headers, monkeypatch):
        class R:
            status_code = 200
            def json(self):
                return [{'type': 'file', 'path': 'huge-Q8.gguf', 'size': str(int(100e9))}]
            def raise_for_status(self): pass
        monkeypatch.setattr(mod._requests, 'get', lambda *a, **k: R())
        r = client.post('/api/models/download',
                        json={'repo': 'owner/repo', 'file': 'huge-Q8.gguf',
                              'category': 'chat'},
                        headers=auth_headers)
        assert r.status_code == 409
        assert 'does not fit' in r.get_json()['error']

    def test_specs_shape(self, client, auth_headers):
        d = client.get('/api/models/specs', headers=auth_headers).get_json()
        s = d['specs']
        for key in ('cpu', 'ram_total_gb', 'ram_free_gb', 'disk_free_gb', 'gpus'):
            assert key in s
