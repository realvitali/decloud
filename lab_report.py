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
  * the token a hub receives unlocks only: the stats report, a short list of
    safe actions (restart a running container, unload a loaded model) and a
    relay to this device's own Ollama API (chat, pull, list, delete models).
    No shell, no files, no reboot.
  * code updates install only when signed with a key pinned in this file
    (RELEASE_SIGNERS) and the owner allowed updates on this device
  * in service mode nobody can pair (/pair/start answers 409); re-run with
    --pair at the device to add another hub

Standalone needs only Python 3.8+ and psutil (apt install python3-psutil).
Keep this file free of DeCloud imports so it can be copied anywhere.
"""
import base64
import hashlib
import hmac
import http.client
import ipaddress
import glob
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
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import psutil

AGENT_PORT = 8898
AGENT_VERSION = 6  # bump when the hub needs a newer agent on its nodes

# Signed updates. An update is installed only if its release record is signed by
# one of these keys (OpenSSH "allowed signers" lines for the principal
# "decloud-release"). The private key never leaves the maintainer's machine
# (scripts/sign_release.py), so neither a hub, GitHub nor CI can push code.
RELEASE_SIGNERS = ''
SIG_NAMESPACE = 'decloud-release'
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
        num = lambda s: float(s) if re.fullmatch(r'[\d.]+', s) else None
        held = {}  # GPU uuid -> MiB held by running programs (works on unified-memory chips too)
        for line in _run(['nvidia-smi', '--query-compute-apps=gpu_uuid,used_memory', '--format=csv,noheader,nounits'], 4).splitlines():
            p = [s.strip() for s in line.split(',')]
            if len(p) == 2 and num(p[1]) is not None:
                held[p[0]] = held.get(p[0], 0) + num(p[1])
        q = _run(['nvidia-smi', '--query-gpu=name,memory.total,utilization.gpu,temperature.gpu,uuid,memory.used',
                  '--format=csv,noheader,nounits'], 4)
        for line in q.strip().splitlines():
            p = [s.strip() for s in line.split(',')]
            if len(p) == 6:
                vram, used = num(p[1]), num(p[5])  # memory.used is [N/A] on unified-memory chips
                out.append({'name': p[0], 'vram_gb': round(vram / 1024, 1) if vram else None,
                            'util': num(p[2]), 'temp': num(p[3]),
                            'mem_used_gb': round((used if used is not None else held.get(p[4], 0)) / 1024, 1)})
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


DEVICE_TYPES = ('spark', 'dgx', 'desktop', 'laptop', 'mini', 'server', 'pi', 'mac', 'macbook', 'vm', 'computer')
_CHASSIS = {3: 'desktop', 4: 'desktop', 5: 'desktop', 6: 'desktop', 7: 'desktop', 13: 'desktop', 15: 'desktop', 16: 'desktop',
            24: 'desktop', 8: 'laptop', 9: 'laptop', 10: 'laptop', 14: 'laptop', 31: 'laptop', 32: 'laptop', 30: 'laptop',
            35: 'mini', 36: 'mini', 17: 'server', 23: 'server', 25: 'server', 28: 'server', 29: 'server'}


def verify_release(manifest, sig, signers=None):
    """Check a release record against the pinned keys; return it as a dict.
    Raises ValueError when anything is off. Uses ssh-keygen (OpenSSH 8.1+)."""
    signers = RELEASE_SIGNERS if signers is None else signers
    if not signers.strip():
        raise ValueError('Signed updates are not set up yet.')
    tool = shutil.which('ssh-keygen')
    if not tool:
        raise ValueError('ssh-keygen is missing, so updates cannot be checked. Install openssh-client.')
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        allowed, sigf = Path(d, 'allowed'), Path(d, 'sig')
        allowed.write_text(signers if signers.endswith('\n') else signers + '\n')
        sigf.write_bytes(sig)
        r = subprocess.run([tool, '-Y', 'verify', '-f', str(allowed), '-I', 'decloud-release', '-n', SIG_NAMESPACE, '-s', str(sigf)],
                           input=manifest, capture_output=True, timeout=20)
    if r.returncode != 0:
        raise ValueError('The update is not signed by DeCloud.')
    m = json.loads(manifest)
    if not (isinstance(m, dict) and re.fullmatch(r'v\d+\.\d+\.\d+', str(m.get('version', '')))
            and re.fullmatch(r'[0-9a-f]{40}', str(m.get('commit', ''))) and re.fullmatch(r'[0-9a-f]{64}', str(m.get('agent_sha256', '')))
            and isinstance(m.get('agent_version'), int)):
        raise ValueError('The release record is malformed.')
    return m


def apply_update(state, agent, manifest, sig, here=None, restart=None):
    """Install a signed agent update: verify, self-test, keep the old copy, swap,
    then exit so systemd starts the new one. The boot guard rolls back if it won't start."""
    if not state.auto_update:
        raise ValueError('Updates are turned off on this device.')
    if not os.environ.get('INVOCATION_ID') and restart is None:
        raise ValueError('This agent is not running as a service. Run the setup command on it instead.')
    # Only releases signed with a pinned key. Without one, an update from the hub would let
    # anyone holding this device's token run code here, so updates stay off.
    m = verify_release(manifest, sig)
    if hashlib.sha256(agent).hexdigest() != m['agent_sha256']:
        raise ValueError('The file does not match the signed release.')
    if m['agent_version'] <= AGENT_VERSION:
        raise ValueError('Already up to date.')
    here = Path(here or __file__).resolve()
    new, prev = here.with_name(here.name + '.new'), here.with_name(here.name + '.prev')
    new.write_bytes(agent)
    try:
        test = subprocess.run([sys.executable, str(new), '--self-test'], capture_output=True, timeout=60)
        ok = test.returncode == 0
    except subprocess.TimeoutExpired:
        ok = False
    if not ok:
        new.unlink(missing_ok=True)
        raise ValueError('The new version failed its self-test, so nothing changed.')
    shutil.copy2(here, prev)
    (state.dir / 'update.json').write_text(json.dumps({'from': AGENT_VERSION, 'to': m['agent_version'], 'boots': 0}))
    os.replace(new, here)
    (restart or (lambda: threading.Timer(1.0, lambda: os._exit(0)).start()))()
    return f'Updating to agent version {m["agent_version"]}.'


