#!/usr/bin/env python3
"""DeCloud lab report — one machine's specs + what's running.

Used two ways:
  * imported by DeCloud (routes/lab.py) to serve /api/lab/report
  * run standalone as the tiny agent on headless boxes (Pi, NAS, Proxmox):
        python3 lab_report.py                    # serve on :8898, print pairing code
        python3 lab_report.py --install-service  # same, as a systemd user service

Standalone needs only Python 3.8+ and psutil (apt install python3-psutil).
Keep this file free of DeCloud imports so it can be copied anywhere.
"""
import base64
import hmac
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import psutil

AGENT_PORT = 8898
_VIRTUAL_FS = {'tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'proc', 'sysfs', 'ramfs', 'efivarfs', 'autofs'}


def _run(cmd, timeout=3):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ''
    except Exception:
        return ''


def os_name():
    if platform.system() == 'Linux':
        try:
            info = dict(l.split('=', 1) for l in Path('/etc/os-release').read_text().splitlines() if '=' in l)
            return info.get('PRETTY_NAME', 'Linux').strip('"')
        except OSError:
            return 'Linux'
    if platform.system() == 'Darwin':
        return f'macOS {platform.mac_ver()[0]}'.strip()
    return f'{platform.system()} {platform.release()}'.strip()


def cpu_name():
    name = ''
    if platform.system() == 'Linux':
        for line in _run(['lscpu']).splitlines():
            if line.lower().startswith('model name:'):
                name = line.split(':', 1)[1].strip()
                break
        if not name:
            try:
                for line in Path('/proc/cpuinfo').read_text(errors='replace').splitlines():
                    if line.lower().startswith(('model name', 'model')):
                        name = line.split(':', 1)[1].strip()
                        break
            except OSError:
                pass
    elif platform.system() == 'Darwin':
        name = _run(['sysctl', '-n', 'machdep.cpu.brand_string'], 2).strip()
    return name or platform.processor() or platform.machine()


def gpus():
    """[{name, vram_gb, util, temp}] — NVIDIA via nvidia-smi (full detail),
    anything else by name only (lspci / system_profiler)."""
    out = []
    if shutil.which('nvidia-smi'):
        q = _run(['nvidia-smi', '--query-gpu=name,memory.total,utilization.gpu,temperature.gpu',
                  '--format=csv,noheader,nounits'], 4)
        for line in q.strip().splitlines():
            p = [s.strip() for s in line.split(',')]
            if len(p) == 4:
                num = lambda s: float(s) if re.fullmatch(r'[\d.]+', s) else None
                vram = num(p[1])
                out.append({'name': p[0], 'vram_gb': round(vram / 1024, 1) if vram else None,
                            'util': num(p[2]), 'temp': num(p[3])})
        if out:
            return out
    if platform.system() == 'Linux' and shutil.which('lspci'):
        for line in _run(['lspci'], 4).splitlines():
            m = re.search(r'(?:VGA compatible controller|3D controller|Display controller): (.+?)(?:\s*\(rev|$)', line)
            if m:
                out.append({'name': re.sub(r'\s+Device\s+[0-9a-fA-F]{4}$', '', m.group(1)).strip(),
                            'vram_gb': None, 'util': None, 'temp': None})
    elif platform.system() == 'Darwin':
        for m in re.finditer(r'Chipset Model:\s*(.+)', _run(['system_profiler', 'SPDisplaysDataType'], 6)):
            out.append({'name': m.group(1).strip(), 'vram_gb': None, 'util': None, 'temp': None})
    return out


def storage():
    """Sum of real (non-virtual) filesystems, one entry per device."""
    seen, total, used, disks = set(), 0, 0, 0
    for p in psutil.disk_partitions(all=False):
        if p.fstype in _VIRTUAL_FS or p.device in seen or '/snap/' in p.mountpoint or p.device.startswith('/dev/loop'):
            continue
        seen.add(p.device)
        try:
            u = psutil.disk_usage(p.mountpoint)
        except Exception:
            continue
        total += u.total
        used += u.used
        disks += 1
    return {'total': total, 'used': used, 'volumes': disks}


def containers():
    for tool in ('docker', 'podman'):
        if shutil.which(tool):
            rows = []
            for line in _run([tool, 'ps', '--format', '{{json .}}'], 4).splitlines():
                try:
                    c = json.loads(line)
                except ValueError:
                    continue
                names = c.get('Names')
                rows.append({'name': names[0] if isinstance(names, list) else names, 'image': c.get('Image', '')})
            return rows
    return []


def ollama_models():
    host = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')
    if not host.startswith('http'):
        host = 'http://' + host
    try:
        with urllib.request.urlopen(host.rstrip('/') + '/api/ps', timeout=1.5) as r:
            return [m.get('name', '') for m in json.load(r).get('models', [])]
    except Exception:
        return []


def services(names):
    if not names or not shutil.which('systemctl'):
        return []
    out = []
    for n in names[:20]:
        if not re.fullmatch(r'[\w@.:-]{1,80}', n):
            continue
        state = _run(['systemctl', 'is-active', n], 2).strip() or 'inactive'
        out.append({'name': n, 'active': state == 'active'})
    return out


def report(service_names=None, kind='decloud'):
    procs = list(psutil.process_iter(['name', 'memory_percent']))
    for p in procs:
        try:
            p.cpu_percent(None)  # prime per-process counters
        except Exception:
            pass
    cpu = psutil.cpu_percent(interval=0.4)
    by_name = {}  # group threads/workers of one app (e.g. 12 × "chrome") into one row
    for p in procs:
        try:
            t = by_name.setdefault(p.info['name'] or '?', {'name': p.info['name'] or '?', 'cpu': 0, 'mem': 0})
            t['cpu'] = round(t['cpu'] + p.cpu_percent(None), 1)
            t['mem'] = round(t['mem'] + (p.info['memory_percent'] or 0), 1)
        except Exception:
            pass
    top = sorted(by_name.values(), key=lambda t: t['cpu'], reverse=True)[:5]

    vm = psutil.virtual_memory()
    temp = None
    try:
        vals = [s.current for v in psutil.sensors_temperatures().values() for s in v if s.current]
        temp = round(max(vals)) if vals else None
    except Exception:
        pass
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except (OSError, AttributeError):
        load = None

    return {
        'kind': kind,
        'hostname': platform.node(),
        'os': os_name(),
        'kernel': platform.release(),
        'arch': platform.machine(),
        'cpu_name': cpu_name(),
        'cores': psutil.cpu_count() or 0,
        'cpu_percent': cpu,
        'load': load,
        'temp': temp,
        'gpus': gpus(),
        'ram_total': vm.total,
        'ram_used': vm.total - vm.available,
        'storage': storage(),
        'uptime_s': int(time.time() - psutil.boot_time()),
        'running': {
            'containers': containers(),
            'models': ollama_models(),
            'services': services(service_names),
            'processes': top,
        },
    }


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))  # no packet sent; picks the LAN-facing interface
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def pairing_code(url, token, name):
    raw = json.dumps({'u': url, 't': token, 'n': name}, separators=(',', ':')).encode()
    return 'dcl1.' + base64.urlsafe_b64encode(raw).decode().rstrip('=')


