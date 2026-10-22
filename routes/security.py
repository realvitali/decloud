"""Security routes: the audit trail (Logs) and the TOTP second step in front of the Terminal."""
from flask import Blueprint, jsonify, request
import base64, hashlib, hmac, json, os, struct, tempfile, threading, time
from pathlib import Path

import audit
import shared
from shared import limiter, _extract_session_token

bp = Blueprint('security', __name__)

UNLOCK_SECONDS = 4 * 3600        # how long a correct code keeps the Terminal open
_FAIL_LIMIT, _FAIL_WINDOW, _LOCKOUT = 5, 900, 900
_lock = threading.Lock()
_unlocked = {}                   # session token -> expiry
_fails = []                      # timestamps of recent wrong codes
_locked_until = 0.0


def _totp_path():
    return Path(os.environ.get('DECLOUD_TOTP_FILE') or Path(shared.BASE_DIR) / 'totp.json')


def _load():
    try:
        d = json.loads(_totp_path().read_text())
        base64.b32decode(d['secret'], casefold=True)
        return d
    except Exception:
        return None


def _save(d):
    p = _totp_path()
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix='.totp-')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as fh:
            json.dump(d, fh)
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _code(secret_b32, step):
    key = base64.b32decode(secret_b32, casefold=True)
    mac = hmac.new(key, struct.pack('>Q', step), hashlib.sha1).digest()
    o = mac[-1] & 0x0F
    return '%06d' % ((struct.unpack('>I', mac[o:o + 4])[0] & 0x7FFFFFFF) % 1000000)


def verify(code, now=None):
    """RFC 6238 (SHA1, 6 digits, 30 s) with one step of clock drift; a step can be used only once."""
    d = _load()
    code = (code or '').replace(' ', '')
    if not d or len(code) != 6 or not code.isdigit():
        return False
    cur = int((now if now is not None else time.time()) // 30)
    for step in (cur - 1, cur, cur + 1):
        if hmac.compare_digest(_code(d['secret'], step), code):
            if step <= int(d.get('last_step', 0)):
                return False                      # replay of a code already used
            d['last_step'] = step
            try:
                _save(d)
            except Exception:
                return False
            return True
    return False


def terminal_unlocked(token):
    with _lock:
        exp = _unlocked.get(token or 'open', 0)
        if exp > time.time():
            return True
        _unlocked.pop(token or 'open', None)
        return False


@bp.route('/api/terminal/status')
def terminal_status():
    tok = _extract_session_token()
    with _lock:
        exp = _unlocked.get(tok or 'open', 0)
    return jsonify({'configured': _load() is not None, 'unlocked': exp > time.time(),
                    'expires_in': max(0, int(exp - time.time())), 'locked_out': max(0, int(_locked_until - time.time()))})


@bp.route('/api/terminal/unlock', methods=['POST'])
@limiter.limit("10 per minute")
def terminal_unlock():
    global _locked_until
    if _load() is None:
        return jsonify({'error': 'Two-step code is not set up. On the server run: .venv/bin/python scripts/totp_setup.py'}), 409
    now = time.time()
    with _lock:
        if _locked_until > now:
            audit.log('totp_locked', 'attempt while locked out', ok=False)
            return jsonify({'error': 'Too many wrong codes. Try again in %d min.' % (int(_locked_until - now) // 60 + 1)}), 429
    code = (request.get_json(silent=True) or {}).get('code', '')
    if not isinstance(code, str) or not verify(code):
        with _lock:
            _fails[:] = [t for t in _fails if now - t < _FAIL_WINDOW] + [now]
            if len(_fails) >= _FAIL_LIMIT:
                _locked_until = now + _LOCKOUT
                _fails.clear()
        audit.log('totp_fail', 'wrong terminal code', ok=False)
        return jsonify({'error': 'That code is not right.'}), 401
    with _lock:
        _fails.clear()
        _unlocked[_extract_session_token() or 'open'] = now + UNLOCK_SECONDS
    audit.log('totp_ok', 'terminal unlocked')
    return jsonify({'ok': True, 'expires_in': UNLOCK_SECONDS})


@bp.route('/api/logs')
def logs():
    group = request.args.get('group', '')
    limit = max(1, min(500, request.args.get('limit', 200, type=int)))
    return jsonify({'events': audit.read(group, limit)})