def boot_guard(state, argv, here=None):
    """Runs first on every service start. A fresh update that keeps failing to
    come up (systemd restarts it) is swapped back for the previous version."""
    here = Path(here or __file__).resolve()
    marker, prev = state.dir / 'update.json', here.with_name(here.name + '.prev')
    if not marker.exists():
        return
    try:
        info = json.loads(marker.read_text())
    except ValueError:
        info = {}
    info['boots'] = int(info.get('boots', 0)) + 1
    if info['boots'] > 3 and prev.exists():
        os.replace(prev, here)
        marker.unlink(missing_ok=True)
        print('The updated agent kept failing to start, so the previous version was restored.', flush=True)
        os.execv(sys.executable, [sys.executable, str(here), *argv])
        return
    marker.write_text(json.dumps(info))
    threading.Timer(90, lambda: marker.unlink(missing_ok=True)).start()   # up and healthy: the update is good


def _read(path):
    try:
        return Path(path).read_text(errors='replace').replace('\x00', '').strip()
    except OSError:
        return ''


def device_kind():
    """{'type': one of DEVICE_TYPES, 'model': short marketing name or ''}: lets
    the hub draw a DGX Spark as a Spark and a laptop as a laptop."""
    if platform.system() == 'Darwin':
        model = _run(['sysctl', '-n', 'hw.model'], 2).strip()
        return {'type': 'macbook' if 'book' in model.lower() else 'mac', 'model': model[:60]}
    dmi = lambda f: _read(f'/sys/class/dmi/id/{f}')
    product, family, vendor = dmi('product_name'), dmi('product_family'), dmi('sys_vendor')
    ident = f'{vendor} {product} {family}'.lower()
    if 'dgx spark' in ident.replace('_', ' '):
        return {'type': 'spark', 'model': 'NVIDIA DGX Spark'}
    if 'dgx' in ident:
        return {'type': 'dgx', 'model': ('NVIDIA ' + (family or product).replace('_', ' ')).strip()[:60]}
    pi = _read('/proc/device-tree/model')
    if 'raspberry pi' in pi.lower():
        return {'type': 'pi', 'model': pi[:60]}
    if any(v in ident for v in ('qemu', 'kvm', 'vmware', 'virtualbox', 'virtual machine', 'hvm domu', 'bochs')):
        return {'type': 'vm', 'model': 'Virtual machine'}
    try:
        chassis = int(dmi('chassis_type') or 0)
    except ValueError:
        chassis = 0
    kind = _CHASSIS.get(chassis)
    if not kind and any(n.startswith('BAT') for n in os.listdir('/sys/class/power_supply')) if os.path.isdir('/sys/class/power_supply') else False:
        kind = 'laptop'
    # Desktop "product names" are usually the motherboard; only keep real model names.
    model = '' if kind in ('desktop', None) or product.lower() in ('', 'default string', 'to be filled by o.e.m.', 'system product name') else product
    return {'type': kind or 'computer', 'model': model.replace('_', ' ')[:60]}


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


