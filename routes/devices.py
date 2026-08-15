"""Devices route."""
from flask import Blueprint, jsonify, request
import json, subprocess, time, re
from pathlib import Path
import psutil
from shared import BASE_DIR

bp = Blueprint('devices', __name__)

@bp.route('/api/devices')
def devices():
    """Return list of devices that have accessed the DeCloud app."""
    devices = {}

    # 1. Active TCP connections to port 8899
    try:
        for c in psutil.net_connections(kind='inet'):
            if c.laddr and c.laddr.port == 8899 and c.raddr:
                ip = c.raddr.ip
                if ip not in devices:
                    devices[ip] = {'ip': ip, 'last_seen': time.strftime('%Y-%m-%d %H:%M:%S'), 'name': ''}
    except (psutil.AccessDenied, PermissionError):
        pass

    # 2. Tailscale devices
    try:
        result = subprocess.run(['tailscale', 'status', '--json'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            ts = json.loads(result.stdout)
            for peer_id, peer in ts.get('Peer', {}).items():
                # Skip funnel ingress nodes (infrastructure, not real devices)
                if peer.get('HostName') == 'funnel-ingress-node':
                    continue
                # Skip IPv6 addresses (use IPv4 only)
                ip = peer.get('TailscaleIPs', [''])[0] if peer.get('TailscaleIPs') else ''
                if not ip or ':' in ip:
                    continue
                name = peer.get('HostName', '') or peer.get('DNSName', '').rstrip('.') or ''
                if ip not in devices:
                    devices[ip] = {'ip': ip, 'last_seen': peer.get('LastSeen', '') or '', 'name': name}
                else:
                    if not devices[ip]['name']:
                        devices[ip]['name'] = name
    except Exception:
        pass

    # 3. Parse access logs (nginx + Flask) for IPs
    log_files = [
        '/var/log/nginx/access.log',
        '/var/log/nginx/decloud_access.log',
        str(BASE_DIR / 'app.log'),
    ]
    for lf in log_files:
        try:
            p = Path(lf)
            if not p.exists():
                continue
            # read last 200 lines for efficiency
            lines = p.read_text(errors='replace').splitlines()[-200:]
            for line in lines:
                m = re.match(r'(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-fA-F:]+)', line)
                if not m:
                    continue
                ip = m.group(1) or m.group(2)
                if ip and ip not in devices:
                    devices[ip] = {'ip': ip, 'last_seen': '', 'name': ''}
        except Exception:
            pass

    return jsonify(list(devices.values()))
