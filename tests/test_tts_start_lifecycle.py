"""TTS start reservations serialize filesystem checks and recover after spawn failure."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import subprocess
from unittest.mock import Mock

import pytest

from app import app
import routes.books as books
import shared


@pytest.fixture
def lock(tmp_path, monkeypatch):
    source, audio = tmp_path / 'books', tmp_path / 'audio'
    source.mkdir()
    audio.mkdir()
    (source / 'Example.json').write_text('[]')
    monkeypatch.setattr(shared, 'BOOKS_DIR', source)
    monkeypatch.setattr(books, 'AUDIO_DIR', audio)
    monkeypatch.setattr(books, '_tts_processes', {}, raising=False)
    return audio / 'Example.tts_lock'


def test_overlapping_restart_after_error_launches_once(auth_headers, lock, processes, monkeypatch):
    lock.write_text('-1')
    first_read, second_read, release = threading.Event(), threading.Event(), threading.Event()
    original_read = Path.read_text

    def slow_read(path, *args, **kwargs):
        value = original_read(path, *args, **kwargs)
        if path == lock:
            if not first_read.is_set():
                first_read.set()
                assert release.wait(5)
            else:
                second_read.set()
        return value

    monkeypatch.setattr(Path, 'read_text', slow_read)

    def start():
        with app.test_client() as client:
            return client.post('/api/tts/start/Example', headers=auth_headers).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(start)
        try:
            assert first_read.wait(5)
            second = pool.submit(start)
            second_read.wait(0.2)  # the second read must wait for the start lock
        finally:
            release.set()
        assert sorted([first.result(timeout=5), second.result(timeout=5)]) == [200, 409]
    assert len(processes) == 1


@pytest.fixture
def processes(monkeypatch):
    launched = []

    def launch(*args, **kwargs):
        process = Mock()
        process.poll.return_value = None
        launched.append(process)
        return process

    monkeypatch.setattr(books.subprocess, 'Popen', launch)
    monkeypatch.setattr(books.subprocess, 'run', Mock())
    return launched


def test_failed_progress_does_not_override_a_live_child(client, auth_headers, lock, processes):
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 200
    lock.write_text('-1')
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 409
    assert len(processes) == 1


def test_stop_reaps_owned_child_before_restart(client, auth_headers, lock, processes):
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 200
    assert client.post('/api/tts/stop/Example', headers=auth_headers).status_code == 200
    processes[0].terminate.assert_called_once()
    processes[0].wait.assert_called_once()
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 200
    assert len(processes) == 2


def test_dead_owned_child_does_not_leave_a_stuck_reservation(client, auth_headers, lock, processes):
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 200
    processes[0].poll.return_value = 1  # hard crash before progress cleanup
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 200
    assert len(processes) == 2


def test_unconfirmed_stop_cannot_allow_a_second_child(client, auth_headers, lock, processes):
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 200
    processes[0].wait.side_effect = subprocess.TimeoutExpired('fixture-tts', 2)
    assert client.post('/api/tts/stop/Example', headers=auth_headers).status_code == 500
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 409
    assert len(processes) == 1


@pytest.mark.parametrize('progress,status', [('20', 409), (None, 200)])
def test_stop_without_ownership_never_signals_or_changes_progress(
        client, auth_headers, lock, monkeypatch, progress, status):
    if progress is not None:
        lock.write_text(progress)
    signals = Mock()
    monkeypatch.setattr(books.subprocess, 'run', signals)
    response = client.post('/api/tts/stop/Example', headers=auth_headers)
    assert response.status_code == status
    assert (lock.read_text() if lock.exists() else None) == progress
    signals.assert_not_called()


def test_failed_spawn_allows_retry(client, auth_headers, lock, monkeypatch):
    spawn = Mock(side_effect=[OSError('simulated process exhaustion'), Mock()])
    monkeypatch.setattr(books.subprocess, 'Popen', spawn)
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 500
    assert client.post('/api/tts/start/Example', headers=auth_headers).status_code == 200
    assert spawn.call_count == 2
