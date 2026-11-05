"""File-browser security tests: traversal, symlink escapes, shred guards."""
import os
import pathlib

import sys

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

    @pytest.mark.parametrize('path', ['../note.txt', '/etc/passwd', 'sub/../../note.txt', '', 'sub/\0x'])
    def test_write_actions_reject_escapes(self, client, auth_headers, populated, path, tmp_path, monkeypatch):
        monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path / 'xdg'))
        for url, body in (('/api/files/rename', {'path': path, 'name': 'x'}), ('/api/files/delete', {'paths': [path]})):
            r = client.post(url, json=body, headers=auth_headers)
            assert r.status_code in (400, 403, 404), (url, path)
        assert (populated / 'note.txt').exists()


class TestFileActions:
    @pytest.fixture(autouse=True)
    def trash(self, tmp_path, monkeypatch):
        monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path / 'xdg'))
        return tmp_path / 'xdg' / 'Trash'

    def test_names_cannot_carry_paths_or_hide(self, client, auth_headers, populated):
        for bad in ('../x', 'a/b', '.ssh', '', ' x', 'a\x00b', 'a\nb'):
            assert client.post('/api/files/mkdir', json={'path': '', 'name': bad}, headers=auth_headers).status_code == 400, bad
            assert client.post('/api/files/rename', json={'path': 'note.txt', 'name': bad}, headers=auth_headers).status_code == 400, bad
        assert (populated / 'note.txt').exists()

    def test_mkdir_rename_delete_roundtrip(self, client, auth_headers, populated, trash):
        assert client.post('/api/files/mkdir', json={'path': 'sub', 'name': 'New'}, headers=auth_headers).status_code == 200
        assert client.post('/api/files/mkdir', json={'path': 'sub', 'name': 'New'}, headers=auth_headers).status_code == 409
        assert client.post('/api/files/rename', json={'path': 'note.txt', 'name': 'renamed.txt'}, headers=auth_headers).status_code == 200
        assert (populated / 'renamed.txt').read_text() == 'hello'
        r = client.post('/api/files/delete', json={'paths': ['renamed.txt', 'sub/New']}, headers=auth_headers)
        if sys.platform == 'win32':          # no trash to move to: the app asks before deleting for good
            assert r.status_code == 409 and r.get_json()['code'] == 'NO_TRASH'
            return
        assert r.status_code == 200 and r.get_json()['deleted'] == 2
        assert not (populated / 'renamed.txt').exists()
        if sys.platform == 'linux':          # freedesktop trash, restorable from the desktop
            assert (trash / 'files' / 'renamed.txt').exists() and (trash / 'info' / 'renamed.txt.trashinfo').exists()

    def test_upload_never_overwrites(self, client, auth_headers, populated):
        import io
        r = client.post('/api/files/upload', headers=auth_headers, content_type='multipart/form-data',
                        data={'path': '', 'files': (io.BytesIO(b'new'), 'note.txt')})
        assert r.status_code == 200 and r.get_json()['saved'] == ['note (2).txt']
        assert (populated / 'note.txt').read_text() == 'hello'
        r = client.post('/api/files/upload', headers=auth_headers, content_type='multipart/form-data',
                        data={'path': '', 'files': (io.BytesIO(b'x'), '.bashrc')})
        assert r.status_code == 400 and not (populated / '.bashrc').exists()

    def test_removed_odd_features_are_gone(self, client, auth_headers, populated):
        for url in ('/api/lego/trash', '/api/lego/poof', '/api/lego/shred'):
            assert client.post(url, json={'path': 'note.txt'}, headers=auth_headers).status_code in (404, 405)
        assert client.get('/api/lego/random_image', headers=auth_headers).status_code == 404


class TestSymlinkEscape:
    def test_delete_moves_the_link_not_its_target(self, client, auth_headers, populated, tmp_path, monkeypatch):
        if os.name == 'nt':
            pytest.skip('symlinks need privileges on Windows')
        monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path / 'xdg'))
        outside = populated.parent / 'outside-secret.txt'
        outside.write_text('do not destroy')
        (populated / 'link.txt').symlink_to(outside)
        r = client.post('/api/files/delete', json={'paths': ['link.txt']}, headers=auth_headers)
        assert r.status_code == 200 and outside.read_text() == 'do not destroy'

    def test_cannot_act_inside_a_symlinked_folder_outside_files(self, client, auth_headers, populated):
        if os.name == 'nt':
            pytest.skip('symlinks need privileges on Windows')
        outdir = populated.parent / 'outside-dir'
        outdir.mkdir(exist_ok=True)
        (outdir / 'precious.txt').write_text('keep')
        (populated / 'portal').symlink_to(outdir)
        r = client.post('/api/files/delete', json={'paths': ['portal/precious.txt']}, headers=auth_headers)
        assert r.status_code in (400, 403, 404) and (outdir / 'precious.txt').exists()


class TestAuthRequired:
    def test_all_destructive_endpoints_require_auth(self, client, populated):
        for method, url, body in [
            ('post', '/api/files/delete', {'paths': ['note.txt']}),
            ('post', '/api/files/rename', {'path': 'note.txt', 'name': 'x'}),
            ('post', '/api/files/mkdir', {'path': '', 'name': 'x'}),
            ('post', '/api/files/upload', {}),
            ('get', '/api/lego/browse', None),
            ('get', '/api/lego/download?path=note.txt', None),
        ]:
            r = getattr(client, method)(url, json=body) if body is not None else client.get(url)
            assert r.status_code == 401, f'{method} {url}'
