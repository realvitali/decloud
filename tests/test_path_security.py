"""Path-traversal regression tests: music streaming + safe_join_browse."""
import pathlib

import pytest


class TestSafeJoinBrowse:
    def test_prefix_collision_is_clamped(self, tmp_path):
        """A sibling dir sharing a name prefix must NOT pass containment
        (regression: /home/dallas vs /home/dallas2)."""
        import shared

        base = tmp_path / 'dallas'
        base.mkdir()
        sibling = tmp_path / 'dallas2'
        sibling.mkdir()
        (sibling / 'secret.txt').write_text('secret')

        # Bypass the FILES_DIR global by calling with an explicit base.
        result = shared.safe_join_browse(base, '..', 'dallas2', 'secret.txt')
        assert result == base.resolve(), 'escaped via prefix collision!'

    def test_plain_join_stays_inside(self, tmp_path):
        import shared

        base = tmp_path / 'root'
        base.mkdir()
        (base / 'sub').mkdir()
        result = shared.safe_join_browse(base, 'sub')
        assert result == (base / 'sub').resolve()


class TestMusicTraversal:
    def test_stream_traversal_rejected(self, client, auth_headers):
        r = client.get('/api/music/stream/../../.env', headers=auth_headers)
        assert r.status_code in (400, 403, 404)

    def test_artwork_traversal_rejected(self, client, auth_headers):
        r = client.get('/api/music/artwork/../../.env', headers=auth_headers)
        assert r.status_code in (400, 403, 404)