def ollama_base():
    host = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')
    if not host.startswith('http'):
        host = 'http://' + host
    host = host.rstrip('/')
    # OLLAMA_HOST=0.0.0.0 means "listen everywhere" to Ollama; connect via loopback.
    return re.sub(r'//(0\.0\.0\.0|\[::\])(?=[:/]|$)', '//127.0.0.1', host)


def _ollama_json(path, timeout=1.5):
    with urllib.request.urlopen(ollama_base() + path, timeout=timeout) as r:
        return json.load(r)


def ollama_models():
    """Names of the models loaded in memory right now."""
    try:
        return [m.get('name', '') for m in _ollama_json('/api/ps').get('models', [])]
    except Exception:
        return []


def ollama_info():
    """What this device can offer AI apps: installed + loaded Ollama models."""
    try:
        tags = _ollama_json('/api/tags', 2).get('models', [])
    except Exception:
        return {'ok': False, 'installed': [], 'loaded': []}
    try:
        ps = _ollama_json('/api/ps').get('models', [])
    except Exception:
        ps = []
    local = lambda m: not (m.get('remote_host') or m.get('remote_model') or str(m.get('name', '')).endswith((':cloud', '-cloud')))
    return {
        'ok': True,
        'installed': [{'name': str(m.get('name', '')), 'size': m.get('size', 0)} for m in tags if local(m)][:100],
        'loaded': [{'name': str(m.get('name', '')), 'size': m.get('size', 0), 'size_vram': m.get('size_vram', 0)} for m in ps][:20],
    }


# ─── Safe actions a paired hub may ask for ───────────────────────
ACTIONS = ('restart-container', 'unload-model')


def run_action(action, target):
    """Only actions that can't brick the machine, and only on things that are
    running right now. Returns a short message or raises ValueError."""
    target = str(target or '')
    if action == 'restart-container':
        names = {c['name'] for c in containers()}
        if target not in names:
            raise ValueError('That container is not running here.')
        tool = 'docker' if shutil.which('docker') else 'podman'
        r = subprocess.run([tool, 'restart', '--', target], capture_output=True, text=True, timeout=90)
        if r.returncode != 0:
            raise ValueError((r.stderr or 'Restart failed').strip()[:200])
        return f'Restarted {target}.'
    if action == 'unload-model':
        if target not in ollama_models():
            raise ValueError('That model is not loaded here.')
        req = urllib.request.Request(ollama_base() + '/api/generate', method='POST',
                                     data=json.dumps({'model': target, 'keep_alive': 0}).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=20):
            pass
        return f'Unloaded {target}.'
    raise ValueError('Unknown action.')


def services(names):
    if not names or not shutil.which('systemctl'):
        return []
    out = []
    for n in names[:20]:
        if not re.fullmatch(r'[\w@.:-]{1,80}', n):
            continue
        state = _run(['systemctl', 'is-active', '--', n], 2).strip() or 'inactive'
        out.append({'name': n, 'active': state == 'active'})
    return out


