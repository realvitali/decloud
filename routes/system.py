"""System info and network stats routes."""
from flask import Blueprint, jsonify, request
import platform, psutil, time, subprocess, shutil, re
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

        # Hardware details for the neofetch-style panel
        cpu_name = ''
        try:
            if platform.system() == 'Linux':
                # ARM: try lscpu (has Model name), then /proc/cpuinfo 'model name'/'model'
                if shutil.which('lscpu'):
                    res = subprocess.run(['lscpu'], capture_output=True, text=True, timeout=3)
                    for line in res.stdout.splitlines():
                        if line.lower().startswith('model name:'):
                            cpu_name = line.split(':', 1)[1].strip()
                            break
                if not cpu_name:
                    for line in Path('/proc/cpuinfo').read_text(errors='replace').splitlines():
                        if line.lower().startswith(('model name', 'model')):
                            cpu_name = line.split(':', 1)[1].strip()
                            break
            elif platform.system() == 'Darwin':
                res = subprocess.run(['sysctl', '-n', 'machdep.cpu.brand_string'],
                                     capture_output=True, text=True, timeout=2)
                cpu_name = res.stdout.strip()
        except Exception:
            pass
        cpu_name = cpu_name or platform.processor() or platform.machine()

        gpu_name = ''
        try:
            if platform.system() == 'Linux' and shutil.which('lspci'):
                res = subprocess.run(['lspci'], capture_output=True, text=True, timeout=4)
                for line in res.stdout.splitlines():
                    if re.search(r'VGA|3D controller|Display', line):
                        # format: "01:00.0 Class: Vendor Name Device 1234 (rev a1)"
                        m = re.search(r'VGA compatible controller: (.+?)(?:\s*\(rev|$)', line)
                        if not m:
                            m = re.search(r'3D controller: (.+?)(?:\s*\(rev|$)', line)
                        if not m:
                            m = re.search(r'Display controller: (.+?)(?:\s*\(rev|$)', line)
                        gpu_name = re.sub(r'\s+Device\s+[0-9a-fA-F]{4}$', '', (m.group(1) if m else '')).strip()
                        if gpu_name.endswith('NVIDIA Corporation'):
                            # lspci db too old to resolve the model — try nvidia-smi for a proper name
                            try:
                                ns = subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                                                    capture_output=True, text=True, timeout=4)
                                if ns.returncode == 0 and ns.stdout.strip():
                                    gpu_name = ns.stdout.strip().splitlines()[0]
                            except Exception:
                                pass
                        break
            elif platform.system() == 'Darwin' and shutil.which('system_profiler'):
                res = subprocess.run(['system_profiler', 'SPDisplaysDataType'],
                                     capture_output=True, text=True, timeout=6)
                m = re.search(r'Chipset Model:\s*(.+)', res.stdout)
                if m:
                    gpu_name = m.group(1).strip()
        except Exception:
            pass

        swap = psutil.swap_memory()
        battery = None
        try:
            bat = psutil.sensors_battery()
            if bat is not None:
                battery = {'percent': round(bat.percent), 'plugged': bat.power_plugged}
        except Exception:
            pass

        arch = platform.machine() or ''
        mem_total_gb = vm.total / (1024 ** 3)
        disk = psutil.disk_usage('/')
        disk_total_gb = disk.total / (1024 ** 3)

        return jsonify({
            'hostname': platform.node(),
            'os': osinfo['name'],
            'os_version': osinfo['version'],
            'os_kernel': osinfo['kernel'],
            'arch': arch,
            'cpu_name': cpu_name,
            'cpu_cores': psutil.cpu_count(),
            'cpu_percent': psutil.cpu_percent(interval=0.5),
            'gpu_name': gpu_name,
            'ram_total': vm.total,
            'ram_used': vm.used,
            'ram_percent': vm.percent,
            'ram_total_gb': round(mem_total_gb, 1),
            'swap_percent': swap.percent,
            'disk_percent': disk.percent,
            'disk_total_gb': round(disk_total_gb, 1),
            'battery': battery,
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

