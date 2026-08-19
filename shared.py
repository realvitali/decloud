"""DeCloud — shared state and helpers."""
from flask import Flask, send_from_directory, jsonify, request, send_file, Response, stream_with_context
from flask_sock import Sock
import os, json, subprocess, platform, psutil, uuid, re, time, threading, secrets, hmac
from pathlib import Path
from functools import lru_cache
import requests as _requests
import websocket as _ws_lib
import hashlib

app = Flask(__name__, static_folder='static', static_url_path='/static')
sock = Sock(app)

# ─── Rate Limiting ──────────────────────────────────────────────
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["300 per minute"],
    storage_uri="memory://",
)

# ─── .env loader ─────────────────────────────────────────────────
# systemd injects EnvironmentFile automatically, but manual `./decloud start`
# and bare `python app.py` don't. Load .env here so both paths behave the same.
# Never overrides variables already set in the real environment.
def _load_env_file():
    env_path = Path(__file__).parent / '.env'
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(errors='replace').splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            if key and key not in os.environ:
                os.environ[key] = val
    except Exception:
        pass  # unreadable .env shouldn't crash the app

_load_env_file()

# ─── Authentication ─────────────────────────────────────────────
# DeCloud requires a passcode (DECLOUD_PIN) to access the app. If not
# set, the app runs in open mode (for local-only development).
#
# Security model:
#   - The passcode is the *credential* — only used during /api/auth/login.
#   - On successful login the server mints a random opaque session token,
#     stores it in the in-memory SESSIONS map with an expiry, and sets it
#     as the `decloud_session` cookie. The passcode itself is NEVER sent
#     back to the browser and never accepted as a Bearer credential.
#   - All subsequent requests are authenticated by the session token.
#   - Sessions are scoped to a single process (in-memory) and expire
#     after 30 days. A restart invalidates all sessions, forcing
#     re-login — acceptable for a personal self-hosted app.
DECLOUD_PIN = os.environ.get('DECLOUD_PIN', '')
if DECLOUD_PIN:
    if len(DECLOUD_PIN) > 64:
        raise SystemExit('[decloud] DECLOUD_PIN is longer than 64 characters.')
    if len(DECLOUD_PIN) < 8:
        print('[decloud] WARNING: DECLOUD_PIN is short. Use at least 8 '
              'characters (a passphrase, not just digits) — the install '
              'default is now 8 digits.', flush=True)

# Refuse to start with the placeholder SECRET_KEY. Generate one if missing.
_env_secret = os.environ.get('SECRET_KEY', '')
if _env_secret and _env_secret != 'change-me-to-a-random-string':
    SECRET_KEY = _env_secret
else:
    SECRET_KEY = secrets.token_hex(32)
    print('[decloud] WARNING: SECRET_KEY not set in .env — generated an ephemeral '
          'one for this run. Sessions will not survive a restart. '
          'Set SECRET_KEY in .env to persist sessions.', flush=True)
app.secret_key = SECRET_KEY

# In-memory session store: token -> expiry epoch seconds
SESSIONS: dict[str, float] = {}
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days
MAX_SESSIONS = 50

# Failed-login tracking: remote address -> [attempt timestamps]
_LOGIN_ATTEMPTS: dict[str, list[float]] = {}
_LOGIN_BACKOFF_WINDOW = 60.0  # seconds of history kept per address
_LOGIN_BACKOFF_MAX = 10       # failures before a hard cooldown applies

def _purge_expired_sessions():
    """Drop expired tokens. Called on every authenticated request — cheap
    because the dict stays small (a handful of devices per install)."""
    now = time.time()
    for t in [t for t, exp in SESSIONS.items() if exp <= now]:
        SESSIONS.pop(t, None)

def _csrf_for_token(token: str) -> str:
    """CSRF token derived from a session token and the app secret."""
    return hmac.new(SECRET_KEY.encode(), token.encode(), hashlib.sha256).hexdigest()

def _extract_session_token():
    """Return the session token from cookie or Authorization header, or None."""
    token = request.cookies.get('decloud_session')
    if not token:
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:].strip()
    return token or None

def _is_authenticated():
    """Check if the current request carries a valid session token."""
    if not DECLOUD_PIN:
        return True  # Open mode (no passcode set)
    token = _extract_session_token()
    if not token:
        return False
    _purge_expired_sessions()
    return token in SESSIONS

def _authed_by_bearer() -> bool:
    """True when auth came from an Authorization header (CSRF-safe)."""
    return bool(request.headers.get('Authorization', '').startswith('Bearer '))

