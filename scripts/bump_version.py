#!/usr/bin/env python3
"""Bump DeCloud's version + changelog consistently across all three spots.

Usage:
    python scripts/bump_version.py <patch|minor|major> -m "one-line summary" -c "change one;change two"

Keeps in sync:
  1. routes/version.py  — VERSION + CHANGELOG[0]
  2. decloud            — VERSION="x.y.z"
Adds a changelog entry dated today. `-c` is a semicolon-separated list of
bullets; `-m` is always the first bullet.
"""
import argparse
import datetime
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = ROOT / 'routes' / 'version.py'
DECLOUD_FILE = ROOT / 'decloud'


def read_version():
    text = VERSION_FILE.read_text()
    m = re.search(r'^VERSION = "([^"]+)"', text, re.MULTILINE)
    if not m:
        sys.exit('ERROR: could not find VERSION in routes/version.py')
    return m.group(1)


def bump(current, kind):
    parts = [int(x) for x in current.split('.')]
    if len(parts) != 3:
        sys.exit(f'ERROR: unexpected version format: {current}')
    if kind == 'major':
        parts = [parts[0] + 1, 0, 0]
    elif kind == 'minor':
        parts = [parts[0], parts[1] + 1, 0]
    elif kind == 'patch':
        parts = [parts[0], parts[1], parts[2] + 1]
    else:
        sys.exit(f'ERROR: unknown bump type: {kind}')
    return '.'.join(str(p) for p in parts)


def build_entry(version, date, changes):
    bullets = '\n'.join(f'            "{c}",' for c in changes)
    return (
        f'    {{\n'
        f'        "version": "{version}",\n'
        f'        "date": "{date}",\n'
        f'        "changes": [\n'
        f'{bullets}\n'
        f'        ]\n'
        f'    }},\n'
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('bump', choices=['patch', 'minor', 'major'])
    ap.add_argument('-m', '--message', required=True, help='one-line summary (first changelog bullet)')
    ap.add_argument('-c', '--changes', default='', help='semicolon-separated additional bullets')
    args = ap.parse_args()

    changes = [args.message.strip()]
    if args.changes:
        changes += [c.strip() for c in args.changes.split(';') if c.strip()]

    current = read_version()
    new = bump(current, args.bump)
    today = datetime.date.today().isoformat()

    # 1. routes/version.py
    text = VERSION_FILE.read_text()
    text = re.sub(r'^VERSION = "[^"]+"', f'VERSION = "{new}"', text, count=1, flags=re.MULTILINE)
    entry = build_entry(new, today, changes)
    text = re.sub(r'(CHANGELOG = \[\n)', r'\1' + entry, text, count=1)
    VERSION_FILE.write_text(text)

    # 2. decloud script
    dtext = DECLOUD_FILE.read_text()
    dtext = re.sub(r'^VERSION="[^"]+"', f'VERSION="{new}"', dtext, count=1, flags=re.MULTILINE)
    DECLOUD_FILE.write_text(dtext)

    print(f'Bumped {current} -> {new} ({args.bump})')
    print(f'Changelog entry dated {today} with {len(changes)} bullet(s):')
    for c in changes:
        print(f'  - {c}')
    print('\nNow: run tests, commit, and push. CI (scripts/check_version.py) '
          'fails if the three spots disagree.')


if __name__ == '__main__':
    main()
