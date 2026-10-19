"""N3: releases (what every install's updater pulls) only after CI passes,
and the release job's third-party actions are pinned by commit SHA.

Text checks only — no YAML dependency in the test suite.
"""
import re
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / '.github' / 'workflows'
RELEASE = (WORKFLOWS / 'release.yml').read_text(encoding='utf-8')
CI = (WORKFLOWS / 'ci.yml').read_text(encoding='utf-8')


def _trigger_block(text):
    return re.search(r'^on:\n(.*?)^\S', text, re.MULTILINE | re.DOTALL).group(1)


def test_release_is_not_triggered_by_push():
    assert not re.search(r'^\s+push:', _trigger_block(RELEASE), re.MULTILINE)


def test_release_runs_after_ci_workflow():
    trigger = _trigger_block(RELEASE)
    assert 'workflow_run:' in trigger
    ci_name = re.search(r'^name:\s*(.+)$', CI, re.MULTILINE).group(1).strip()
    assert re.search(rf'workflows:\s*\[\s*{re.escape(ci_name)}\s*\]', trigger)


def test_release_job_requires_ci_success_on_main_push():
    assert "github.event.workflow_run.conclusion == 'success'" in RELEASE
    assert "github.event.workflow_run.event == 'push'" in RELEASE
    assert "github.event.workflow_run.head_branch == 'main'" in RELEASE


def test_release_checks_out_the_tested_commit():
    assert 'ref: ${{ github.event.workflow_run.head_sha }}' in RELEASE


def test_release_actions_pinned_by_sha():
    uses = re.findall(r'^\s*-?\s*uses:\s*(\S+)', RELEASE, re.MULTILINE)
    assert uses, 'no actions found'
    for ref in uses:
        assert re.fullmatch(r'[\w.-]+/[\w.-]+@[0-9a-f]{40}', ref), f'not SHA-pinned: {ref}'
    assert any(u.startswith('softprops/action-gh-release@') for u in uses)