def ws_is_authenticated(environ: dict) -> bool:
    """Check a WebSocket handshake for a valid session.

    Flask's before_request hooks do NOT run for WebSocket upgrades, so
    every WebSocket handler must call this itself. Accepts the session
    token via cookie, Authorization header, or ?token= query parameter
    (the query parameter is the cross-origin tunnel fallback).
    """
    if not DECLOUD_PIN:
        return True  # Open mode
    token = ''
    auth = environ.get('HTTP_AUTHORIZATION', '')
    if auth.startswith('Bearer '):
        token = auth[7:].strip()
    if not token:
        cookie = environ.get('HTTP_COOKIE', '')
        for part in cookie.split(';'):
            key, _, val = part.strip().partition('=')
            if key == 'decloud_session':
                token = val
                break
    if not token:
        from urllib.parse import parse_qs
        qs = parse_qs(environ.get('QUERY_STRING', ''))
        token = (qs.get('token') or [''])[0]
    if not token:
        return False
    _purge_expired_sessions()
    return token in SESSIONS

@app.before_request
def _require_auth():
    """Gate all API endpoints behind session-token authentication."""
    from flask import request as req
    if not DECLOUD_PIN:
        return  # Open mode, no auth needed
    # Allow static files and the login page
    if req.path.startswith('/static/') or req.path == '/manifest.json' or req.path == '/sw.js':
        return
    if req.path == '/' or req.path == '/kill-cache':
        return
    if req.path == '/api/auth/login' or req.path == '/api/auth/check':
        return
    if not _is_authenticated():
        if req.path.startswith('/api/'):
            return jsonify({'error': 'Authentication required', 'code': 'AUTH_REQUIRED'}), 401
        # For non-API requests, serve the page (frontend will redirect to login)

    # CSRF defense for state-changing requests authenticated only by
    # cookie. Bearer-header auth is CSRF-safe (cross-origin callers
    # cannot set custom headers without a CORS preflight).
    if (req.method in ('POST', 'PUT', 'PATCH', 'DELETE')
            and req.path.startswith('/api/')
            and not _authed_by_bearer()):
        token = _extract_session_token()
        if not token:
            return jsonify({'error': 'Authentication required', 'code': 'AUTH_REQUIRED'}), 401
        provided = req.headers.get('X-CSRF-Token', '')
        if not provided or not hmac.compare_digest(provided, _csrf_for_token(token)):
            return jsonify({'error': 'Invalid CSRF token', 'code': 'CSRF_REQUIRED'}), 403

# ─── OS detection (cross-platform: Debian/Ubuntu, Fedora, macOS, Windows) ──
@lru_cache(maxsize=1)
def detect_os() -> dict:
    """Return {name, version, kernel} for the host OS.

    Reads /etc/os-release on Linux (works across Debian/Ubuntu/Fedora/
    Arch/etc.), falls back to platform.* for macOS/Windows/BSD.
    """
    system = platform.system()
    name = system or 'Unknown'
    version = platform.release() or ''
    kernel = platform.version() or ''

    if system == 'Linux':
        try:
            info = {}
            for raw in Path('/etc/os-release').read_text(errors='replace').splitlines():
                if '=' in raw:
                    key, _, val = raw.partition('=')
                    info[key] = val.strip().strip('"')
            pretty = info.get('PRETTY_NAME') or info.get('NAME') or 'Linux'
            version = info.get('VERSION') or info.get('VERSION_ID') or ''
            name = pretty
            if version and version not in pretty:
                name = f'{pretty} {version}'
        except OSError:
            pass
    elif system == 'Darwin':
        mac_ver = platform.mac_ver()[0] or ''
        name = f'macOS {mac_ver}'.strip()
        version = mac_ver
    elif system == 'Windows':
        win_ver = platform.win32_ver()
        name = f'Windows {win_ver[0]} {win_ver[1]}'.strip()
        version = win_ver[1] or ''
    return {'name': name, 'version': version, 'kernel': kernel, 'system': system}

# ─── Config: all paths are env-configurable ─────────────────────
BASE_DIR = Path(__file__).parent

# ─── Request logging ────────────────────────────────────────────
# Appends one line per request to app.log so the Logs screen works.
# Format matches _read_logs(): "TIMESTAMP LEVEL MESSAGE".
import logging as _logging

