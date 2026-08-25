"""Music generation routes (local MiniMax Music 3 via ComfyUI).

The heavy lifting happens in the user's own ComfyUI (the same local
server DeCloud already uses for image generation), running the open
weights of MiniMax Music 3. DeCloud queues the user's workflow, polls
for completion, copies the finished audio into its own library, and
keeps a local history index so past songs are always browsable.

Workflow handling is generic: the user exports their working
MiniMax Music 3 workflow from ComfyUI ("Save (API format)") and drops
it in the app directory as `musicgen_workflow.json` (or sets
DECLOUD_MUSICGEN_WORKFLOW). Text inputs are patched by keyword
(prompt/lyrics/text/style), an instrumental flag by keyword, and the
audio save node's filename_prefix is set so output is recognizable.
No node class names are hardcoded, so it survives workflow updates.
"""
from flask import Blueprint, jsonify, request, send_file
import json
import os
import re
import time
from pathlib import Path

from shared import app, limiter, BASE_DIR, _requests, COMFY_URL, COMFY_OUTPUT

bp = Blueprint('musicgen', __name__)

# ─── Config ───────────────────────────────────────────────────────
MUSICGEN_DIR = Path(os.path.expandvars(os.path.expanduser(
    os.environ.get('DECLOUD_MUSICGEN_DIR', '~/Music/decloud-generated'))))
MUSICGEN_INDEX = MUSICGEN_DIR / 'index.json'

WORKFLOW_FILE = Path(os.path.expandvars(os.path.expanduser(
    os.environ.get('DECLOUD_MUSICGEN_WORKFLOW',
                   str(BASE_DIR / 'musicgen_workflow.json')))))

AUDIO_EXTS = {'.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac'}

# In-flight generations: prompt_id -> {started, before_files, request}
_INFLIGHT: dict[str, dict] = {}


def _ensure_dir() -> bool:
    """Create the library dir lazily; read-only homes degrade gracefully."""
    try:
        MUSICGEN_DIR.mkdir(parents=True, exist_ok=True)
        return True
    except OSError:
        return False


def _load_index() -> list:
    if MUSICGEN_INDEX.exists():
        try:
            data = json.loads(MUSICGEN_INDEX.read_text())
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def _save_index(entries: list):
    if not _ensure_dir():
        return
    try:
        MUSICGEN_INDEX.write_text(json.dumps(entries, indent=2))
    except OSError:
        pass


def _load_workflow() -> dict:
    if not WORKFLOW_FILE.exists():
        return {}
    try:
        data = json.loads(WORKFLOW_FILE.read_text())
        if isinstance(data, dict) and 'nodes' in data:
            # ComfyUI UI-format export: convert to API format
            data = _ui_to_api(data)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _ui_to_api(ui_workflow: dict) -> dict:
    """Convert a ComfyUI UI-format workflow (with `nodes`) to API format."""
    out = {}
    for node in ui_workflow.get('nodes', []):
        node_id = str(node.get('id'))
        out[node_id] = {
            'class_type': node.get('type', ''),
            'inputs': {k: v for k, v in (node.get('widgets_values') or {}).items()},
        }
    return out


def _patch_workflow(workflow: dict, params: dict) -> dict:
    """Patch text/flag inputs generically by input-key keywords."""
    text_keys = ('prompt', 'lyrics', 'text', 'style', 'description', 'genre')
    patched = json.loads(json.dumps(workflow))
    for node in patched.values():
        inputs = node.get('inputs') or {}
        for key, value in list(inputs.items()):
            kl = key.lower()
            if kl in ('lyrics', 'lyric') and params.get('lyrics'):
                inputs[key] = params['lyrics']
            elif kl in ('prompt', 'text', 'description', 'genre', 'style'):
                if params.get('prompt'):
                    inputs[key] = params['prompt']
            elif kl == 'instrumental' and 'instrumental' in params:
                inputs[key] = bool(params['instrumental'])
            elif kl in ('duration', 'length', 'seconds', 'duration_seconds') and params.get('duration'):
                try:
                    inputs[key] = int(params['duration'])
                except (TypeError, ValueError):
                    pass
            elif kl in ('filename_prefix', 'prefix') and 'filename_prefix' in params:
                inputs[key] = params['filename_prefix']
            # Seed: always randomize unless the user pinned one
            if kl in ('seed', 'noise_seed'):
                inputs[key] = int(time.time() * 1000) % (2 ** 32)
    return patched


