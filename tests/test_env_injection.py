"""N6: values written to .env must not smuggle in extra lines.

An embedded newline in e.g. a library path or API key used to append
`DECLOUD_COMFY_CMD=...` to .env, which /api/comfy/start then executes.
"""
import os

import pytest

import shared

INJECTIONS = [
    'x\nDECLOUD_COMFY_CMD=touch /tmp/pwned',
    'x\r\nDECLOUD_COMFY_CMD=touch /tmp/pwned',
    'x\rDECLOUD_COMFY_CMD=touch /tmp/pwned',
    'x DECLOUD_COMFY_CMD=touch /tmp/pwned',   # str.splitlines() breaks here too
    'x\x85DECLOUD_COMFY_CMD=touch /tmp/pwned',
    'trailing-newline\n',
]

ORIGINAL = 'SECRET_KEY=keep-me\nDECLOUD_TEST_KEY=old\n'


@pytest.fixture
def env_dir(tmp_path, monkeypatch):
    """Point .env writes at a temp dir so the real .env is never touched."""
    monkeypatch.setattr(shared, 'BASE_DIR', tmp_path)
    (tmp_path / '.env').write_text(ORIGINAL)
    monkeypatch.setenv('DECLOUD_TEST_KEY', 'old')
    return tmp_path


class TestSetEnvValue:
    @pytest.mark.parametrize('value', INJECTIONS)
    def test_line_breaks_rejected(self, env_dir, value):
        assert shared.set_env_value('DECLOUD_TEST_KEY', value) is False
        assert (env_dir / '.env').read_text() == ORIGINAL
        assert os.environ['DECLOUD_TEST_KEY'] == 'old'

    def test_normal_value_written(self, env_dir):
        assert shared.set_env_value('DECLOUD_TEST_KEY', 'new value') is True
        text = (env_dir / '.env').read_text()
        assert 'DECLOUD_TEST_KEY=new value' in text
        assert 'SECRET_KEY=keep-me' in text
        assert 'DECLOUD_TEST_KEY=old' not in text


class TestUpdateEnvFile:
    @pytest.mark.parametrize('value', INJECTIONS)
    def test_line_breaks_rejected(self, env_dir, value):
        from routes.settings import _update_env_file
        assert _update_env_file({'books': '/ok/books', 'music': value}) is False
        assert (env_dir / '.env').read_text() == ORIGINAL

    def test_normal_paths_written(self, env_dir):
        from routes.settings import _update_env_file
        assert _update_env_file({'books': '/ok/books'}) is True
        assert 'DECLOUD_BOOKS_DIR=/ok/books' in (env_dir / '.env').read_text()


class TestRoutesRefuseInjection:
    def test_settings_paths(self, client, auth_headers, env_dir, monkeypatch):
        monkeypatch.setenv('DECLOUD_MUSIC_DIR', os.environ.get('DECLOUD_MUSIC_DIR', ''))
        r = client.post('/api/settings/paths', headers=auth_headers,
                        json={'music': '/tmp/m\nDECLOUD_COMFY_CMD=touch /tmp/pwned'})
        assert r.status_code >= 400
        assert 'DECLOUD_COMFY_CMD' not in (env_dir / '.env').read_text()

    def test_change_pin(self, client, auth_headers, env_dir):
        import routes.auth as auth_module
        before = shared.DECLOUD_PIN
        r = client.post('/api/auth/pin', headers=auth_headers, json={
            'current_pin': before,
            'new_pin': 'abcdefgh\nDECLOUD_COMFY_CMD=touch /tmp/pwned',
        })
        assert r.status_code >= 400
        assert shared.DECLOUD_PIN == before
        assert auth_module.DECLOUD_PIN == before
        assert 'DECLOUD_COMFY_CMD' not in (env_dir / '.env').read_text()
