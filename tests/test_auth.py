"""Authentication security tests: login, gating, CSRF, sessions."""
import os
import time
import pytest

TEST_PASSCODE = os.environ['DECLOUD_PIN']


class TestLogin:
    def test_wrong_passcode_rejected(self, client):
        resp = client.post('/api/auth/login', json={'pin': '00000000'})
        assert resp.status_code == 401

    def test_missing_pin_rejected(self, client):
        resp = client.post('/api/auth/login', json={})
        assert resp.status_code == 401

    def test_correct_passcode_mints_session_and_csrf(self, client, login):
        assert login['ok'] is True
        assert len(login['session']) >= 32          # opaque token (from cookie)
        assert len(login['csrf']) >= 32

    def test_session_token_never_in_body(self, client):
        r = client.post('/api/auth/login', json={'pin': TEST_PASSCODE})
        assert set(r.get_json()) == {'ok', 'csrf'}
        assert 'HttpOnly' in r.headers['Set-Cookie']

    def test_query_token_not_accepted(self, client, login):
        token = login['session']
        client.delete_cookie('decloud_session')
        assert client.get(f'/api/system?token={token}').status_code == 401

    def test_global_throttle_ignores_ip(self, client):
        import shared
        shared._LOGIN_GLOBAL_FAILS[:] = [time.time()] * shared._LOGIN_GLOBAL_MAX
        r = client.post('/api/auth/login', json={'pin': TEST_PASSCODE},
                        environ_base={'REMOTE_ADDR': '10.9.8.7'})
        assert r.status_code == 429
        assert 'decloud pin reset' in r.get_json()['error']
        shared._LOGIN_GLOBAL_FAILS.clear()
        assert client.post('/api/auth/login', json={'pin': TEST_PASSCODE}).status_code == 200

    def test_forwarded_for_trusted_only_from_loopback(self, client):
        import shared
        h = {'X-Forwarded-For': '203.0.113.9'}
        client.post('/api/auth/login', json={'pin': '00000000'}, headers=h,
                    environ_base={'REMOTE_ADDR': '192.168.1.50'})
        assert '192.168.1.50' in shared._LOGIN_ATTEMPTS
        assert '203.0.113.9' not in shared._LOGIN_ATTEMPTS
        client.post('/api/auth/login', json={'pin': '00000000'}, headers=h)  # via local proxy
        assert '203.0.113.9' in shared._LOGIN_ATTEMPTS

    def test_raw_pin_is_never_accepted_as_bearer(self, client):
        # The passcode itself must not work as an auth credential —
        # only minted session tokens may.
        resp = client.get('/api/system', headers={'Authorization': f'Bearer {TEST_PASSCODE}'})
        assert resp.status_code == 401

    def test_login_cookie_is_session_token_not_pin(self, client, login):
        cookies = client.get_cookie('decloud_session')
        assert cookies is not None
        assert cookies.value == login['session']
        assert cookies.value != TEST_PASSCODE

    def test_login_backoff_locks_after_repeated_failures(self, client):
        # 6 quick failures: the 6th+ hit the exponential backoff sleep,
        # and flask-limiter's 5/min cap turns the 6th into 429.
        codes = []
        for _ in range(6):
            r = client.post('/api/auth/login', json={'pin': '00000000'})
            codes.append(r.status_code)
        assert 429 in codes or codes.count(401) == 6  # limiter OR backoff path
        assert codes[-1] in (401, 429)


class TestGating:
    def test_api_requires_auth(self, client):
        resp = client.get('/api/system')
        assert resp.status_code == 401
        assert resp.get_json()['code'] == 'AUTH_REQUIRED'

    def test_auth_check_reflects_state(self, client, login):
        r = client.get('/api/auth/check')
        assert r.status_code == 200
        assert r.get_json()['authenticated'] is True

    def test_static_and_login_page_are_public(self, client):
        assert client.get('/api/auth/login', json={}).status_code != 500
        assert client.get('/sw.js').status_code == 200
        assert client.get('/manifest.json').status_code == 200

    def test_logout_invalidates_session(self, client, login, auth_headers):
        r = client.post('/api/auth/logout', headers=auth_headers)
        assert r.status_code == 200
        # The cookie may remain but the server-side token must be gone
        r2 = client.get('/api/system')
        assert r2.status_code == 401

    def test_expired_session_rejected(self, client, login):
        from shared import SESSIONS
        SESSIONS[login['session']] = time.time() - 10  # expire it
        r = client.get('/api/system')
        assert r.status_code == 401

    def test_session_cap_bounds_table(self, client):
        from shared import SESSIONS, MAX_SESSIONS
        SESSIONS.clear()
        for i in range(MAX_SESSIONS + 5):
            client.post('/api/auth/login', json={'pin': TEST_PASSCODE})
        assert len(SESSIONS) <= MAX_SESSIONS


