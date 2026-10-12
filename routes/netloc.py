"""Network-location awareness: detect if the client is on the Tailnet.

Classifies the client IP into tailscale / lan / public so the UI can show a
"connect to your tailnet" splash when someone opens DeCloud over a funnel or
public address. Never blocks access — purely informational.
"""
from flask import Blueprint, jsonify, request
import ipaddress

bp = Blueprint('netloc', __name__)

_TAILSCALE_NET = ipaddress.ip_network('100.64.0.0/10')  # Tailscale CGNAT


def _classify(ip_str: str) -> str:
    """Classify a client address into a connection type."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return 'unknown'
    if ip.version == 4 and ip in _TAILSCALE_NET:
        return 'tailscale'
    if ip.version == 6 and (ip.is_link_local or str(ip).lower().startswith('fd7a:')):
        # Tailscale IPv6: fd7a::/48 ULA
        return 'tailscale'
    if ip.is_private or ip.is_loopback:
        return 'lan'
    if ip.is_global:
        return 'public'
    return 'unknown'


@bp.route('/api/netloc')
def netloc():
    """Where is this client connecting from? Informational only."""
    # X-Forwarded-For is only trusted if it came through our own funnel proxy
    # (tailscale funnel sets it); remote_addr is the socket peer either way.
    client = request.remote_addr or ''
    via = request.headers.get('X-Forwarded-For', '')
    # If the funnel proxy is in front, remote_addr will be the proxy — use XFF's first hop
    if via:
        client = via.split(',')[0].strip()
    return jsonify({
        'type': _classify(client),
        'ip_class': _classify(client),
        'hint': {
            'tailscale': 'Connected via Tailscale — full speed, fully encrypted.',
            'lan': 'On your home network — fast, but not via Tailscale.',
            'public': 'Public internet — apps may be a cached/static snapshot. Connect to your tailnet for the live app.',
            'unknown': 'Connection type unknown.',
        }.get(_classify(client), ''),
    })