# Well-known self-hosted apps, found by process name or container image.
# key -> (process names, words in a container image)
APPS = {
    'ollama': (('ollama',), ('ollama',)),
    'docker': (('dockerd', 'podman'), ()),
    'tailscale': (('tailscaled',), ()),
    'vllm': ((), ('vllm',)),
    'open-webui': ((), ('open-webui',)),
    'comfyui': ((), ('comfyui', 'comfy-ui')),
    'jellyfin': (('jellyfin',), ('jellyfin',)),
    'plex': (('Plex Media Server', 'plexmediaserver'), ('plex',)),
    'home-assistant': (('hass',), ('home-assistant', 'homeassistant')),
    'immich': ((), ('immich',)),
    'nextcloud': ((), ('nextcloud',)),
    'pihole': (('pihole-FTL',), ('pihole',)),
    'adguard': (('AdGuardHome',), ('adguard',)),
    'syncthing': (('syncthing',), ('syncthing',)),
    'samba': (('smbd',), ('samba',)),
    'nginx': (('nginx',), ('nginx',)),
    'caddy': (('caddy',), ('caddy',)),
    'traefik': (('traefik',), ('traefik',)),
    'postgres': (('postgres',), ('postgres',)),
    'mysql': (('mysqld', 'mariadbd'), ('mysql', 'mariadb')),
    'redis': (('redis-server',), ('redis',)),
    'grafana': (('grafana', 'grafana-server'), ('grafana',)),
    'prometheus': (('prometheus',), ('prometheus',)),
    'portainer': ((), ('portainer',)),
    'qbittorrent': (('qbittorrent-nox',), ('qbittorrent',)),
    'transmission': (('transmission-daemon',), ('transmission',)),
    'minecraft': ((), ('minecraft',)),
}


def apps(proc_names, ctrs):
    """Keys of APPS that are running here, by process name or container image."""
    procs = set(proc_names)
    images = ' '.join(str(c.get('image', '')).lower() for c in ctrs)
    found = [k for k, (names, words) in APPS.items()
             if procs.intersection(names) or any(w in images for w in words)]
    if ctrs and 'docker' not in found:
        found.append('docker')
    return found


_rapl = {}  # energy counter -> (time, microjoules) from the last report


def power():
    """Watts this machine can measure about itself: {'watts', 'parts': {gpu, cpu, battery}} or None.
    NVIDIA cards report their draw; CPU energy counters count when readable (often root-only);
    a laptop on battery reports the whole system. Nothing here sees wall power."""
    parts = {}
    if shutil.which('nvidia-smi'):
        vals = [float(v) for v in _run(['nvidia-smi', '--query-gpu=power.draw', '--format=csv,noheader,nounits'], 4).split()
                if re.fullmatch(r'\d+(\.\d+)?', v)]
        if vals:
            parts['gpu'] = round(sum(vals), 1)
    for e in glob.glob('/sys/class/powercap/intel-rapl:[0-9]/energy_uj'):
        uj = _read(e)
        if not uj.isdigit():
            continue  # root-only on most systems
        now, last = time.time(), _rapl.get(e)
        _rapl[e] = (now, int(uj))
        if last and now > last[0] and int(uj) >= last[1]:
            parts['cpu'] = round(parts.get('cpu', 0) + (int(uj) - last[1]) / 1e6 / (now - last[0]), 1)
    for b in glob.glob('/sys/class/power_supply/BAT*'):
        uw = _read(b + '/power_now')
        if _read(b + '/status') == 'Discharging' and uw.isdigit() and int(uw) > 0:
            parts['battery'] = round(int(uw) / 1e6, 1)  # on battery: the whole laptop
    if not parts:
        return None
    return {'watts': parts['battery'] if 'battery' in parts else round(sum(parts.values()), 1), 'parts': parts}


_cpu_primed = False


def report(service_names=None, kind='decloud'):
    global _cpu_primed
    procs = list(psutil.process_iter(['name', 'memory_percent']))
    if _cpu_primed:
        cpu = psutil.cpu_percent(None)  # average since the last report, not a jumpy snapshot
    else:
        for p in procs:
            try:
                p.cpu_percent(None)  # prime per-process counters
            except Exception:
                pass
        cpu = psutil.cpu_percent(interval=0.4)
        _cpu_primed = True
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
    ctrs = containers()
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
        'agent_version': AGENT_VERSION,
        'device': device_kind(),
        'ollama': ollama_info(),
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
        'apps': apps(by_name, ctrs),
        'power': power(),
        'running': {
            'containers': ctrs,
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
        old = os.umask(0o077)   # the key file must never exist readable by others, even briefly
        try:
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                            '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '3650', '-subj', '/CN=decloud-lab'],
                           check=True, capture_output=True)
        finally:
            os.umask(old)
        os.chmod(key, 0o600)


