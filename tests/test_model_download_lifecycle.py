"""Retry, target ownership, and failure recovery for model downloads."""
import pytest
from types import SimpleNamespace
from unittest.mock import Mock

import routes.models as models


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(models, 'CHAT_DIR', tmp_path)
    monkeypatch.setattr(models, '_downloads', {})
    monkeypatch.setattr(models, 'get_specs', lambda: {})
    monkeypatch.setattr(models, 'analyze_repo', lambda *args: {'files': [{
        'file': 'model.gguf', 'parts': None, 'tier': 'runs-well', 'size_gb': 0.01,
    }]})


@pytest.fixture
def dispatch(monkeypatch):
    thread = Mock()
    monkeypatch.setattr(models, 'threading', SimpleNamespace(Thread=thread))
    return thread.return_value.start


BODY = {'repo': 'owner/model', 'file': 'model.gguf', 'category': 'chat',
        'import_ollama': False}


def test_retry_reuses_queued_job_even_if_catalog_goes_offline(
        client, auth_headers, dispatch, monkeypatch):
    first = client.post('/api/models/download', json=BODY, headers=auth_headers)
    retry = client.post('/api/models/download', json=BODY, headers=auth_headers)
    assert first.status_code == retry.status_code == 200
    assert retry.json['download_id'] == first.json['download_id']
    monkeypatch.setattr(models, 'analyze_repo', lambda *a: {'error': 'catalog offline'})
    offline_retry = client.post('/api/models/download', json=BODY, headers=auth_headers)
    assert offline_retry.status_code == 200
    assert offline_retry.json['download_id'] == first.json['download_id']
    assert dispatch.call_count == 1
    listing = client.get('/api/models/downloads', headers=auth_headers)
    assert listing.status_code == 200
    assert not any(k.startswith('_') for k in listing.json['downloads'][0])


def test_private_split_parts_do_not_reserve_unrelated_outputs(client, auth_headers, dispatch):
    parts = ['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf']
    split = {**BODY, 'files': parts}
    single = {**BODY, 'files': [parts[0]]}
    assert client.post('/api/models/download', json=split, headers=auth_headers).status_code == 200
    assert client.post('/api/models/download', json=single, headers=auth_headers).status_code == 200
    assert dispatch.call_count == 2


@pytest.mark.parametrize('state', ['queued', 'cancelling'])
def test_other_repo_cannot_write_active_target(client, auth_headers, dispatch, state):
    first = client.post('/api/models/download', json=BODY, headers=auth_headers)
    assert first.status_code == 200
    models._downloads[first.json['download_id']]['state'] = state
    conflict = client.post('/api/models/download', json={**BODY, 'repo': 'other/model'},
                           headers=auth_headers)
    assert conflict.status_code == 409
    assert dispatch.call_count == 1


@pytest.mark.parametrize('state', ['done', 'error', 'cancelled'])
def test_terminal_job_can_be_retried(client, auth_headers, dispatch, state):
    first = client.post('/api/models/download', json=BODY, headers=auth_headers)
    models._downloads[first.json['download_id']]['state'] = state
    retry = client.post('/api/models/download', json=BODY, headers=auth_headers)
    assert retry.status_code == 200
    assert retry.json['download_id'] != first.json['download_id']
    assert dispatch.call_count == 2


def test_failed_thread_start_releases_target(client, auth_headers, dispatch):
    dispatch.side_effect = [RuntimeError('cannot start thread'), None]
    first = client.post('/api/models/download', json=BODY, headers=auth_headers)
    assert first.status_code == 500
    assert list(models._downloads.values())[0]['state'] == 'error'
    retry = client.post('/api/models/download', json=BODY, headers=auth_headers)
    assert retry.status_code == 200
    assert retry.json['download_id'] != first.json['download_id']
    assert dispatch.call_count == 2


class Stream:
    headers = {}

    def __init__(self, data=b'complete', fail=False):
        self.data, self.fail = data, fail

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def raise_for_status(self):
        pass

    def iter_content(self, **kwargs):
        yield self.data
        if self.fail:
            raise OSError('interrupted stream')


def test_failed_download_preserves_existing_model(tmp_path, monkeypatch):
    final = tmp_path / 'model.gguf'
    final.write_bytes(b'working model')
    models._downloads['job'] = {'state': 'queued'}
    monkeypatch.setattr(models._requests, 'get', lambda *a, **k: Stream(fail=True))
    models._download_worker('job', 'owner/model', ['model.gguf'], 'chat', False)
    assert models._downloads['job']['state'] == 'error'
    assert final.read_bytes() == b'working model'
    assert list(tmp_path.iterdir()) == [final]


def test_cancelled_queued_job_does_not_download(monkeypatch):
    models._downloads['job'] = {'state': 'cancelling'}

    def unexpected(*args, **kwargs):
        pytest.fail('a cancelled queued job attempted a download')

    monkeypatch.setattr(models._requests, 'get', unexpected)
    models._download_worker('job', 'owner/model', ['model.gguf'], 'chat', False)
    assert models._downloads['job']['state'] == 'cancelled'


def test_long_split_download_publishes_only_complete_merge(
        client, auth_headers, dispatch, tmp_path, monkeypatch):
    prefix = 'model-' + 'x' * 90
    parts = [prefix + '-00001-of-00002.gguf', prefix + '-00002-of-00002.gguf']
    final = tmp_path / models._merged_name(parts[0])
    final.write_bytes(b'old')

    def get(url, **kwargs):
        assert final.read_bytes() == b'old'
        return Stream(b'one' if parts[0] in url else b'two')

    monkeypatch.setattr(models._requests, 'get', get)
    response = client.post('/api/models/download', json={**BODY, 'files': parts}, headers=auth_headers)
    assert response.status_code == 200
    assert dispatch.call_count == 1
    job = response.json['download_id']
    models._download_worker(job, 'owner/model', parts, 'chat', False)
    assert models._downloads[job]['state'] == 'done'
    assert final.read_bytes() == b'onetwo'
    assert list(tmp_path.iterdir()) == [final]
