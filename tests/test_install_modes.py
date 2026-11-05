"""Host and node installer entry points must be explicit and non-destructive."""
from pathlib import Path
import subprocess
import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="install.sh is a bash script")


INSTALLER = Path(__file__).resolve().parents[1] / 'install.sh'


def run_installer(*args):
    return subprocess.run(['bash', str(INSTALLER), *args], stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=5)


def test_help_describes_host_and_node():
    result = run_installer('--help')
    assert result.returncode == 0
    assert '--host' in result.stdout and '--node' in result.stdout


@pytest.mark.skipif(sys.platform != "linux", reason="node mode stops earlier off Linux")
def test_node_requires_interactive_pairing():
    result = run_installer('--node')
    assert result.returncode != 0
    assert 'interactive terminal' in result.stderr


def test_invalid_install_mode_fails_before_installing():
    assert run_installer('--not-a-mode').returncode == 2
    assert run_installer('--host', '--node').returncode == 2