_req_logger = _logging.getLogger('decloud.requests')
_req_handler = _logging.FileHandler(BASE_DIR / 'app.log')
_req_handler.setFormatter(_logging.Formatter('%(asctime)s %(levelname)s %(message)s', datefmt='%Y-%m-%dT%H:%M:%S'))
_req_logger.addHandler(_req_handler)
_req_logger.setLevel(_logging.INFO)

@app.after_request
def _harden_response(resp):
    """Security headers + request logging on every response."""
    # Security headers
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('X-Frame-Options', 'DENY')
    resp.headers.setdefault('Referrer-Policy', 'no-referrer')
    resp.headers.setdefault(
        'Permissions-Policy',
        'camera=(), geolocation=(), microphone=(self)',
    )
    # CSP: script-src needs 'unsafe-inline' because the SPA uses inline
    # onclick handlers; everything else is locked down. jsdelivr hosts
    # the xterm terminal assets.
    resp.headers.setdefault(
        'Content-Security-Policy',
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self' ws: wss:; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; "
        "form-action 'self'",
    )
    # Never cache API responses — they can contain personal data
    if request.path.startswith('/api/'):
        resp.headers.setdefault('Cache-Control', 'no-store')

    # Request log
    try:
        if not (resp.status_code == 200 and request.path.startswith('/static/')):
            _req_logger.info(f'{request.method} {request.path} {resp.status_code}')
    except Exception:
        pass
    return resp

def _env_path(key, default):
    """Read a path from env var, falling back to default."""
    val = os.environ.get(key)
    if val:
        # Expand ~ and environment variables like $HOME
        return Path(os.path.expandvars(os.path.expanduser(val)))
    return Path(default)

BOOKS_DIR = _env_path('DECLOUD_BOOKS_DIR', Path.home() / 'Books')
AUDIO_DIR = BASE_DIR / 'audio_cache'
AUDIO_DIR.mkdir(exist_ok=True)

# Piper TTS voice models directory
PIPER_DIR = _env_path('DECLOUD_PIPER_DIR', Path.home() / '.local/share/piper')

# In-memory cache for parsed PDF text (avoids re-parsing on every request)
_pdf_text_cache = {}  # key: (book_id, chapter_idx) -> text
_pdf_chapters_cache = {}  # key: book_id -> [{start, end, title}]

# ─── Available TTS Voices ─────────────────────────────────────
VOICES = {
    'kathleen-low': {
        'id': 'kathleen-low',
        'name': 'kathleen-low',
        'gender': 'female',
        'model': 'piper',
        'file': str(PIPER_DIR / 'en_US-kathleen-low.onnx'),
        'sample': None,
    },
    'lessac-medium': {
        'id': 'lessac-medium',
        'name': 'lessac-medium',
        'gender': 'male',
        'model': 'piper',
        'file': str(PIPER_DIR / 'en_US-lessac-medium.onnx'),
        'sample': None,
    },
    'lessac-high': {
        'id': 'lessac-high',
        'name': 'lessac-high',
        'gender': 'male',
        'model': 'piper',
        'file': str(PIPER_DIR / 'en_US-lessac-high.onnx'),
        'sample': None,
    },
}

# ─── LLM (local Ollama) ────────────────────────────────────────
OLLAMA_URL = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')
LLM_MODEL = os.environ.get('DECLOUD_LLM_MODEL', 'llama3.2')
LLM_TIMEOUT = 90

