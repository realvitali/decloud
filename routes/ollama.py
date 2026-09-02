"""Ollama model management, server-side generation jobs, and chat storage routes."""
from flask import Blueprint, jsonify, request, Response, stream_with_context
import json
import os
import time
import uuid
import threading
from pathlib import Path
from shared import _requests, OLLAMA_URL, CHATS_DIR

bp = Blueprint('ollama', __name__)

# ─── In-memory job storage ──────────────────────────────────────
_OLLAMA_JOBS = {}              # job_id -> {chunks, done, error, cancelled, response, started, lock, cv}
_JOBS_LOCK = threading.Lock()

# ─── Helpers ────────────────────────────────────────────────────
def _format_model_size(size):
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024:
            return f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} TB'

def _prune_jobs():
    """Remove stale jobs older than 1800s and cap to 20 jobs."""
    now = time.time()
    with _JOBS_LOCK:
        # remove expired
        expired = [jid for jid, j in _OLLAMA_JOBS.items()
                   if now - j.get('started', 0) > 1800]
        for jid in expired:
            j = _OLLAMA_JOBS.pop(jid, None)
            if j and j.get('response'):
                try:
                    j['response'].close()
                except Exception:
                    pass
        # if still over 20, drop oldest
        if len(_OLLAMA_JOBS) > 20:
            sorted_ids = sorted(_OLLAMA_JOBS.items(), key=lambda kv: kv[1].get('started', 0))
            for jid, j in sorted_ids[:len(_OLLAMA_JOBS) - 20]:
                if j.get('response'):
                    try:
                        j['response'].close()
                    except Exception:
                        pass
                _OLLAMA_JOBS.pop(jid, None)

# ─── Model listing ──────────────────────────────────────────────
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

# ─── Server-side generation jobs (Part 1) ───────────────────────
def _run_ollama_job(job_id, model, messages, temperature, top_p, max_tokens):
    """Background worker: streams from Ollama, stores chunks in the job dict."""
    job = _OLLAMA_JOBS.get(job_id)
    if not job:
        return
    try:
        payload = {
            'model': model,
            'messages': messages,
            'stream': True,
            'options': {
                'temperature': temperature,
                'top_p': top_p,
                # Anti-degeneration: these stop the "this this and and and"
                # repetition loops and mashed/duplicated output that happen
                # when a model runs with no repeat penalty and a truncated
                # context window.
                'repeat_penalty': 1.15,
                'repeat_last_n': 256,
                'num_ctx': 8192,
            },
            # Keep the model resident so back-to-back turns don't pay a
            # full reload each time (the "takes forever" symptom).
            'keep_alive': '30m',
        }
        if max_tokens > 0:
            payload['options']['num_predict'] = max_tokens
        else:
            # Cap runaway generations so a repetition loop can't run forever.
            payload['options']['num_predict'] = 2048

        resp = _requests.post(f'{OLLAMA_URL}/api/chat', json=payload, stream=True, timeout=300)
        with job['lock']:
            job['response'] = resp
        if resp.status_code != 200:
            detail = ''
            try:
                detail = resp.json().get('error', '')
            except Exception:
                detail = resp.text[:200]
            with job['lock']:
                job['error'] = f'Ollama error {resp.status_code}: {detail or resp.reason}'
                job['done'] = True
                job['cv'].notify_all()
            return

        for line in resp.iter_lines():
            with job['lock']:
                if job['cancelled']:
                    break
            if not line:
                continue
            try:
                chunk = json.loads(line)
                if chunk.get('error'):
                    with job['lock']:
                        job['error'] = chunk['error']
                        job['done'] = True
                        job['cv'].notify_all()
                    return
                content = chunk.get('message', {}).get('content')
                if content:
                    entry = {'content': content}
                    # carry through token stats when present
                    if 'eval_count' in chunk:
                        entry['eval_count'] = chunk['eval_count']
                    if 'prompt_eval_count' in chunk:
                        entry['prompt_eval_count'] = chunk['prompt_eval_count']
                    if 'eval_duration' in chunk:
                        entry['eval_duration'] = chunk['eval_duration']
                    if 'total_duration' in chunk:
                        entry['total_duration'] = chunk['total_duration']
                    if 'load_duration' in chunk:
                        entry['load_duration'] = chunk['load_duration']
                    with job['lock']:
                        job['chunks'].append(entry)
                        job['cv'].notify_all()
                if chunk.get('done'):
                    done_entry = {'done': True}
                    for k in ('eval_count', 'prompt_eval_count', 'eval_duration',
                              'total_duration', 'load_duration'):
                        if k in chunk:
                            done_entry[k] = chunk[k]
                    with job['lock']:
                        job['chunks'].append(done_entry)
                        job['done'] = True
                        job['cv'].notify_all()
                    return
            except json.JSONDecodeError:
                continue
    except Exception as e:
        with job['lock']:
            job['error'] = str(e)
            job['done'] = True
            job['cv'].notify_all()
    finally:
        with job['lock']:
            job['done'] = True
            job['cv'].notify_all()


