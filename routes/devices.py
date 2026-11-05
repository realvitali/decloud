"""Devices route: this computer and the devices added in the Lab."""
from flask import Blueprint, jsonify
import json, subprocess

bp = Blueprint('devices', __name__)

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
    """This computer plus the devices added in the Lab (computers and phones),
    with live status. Not every Tailscale peer: that list includes shared-in
    nodes and hundreds of Mullvad exit servers."""
    from shared import load_settings
    import routes.lab as lab
    ts = _tailscale_status()
    by_ip = {ip: p for p in (ts.get('Peer') or {}).values() for ip in (p.get('TailscaleIPs') or [])}
    settings = load_settings()
    me = ts.get('Self') or {}
    out = [{
        'ip': next((ip for ip in (me.get('TailscaleIPs') or []) if _is_ipv4(ip)), ''),
        'name': lab._prefs(settings)['device_name'],
        'dns': (me.get('DNSName') or '').rstrip('.'),
        'os': me.get('OS') or '',
        'online': True, 'is_local': True, 'last_seen': '', 'kind': 'computer',
    }]
    for d in settings.get('lab_devices', []):
        ip = lab._addr(d)
        peer = by_ip.get(ip, {})
        report = lab.cached_report(d.get('id'), max_age=120)
        out.append({'ip': ip, 'name': str(d.get('name', ''))[:40], 'dns': (peer.get('DNSName') or '').rstrip('.'),
                    'os': peer.get('OS') or '', 'online': bool(report and not report.get('error')) if report else bool(peer.get('Online')),
                    'is_local': False, 'last_seen': peer.get('LastSeen') or '', 'kind': 'computer'})
    for ph in settings.get('lab_phones', []):
        peer = by_ip.get(ph.get('ip'), {})
        out.append({'ip': ph.get('ip', ''), 'name': str(ph.get('name', ''))[:40], 'dns': (peer.get('DNSName') or '').rstrip('.'),
                    'os': peer.get('OS') or ph.get('os', ''), 'online': bool(peer.get('Online')),
                    'is_local': False, 'last_seen': peer.get('LastSeen') or '', 'kind': 'phone'})
    return jsonify(out)