def llm_chat(messages, timeout=LLM_TIMEOUT):
    """Call local Ollama model. Returns assistant text or error string."""
    try:
        import urllib.request
        payload = json.dumps({
            'model': LLM_MODEL,
            'messages': messages,
            'stream': False,
            'options': {'temperature': 0.4, 'num_ctx': 8192}
        }).encode()
        req = urllib.request.Request(
            f'{OLLAMA_URL}/api/chat',
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = json.loads(resp.read())
        return data.get('message', {}).get('content', '').strip()
    except Exception as e:
        return f'[LLM error: {e}]'

def get_book_chapter_text(book_id, chapter_idx):
    """Get full text of a specific chapter from JSON, PDF, or TXT source."""
    json_matches = list(BOOKS_DIR.rglob(f'{book_id}.json'))
    json_source = json_matches[0] if json_matches else (BOOKS_DIR / f'{book_id}.json')
    if json_source.exists():
        with open(json_source) as f:
            chapters = json.load(f)
        if 0 <= chapter_idx < len(chapters):
            return chapters[chapter_idx].get('text', ''), chapters[chapter_idx].get('title', f'Chapter {chapter_idx+1}')
    # Fallback to TXT (entire file is one chapter)
    txt_matches = list(BOOKS_DIR.rglob(f'{book_id}.txt'))
    txt_path = txt_matches[0] if txt_matches else None
    if txt_path and txt_path.exists():
        text = txt_path.read_text(encoding='utf-8', errors='replace')
        return text, txt_path.stem.replace('_', ' ')
    # Fallback to PDF
    import fitz
    pdf_matches = list(BOOKS_DIR.rglob(f'{book_id}.pdf'))
    pdf_path = pdf_matches[0] if pdf_matches else (BOOKS_DIR / f'{book_id}.pdf')
    if not pdf_path.exists():
        return '', ''
    doc = fitz.open(str(pdf_path))
    toc = doc.get_toc()
    # Find chapter boundaries (same logic as text API)
    sections = []
    for entry in toc:
        level, title, page = entry[0], entry[1].strip(), entry[2]
        if level <= 2 and title and page - 1 >= 0:
            sections.append({'start': page - 1, 'title': title})
    if chapter_idx < 0 or chapter_idx >= len(sections):
        return '', ''
    start = sections[chapter_idx]['start']
    end = sections[chapter_idx + 1]['start'] - 1 if chapter_idx + 1 < len(sections) else len(doc) - 1
    text = ' '.join([doc[p].get_text() for p in range(start, end + 1)])
    doc.close()
    return text, sections[chapter_idx]['title']

def get_text_up_to_position(text, word_index):
    """Get text from start up to a given word index."""
    tokens = text.split()
    if word_index and word_index > 0 and word_index < len(tokens):
        return ' '.join(tokens[:word_index])
    return text  # full chapter if no position

# ─── File Browser ──────────────────────────────────────────────
# The directory the Files app browses. Set DECLOUD_FILES_DIR in .env
FILES_DIR = _env_path('DECLOUD_FILES_DIR', Path.home() / 'Files')
THUMB_CACHE_DIR = BASE_DIR / 'thumb_cache'
THUMB_CACHE_DIR.mkdir(exist_ok=True)
THUMB_SIZE = (200, 200)
THUMB_CACHE_TTL = 86400  # 24h

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

def _thumb_cache_path(source_path: Path) -> Path:
    """Get cache path for a source image. Keyed by path + mtime."""
    key = f"{source_path}:{source_path.stat().st_mtime}"
    h = hashlib.md5(key.encode()).hexdigest()[:16]
    return THUMB_CACHE_DIR / f"{h}.webp"

def _generate_thumbnail(source_path: Path, size: tuple = THUMB_SIZE) -> Path | None:
    """Generate a small WebP thumbnail, cache it, return cache path."""
    cache_path = _thumb_cache_path(source_path)
    if cache_path.exists():
        return cache_path
    try:
        from PIL import Image
        img = Image.open(source_path)
        img.thumbnail(size)
        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')
        img.save(cache_path, 'WEBP', quality=75)
        return cache_path
    except Exception:
        return None

def safe_join_browse(base, *parts):
    """Safely join paths and ensure the result is within the base directory."""
    result = base
    for part in parts:
        if part == '..':
            result = result.parent
            if not str(result).startswith(str(base)) and result != base.parent:
                result = base
        elif part and part != '.':
            result = result / part
    # Ensure we stay within the mount
    result = result.resolve()
    if not str(result).startswith(str(FILES_DIR.resolve())):
        result = FILES_DIR.resolve()
    return result

def format_size(size):
    """Format bytes as human-readable."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024:
            return f'{size:.0f} {unit}' if unit == 'B' else f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} TB'

# In-memory cache for folder info (child_count, has_images)
_folder_info_cache = {}  # path -> (mtime, child_count, has_images)

# ─── ComfyUI ────────────────────────────────────────────────────
COMFY_URL = os.environ.get('COMFY_URL', 'http://localhost:8188')
COMFY_OUTPUT = _env_path('DECLOUD_COMFY_OUTPUT', Path.home() / 'ComfyUI' / 'output')
COMFY_INPUT = _env_path('DECLOUD_COMFY_INPUT', Path.home() / 'ComfyUI' / 'input')

# ─── Voice System: Whisper + Engines ────────────────────────────
_whisper_model = None
_whisper_model_name = None

def get_whisper_model(model_name='base'):
    """Lazy-load faster-whisper model. Sizes: tiny, base, small, medium, large-v3"""
    global _whisper_model, _whisper_model_name
    if _whisper_model and _whisper_model_name == model_name:
        return _whisper_model
    from faster_whisper import WhisperModel
    # Use int8 for speed on CPU, float16 if GPU available
    try:
        _whisper_model = WhisperModel(model_name, device='cuda', compute_type='float16')
    except Exception:
        _whisper_model = WhisperModel(model_name, device='cpu', compute_type='int8')
    _whisper_model_name = model_name
    return _whisper_model

# Available TTS engines
TTS_ENGINES = {
    'piper-lessac-high': {
        'name': 'Piper Lessac (High Quality)',
        'engine': 'piper',
        'model': 'voices/en_US-lessac-high.onnx',
    },
    'piper-lessac-medium': {
        'name': 'Piper Lessac (Medium)',
        'engine': 'piper',
        'model': 'voices/en_US-lessac-medium.onnx',
    },
    'piper-kathleen-low': {
        'name': 'Piper Kathleen (Low)',
        'engine': 'piper',
        'model': 'voices/en_US-kathleen-low.onnx',
    },
    'browser': {
        'name': 'Browser Built-in (Instant)',
        'engine': 'browser',
        'model': None,
    },
}

STT_ENGINES = {
    'whisper-tiny': {'name': 'Whisper Tiny (Fastest)', 'model': 'tiny'},
    'whisper-base': {'name': 'Whisper Base (Balanced)', 'model': 'base'},
    'whisper-small': {'name': 'Whisper Small (Better)', 'model': 'small'},
    'whisper-medium': {'name': 'Whisper Medium (Best Local)', 'model': 'medium'},
    'browser': {'name': 'Browser Web Speech (No Install)', 'model': None},
}

# ─── Vui proxy URL ──────────────────────────────────────────────
VUI_URL = os.environ.get('DECLOUD_VUI_URL', 'http://127.0.0.1:8081')

# ─── Optional modules (set env vars to enable) ──────────────────
# These features need external tools/config to work.
# If env vars aren't set, the modules load but return helpful errors.
OSINT_TOOLS_DIR = os.environ.get('DECLOUD_OSINT_DIR', '')  # path to osint-tools
JOURNAL_DIR = _env_path('DECLOUD_JOURNAL_DIR', '')  # path to Obsidian vault
HERMES_HOME = os.environ.get('DECLOUD_HERMES_HOME', '')  # path to .hermes

# ─── Projects config (data-driven, edit in settings or .env) ───
# Empty by default — users add their own projects in the UI
PROJECTS_CONFIG = json.loads(os.environ.get('DECLOUD_PROJECTS', '[]'))

# ─── Network stats state ────────────────────────────────────────
_network_last = {'bytes_sent': 0, 'bytes_recv': 0, 'ts': 0}

# ─── Settings ───────────────────────────────────────────────────
SETTINGS_FILE = BASE_DIR / 'settings.json'

# ─── Telemetry ──────────────────────────────────────────────────
TELEMETRY_DIR = BASE_DIR / 'telemetry'
TELEMETRY_DIR.mkdir(exist_ok=True)
USAGE_FILE = TELEMETRY_DIR / 'usage.json'

# ─── Logs ───────────────────────────────────────────────────────
LOG_FILE = BASE_DIR / 'app.log'

def _read_logs(limit=100):
    """Return list of {timestamp, level, message} parsed from log file."""
    log_lines = []
    if LOG_FILE.exists():
        try:
            lines = LOG_FILE.read_text(errors='replace').splitlines()
        except Exception:
            lines = []
    else:
        # fallback: no stderr capture available; return empty
        lines = []
    lines = lines[-limit:]
    log_re = re.compile(
        r'^(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\s*'
        r'(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL)?\s*[:\-\]\s]*'
        r'(?P<msg>.*)$',
        re.IGNORECASE,
    )
    for line in lines:
        m = log_re.match(line)
        if m:
            log_lines.append({
                'timestamp': m.group('ts'),
                'level': (m.group('level') or 'INFO').upper(),
                'message': m.group('msg').strip(),
            })
        else:
            # non-matching line — append as INFO
            log_lines.append({
                'timestamp': '',
                'level': 'INFO',
                'message': line,
            })
    return log_lines

# ─── Music ──────────────────────────────────────────────────────
MUSIC_DIR = _env_path('DECLOUD_MUSIC_DIR', Path.home() / 'Music' / 'decloud-music')
MUSIC_EXTS = {'.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'}