@bp.route('/api/ollama/chat', methods=['POST'])
def ollama_chat():
    """Start a server-side generation job. Returns job_id immediately."""
    _prune_jobs()
    data = request.get_json(silent=True) or {}
    model = data.get('model', 'qwen2.5:14b-instruct')
    messages = data.get('messages', [])
    temperature = data.get('temperature', 0.6)
    top_p = data.get('top_p', 0.9)
    max_tokens = data.get('max_tokens', 0)

    # Input caps — this endpoint is exposed over the tunnel; without caps
    # a client could push unbounded payloads into a local LLM.
    if not isinstance(messages, list) or not messages:
        return jsonify({'error': 'messages must be a non-empty list'}), 400
    if len(messages) > 200:
        return jsonify({'error': 'too many messages (max 200)'}), 400
    total_chars = sum(len(str(m.get('content', ''))) for m in messages if isinstance(m, dict))
    if total_chars > 120_000:
        return jsonify({'error': 'conversation too long (max 120k chars)'}), 400
    try:
        if not (0 <= float(temperature) <= 2) or not (0 <= float(top_p) <= 1):
            return jsonify({'error': 'temperature (0-2) or top_p (0-1) out of range'}), 400
        if not (0 <= int(max_tokens) <= 32768):
            return jsonify({'error': 'max_tokens out of range (0-32768)'}), 400
    except (TypeError, ValueError):
        return jsonify({'error': 'invalid numeric parameter'}), 400

    job_id = uuid.uuid4().hex[:12]
    job = {
        'chunks': [],
        'done': False,
        'error': None,
        'cancelled': False,
        'response': None,
        'started': time.time(),
        'lock': threading.Lock(),
        'cv': threading.Condition(job['lock']) if False else None,  # placeholder
    }
    # use a proper condition variable sharing the job's lock
    lock = threading.Lock()
    cv = threading.Condition(lock)
    job['lock'] = lock
    job['cv'] = cv

    with _JOBS_LOCK:
        _OLLAMA_JOBS[job_id] = job

    t = threading.Thread(
        target=_run_ollama_job,
        args=(job_id, model, messages, temperature, top_p, max_tokens),
        daemon=True,
    )
    t.start()

    return jsonify({'job_id': job_id})


@bp.route('/api/ollama/chat/stream/<job_id>')
def ollama_chat_stream(job_id):
    """SSE stream: replay buffered chunks from ?from=INDEX, then stream live."""
    job = _OLLAMA_JOBS.get(job_id)
    if not job:
        return jsonify({'error': 'job not found'}), 404

    from_idx = request.args.get('from', default=0, type=int)
    deadline = time.time() + 600

    def generate():
        idx = from_idx
        while True:
            # snapshot chunks under lock
            with job['lock']:
                # replay any buffered chunks from idx
                while idx < len(job['chunks']):
                    chunk = job['chunks'][idx]
                    idx += 1
                    yield f"data: {json.dumps(chunk)}\n\n"
                # check termination
                if job['done'] or job['error'] or job['cancelled']:
                    if job['error']:
                        yield f"data: {json.dumps({'error': job['error']})}\n\n"
                    if job['cancelled']:
                        yield f"data: {json.dumps({'cancelled': True})}\n\n"
                    yield f"data: {json.dumps({'done': True})}\n\n"
                    return
                # wait for new chunks (or completion) with deadline
                remaining = deadline - time.time()
                if remaining <= 0:
                    yield f"data: {json.dumps({'error': 'stream timeout'})}\n\n"
                    yield f"data: {json.dumps({'done': True})}\n\n"
                    return
                job['cv'].wait(timeout=min(remaining, 5))

    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@bp.route('/api/ollama/chat/status/<job_id>')
