"""Terminal two-step code (TOTP), audit log and Gallery path safety."""
import base64, json, time
import pytest

from routes import security


@pytest.fixture()
def secret(tmp_path, monkeypatch):
    f = tmp_path / 'totp.json'
    s = base64.b32encode(b'12345678901234567890').decode()       # RFC 6238 test secret
    f.write_text(json.dumps({'secret': s, 'last_step': 0}))
    monkeypatch.setenv('DECLOUD_TOTP_FILE', str(f))
    security._unlocked.clear(); security._fails.clear(); security._locked_until = 0.0
    return s


def test_rfc6238_vector(secret):
    assert security._code(secret, 59 // 30) == '287082'


def test_code_accepted_once_only(secret):
    now = 1_700_000_000
    code = security._code(secret, now // 30)
    assert security.verify(code, now) is True
    assert security.verify(code, now) is False                    # replay
    assert security.verify('000000', now) is False
    assert security.verify('abc', now) is False


def test_terminal_unlock_flow(client, auth_headers, secret):
    r = client.get('/api/terminal/status', headers=auth_headers).get_json()
    assert r['configured'] and not r['unlocked']
    code = security._code(secret, int(time.time() // 30) + 1)
    assert client.post('/api/terminal/unlock', json={'code': '123456'}, headers=auth_headers).status_code == 401
    assert client.post('/api/terminal/unlock', json={'code': code}, headers=auth_headers).status_code == 200
    assert client.get('/api/terminal/status', headers=auth_headers).get_json()['unlocked']


def test_unlock_needs_setup(client, auth_headers, tmp_path, monkeypatch):
    monkeypatch.setenv('DECLOUD_TOTP_FILE', str(tmp_path / 'missing.json'))
    assert client.post('/api/terminal/unlock', json={'code': '123456'}, headers=auth_headers).status_code == 409


def test_logs_need_login(client):
    assert client.get('/api/logs').status_code == 401


@pytest.mark.parametrize('path', ['../../etc/passwd', '/etc/passwd', 'sub/../../etc/passwd', 'a.txt'])
def test_gallery_file_rejects_non_media_and_traversal(client, auth_headers, path):
    for ep in ('file', 'thumb', 'info'):
        assert client.get('/api/gallery/' + ep, query_string={'path': path}, headers=auth_headers).status_code == 404
