"""A private vulnerability-reporting channel must exist (promo blocker 6)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_security_md_has_private_channel():
    text = (ROOT / 'SECURITY.md').read_text(encoding='utf-8')
    assert '/security/advisories/new' in text
    assert 'do not open a public' in text.lower()


def test_readme_points_to_security_md():
    assert '(SECURITY.md)' in (ROOT / 'README.md').read_text(encoding='utf-8')