def cert_fp(der):
    return hashlib.sha256(der).hexdigest()


class State:
    """This device's key material, kept in one private directory."""

    def __init__(self, directory):
        self.dir = Path(directory)
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)   # key, token and update consent live here
        except OSError:
            pass
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

    @property
    def auto_update(self):
        """Set only here on the device (setup prompt or --auto-update-on); a hub can't turn it on."""
        return (self.dir / 'auto-update').exists()

    def set_auto_update(self, on):
        f = self.dir / 'auto-update'
        f.write_text('on\n') if on else f.unlink(missing_ok=True)


def sas(fp, nonce_h, nonce_d):
    """The 6-digit number both screens show. Binds the device's cert to both nonces."""
    return f"{int(hashlib.sha256((fp + nonce_h + nonce_d).encode()).hexdigest(), 16) % 1_000_000:06d}"


# ─── Device side: HTTPS report + pairing, UDP discovery ──────────
DISCOVERY_MSG = b'DECLOUD-LAB?'
# Ollama calls a paired hub may relay (GET / POST). Nothing else of Ollama is reachable.
OLLAMA_GET = ('/ollama/api/tags', '/ollama/api/ps', '/ollama/api/version')
OLLAMA_POST = ('/ollama/api/chat', '/ollama/api/generate', '/ollama/api/pull', '/ollama/api/show')
OLLAMA_PROXY_TIMEOUT = 600
PAIR_TTL = 120


