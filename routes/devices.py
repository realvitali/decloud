"""Devices route — real device list from Tailscale + active connections."""
from flask import Blueprint, jsonify
import json, subprocess, time
import psutil

bp = Blueprint('devices', __name__)

APP_PORT = int(__import__('os').environ.get('DECLOUD_PORT', '8899'))


def _tailscale_status():
    """Return parsed `tailscale status --json` or {} if unavailable."""
    try:
        result = subprocess.run(['tailscale', 'status', '--json'],
                                capture_output=True, text=True, timeout=5)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception:
        pass
    return {}


def _is_ipv4(ip):
    return bool(ip) and ':' not in ip


@bp.route('/api/devices')
def devices():
    """Return this machine + tailnet peers with real names, OS and status."""
    out = []

    ts = _tailscale_status()

    # 1. This machine (Self node)
    self_node = ts.get('Self') or {}
    self_ip = ''
    for ip in (self_node.get('TailscaleIPs') or []):
        if _is_ipv4(ip):
            self_ip = ip
            break
    out.append({
        'ip': self_ip,
        'name': self_node.get('HostName') or 'this machine',
        'dns': (self_node.get('DNSName') or '').rstrip('.'),
        'os': self_node.get('OS') or '',
        'online': True,
        'is_local': True,
        'last_seen': '',
    })

    # 2. Tailnet peers
    for peer_id, peer in (ts.get('Peer') or {}).items():
        # Skip infrastructure nodes (not real devices)
        if peer.get('HostName') == 'funnel-ingress-node':
            continue
        ip = ''
        for candidate in (peer.get('TailscaleIPs') or []):
            if _is_ipv4(candidate):
                ip = candidate
                break
        if not ip:
            continue
        host = peer.get('HostName') or ''
        dns = (peer.get('DNSName') or '').rstrip('.')
        # Tailscale's default hostname is 'localhost' — prefer the DNS
        # machine name (e.g. 'iphone-15-pro-max.tail44f1bb.ts.net').
        dns_short = dns.split('.')[0] if dns else ''
        if host and host.lower() not in ('localhost', 'unknown'):
            name = host
        else:
            name = dns_short or host or ip
        out.append({
            'ip': ip,
            'name': name,
            'dns': dns,
            'os': peer.get('OS') or '',
            'online': bool(peer.get('Online')),
            'is_local': False,
            'last_seen': peer.get('LastHandshake') or peer.get('LastSeen') or '',
        })

    # 3. Active connections to the app that aren't tailnet peers
    #    (LAN clients, localhost browser sessions) — merge by IP.
    known_ips = {d['ip'] for d in out if d['ip']}
    try:
        for c in psutil.net_connections(kind='inet'):
            if c.laddr and c.laddr.port == APP_PORT and c.raddr:
                ip = c.raddr.ip
                if ip in known_ips or ':' in ip:
                    continue
                known_ips.add(ip)
                out.append({
                    'ip': ip,
                    'name': '',
                    'dns': '',
                    'os': '',
                    'online': True,
                    'is_local': False,
                    'last_seen': time.strftime('%Y-%m-%dT%H:%M:%S'),
                })
    except (psutil.AccessDenied, PermissionError):
        pass

    return jsonify(out)
