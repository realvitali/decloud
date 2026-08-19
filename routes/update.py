"""Safe self-update routes.

Design goals (the machine matters more than the feature):
  1. NEVER destroy user data — updates only move git-tracked files.
     `.env`, books, audio caches, and settings live outside the tree
     and are untouched.
  2. NEVER update a tree the user has modified by hand — a dirty
     working tree refuses the update outright.
  3. VERIFY before switching — after checkout, the new code must pass
     a syntax compile AND a live boot probe on a scratch port before
     the running app is restarted. A failed verification rolls the
     checkout back immediately and reports the error.
  4. SELF-HEAL — if the new code somehow still crashes on the real
     boot, app.py detects the fresh update marker and checks out the
     previous revision before exiting, so the service manager brings
     the OLD, working code back up.
  5. EXPLICIT — the UI shows the exact target version and release
     notes and asks for confirmation. Nothing updates silently.
"""
from flask import Blueprint, jsonify, request
from shared import app, limiter, BASE_DIR
import json
import os
import re
import subprocess
import sys
import threading
import time

bp = Blueprint('update', __name__)

# ─── Marker file: .update_meta.json in the app directory ─────────
UPDATE_META_FILE = BASE_DIR / '.update_meta.json'
ROLLBACK_WINDOW_SECONDS = 600          # 10 min after an update, boot failures trigger auto-rollback
MARKER_CLEAR_AFTER_SECONDS = 120       # after this much healthy uptime, the update is considered good

# Only one update/rollback may run at a time
_update_lock = threading.Lock()

# Valid target refs: short tag-like names only (defense in depth —
# the value is only ever passed to git as a single argv entry, but a
# whitelist costs nothing and prevents exotic refs)
_REF_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')

# Cache for the remote "latest version" lookup (10 minutes)
_latest_cache = {'ts': 0.0, 'data': None}

GITHUB_RELEASES_URL = 'https://api.github.com/repos/realvitali/decloud/releases/latest'
GITHUB_TAGS_URL = 'https://api.github.com/repos/realvitali/decloud/tags'

# ─── Git helpers (separate functions so tests can patch them) ─────

def _git(*args, timeout=60):
    """Run a git command in BASE_DIR; returns (ok, stdout_text)."""
    try:
        proc = subprocess.run(
            ['git', *args], cwd=str(BASE_DIR),
            capture_output=True, text=True, timeout=timeout,
        )
        return proc.returncode == 0, (proc.stdout or '').strip()
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)

def _git_available() -> bool:
    ok, out = _git('rev-parse', '--is-inside-work-tree', timeout=15)
    return ok and out == 'true'

def _tree_clean() -> bool:
    ok, out = _git('status', '--porcelain', timeout=15)
    if not ok:
        return False
    # Ignore our own update marker: after a rollback to an OLDER release
    # whose .gitignore predates it, the marker shows up as an untracked
    # file and would wrongly block the next update.
    lines = [ln for ln in out.splitlines()
             if '.update_meta.json' not in ln]
    return not lines

def _head_sha() -> str:
    ok, out = _git('rev-parse', 'HEAD', timeout=15)
    return out if ok else ''

def _resolve_tag_ref(ref: str) -> str:
    """Resolve a tag name to a commit SHA; empty on failure."""
    ok, out = _git('rev-parse', '--verify', f'refs/tags/{ref}', timeout=15)
    return out if ok else ''

def _fetch_tags(timeout=90) -> bool:
    ok, _ = _git('fetch', '--tags', 'origin', timeout=timeout)
    return ok

def _checkout(sha: str, timeout=60) -> bool:
    """Check out a revision WITHOUT -f: git itself refuses to clobber
    modified files, so user changes can never be destroyed here."""
    ok, _ = _git('checkout', '--detach', sha, timeout=timeout)
    return ok

def _git_remote_url() -> str:
    ok, out = _git('remote', 'get-url', 'origin', timeout=15)
    return out if ok else ''