class LabServer:
    """approve(hub_name, number) -> bool is called (it may block, e.g. waiting
    for a click or a y/N in the terminal) when a hub asks to pair."""

    def __init__(self, state, name, report_fn, approve, host='0.0.0.0', port=AGENT_PORT, kind='decloud', updater=None):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        self.state, self.name, self.kind = state, name, kind
        sessions, lock, approve_lock = {}, threading.Lock(), threading.Lock()
        srv = self

        class H(BaseHTTPRequestHandler):
            timeout = 10  # an idle/slow client can't pin a handler thread

            def setup(self):
                # TLS handshake here, in the handler thread (with the timeout
                # above) — not in accept() on the serve thread, where one idle
                # connection would freeze the whole lab server.
                self.request.settimeout(self.timeout)
                self.request.do_handshake()
                super().setup()

            def _send(self, code, obj):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _authed(self):
                return hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {state.token}')

            def _body(self, limit):
                n = int(self.headers.get('Content-Length') or 0)
                if not 0 <= n <= limit:
                    raise ValueError('bad length')
                return self.rfile.read(n)

            def _proxy(self, method, body=None):
                """Relay one Ollama API call to this device's own Ollama, streaming
                the answer back. Only paired hubs get here (token checked)."""
                req = urllib.request.Request(ollama_base() + self.path[len('/ollama'):], data=body, method=method,
                                             headers={'Content-Type': 'application/json'})
                try:
                    up = urllib.request.urlopen(req, timeout=OLLAMA_PROXY_TIMEOUT)
                except urllib.error.HTTPError as e:
                    up = e
                except OSError:
                    return self._send(502, {'error': 'Ollama is not running on this device.'})
                try:
                    self.send_response(getattr(up, 'status', None) or up.code)
                    self.send_header('Content-Type', up.headers.get('Content-Type') or 'application/json')
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    self.request.settimeout(OLLAMA_PROXY_TIMEOUT)
                    while True:
                        chunk = up.read1(65536) if hasattr(up, 'read1') else up.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except OSError:
                    pass  # hub hung up (Stop pressed): closing upstream stops the generation
                finally:
                    up.close()

            def do_GET(self):
                if self.path not in ('/api/lab/report',) + OLLAMA_GET:
                    return self._send(404, {'error': 'not found'})
                if not self._authed():
                    return self._send(401, {'error': 'bad key'})
                if self.path.startswith('/ollama/'):
                    return self._proxy('GET')
                self._send(200, report_fn())

            def do_DELETE(self):
                if self.path != '/ollama/api/delete':
                    return self._send(404, {'error': 'not found'})
                if not self._authed():
                    return self._send(401, {'error': 'bad key'})
                try:
                    body = self._body(4096)
                except ValueError:
                    return self._send(400, {'error': 'bad request'})
                self._proxy('DELETE', body)

            def do_POST(self):
                if self.path == '/api/lab/update' and updater:
                    if not self._authed():
                        return self._send(401, {'error': 'bad key'})
                    try:
                        data = json.loads(self._body(2_000_000) or b'{}')
                        agent = base64.b64decode(str(data['agent']), validate=True)
                        manifest, sig = str(data['manifest']).encode(), str(data['sig']).encode()
                    except Exception:
                        return self._send(400, {'error': 'bad request'})
                    try:
                        return self._send(200, {'ok': True, 'message': updater(agent, manifest, sig)})
                    except (ValueError, OSError, subprocess.SubprocessError) as e:
                        return self._send(409, {'error': str(e) or 'Update failed'})
                if self.path == '/api/lab/action' or self.path in OLLAMA_POST:
                    if not self._authed():
                        return self._send(401, {'error': 'bad key'})
                    try:
                        body = self._body(8_000_000)
                        if self.path.startswith('/ollama/'):
                            return self._proxy('POST', body)
                        data = json.loads(body or b'{}')
                        assert isinstance(data, dict)
                    except Exception:
                        return self._send(400, {'error': 'bad request'})
                    try:
                        return self._send(200, {'ok': True, 'message': run_action(data.get('action'), data.get('target'))})
                    except (ValueError, OSError, subprocess.SubprocessError) as e:
                        return self._send(400, {'error': str(e) or 'Action failed'})
                try:
                    data = json.loads(self._body(4096) or b'{}')
                    assert isinstance(data, dict)
                except Exception:
                    return self._send(400, {'error': 'bad request'})
                now = time.time()
                with lock:
                    for k in [k for k, v in sessions.items() if now - v['t'] > PAIR_TTL]:
                        sessions.pop(k)
                    if self.path == '/pair/start':
                        if approve is None:  # running as a service: nobody here to confirm a code
                            return self._send(409, {'error': 'not in pairing mode', 'code': 'NOT_PAIRING'})
                        commit = str(data.get('commit', ''))
                        if len(sessions) >= 3:
                            return self._send(429, {'error': 'busy, try again in a minute'})
                        if not re.fullmatch(r'[0-9a-f]{64}', commit):
                            return self._send(400, {'error': 'bad request'})
                        sid, nd = secrets.token_hex(8), secrets.token_hex(16)
                        sessions[sid] = {'t': now, 'commit': commit, 'nd': nd, 'hub': re.sub(r'[^\x20-\x7e]', '', str(data.get('hub') or ''))[:40] or 'A hub'}
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
        self.httpd.socket = ctx.wrap_socket(self.httpd.socket, server_side=True,
                                            do_handshake_on_connect=False)
        self.httpd.handle_error = lambda *a: None  # failed handshakes/timeouts: just drop
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


def _connect(url, fp, method, path, body=None, token=None, timeout=6, raw=False):
    """Open a pinned HTTPS request. Returns (conn, response, seen_fp); caller closes conn."""
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
        data = body if raw else (json.dumps(body) if body is not None else None)
        conn.request(method, path, body=data, headers=headers)
        return conn, conn.getresponse(), seen
    except BaseException:
        conn.close()
        raise


def _read_capped(r, limit, deadline):
    """Read a reply, but at most `limit` bytes and only until `deadline`: the socket
    timeout covers each read, so a peer trickling bytes could otherwise hold us forever."""
    out = bytearray()
    while len(out) < limit:
        if time.monotonic() > deadline:
            raise OSError('reply took too long')
        chunk = r.read1(min(65536, limit - len(out))) if hasattr(r, 'read1') else r.read(min(65536, limit - len(out)))
        if not chunk:
            break
        out += chunk
    return bytes(out)


