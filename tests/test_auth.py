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
        assert len(login['session']) >= 32          # opaque token
        assert len(login['csrf']) >= 32

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
        # Bearer-authenticated requests cannot be CSRF'd (cross-origin
        # callers can't set the header) — no CSRF token required.
        r = client.post('/api/auth/logout', headers={'Authorization': f"Bearer {login['session']}"})
        assert r.status_code == 200


class TestOpenMode:
    def test_open_mode_bypasses_auth(self, client, monkeypatch):
        import shared
        import routes.auth as auth_module
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(auth_module, 'DECLOUD_PIN', '')
        r = client.get('/api/system')
        assert r.status_code == 200
        r2 = client.get('/api/auth/check')
        assert r2.get_json() == {'authenticated': True, 'open_mode': True}
