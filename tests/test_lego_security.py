"""File-browser security tests: traversal, symlink escapes, shred guards."""
import os
import pathlib

import pytest


def _mk(path: pathlib.Path):
    path.mkdir(parents=True, exist_ok=True)


@pytest.fixture
def populated(files_dir):
    _mk(files_dir / 'sub')
    _mk(files_dir / 'sub' / 'deeper')
    (files_dir / 'note.txt').write_text('hello')
    (files_dir / 'sub' / 'photo.jpg').write_bytes(b'\xff\xd8\xff\xe0fakejpeg')
    return files_dir


class TestTraversal:
    @pytest.mark.parametrize('path', [
        '../',
        '..',
        '../..',
        '%2e%2e/',
        '....//',
        'sub/../../etc',
        'sub/..%2f..%2fetc',
        '/etc',
    ])
    def test_browse_traversal_stays_inside(self, client, auth_headers, path):
        r = client.get('/api/lego/browse', query_string={'path': path}, headers=auth_headers)
        assert r.status_code in (200, 403, 404)
        if r.status_code == 200:
            # Whatever was returned must resolve inside the files root
            for item in r.get_json().get('items', []):
                assert not str(item.get('path', '')).startswith('/etc')
                assert '..' not in str(item.get('path', ''))

    @pytest.mark.parametrize('path', ['../note.txt', '/etc/passwd', 'sub/../../etc/passwd'])
    def test_download_traversal_rejected(self, client, auth_headers, populated, path):
        r = client.get('/api/lego/download', query_string={'path': path}, headers=auth_headers)
        assert r.status_code in (400, 403, 404)

    @pytest.mark.parametrize('path', ['../note.txt', '/etc/passwd'])
    def test_shred_traversal_rejected(self, client, auth_headers, populated, path):
        r = client.post('/api/lego/shred', json={'path': path}, headers=auth_headers)
        assert r.status_code in (400, 403, 404)

    @pytest.mark.parametrize('path', ['../note.txt', '/etc/passwd'])
    def test_trash_and_poof_traversal_rejected(self, client, auth_headers, populated, path):
        for endpoint in ('/api/lego/trash', '/api/lego/poof'):
            r = client.post(endpoint, json={'path': path}, headers=auth_headers)
            assert r.status_code in (400, 403, 404), endpoint


class TestSymlinkEscape:
    def test_shred_refuses_symlink(self, client, auth_headers, populated):
        if os.name == 'nt':
            pytest.skip('symlinks need privileges on Windows')
        outside = populated.parent / 'outside-secret.txt'
        outside.write_text('do not destroy')
        link = populated / 'link-to-outside.txt'
        link.symlink_to(outside)
        try:
            r = client.post('/api/lego/shred', json={'path': 'link-to-outside.txt'}, headers=auth_headers)
            assert r.status_code in (400, 403), r.get_json()
            assert outside.exists(), 'shred followed a symlink!'
        finally:
            link.unlink(missing_ok=True)

    def test_trash_and_poof_refuse_symlink(self, client, auth_headers, populated):
        if os.name == 'nt':
            pytest.skip('symlinks need privileges on Windows')
        outside = populated.parent / 'outside-secret2.txt'
        outside.write_text('do not destroy')
        link = populated / 'link2.txt'
        link.symlink_to(outside)
        try:
            for endpoint in ('/api/lego/trash', '/api/lego/poof'):
                r = client.post(endpoint, json={'path': 'link2.txt'}, headers=auth_headers)
                assert r.status_code in (400, 403), endpoint
            assert outside.exists()
        finally:
            link.unlink(missing_ok=True)


class TestAuthRequired:
    def test_all_destructive_endpoints_require_auth(self, client, populated):
        for method, url, body in [
            ('post', '/api/lego/trash', {'path': 'note.txt'}),
            ('post', '/api/lego/poof', {'path': 'note.txt'}),
            ('post', '/api/lego/shred', {'path': 'note.txt'}),
            ('post', '/api/lego/mark_done', {'path': 'sub'}),
            ('get', '/api/lego/browse', None),
            ('get', '/api/lego/download?path=note.txt', None),
        ]:
            r = getattr(client, method)(url, json=body) if body is not None else client.get(url)
            assert r.status_code == 401, f'{method} {url}'
