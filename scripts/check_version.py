#!/usr/bin/env python3
"""Verify DeCloud's version is consistent across the three places it lives.

Exit non-zero (fail CI) if:
  - routes/version.py VERSION != CHANGELOG[0]["version"]
  - CHANGELOG[0] is missing a date or changes list
  - decloud VERSION != routes/version.py VERSION
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def fail(msg):
    print(f'ERROR: {msg}', file=sys.stderr)
    return False


def main():
    version_file = ROOT / 'routes' / 'version.py'
    decloud_file = ROOT / 'decloud'
    ok = True

    vtext = version_file.read_text()
    m = re.search(r'^VERSION = "([^"]+)"', vtext, re.MULTILINE)
    if not m:
        sys.exit('ERROR: VERSION not found in routes/version.py')
    version = m.group(1)

    # CHANGELOG[0] must be a dict with a matching version + date + changes.
    head = vtext.split('CHANGELOG = [', 1)[1] if 'CHANGELOG = [' in vtext else ''
    if not head:
        ok = fail('CHANGELOG not found in routes/version.py')

    if ok:
        first_entry = head.split('},', 1)[0]
        entry_version = re.search(r'"version":\s*"([^"]+)"', first_entry)
        entry_date = re.search(r'"date":\s*"([^"]+)"', first_entry)
        entry_changes = re.search(r'"changes":\s*\[', first_entry)
        if not entry_version or entry_version.group(1) != version:
            ok = fail(f'CHANGELOG[0].version ({entry_version.group(1) if entry_version else "?"}) '
                      f'does not match VERSION ({version})')
        if not entry_date:
            ok = fail('CHANGELOG[0] is missing a "date"')
        if not entry_changes:
            ok = fail('CHANGELOG[0] is missing a "changes" list')

    dtext = decloud_file.read_text()
    dm = re.search(r'^VERSION="([^"]+)"', dtext, re.MULTILINE)
    if not dm:
        ok = fail('VERSION not found in decloud script')
    elif dm.group(1) != version:
        ok = fail(f'decloud VERSION ({dm.group(1)}) does not match routes/version.py ({version})')

    if not ok:
        sys.exit(1)
    print(f'OK: version {version} is consistent across all spots.')


if __name__ == '__main__':
    main()
