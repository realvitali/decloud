"""WebSocket handshake authentication tests.

The WebSocket upgrade is a normal Flask request (flask-sock registers a
regular view), so before_request gates it — AND every WS handler also
checks ws_is_authenticated() in-handler as defense in depth. These tests
cover the in-handler helper directly.
"""
import time

import pytest

from shared import (
    DECLOUD_PIN, SESSIONS, SESSION_TTL_SECONDS, ws_is_authenticated,
)


def _environ(**overrides):
    base = {
        'HTTP_COOKIE': '',
        'HTTP_AUTHORIZATION': '',
        'QUERY_STRING': '',
        'HTTP_HOST': 'localhost:8899',
        'HTTP_ORIGIN': 'http://localhost:8899',
    }
    base.update(overrides)
    return base


@pytest.fixture
def session_token():
    import secrets
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = time.time() + SESSION_TTL_SECONDS
    yield token
    SESSIONS.pop(token, None)


class TestWsAuthHelper:
    def test_no_credentials_rejected(self, session_token):
        assert ws_is_authenticated(_environ()) is False

    def test_cookie_accepted(self, session_token):
        assert ws_is_authenticated(_environ(HTTP_COOKIE=f'decloud_session={session_token}')) is True

    def test_bearer_accepted(self, session_token):
        assert ws_is_authenticated(_environ(HTTP_AUTHORIZATION=f'Bearer {session_token}')) is True

    def test_query_token_accepted(self, session_token):
        assert ws_is_authenticated(_environ(QUERY_STRING=f'token={session_token}')) is True

    def test_query_token_among_other_params(self, session_token):
        env = _environ(QUERY_STRING=f'cid=abc&token={session_token}')
        assert ws_is_authenticated(env) is True

    def test_unknown_token_rejected(self, session_token):
        env = _environ(HTTP_COOKIE='decloud_session=not-a-real-token')
        assert ws_is_authenticated(env) is False

    def test_expired_token_rejected(self, session_token):
        SESSIONS[session_token] = time.time() - 5
        assert ws_is_authenticated(_environ(QUERY_STRING=f'token={session_token}')) is False

    def test_raw_passcode_rejected(self):
        # The passcode itself must never authenticate a socket
        env = _environ(QUERY_STRING=f'token={DECLOUD_PIN}')
        assert ws_is_authenticated(env) is False

    def test_open_mode_allows(self, monkeypatch):
        import shared
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(shared, 'INSECURE_OPEN', True)
        assert ws_is_authenticated(_environ()) is True

    def test_no_pin_without_open_flag_fails_closed(self, monkeypatch):
        import shared
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(shared, 'INSECURE_OPEN', False)
        assert ws_is_authenticated(_environ()) is False


class TestWsOriginHost:
    """N1: a hostile page must not open the terminal socket, in any mode."""

    def test_missing_origin_rejected(self, session_token):
        env = _environ(HTTP_ORIGIN='', HTTP_COOKIE=f'decloud_session={session_token}')
        assert ws_is_authenticated(env) is False

    def test_cross_site_origin_rejected(self, session_token):
        env = _environ(HTTP_ORIGIN='https://evil.example',
                       HTTP_COOKIE=f'decloud_session={session_token}')
        assert ws_is_authenticated(env) is False

    def test_other_local_port_origin_rejected(self, session_token):
        env = _environ(HTTP_ORIGIN='http://localhost:3000',
                       HTTP_COOKIE=f'decloud_session={session_token}')
        assert ws_is_authenticated(env) is False

    def test_rebound_host_rejected(self, session_token):
        # DNS rebinding: Origin and Host agree, but the name isn't ours
        env = _environ(HTTP_HOST='evil.example:8899', HTTP_ORIGIN='http://evil.example:8899',
                       HTTP_COOKIE=f'decloud_session={session_token}')
        assert ws_is_authenticated(env) is False

    def test_open_mode_still_checks_origin(self, monkeypatch):
        import shared
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(shared, 'INSECURE_OPEN', True)
        assert ws_is_authenticated(_environ(HTTP_ORIGIN='https://evil.example')) is False
        assert ws_is_authenticated(_environ(HTTP_ORIGIN='')) is False

    def test_funnel_origin_accepted(self, session_token):
        env = _environ(HTTP_HOST='box.tail1234.ts.net', HTTP_ORIGIN='https://box.tail1234.ts.net',
                       HTTP_COOKIE=f'decloud_session={session_token}')
        assert ws_is_authenticated(env) is True
