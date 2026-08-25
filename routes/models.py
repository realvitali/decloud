"""AI model advisor + one-tap downloads.

"My Machine, but for models": probe the hardware (CPU/RAM/GPU VRAM),
analyze a curated catalog — or ANY pasted HuggingFace repo — against
real file sizes from the HF API, and mark each model with what level
it runs at on this machine:

    runs-well   fits VRAM comfortably
    tight       fits with offloading / reduced context
    cpu-only    too big for VRAM but fits in RAM (slow)
    too-big     does not fit

Downloads stream into the right place for the apps to find them:
chat GGUFs go to DECLOUD_MODELS_DIR/chat and can be imported into
Ollama automatically (`ollama create`), image/video/music models go
into the local ComfyUI models tree. Progress is polled from the UI;
cancel stops and cleans up. The user never touches the machine.
"""
from flask import Blueprint, jsonify, request
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from shared import app, limiter, BASE_DIR, _requests, COMFY_OUTPUT
import psutil

bp = Blueprint('models', __name__)

# ─── Config ───────────────────────────────────────────────────────
MODELS_DIR = Path(os.path.expandvars(os.path.expanduser(
    os.environ.get('DECLOUD_MODELS_DIR', '~/Models'))))
CHAT_DIR = MODELS_DIR / 'chat'
# ComfyUI's models root: sibling of its output dir (default layout)
COMFY_MODELS_DIR = Path(os.path.expandvars(os.path.expanduser(
    os.environ.get('DECLOUD_COMFY_MODELS_DIR', str(COMFY_OUTPUT.parent / 'models')))))

HF_API = 'https://huggingface.co/api/models'
HF_RESOLVE = 'https://huggingface.co/{repo}/resolve/main/{file}'

REPO_PATTERN = re.compile(r'^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$')
FILE_PATTERN = re.compile(r'^[A-Za-z0-9._/+-]+$')
SPLIT_RE = re.compile(r'^(.*?)[-_](\d{5})[-_]of[-_](\d{5})\.(gguf|safetensors)$', re.IGNORECASE)

# VRAM headroom kept for context/activations (GB)
CHAT_OVERHEAD_GB = 1.5
IMAGE_OVERHEAD_GB = 1.0
CPU_RAM_HEADROOM_FACTOR = 0.5   # CPU-only: model may use up to half of RAM

# ─── Curated catalog (starters — any HF repo works via /analyze) ──
CATALOG = [
    {'repo': 'unsloth/DeepSeek-R1-GGUF', 'category': 'chat',
     'label': 'DeepSeek R1 (reasoning)', 'note': 'Pick the Q4_K_M file for most GPUs.'},
    {'repo': 'unsloth/Llama-3.3-70B-Instruct-GGUF', 'category': 'chat',
     'label': 'Llama 3.3 70B', 'note': 'Needs 24GB+ for Q4; smaller quants exist.'},
    {'repo': 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', 'category': 'chat',
     'label': 'Qwen 2.5 Coder 7B', 'note': 'Great coding model for modest GPUs.'},
    {'repo': 'bartowski/Llama-3.2-3B-Instruct-GGUF', 'category': 'chat',
     'label': 'Llama 3.2 3B', 'note': 'Runs on almost anything, even CPU.'},
    {'repo': 'Comfy-Org/flux1-schnell', 'category': 'image',
     'label': 'FLUX.1 Schnell', 'note': 'Fast image generation (fp8).'},
    {'repo': 'stabilityai/stable-diffusion-xl-base-1.0', 'category': 'image',
     'label': 'Stable Diffusion XL', 'note': 'The classic — works on 8GB VRAM.'},
    {'repo': 'guillaume127/MiniMax-Music-3-Turbo-FP8', 'category': 'music',
     'label': 'MiniMax Music 3 (FP8)', 'note': 'Local music generation, ComfyUI-optimized.'},
    {'repo': 'Comfy-Org/Wan_2.1_ComfyUI_repackaged', 'category': 'video',
     'label': 'Wan 2.1 (video)', 'note': 'Local video generation — heavy, 16GB+.'},
]

# Category → ComfyUI subfolder (chat goes to CHAT_DIR instead)
CATEGORY_TARGETS = {
    'image': COMFY_MODELS_DIR / 'checkpoints',
    'video': COMFY_MODELS_DIR / 'diffusion_models',
    'music': COMFY_MODELS_DIR / 'musicgen',
}

# ─── Hardware probe ───────────────────────────────────────────────

