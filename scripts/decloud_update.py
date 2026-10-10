#!/usr/bin/env python3
"""DeCloud update CLI — the terminal twin of the in-app updater.

Both paths call the SAME functions in routes/update.py, so behavior and
safety guarantees (verify, test-boot, auto-rollback) are identical.

Usage:
  decloud update check       show current vs latest
  decloud update             update to the latest release (asks nothing extra)
  decloud update v0.0.7      update to a specific tag
  decloud update rollback    go back to the version before the last update
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import routes.update as upd  # noqa: E402


def _print_status(d):
    print(f"Current version : {d['current_version']}")
    if not d['is_git']:
        print("Updates        : unavailable — this install is not a git checkout.")
        print("                 (reinstall via `git clone` to enable one-click updates)")
        return
    latest = d['latest'] or {}
    if latest.get('tag'):
        print(f"Latest version  : {latest['tag']}")
        if d['update_available']:
            print("Status          : update available")
            notes = (latest.get('notes') or '').strip()
            if notes:
                print()
                print(notes)
        else:
            print("Status          : up to date")
    else:
        print("Status          : no release information found on the remote")
    if not d['tree_clean']:
        print()
        print("WARNING: local files are modified — updates are paused to")
        print("         protect your changes (run `git status` to review).")
    if d['can_rollback']:
        print()
        print("A previous version is recorded — `decloud update rollback` reverts.")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else 'check'

    if cmd in ('check', 'status'):
        _print_status(upd.check_status())
        return

    if cmd in ('rollback', 'revert'):
        code, payload = upd.perform_rollback()
        if code == 200:
            print("Rolled back — the app will restart in a moment.")
            return
        print("ERROR:", payload.get('error', 'rollback failed'))
        sys.exit(1)

    # Everything else is treated as an update: `update`, or a bare tag name.
    ref = None
    if cmd == 'update' and len(args) > 1:
        ref = args[1]
    elif cmd != 'update':
        ref = cmd

    if not ref:
        d = upd.check_status()
        latest = d['latest'] or {}
        ref = latest.get('tag')
        if not d['update_available'] or not ref:
            print("Already up to date.")
            return
        print(f"Updating to {ref} …")

    code, payload = upd.perform_update(ref)
    if code == 200:
        print(payload.get('message', 'Update verified.'))
        return
    print("ERROR:", payload.get('error', 'update failed'))
    sys.exit(1)


if __name__ == '__main__':
    main()
