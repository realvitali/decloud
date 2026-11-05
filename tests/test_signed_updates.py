"""Signed updates: only releases signed with a pinned key reach DeCloud or its devices."""
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

import lab_report
import routes.lab as lab
import routes.update as upd

pytestmark = pytest.mark.skipif(not shutil.which('ssh-keygen'), reason='needs ssh-keygen')


@pytest.fixture
def key(tmp_path):
    k = tmp_path / 'release'
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'decloud-release', '-f', str(k)], check=True)
    pub = (tmp_path / 'release.pub').read_text().split()
    signers = f'decloud-release namespaces="{lab_report.SIG_NAMESPACE}" {pub[0]} {pub[1]}\n'

    def sign(body, ns=lab_report.SIG_NAMESPACE):
        f = tmp_path / 'm.json'
        f.write_bytes(body)
        Path(str(f) + '.sig').unlink(missing_ok=True)
        subprocess.run(['ssh-keygen', '-q', '-Y', 'sign', '-f', str(k), '-n', ns, str(f)], check=True, capture_output=True)
        return Path(str(f) + '.sig').read_bytes()
    return signers, sign


def record(agent, version='v9.9.9', agent_version=99, commit='a' * 40):
    return json.dumps({'version': version, 'commit': commit, 'agent_sha256': hashlib.sha256(agent).hexdigest(),
                       'agent_version': agent_version}, sort_keys=True).encode()


def test_only_the_pinned_key_and_namespace_verify(key, tmp_path):
    signers, sign = key
    body = record(b'agent')
    assert lab_report.verify_release(body, sign(body), signers)['version'] == 'v9.9.9'
    with pytest.raises(ValueError):
        lab_report.verify_release(body.replace(b'v9.9.9', b'v9.9.8'), sign(body), signers)    # edited after signing
    with pytest.raises(ValueError):
        lab_report.verify_release(body, sign(body, ns='something-else'), signers)               # signature meant for other use
    other = tmp_path / 'other'
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(other)], check=True)
    pub = (tmp_path / 'other.pub').read_text().split()
    with pytest.raises(ValueError):
        lab_report.verify_release(body, sign(body), f'decloud-release {pub[0]} {pub[1]}\n')   # not our key
    with pytest.raises(ValueError):
        lab_report.verify_release(body, sign(body), '')                                       # signing not set up: refuse


@pytest.fixture
def agent_dir(tmp_path, monkeypatch):
    here = tmp_path / 'decloud-agent.py'
    shutil.copy(lab_report.__file__, here)
    state = lab_report.State(tmp_path / 'state')
    state.set_auto_update(True)
    newer = re.sub(rb'^AGENT_VERSION = \d+', b'AGENT_VERSION = 99', here.read_bytes(), count=1, flags=re.M)
    return here, state, newer


def test_agent_installs_a_signed_update_and_keeps_the_old_copy(key, agent_dir, monkeypatch):
    signers, sign = key
    here, state, newer = agent_dir
    monkeypatch.setattr(lab_report, 'RELEASE_SIGNERS', signers)
    body = record(newer)
    restarted = []
    msg = lab_report.apply_update(state, newer, body, sign(body), here=here, restart=lambda: restarted.append(1))
    assert 'version 99' in msg and restarted
    assert here.read_bytes() == newer and Path(str(here) + '.prev').exists()
    assert json.loads((state.dir / 'update.json').read_text())['boots'] == 0


def test_agent_refuses_anything_off(key, agent_dir, monkeypatch):
    signers, sign = key
    here, state, newer = agent_dir
    monkeypatch.setattr(lab_report, 'RELEASE_SIGNERS', signers)
    before = here.read_bytes()
    body = record(newer)
    noop = lambda: None
    with pytest.raises(ValueError, match='does not match'):
        lab_report.apply_update(state, newer + b'\n# extra', body, sign(body), here=here, restart=noop)
    old = record(newer, agent_version=lab_report.AGENT_VERSION)
    with pytest.raises(ValueError, match='up to date'):
        lab_report.apply_update(state, newer, old, sign(old), here=here, restart=noop)
    broken = b'raise SystemExit(3)\n'
    bad = record(broken)
    with pytest.raises(ValueError, match='self-test'):
        lab_report.apply_update(state, broken, bad, sign(bad), here=here, restart=noop)
    state.set_auto_update(False)
    with pytest.raises(ValueError, match='turned off'):
        lab_report.apply_update(state, newer, body, sign(body), here=here, restart=noop)
    assert here.read_bytes() == before


