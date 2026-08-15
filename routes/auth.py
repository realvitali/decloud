"""Authentication routes: PIN login for DeCloud."""
from flask import Blueprint, jsonify, request, make_response
from shared import app, DECLOUD_PIN, limiter
import hmac

bp = Blueprint('auth', __name__)

@bp.route('/api/auth/login', methods=['POST'])
@limiter.limit("5 per minute")  # Prevent PIN brute-force
def login():
    """Authenticate with a PIN. Sets a cookie on success."""
    if not DECLOUD_PIN:
        return jsonify({'ok': True, 'message': 'Open mode — no PIN required'})
    
    data = request.get_json(silent=True) or {}
    pin = data.get('pin', '')
    
    if hmac.compare_digest(pin, DECLOUD_PIN):
        resp = make_response(jsonify({'ok': True}))
        resp.set_cookie('decloud_pin', DECLOUD_PIN, httponly=True, samesite='Strict', max_age=30*24*60*60)
        return resp
    
    return jsonify({'error': 'Invalid PIN'}), 401

@bp.route('/api/auth/check', methods=['GET'])
def check_auth():
    """Check if the current session is authenticated."""
    if not DECLOUD_PIN:
        return jsonify({'authenticated': True, 'open_mode': True})
    
    session_pin = request.cookies.get('decloud_pin')
    if session_pin and hmac.compare_digest(session_pin, DECLOUD_PIN):
        return jsonify({'authenticated': True, 'open_mode': False})
    
    return jsonify({'authenticated': False, 'open_mode': False}), 401

@bp.route('/api/auth/logout', methods=['POST'])
def logout():
    """Clear the auth cookie."""
    resp = make_response(jsonify({'ok': True}))
    resp.delete_cookie('decloud_pin')
    return resp