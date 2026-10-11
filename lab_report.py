#!/usr/bin/env python3
"""DeCloud lab report — one machine's specs + what's running, served to
paired hubs over pinned HTTPS.

Used two ways:
  * imported by DeCloud (routes/lab.py): builds the local report, and runs
    LabServer when the user lets other devices add this computer
  * run standalone as the tiny agent on headless boxes (Pi, NAS, Proxmox):
        python3 lab_report.py --install-service   # pair with a hub, then run on boot
        python3 lab_report.py --pair              # pair with another hub later

Security model:
  * every device has its own self-signed cert; a hub pins its SHA-256 at
    pairing time and refuses anything else afterwards (no CA, no warnings)
  * pairing is Bluetooth-style numeric comparison with a commitment, so a
    man-in-the-middle can't make both screens show the same number
  * the token a hub receives only unlocks GET /api/lab/report

Standalone needs only Python 3.8+ and psutil (apt install python3-psutil).
Keep this file free of DeCloud imports so it can be copied anywhere.
"""
import base64
import hashlib
import hmac
import http.client
import json
import os
import platform
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
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


# ─── Keys: token + self-signed cert per device ───────────────────
def _write_secret(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)


def _make_cert(cert, key):
    try:
        import datetime
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
        k = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'decloud-lab')])
        now = datetime.datetime.now(datetime.timezone.utc)
        c = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(k.public_key())
             .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
             .not_valid_after(now + datetime.timedelta(days=3650)).sign(k, hashes.SHA256()))
        _write_secret(key, k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()).decode())
        cert.write_bytes(c.public_bytes(serialization.Encoding.PEM))
    except ImportError:  # standalone agent without the cryptography package
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                        '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '3650', '-subj', '/CN=decloud-lab'],
                       check=True, capture_output=True)
        os.chmod(key, 0o600)


def cert_fp(der):
    return hashlib.sha256(der).hexdigest()


class State:
    """This device's key material, kept in one private directory."""

    def __init__(self, directory):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cert, self.key = self.dir / 'cert.pem', self.dir / 'key.pem'
        if not (self.cert.exists() and self.key.exists()):
            _make_cert(self.cert, self.key)
        self.fp = cert_fp(ssl.PEM_cert_to_DER_cert(self.cert.read_text()))

    @property
    def token(self):
        f = self.dir / 'token'
        if not f.exists():
            _write_secret(f, secrets.token_urlsafe(24))
        return f.read_text().strip()

    def reset_token(self):
        _write_secret(self.dir / 'token', secrets.token_urlsafe(24))


def sas(fp, nonce_h, nonce_d):
    """The 6-digit number both screens show. Binds the device's cert to both nonces."""
    return f"{int(hashlib.sha256((fp + nonce_h + nonce_d).encode()).hexdigest(), 16) % 1_000_000:06d}"


# ─── Device side: HTTPS report + pairing, UDP discovery ──────────
DISCOVERY_MSG = b'DECLOUD-LAB?'
PAIR_TTL = 120


