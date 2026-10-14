"""Terminal command and interactive PTY WebSocket route."""
from flask import Blueprint, jsonify, request
from shared import limiter, ws_is_authenticated
import os, json, subprocess, threading, time

# POSIX-only imports for the PTY terminal (Windows gets a clean error)
try:
    import pty as _pty
    import select as _select
    import struct as _struct
    import fcntl as _fcntl
    import termios as _termios
    import signal as _signal
    _PTY_AVAILABLE = True
except (ImportError, OSError):
    _PTY_AVAILABLE = False

bp = Blueprint('terminal', __name__)

# ─── Quick commands ────────────────────────────────────────────────
# Each entry: (command string the user types, argv to execute, max output
# lines). Executed WITHOUT a shell — argv lists only. Piped/glob forms are
# replaced by capped equivalents so nothing ever goes through /bin/sh.
_ALLOWED_COMMANDS = {
    # Filesystem
    'ls': (['ls'], 100),
    'ls -la': (['ls', '-la'], 100),
    'ls -lh': (['ls', '-lh'], 100),
    'ls -lAh': (['ls', '-lAh'], 100),
    'pwd': (['pwd'], 10),
    'tree': (['tree'], 200),
    'tree -L 2': (['tree', '-L', '2'], 200),
    'find . -maxdepth 2': (['find', '.', '-maxdepth', '2'], 200),
    'stat *': ('STAT_CWD', 100),        # python-native: stat each cwd entry
    'file *': ('FILE_CWD', 100),        # python-native: file type each entry
    # System info
    'uptime': (['uptime'], 10),
    'whoami': (['whoami'], 10),
    'hostname': (['hostname'], 10),
    'hostname -I': (['hostname', '-I'], 10),
    'date': (['date'], 10),
    'cal': (['cal'], 30),
    'uname -a': (['uname', '-a'], 10),
    'cat /etc/os-release': (['cat', '/etc/os-release'], 40),
    'arch': (['uname', '-m'], 10),
    # Resource usage
    'free -h': (['free', '-h'], 10),
    'df -h': (['df', '-h'], 30),
    'df -hT': (['df', '-hT'], 30),
    'du -sh .': (['du', '-sh', '.'], 10),
    'du -sh *': ('DU_CWD', 100),        # python-native: du per cwd entry
    'top -bn1 | head -20': (['top', '-bn1'], 20),
    'ps aux | head -20': (['ps', 'aux'], 20),
    'ps aux --sort=-%cpu | head -10': (['ps', 'aux', '--sort=-%cpu'], 10),
    # Network
    'tailscale status': (['tailscale', 'status'], 30),
    'tailscale ip': (['tailscale', 'ip'], 10),
    'tailscale netcheck': (['tailscale', 'netcheck'], 30),
    'ip a': (['ip', 'a'], 50),
    'ip addr': (['ip', 'addr'], 50),
    'ip route': (['ip', 'route'], 20),
    'ss -tuln': (['ss', '-tuln'], 30),
    'netstat -tuln': (['netstat', '-tuln'], 30),
    'cat /etc/hosts': (['cat', '/etc/hosts'], 30),
    'cat /etc/hostname': (['cat', '/etc/hostname'], 10),
    # Users
    'who': (['who'], 30),
    'last': (['last'], 30),
    'lastlog': (['lastlog'], 30),
    # Systemd / services
    'systemctl list-units --type=service --state=running': (
        ['systemctl', 'list-units', '--type=service', '--state=running'], 50),
    'systemctl status *': (['systemctl', 'status'], 30),
    'systemctl --failed': (['systemctl', '--failed'], 30),
    'journalctl -n 20 --no-pager': (['journalctl', '-n', '20', '--no-pager'], 20),
    # GPU
    'nvidia-smi': (['nvidia-smi'], 40),
    # Misc
    'neofetch': (['neofetch'], 50),
    'fortune': (['fortune'], 10),
    'cowsay hello': (['cowsay', 'hello'], 10),
}

def _truncate_lines(text: str, max_lines: int) -> str:
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    return '\n'.join(lines[:max_lines]) + f'\n… truncated ({len(lines) - max_lines} more lines)'

def _native_stat_cwd() -> str:
    """Python-native `stat *` — no shell, no subprocess."""
    rows = []
    try:
        for entry in os.scandir('.'):
            try:
                st = entry.stat()
                rows.append(f"{st.st_mode & 0o777:o} {st.st_uid}:{st.st_gid} "
                            f"{st.st_size:>10} {entry.name}")
            except OSError:
                rows.append(f"??? {entry.name}")
    except OSError as e:
        return f"stat error: {e}"
    return '\n'.join(sorted(rows))

def _native_file_cwd() -> str:
    """Python-native `file *` — no shell, no subprocess."""
    import mimetypes
    rows = []
    try:
        for entry in sorted(os.scandir('.'), key=lambda e: e.name):
            if entry.is_dir():
                rows.append(f"{entry.name}: directory")
                continue
            try:
                with open(entry.path, 'rb') as f:
                    head = f.read(512)
                if b'\x00' in head:
                    kind = 'binary data'
                else:
                    kind = 'text/plain'
                mime = mimetypes.guess_type(entry.name)[0]
                rows.append(f"{entry.name}: {mime or kind}")
            except OSError:
                rows.append(f"{entry.name}: unreadable")
    except OSError as e:
        return f"file error: {e}"
    return '\n'.join(rows)

