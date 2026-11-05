"""Ollama model management and chat routes."""
from flask import Blueprint, jsonify, request, Response, stream_with_context
import json
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path
from shared import _requests, OLLAMA_URL, LLM_MODEL, BASE_DIR

bp = Blueprint('ollama', __name__)
CHATS_DIR = Path(os.environ.get('DECLOUD_CHATS_DIR', BASE_DIR / 'data' / 'chats')).expanduser()
_generations = {}
_generations_lock = threading.Lock()


def _chat_path(chat_id):
    if not isinstance(chat_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', chat_id):
        return None
    return CHATS_DIR / (chat_id + '.json')


@bp.route('/api/ollama/chats')
def chats_list():
    chats = []
    for path in CHATS_DIR.glob('*.json'):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if _chat_path(path.stem) and isinstance(data, dict):
                chats.append({'id': path.stem, 'title': str(data.get('title') or 'Untitled')[:120],
                              'updated': data.get('updated', 0)})
        except (OSError, ValueError, TypeError):
            continue
    chats.sort(key=lambda c: str(c['updated']), reverse=True)
    return jsonify({'chats': chats})


@bp.route('/api/ollama/chats/<chat_id>')
def chats_load(chat_id):
    path = _chat_path(chat_id)
    if not path:
        return jsonify({'error': 'invalid chat id'}), 400
    try:
        return jsonify(json.loads(path.read_text(encoding='utf-8')))
    except FileNotFoundError:
        return jsonify({'error': 'chat not found'}), 404
    except (OSError, ValueError):
        return jsonify({'error': 'could not read chat'}), 500


@bp.route('/api/ollama/chats', methods=['POST'])
def chats_save():
    data = request.get_json(silent=True) or {}
    chat_id = data.get('id') or uuid.uuid4().hex[:12]
    path = _chat_path(chat_id)
    messages = data.get('messages')
    if not path or not isinstance(messages, list) or len(messages) > 1000:
        return jsonify({'error': 'invalid chat'}), 400
    if any(not isinstance(m, dict) or m.get('role') not in ('user', 'assistant', 'system')
           or not isinstance(m.get('content'), str) for m in messages):
        return jsonify({'error': 'invalid messages'}), 400
    if sum(len(m['content']) for m in messages) > 2_000_000:
        return jsonify({'error': 'chat too long'}), 400
    now = time.time()
    created = now
    try:
        if path.exists():
            created = json.loads(path.read_text(encoding='utf-8')).get('created', now)
        CHATS_DIR.mkdir(parents=True, exist_ok=True)
        chat = {'id': chat_id, 'title': str(data.get('title') or 'Untitled')[:120],
                'model': str(data.get('model') or '')[:200], 'messages': messages,
                'created': created, 'updated': now}
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=CHATS_DIR, delete=False) as f:
            temp_name = f.name
            json.dump(chat, f, ensure_ascii=False)
        os.replace(temp_name, path)
        return jsonify(chat)
    except (OSError, ValueError):
        return jsonify({'error': 'could not save chat'}), 500

@bp.route('/api/ollama/models')
def ollama_models():
    """Models on every connected device (this host + paired lab devices)."""
    from .ai_devices import inventory
    inv = inventory(max_age=3)
    if not any(d['online'] for d in inv['devices']):
        return jsonify({'error': 'Ollama is not running on any device.', 'devices': inv['devices']}), 503
    models = [{**m, 'size_human': _format_model_size(m['size'])} for m in inv['models']]
    return jsonify({'models': models, 'devices': inv['devices']})

def _format_model_size(size):
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024:
            return f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} TB'