def test_boot_guard_restores_the_previous_version(agent_dir, monkeypatch):
    here, state, _ = agent_dir
    Path(str(here) + '.prev').write_bytes(b'# old agent\n')
    (state.dir / 'update.json').write_text(json.dumps({'boots': 3}))
    ran = []
    monkeypatch.setattr(lab_report.os, 'execv', lambda *a: ran.append(a))
    lab_report.boot_guard(state, [], here=here)
    assert here.read_bytes() == b'# old agent\n' and ran and not (state.dir / 'update.json').exists()


def test_updater_only_offers_and_installs_signed_releases(monkeypatch):
    monkeypatch.setattr(upd, 'signing_enabled', lambda: True)
    monkeypatch.setattr(upd, '_fetch_latest_from_github', lambda: {'tag': 'v99.0.0'})
    monkeypatch.setattr(upd, '_latest_cache', {'ts': 0.0, 'data': None})
    monkeypatch.setattr(upd, 'verified_release', lambda tag: {'ok': False, 'error': 'this release is not signed'})
    assert upd.check_status()['update_available'] is False

    for name, val in (('_git_available', True), ('_tree_clean', True), ('_head_sha', 'b' * 40), ('_fetch_tags', True),
                      ('_resolve_tag_ref', 'c' * 40), ('_on_main', True)):
        monkeypatch.setattr(upd, name, lambda *a, v=val: v)
    monkeypatch.setattr(upd, 'read_update_meta', lambda: {})
    code, body = upd.perform_update('v99.0.0')
    assert code == 409 and body['code'] == 'UNSIGNED'
    monkeypatch.setattr(upd, 'verified_release', lambda tag: {'ok': True, 'manifest': {'commit': 'd' * 40}})
    code, body = upd.perform_update('v99.0.0')                 # signed, but for a different commit
    assert code == 409 and body['code'] == 'UNSIGNED'


def test_without_a_key_nothing_is_pushed_or_accepted(monkeypatch, agent_dir):
    # audit 2026-11-04: an unsigned update from the hub = code execution for anyone with the token
    monkeypatch.setattr(upd, 'signing_enabled', lambda: False)
    payload, why = lab.agent_release()
    assert payload is None and 'signed' in why
    here, state, newer = agent_dir
    monkeypatch.setattr(lab_report, 'RELEASE_SIGNERS', '')
    body = json.dumps({'agent_version': 99, 'agent_sha256': hashlib.sha256(newer).hexdigest()}).encode()
    before = here.read_bytes()
    with pytest.raises(ValueError, match='not set up'):
        lab_report.apply_update(state, newer, body, b'', here=here, restart=lambda: None)
    assert here.read_bytes() == before

    monkeypatch.setattr(upd, 'signing_enabled', lambda: True)   # key pinned on the hub, release unsigned: nothing to push
    monkeypatch.setattr(upd, 'verified_release', lambda tag: {'ok': False, 'error': 'not signed'})
    status, msg = lab.push_update({'id': 'd1', 'url': 'https://127.0.0.1:1', 'token': 't', 'fp': 'f'})
    assert status == 409 and 'no signed release' in msg


def test_a_pinned_key_rejects_an_unsigned_hub_record(key, agent_dir, monkeypatch):
    signers, _ = key
    here, state, newer = agent_dir
    monkeypatch.setattr(lab_report, 'RELEASE_SIGNERS', signers)
    body = json.dumps({'agent_version': 99, 'agent_sha256': hashlib.sha256(newer).hexdigest()}).encode()
    with pytest.raises(ValueError):
        lab_report.apply_update(state, newer, body, b'', here=here, restart=lambda: None)
