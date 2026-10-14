"""Authentication routes: passcode login for DeCloud."""
from flask import Blueprint, jsonify, request, make_response
from shared import (
    DECLOUD_PIN, limiter, SESSIONS, SESSION_TTL_SECONDS, MAX_SESSIONS,
    _LOGIN_ATTEMPTS, _LOGIN_BACKOFF_WINDOW, _LOGIN_BACKOFF_MAX,
    _LOGIN_GLOBAL_FAILS, _LOGIN_GLOBAL_WINDOW, _LOGIN_GLOBAL_MAX,
    _csrf_for_token, _extract_session_token, _purge_expired_sessions,
    _session_lock, save_sessions,
)
import hmac
import secrets
import time

bp = Blueprint('auth', __name__)

def _client_addr():
    return request.remote_addr or 'unknown'

def _global_locked() -> bool:
    """True while too many failures (from any address) sit in the window."""
    cutoff = time.time() - _LOGIN_GLOBAL_WINDOW
    with _session_lock:
        _LOGIN_GLOBAL_FAILS[:] = [t for t in _LOGIN_GLOBAL_FAILS if t > cutoff]
        return len(_LOGIN_GLOBAL_FAILS) >= _LOGIN_GLOBAL_MAX

def _record_failure(addr: str) -> float:
    """Record a failed attempt for an address; return seconds to back off."""
    now = time.time()
    with _session_lock:
        attempts = [t for t in _LOGIN_ATTEMPTS.get(addr, []) if now - t < _LOGIN_BACKOFF_WINDOW]
        attempts.append(now)
        _LOGIN_ATTEMPTS[addr] = attempts
        _LOGIN_GLOBAL_FAILS.append(now)
    # Exponential backoff once past the threshold
    over = max(0, len(attempts) - _LOGIN_BACKOFF_MAX)
    return min(8.0, 0.5 * (2 ** over)) if over else 0.0

def _clear_failures(addr: str):
    _LOGIN_ATTEMPTS.pop(addr, None)

@bp.route('/api/auth/login', methods=['POST'])
@limiter.limit("5 per minute")  # Prevent passcode brute-force
def login():
    """Authenticate with the passcode. Sets a session-token cookie on success."""
    if not DECLOUD_PIN:
        return jsonify({'ok': True, 'message': 'Open mode — no passcode required'})

    addr = _client_addr()
    data = request.get_json(silent=True) or {}
    pin = data.get('pin', '')
    if not isinstance(pin, str) or not pin:
        return jsonify({'error': 'Invalid passcode'}), 401

    if _global_locked():
        return jsonify({
            'error': 'Too many wrong passcodes — sign-in is paused for a few '
                     'minutes. On the computer, `./decloud pin reset` clears it.',
            'code': 'LOGIN_LOCKED',
        }), 429

    if not hmac.compare_digest(pin, DECLOUD_PIN):
        backoff = _record_failure(addr)
        if backoff > 0:
            time.sleep(backoff)
        return jsonify({'error': 'Invalid passcode'}), 401

    _clear_failures(addr)

    # Mint a fresh opaque session token. The passcode never leaves the server.
    token = secrets.token_urlsafe(32)
    with _session_lock:
        _purge_expired_sessions()
        # Bound the session table so an attacker cannot fill memory with tokens
        while len(SESSIONS) >= MAX_SESSIONS:
            SESSIONS.pop(min(SESSIONS, key=SESSIONS.get), None)
        SESSIONS[token] = time.time() + SESSION_TTL_SECONDS
    save_sessions()

    # The token itself only travels in the HttpOnly cookie — page JS never
    # sees it. (The TUI reads it from Set-Cookie and sends it as Bearer.)
    resp = make_response(jsonify({
        'ok': True,
        'csrf': _csrf_for_token(token),
    }))
    resp.set_cookie(
        'decloud_session', token,
        httponly=True, samesite='Strict',
        secure=request.is_secure,  # HTTPS only when the request is HTTPS
        max_age=SESSION_TTL_SECONDS,
        path='/',
    )
    return resp

@bp.route('/api/auth/check', methods=['GET'])
def check_auth():
    """Check if the current session is authenticated."""
    if not DECLOUD_PIN:
        return jsonify({'authenticated': True, 'open_mode': True})

    token = _extract_session_token()
    valid = bool(token) and token in SESSIONS and SESSIONS.get(token, 0) > time.time()
    if valid:
        return jsonify({
            'authenticated': True,
            'open_mode': False,
            'csrf': _csrf_for_token(token),
        })
    return jsonify({'authenticated': False, 'open_mode': False}), 401

@bp.route('/api/auth/logout', methods=['POST'])
def logout():
    """Invalidate the current session token."""
    token = _extract_session_token()
    if token:
        SESSIONS.pop(token, None)
        save_sessions()
    resp = make_response(jsonify({'ok': True}))
    resp.delete_cookie('decloud_session')
    return resp


@bp.route('/api/auth/pin', methods=['POST'])
@limiter.limit("10 per hour")
def change_pin():
    """Change the access passcode. Requires the current passcode (in case a
    valid session is held by an untrusted device) and writes the new one to
    .env + the running process, then invalidates every session."""
    import shared

    data = request.get_json(silent=True) or {}
    current = data.get('current_pin', '') or ''
    new = data.get('new_pin', '') or ''
    if not isinstance(current, str) or not isinstance(new, str):
        return jsonify({'error': 'Invalid request'}), 400

    # In open mode there is no existing passcode to verify, so an
    # unauthenticated caller could set one and lock the owner out. Refuse.
    if not shared.DECLOUD_PIN:
        return jsonify({'error': 'No passcode is set — configure DECLOUD_PIN in .env first.'}), 400

    if not hmac.compare_digest(current, shared.DECLOUD_PIN):
        return jsonify({'error': 'Current passcode is incorrect'}), 401

    new = new.strip()
    # The login screen is a number keypad (max 10 digits) — anything else
    # would lock the owner out.
    if not (new.isascii() and new.isdigit() and 8 <= len(new) <= 10):
        return jsonify({'error': 'New passcode must be 8 to 10 numbers'}), 400
    if hmac.compare_digest(new, shared.DECLOUD_PIN):
        return jsonify({'error': 'New passcode must be different from the current one'}), 400

    if not shared.set_env_value('DECLOUD_PIN', new):
        return jsonify({'error': 'Could not write .env (check permissions)'}), 500

    # Update the running process (shared gate + this module's copy) and
    # force every device to sign in again with the new passcode.
    shared.DECLOUD_PIN = new
    global DECLOUD_PIN
    DECLOUD_PIN = new
    SESSIONS.clear()
    save_sessions()

    return jsonify({'ok': True, 'message': 'Passcode updated — please sign in again'})
