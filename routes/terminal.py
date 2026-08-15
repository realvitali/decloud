"""Terminal command and interactive PTY WebSocket route."""
from flask import Blueprint, jsonify, request
from shared import limiter
import os, json, subprocess, threading
import pty as _pty
import select as _select
import struct as _struct
import fcntl as _fcntl
import termios as _termios
import signal as _signal

bp = Blueprint('terminal', __name__)

@bp.route('/api/command', methods=['POST'])
@limiter.limit("30 per minute")
def run_command():
    data = request.json
    cmd = data.get('command', '').strip()

    ALLOWED = [
        # Filesystem
        'ls', 'ls -la', 'ls -lh', 'ls -lAh', 'pwd', 'tree', 'tree -L 2',
        'find . -maxdepth 2', 'stat *', 'file *',
        # System info
        'uptime', 'whoami', 'hostname', 'hostname -I', 'date', 'cal',
        'uname -a', 'cat /etc/os-release', 'arch',
        # Resource usage
        'free -h', 'df -h', 'df -hT', 'du -sh *', 'du -sh .',
        'top -bn1 | head -20', 'ps aux | head -20', 'ps aux --sort=-%cpu | head -10',
        # Network
        'tailscale status', 'tailscale ip', 'tailscale netcheck',
        'ip a', 'ip addr', 'ip route', 'ss -tuln', 'netstat -tuln',
        'cat /etc/hosts', 'cat /etc/hostname',
        # Users
        'who', 'last', 'lastlog',
        # Systemd / services
        'systemctl list-units --type=service --state=running',
        'systemctl status *', 'journalctl -n 20 --no-pager',
        # GPU
        'nvidia-smi',
        # Misc
        'neofetch', 'fortune', 'cowsay hello',
    ]

    if cmd not in ALLOWED:
        return jsonify({'error': 'Command not in whitelist'}), 403

    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
        return jsonify({'output': result.stdout, 'error': result.stderr})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Command timed out'}), 408
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── Full interactive PTY terminal via WebSocket ─────────────────────────

def register(sock):
    @sock.route('/api/terminal/ws')
    def terminal_ws(ws):
        """Full interactive PTY terminal over WebSocket.
        Spawns a real shell with proper TTY, supports ANSI colors, interactive apps
        like claude, opencode, vim, htop, etc."""
        import os as _os

        # Create a pseudo-terminal
        master_fd, slave_fd = _pty.openpty()

        # Set terminal size (80x24 default, will be updated by frontend)
        try:
            _winsize = _struct.pack('HHHH', 24, 80, 0, 0)
            _fcntl.ioctl(slave_fd, _termios.TIOCSWINSZ, _winsize)
        except Exception:
            pass

        # Fork a child process attached to the slave PTY
        pid = _os.fork()

        if pid == 0:
            # Child process
            _os.close(master_fd)
            _os.setsid()

            # Set controlling terminal
            try:
                _fcntl.ioctl(slave_fd, _termios.TIOCSCTTY, 0)
            except Exception:
                pass

            # Set up stdin/stdout/stderr to the slave PTY
            _os.dup2(slave_fd, 0)
            _os.dup2(slave_fd, 1)
            _os.dup2(slave_fd, 2)
            if slave_fd > 2:
                _os.close(slave_fd)

            # Set terminal environment
            env = dict(_os.environ)
            env['TERM'] = 'xterm-256color'
            env['COLORTERM'] = 'truecolor'
            env['LANG'] = 'en_US.UTF-8'
            env['LC_ALL'] = 'en_US.UTF-8'

            # Start the shell
            try:
                _os.execvpe('/bin/bash', ['/bin/bash', '--login'], env)
            except Exception:
                _os.execvpe('/bin/sh', ['/bin/sh'], env)
        else:
            # Parent process
            _os.close(slave_fd)

            def pty_to_ws():
                """Read from PTY master, send to WebSocket as binary."""
                try:
                    while True:
                        ready, _, _ = _select.select([master_fd], [], [], 0.1)
                        if ready:
                            try:
                                data = _os.read(master_fd, 65536)
                                if not data:
                                    break
                                ws.send(data.decode('utf-8', errors='replace'))
                            except (OSError, _os.error):
                                break
                        # Check if child is still alive
                        try:
                            wpid, _ = _os.waitpid(pid, _os.WNOHANG)
                            if wpid != 0:
                                # Child exited
                                try:
                                    remaining = _os.read(master_fd, 65536)
                                    if remaining:
                                        ws.send(remaining.decode('utf-8', errors='replace'))
                                except Exception:
                                    pass
                                ws.send(json.dumps({'type': 'exit'}))
                                break
                        except ChildProcessError:
                            ws.send(json.dumps({'type': 'exit'}))
                            break
                except Exception:
                    pass
                finally:
                    try:
                        _os.close(master_fd)
                    except Exception:
                        pass

            def ws_to_pty():
                """Read from WebSocket, write to PTY master."""
                try:
                    while True:
                        msg = ws.receive()
                        if msg is None:
                            break
                        # Check for resize commands
                        try:
                            data = json.loads(msg)
                            if data.get('type') == 'resize':
                                cols = data.get('cols', 80)
                                rows = data.get('rows', 24)
                                try:
                                    _winsize = _struct.pack('HHHH', rows, cols, 0, 0)
                                    _fcntl.ioctl(master_fd, _termios.TIOCSWINSZ, _winsize)
                                except Exception:
                                    pass
                                continue
                            elif data.get('type') == 'input':
                                _os.write(master_fd, data.get('data', '').encode('utf-8'))
                                continue
                        except (json.JSONDecodeError, TypeError):
                            pass
                        # Raw input (backward compat)
                        _os.write(master_fd, msg.encode('utf-8'))
                except Exception:
                    pass

            # Start PTY reader thread
            reader = threading.Thread(target=pty_to_ws, daemon=True)
            reader.start()

            # Handle WebSocket input (blocking)
            ws_to_pty()

            # Cleanup
            try:
                _os.kill(pid, _signal.SIGTERM)
                _os.waitpid(pid, 0)
            except Exception:
                pass
            try:
                _os.close(master_fd)
            except Exception:
                pass

            reader.join(timeout=2)