def _https(url, fp, method='GET', path='/', body=None, token=None, timeout=6):
    deadline = time.monotonic() + timeout + 2
    conn, r, seen = _connect(url, fp, method, path, body, token, timeout)
    try:
        raw = _read_capped(r, 2_000_000, deadline)
        try:
            data = json.loads(raw or b'null')
        except (ValueError, RecursionError):   # RecursionError: a peer sending '[[[[…' 100k deep
            data = None
        return r.status, data, seen
    finally:
        conn.close()


def call(url, token, fp, method, path, body=None, timeout=10):
    """One authenticated JSON call to a paired device. Returns (status, data)."""
    status, data, _ = _https(url, fp, method, path, body, token, timeout)
    if status == 401:
        raise PermissionError('Key rejected')
    return status, data


def open_stream(url, token, fp, method, path, body=None, timeout=OLLAMA_PROXY_TIMEOUT):
    """Authenticated streaming call (Ollama relay). Returns (conn, response)."""
    conn, r, _ = _connect(url, fp, method, path, body, token, timeout)
    if r.status == 401:
        conn.close()
        raise PermissionError('Key rejected')
    return conn, r


def fetch_report(url, token, fp):
    status, data, _ = _https(url, fp, path='/api/lab/report', token=token, timeout=4)
    if status == 401:
        raise PermissionError('Key rejected')
    if status != 200 or not isinstance(data, dict):
        raise OSError(f'HTTP {status}')
    return data


def _broadcast_targets():
    """Addresses to broadcast the discovery ping to.

    255.255.255.255 leaves via exactly ONE interface (usually the default
    route) — on machines with VPN/Tailscale/docker interfaces that is often
    the wrong one, so Wi-Fi discovery silently fails. Subnet-directed
    broadcasts (one per real interface, like mDNS/DHCP do) fix that.
    """
    import ipaddress
    targets = {'255.255.255.255', '127.0.0.1'}
    try:
        for _if, addrs in psutil.net_if_addrs().items():
            for a in addrs:
                if a.family != socket.AF_INET:
                    continue
                try:
                    net = ipaddress.ip_network(f'{a.address}/{a.netmask}', strict=False)
                    if not net.is_loopback:
                        targets.add(str(net.broadcast_address))
                except (ValueError, TypeError):
                    pass
    except Exception:
        pass  # psutil oddity — the plain broadcast still goes out
    return targets


def discover(timeout=2.5, port=AGENT_PORT):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.3)
    found, end = {}, time.time() + timeout
    try:
        for target in _broadcast_targets():
            try:
                s.sendto(DISCOVERY_MSG, (target, port))
            except OSError:
                pass  # e.g. no broadcast route; still try the rest
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(2048)
                d = json.loads(data)
                fp = str(d.get('fp', ''))
                p = int(d.get('port') or port)
                if re.fullmatch(r'[0-9a-f]{64}', fp) and fp not in found and 1 <= p <= 65535:
                    found[fp] = {'name': str(d.get('name', ''))[:40], 'kind': 'agent' if d.get('kind') == 'agent' else 'decloud',
                                 'ip': ip, 'port': p, 'fp': fp}
            except socket.timeout:
                pass
            except Exception:
                pass  # a junk reply (list, Infinity port, …) from someone on the LAN: ignore it
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
def tailnet_ipv4():
    """The agent must fail closed if Tailscale is unavailable."""
    try:
        result = subprocess.run(['tailscale', 'ip', '-4'], capture_output=True, text=True, timeout=5, check=True)
        for line in result.stdout.splitlines():
            ip = ipaddress.ip_address(line.strip())
            if ip.version == 4 and ip in ipaddress.ip_network('100.64.0.0/10'):
                return str(ip)
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    raise RuntimeError('Connect Tailscale on this device before starting the node.')


