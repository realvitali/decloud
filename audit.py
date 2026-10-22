"""Append-only audit trail (JSON lines): logins, terminal unlocks, destructive file actions.

Small on purpose: one file, capped at ~1 MB (the previous 1 MB is kept as audit.log.1), mode 0600.
Passwords, codes and tokens are never written here."""
import json, os, threading, time
from pathlib import Path

_LOCK = threading.Lock()
_MAX_BYTES = 1_000_000


def _path():
    return Path(os.environ.get('DECLOUD_AUDIT_FILE') or Path(__file__).resolve().parent / 'audit.log')


def _who():
    try:
        from flask import request, has_request_context
        if has_request_context():
            return request.remote_addr or '', (request.headers.get('User-Agent') or '')[:160]
    except Exception:
        pass
    return '', ''


def log(kind, detail='', ok=True):
    ip, ua = _who()
    row = {'ts': int(time.time()), 'kind': kind, 'ok': bool(ok), 'detail': str(detail)[:300], 'ip': ip, 'ua': ua}
    line = json.dumps(row, ensure_ascii=False) + '\n'
    p = _path()
    try:
        with _LOCK:
            try:
                if p.exists() and p.stat().st_size > _MAX_BYTES:
                    os.replace(p, p.with_name(p.name + '.1'))
            except OSError:
                pass
            fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, line.encode('utf-8'))
            finally:
                os.close(fd)
    except OSError:
        pass          # the audit trail must never break a request


GROUPS = {
    'auth': ('login_ok', 'login_fail', 'logout', 'password_changed'),
    'terminal': ('totp_ok', 'totp_fail', 'totp_locked', 'terminal_open', 'terminal_denied'),
    'files': ('file_trash', 'file_poof', 'file_shred', 'file_done'),
    'system': ('server_start',),
}


def read(group='', limit=200):
    kinds = GROUPS.get(group)
    p = _path()
    rows = []
    for f in (p.with_name(p.name + '.1'), p):
        try:
            with open(f, encoding='utf-8') as fh:
                for line in fh:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if group == 'alerts':
                        if r.get('ok'):
                            continue
                    elif kinds and r.get('kind') not in kinds:
                        continue
                    rows.append(r)
        except OSError:
            continue
    return rows[-limit:][::-1]
