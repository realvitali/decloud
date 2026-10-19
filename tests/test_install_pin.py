"""N2: every install ends up with a passcode, and Funnel needs one.

These run the real snippets out of install.sh / setup.ps1 / decloud in a
temp dir (bash on Linux/macOS, PowerShell where available), so a broken
pattern like setup.ps1's old `-replace '^DECLOUD_PIN=.*$'` is caught.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = (ROOT / '.env.example').read_text(encoding='utf-8')
PIN_LINE = re.compile(r'^DECLOUD_PIN=(\d{8})$', re.MULTILINE)

needs_bash = pytest.mark.skipif(
    sys.platform == 'win32' or not shutil.which('bash'),
    reason='POSIX bash snippet')


def _script_block(path, start_marker, end_line):
    """Lines from the one containing start_marker through end_line."""
    lines = (ROOT / path).read_text(encoding='utf-8').splitlines()
    start = next(i for i, l in enumerate(lines) if start_marker in l)
    end = next(i for i in range(start, len(lines)) if lines[i] == end_line)
    return '\n'.join(lines[start:end + 1])


def _env_without_pin():
    env = dict(os.environ)
    env.pop('DECLOUD_PIN', None)
    return env


# ─── install.sh ──────────────────────────────────────────────────

def _run_install_pin_block(tmp_path):
    block = _script_block('install.sh', '# Generate a passcode whenever .env has none', 'fi')
    script = f'set -e\nPYBIN={sys.executable!r}\nOS_TYPE={"macos" if sys.platform == "darwin" else "linux"}\n{block}\n'
    subprocess.run(['bash', '-c', script], cwd=tmp_path, check=True,
                   env=_env_without_pin(), capture_output=True, timeout=60)
    return (tmp_path / '.env').read_text(encoding='utf-8')


@needs_bash
class TestInstallShPin:
    def test_hand_copied_template_gets_pin(self, tmp_path):
        # The audit's case: user copied .env.example -> .env by hand
        (tmp_path / '.env').write_text(TEMPLATE, encoding='utf-8')
        out = _run_install_pin_block(tmp_path)
        assert len(PIN_LINE.findall(out)) == 1

    def test_empty_pin_line_is_filled(self, tmp_path):
        (tmp_path / '.env').write_text('SECRET_KEY=x\nDECLOUD_PIN=\nDECLOUD_PORT=8899\n')
        out = _run_install_pin_block(tmp_path)
        assert len(PIN_LINE.findall(out)) == 1
        assert 'DECLOUD_PORT=8899' in out

    def test_no_trailing_newline_does_not_glue_onto_comment(self, tmp_path):
        (tmp_path / '.env').write_text('# last line is a comment')
        out = _run_install_pin_block(tmp_path)
        assert len(PIN_LINE.findall(out)) == 1

    def test_existing_pin_is_kept(self, tmp_path):
        (tmp_path / '.env').write_text('DECLOUD_PIN=my-own-passphrase\n')
        out = _run_install_pin_block(tmp_path)
        assert out == 'DECLOUD_PIN=my-own-passphrase\n'

    def test_idempotent(self, tmp_path):
        (tmp_path / '.env').write_text(TEMPLATE, encoding='utf-8')
        first = _run_install_pin_block(tmp_path)
        second = _run_install_pin_block(tmp_path)
        assert first == second


# ─── decloud: refuse Funnel without a PIN ────────────────────────

def _has_pin(tmp_path, env_pin=None):
    func = re.search(r'^has_pin\(\) \{.*?^\}', (ROOT / 'decloud').read_text(encoding='utf-8'),
                     re.MULTILINE | re.DOTALL).group(0)
    env = _env_without_pin()
    if env_pin is not None:
        env['DECLOUD_PIN'] = env_pin
    r = subprocess.run(['bash', '-c', f'{func}\nAPP_DIR={str(tmp_path)!r}\nhas_pin'],
                       env=env, capture_output=True, timeout=30)
    return r.returncode == 0


@needs_bash
class TestDecloudHasPin:
    def test_no_env_file(self, tmp_path):
        assert _has_pin(tmp_path) is False

    @pytest.mark.parametrize('content', [
        TEMPLATE, 'DECLOUD_PIN=\n', 'DECLOUD_PIN=""\n', "DECLOUD_PIN=''\n",
        'DECLOUD_PIN=12345678\nDECLOUD_PIN=\n',   # last-wins, like the loader
    ])
    def test_no_pin(self, tmp_path, content):
        (tmp_path / '.env').write_text(content)
        assert _has_pin(tmp_path) is False

    @pytest.mark.parametrize('content', ['DECLOUD_PIN=12345678\n', 'DECLOUD_PIN="a b c d"\n'])
    def test_pin(self, tmp_path, content):
        (tmp_path / '.env').write_text(content)
        assert _has_pin(tmp_path) is True

    def test_env_var_wins_over_env_file(self, tmp_path):
        (tmp_path / '.env').write_text('DECLOUD_PIN=12345678\n')
        assert _has_pin(tmp_path, env_pin='') is False
        (tmp_path / '.env').write_text('')
        assert _has_pin(tmp_path, env_pin='87654321') is True

    def test_start_tunnel_checks_pin_before_funnel(self):
        text = (ROOT / 'decloud').read_text(encoding='utf-8')
        body = re.search(r'^start_tunnel\(\) \{.*?^\}', text, re.MULTILINE | re.DOTALL).group(0)
        assert body.index('has_pin') < body.index('tailscale funnel --bg')


# ─── setup.ps1 ───────────────────────────────────────────────────

def _powershell():
    return shutil.which('pwsh') or shutil.which('powershell')


def test_setup_ps1_broken_replace_is_gone():
    text = (ROOT / 'setup.ps1').read_text(encoding='utf-8')
    assert "-replace '^DECLOUD_PIN=" not in text


@pytest.mark.skipif(not _powershell(), reason='PowerShell not installed')
class TestSetupPs1Pin:
    def _run(self, tmp_path):
        block = _script_block('setup.ps1', '# Generate a passcode whenever .env has none', '}')
        script = tmp_path / 'pin.ps1'
        script.write_text(
            "$ErrorActionPreference = 'Stop'\n"
            f"$VenvPython = '{sys.executable}'\n"
            f"Set-Location -LiteralPath '{tmp_path}'\n" + block + '\n', encoding='utf-8-sig')
        subprocess.run([_powershell(), '-NoProfile', '-NonInteractive',
                        '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                       check=True, capture_output=True, timeout=120)
        return (tmp_path / '.env').read_text(encoding='utf-8', errors='replace').replace('\r\n', '\n')

    def test_template_gets_pin(self, tmp_path):
        (tmp_path / '.env').write_text(TEMPLATE, encoding='utf-8')
        out = self._run(tmp_path)
        assert len(PIN_LINE.findall(out)) == 1

    def test_existing_pin_is_kept(self, tmp_path):
        (tmp_path / '.env').write_text('DECLOUD_PIN=my-own-passphrase\n')
        out = self._run(tmp_path)
        assert PIN_LINE.findall(out) == []
        assert 'DECLOUD_PIN=my-own-passphrase' in out

    def test_idempotent(self, tmp_path):
        (tmp_path / '.env').write_text(TEMPLATE, encoding='utf-8')
        assert self._run(tmp_path) == self._run(tmp_path)