def parse_pairing_code(code):
    """Returns {'u','t','n'} or raises ValueError."""
    code = (code or '').strip()
    if not code.startswith('dcl1.'):
        raise ValueError('That is not a DeCloud pairing code (it should start with dcl1.)')
    body = code[5:]
    try:
        d = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
    except Exception:
        raise ValueError('Pairing code is damaged — copy it again')
    if not isinstance(d, dict) or not re.match(r'^https?://[^\s/]+', str(d.get('u', ''))) or not d.get('t'):
        raise ValueError('Pairing code is missing the address or key')
    return {'u': str(d['u']).rstrip('/'), 't': str(d['t']), 'n': str(d.get('n') or '')[:40]}


# ─── Standalone agent ────────────────────────────────────────────
def _agent_main(argv):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    cfg_dir = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'decloud-agent'
    cfg_dir.mkdir(parents=True, exist_ok=True)
    tok_file = cfg_dir / 'token'
    if not tok_file.exists():
        tok_file.write_text(secrets.token_urlsafe(24))
        tok_file.chmod(0o600)
    token = tok_file.read_text().strip()
    port = int(os.environ.get('DECLOUD_AGENT_PORT', AGENT_PORT))
    svc = [s for s in os.environ.get('DECLOUD_LAB_SERVICES', '').replace(',', ' ').split() if s]

    if '--install-service' in argv:
        unit_dir = Path.home() / '.config/systemd/user'
        unit_dir.mkdir(parents=True, exist_ok=True)
        (unit_dir / 'decloud-agent.service').write_text(
            '[Unit]\nDescription=DeCloud lab agent\nAfter=network-online.target\n\n'
            f'[Service]\nExecStart={sys.executable} {Path(__file__).resolve()}\nRestart=always\n'
            f'Environment=DECLOUD_AGENT_PORT={port}\nEnvironment=DECLOUD_LAB_SERVICES={",".join(svc)}\n\n'
            '[Install]\nWantedBy=default.target\n')
        subprocess.run(['systemctl', '--user', 'daemon-reload'])
        subprocess.run(['systemctl', '--user', 'enable', '--now', 'decloud-agent'])
        subprocess.run(['loginctl', 'enable-linger', os.environ.get('USER', '')])
        print('Installed as a service: it starts on boot. Logs: journalctl --user -u decloud-agent')

    code = pairing_code(f'http://{lan_ip()}:{port}', token, platform.node())
    print(f'\nDeCloud agent on port {port}. Paste this pairing code into DeCloud → System → Add device:\n\n  {code}\n')
    if '--install-service' in argv:
        return

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            auth = self.headers.get('Authorization', '')
            if self.path != '/api/lab/report':
                self.send_error(404)
                return
            if not hmac.compare_digest(auth, f'Bearer {token}'):
                self.send_error(401)
                return
            body = json.dumps(report(svc, kind='agent')).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    ThreadingHTTPServer(('0.0.0.0', port), H).serve_forever()


if __name__ == '__main__':
    _agent_main(sys.argv[1:])