def _py_compile_all(timeout=60) -> bool:
    """Syntax-check every python file that ships with the app."""
    targets = ['app.py', 'shared.py'] + [
        str(p.relative_to(BASE_DIR)) for p in (BASE_DIR / 'routes').glob('*.py')
    ] + [
        str(p.relative_to(BASE_DIR)) for p in BASE_DIR.glob('tts_worker*.py')
    ]
    ok, _ = _git_style_run([sys.executable, '-m', 'py_compile', *targets], timeout)
    return ok

def _git_style_run(argv, timeout) -> tuple:
    try:
        proc = subprocess.run(
            argv, cwd=str(BASE_DIR), capture_output=True, text=True, timeout=timeout,
        )
        return proc.returncode == 0, (proc.stderr or proc.stdout or '')[:400]
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:400]

def _boot_probe(timeout=25) -> tuple:
    """Start the (new) app on a scratch port and confirm it answers.
    Returns (ok, detail). The probe never restarts the real service.
    Any HTTP response proves Flask came up; connection refused means it
    did not."""
    import socket
    import urllib.request
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        probe_port = s.getsockname()[1]
    env = dict(os.environ)
    env['DECLOUD_PORT'] = str(probe_port)
    env['DECLOUD_HOST'] = '127.0.0.1'
    env['DECLOUD_UPDATE_PROBE'] = '1'  # app.py skips rollback logic in probes
    try:
        proc = subprocess.Popen(
            [sys.executable, 'app.py'], cwd=str(BASE_DIR),
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
    except OSError as e:
        return False, f'could not start probe: {e}'

    deadline = time.time() + timeout
    ok = False
    detail = 'no response from probe'
    try:
        while time.time() < deadline:
            if proc.poll() is not None:
                tail = ''
                if proc.stdout:
                    tail = proc.stdout.read()[-300:]
                return False, f'probe exited early (code {proc.returncode}): {tail}'
            try:
                req = urllib.request.Request(
                    f'http://127.0.0.1:{probe_port}/', method='GET')
                with urllib.request.urlopen(req, timeout=2) as resp:
                    resp.read(64)
                    # Any HTTP status means the app is up
                    ok = True
                    detail = f'probe answered {resp.status}'
                    break
            except Exception:
                time.sleep(0.4)
    finally:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception:
            pass
    return ok, detail

# ─── Marker helpers ───────────────────────────────────────────────

def read_update_meta() -> dict:
    if not UPDATE_META_FILE.exists():
        return {}
    try:
        return json.loads(UPDATE_META_FILE.read_text())
    except Exception:
        return {}

def write_update_meta(meta: dict):
    UPDATE_META_FILE.write_text(json.dumps(meta, indent=2))

def clear_update_meta():
    try:
        UPDATE_META_FILE.unlink(missing_ok=True)
    except OSError:
        pass

def _normalize_version(v: str) -> str:
    return (v or '').strip().lstrip('vV')

# ─── Remote latest-version lookup (cached, hardcoded host = no SSRF) ──

def _fetch_latest_from_github() -> dict:
    import requests as _requests
    data = None
    try:
        r = _requests.get(GITHUB_RELEASES_URL, timeout=6,
                          headers={'Accept': 'application/vnd.github+json'})
        if r.status_code == 200:
            rel = r.json()
            data = {
                'tag': rel.get('tag_name', ''),
                'name': rel.get('name') or rel.get('tag_name', ''),
                'published_at': rel.get('published_at', ''),
                'notes': (rel.get('body') or '')[:600],
            }
        else:
            raise RuntimeError(f'releases {r.status_code}')
    except Exception:
        data = None
    if not data:
        try:
            r = _requests.get(GITHUB_TAGS_URL, timeout=6,
                              headers={'Accept': 'application/vnd.github+json'})
            if r.status_code == 200:
                tags = r.json()
                if tags:
                    data = {
                        'tag': tags[0].get('name', ''),
                        'name': tags[0].get('name', ''),
                        'published_at': '',
                        'notes': '',
                    }
        except Exception:
            data = None
    return data or {}

# ─── Routes ───────────────────────────────────────────────────────

@bp.route('/api/system/update/check', methods=['GET'])
@limiter.limit("10 per minute")
def update_check():
    """Report local state and the newest available version. Read-only."""
    from routes.version import VERSION
    is_git = _git_available()
    meta = read_update_meta()
    head = _head_sha() if is_git else ''
    can_rollback = bool(meta.get('prev_sha') and head and meta['prev_sha'] != head)

    latest = None
    now = time.time()
    if now - _latest_cache['ts'] > 600:
        _latest_cache['data'] = _fetch_latest_from_github()
        _latest_cache['ts'] = now
    latest = _latest_cache['data'] or {}

    update_available = False
    if is_git and latest.get('tag'):
        update_available = (_normalize_version(latest['tag'])
                            != _normalize_version(VERSION))

    return jsonify({
        'current_version': VERSION,
        'is_git': is_git,
        'tree_clean': _tree_clean() if is_git else True,
        'head_sha': head[:12],
        'remote': _git_remote_url() if is_git else '',
        'can_rollback': can_rollback,
        'latest': latest,
        'update_available': update_available,
    })

@bp.route('/api/system/update', methods=['POST'])
@limiter.limit("3 per 15 minutes")
def update_run():
    """Fetch, verify, and switch to an explicit tag. Returns before the
    restart happens (the service manager restarts the process)."""
    data = request.get_json(silent=True) or {}
    ref = str(data.get('ref') or '').strip()

    if not _REF_PATTERN.match(ref):
        return jsonify({'error': 'invalid version reference'}), 400

    if not _update_lock.acquire(blocking=False):
        return jsonify({'error': 'an update is already in progress'}), 409
    try:
        # 1. Git install required
        if not _git_available():
            return jsonify({
                'error': 'updates require a git installation of DeCloud '
                         '(this install has no git repository)',
                'code': 'NOT_GIT',
            }), 409

        # 2. Never update a tree the user has modified
        if not _tree_clean():
            return jsonify({
                'error': 'local changes detected — refusing to update so your '
                         'edits are not lost. Review `git status` over SSH, '
                         'then try again.',
                'code': 'DIRTY_TREE',
            }), 409

        prev_sha = _head_sha()
        if not prev_sha:
            return jsonify({'error': 'could not read current revision'}), 500

        # 3. Fetch tags (read-only)
        if not _fetch_tags():
            return jsonify({'error': 'could not fetch updates from origin '
                                     '(network or remote problem)'}), 502

        # 4. Resolve the exact target
        target_sha = _resolve_tag_ref(ref)
        if not target_sha:
            return jsonify({'error': f'version {ref} not found on the remote'}), 404
        if target_sha == prev_sha:
            return jsonify({'error': 'already on this version'}), 409

        from routes.version import VERSION
        write_update_meta({
            'state': 'prepared',
            'prev_sha': prev_sha,
            'prev_version': VERSION,
            'target_ref': ref,
            'target_sha': target_sha,
            'ts': time.time(),
        })

        # 5. Switch the working tree (git refuses if anything conflicts)
        if not _checkout(target_sha):
            clear_update_meta()
            return jsonify({'error': 'checkout failed — your current version '
                                     'is still running, nothing changed'}), 500

        # 6. Verify the NEW code before restarting
        if not _py_compile_all():
            _rollback_now(prev_sha)
            return jsonify({'error': 'new version failed syntax checks — '
                                     'rolled back, you are still on '
                                     f'{VERSION}'}), 500
        probe_ok, probe_detail = _boot_probe()
        if not probe_ok:
            _rollback_now(prev_sha)
            return jsonify({
                'error': f'new version failed the boot test and was rolled '
                         f'back automatically ({probe_detail}). Your current '
                         'version is still running.',
            }), 500

        # 7. Verified — mark installed and schedule the restart
        meta = read_update_meta()
        meta['state'] = 'installed'
        meta['ts'] = time.time()
        write_update_meta(meta)

        restart_requested = _schedule_restart()

        return jsonify({
            'ok': True,
            'from': VERSION,
            'to': ref,
            'restart': 'scheduled' if restart_requested else 'manual',
            'message': 'update verified — the app will restart in a moment' if
                       restart_requested else
                       'update verified — restart the app to switch to it',
        })
    finally:
        _update_lock.release()

@bp.route('/api/system/update/rollback', methods=['POST'])
@limiter.limit("3 per 15 minutes")
def update_rollback():
    """Return to the revision that ran before the last update."""
    if not _update_lock.acquire(blocking=False):
        return jsonify({'error': 'an update is already in progress'}), 409
    try:
        meta = read_update_meta()
        prev_sha = meta.get('prev_sha')
        if not prev_sha:
            return jsonify({'error': 'no previous version recorded'}), 409
        head = _head_sha()
        if head == prev_sha:
            return jsonify({'error': 'already on the previous version'}), 409
        if not _tree_clean():
            return jsonify({'error': 'local changes detected — refusing to '
                                     'touch the tree'}), 409
        if not _checkout(prev_sha):
            return jsonify({'error': 'rollback checkout failed — nothing changed'}), 500
        meta['state'] = 'rolled_back'
        meta['ts'] = time.time()
        write_update_meta(meta)
        _schedule_restart()
        return jsonify({'ok': True, 'rolled_back_to': prev_sha[:12]})
    finally:
        _update_lock.release()

# ─── Restart + rollback mechanics ─────────────────────────────────

def _schedule_restart() -> bool:
    """Kill this process in 2 seconds; the service manager (systemd
    Restart=always / launchd / scheduled task) brings it back on the
    new code. Disabled via env for tests. Returns True if scheduled."""
    if os.environ.get('DECLOUD_UPDATE_DISABLE_RESTART') == '1':
        return False
    script = (
        'import os, signal, sys, time\n'
        'pid = int(sys.argv[1])\n'
        'time.sleep(2)\n'
        'try: os.kill(pid, signal.SIGTERM)\n'
        'except ProcessLookupError: sys.exit(0)\n'
        'time.sleep(5)\n'
        'try: os.kill(pid, signal.SIGKILL)\n'
        'except ProcessLookupError: pass\n'
    )
    try:
        subprocess.Popen(
            [sys.executable, '-c', script, str(os.getpid())],
            start_new_session=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            close_fds=True, cwd=str(BASE_DIR),
        )
        return True
    except OSError:
        return False

def _rollback_now(prev_sha: str):
    """Immediately check out the previous revision (used when the new
    code fails verification). Leaves the marker so the UI can report."""
    try:
        _checkout(prev_sha)
        meta = read_update_meta()
        meta['state'] = 'rolled_back'
        meta['ts'] = time.time()
        write_update_meta(meta)
    except Exception:
        pass

# ─── Boot-time hooks (called from app.py) ─────────────────────────

def rollback_on_failed_boot() -> bool:
    """Called from app.py's startup exception handler. If the previous
    update is fresh, check the last-good revision back out so the next
    (automatic) restart brings the working version up. Returns True if
    a rollback was performed."""
    try:
        meta = read_update_meta()
        if meta.get('state') not in ('prepared', 'installed'):
            return False
        age = time.time() - float(meta.get('ts', 0))
        if age > ROLLBACK_WINDOW_SECONDS:
            clear_update_meta()
            return False
        prev_sha = meta.get('prev_sha')
        if prev_sha and prev_sha != _head_sha():
            _checkout(prev_sha)
            meta['state'] = 'rolled_back'
            meta['ts'] = time.time()
            write_update_meta(meta)
            return True
        return False
    except Exception:
        return False

def clear_marker_after_healthy_uptime():
    """Background thread: once the (new) code has stayed up for a while,
    the update is considered good and the marker is cleared."""
    try:
        initial_ts = read_update_meta().get('ts')
    except Exception:
        return

    def _clear():
        time.sleep(MARKER_CLEAR_AFTER_SECONDS)
        try:
            meta = read_update_meta()
            # Only clear if nothing newer happened meanwhile
            if meta and meta.get('ts') == initial_ts:
                clear_update_meta()
        except Exception:
            pass
    threading.Thread(target=_clear, daemon=True).start()
