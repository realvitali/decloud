"""DeCloud passcode helper (stdlib only).

    decloud pin          show your passcode
    decloud pin reset    get a new passcode (type the old one, or press
                         Enter if you forgot it — being at this computer
                         is the proof that you own it)
"""
import hmac
import os
import secrets
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
ENV = APP_DIR / '.env'
SESSIONS = APP_DIR / 'sessions.json'
CLI = '.\\decloud.ps1' if os.name == 'nt' else './decloud'


def new_pin():
    return ''.join(str(secrets.randbelow(10)) for _ in range(8))


def read_pin():
    if not ENV.exists():
        return ''
    pin = ''
    for line in ENV.read_text(errors='replace').splitlines():
        if line.strip().startswith('DECLOUD_PIN='):
            pin = line.split('=', 1)[1].strip().strip('"\'')  # last wins, like the app
    return pin


def write_pin(pin):
    lines = ENV.read_text(errors='replace').splitlines() if ENV.exists() else []
    lines = [l for l in lines if not l.strip().startswith('DECLOUD_PIN=')]
    lines.append(f'DECLOUD_PIN={pin}')
    fd = os.open(ENV, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    try:
        os.chmod(ENV, 0o600)
    except OSError:
        pass


def banner(pin, title):
    shown = f'{pin[:4]} {pin[4:]}' if len(pin) == 8 and pin.isdigit() else pin
    print()
    print('  ┌──────────────────────────────────────────────┐')
    print(f'  │  {title:<44}│')
    print(f'  │  {shown:<44}│')
    print('  │                                              │')
    print('  │  Write it down somewhere safe (a password    │')
    print('  │  manager, or paper you keep at home).        │')
    print(f'  │  Forgot it? Run:  {CLI + " pin":<27}│')
    print('  └──────────────────────────────────────────────┘')
    print()


def restart():
    """Restart the running app so the new passcode takes effect."""
    def ok(*cmd):
        try:
            return subprocess.run(cmd, capture_output=True, timeout=30).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    if os.name == 'nt':
        return 'done'  # decloud.ps1 restarts the scheduled task itself
    if ok('systemctl', '--user', 'is-active', '--quiet', 'decloud'):
        return 'done' if ok('systemctl', '--user', 'restart', 'decloud') else 'manual'
    if sys.platform == 'darwin' and ok('launchctl', 'list', 'com.decloud.app'):
        return 'done' if ok('launchctl', 'kickstart', '-k',
                            f'gui/{os.getuid()}/com.decloud.app') else 'manual'
    pidfile = APP_DIR / 'app.pid'
    if pidfile.exists():
        try:
            import psutil
            # ./decloud start runs a supervisor loop; killing its python child
            # makes the loop start a fresh one with the new passcode.
            for child in psutil.Process(int(pidfile.read_text())).children(recursive=True):
                child.terminate()
            return 'done'
        except Exception:
            pass
    return 'manual'


def reset():
    old = read_pin()
    if old:
        try:
            typed = input('Type your current passcode (or just press Enter if you forgot it): ').strip()
        except EOFError:
            typed = ''
        if typed and not hmac.compare_digest(typed, old):
            print('That passcode is wrong. Nothing was changed.')
            print('Forgot it? Run this again and just press Enter.')
            return 1
        if not typed:
            ans = input('Emergency reset: make a new passcode and sign out every device? [y/N] ')
            if ans.strip().lower() not in ('y', 'yes'):
                print('Cancelled. Nothing was changed.')
                return 1
    pin = new_pin()
    write_pin(pin)
    SESSIONS.unlink(missing_ok=True)  # old logins stop working
    banner(pin, 'Your NEW DeCloud passcode:')
    print('Every phone and browser will need to sign in again with it.')
    if restart() == 'manual':
        print(f'Now restart DeCloud so the new passcode works:  {CLI} restart')
    return 0


def main(argv):
    cmd = argv[0] if argv else 'show'
    if cmd == 'show':
        pin = read_pin()
        if not pin:
            print(f'No passcode set yet. Run:  {CLI} pin reset')
            return 1
        banner(pin, 'Your DeCloud passcode:')
        print(f'Want a different one? Run:  {CLI} pin reset')
        return 0
    if cmd == 'reset':
        return reset()
    print(__doc__)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