def get_specs() -> dict:
    """CPU/RAM/GPU as the advisor sees them. Never raises."""
    specs = {
        'cpu': (psutil.cpu_count(logical=True) or 0),
        'ram_total_gb': round(psutil.virtual_memory().total / 1e9, 1),
        'ram_free_gb': round(psutil.virtual_memory().available / 1e9, 1),
        'disk_free_gb': 0,
        'gpus': [],
    }
    try:
        specs['disk_free_gb'] = round(psutil.disk_usage(str(MODELS_DIR.anchor or '/')).free / 1e9, 1)
    except Exception:
        pass
    try:
        out = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,memory.total,memory.free',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5,
        )
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(',')]
            if len(parts) >= 3:
                try:
                    total_mb = float(parts[1])
                    free_mb = float(parts[2])
                except ValueError:
                    continue
                specs['gpus'].append({
                    'name': parts[0],
                    'vram_total_gb': round(total_mb / 1024, 1),
                    'vram_free_gb': round(free_mb / 1024, 1),
                })
    except Exception:
        pass
    return specs


def vram_total(specs: dict) -> float:
    return max((g['vram_total_gb'] for g in specs['gpus']), default=0.0)


# ─── Fit engine ───────────────────────────────────────────────────

def fit_tier(size_gb: float, category: str, specs: dict) -> str:
    """How well a model of size_gb GB runs on this machine."""
    vram = vram_total(specs)
    ram = specs['ram_total_gb']
    if category == 'chat':
        need = size_gb + CHAT_OVERHEAD_GB
        if vram > 0:
            if need <= vram * 0.9:
                return 'runs-well'
            if need <= vram * 1.05:
                return 'tight'
            if need <= ram * CPU_RAM_HEADROOM_FACTOR:
                return 'cpu-only'
            return 'too-big'
        return 'cpu-only' if need <= ram * CPU_RAM_HEADROOM_FACTOR else 'too-big'
    # image / video / music: need real GPU VRAM
    need = size_gb + IMAGE_OVERHEAD_GB
    if vram <= 0:
        return 'too-big'
    if need <= vram * 0.9:
        return 'runs-well'
    if need <= vram * 1.05:
        return 'tight'
    return 'too-big'


def analyze_repo(repo: str, category: str, specs: dict) -> dict:
    """Fetch real file sizes from HF and score every downloadable file.

    Uses the tree endpoint (the siblings list no longer carries sizes)."""
    try:
        r = _requests.get(f'{HF_API}/{repo}/tree/main',
                          params={'recursive': True, 'expand': False}, timeout=20)
        if r.status_code == 404:
            return {'repo': repo, 'error': 'repo not found on HuggingFace'}
        r.raise_for_status()
        entries = r.json()
    except Exception as e:
        return {'repo': repo, 'error': f'could not reach HuggingFace: {e}'}

    files = []
    total = 0
    gguf_groups: dict[str, dict] = {}
    for entry in entries or []:
        if not isinstance(entry, dict) or entry.get('type') != 'file':
            continue
        fname = entry.get('path') or entry.get('rfilename', '')
        try:
            size = int(entry.get('size') or 0)
        except (TypeError, ValueError):
            size = 0
        if not fname or size <= 0:
            continue
        lname = fname.lower()
        interesting = (lname.endswith('.gguf') or lname.endswith('.safetensors')
                       or lname.endswith('.pt') or lname.endswith('.ckpt')
                       or (category in ('music', 'video') and lname.endswith(('.onnx', '.bin'))))
        if not interesting:
            continue
        total += size

        m = SPLIT_RE.match(fname)
        if m and m.group(4).lower() == 'gguf':
            # Split GGUF archive: group parts into ONE downloadable entry
            base = m.group(1)
            grp = gguf_groups.setdefault(base, {'parts': [], 'size': 0})
            grp['parts'].append(fname)
            grp['size'] += size
            continue

        files.append({'file': fname, 'size_gb': round(size / 1e9, 2), 'parts': None})

    for base, grp in gguf_groups.items():
        size_gb = grp['size'] / 1e9
        files.append({
            'file': base + '.gguf',
            'size_gb': round(size_gb, 2),
            'parts': sorted(grp['parts']),
            'tier': fit_tier(size_gb, category, specs),
        })

    for f in files:
        if 'tier' not in f:
            f['tier'] = fit_tier(f['size_gb'], category, specs)

    if category == 'chat':
        # GGUF: smallest quants first (what most people want)
        files.sort(key=lambda f: (f['size_gb'], f['file']))
    else:
        # safetensors: the model itself is the biggest file — show it first,
        # drop tiny auxiliary files (loras/vaes) from the top view
        files.sort(key=lambda f: f['size_gb'], reverse=True)
        files = [f for f in files if f['size_gb'] >= 0.5][:8]

    return {
        'repo': repo,
        'category': category,
        'total_gb': round(total / 1e9, 2),
        'files': files[:12],
        'downloads_available': bool(files),
    }


