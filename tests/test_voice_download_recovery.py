"""Interrupted HTTP transfers must not publish installable voice files."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading

import pytest

import routes.voice as voice


@pytest.fixture
def server():
    state = {'drop': '.onnx', 'status': 200, 'requests': []}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state['requests'].append(self.path)
            if state['status'] != 200:
                self.send_error(state['status'])
                return
            data = b'{"voice":"fixture"}' if self.path.endswith('.json') else b'M' * 32768
            self.send_response(200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if state['drop'] and self.path.endswith(state['drop']):
                self.wfile.write(data[:max(1, len(data) // 2)])
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
            else:
                self.wfile.write(data)

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{httpd.server_port}/voice', state
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(5)


@pytest.fixture
def model(tmp_path, monkeypatch, server):
    base, _ = server
    target = tmp_path / 'voice.onnx'
    monkeypatch.setattr(voice, '_setup_jobs', {})
    monkeypatch.setattr(voice, 'TTS_ENGINES', {
        'fixture': {'engine': 'piper', 'model': str(target)}})
    monkeypatch.setattr(voice, 'VOICE_MODEL_URLS', {'fixture': base})
    return target


@pytest.mark.parametrize('drop', ['.onnx', '.json'])
def test_interrupted_transfer_is_not_published_and_retry_completes(model, server, drop):
    _, state = server
    state['drop'] = drop
    voice._run_voice_download('job', 'fixture')
    assert voice._setup_jobs['job']['state'] == 'error'
    assert not model.exists()
    assert not voice._tts_installed('fixture')
    assert list(model.parent.iterdir()) == []

    state['drop'] = None
    voice._run_voice_download('job', 'fixture')
    assert voice._setup_jobs['job']['state'] == 'done'
    assert model.read_bytes() == b'M' * 32768
    assert json.loads(Path(str(model) + '.json').read_text()) == {'voice': 'fixture'}
    assert voice._tts_installed('fixture')


def test_installed_voice_is_reused_without_downloading(model, server):
    model.write_bytes(b'working model')
    config = Path(str(model) + '.json')
    config.write_text('{"voice":"old"}')
    voice._run_voice_download('job', 'fixture')
    assert voice._setup_jobs['job']['state'] == 'done'
    assert server[1]['requests'] == []
    assert model.read_bytes() == b'working model'
    assert config.read_text() == '{"voice":"old"}'


@pytest.mark.parametrize('existing_suffix,missing_suffix', [('', '.onnx.json'), ('.json', '.onnx')])
def test_repair_fetches_only_the_missing_component(model, server, existing_suffix, missing_suffix):
    existing = Path(str(model) + existing_suffix)
    existing.write_bytes(b'keep this file')
    assert not voice._tts_installed('fixture')
    server[1]['drop'] = None
    voice._run_voice_download('job', 'fixture')
    assert voice._setup_jobs['job']['state'] == 'done'
    assert existing.read_bytes() == b'keep this file'
    assert server[1]['requests'] == ['/voice' + missing_suffix]
    assert voice._tts_installed('fixture')


@pytest.mark.skipif(os.name == 'nt' or not all(shutil.which(cmd) for cmd in ('bash', 'curl')),
                    reason='POSIX installer requires bash and curl')
@pytest.mark.parametrize('failure', ['disconnect', 'http-error'])
def test_installer_retries_failed_transfer_and_skips_completed_files(tmp_path, server, failure):
    base, state = server
    if failure == 'http-error':
        state['status'] = 404
    installer = (Path(__file__).resolve().parents[1] / 'install.sh').read_text()
    helper = installer[installer.index('_fetch_voice() {'):]
    helper = helper[:helper.index('\n}\n') + 3]
    helper = helper.replace('https://huggingface.co/', base + '/')
    env = dict(os.environ, PIPER_DIR=str(tmp_path))

    def run():
        subprocess.run(['bash', '-c', helper + '\n_fetch_voice lessac high\n'],
                       env=env, capture_output=True, text=True, check=True, timeout=10)

    run()
    assert not (tmp_path / 'en_US-lessac-high.onnx').exists()
    assert not list(tmp_path.glob('*.part.*'))
    state.update(drop=None, status=200)
    run()
    assert (tmp_path / 'en_US-lessac-high.onnx').read_bytes() == b'M' * 32768
    assert json.loads((tmp_path / 'en_US-lessac-high.onnx.json').read_text()) == {'voice': 'fixture'}
    completed_calls = list(state['requests'])
    run()
    assert state['requests'] == completed_calls
    assert len(list(tmp_path.iterdir())) == 2
