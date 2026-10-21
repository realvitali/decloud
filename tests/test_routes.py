"""
Basic route tests for DeCloud.
Run with: python -m pytest tests/ -v
"""
import pytest
import sys
import os
import tempfile
from pathlib import Path

# Add parent dir to path so we can import the app
sys.path.insert(0, str(Path(__file__).parent.parent))

_TMP = Path(tempfile.gettempdir())

# Set test env vars before importing
os.environ.setdefault('DECLOUD_PORT', '8899')
os.environ.setdefault('DECLOUD_BOOKS_DIR', str(_TMP / 'test-books'))
os.environ.setdefault('DECLOUD_FILES_DIR', str(_TMP / 'test-files'))
os.environ.setdefault('SECRET_KEY', 'test-secret-key-for-pytest')

# Create test dirs (cross-platform)
(_TMP / 'test-books').mkdir(exist_ok=True)
(_TMP / 'test-files').mkdir(exist_ok=True)

from app import app


@pytest.fixture
def client():
    """Flask test client, authenticated with the test passcode."""
    app.config['TESTING'] = True
    with app.test_client() as client:
        client.post('/api/auth/login', json={'pin': os.environ.get('DECLOUD_PIN', '')})
        yield client


class TestHealth:
    """Core health and serving tests."""

    def test_index_loads(self, client):
        """Main page should load."""
        resp = client.get('/')
        assert resp.status_code == 200

    def test_manifest_json(self, client):
        """PWA manifest should be served."""
        resp = client.get('/static/manifest.json')
        assert resp.status_code == 200

    def test_service_worker(self, client):
        """Service worker should be served."""
        resp = client.get('/static/sw.js')
        assert resp.status_code == 200


class TestSystemMonitor:
    """System info endpoints."""

    def test_system_stats(self, client):
        """System stats should return JSON with CPU/RAM."""
        resp = client.get('/api/system')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data is not None


class TestFileBrowser:
    """File browser (Lego) endpoints."""

    def test_browse_root(self, client):
        """Should browse the root files directory."""
        resp = client.get('/api/lego/browse')
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'items' in data
        assert 'breadcrumbs' in data

    def test_browse_empty_path(self, client):
        """Empty path should return root listing."""
        resp = client.get('/api/lego/browse?path=')
        assert resp.status_code == 200

    def test_browse_nonexistent(self, client):
        """Nonexistent path should 404."""
        resp = client.get('/api/lego/browse?path=nonexistent_dir_12345')
        assert resp.status_code == 404

    def test_download_no_path(self, client):
        """Download without path should 400."""
        resp = client.get('/api/lego/download')
        assert resp.status_code == 400


class TestBooks:
    """Books / audiobook endpoints."""

    def test_books_list(self, client):
        """Should return book list (may be empty)."""
        resp = client.get('/api/books')
        assert resp.status_code == 200


class TestAuth:
    """Authentication endpoints (open-mode behavior via monkeypatch)."""

    def test_check_auth_open_mode(self, client, monkeypatch):
        """In open mode (no DECLOUD_PIN), auth check should pass."""
        import shared
        import routes.auth as auth_module
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(shared, 'INSECURE_OPEN', True)
        monkeypatch.setattr(auth_module, 'DECLOUD_PIN', '')
        resp = client.get('/api/auth/check')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['authenticated'] is True
        assert data['open_mode'] is True

    def test_login_open_mode(self, client, monkeypatch):
        """In open mode, login should succeed without a passcode."""
        import shared
        import routes.auth as auth_module
        monkeypatch.setattr(shared, 'DECLOUD_PIN', '')
        monkeypatch.setattr(shared, 'INSECURE_OPEN', True)
        monkeypatch.setattr(auth_module, 'DECLOUD_PIN', '')
        resp = client.post('/api/auth/login', json={'pin': ''})
        assert resp.status_code == 200


def test_lab_pairing_code_roundtrip():
    import lab_report
    fp = 'a' * 64
    code = lab_report.pairing_code('https://10.0.0.5:8898', 'tok', 'pi', fp)
    assert lab_report.parse_pairing_code(code) == {'u': 'https://10.0.0.5:8898', 't': 'tok', 'n': 'pi', 'f': fp}
    for bad in ('', 'hello', 'dcl1.!!!', lab_report.pairing_code('http://10.0.0.5:8898', 'tok', 'x', fp),
                lab_report.pairing_code('https://10.0.0.5:8898', 'tok', 'x', 'nope')):
        with pytest.raises(ValueError):
            lab_report.parse_pairing_code(bad)


def test_lab_pairing_end_to_end(tmp_path):
    """Numeric-comparison pairing over pinned TLS: numbers match, pins hold,
    tampering and denial both fail."""
    import lab_report as L
    st = L.State(tmp_path)
    shown, answer = {}, {'ok': True}

    def approve(hub, number):
        shown['n'] = number
        return answer['ok']

    srv = L.LabServer(st, 'dev', lambda: {'ok': 1}, approve, host='127.0.0.1', port=0).start()
    url = f'https://127.0.0.1:{srv.port}'
    try:
        assert any(f['fp'] == st.fp for f in L.discover(timeout=0.8, port=srv.port))
        job = L.pair_start(url, 'hub')
        token = L.pair_finish(job)
        assert shown['n'] == job['number'] and job['fp'] == st.fp and token == st.token
        assert L.fetch_report(url, token, st.fp) == {'ok': 1}
        with pytest.raises(L.PinError):
            L.fetch_report(url, token, '0' * 64)
        with pytest.raises(PermissionError):
            L.fetch_report(url, 'wrong', st.fp)
        tampered = L.pair_start(url, 'hub')
        tampered['nh'] = '0' * 32  # reveal doesn't match the commitment
        with pytest.raises(PermissionError):
            L.pair_finish(tampered)
        answer['ok'] = False
        with pytest.raises(PermissionError):
            L.pair_finish(L.pair_start(url, 'hub'))
        st.reset_token()
        with pytest.raises(PermissionError):
            L.fetch_report(url, token, st.fp)
    finally:
        srv.stop()


def test_lab_peer_report_is_sanitized():
    from routes.lab import _clean
    evil = {'cpu_percent': '1%"><img src=x onerror=alert(1)>', 'cores': '<b>', 'temp': 'x"',
            'storage': {'total': 'NaN', 'volumes': '"'}, 'gpus': [{'name': 'g', 'vram_gb': '"'}],
            'running': {'models': ['ok', {'x': 1}], 'containers': 'nope'}, 'kind': '<script>'}
    c = _clean(evil)
    assert c['cpu_percent'] == 0 and c['cores'] == 0 and c['temp'] is None and c['kind'] == 'decloud'
    assert c['storage']['total'] == 0 and c['gpus'][0]['vram_gb'] is None
    assert c['running']['models'] == ['ok'] and c['running']['containers'] == []