@bp.route('/api/ollama/chat', methods=['POST'])
def ollama_chat():
    """Stream chat completion from Ollama. Supports SSE-style streaming."""
    data = request.get_json(silent=True) or {}
    model = str(data.get('model') or LLM_MODEL)
    messages = data.get('messages', [])
    temperature = data.get('temperature', 0.7)
    top_p = data.get('top_p', 0.9)
    max_tokens = data.get('max_tokens', 0)  # 0 = unlimited

    # Input caps — this endpoint is exposed over the tunnel; without caps
    # a client could push unbounded payloads into a local LLM.
    if not isinstance(messages, list) or not messages:
        return jsonify({'error': 'messages must be a non-empty list'}), 400
    if len(messages) > 40:
        return jsonify({'error': 'too many messages (max 40)'}), 400
    total_chars = sum(len(str(m.get('content', ''))) for m in messages if isinstance(m, dict))
    if total_chars > 120_000:
        return jsonify({'error': 'conversation too long (max 120k chars)'}), 400
    if not (0 <= float(temperature) <= 2) or not (0 <= float(top_p) <= 1):
        return jsonify({'error': 'temperature (0-2) or top_p (0-1) out of range'}), 400
    if not (0 <= int(max_tokens) <= 32768):
        return jsonify({'error': 'max_tokens out of range (0-32768)'}), 400

    generation_id = str(data.get('generation_id') or uuid.uuid4().hex)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', generation_id):
        return jsonify({'error': 'invalid generation id'}), 400
    from .ai_devices import choose
    target, problem = choose(model, str(data.get('device') or 'auto'))
    if problem:
        return jsonify({'error': problem}), 409
    generation = {'cancelled': threading.Event(), 'response': None, 'target': target}
    with _generations_lock:
        if generation_id in _generations:
            return jsonify({'error': 'generation already exists'}), 409
        _generations[generation_id] = generation

    def generate():
        resp = None
        try:
            payload = {
                'model': model,
                'messages': messages,
                'stream': True,
                'options': {
                    'temperature': temperature,
                    'top_p': top_p,
                }
            }
            if max_tokens > 0:
                payload['options']['num_predict'] = max_tokens

            if generation['cancelled'].is_set():
                return
            yield f"data: {json.dumps({'device': target.name, 'device_id': target.id})}\n\n"
            resp = target.stream('/api/chat', payload, timeout=300)
            with _generations_lock:
                generation['response'] = resp
            if generation['cancelled'].is_set():
                return
            if resp.status != 200:
                detail = resp.error_text()
                yield f"data: {json.dumps({'error': f'Ollama error {resp.status} on {target.name}: {detail}'})}\n\n"
                return
            for line in resp.lines():
                if generation['cancelled'].is_set():
                    break
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                    if chunk.get('error'):
                        yield f"data: {json.dumps({'error': chunk['error']})}\n\n"
                        return
                    if chunk.get('message', {}).get('content'):
                        yield f"data: {json.dumps({'content': chunk['message']['content']})}\n\n"
                    if chunk.get('done'):
                        yield f"data: {json.dumps({'done': True})}\n\n"
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            if resp is not None:
                resp.close()
            with _generations_lock:
                _generations.pop(generation_id, None)

    return Response(stream_with_context(generate()), mimetype='text/event-stream')

@bp.route('/api/ollama/stop', methods=['POST'])
def ollama_stop():
    """Stop a running model generation."""
    data = request.get_json(silent=True) or {}
    generation_id = data.get('generation_id')
    generation = None
    if generation_id:
        with _generations_lock:
            generation = _generations.get(generation_id)
            if generation:
                generation['cancelled'].set()
                response = generation['response']
            else:
                response = None
        if response is not None:
            # Closing may wait on a network read: don't hold up the UI.
            threading.Thread(target=response.close, daemon=True).start()
    if generation:
        # Dropping the stream stops the generation; keep the model loaded so the
        # next message doesn't wait for a (possibly huge) model to load again.
        return jsonify({'ok': True})
    model = data.get('model', '')
    try:
        _requests.post(f'{OLLAMA_URL}/api/generate', json={'model': model, 'keep_alive': 0}, timeout=5)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 503
