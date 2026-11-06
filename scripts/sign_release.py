#!/usr/bin/env python3
"""Sign DeCloud releases on the maintainer's machine.

The private key never goes to GitHub or CI. Installs only accept a release whose
record is signed by a key pinned in their own copy of lab_report.RELEASE_SIGNERS,
so a hijacked account, repo or workflow cannot ship an update.

  .venv/bin/python scripts/sign_release.py init [--hardware]   create the key once, pin its public half
  .venv/bin/python scripts/sign_release.py sign [vX.Y.Z]       sign a release CI created (default: the newest)
  .venv/bin/python scripts/sign_release.py verify [vX.Y.Z]     check a published release like an install would

Key: ~/.ssh/decloud_release (override with DECLOUD_SIGNING_KEY). Use --hardware
for a security key (YubiKey etc.): every signature then needs a touch.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import lab_report  # noqa: E402

KEY = Path(os.environ.get('DECLOUD_SIGNING_KEY', Path.home() / '.ssh' / 'decloud_release'))
NS = lab_report.SIG_NAMESPACE


def run(*args, **kw):
    return subprocess.run(args, check=True, **kw)


def git(*args):
    return run('git', '-C', str(ROOT), *args, capture_output=True).stdout


def signers_line():
    pub = Path(str(KEY) + '.pub').read_text().split()
    return f'decloud-release namespaces="{NS}" {pub[0]} {pub[1]}'


def init(hardware):
    if not KEY.exists():
        KEY.parent.mkdir(mode=0o700, exist_ok=True)
        print('Creating the release signing key. Choose a strong passphrase.' + (' Touch your security key when it blinks.' if hardware else ''))
        run('ssh-keygen', '-t', 'ed25519-sk' if hardware else 'ed25519', '-C', 'decloud-release', '-f', str(KEY))
    line = signers_line()
    src = (ROOT / 'lab_report.py').read_text()
    current = lab_report.RELEASE_SIGNERS.strip()
    if line in current.splitlines():
        print('This key is already pinned in lab_report.py.')
        return
    pinned = (current + '\n' + line).strip() if current else line
    new = re.sub(r"^RELEASE_SIGNERS = .*$", 'RELEASE_SIGNERS = ' + repr(pinned + '\n'), src, count=1, flags=re.M)
    (ROOT / 'lab_report.py').write_text(new)
    print('Pinned the public key in lab_report.py:\n  ' + line)
    print('Commit and release it. Installs trust this key from that version on.')
    if current:
        print('Note: a second key was added. Sign that release with an already-pinned key so existing installs accept it.')


def manifest(tag):
    commit = git('rev-parse', f'{tag}^{{commit}}').decode().strip()
    agent = git('show', f'{tag}:lab_report.py')
    m = re.search(rb'^AGENT_VERSION = (\d+)', agent, re.M)
    return json.dumps({'version': tag, 'commit': commit, 'agent_sha256': hashlib.sha256(agent).hexdigest(),
                       'agent_version': int(m.group(1))}, sort_keys=True, separators=(',', ':')).encode()


def latest_tag():
    return run('gh', 'release', 'view', '--json', 'tagName', '-q', '.tagName', cwd=ROOT, capture_output=True, text=True).stdout.strip()


def sign(tag):
    tag = tag or latest_tag()
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        sys.exit(f'Not a release tag: {tag!r}')
    git('fetch', '--tags', '--force', 'origin')
    body = manifest(tag)
    with tempfile.TemporaryDirectory() as d:
        mf = Path(d, 'release-manifest.json')
        mf.write_bytes(body)
        print(f'Signing {tag} ({json.loads(body)["commit"][:12]}) …')
        run('ssh-keygen', '-Y', 'sign', '-f', str(KEY), '-n', NS, str(mf))
        sig = Path(str(mf) + '.sig').read_bytes()
        # The release must verify with the keys pinned by the versions people run now
        lab_report.verify_release(body, sig, lab_report.RELEASE_SIGNERS)
        run('gh', 'release', 'upload', tag, str(mf), str(mf) + '.sig', '--clobber', cwd=ROOT)
    print(f'Signed and published. Installs will now offer {tag}.')


def verify(tag):
    import routes.update as upd
    tag = tag or latest_tag()
    upd._signed_cache.clear()
    res = upd.verified_release(tag)
    print(f'{tag}: ' + ('signed by a pinned key ✓ ' + json.dumps(res['manifest']) if res['ok'] else 'NOT accepted: ' + res['error']))
    sys.exit(0 if res['ok'] else 1)


if __name__ == '__main__':
    cmd, rest = (sys.argv[1] if len(sys.argv) > 1 else ''), sys.argv[2:]
    if cmd == 'init':
        init('--hardware' in rest)
    elif cmd == 'sign':
        sign(rest[0] if rest else '')
    elif cmd == 'verify':
        verify(rest[0] if rest else '')
    else:
        print(__doc__)
