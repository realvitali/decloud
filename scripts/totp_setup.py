#!/usr/bin/env python3
"""Create the TOTP secret that protects the DeCloud Terminal.

Run this on the server, in your own terminal (not through the web UI), then scan the QR code with your
authenticator app (Aegis: + > Scan QR code, or Enter manually: SHA1, 6 digits, 30 s).

  .venv/bin/python scripts/totp_setup.py            create (refuses to overwrite)
  .venv/bin/python scripts/totp_setup.py --reset    replace the secret
  .venv/bin/python scripts/totp_setup.py --check 123456   test a code
"""
import base64, json, os, secrets, shutil, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
PATH = Path(os.environ.get('DECLOUD_TOTP_FILE') or ROOT / 'totp.json')

if '--check' in sys.argv:
    sys.path.insert(0, str(ROOT))
    os.environ.setdefault('DECLOUD_TOTP_FILE', str(PATH))
    from routes.security import verify
    print('valid' if verify(sys.argv[sys.argv.index('--check') + 1]) else 'NOT valid')
    sys.exit(0)

if PATH.exists() and '--reset' not in sys.argv:
    sys.exit('A secret already exists (%s). Use --reset to replace it.' % PATH)
secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip('=')
fd, tmp = tempfile.mkstemp(dir=str(PATH.parent), prefix='.totp-')
os.fchmod(fd, 0o600)
with os.fdopen(fd, 'w') as fh:
    json.dump({'secret': secret, 'last_step': 0, 'created': int(time.time())}, fh)
os.replace(tmp, PATH)
label = quote('DeCloud:' + (os.environ.get('USER') or 'terminal'))
uri = 'otpauth://totp/%s?secret=%s&issuer=DeCloud&algorithm=SHA1&digits=6&period=30' % (label, secret)
print('\nTerminal two-step code is ready. Saved to %s (mode 600).\n' % PATH)
if shutil.which('qrencode'):
    subprocess.run(['qrencode', '-t', 'ansiutf8', uri])
else:
    print('(install qrencode to show a QR code here)')
print('\nOr add it by hand in your app:  Secret  %s   (TOTP, SHA1, 6 digits, 30 s)\n' % secret)
print('Clear your terminal scrollback afterwards.')
