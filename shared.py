"""DeCloud — shared state and helpers."""
from flask import Flask, send_from_directory, jsonify, request, send_file, Response, stream_with_context
from flask_sock import Sock
import os, sys, json, subprocess, platform, psutil, uuid, re, time, threading, secrets, hmac, shutil
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
        # Keys already present in the real environment (e.g. systemd
        # EnvironmentFile) must NOT be overridden by .env. Everything else
        # uses last-wins, so a duplicate key in .env resolves to the final
        # line (correct .env semantics) rather than silently picking the first.
        external = set(os.environ.keys())
        for raw in env_path.read_text(errors='replace').splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            if key and key not in external:
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
    """Return the session token from cookie, Authorization header, or the
    ?token= query parameter (the cross-origin tunnel fallback for
    WebSocket handshakes, where browsers cannot set headers)."""
    token = request.cookies.get('decloud_session')
    if not token:
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:].strip()
    if not token:
        token = request.args.get('token', '') or ''
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


def reload_env_paths():
    """Re-read DECLOUD_*_DIR from the environment into the module globals.

    Called after Settings saves new paths to .env so library changes take
    effect without an app restart. Code that reads shared.BOOKS_DIR /
    shared.FILES_DIR / shared.MUSIC_DIR at request time sees the new
    values immediately."""
    global BOOKS_DIR, FILES_DIR, MUSIC_DIR, PIPER_DIR
    BOOKS_DIR = _env_path('DECLOUD_BOOKS_DIR', Path.home() / 'Books')
    FILES_DIR = _env_path('DECLOUD_FILES_DIR', Path.home())
    MUSIC_DIR = _env_path('DECLOUD_MUSIC_DIR', Path.home() / 'Music')
    PIPER_DIR = _env_path('DECLOUD_PIPER_DIR', Path.home() / '.local/share/piper')
    try:
        MUSIC_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

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
FILES_DIR = _env_path('DECLOUD_FILES_DIR', Path.home())
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
    """Join parts under base, resolving symlinks, and clamp any result that
    escapes base. Uses real-path containment (is_relative_to), NOT a string
    prefix check, so sibling directories with a shared name prefix can't
    pass the check (e.g. /home/dallas vs /home/dallas2)."""
    base = Path(base)
    result = base
    for part in parts:
        if part and part != '.':
            result = result / part
    base_resolved = base.resolve()
    result_resolved = result.resolve()
    try:
        if result_resolved.is_relative_to(base_resolved):
            return result_resolved
    except AttributeError:  # Python < 3.9 fallback
        if os.path.commonpath([str(base_resolved), str(result_resolved)]) == str(base_resolved):
            return result_resolved
    return base_resolved

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
def piper_bin():
    """Locate the piper executable (bundled by the piper-tts pip package,
    or on PATH). Prefers the venv's own binary so it works under systemd
    where PATH is minimal."""
    exe = Path(sys.executable).with_name('piper')
    if exe.exists():
        return str(exe)
    return shutil.which('piper') or 'piper'


