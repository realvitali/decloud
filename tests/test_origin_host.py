"""N1: Host allowlist + Origin checks, and the defanged open mode.

A hostile web page (or a DNS-rebound hostname) must not reach the API or
the terminal WebSocket — in PIN mode or in open mode. Open mode itself
must be an explicit opt-in that refuses LAN binds and Tailscale Funnel.
"""
import os

import pytest

TEST_PASSCODE = os.environ['DECLOUD_PIN']


@pytest.fixture
def bare_client():
    """A test client that sends no Origin header (like curl)."""
    from app import app
    app.config['TESTING'] = True
    with app.test_client() as c:
        yield c


@pytest.fixture
def open_mode(monkeypatch):
    import shared
    import routes.auth as auth_module
    monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
    monkeypatch.setattr(auth_module, 'DECLOUD_PIN', '')
    monkeypatch.setattr(shared, 'INSECURE_OPEN', True)


class TestHostAllowlist:
    @pytest.mark.parametrize('host', [
        'localhost', 'localhost:8899', '127.0.0.1:8899', '[::1]:8899',
        '100.101.102.103:8899', 'box.tail1234.ts.net', 'abc-def.trycloudflare.com',
    ])
    def test_allowed(self, host):
        from shared import host_allowed
        assert host_allowed(host) is True

    @pytest.mark.parametrize('host', [
        '', 'evil.example', 'evil.example:8899', 'localhost.evil.example',
        'ts.net.evil.example', '[::1',
    ])
    def test_rejected(self, host):
        from shared import host_allowed
        assert host_allowed(host) is False

    def test_extra_hosts_from_env(self, monkeypatch):
        import shared
        monkeypatch.setattr(shared, 'ALLOWED_HOSTS', {'mybox'})
        assert shared.host_allowed('mybox:8899') is True
        assert shared.host_allowed('otherbox:8899') is False

    def test_rebound_host_gets_403_on_page(self, client):
        r = client.get('/', environ_overrides={'HTTP_HOST': 'evil.example:8899'})
        assert r.status_code == 403
        assert r.get_json()['code'] == 'BAD_HOST'

    def test_rebound_host_gets_403_in_open_mode(self, client, open_mode):
        r = client.get('/api/system', environ_overrides={'HTTP_HOST': 'evil.example:8899'})
        assert r.status_code == 403


class TestOriginMatchesHost:
    @pytest.mark.parametrize('origin,host', [
        ('http://localhost:8899', 'localhost:8899'),
        ('https://box.tail1234.ts.net', 'box.tail1234.ts.net'),
        ('https://box.tail1234.ts.net', 'box.tail1234.ts.net:443'),
        ('http://LOCALHOST:8899', 'localhost:8899'),
    ])
    def test_same_origin(self, origin, host):
        from shared import origin_matches_host
        assert origin_matches_host(origin, host) is True

    @pytest.mark.parametrize('origin,host', [
        ('', 'localhost:8899'),
        ('null', 'localhost:8899'),
        ('https://evil.example', 'localhost:8899'),
        ('http://localhost:3000', 'localhost:8899'),
        ('http://localhost', 'localhost:8899'),
        ('file://', 'localhost:8899'),
        ('https://other.tail1234.ts.net', 'box.tail1234.ts.net'),
    ])
    def test_cross_site(self, origin, host):
        from shared import origin_matches_host
        assert origin_matches_host(origin, host) is False


class TestOriginGate:
    def test_login_without_origin_refused(self, bare_client):
        r = bare_client.post('/api/auth/login', json={'pin': TEST_PASSCODE})
        assert r.status_code == 403
        assert r.get_json()['code'] == 'BAD_ORIGIN'

    def test_login_cross_site_refused(self, client):
        r = client.post('/api/auth/login', json={'pin': TEST_PASSCODE},
                        headers={'Origin': 'https://evil.example'})
        assert r.status_code == 403

    def test_bearer_post_cross_site_refused(self, client, auth_headers):
        h = dict(auth_headers, Origin='https://evil.example')
        r = client.post('/api/auth/logout', headers=h)
        assert r.status_code == 403

    def test_same_origin_post_accepted(self, client, auth_headers):
        r = client.post('/api/auth/logout', headers=auth_headers)
        assert r.status_code == 200

    def test_get_without_origin_still_works(self, bare_client):
        assert bare_client.get('/').status_code == 200
        assert bare_client.get('/api/auth/check').status_code == 401

    def test_ws_upgrade_cross_site_refused(self, client):
        r = client.get('/api/terminal/ws', headers={
            'Upgrade': 'websocket', 'Connection': 'Upgrade',
            'Origin': 'https://evil.example',
        })
        assert r.status_code == 403
        assert r.get_json()['code'] == 'BAD_ORIGIN'

    def test_ws_upgrade_without_origin_refused(self, bare_client):
        r = bare_client.get('/api/terminal/ws', headers={
            'Upgrade': 'websocket', 'Connection': 'Upgrade',
        })
        assert r.status_code == 403

    def test_open_mode_cross_site_post_refused(self, client, open_mode):
        r = client.post('/api/auth/logout', headers={'Origin': 'https://evil.example'})
        assert r.status_code == 403

    def test_open_mode_cross_site_ws_refused(self, client, open_mode):
        r = client.get('/api/terminal/ws', headers={
            'Upgrade': 'websocket', 'Connection': 'Upgrade',
            'Origin': 'https://evil.example',
        })
        assert r.status_code == 403


class TestOpenModeIsOptIn:
    def test_no_pin_without_flag_fails_closed(self, client, monkeypatch):
        import shared
        import routes.auth as auth_module
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(auth_module, 'DECLOUD_PIN', '')
        monkeypatch.setattr(shared, 'INSECURE_OPEN', False)
        assert client.get('/api/system').status_code == 401
        r = client.get('/api/auth/check')
        assert r.status_code == 401
        assert r.get_json()['open_mode'] is False
        r = client.post('/api/auth/login', json={'pin': ''})
        assert r.status_code == 503
        assert r.get_json()['code'] == 'NO_PIN'

    def test_flag_enables_open_mode(self, client, open_mode):
        assert client.get('/api/system').status_code == 200


class TestOpenModeRefusals:
    def test_pin_mode_never_refused(self, monkeypatch):
        import app as app_module
        monkeypatch.setattr(app_module, '_funnel_active', lambda: True)
        assert app_module.open_mode_refusal('0.0.0.0') is None

    def test_no_pin_no_flag_not_refused_here(self, monkeypatch):
        # Fails closed at the API instead (see TestOpenModeIsOptIn)
        import shared
        import app as app_module
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(shared, 'INSECURE_OPEN', False)
        assert app_module.open_mode_refusal('0.0.0.0') is None

    @pytest.mark.parametrize('bind', ['0.0.0.0', '192.168.1.20', '100.101.102.103', '::'])
    def test_open_mode_refuses_non_loopback_bind(self, monkeypatch, open_mode, bind):
        import app as app_module
        monkeypatch.setattr(app_module, '_funnel_active', lambda: False)
        assert 'refuses to bind' in app_module.open_mode_refusal(bind)

    def test_open_mode_refuses_funnel(self, monkeypatch, open_mode):
        import app as app_module
        monkeypatch.setattr(app_module, '_funnel_active', lambda: True)
        assert 'Funnel' in app_module.open_mode_refusal('127.0.0.1')

    def test_open_mode_loopback_without_funnel_ok(self, monkeypatch, open_mode):
        import app as app_module
        monkeypatch.setattr(app_module, '_funnel_active', lambda: False)
        assert app_module.open_mode_refusal('127.0.0.1') is None
