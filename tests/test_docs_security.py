"""N4/N16: docs must not tell owners to share the passcode, and must say
plainly that it unlocks a shell."""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DOCS = ['README.md', 'docs/PERMANENT_TUNNEL.md']


@pytest.mark.parametrize('name', DOCS)
def test_no_passcode_sharing_guidance(name):
    text = (ROOT / name).read_text(encoding='utf-8')
    assert not re.search(r'sharing with friends', text, re.IGNORECASE)
    assert not re.search(r'friends don.t need tailscale', text, re.IGNORECASE)
    assert not re.search(r'send them.{0,200}passcode', text, re.IGNORECASE | re.DOTALL)


@pytest.mark.parametrize('name', DOCS)
def test_passcode_is_described_as_a_shell(name):
    text = (ROOT / name).read_text(encoding='utf-8')
    assert 'unlocks a shell' in text
    assert re.search(r"don.t share", text, re.IGNORECASE)