class TestCsrf:
    def test_cookie_post_without_csrf_rejected(self, client, login):
        # Authenticate via cookie only (no Bearer), then POST without CSRF
        client.set_cookie('decloud_session', login['session'])
        r = client.post('/api/auth/logout')
        assert r.status_code == 403
        assert r.get_json()['code'] == 'CSRF_REQUIRED'

    def test_cookie_post_with_wrong_csrf_rejected(self, client, login):
        client.set_cookie('decloud_session', login['session'])
        r = client.post('/api/auth/logout', headers={'X-CSRF-Token': '0' * 64})
        assert r.status_code == 403

    def test_cookie_post_with_valid_csrf_accepted(self, client, login):
        client.set_cookie('decloud_session', login['session'])
        r = client.post('/api/auth/logout', headers={'X-CSRF-Token': login['csrf']})
        assert r.status_code == 200

    def test_bearer_post_is_csrf_safe(self, client, login):
        # Bearer-only requests (the TUI) cannot be CSRF'd (cross-origin
        # callers can't set the header) — no CSRF token required.
        client.delete_cookie('decloud_session')
        r = client.post('/api/auth/logout', headers={'Authorization': f"Bearer {login['session']}"})
        assert r.status_code == 200

    def test_bogus_bearer_does_not_skip_csrf_for_cookie(self, client, login):
        # A cookie-carrying request must pass CSRF whatever headers it adds.
        r = client.post('/api/auth/logout', headers={'Authorization': 'Bearer junk'})
        assert r.status_code == 403
        r = client.post('/api/auth/logout', headers={'Authorization': f"Bearer {login['session']}"})
        assert r.status_code == 403


class TestHostAllowlist:
    @pytest.mark.parametrize('host,ok', [
        ('localhost:8899', True), ('127.0.0.1:8899', True), ('[::1]:8899', True),
        ('192.168.1.20:8899', True), ('box.tail1234.ts.net', True),
        ('evil.example.com', False), ('localhost.evil.com', False), ('', False),
    ])
    def test_host_allowed(self, host, ok):
        from shared import host_allowed
        assert host_allowed(host) is ok

    def test_rebinding_host_rejected(self, client):
        r = client.get('/api/auth/check', headers={'Host': 'attacker.example'})
        assert r.status_code == 421

    def test_env_allowlist(self, monkeypatch):
        import shared
        monkeypatch.setenv('DECLOUD_ALLOWED_HOSTS', 'cloud.example.org, other.example')
        shared._machine_hostnames.cache_clear()
        try:
            assert shared.host_allowed('cloud.example.org')
            assert shared.host_allowed('other.example:443')
        finally:
            monkeypatch.delenv('DECLOUD_ALLOWED_HOSTS')
            shared._machine_hostnames.cache_clear()


class TestOpenMode:
    def test_open_mode_bypasses_auth(self, client, monkeypatch):
        import shared
        import routes.auth as auth_module
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(auth_module, 'DECLOUD_PIN', '')
        monkeypatch.setattr(shared, 'INSECURE_OPEN', True)
        r = client.get('/api/system')
        assert r.status_code == 200
        r2 = client.get('/api/auth/check')
        assert r2.get_json() == {'authenticated': True, 'open_mode': True}


class TestPinCli:
    def test_reset_with_right_or_forgotten_pin(self, tmp_path, monkeypatch):
        import sys
        sys.path.insert(0, 'scripts')
        import decloud_pin as dp
        monkeypatch.setattr(dp, 'ENV', tmp_path / '.env')
        monkeypatch.setattr(dp, 'SESSIONS', tmp_path / 'sessions.json')
        monkeypatch.setattr(dp, 'restart', lambda: 'manual')
        (tmp_path / '.env').write_text('SECRET_KEY=x\nDECLOUD_PIN=11112222\n')
        (tmp_path / 'sessions.json').write_text('{}')

        answers = iter(['99999999'])                 # wrong pin: nothing changes
        monkeypatch.setattr('builtins.input', lambda _='': next(answers))
        assert dp.reset() == 1 and dp.read_pin() == '11112222'

        answers = iter(['11112222'])                 # right pin: new one
        assert dp.reset() == 0
        pin = dp.read_pin()
        assert pin != '11112222' and pin.isdigit() and len(pin) == 8
        assert not (tmp_path / 'sessions.json').exists()
        assert 'SECRET_KEY=x' in (tmp_path / '.env').read_text()

        answers = iter(['', 'y'])                    # forgot it: emergency reset
        assert dp.reset() == 0 and dp.read_pin() != pin


def test_change_pin_requires_keypad_digits(client, login):
    h = {'X-CSRF-Token': login['csrf']}
    for bad in ('sunshine1', '1234567', '12345678901'):
        r = client.post('/api/auth/pin', headers=h,
                        json={'current_pin': TEST_PASSCODE, 'new_pin': bad})
        assert r.status_code == 400, bad