class LabServer:
    """approve(hub_name, number) -> bool is called (it may block, e.g. waiting
    for a click or a y/N in the terminal) when a hub asks to pair."""

    def __init__(self, state, name, report_fn, approve, host='0.0.0.0', port=AGENT_PORT, kind='decloud'):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        self.state, self.name, self.kind = state, name, kind
        sessions, lock, approve_lock = {}, threading.Lock(), threading.Lock()
        srv = self

        class H(BaseHTTPRequestHandler):
            def _send(self, code, obj):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path != '/api/lab/report':
                    return self._send(404, {'error': 'not found'})
                if not hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {state.token}'):
                    return self._send(401, {'error': 'bad key'})
                self._send(200, report_fn())

            def do_POST(self):
                n = int(self.headers.get('Content-Length') or 0)
                try:
                    data = json.loads(self.rfile.read(min(n, 4096)) or b'{}')
                    assert isinstance(data, dict)
                except Exception:
                    return self._send(400, {'error': 'bad request'})
                now = time.time()
                with lock:
                    for k in [k for k, v in sessions.items() if now - v['t'] > PAIR_TTL]:
                        sessions.pop(k)
                    if self.path == '/pair/start':
                        commit = str(data.get('commit', ''))
                        if len(sessions) >= 3:
                            return self._send(429, {'error': 'busy, try again in a minute'})
                        if not re.fullmatch(r'[0-9a-f]{64}', commit):
                            return self._send(400, {'error': 'bad request'})
                        sid, nd = secrets.token_hex(8), secrets.token_hex(16)
                        sessions[sid] = {'t': now, 'commit': commit, 'nd': nd, 'hub': str(data.get('hub') or 'A hub')[:40]}
                        return self._send(200, {'session': sid, 'nonce': nd, 'name': srv.name, 'kind': srv.kind})
                    if self.path != '/pair/finish':
                        return self._send(404, {'error': 'not found'})
                    s = sessions.pop(str(data.get('session')), None)
                nh = str(data.get('nonce_h', ''))
                if not s or not hmac.compare_digest(hashlib.sha256(nh.encode()).hexdigest(), s['commit']):
                    return self._send(403, {'error': 'pairing expired or tampered with'})
                with approve_lock:  # one prompt at a time
                    ok = approve(s['hub'], sas(state.fp, nh, s['nd']))
                if not ok:
                    return self._send(403, {'error': 'denied on the device'})
                self._send(200, {'token': state.token})

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer((host, port), H)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(state.cert, state.key)
        self.httpd.socket = ctx.wrap_socket(self.httpd.socket, server_side=True)
        self.port = self.httpd.server_address[1]
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.udp.bind((host, self.port))
        except OSError:
            self.udp = None  # discovery is a convenience; pairing codes still work

    def _answer_discovery(self):
        while self.udp:
            try:
                data, addr = self.udp.recvfrom(64)
                if data == DISCOVERY_MSG:
                    self.udp.sendto(json.dumps({'name': self.name, 'port': self.port, 'kind': self.kind,
                                                'fp': self.state.fp}).encode(), addr)
            except OSError:
                return

    def start(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        threading.Thread(target=self._answer_discovery, daemon=True).start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        if self.udp:
            u, self.udp = self.udp, None
            u.close()


# ─── Hub side: discover, pair, fetch (always pinned) ─────────────
class PinError(Exception):
    pass


def _https(url, fp, method='GET', path='/', body=None, token=None, timeout=6):
    u = urllib.parse.urlsplit(url)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # trust comes from the pinned fingerprint below, not a CA
    conn = http.client.HTTPSConnection(u.hostname, u.port or 443, context=ctx, timeout=timeout)
    try:
        conn.connect()
        seen = cert_fp(conn.sock.getpeercert(binary_form=True))
        if fp and not hmac.compare_digest(seen, fp):
            raise PinError('This device presented a different certificate than when it was added')
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        r = conn.getresponse()
        raw = r.read(2_000_000)
        try:
            data = json.loads(raw or b'null')
        except ValueError:
            data = None
        return r.status, data, seen
    finally:
        conn.close()


def fetch_report(url, token, fp):
    status, data, _ = _https(url, fp, path='/api/lab/report', token=token)
    if status == 401:
        raise PermissionError('Key rejected')
    if status != 200 or not isinstance(data, dict):
        raise OSError(f'HTTP {status}')
    return data


def discover(timeout=1.5, port=AGENT_PORT):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.3)
    found, end = {}, time.time() + timeout
    try:
        for target in ('255.255.255.255', '127.0.0.1'):
            try:
                s.sendto(DISCOVERY_MSG, (target, port))
            except OSError:
                pass  # e.g. no broadcast route; still try the rest
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(2048)
                d = json.loads(data)
                fp = str(d.get('fp', ''))
                if re.fullmatch(r'[0-9a-f]{64}', fp) and fp not in found:
                    found[fp] = {'name': str(d.get('name', ''))[:40], 'kind': 'agent' if d.get('kind') == 'agent' else 'decloud',
                                 'ip': ip, 'port': int(d.get('port') or port), 'fp': fp}
            except (socket.timeout, ValueError, TypeError):
                pass
    except OSError:
        pass
    finally:
        s.close()
    return list(found.values())


def pair_start(url, hub_name):
    """Step 1. Returns the job dict incl. the number to show on the hub. The
    hub commits to its nonce before seeing the device's, so nobody in the
    middle can steer both numbers to match."""
    nh = secrets.token_hex(16)
    status, d, seen = _https(url, None, 'POST', '/pair/start',
                             {'commit': hashlib.sha256(nh.encode()).hexdigest(), 'hub': hub_name})
    if status != 200 or not isinstance(d, dict) or not re.fullmatch(r'[0-9a-f]{32}', str(d.get('nonce', ''))):
        raise OSError((d or {}).get('error') if isinstance(d, dict) else f'HTTP {status}')
    return {'url': url, 'fp': seen, 'nh': nh, 'session': str(d.get('session')), 'name': str(d.get('name', ''))[:40],
            'kind': 'agent' if d.get('kind') == 'agent' else 'decloud', 'number': sas(seen, nh, d['nonce'])}


def pair_finish(job):
    """Step 2. Blocks until the person answers on the device. Returns the token."""
    status, d, _ = _https(job['url'], job['fp'], 'POST', '/pair/finish',
                          {'session': job['session'], 'nonce_h': job['nh']}, timeout=PAIR_TTL + 30)
    if status != 200 or not isinstance(d, dict) or not d.get('token'):
        raise PermissionError((d or {}).get('error', 'Pairing failed') if isinstance(d, dict) else 'Pairing failed')
    return str(d['token'])