def _audio_duration_seconds(path: Path) -> float:
    try:
        from mutagen import File as MutagenFile
        info = MutagenFile(str(path))
        if info and info.info and getattr(info.info, 'length', None):
            return round(float(info.info.length), 1)
    except Exception:
        pass
    return 0.0


def _scan_audio_files() -> set:
    """Set of existing audio files in the ComfyUI output dir."""
    found = set()
    if COMFY_OUTPUT.exists():
        try:
            for f in COMFY_OUTPUT.iterdir():
                if f.is_file() and f.suffix.lower() in AUDIO_EXTS:
                    found.add(str(f))
        except OSError:
            pass
    return found


# ─── Routes ───────────────────────────────────────────────────────

@bp.route('/api/musicgen/status')
def musicgen_status():
    """ComfyUI reachability + workflow configuration + library size."""
    comfy_online = False
    try:
        r = _requests.get(f'{COMFY_URL}/system_stats', timeout=5)
        comfy_online = r.status_code == 200
    except Exception:
        comfy_online = False
    return jsonify({
        'comfy_online': comfy_online,
        'workflow_configured': WORKFLOW_FILE.exists() and bool(_load_workflow()),
        'workflow_path': str(WORKFLOW_FILE),
        'history_count': len(_load_index()),
        'library_dir': str(MUSICGEN_DIR),
    })


@bp.route('/api/musicgen/generate', methods=['POST'])
@limiter.limit("6 per hour")
def musicgen_generate():
    """Queue a music generation in the user's ComfyUI workflow."""
    data = request.get_json(silent=True) or {}
    prompt = str(data.get('prompt', '')).strip()
    lyrics = str(data.get('lyrics', '')).strip()
    instrumental = bool(data.get('instrumental', False))
    duration = data.get('duration')

    if not prompt and not lyrics:
        return jsonify({'error': 'Describe the song (prompt), or provide lyrics — or both'}), 400

    workflow = _load_workflow()
    if not workflow:
        return jsonify({
            'error': 'Music workflow is not configured yet. Export your '
                     'MiniMax Music 3 workflow from ComfyUI ("Save (API '
                     'format)") and place it at ' + str(WORKFLOW_FILE),
            'code': 'NO_WORKFLOW',
        }), 409

    params = {'prompt': prompt, 'lyrics': lyrics, 'instrumental': instrumental,
              'filename_prefix': 'decloud_music'}
    if duration:
        params['duration'] = duration
    api_workflow = _patch_workflow(workflow, params)

    try:
        r = _requests.post(f'{COMFY_URL}/prompt', json={'prompt': api_workflow},
                           timeout=15)
        result = r.json()
        if 'error' in result:
            return jsonify({'error': 'ComfyUI rejected the workflow: ' +
                                     json.dumps(result['error'])[:300]}), 400
        prompt_id = result.get('prompt_id', '')
        if not prompt_id:
            return jsonify({'error': 'ComfyUI returned no prompt id'}), 502
    except Exception as e:
        return jsonify({'error': f'Could not reach ComfyUI: {e}'}), 503

    _INFLIGHT[prompt_id] = {
        'started': time.time(),
        'before_files': _scan_audio_files(),
        'request': {'prompt': prompt, 'lyrics': lyrics, 'instrumental': instrumental},
    }
    return jsonify({'ok': True, 'prompt_id': prompt_id})


