"""Regression tests for the auth/settings/env/terminal/lab/update hardening."""
import os
import socket
import stat
import time

import pytest

import shared


def _mode(p):
    if os.name == 'nt':
        return 0o600  # Windows has no POSIX permission bits to check
    return stat.S_IMODE(os.stat(p).st_mode)


# ─── settings.json / .env / sessions.json writes ────────────────

def test_save_settings_atomic_private_and_corrupt_backup(tmp_path, monkeypatch):
    f = tmp_path / 'settings.json'
    monkeypatch.setattr(shared, 'SETTINGS_FILE', f)
    assert shared.save_settings({'theme': 'dark'})
    assert shared.load_settings() == {'theme': 'dark'} and _mode(f) == 0o600
    f.write_text('{not json')
    assert shared.load_settings() == {}
    assert (tmp_path / 'settings.json.corrupt').read_text() == '{not json'
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith('.tmp')] == []


def test_settings_routes_use_shared_writer(client, auth_headers, tmp_path, monkeypatch):
    monkeypatch.setattr(shared, 'SETTINGS_FILE', tmp_path / 'settings.json')
    assert client.post('/api/settings/theme', json={'theme': 'dark'}, headers=auth_headers).status_code == 200
    assert client.post('/api/settings/experimental', json={'experimental': True},
                       headers=auth_headers).status_code == 200
    assert shared.load_settings() == {'theme': 'dark', 'experimental': True}
    assert client.get('/api/settings/theme', headers=auth_headers).get_json() == {'theme': 'dark'}


def test_set_env_value_rejects_newlines_and_writes_0600(tmp_path, monkeypatch):
    monkeypatch.setattr(shared, 'BASE_DIR', tmp_path)
    env = tmp_path / '.env'
    env.write_text('A=1\n')
    for bad in ('x\nDECLOUD_PIN=1', 'x\r', 'x\0'):
        assert shared.set_env_value('K', bad) is False
    assert env.read_text() == 'A=1\n'
    assert shared.set_env_value('K', 'v') is True
    assert env.read_text() == 'A=1\nK=v\n' and _mode(env) == 0o600
    monkeypatch.delenv('K')


def test_settings_paths_rejects_newline(client, auth_headers, tmp_path, monkeypatch):
    monkeypatch.setattr(shared, 'BASE_DIR', tmp_path)
    r = client.post('/api/settings/paths', json={'books': '/tmp/a\nDECLOUD_PIN=1'}, headers=auth_headers)
    assert r.status_code == 400
    assert not (tmp_path / '.env').exists()


def test_sessions_file_private(tmp_path, monkeypatch):
    monkeypatch.setattr(shared, 'SESSIONS_FILE', tmp_path / 'sessions.json')
    shared.save_sessions()
    assert _mode(tmp_path / 'sessions.json') == 0o600


def test_read_logs_tail_only(tmp_path, monkeypatch):
    log = tmp_path / 'app.log'
    line = '2026-01-01T00:00:00 INFO ' + 'x' * 100 + '\n'
    log.write_text(line * 30000 + '2026-01-02T00:00:00 INFO last\n')  # ~3.8 MB
    monkeypatch.setattr(shared, 'LOG_FILE', log)
    out = shared._read_logs(limit=5)
    assert len(out) == 5 and out[-1]['message'] == 'last'


# ─── terminal teardown ──────────────────────────────────────────

@pytest.mark.skipif(not hasattr(os, 'fork'), reason='POSIX only')
@pytest.mark.parametrize('argv,grace', [
    (['/bin/bash', '--norc', '--noprofile', '-i'], 2.0),            # ignores SIGTERM
    (['/bin/sh', '-c', 'trap "" HUP TERM; sleep 30'], 0.3),        # ignores HUP too
])
def test_end_shell_reaps_child(argv, grace):
    import pty
    from routes.terminal import _end_shell
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execv(argv[0], argv)
        finally:
            os._exit(127)
    time.sleep(0.3)
    _end_shell(pid, fd, grace=grace)
    with pytest.raises(ChildProcessError):
        os.waitpid(pid, os.WNOHANG)          # already reaped
    with pytest.raises(OSError):
        os.close(fd)                         # already closed


# ─── lab server ─────────────────────────────────────────────────

def test_lab_idle_connection_does_not_block_and_bad_length_rejected(tmp_path):
    import lab_report as L
    st = L.State(tmp_path)
    srv = L.LabServer(st, 'dev', lambda: {'ok': 1}, lambda *a: True, host='127.0.0.1', port=0).start()
    idle = socket.create_connection(('127.0.0.1', srv.port))  # never sends a ClientHello
    try:
        url = f'https://127.0.0.1:{srv.port}'
        assert L.fetch_report(url, st.token, st.fp) == {'ok': 1}
        for length in ('-1', '5000', 'abc'):
            status, _, _ = _raw_post(srv.port, length)
            assert status == 400, length
    finally:
        idle.close()
        srv.stop()


def _raw_post(port, length):
    import http.client
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    c = http.client.HTTPSConnection('127.0.0.1', port, context=ctx, timeout=5)
    c.putrequest('POST', '/pair/start')
    c.putheader('Content-Length', length)
    c.endheaders()
    r = c.getresponse()
    out = (r.status, r.read(), None)
    c.close()
    return out


# ─── updater ────────────────────────────────────────────────────

@pytest.fixture
def git_ok(tmp_path, monkeypatch):
    import routes.update as upd
    monkeypatch.setattr(upd, 'UPDATE_META_FILE', tmp_path / '.update_meta.json')
    monkeypatch.setattr(upd, '_git_available', lambda: True)
    monkeypatch.setattr(upd, '_tree_clean', lambda: True)
    monkeypatch.setattr(upd, '_fetch_tags', lambda timeout=90: True)
    monkeypatch.setattr(upd, '_head_sha', lambda: 'cur')
    monkeypatch.setattr(upd, '_resolve_tag_ref', lambda ref: 'target')
    monkeypatch.setattr(upd, '_checkout', lambda sha, timeout=60: False)  # stop before restart
    return upd


def test_update_refuses_downgrade(git_ok):
    code, body = git_ok.perform_update('v0.0.1')
    assert code == 409 and body['code'] == 'DOWNGRADE'


def test_update_allows_rollback_to_recorded_version(git_ok, monkeypatch):
    git_ok.write_update_meta({'prev_version': '0.0.1'})
    monkeypatch.setattr(git_ok, '_on_main', lambda sha: True)
    code, _ = git_ok.perform_update('v0.0.1')
    assert code == 500  # got past the guards to the (stubbed, failing) checkout


def test_update_refuses_tag_off_main(git_ok, monkeypatch):
    monkeypatch.setattr(git_ok, '_on_main', lambda sha: False)
    code, body = git_ok.perform_update('v999.0.0')
    assert code == 409 and body['code'] == 'NOT_ON_MAIN'
