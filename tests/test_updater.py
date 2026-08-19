"""Self-update safety tests.

These never run a real git fetch/checkout against the actual repo —
the git helpers are patched. The live end-to-end safety test (broken
update auto-rolls-back) is run manually in a throwaway clone.
"""
import json
import time

import pytest

import routes.update as updater


@pytest.fixture(autouse=True)
def _fresh_state(tmp_path, monkeypatch):
    """Isolate the marker file and reset the latest-version cache."""
    monkeypatch.setattr(updater, 'UPDATE_META_FILE', tmp_path / '.update_meta.json')
    updater._latest_cache['ts'] = 0.0
    updater._latest_cache['data'] = None
    yield


class TestAuthRequired:
    def test_check_requires_auth(self, client):
        assert client.get('/api/system/update/check').status_code == 401

    def test_update_requires_auth(self, client):
        r = client.post('/api/system/update', json={'ref': 'v0.0.2-alpha'})
        assert r.status_code == 401

    def test_rollback_requires_auth(self, client):
        assert client.post('/api/system/update/rollback').status_code == 401


class TestCheckEndpoint:
    def test_shape_with_mock_github(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(updater, '_fetch_latest_from_github', lambda: {
            'tag': 'v9.9.9', 'name': 'v9.9.9', 'published_at': '', 'notes': '',
        })
        r = client.get('/api/system/update/check', headers=auth_headers)
        assert r.status_code == 200
        d = r.get_json()
        assert 'current_version' in d
        assert d['is_git'] is True          # tests run in the repo checkout
        assert d['latest']['tag'] == 'v9.9.9'
        assert d['update_available'] is True
        assert isinstance(d['tree_clean'], bool)
        assert 'remote' in d

    def test_up_to_date_when_versions_match(self, client, auth_headers, monkeypatch):
        from routes.version import VERSION
        monkeypatch.setattr(updater, '_fetch_latest_from_github', lambda: {
            'tag': 'v' + VERSION, 'name': '', 'published_at': '', 'notes': '',
        })
        d = client.get('/api/system/update/check', headers=auth_headers).get_json()
        assert d['update_available'] is False


class TestUpdateEndpoint:
    def test_invalid_ref_rejected_before_anything(self, client, auth_headers):
        from shared import limiter
        for bad in ('', 'v1.0.0; rm -rf /', '../../etc', 'refs/heads/main',
                    'a b', 'v' + 'x' * 70):
            r = client.post('/api/system/update', json={'ref': bad}, headers=auth_headers)
            assert r.status_code == 400, bad
            limiter.reset()  # each attempt counts toward the 3/15min limit

    def test_not_git_install_refused(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(updater, '_git_available', lambda: False)
        r = client.post('/api/system/update', json={'ref': 'v0.0.3'}, headers=auth_headers)
        assert r.status_code == 409
        assert r.get_json()['code'] == 'NOT_GIT'

    def test_dirty_tree_refused_and_nothing_fetched(self, client, auth_headers, monkeypatch):
        fetched = {'n': 0}
        monkeypatch.setattr(updater, '_git_available', lambda: True)
        monkeypatch.setattr(updater, '_tree_clean', lambda: False)
        monkeypatch.setattr(updater, '_fetch_tags',
                            lambda timeout=90: fetched.__setitem__('n', fetched['n'] + 1) or True)
        r = client.post('/api/system/update', json={'ref': 'v0.0.3'}, headers=auth_headers)
        assert r.status_code == 409
        assert r.get_json()['code'] == 'DIRTY_TREE'
        assert fetched['n'] == 0            # never even fetched

    def test_unknown_ref_refused_after_fetch(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(updater, '_git_available', lambda: True)
        monkeypatch.setattr(updater, '_tree_clean', lambda: True)
        monkeypatch.setattr(updater, '_fetch_tags', lambda timeout=90: True)
        monkeypatch.setattr(updater, '_head_sha', lambda: 'abc123')
        monkeypatch.setattr(updater, '_resolve_tag_ref', lambda ref: '')
        r = client.post('/api/system/update', json={'ref': 'v0.0.3'}, headers=auth_headers)
        assert r.status_code == 404

    def test_already_on_target_refused(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(updater, '_git_available', lambda: True)
        monkeypatch.setattr(updater, '_tree_clean', lambda: True)
        monkeypatch.setattr(updater, '_fetch_tags', lambda timeout=90: True)
        monkeypatch.setattr(updater, '_head_sha', lambda: 'abc123')
        monkeypatch.setattr(updater, '_resolve_tag_ref', lambda ref: 'abc123')
        r = client.post('/api/system/update', json={'ref': 'v0.0.3'}, headers=auth_headers)
        assert r.status_code == 409


class TestRollbackEndpoint:
    def test_no_marker_refused(self, client, auth_headers):
        r = client.post('/api/system/update/rollback', headers=auth_headers)
        assert r.status_code == 409


class TestMarkerHelpers:
    def test_roundtrip(self):
        assert updater.read_update_meta() == {}
        updater.write_update_meta({'state': 'installed', 'ts': 123})
        assert updater.read_update_meta()['state'] == 'installed'
        updater.clear_update_meta()
        assert updater.read_update_meta() == {}

    def test_corrupt_marker_reads_empty(self):
        updater.UPDATE_META_FILE.write_text('not json {')
        assert updater.read_update_meta() == {}


class TestFailedBootRollback:
    def test_no_marker_no_action(self):
        assert updater.rollback_on_failed_boot() is False

    def test_stale_marker_cleared_without_action(self):
        updater.write_update_meta({'state': 'installed', 'prev_sha': 'deadbeef',
                                   'ts': time.time() - updater.ROLLBACK_WINDOW_SECONDS - 60})
        assert updater.rollback_on_failed_boot() is False
        assert updater.read_update_meta() == {}

    def test_fresh_marker_rolls_back(self, monkeypatch):
        updater.write_update_meta({'state': 'installed', 'prev_sha': 'prevsha',
                                   'ts': time.time()})
        checkout = {'sha': None}
        monkeypatch.setattr(updater, '_head_sha', lambda: 'broken-new-sha')
        monkeypatch.setattr(updater, '_checkout',
                            lambda sha, timeout=60: checkout.__setitem__('sha', sha) or True)
        assert updater.rollback_on_failed_boot() is True
        assert checkout['sha'] == 'prevsha'
        assert updater.read_update_meta()['state'] == 'rolled_back'

    def test_prepared_state_also_rolls_back(self, monkeypatch):
        updater.write_update_meta({'state': 'prepared', 'prev_sha': 'prevsha',
                                   'ts': time.time()})
        monkeypatch.setattr(updater, '_head_sha', lambda: 'other')
        monkeypatch.setattr(updater, '_checkout', lambda sha, timeout=60: True)
        assert updater.rollback_on_failed_boot() is True


class TestVersionHelpers:
    def test_normalize(self):
        assert updater._normalize_version('v0.0.2-alpha') == '0.0.2-alpha'
        assert updater._normalize_version('0.0.2') == '0.0.2'
        assert updater._normalize_version('') == ''

    def test_ref_pattern(self):
        assert updater._REF_PATTERN.match('v0.0.2-alpha')
        assert updater._REF_PATTERN.match('0.0.3')
        assert not updater._REF_PATTERN.match('refs/heads/main')
        assert not updater._REF_PATTERN.match('v 1.0')
