"""System info and network stats routes."""
from flask import Blueprint, jsonify, request
import platform, psutil, time
from shared import _network_last

bp = Blueprint('system', __name__)

@bp.route('/api/system')
def system_info():
    try:
        boot_time = psutil.boot_time()
        uptime = int(__import__('time').time() - boot_time)
        hours, rem = divmod(uptime, 3600)
        mins = rem // 60

        vm = psutil.virtual_memory()
        temps = {}
        try:
            temps = psutil.sensors_temperatures()
            temps = {k: [{'label': s.label, 'current': s.current} for s in v] for k, v in temps.items()}
        except:
            pass

        return jsonify({
            'hostname': platform.node(),
            'os': 'Linux Mint 22.3',
            'cpu_percent': psutil.cpu_percent(interval=0.5),
            'cpu_cores': psutil.cpu_count(),
            'ram_total': vm.total,
            'ram_used': vm.used,
            'ram_percent': vm.percent,
            'disk_percent': psutil.disk_usage('/').percent,
            'uptime': f'{hours}h {mins}m',
            'temps': temps,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── API: Network Stats ───────────────────────────────────────
@bp.route('/api/network/stats')
def network_stats():
    """Current network upload/download speeds in bytes/sec (delta between calls)."""
    now = time.time()
    io = psutil.net_io_counters()
    prev = _network_last
    dt = now - prev['ts'] if prev['ts'] else 0
    if dt > 0 and prev['ts']:
        up_speed = (io.bytes_sent - prev['bytes_sent']) / dt
        down_speed = (io.bytes_recv - prev['bytes_recv']) / dt
    else:
        up_speed = 0
        down_speed = 0
    _network_last.update(bytes_sent=io.bytes_sent, bytes_recv=io.bytes_recv, ts=now)
    return jsonify({
        'upload_speed': max(0, int(up_speed)),
        'download_speed': max(0, int(down_speed)),
        'total_sent': io.bytes_sent,
        'total_recv': io.bytes_recv,
        'timestamp': now,
    })