def ollama_chat_status(job_id):
    """Return current status of a generation job."""
    job = _OLLAMA_JOBS.get(job_id)
    if not job:
        return jsonify({'error': 'job not found'}), 404
    with job['lock']:
        return jsonify({
            'done': job['done'],
            'chunks': len(job['chunks']),
            'error': job['error'],
            'cancelled': job['cancelled'],
        })


@bp.route('/api/ollama/chat/cancel/<job_id>', methods=['POST'])
def ollama_chat_cancel(job_id):
    """Cancel a running generation job and close the Ollama response."""
    job = _OLLAMA_JOBS.get(job_id)
    if not job:
        return jsonify({'error': 'job not found'}), 404
    with job['lock']:
        job['cancelled'] = True
        job['done'] = True
        resp = job.get('response')
        job['cv'].notify_all()
    if resp:
        try:
            resp.close()
        except Exception:
            pass
    return jsonify({'ok': True})


@bp.route('/api/ollama/stop', methods=['POST'])
def ollama_stop():
    """Stop a running model (unload from memory via keep_alive=0)."""
    data = request.get_json(silent=True) or {}
    model = data.get('model', '')
    try:
        _requests.post(f'{OLLAMA_URL}/api/generate',
                       json={'model': model, 'keep_alive': 0}, timeout=5)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 503


# ─── Chat storage routes (Part 2) ────────────────────────────────
def _valid_chat_id(chat_id):
    """Reject path traversal attempts; only allow safe filename characters."""
    if not chat_id:
        return False
    if '/' in chat_id or '..' in chat_id or '\\' in chat_id:
        return False
    if chat_id in ('.', '..'):
        return False
    # allow alphanumerics, dash, underscore
    return all(c.isalnum() or c in '-_' for c in chat_id)


def _chat_path(chat_id):
    """Return the filesystem path for a chat ID."""
    return CHATS_DIR / f'{chat_id}.json'


def _load_chat_file(path):
    """Read a chat JSON file and return its contents."""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _save_chat_file(path, data):
    """Write a chat JSON file."""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@bp.route('/api/ollama/chats')
def chats_list():
    """List all saved chats, sorted by updated descending."""
    try:
        chats = []
        for p in CHATS_DIR.glob('*.json'):
            try:
                data = _load_chat_file(p)
                chats.append({
                    'id': data.get('id', p.stem),
                    'title': data.get('title', ''),
                    'model': data.get('model', ''),
                    'created': data.get('created', 0),
                    'updated': data.get('updated', 0),
                    'message_count': len(data.get('messages', [])),
                })
            except Exception:
                continue
        chats.sort(key=lambda c: c.get('updated', 0), reverse=True)
        return jsonify({'chats': chats})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/ollama/chats/<chat_id>')
def chats_load(chat_id):
    """Load a specific chat by ID."""
    if not _valid_chat_id(chat_id):
        return jsonify({'error': 'invalid chat id'}), 400
    path = _chat_path(chat_id)
    if not path.exists():
        return jsonify({'error': 'chat not found'}), 404
    try:
        data = _load_chat_file(path)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/ollama/chats', methods=['POST'])
