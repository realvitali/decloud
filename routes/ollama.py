"""Ollama model management and chat routes."""
from flask import Blueprint, jsonify, request, Response, stream_with_context
import json
from shared import _requests, OLLAMA_URL, LLM_MODEL

bp = Blueprint('ollama', __name__)

@bp.route('/api/ollama/models')
def ollama_models():
    """List available Ollama models."""
    try:
        r = _requests.get(f'{OLLAMA_URL}/api/tags', timeout=5)
        data = r.json()
        models = []
        for m in data.get('models', []):
            models.append({
                'name': m['name'],
                'size': m.get('size', 0),
                'size_human': _format_model_size(m.get('size', 0)),
                'family': m.get('details', {}).get('family', 'unknown'),
            })
        return jsonify({'models': models})
    except Exception as e:
        return jsonify({'error': str(e)}), 503

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

    def generate():
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

            resp = _requests.post(f'{OLLAMA_URL}/api/chat', json=payload, stream=True, timeout=300)
            if resp.status_code != 200:
                detail = ''
                try:
                    detail = resp.json().get('error', '')
                except Exception:
                    detail = resp.text[:200]
                yield f"data: {json.dumps({'error': f'Ollama error {resp.status_code}: {detail or resp.reason}'})}\n\n"
                return
            for line in resp.iter_lines():
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

    return Response(stream_with_context(generate()), mimetype='text/event-stream')

@bp.route('/api/ollama/stop', methods=['POST'])
def ollama_stop():
    """Stop a running model generation."""
    data = request.get_json(silent=True) or {}
    model = data.get('model', '')
    try:
        _requests.post(f'{OLLAMA_URL}/api/generate', json={'model': model, 'keep_alive': 0}, timeout=5)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 503