# ─── Manual fallback: one pasteable code (remote / Tailscale) ────
def pairing_code(url, token, name, fp):
    raw = json.dumps({'u': url, 't': token, 'n': name, 'f': fp}, separators=(',', ':')).encode()
    return 'dcl1.' + base64.urlsafe_b64encode(raw).decode().rstrip('=')


def parse_pairing_code(code):
    """Returns {'u','t','n','f'} or raises ValueError."""
    code = (code or '').strip()
    if not code.startswith('dcl1.'):
        raise ValueError('That is not a DeCloud pairing code (it should start with dcl1.)')
    body = code[5:]
    try:
        d = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
    except Exception:
        raise ValueError('Pairing code is damaged — copy it again')
    if (not isinstance(d, dict) or not re.match(r'^https://[^\s/]+', str(d.get('u', ''))) or not d.get('t')
            or not re.fullmatch(r'[0-9a-f]{64}', str(d.get('f', '')))):
        raise ValueError('Pairing code is missing the address, key or fingerprint')
    return {'u': str(d['u']).rstrip('/'), 't': str(d['t']), 'n': str(d.get('n') or '')[:40], 'f': d['f']}


# ─── Standalone agent ────────────────────────────────────────────
def _agent_main(argv):
    cfg = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'decloud-agent'
    state = State(cfg)
    port = int(os.environ.get('DECLOUD_AGENT_PORT', AGENT_PORT))
    svc = [s for s in os.environ.get('DECLOUD_LAB_SERVICES', '').replace(',', ' ').split() if s]
    name = platform.node()
    report_fn = lambda: report(svc, kind='agent')
    pairing = '--pair' in argv or '--install-service' in argv

    if not pairing:  # service mode: serve forever, never approve (no one to ask)
        def refuse(hub, number):
            print(f'Pairing request from "{hub}" ignored. To add a hub, run: python3 {Path(__file__).resolve()} --pair', flush=True)
            return False
        LabServer(state, name, report_fn, refuse, port=port, kind='agent').start()
        print(f'DeCloud agent "{name}" serving on port {port}', flush=True)
        threading.Event().wait()

    has_systemd = shutil.which('systemctl') is not None
    was_running = has_systemd and subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'decloud-agent']).returncode == 0
    if was_running:
        subprocess.run(['systemctl', '--user', 'stop', 'decloud-agent'])

    paired = threading.Event()

    def ask(hub, number):
        print(f'\n"{hub}" wants to add this computer to its lab.')
        ok = input(f'Does "{hub}" show {number[:3]} {number[3:]}? Type y to allow: ').strip().lower() in ('y', 'yes')
        print('Allowed. You can close this when you are done.' if ok else 'Denied.')
        if ok:
            paired.set()
        return ok

    srv = LabServer(state, name, report_fn, ask, port=port, kind='agent').start()
    code = pairing_code(f'https://{lan_ip()}:{port}', state.token, name, state.fp)
    print(f'\nThis computer ("{name}") is ready to be added.\n'
          f'On your DeCloud hub: open Lab → Devices → Find devices, then tap Add next to "{name}".\n'
          f'(Not on the same network? Paste this code instead:\n  {code} )\n\nWaiting… press Ctrl+C to skip.')
    try:
        while not paired.wait(0.5):
            pass
        time.sleep(1)  # let the response reach the hub
    except KeyboardInterrupt:
        print('\nSkipped pairing.')
    srv.stop()

    if '--install-service' in argv and has_systemd:
        unit_dir = Path.home() / '.config/systemd/user'
        unit_dir.mkdir(parents=True, exist_ok=True)
        (unit_dir / 'decloud-agent.service').write_text(
            '[Unit]\nDescription=DeCloud lab agent\nAfter=network-online.target\n\n'
            f'[Service]\nExecStart={sys.executable} {Path(__file__).resolve()}\nRestart=always\n'
            f'Environment=DECLOUD_AGENT_PORT={port}\nEnvironment=DECLOUD_LAB_SERVICES={",".join(svc)}\n\n'
            '[Install]\nWantedBy=default.target\n')
        subprocess.run(['systemctl', '--user', 'daemon-reload'])
        subprocess.run(['systemctl', '--user', 'enable', '--now', 'decloud-agent'])
        subprocess.run(['loginctl', 'enable-linger', os.environ.get('USER', '')], capture_output=True)
        print('Installed: the agent now starts on boot.')
    elif '--install-service' in argv:
        print(f'No systemd here: keep it running with your process manager:\n  python3 {Path(__file__).resolve()}')
    elif was_running:
        subprocess.run(['systemctl', '--user', 'start', 'decloud-agent'])


if __name__ == '__main__':
    _agent_main(sys.argv[1:])