def chats_save():
    """Create or save a chat. Generates an ID if not provided."""
    data = request.get_json(silent=True) or {}
    chat_id = data.get('id')
    if not chat_id:
        chat_id = uuid.uuid4().hex[:12]
    if not _valid_chat_id(chat_id):
        return jsonify({'error': 'invalid chat id'}), 400

    now = time.time()
    path = _chat_path(chat_id)

    # preserve created timestamp if file already exists
    created = now
    if path.exists():
        try:
            old = _load_chat_file(path)
            created = old.get('created', now)
        except Exception:
            pass

    chat_data = {
        'id': chat_id,
        'title': data.get('title', ''),
        'model': data.get('model', ''),
        'messages': data.get('messages', []),
        'created': created,
        'updated': now,
    }
    try:
        _save_chat_file(path, chat_data)
        return jsonify(chat_data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/ollama/chats/<chat_id>', methods=['PUT'])
def chats_rename(chat_id):
    """Rename a chat (update its title)."""
    if not _valid_chat_id(chat_id):
        return jsonify({'error': 'invalid chat id'}), 400
    path = _chat_path(chat_id)
    if not path.exists():
        return jsonify({'error': 'chat not found'}), 404
    data = request.get_json(silent=True) or {}
    title = data.get('title')
    if title is None:
        return jsonify({'error': 'title required'}), 400
    try:
        chat_data = _load_chat_file(path)
        chat_data['title'] = title
        chat_data['updated'] = time.time()
        _save_chat_file(path, chat_data)
        return jsonify(chat_data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/ollama/chats/<chat_id>', methods=['DELETE'])
def chats_delete(chat_id):
    """Soft delete a chat (unlink the file)."""
    if not _valid_chat_id(chat_id):
        return jsonify({'error': 'invalid chat id'}), 400
    path = _chat_path(chat_id)
    if not path.exists():
        return jsonify({'error': 'chat not found'}), 404
    try:
        os.unlink(path)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/ollama/chats/<chat_id>/nuke', methods=['POST'])
def chats_nuke(chat_id):
    """Irrecoverably delete a chat via shred -u, falling back to unlink."""
    if not _valid_chat_id(chat_id):
        return jsonify({'error': 'invalid chat id'}), 400
    path = _chat_path(chat_id)
    if not path.exists():
        return jsonify({'error': 'chat not found'}), 404
    try:
        import subprocess
        result = subprocess.run(
            ['shred', '-u', str(path)],
            capture_output=True, timeout=10,
        )
        if result.returncode != 0:
            # fallback to unlink if shred fails or not available
            os.unlink(path)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/ollama/chats/<chat_id>/title', methods=['POST'])
def chats_autogen_title(chat_id):
    """Auto-generate a concise title from the conversation via a small model.

    Uses the configured title model (settings.json → title_model), falling back
    to the chat's model, then DECLOUD_LLM_MODEL. A small model (3b or under) is
    recommended for speed.
    """
    if not _valid_chat_id(chat_id):
        return jsonify({'error': 'invalid chat id'}), 400
    path = _chat_path(chat_id)
    if not path.exists():
        return jsonify({'error': 'chat not found'}), 404

    try:
        chat_data = _load_chat_file(path)
        messages = chat_data.get('messages', [])

        # Build a compact transcript of the conversation (last N turns).
        turns = [m for m in messages if m.get('role') in ('user', 'assistant') and m.get('content')]
        if not turns:
            return jsonify({'error': 'no messages found'}), 400
        # Use the first user message plus a few recent turns for context.
        first_user = next((m['content'] for m in turns if m['role'] == 'user'), '')
        if not first_user:
            return jsonify({'error': 'no user message found'}), 400
        recent = turns[-6:]
        transcript = '\n'.join(
            f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content'][:200]}"
            for m in recent
        )

        # Resolve the title model: configured setting → chat model → env default.
        title_model = ''
        try:
            from shared import SETTINGS_FILE
            if SETTINGS_FILE.exists():
                title_model = json.loads(SETTINGS_FILE.read_text()).get('title_model', '')
        except Exception:
            pass
        if not title_model:
            title_model = chat_data.get('model') or os.environ.get('DECLOUD_LLM_MODEL', 'llama3.2')

        prompt = (
            'Write a short title (3-6 words) for this conversation. '
            'Reply with ONLY the title, no quotes, no punctuation, no explanation.\n\n'
            f'Conversation:\n{transcript}'
        )
        try:
            resp = _requests.post(
                f'{OLLAMA_URL}/api/chat',
                json={
                    'model': title_model,
                    'messages': [{'role': 'user', 'content': prompt}],
                    'stream': False,
                    'options': {'temperature': 0.3, 'num_predict': 30},
                },
                timeout=30,
            )
            if resp.status_code == 200:
                title = resp.json().get('message', {}).get('content', '').strip()
                title = title.split('\n')[0].strip().strip('"\'`.,!?')
                words = title.split()
                if len(words) > 6:
                    title = ' '.join(words[:6])
                if not title:
                    title = 'Untitled Chat'
            else:
                return jsonify({'error': f'Ollama error: {resp.status_code}'}), 502
        except Exception as e:
            return jsonify({'error': f'Ollama request failed: {e}'}), 502

        chat_data['title'] = title
        chat_data['updated'] = time.time()
        _save_chat_file(path, chat_data)
        return jsonify({'title': title})
    except Exception as e:
        return jsonify({'error': str(e)}), 500