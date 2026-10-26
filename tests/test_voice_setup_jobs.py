"""Setup jobs reserve their operation before the worker runs."""
import pytest
from types import SimpleNamespace
from unittest.mock import Mock

import routes.voice as voice


CASES = [('/api/voice/ollama/install', {}),
         ('/api/voice/ollama/pull', {'model': 'tiny:latest'}),
         ('/api/voice/tts/install', {'engine': 'piper-kathleen-low'})]


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(voice, '_setup_jobs', {})
    monkeypatch.setattr(voice.shutil, 'which', lambda name: '/fixture/ollama')


@pytest.fixture
def dispatch(monkeypatch):
    thread = Mock()
    monkeypatch.setattr(voice, 'threading', SimpleNamespace(Thread=thread))
    return thread.return_value.start


@pytest.mark.parametrize('url,body', CASES)
def test_retry_before_worker_runs_dispatches_once(client, auth_headers, dispatch, url, body):
    first = client.post(url, json=body, headers=auth_headers)
    retry = client.post(url, json=body, headers=auth_headers)
    assert first.status_code == retry.status_code == 202
    assert first.json['job'] == retry.json['job']
    assert dispatch.call_count == 1
    # The existing settings UI only keeps polling jobs in this public state.
    assert voice._setup_jobs[first.json['job']]['state'] == 'running'


def test_distinct_model_names_get_distinct_jobs(client, auth_headers, dispatch):
    first = client.post('/api/voice/ollama/pull', json={'model': 'tiny:latest'}, headers=auth_headers)
    second = client.post('/api/voice/ollama/pull', json={'model': 'tiny_latest'}, headers=auth_headers)
    assert first.status_code == second.status_code == 202
    assert first.json['job'] != second.json['job']
    assert dispatch.call_count == 2


def test_dispatch_failure_is_retryable(client, auth_headers, dispatch):
    dispatch.side_effect = [RuntimeError('simulated thread exhaustion'), None]
    failed = client.post('/api/voice/ollama/install', headers=auth_headers)
    assert failed.status_code == 500
    assert next(iter(voice._setup_jobs.values()))['state'] == 'error'
    retry = client.post('/api/voice/ollama/install', headers=auth_headers)
    assert retry.status_code == 202
    assert dispatch.call_count == 2
