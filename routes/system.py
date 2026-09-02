"""System info and network stats routes."""
from flask import Blueprint, jsonify, request
import platform, psutil, time, subprocess
from pathlib import Path
from shared import _network_last, detect_os

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

        osinfo = detect_os()
        # CPU model (fastfetch-style)
        cpu_model = platform.processor() or ''
        if not cpu_model or cpu_model == 'x86_64':
            try:
                for line in Path('/proc/cpuinfo').read_text(errors='replace').splitlines():
                    if line.lower().startswith('model name'):
                        cpu_model = line.split(':', 1)[1].strip()
                        break
            except OSError:
                pass
        # GPU (NVIDIA via nvidia-smi, else lspci)
        gpu = ''
        try:
            out = subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                                 capture_output=True, text=True, timeout=3).stdout.strip()
            if out:
                gpu = out.splitlines()[0]
        except Exception:
            pass
        if not gpu:
            try:
                out = subprocess.run(['lspci'], capture_output=True, text=True, timeout=3).stdout
                for line in out.splitlines():
                    if 'VGA' in line or '3D' in line or 'Display' in line:
                        gpu = line.split(': ', 1)[1].strip()
                        break
            except Exception:
                pass
        disk = psutil.disk_usage('/')
        return jsonify({
            'hostname': platform.node(),
            'os': osinfo['name'],
            'os_version': osinfo['version'],
            'os_kernel': osinfo['kernel'],
            'cpu_model': cpu_model,
            'gpu': gpu,
            'cpu_percent': psutil.cpu_percent(interval=0.5),
            'cpu_cores': psutil.cpu_count(),
            'ram_total': vm.total,
            'ram_used': vm.used,
            'ram_percent': vm.percent,
            'disk_total': disk.total,
            'disk_used': disk.used,
            'disk_percent': disk.percent,
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

