"""Authentication routes: passcode login for DeCloud."""
from flask import Blueprint, jsonify, request, make_response
from shared import (
    app, DECLOUD_PIN, limiter, SESSIONS, SESSION_TTL_SECONDS, MAX_SESSIONS,
    _LOGIN_ATTEMPTS, _LOGIN_BACKOFF_WINDOW, _LOGIN_BACKOFF_MAX,
    _csrf_for_token, _purge_expired_sessions,
)
import hmac
import secrets
import time

bp = Blueprint('auth', __name__)

def _client_addr():
    return request.remote_addr or 'unknown'

def _record_failure(addr: str) -> float:
    """Record a failed attempt for an address; return seconds to back off."""
    now = time.time()
    attempts = [t for t in _LOGIN_ATTEMPTS.get(addr, []) if now - t < _LOGIN_BACKOFF_WINDOW]
    attempts.append(now)
    _LOGIN_ATTEMPTS[addr] = attempts
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

    if not hmac.compare_digest(pin, DECLOUD_PIN):
        backoff = _record_failure(addr)
        if backoff > 0:
            time.sleep(backoff)
        return jsonify({'error': 'Invalid passcode'}), 401

    _clear_failures(addr)

    # Mint a fresh opaque session token. The passcode never leaves the server.
    token = secrets.token_urlsafe(32)
    _purge_expired_sessions()
    # Bound the session table so an attacker cannot fill memory with tokens
    if len(SESSIONS) >= MAX_SESSIONS:
        oldest = sorted(SESSIONS.items(), key=lambda kv: kv[1])[:1]
        for old_token, _ in oldest:
            SESSIONS.pop(old_token, None)
    SESSIONS[token] = time.time() + SESSION_TTL_SECONDS

    resp = make_response(jsonify({
        'ok': True,
        'session': token,
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

    token = request.cookies.get('decloud_session')
    if not token:
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:].strip()
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
    token = request.cookies.get('decloud_session')
    if not token:
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:].strip()
    if token:
        SESSIONS.pop(token, None)
    resp = make_response(jsonify({'ok': True}))
    resp.delete_cookie('decloud_session')
    return resp