def _agent_main(argv):
    cfg = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'decloud-agent'
    state = State(cfg)
    port = int(os.environ.get('DECLOUD_AGENT_PORT', AGENT_PORT))
    svc = [s for s in os.environ.get('DECLOUD_LAB_SERVICES', '').replace(',', ' ').split() if s]
    name = platform.node()
    report_fn = lambda: {**report(svc, kind='agent'), 'auto_update': state.auto_update}
    if '--auto-update-on' in argv or '--auto-update-off' in argv:
        state.set_auto_update('--auto-update-on' in argv)
        print('Automatic updates are ' + ('on.' if state.auto_update else 'off.'))
        return
    pairing = '--pair' in argv or '--install-service' in argv
    tailnet_only = '--tailnet' in argv
    host = tailnet_ipv4() if tailnet_only else '0.0.0.0'

    if not pairing:  # service mode: serve forever; pairing needs someone at the terminal
        boot_guard(state, argv)
        LabServer(state, name, report_fn, None, host=host, port=port, kind='agent',
                  updater=lambda a, m, s: apply_update(state, a, m, s)).start()
        print(f'DeCloud agent "{name}" serving on {host}:{port}. To add it to another lab, run: '
              f'python3 {Path(__file__).resolve()} --pair', flush=True)
        threading.Event().wait()

    has_systemd = shutil.which('systemctl') is not None
    was_running = has_systemd and subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'decloud-agent']).returncode == 0
    if was_running:
        subprocess.run(['systemctl', '--user', 'stop', 'decloud-agent'])

    paired = threading.Event()

    def ask(hub, number):
        print(f'\n"{hub}" wants to add this computer to its lab. It will see this computer\'s stats,\n'
              'use, download and delete its Ollama AI models, and restart its running containers.\n'
              'It cannot open a shell or read files.')
        ok = input(f'Does "{hub}" show {number[:3]} {number[3:]}? Type y to allow: ').strip().lower() in ('y', 'yes')
        print('Allowed. You can close this when you are done.' if ok else 'Denied.')
        if ok:
            paired.set()
        return ok

    srv = LabServer(state, name, report_fn, ask, host=host, port=port, kind='agent').start()
    if tailnet_only:
        print(f'\nThis computer ("{name}") is ready on its Tailscale address {host}.\n'
              'Go back to DeCloud: it will find this computer by itself and show a six-digit number.\n'
              'Compare it with the number shown here before typing y.\n\nWaiting… press Ctrl+C to skip.', flush=True)
    else:
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

    if '--install-service' in argv and not state.auto_update:
        try:
            yes = input('\nInstall DeCloud agent updates on this computer automatically?\n'
                        'Only updates signed by the DeCloud release key are accepted (none are, until\n'
                        'signing is set up). Each one is tested first and rolled back if it fails. [y/N]: ').strip().lower() in ('y', 'yes')
        except EOFError:
            yes = False
        state.set_auto_update(yes)
        print('Automatic updates are on.' if yes else 'Automatic updates are off. Turn them on later with --auto-update-on.')

    if '--install-service' in argv and has_systemd:
        unit_dir = Path.home() / '.config/systemd/user'
        unit_dir.mkdir(parents=True, exist_ok=True)
        (unit_dir / 'decloud-agent.service').write_text(
            '[Unit]\nDescription=DeCloud lab agent\nAfter=network-online.target\n\n'
            f'[Service]\nExecStart="{sys.executable}" "{Path(__file__).resolve()}"{" --tailnet" if tailnet_only else ""}\nRestart=always\nRestartSec=5\n'
            f'Environment=DECLOUD_AGENT_PORT={port}\nEnvironment=DECLOUD_LAB_SERVICES={",".join(svc)}\n\n'
            '[Install]\nWantedBy=default.target\n')
        subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', '--user', 'enable', '--now', 'decloud-agent'], check=True)
        subprocess.run(['loginctl', 'enable-linger', os.environ.get('USER', '')], capture_output=True)
        print('Installed: the agent now starts on boot.')
    elif '--install-service' in argv:
        print(f'No systemd here: keep it running with your process manager:\n  python3 {Path(__file__).resolve()}')
    elif was_running:
        subprocess.run(['systemctl', '--user', 'start', 'decloud-agent'])


if __name__ == '__main__':
    if '--self-test' in sys.argv[1:]:   # run by apply_update on a downloaded version before it is trusted
        r = report(kind='agent')
        sys.exit(0 if isinstance(r, dict) and r.get('cores') else 1)
    _agent_main(sys.argv[1:])
