"""
Basic route tests for DeCloud.
Run with: python -m pytest tests/ -v
"""
import pytest
import sys
import os
from pathlib import Path

# Add parent dir to path so we can import the app
sys.path.insert(0, str(Path(__file__).parent.parent))

# Set test env vars before importing
os.environ.setdefault('DECLOUD_PORT', '8899')
os.environ.setdefault('DECLOUD_BOOKS_DIR', '/tmp/test-books')
os.environ.setdefault('DECLOUD_FILES_DIR', '/tmp/test-files')
os.environ.setdefault('SECRET_KEY', 'test-secret-key-for-pytest')

# Create test dirs
Path('/tmp/test-books').mkdir(exist_ok=True)
Path('/tmp/test-files').mkdir(exist_ok=True)

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
        monkeypatch.setattr(auth_module, 'DECLOUD_PIN', '')
        resp = client.post('/api/auth/login', json={'pin': ''})
        assert resp.status_code == 200