def _native_du_cwd() -> str:
    """Python-native `du -sh *` — no shell, no subprocess."""
    rows = []
    try:
        for entry in sorted(os.scandir('.'), key=lambda e: e.name):
            total = 0
            if entry.is_dir(follow_symlinks=False):
                for root, dirs, files in os.walk(entry.path):
                    for name in files:
                        try:
                            total += os.lstat(os.path.join(root, name)).st_size
                        except OSError:
                            pass
            else:
                try:
                    total = entry.stat().st_size
                except OSError:
                    pass
            rows.append(f"{total / (1024 * 1024):8.1f}M  {entry.name}")
    except OSError as e:
        return f"du error: {e}"
    return '\n'.join(rows)

@bp.route('/api/command', methods=['POST'])
@limiter.limit("30 per minute")
def run_command():
    """Run one allowlisted diagnostic command. No shell involved — every
    entry is a fixed argv list executed with shell=False."""
    data = request.get_json(silent=True) or {}
    cmd = (data.get('command') or '').strip()

    if cmd not in _ALLOWED_COMMANDS:
        return jsonify({'error': 'Command not in whitelist'}), 403

    target, max_lines = _ALLOWED_COMMANDS[cmd]

    try:
        if target == 'STAT_CWD':
            return jsonify({'output': _native_stat_cwd(), 'error': ''})
        if target == 'FILE_CWD':
            return jsonify({'output': _native_file_cwd(), 'error': ''})
        if target == 'DU_CWD':
            return jsonify({'output': _native_du_cwd(), 'error': ''})

        result = subprocess.run(
            target, shell=False, capture_output=True, text=True, timeout=10)
        output = _truncate_lines(result.stdout or '', max_lines)
        error = _truncate_lines(result.stderr or '', max_lines)
        return jsonify({'output': output, 'error': error})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Command timed out'}), 408
    except FileNotFoundError:
        return jsonify({'error': 'Command not available on this system'}), 503
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── Full interactive PTY terminal via WebSocket ─────────────────────────

def register(sock):
    @sock.route('/api/terminal/ws')
    def terminal_ws(ws):
        """Full interactive PTY terminal over WebSocket.

        Authentication is checked HERE because Flask's before_request
        hooks never run for WebSocket upgrades."""
        if not ws_is_authenticated(getattr(ws, 'environ', {})):
            try:
                ws.send(json.dumps({'type': 'error', 'error': 'Authentication required'}))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return

        if not _PTY_AVAILABLE:
            # Windows (or exotic platform) — PTY shells are POSIX-only
            try:
                ws.send(json.dumps({
                    'type': 'error',
                    'error': 'Interactive terminal is not supported on this OS '
                             '(requires a POSIX platform: Linux or macOS).',
                }))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return

        # Build everything BEFORE forking: this is a threaded process, so
        # the child must do nothing but exec (no allocation, no locks).
        env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor',
                   LANG='en_US.UTF-8', LC_ALL='en_US.UTF-8')
        # ponytail: pty.fork's child still runs a few lines of Python before
        # exec; a C-level spawn would need a controlling-tty helper per OS.
        pid, master_fd = _pty.fork()  # child: setsid + slave PTY as stdio
        if pid == 0:
            try:
                os.execve('/bin/bash', ['/bin/bash', '--login'], env)
            except OSError:
                try:
                    os.execve('/bin/sh', ['/bin/sh'], env)
                except OSError:
                    pass
            os._exit(127)  # never fall back into the Flask app

        _set_winsize(master_fd, 24, 80)  # frontend sends the real size
        stop = threading.Event()

        def pty_to_ws():
            """Read from PTY master, send to WebSocket. Never closes the fd —
            the handler below is its only owner."""
            try:
                while not stop.is_set():
                    ready, _, _ = _select.select([master_fd], [], [], 0.1)
                    if not ready:
                        continue
                    try:
                        data = os.read(master_fd, 65536)
                    except OSError:
                        data = b''  # EIO: the shell exited
                    if not data:
                        ws.send(json.dumps({'type': 'exit'}))
                        ws.close()
                        return
                    ws.send(data.decode('utf-8', errors='replace'))
            except Exception:
                pass

        reader = threading.Thread(target=pty_to_ws, daemon=True)
        reader.start()
        try:
            while True:
                msg = ws.receive()
                if msg is None:
                    break
                try:
                    data = json.loads(msg)
                except (json.JSONDecodeError, TypeError):
                    data = None
                if isinstance(data, dict) and data.get('type') == 'resize':
                    _set_winsize(master_fd, data.get('rows', 24), data.get('cols', 80))
                elif isinstance(data, dict) and data.get('type') == 'input':
                    os.write(master_fd, str(data.get('data', '')).encode('utf-8'))
                else:
                    os.write(master_fd, msg.encode('utf-8'))  # raw input (backward compat)
        except Exception:
            pass
        finally:
            stop.set()
            reader.join(timeout=2)
            _end_shell(pid, master_fd)


def _set_winsize(fd, rows, cols):
    try:
        _fcntl.ioctl(fd, _termios.TIOCSWINSZ, _struct.pack('HHHH', int(rows), int(cols), 0, 0))
    except Exception:
        pass


def _end_shell(pid, master_fd, grace=2.0):
    """Hang up the shell's session (interactive bash ignores SIGTERM but
    exits on SIGHUP), give it `grace` seconds, then SIGKILL. Always reaps
    the child and closes the master fd exactly once."""
    try:
        os.killpg(pid, _signal.SIGHUP)
    except OSError:
        pass
    try:
        os.close(master_fd)
    except OSError:
        pass
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                return
        except ChildProcessError:
            return
        time.sleep(0.05)
    try:
        os.killpg(pid, _signal.SIGKILL)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
