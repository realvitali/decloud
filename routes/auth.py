"""Authentication routes: PIN login for DeCloud."""
from flask import Blueprint, jsonify, request, make_response
from shared import app, DECLOUD_PIN, limiter, SESSIONS, SESSION_TTL_SECONDS
import hmac
import secrets
import time

bp = Blueprint('auth', __name__)

@bp.route('/api/auth/login', methods=['POST'])
@limiter.limit("5 per minute")  # Prevent PIN brute-force
def login():
    """Authenticate with a PIN. Sets a session-token cookie on success."""
    if not DECLOUD_PIN:
        return jsonify({'ok': True, 'message': 'Open mode — no PIN required'})

    data = request.get_json(silent=True) or {}
    pin = data.get('pin', '')

    if not hmac.compare_digest(pin, DECLOUD_PIN):
        return jsonify({'error': 'Invalid PIN'}), 401

    # Mint a fresh opaque session token. The PIN never leaves the server.
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = time.time() + SESSION_TTL_SECONDS

    resp = make_response(jsonify({'ok': True, 'session': token}))
    resp.set_cookie(
        'decloud_session', token,
        httponly=True, samesite='Strict',
        secure=request.is_secure,  # only send over HTTPS when the request is HTTPS
        max_age=SESSION_TTL_SECONDS,
    )
    return resp

@bp.route('/api/auth/check', methods=['GET'])
def check_auth():
    """Check if the current session is authenticated."""
    if not DECLOUD_PIN:
        return jsonify({'authenticated': True, 'open_mode': True})

    if _is_authenticated_from_request():
        return jsonify({'authenticated': True, 'open_mode': False})

    return jsonify({'authenticated': False, 'open_mode': False}), 401

@bp.route('/api/auth/logout', methods=['POST'])
def logout():
    """Invalidate the current session token."""
    token = request.cookies.get('decloud_session')
    if token:
        SESSIONS.pop(token, None)
    resp = make_response(jsonify({'ok': True}))
    resp.delete_cookie('decloud_session')
    return resp

def _is_authenticated_from_request():
    """Local helper for the check endpoint; mirrors shared._is_authenticated
    but without the before_request overhead."""
    from shared import SESSIONS as _S
    now = time.time()
    token = request.cookies.get('decloud_session')
    if token and _S.get(token, 0) > now:
        return True
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        bearer = auth_header[7:].strip()
        if bearer and _S.get(bearer, 0) > now:
            return True
    return False