# ─── Download manager ─────────────────────────────────────────────

_downloads: dict[str, dict] = {}
_download_lock = threading.Lock()


def _target_dir(category: str) -> Path:
    if category == 'chat':
        return CHAT_DIR
    return CATEGORY_TARGETS.get(category, MODELS_DIR / category)


def _slug(name: str) -> str:
    return re.sub(r'[^A-Za-z0-9._-]+', '-', name).strip('-')[:80] or 'model'


def _ollama_import(gguf_path: Path, name: str) -> tuple:
    """Make a downloaded chat GGUF usable in the AI Chat app."""
    modelfile = gguf_path.with_suffix('.Modelfile')
    modelfile.write_text(f'FROM {gguf_path}\n')
    try:
        proc = subprocess.run(
            ['ollama', 'create', name, '-f', str(modelfile)],
            capture_output=True, text=True, timeout=600,
        )
        if proc.returncode == 0:
            return True, name
        return False, (proc.stderr or proc.stdout or 'ollama create failed')[:300]
    except FileNotFoundError:
        return False, 'Ollama is not installed on this machine'
    except Exception as e:
        return False, str(e)[:300]


def _download_worker(dl_id: str, repo: str, parts: list, category: str,
                     import_ollama: bool):
    dest_dir = _target_dir(category)
    combined = dest_dir / _slug(parts[0].split('/')[-1]) if len(parts) > 1 else dest_dir / _slug(parts[0])
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        total_size = 0
        done = 0
        for fname in parts:
            url = HF_RESOLVE.format(repo=repo, file=fname)
            dest = dest_dir / _slug(fname)
            part_path = dest.with_suffix(dest.suffix + '.part')
            with _requests.get(url, stream=True, timeout=30) as r:
                r.raise_for_status()
                total_size += int(r.headers.get('content-length') or 0)
                with _download_lock:
                    _downloads[dl_id].update({'total_bytes': total_size,
                                              'state': 'downloading'})
                with open(part_path, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=1024 * 256):
                        if _downloads.get(dl_id, {}).get('state') == 'cancelling':
                            break
                        f.write(chunk)
                        done += len(chunk)
                        with _download_lock:
                            _downloads[dl_id]['done_bytes'] = done
            if _downloads.get(dl_id, {}).get('state') == 'cancelling':
                part_path.unlink(missing_ok=True)
                with _download_lock:
                    _downloads[dl_id]['state'] = 'cancelled'
                return
            part_path.rename(dest)

        # Split GGUF archives are byte-concatenable: merge into one file
        if len(parts) > 1:
            with _download_lock:
                _downloads[dl_id]['state'] = 'importing'
            with open(combined, 'wb') as out:
                for fname in parts:
                    src = dest_dir / _slug(fname)
                    with open(src, 'rb') as f:
                        while True:
                            chunk = f.read(1024 * 1024)
                            if not chunk:
                                break
                            out.write(chunk)
                    src.unlink(missing_ok=True)
            final = combined
        else:
            final = dest_dir / _slug(parts[0])
            with _download_lock:
                _downloads[dl_id].update({'state': 'importing', 'path': str(final)})

        with _download_lock:
            _downloads[dl_id].update({'path': str(final)})
        if category == 'chat' and import_ollama:
            ok, detail = _ollama_import(final, _slug(final.name).split('.gguf')[0].lower())
            with _download_lock:
                _downloads[dl_id].update({
                    'state': 'done',
                    'ollama': detail if ok else None,
                    'ollama_error': None if ok else detail,
                })
            return
        with _download_lock:
            _downloads[dl_id]['state'] = 'done'
    except Exception as e:
        with _download_lock:
            _downloads[dl_id].update({'state': 'error', 'error': str(e)[:300]})


# ─── Routes ───────────────────────────────────────────────────────

_catalog_cache = {'ts': 0.0, 'data': None}

@bp.route('/api/models/specs')
def models_specs():
    return jsonify({'specs': get_specs()})


