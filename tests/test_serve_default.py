"""The CLI must choose private Serve and leave unrelated routes alone."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest
import sys

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="decloud is a bash script")


@pytest.fixture
def cli(tmp_path):
    shutil.copy(Path(__file__).resolve().parents[1] / 'decloud', tmp_path / 'decloud')
    bindir = tmp_path / 'bin'
    bindir.mkdir()
    state = tmp_path / 'state.json'
    state.write_text('{}')
    log = tmp_path / 'calls'
    tailscale = bindir / 'tailscale'
    tailscale.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
path = Path(os.environ['TEST_STATE'])
with open(os.environ['TEST_CALLS'], 'a') as f: f.write(' '.join(args) + '\\n')
if args == ['serve', 'status', '--json']:
    print(path.read_text())
elif args[:2] == ['funnel', '--https=443']:
    path.write_text('{}')
elif args[:3] == ['serve', '--bg', '--https=443']:
    path.write_text(json.dumps({'Web': {'host.example:443': {'Handlers': {'/': {'Proxy': args[3]}}}}}))
''')
    tailscale.chmod(0o755)
    curl = bindir / 'curl'
    curl.write_text('#!/bin/sh\nexit 0\n')
    curl.chmod(0o755)
    env = {**os.environ, 'PATH': str(bindir) + os.pathsep + os.environ['PATH'],
           'TEST_STATE': str(state), 'TEST_CALLS': str(log), 'DECLOUD_PORT': '8899'}

    def run(*args):
        return subprocess.run(['bash', str(tmp_path / 'decloud'), *args], env=env,
                              capture_output=True, text=True, timeout=15)
    return run, state, log


def config(proxy, public=False):
    return {'Web': {'host.example:443': {'Handlers': {'/': {'Proxy': proxy}}}},
            'AllowFunnel': {'host.example:443': public}}


def test_start_uses_private_serve(cli):
    run, state, log = cli
    result = run('start')
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'serve --bg --https=443 http://127.0.0.1:8899' in log.read_text()
    assert 'funnel --bg' not in log.read_text()
    assert 'private Serve active' in run('status').stdout


def test_existing_public_decloud_route_becomes_private(cli):
    run, state, log = cli
    state.write_text(json.dumps(config('http://127.0.0.1:8899', True)))
    assert run('start').returncode == 0
    assert 'funnel --https=443 off' in log.read_text()
    assert 'private Serve active' in run('status').stdout


def test_unrelated_route_is_not_overwritten(cli):
    run, state, log = cli
    original = json.dumps(config('http://127.0.0.1:7777'))
    state.write_text(original)
    assert run('start').returncode != 0
    assert state.read_text() == original
    assert 'serve --bg' not in log.read_text()