@bp.route('/api/musicgen/progress/<prompt_id>')
def musicgen_progress(prompt_id):
    """Poll ComfyUI; when done, collect the new audio into the library."""
    entry = _INFLIGHT.get(prompt_id)
    if not entry:
        return jsonify({'error': 'unknown generation'}), 404

    try:
        r = _requests.get(f'{COMFY_URL}/history/{prompt_id}', timeout=8)
        history = r.json()
    except Exception as e:
        return jsonify({'error': str(e)}), 503

    if prompt_id in history:
        h = history[prompt_id]
        status = h.get('status', {})
        if status.get('status_str') == 'error':
            _INFLIGHT.pop(prompt_id, None)
            return jsonify({'done': True, 'error': 'Generation failed in ComfyUI',
                            'status': status})

        # Collect newly created audio files from the output directory
        new_files = []
        current = _scan_audio_files()
        for f in sorted(current - entry['before_files']):
            if Path(f).stat().st_mtime >= entry['started']:
                new_files.append(Path(f))

        if not new_files:
            # Done but no audio found — report honestly
            _INFLIGHT.pop(prompt_id, None)
            return jsonify({'done': True, 'error':
                            'Generation finished but no audio file appeared in '
                            f'{COMFY_OUTPUT}. Check the workflow has an audio '
                            'save node.'})

        # Import into the library
        if not _ensure_dir():
            return jsonify({'error': 'cannot write to the music library '
                                     'directory'}), 500
        index = _load_index()
        imported = []
        for f in new_files:
            song_id = f.stem.replace(' ', '_')
            dest = MUSICGEN_DIR / f'{song_id}{f.suffix.lower()}'
            try:
                import shutil
                shutil.copy2(f, dest)
            except OSError as e:
                return jsonify({'error': f'could not save audio: {e}'}), 500
            meta = {
                'id': song_id,
                'file': dest.name,
                'prompt': entry['request']['prompt'],
                'lyrics': entry['request']['lyrics'],
                'instrumental': entry['request']['instrumental'],
                'duration_sec': _audio_duration_seconds(dest),
                'created': time.time(),
            }
            index.insert(0, meta)
            imported.append(meta)
        _save_index(index)
        _INFLIGHT.pop(prompt_id, None)
        return jsonify({'done': True, 'songs': imported})

    # Still queued/running
    try:
        r2 = _requests.get(f'{COMFY_URL}/queue', timeout=5)
        queue = r2.json()
        return jsonify({
            'done': False,
            'running': len(queue.get('queue_running', [])),
            'pending': len(queue.get('queue_pending', [])),
        })
    except Exception:
        return jsonify({'done': False, 'running': 0, 'pending': 0})


@bp.route('/api/musicgen/history')
def musicgen_history():
    """All previously generated songs, newest first."""
    return jsonify({'songs': _load_index()})


@bp.route('/api/musicgen/audio/<song_id>')
def musicgen_audio(song_id):
    """Stream a generated song from the local library."""
    if not re.match(r'^[A-Za-z0-9._-]+$', song_id):
        return jsonify({'error': 'bad id'}), 400
    for f in MUSICGEN_DIR.iterdir():
        if f.stem == song_id and f.suffix.lower() in AUDIO_EXTS:
            return send_file(str(f), mimetype='audio/mpeg' if f.suffix.lower() == '.mp3' else None)
    return jsonify({'error': 'song not found'}), 404


@bp.route('/api/musicgen/history/<song_id>', methods=['DELETE'])
def musicgen_delete(song_id):
    """Remove a song from the library and its history entry."""
    if not re.match(r'^[A-Za-z0-9._-]+$', song_id):
        return jsonify({'error': 'bad id'}), 400
    index = _load_index()
    index = [s for s in index if s.get('id') != song_id]
    _save_index(index)
    for f in MUSICGEN_DIR.iterdir():
        if f.stem == song_id and f.suffix.lower() in AUDIO_EXTS:
            try:
                f.unlink()
            except OSError:
                pass
    return jsonify({'ok': True})