@bp.route('/api/models/catalog')
def models_catalog():
    """Curated catalog, scored against this machine's real hardware.

    Repos are fetched in parallel so one slow repo can't hang the
    screen; results are cached for 10 minutes."""
    now = time.time()
    if _catalog_cache['data'] is not None and now - _catalog_cache['ts'] < 600:
        return jsonify(_catalog_cache['data'])

    specs = get_specs()
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        analyses = list(pool.map(
            lambda entry: {**entry,
                           **analyze_repo(entry['repo'], entry['category'], specs)},
            CATALOG))
    payload = {'specs': specs, 'catalog': analyses}
    _catalog_cache['data'] = payload
    _catalog_cache['ts'] = now
    return jsonify(payload)


@bp.route('/api/models/analyze', methods=['POST'])
@limiter.limit("10 per minute")
def models_analyze():
    """Score any HuggingFace repo pasted by the user."""
    data = request.get_json(silent=True) or {}
    repo = str(data.get('repo', '')).strip()
    category = str(data.get('category', 'chat')).strip()
    if not REPO_PATTERN.match(repo):
        return jsonify({'error': 'invalid HuggingFace repo name (owner/repo)'}), 400
    if category not in ('chat', 'image', 'video', 'music'):
        category = 'chat'
    return jsonify(analyze_repo(repo, category, get_specs()))


@bp.route('/api/models/download', methods=['POST'])
@limiter.limit("3 per hour")
def models_download():
    """Start a background download into the right app folder."""
    data = request.get_json(silent=True) or {}
    repo = str(data.get('repo', '')).strip()
    fname = str(data.get('file', '')).strip()
    file_list = data.get('files')
    category = str(data.get('category', 'chat')).strip()
    import_ollama = bool(data.get('import_ollama', category == 'chat'))

    if not REPO_PATTERN.match(repo):
        return jsonify({'error': 'invalid repo name'}), 400
    if category not in ('chat', 'image', 'video', 'music'):
        return jsonify({'error': 'invalid category'}), 400

    specs = get_specs()
    analysis = analyze_repo(repo, category, specs)

    # Resolve what to download: explicit part list, or one file entry
    parts = []
    if isinstance(file_list, list) and file_list:
        parts = [str(f) for f in file_list]
        if not parts or not all(FILE_PATTERN.match(f) for f in parts):
            return jsonify({'error': 'invalid file list'}), 400
        total_gb = round(sum(
            next((f['size_gb'] for f in analysis.get('files', [])
                  if f['file'] == p), 0) for p in parts), 2)
        tier = 'runs-well'  # explicit lists are pre-approved by the UI
    elif fname:
        if not FILE_PATTERN.match(fname):
            return jsonify({'error': 'invalid file name'}), 400
        file_info = next((f for f in analysis.get('files', [])
                          if f['file'] == fname), None)
        if file_info is None:
            return jsonify({'error': 'file not found in that repo'}), 404
        if file_info['tier'] == 'too-big':
            return jsonify({'error': 'this model does not fit your hardware '
                                     f"({file_info['size_gb']} GB)"}), 409
        parts = file_info.get('parts') or [fname]
        total_gb = file_info['size_gb']
        tier = file_info['tier']
    else:
        return jsonify({'error': 'file or files required'}), 400

    dl_id = f'{int(time.time())}-{_slug(repo)[:16]}-{_slug(parts[0])[:24]}'
    with _download_lock:
        _downloads[dl_id] = {
            'id': dl_id, 'repo': repo, 'file': (fname or parts[0]), 'category': category,
            'state': 'queued', 'done_bytes': 0, 'total_bytes': int(total_gb * 1e9),
        }
    threading.Thread(target=_download_worker,
                     args=(dl_id, repo, parts, category, import_ollama),
                     daemon=True).start()
    return jsonify({'ok': True, 'download_id': dl_id})


@bp.route('/api/models/downloads')
def models_downloads():
    with _download_lock:
        items = [dict(d) for d in _downloads.values()]
    return jsonify({'downloads': items})


@bp.route('/api/models/downloads/<dl_id>/cancel', methods=['POST'])
def models_cancel(dl_id):
    if not re.match(r'^[0-9A-Za-z-]+$', dl_id):
        return jsonify({'error': 'bad id'}), 400
    with _download_lock:
        dl = _downloads.get(dl_id)
        if not dl:
            return jsonify({'error': 'not found'}), 404
        if dl['state'] in ('queued', 'downloading'):
            dl['state'] = 'cancelling'
    return jsonify({'ok': True})
