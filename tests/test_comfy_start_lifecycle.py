"""An owned ComfyUI process is already starting before HTTP is ready."""
import pytest
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

from app import app
import routes.comfy as comfy


@pytest.fixture
def processes(tmp_path, monkeypatch):
    monkeypatch.setattr(comfy, '_comfy_process', None, raising=False)
    monkeypatch.setattr(comfy, '_comfy_online', lambda: False)
    monkeypatch.setattr(comfy, '_comfy_strategy', lambda: ('cmd', ['fixture-comfy']))
    monkeypatch.setattr(comfy, 'COMFY_PID_FILE', tmp_path / 'comfy.pid')
    monkeypatch.setattr(comfy, 'COMFY_LOG_FILE', tmp_path / 'comfy.log')
    monkeypatch.setattr(comfy.os, 'kill', lambda *args: None)
    launched = []

    def launch(*args, **kwargs):
        proc = Mock(pid=12345)
        proc.poll.return_value = None
        launched.append(proc)
        return proc

    monkeypatch.setattr(comfy.subprocess, 'Popen', launch)
    return launched


def test_exited_process_can_be_restarted(client, auth_headers, processes):
    assert client.post('/api/comfy/start', headers=auth_headers).status_code == 200
    processes[0].poll.return_value = 1
    assert client.post('/api/comfy/start', headers=auth_headers).status_code == 200
    assert len(processes) == 2


def test_stop_reaps_owned_child(client, auth_headers, processes):
    assert client.post('/api/comfy/start', headers=auth_headers).status_code == 200
    assert client.post('/api/comfy/stop', headers=auth_headers).status_code == 200
    processes[0].terminate.assert_called_once()
    processes[0].wait.assert_called_once()
    assert comfy._comfy_process is None
    assert not comfy.COMFY_PID_FILE.exists()


def test_concurrent_requests_reserve_launch_before_popen_returns(
        auth_headers, processes, monkeypatch):
    entered, release, second_launch = threading.Event(), threading.Event(), threading.Event()
    spawn = comfy.subprocess.Popen

    def delayed_launch(*args, **kwargs):
        if entered.is_set():
            second_launch.set()
        entered.set()
        assert release.wait(5)
        return spawn(*args, **kwargs)

    monkeypatch.setattr(comfy.subprocess, 'Popen', delayed_launch)

    def start():
        with app.test_client() as client:
            return client.post('/api/comfy/start', headers=auth_headers).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(start)
        try:
            assert entered.wait(5)
            second = pool.submit(start)
            second_launch.wait(0.2)
        finally:
            release.set()
        assert [first.result(timeout=5), second.result(timeout=5)] == [200, 200]
    assert len(processes) == 1