TTS_ENGINES = {
    'piper-lessac-high': {
        'name': 'Piper Lessac (High Quality)',
        'engine': 'piper',
        'model': str(PIPER_DIR / 'en_US-lessac-high.onnx'),
    },
    'piper-lessac-medium': {
        'name': 'Piper Lessac (Medium)',
        'engine': 'piper',
        'model': str(PIPER_DIR / 'en_US-lessac-medium.onnx'),
    },
    'piper-kathleen-low': {
        'name': 'Piper Kathleen (Low)',
        'engine': 'piper',
        'model': str(PIPER_DIR / 'en_US-kathleen-low.onnx'),
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

# ─── Voice Agent config (modular engines: STT / LLM / TTS) ───────
# Persisted in settings.json (non-secret) + .env (cloud API key only).
# The voice agent reads these at request time so swaps apply immediately.
VOICE_DEFAULTS = {
    'agent_name': 'DeCloud',         # user-named companion (set in onboarding)
    'stt': 'whisper-base',           # engine id from STT_ENGINES
    'tts': 'piper-lessac-medium',    # engine id from TTS_ENGINES
    'voice_access': 'basic',         # 'talk' | 'basic' | 'full'
    'llm_backend': 'local',          # 'local' | 'cloud'
    'llm_local_model': 'llama3.2',
    'llm_cloud_provider': 'openai',  # 'openai' | 'anthropic' | 'openai-compatible'
    'llm_cloud_model': 'gpt-4o-mini',
    'llm_cloud_base_url': '',        # required for openai-compatible
}

# Human-friendly default model suggestions for the one-click pull.
LLM_MODEL_SUGGESTIONS = [
    'llama3.2:3b',
    'qwen2.5:3b',
    'llama3.1:8b',
    'phi3:mini',
    'gemma2:2b',
    'mistral',
]


# ─── Voice Agent conversation memory ────────────────────────────
VOICE_HISTORY_FILE = BASE_DIR / 'voice_history.json'
VOICE_HISTORY_MAX = 40  # keep the last N messages in context


def load_voice_history():
    """Return the persisted voice conversation (list of role/content dicts)."""
    if VOICE_HISTORY_FILE.exists():
        try:
            data = json.loads(VOICE_HISTORY_FILE.read_text())
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def save_voice_history(history):
    """Persist the voice conversation (bounded to VOICE_HISTORY_MAX)."""
    try:
        VOICE_HISTORY_FILE.write_text(json.dumps(history[-VOICE_HISTORY_MAX:]))
        return True
    except Exception:
        return False


def reset_voice_history():
    try:
        if VOICE_HISTORY_FILE.exists():
            VOICE_HISTORY_FILE.unlink()
        return True
    except Exception:
        return False


def get_voice_config():
    """Return the current voice config merged over defaults."""
    cfg = dict(VOICE_DEFAULTS)
    voice = load_settings().get('voice')
    if isinstance(voice, dict):
        for k in VOICE_DEFAULTS:
            if k in voice:
                cfg[k] = voice[k]
    return cfg


def set_voice_config(updates):
    """Persist voice config updates to settings.json. Returns True on success."""
    settings = load_settings()
    voice = dict(settings.get('voice') or {})
    for k, v in updates.items():
        if k in VOICE_DEFAULTS:
            voice[k] = v
    settings['voice'] = voice
    return save_settings(settings)


def _ollama_llm_complete(model, messages, temperature, max_tokens, timeout):
    payload = {
        'model': model,
        'messages': messages,
        'stream': False,
        'options': {'temperature': temperature},
    }
    if max_tokens:
        payload['options']['num_predict'] = max_tokens
    resp = _requests.post(f'{OLLAMA_URL}/api/chat', json=payload, timeout=timeout)
    resp.raise_for_status()
    return resp.json().get('message', {}).get('content', '').strip()


def _anthropic_llm_complete(api_key, model, messages, temperature, max_tokens, timeout):
    system = ''
    msgs = []
    for m in messages:
        role = m.get('role', 'user')
        content = m.get('content', '')
        if role == 'system':
            system += content + '\n'
        elif role in ('user', 'assistant'):
            msgs.append({'role': role, 'content': content})
    payload = {
        'model': model,
        'messages': msgs,
        'max_tokens': max_tokens or 1024,
        'temperature': temperature,
    }
    if system.strip():
        payload['system'] = system.strip()
    resp = _requests.post(
        'https://api.anthropic.com/v1/messages',
        json=payload,
        headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01'},
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    parts = [b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text']
    return ''.join(parts).strip()


def _openai_llm_complete(base, api_key, model, messages, temperature, max_tokens, timeout):
    payload = {'model': model, 'messages': messages, 'temperature': temperature}
    if max_tokens:
        payload['max_tokens'] = max_tokens
    resp = _requests.post(
        f'{base}/chat/completions',
        json=payload,
        headers={'Authorization': f'Bearer {api_key}'},
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()['choices'][0]['message']['content'].strip()


def llm_complete(messages, temperature=0.3, max_tokens=None, model=None, timeout=60):
    """Route a chat completion to the configured backend.

    `model` only overrides the local (Ollama) model; cloud models are taken
    from config. Raises on error so callers can fall back or report it.
    """
    cfg = get_voice_config()
    if cfg.get('llm_backend') == 'cloud':
        provider = cfg.get('llm_cloud_provider', 'openai')
        cloud_model = cfg.get('llm_cloud_model') or 'gpt-4o-mini'
        api_key = os.environ.get('DECLOUD_LLM_API_KEY', '').strip()
        if not api_key:
            raise RuntimeError('No API key configured for the cloud LLM')
        if provider == 'anthropic':
            return _anthropic_llm_complete(api_key, cloud_model, messages, temperature, max_tokens, timeout)
        base = 'https://api.openai.com/v1'
        if provider == 'openai-compatible':
            base = (cfg.get('llm_cloud_base_url') or '').rstrip('/')
            if not base:
                raise RuntimeError('Base URL required for the OpenAI-compatible provider')
        return _openai_llm_complete(base, api_key, cloud_model, messages, temperature, max_tokens, timeout)
    local_model = model or cfg.get('llm_local_model') or LLM_MODEL
    return _ollama_llm_complete(local_model, messages, temperature, max_tokens, timeout)

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


def load_settings():
    """Read settings.json as a dict, tolerating a missing/corrupt file."""
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_settings(data):
    """Persist the settings dict to settings.json. Returns True on success."""
    try:
        SETTINGS_FILE.write_text(json.dumps(data, indent=2))
        return True
    except Exception:
        return False


def set_env_value(key, value):
    """Write key=value to .env (preserving other lines) and update the
    running process environment. Replaces the first occurrence and drops
    any duplicate lines so a key never appears twice. Used for secrets like
    the cloud LLM API key and the access passcode."""
    env_path = BASE_DIR / '.env'
    try:
        lines = env_path.read_text(errors='replace').splitlines() if env_path.exists() else []
    except Exception:
        return False
    out = []
    written = False
    for line in lines:
        if line.strip().startswith(key + '='):
            if not written:
                out.append(f'{key}={value}')
                written = True
            # else: drop duplicate line
        else:
            out.append(line)
    if not written:
        out.append(f'{key}={value}')
    try:
        env_path.write_text('\n'.join(out) + '\n')
        os.environ[key] = value
        return True
    except Exception:
        return False

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
MUSIC_DIR = _env_path('DECLOUD_MUSIC_DIR', Path.home() / 'Music')
try:
    MUSIC_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass  # read-only filesystem — music browsing will simply be empty
MUSIC_EXTS = {'.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'}
