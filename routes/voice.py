"""Voice assistant routes: STT, TTS, and the voice brain (Hermes/LLM).
"""
from flask import Blueprint, jsonify, request, send_file, Response
import os, io, json, subprocess, uuid, re, tempfile, threading, shutil, time
from shared import (
    app, _requests, OLLAMA_URL,
    get_whisper_model, TTS_ENGINES, STT_ENGINES, limiter,
)
import shared

bp = Blueprint('voice', __name__)

@bp.route('/api/voice/stt', methods=['POST'])
def voice_stt():
    """Transcribe audio blob to text using faster-whisper."""
    try:
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({'error': 'No audio file provided'}), 400

        if shutil.which('ffmpeg') is None:
            return jsonify({
                'error': 'ffmpeg is not installed',
                'code': 'FFMPEG_MISSING',
                'hint': 'Whisper needs ffmpeg to decode audio. Run install.sh or `sudo apt install ffmpeg`.',
            }), 503

        model_name = request.form.get('model', 'base')

        # Save to temp wav file
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False, dir=tempfile.gettempdir()) as tmp:
            audio_file.save(tmp.name)
            tmp_path = tmp.name

        # Convert to wav 16kHz mono if needed (whisper handles webm but wav is safer)
        wav_path = tmp_path.rsplit('.', 1)[0] + '.wav'
        proc = subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_path, '-ar', '16000', '-ac', '1', '-f', 'wav', wav_path],
            capture_output=True, timeout=30
        )
        if proc.returncode != 0:
            try:
                os.unlink(tmp_path)
                if os.path.exists(wav_path):
                    os.unlink(wav_path)
            except OSError:
                pass
            return jsonify({'error': 'Audio decode failed: ' + (proc.stderr.decode() or 'unknown')}), 400

        model = get_whisper_model(STT_ENGINES.get(model_name, STT_ENGINES['whisper-base'])['model'])
        segments, info = model.transcribe(wav_path, beam_size=1, language='en')

        text = ' '.join(seg.text.strip() for seg in segments).strip()

        # Cleanup
        os.unlink(tmp_path)
        if os.path.exists(wav_path):
            os.unlink(wav_path)

        app.logger.info(f'[STT] model={model_name} duration={info.duration:.1f}s text="{text}"')
        return jsonify({'text': text, 'language': info.language, 'duration': info.duration})
    except Exception as e:
        app.logger.error(f'[STT] error: {e}')
        return jsonify({'error': 'Speech-to-text failed: ' + str(e), 'code': 'STT_ERROR'}), 500

@bp.route('/api/voice/tts', methods=['POST'])
def voice_tts():
    """Synthesize speech from text using Piper TTS."""
    try:
        data = request.get_json(silent=True) or {}
        text = data.get('text', '').strip()
        engine_id = data.get('engine', 'piper-lessac-high')

        if not text:
            return jsonify({'error': 'No text provided'}), 400

        engine = TTS_ENGINES.get(engine_id, TTS_ENGINES['piper-lessac-high'])

        if engine['engine'] == 'browser':
            return jsonify({'engine': 'browser', 'audio': None})

        # Clear, actionable failure reasons instead of a raw 500.
        model_path = engine['model']
        if not os.path.exists(model_path):
            return jsonify({
                'error': f'Voice model not installed: {os.path.basename(model_path)}',
                'code': 'VOICE_MODEL_MISSING',
                'hint': 'Download it in Settings → Voice.',
            }), 503
        if shared.piper_bin() == 'piper' or not os.path.exists(shared.piper_bin()):
            return jsonify({
                'error': 'Piper is not installed',
                'code': 'PIPER_MISSING',
                'hint': 'Re-run install.sh to bundle Piper, or pick Browser TTS in Settings → Voice.',
            }), 503

        config_path = model_path + '.json'

        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False, dir=tempfile.gettempdir()) as tmp:
            output_path = tmp.name

        proc = subprocess.run(
            [shared.piper_bin(), '-m', model_path, '-c', config_path, '-f', output_path],
            input=text.encode('utf-8'),
            capture_output=True,
            timeout=30
        )

        if proc.returncode != 0:
            return jsonify({'error': 'TTS failed: ' + (proc.stderr.decode() or proc.stdout.decode() or 'unknown error')}), 500

        # Read the WAV into memory and delete the temp file immediately so
        # repeated TTS calls don't leak files in /tmp.
        with open(output_path, 'rb') as f:
            audio_bytes = f.read()
        try:
            os.unlink(output_path)
        except OSError:
            pass

        return send_file(io.BytesIO(audio_bytes), mimetype='audio/wav', as_attachment=False,
                        download_name='tts.wav')
    except Exception as e:
        return jsonify({'error': 'TTS error: ' + str(e)}), 500

@bp.route('/api/voice/tts/stream', methods=['POST'])
def voice_tts_stream():
    """Stream TTS audio - returns audio bytes directly."""
    data = request.get_json(silent=True) or {}
    text = data.get('text', '').strip()
    engine_id = data.get('engine', 'piper-lessac-high')

    if not text:
        return jsonify({'error': 'No text provided'}), 400

    engine = TTS_ENGINES.get(engine_id, TTS_ENGINES['piper-lessac-high'])

    if engine['engine'] == 'browser':
        return jsonify({'engine': 'browser'})

    model_path = engine['model']
    if not os.path.exists(model_path):
        return jsonify({
            'error': f'Voice model not installed: {os.path.basename(model_path)}',
            'code': 'VOICE_MODEL_MISSING',
            'hint': 'Download it in Settings → Voice.',
        }), 503
    if shared.piper_bin() == 'piper' or not os.path.exists(shared.piper_bin()):
        return jsonify({
            'error': 'Piper is not installed',
            'code': 'PIPER_MISSING',
            'hint': 'Re-run install.sh to bundle Piper.',
        }), 503

    config_path = model_path + '.json'

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False, dir=tempfile.gettempdir()) as tmp:
        output_path = tmp.name

    proc = subprocess.run(
        [shared.piper_bin(), '-m', model_path, '-c', config_path, '-f', output_path],
        input=text.encode('utf-8'),
        capture_output=True,
        timeout=30
    )

    if proc.returncode != 0:
        return jsonify({'error': 'TTS failed: ' + (proc.stderr.decode() or 'unknown error')}), 500

    def generate():
        try:
            with open(output_path, 'rb') as f:
                while True:
                    chunk = f.read(4096)
                    if not chunk:
                        break
                    yield chunk
        finally:
            if os.path.exists(output_path):
                os.unlink(output_path)

    return Response(generate(), mimetype='audio/wav')

@bp.route('/api/voice/engines')
def voice_engines():
    """List available STT and TTS engines."""
    return jsonify({
        'stt': [{'id': k, 'name': v['name']} for k, v in STT_ENGINES.items()],
        'tts': [{'id': k, 'name': v['name']} for k, v in TTS_ENGINES.items()],
    })

@bp.route('/api/voice/intent', methods=['POST'])
def voice_intent():
    """Parse user speech into structured action using LLM (local or cloud)."""
    try:
        data = request.get_json(silent=True) or {}
        text = data.get('text', '').strip()
        model = data.get('model', '') or ''

        if not text:
            return jsonify({'error': 'No text provided'}), 400

        agent_name = shared.get_voice_config().get('agent_name', 'DeCloud')
        access = shared.get_voice_config().get('voice_access', 'basic')

        access_hint = {
            'talk': "You may read/view things and read system state, but you cannot change the system. Only use run_command for read-only commands like 'df -h', 'free -h', 'ps', 'ls', 'cat', 'nvidia-smi'.",
            'basic': "You may create files and make non-destructive changes (touch, mkdir, cp, mv, git, pip install, etc.), but never destructive commands (rm, dd, mkfs, shutdown, etc.).",
            'full': "You have full, unrestricted shell access — you may run any command, but every command must still set requires_confirmation=true.",
        }[access]

        # Conversational system prompt. The agent talks naturally but returns
        # a JSON object ONLY when it needs to control DeCloud. Built with a
        # plain string + replace because the JSON examples contain braces.
        system_prompt = """You are {agent_name}, the voice assistant for DeCloud — a self-hosted personal cloud app (music, audiobooks, files, AI chat, a terminal, and a system monitor).

You are speaking out loud, so be natural and conversational. Prefer short answers, but give real detail and substance when it helps — don't be terse or one-word. No markdown, no lists, no emojis, no follow-up questions. Just talk like a warm, capable person.

You can also control DeCloud. If the user asks you to DO something (play a song, open a book, navigate to a screen, run a command, search files), respond with a SINGLE JSON object describing the action — nothing else. Otherwise, just reply in plain conversational text.

Your current access level is "{access}": {access_hint}

Available actions (exact JSON shapes):
1. {"action": "navigate", "screen": "audiobooks|lego|chat|generate|home"}
2. {"action": "play_book", "title": "book name", "chapter": number_or_null}
3. {"action": "stop_playback"}
4. {"action": "pause_playback"}
5. {"action": "resume_playback"}
6. {"action": "run_command", "command": "shell command", "description": "what it does", "requires_confirmation": true}
7. {"action": "search_files", "query": "search term", "path": "optional path"}
8. {"action": "generate_image", "prompt": "description"}
9. {"action": "chat", "message": "what to ask the AI"}
10. {"action": "reset_conversation"}

Rules:
- run_command ALWAYS sets requires_confirmation=true and a plain-English "description".
- Dangerous commands (rm, shred, dd, mkfs, shutdown, reboot) add "dangerous": true.
- Only return JSON when the user wants an action. Otherwise reply conversationally.""".replace('{agent_name}', agent_name).replace('{access}', access).replace('{access_hint}', access_hint)

        # Persistent memory: full server-side history, not just the last 4.
        history = shared.load_voice_history()
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(history)
        messages.append({"role": "user", "content": text})

        # Route through the configured backend (local Ollama or cloud API).
        try:
            llm_text = shared.llm_complete(messages, temperature=0.7, model=model or None)
        except Exception as e:
            return _llm_error_response(e)

        # Parse a JSON action if the model returned one; otherwise treat the
        # output as a plain conversational reply.
        llm_text = (llm_text or '').strip()
        action = None
        try:
            candidate = re.sub(r'^```(?:json)?\s*', '', llm_text)
            candidate = re.sub(r'\s*```$', '', candidate)
            parsed = json.loads(candidate)
            if isinstance(parsed, dict) and 'action' in parsed:
                action = parsed
        except Exception:
            json_match = re.search(r'\{.*\}', llm_text, re.DOTALL)
            if json_match:
                try:
                    parsed = json.loads(json_match.group())
                    if isinstance(parsed, dict) and 'action' in parsed:
                        action = parsed
                except Exception:
                    action = None

        if action is None:
            action = {"action": "respond", "message": llm_text}

        # Persist the turn (unless the user asked to forget).
        if action.get('action') == 'reset_conversation':
            shared.reset_voice_history()
            action = {"action": "respond", "message": "Okay, I've forgotten everything. What can I do for you?"}
        else:
            new_history = history + [{"role": "user", "content": text}]
            reply = action.get('message') if action.get('action') in ('respond', 'chat') else ''
            if reply:
                new_history.append({"role": "assistant", "content": reply})
            elif action.get('action') == 'run_command':
                new_history.append({"role": "assistant", "content": f"[ran: {action.get('command', '')}]"})
            shared.save_voice_history(new_history)

        return jsonify({'action': action, 'raw_llm': llm_text})
    except Exception as e:
        app.logger.error(f'[INTENT] error: {e}')
        return jsonify({'error': str(e)}), 500


@bp.route('/api/voice/reset', methods=['POST'])
def voice_reset():
    """Forget the voice agent's conversation memory (both brains)."""
    shared.reset_voice_history()
    try:
        if VOICE_HERMES_SESSION.exists():
            VOICE_HERMES_SESSION.unlink()
    except Exception:
        pass
    return jsonify({'ok': True})

@bp.route('/api/voice/run_command', methods=['POST'])
@limiter.limit("20 per minute")
def voice_run_command():
    """Execute a shell command and return output. Used after user confirmation.

    Command access is tiered by the voice_access setting:
      - 'talk'  — read-only commands only (view system state, never change it)
      - 'basic' — non-destructive commands (create files, move/copy, git, etc.)
      - 'full'  — unrestricted (still confirmed per-command in the UI)
    """
    # Read-only commands: can inspect but never modify the system.
    # Note: commands like systemctl/tailscale/ip have mutating subcommands, so
    # they are NOT in the read-only set — they'd let 'talk' mode change state.
    READ_ONLY_COMMANDS = {
        'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'which',
        'date', 'cal', 'uptime', 'whoami', 'hostname', 'uname',
        'free', 'df', 'du', 'ps', 'top', 'nvidia-smi',
        'ss', 'ping', 'journalctl',
    }
    # Non-destructive commands: create/change things but reversible.
    # These are best-effort guardrails, NOT a hard security boundary — the
    # Terminal app already gives the owner full shell access. They exist so a
    # voice-initiated command can't trivially destroy data without the user
    # switching to Full access.
    NON_DESTRUCTIVE_COMMANDS = READ_ONLY_COMMANDS | {
        'touch', 'mkdir', 'cp', 'mv', 'ln', 'tar', 'zip', 'unzip',
        'rsync', 'scp', 'ssh', 'curl', 'wget', 'echo', 'printf',
        'git', 'gh', 'pip', 'uv', 'python3', 'python', 'npm',
        'ollama', 'systemctl', 'tailscale', 'ip',
    }
    # Catastrophic patterns blocked in 'talk' and 'basic' modes.
    DANGEROUS_PATTERNS = [
        r'rm\s', r'mv\s.*\s/', r'cp\s.*\s/',
        r'>\s*/dev/sd', r'mkfs', r'dd\s+if=', r'shutdown', r'reboot',
        r'chmod\s+777', r'chown\s+',
        r':\(\)\s*\{', r'fork\s*bomb',
        r'curl.*\|\s*sh', r'wget.*\|\s*sh',
        r'eval\s', r'exec\s',
        r'python3?\s+-c', r'python3?\s*-c',  # inline python can delete data
    ]

    try:
        data = request.get_json(silent=True) or {}
        command = data.get('command', '').strip()

        if not command:
            return jsonify({'error': 'No command provided'}), 400

        # Extract the base command (first word, before any arguments)
        base_cmd = command.split()[0] if command.split() else ''
        base_cmd = base_cmd.split('/')[-1]

        access = shared.get_voice_config().get('voice_access', 'basic')

        if access == 'talk':
            if base_cmd not in READ_ONLY_COMMANDS:
                return jsonify({
                    'error': f'"{base_cmd}" can change the system, which is not allowed in Talk mode.',
                    'code': 'ACCESS_DENIED',
                    'hint': 'Switch the voice agent to Basic or Full access in Settings → Voice to run it.',
                }), 403
        elif access == 'basic':
            if base_cmd not in NON_DESTRUCTIVE_COMMANDS:
                return jsonify({
                    'error': f'"{base_cmd}" is destructive, which is not allowed in Basic mode.',
                    'code': 'ACCESS_DENIED',
                    'hint': 'Switch the voice agent to Full access in Settings → Voice to run it.',
                }), 403

        # Catastrophic safety net for talk/basic (full mode is unrestricted).
        if access != 'full':
            for pat in DANGEROUS_PATTERNS:
                if re.search(pat, command):
                    return jsonify({'error': 'Blocked: command matches a dangerous pattern'}), 403

        # Run with timeout — no shell=True, use list form
        import shlex
        cmd_list = shlex.split(command)
        proc = subprocess.run(
            cmd_list,
            capture_output=True,
            text=True,
            timeout=30
        )

        output = proc.stdout
        if proc.returncode != 0 and proc.stderr:
            output = output + '\n' + proc.stderr if output else proc.stderr

        return jsonify({
            'command': command,
            'output': output[:5000],
            'exit_code': proc.returncode,
        })
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Command timed out (30s limit)'}), 504
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─── Hermes-native voice brain (persistent session) ──────────────

def _hermes_bin():
    """Locate the hermes CLI: $DECLOUD_HERMES_HOME/hermes-agent/venv/bin/hermes
    (or ~/.hermes by default), falling back to PATH."""
    home = os.environ.get('DECLOUD_HERMES_HOME', '').rstrip('/') or os.path.expanduser('~/.hermes')
    cand = os.path.join(home, 'hermes-agent', 'venv', 'bin', 'hermes')
    if os.path.exists(cand):
        return cand
    return shutil.which('hermes') or ''


def _hermes_available():
    return bool(_hermes_bin())


VOICE_HERMES_SESSION = shared.BASE_DIR / 'voice_hermes_session.txt'


def _load_hermes_session():
    try:
        if VOICE_HERMES_SESSION.exists():
            return VOICE_HERMES_SESSION.read_text().strip()
    except Exception:
        pass
    return ''


def _save_hermes_session(sid):
    if sid:
        try:
            VOICE_HERMES_SESSION.write_text(sid)
        except Exception:
            pass


VOICE_HERMES_SYSTEM = (
    "You're speaking out loud, so be natural and conversational. Prefer short "
    "answers, but give real detail and substance when it helps — don't be terse "
    "or one-word. No markdown, no lists, no emojis, no follow-up questions. "
    "Just talk like a warm, capable person.\n\n"
)


def hermes_chat(text, timeout=180):
    """Drive Hermes natively with a persistent session on the local model."""
    bin_path = _hermes_bin()
    if not bin_path:
        raise RuntimeError('Hermes is not installed. Set DECLOUD_HERMES_HOME in .env.')
    cfg = shared.get_voice_config()
    model = cfg.get('llm_local_model') or 'gemma4:26b'
    provider = os.environ.get('DECLOUD_HERMES_PROVIDER', 'custom')
    session_id = _load_hermes_session()

    cmd = [bin_path, 'chat', '--query-file', '-', '-Q', '-m', model, '--provider', provider]
    if session_id:
        cmd += ['--resume', session_id, '--no-restore-cwd']

    try:
        r = subprocess.run(cmd, input=VOICE_HERMES_SYSTEM + text, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Hermes took too long to reply')

    for line in (r.stderr or '').splitlines():
        if line.startswith('session_id:'):
            _save_hermes_session(line.split(':', 1)[1].strip())

    out = (r.stdout or '').strip()
    if not out:
        return '(no reply)'
    # Drop Hermes status/warning lines and keep the actual reply text.
    lines = []
    for line in out.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith(('Warning:', '↪', '⚠')):
            continue
        lines.append(s)
    return '\n'.join(lines) or '(no reply)'


@bp.route('/api/voice/chat', methods=['POST'])
def voice_chat():
    """Chat with the voice brain. Uses Hermes natively (persistent session)
    when available; otherwise falls back to the simple LLM backend so the
    voice agent always works out of the box."""
    data = request.get_json(silent=True) or {}
    text = data.get('text', '').strip()
    if not text:
        return jsonify({'error': 'No text provided'}), 400

    # 1. Prefer Hermes when available.
    if _hermes_available():
        try:
            return jsonify({'reply': hermes_chat(text), 'brain': 'hermes'})
        except Exception as e:
            app.logger.warning(f'[VOICE] Hermes failed, falling back to LLM: {e}')

    # 2. Fallback: simple LLM brain (Ollama/cloud) with persistent memory.
    try:
        reply = _simple_llm_chat(text)
    except Exception as e:
        return _llm_error_response(e)

    history = shared.load_voice_history()
    shared.save_voice_history(history + [
        {"role": "user", "content": text},
        {"role": "assistant", "content": reply},
    ])
    return jsonify({'reply': reply, 'brain': 'llm'})


SIMPLE_SYSTEM = (
    "You are {name}, the voice assistant for DeCloud — a self-hosted personal "
    "cloud app. You're speaking out loud, so be natural and conversational. "
    "Prefer short answers, but give real detail and substance when it helps. "
    "No markdown, no lists, no emojis, no follow-up questions. Just talk like "
    "a warm, capable person."
)


def _simple_llm_chat(text, timeout=120):
    agent_name = shared.get_voice_config().get('agent_name', 'DeCloud')
    system = SIMPLE_SYSTEM.replace('{name}', agent_name)
    history = shared.load_voice_history()
    messages = [{"role": "system", "content": system}]
    messages.extend(history)
    messages.append({"role": "user", "content": text})
    return shared.llm_complete(messages, temperature=0.7, timeout=timeout)


def _ollama_version():
    """Return the Ollama version string if the server responds, else None."""
    try:
        resp = _requests.get(f'{OLLAMA_URL}/api/version', timeout=3)
        if resp.status_code == 200:
            return resp.json().get('version', 'unknown')
    except Exception:
        pass
    return None


def _ollama_models():
    """Return list of installed Ollama model names."""
    try:
        resp = _requests.get(f'{OLLAMA_URL}/api/tags', timeout=5)
        if resp.status_code == 200:
            return [m.get('name', '') for m in resp.json().get('models', [])]
    except Exception:
        pass
    return []


def _piper_available():
    """Piper TTS is available if the binary exists and a voice model is present."""
    bin_path = shared.piper_bin()
    if bin_path == 'piper' or not os.path.exists(bin_path):
        return False
    cfg = shared.get_voice_config()
    model = TTS_ENGINES.get(cfg.get('tts'), TTS_ENGINES['piper-lessac-high'])['model']
    return model is not None and os.path.exists(model)


def _tts_installed(engine_id):
    """Whether a given TTS engine can actually run (browser always can)."""
    engine = TTS_ENGINES.get(engine_id)
    if not engine or engine['engine'] == 'browser':
        return True
    return bool(engine['model']) and os.path.exists(engine['model'])


def _whisper_available():
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _api_key_status():
    key = os.environ.get('DECLOUD_LLM_API_KEY', '').strip()
    if not key:
        return {'set': False, 'hint': ''}
    hint = key[:4] + '…' + key[-4:] if len(key) > 8 else '••••'
    return {'set': True, 'hint': hint}


def _llm_error_response(e):
    """Map an exception from llm_complete() to a clear, actionable response."""
    err = str(e)
    if 'No API key' in err:
        return jsonify({'error': err, 'code': 'API_KEY_MISSING',
                        'hint': 'Add a cloud API key in Settings → Voice.'}), 503
    if any(k in err for k in ('Connection', 'Max retries', 'ConnectionRefused', 'getaddrinfo', 'Name or service')):
        return jsonify({'error': 'Local AI (Ollama) is not running or unreachable',
                        'code': 'OLLAMA_DOWN',
                        'hint': 'Start it: sudo systemctl start ollama'}), 503
    if 'not found' in err.lower() and 'model' in err.lower():
        return jsonify({'error': err, 'code': 'MODEL_NOT_FOUND',
                        'hint': 'Download that model in Settings → Voice.'}), 503
    if '500' in err or '502' in err or '503' in err:
        return jsonify({'error': 'The AI service returned an error: ' + err,
                        'code': 'LLM_UPSTREAM'}), 502
    return jsonify({'error': 'AI error: ' + err, 'code': 'LLM_ERROR'}), 502


@bp.route('/api/voice/status', methods=['GET'])
def voice_status():
    """Read-only capability report for the settings panel + setup wizard."""
    cfg = shared.get_voice_config()
    return jsonify({
        'config': cfg,
        'ollama': {
            'installed': shutil.which('ollama') is not None,
            'running': _ollama_version() is not None,
            'version': _ollama_version(),
        },
        'models': _ollama_models(),
        'model_suggestions': shared.LLM_MODEL_SUGGESTIONS,
        'whisper_available': _whisper_available(),
        'piper_available': _piper_available(),
        'api_key': _api_key_status(),
        'hermes': {
            'available': _hermes_available(),
            'bin': _hermes_bin() or '',
            'home': os.environ.get('DECLOUD_HERMES_HOME', '').rstrip('/') or os.path.expanduser('~/.hermes'),
        },
        'engines': {
            'stt': [{'id': k, 'name': v['name']} for k, v in STT_ENGINES.items()],
            'tts': [{'id': k, 'name': v['name'], 'installed': _tts_installed(k)} for k, v in TTS_ENGINES.items()],
        },
        'setup_jobs': _setup_jobs,
    })


@bp.route('/api/voice/config', methods=['GET', 'POST'])
def voice_config():
    """Read or update the voice engine config (STT / LLM / TTS)."""
    if request.method == 'GET':
        return jsonify({'config': shared.get_voice_config(), 'api_key': _api_key_status()})

    data = request.get_json(silent=True) or {}
    updates = {}

    if 'agent_name' in data and isinstance(data['agent_name'], str):
        name = data['agent_name'].strip()[:40]
        if name:
            updates['agent_name'] = name
    if 'stt' in data and data['stt'] in STT_ENGINES:
        updates['stt'] = data['stt']
    if 'tts' in data and data['tts'] in TTS_ENGINES:
        updates['tts'] = data['tts']
    if 'voice_access' in data and data['voice_access'] in ('talk', 'basic', 'full'):
        updates['voice_access'] = data['voice_access']
    if 'llm_backend' in data and data['llm_backend'] in ('local', 'cloud'):
        updates['llm_backend'] = data['llm_backend']
    if 'llm_local_model' in data and isinstance(data['llm_local_model'], str):
        updates['llm_local_model'] = data['llm_local_model'].strip()[:128]
    if 'llm_cloud_provider' in data and data['llm_cloud_provider'] in ('openai', 'anthropic', 'openai-compatible'):
        updates['llm_cloud_provider'] = data['llm_cloud_provider']
    if 'llm_cloud_model' in data and isinstance(data['llm_cloud_model'], str):
        updates['llm_cloud_model'] = data['llm_cloud_model'].strip()[:128]
    if 'llm_cloud_base_url' in data and isinstance(data['llm_cloud_base_url'], str):
        url = data['llm_cloud_base_url'].strip()
        # Only http/https so a base URL can't smuggle a non-HTTP scheme or
        # point the API key at an unexpected protocol.
        if url and not url.startswith(('http://', 'https://')):
            return jsonify({'error': 'Base URL must start with http:// or https://'}), 400
        updates['llm_cloud_base_url'] = url[:512]

    # API key is stored in .env (chmod 600), never in settings.json.
    api_key = (data.get('api_key') or '').strip()
    if api_key:
        if not shared.set_env_value('DECLOUD_LLM_API_KEY', api_key):
            return jsonify({'error': 'could not write API key to .env'}), 500

    # Hermes home path is stored in .env (points the voice brain at Hermes).
    hermes_home = (data.get('hermes_home') or '').strip()
    if hermes_home:
        if not shared.set_env_value('DECLOUD_HERMES_HOME', hermes_home):
            return jsonify({'error': 'could not write Hermes path to .env'}), 500

    if updates and not shared.set_voice_config(updates):
        return jsonify({'error': 'could not write settings.json'}), 500

    return jsonify({'config': shared.get_voice_config(), 'api_key': _api_key_status(),
                    'hermes': {'available': _hermes_available(), 'bin': _hermes_bin() or ''}})


# ─── One-click setup jobs (best-effort, run in background threads) ──

_setup_jobs = {}
_setup_lock = threading.Lock()


def _set_job(job_id, state, message):
    with _setup_lock:
        _setup_jobs[job_id] = {'state': state, 'message': message, 'ts': time.time()}


def _valid_model_name(name):
    return bool(re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(:[A-Za-z0-9._-]+)?$', name))


def _run_ollama_install(job_id):
    if shutil.which('ollama'):
        _set_job(job_id, 'done', 'Ollama is already installed')
        return
    _set_job(job_id, 'running', 'Downloading the Ollama installer…')
    try:
        script_path = os.path.join(tempfile.gettempdir(), 'decloud_ollama_install.sh')
        # Best-effort one-click install: downloads the official installer over
        # HTTPS (TLS provides transport integrity). There is no pinned hash —
        # this is the same trust model as the official `curl | sh` docs and is
        # only ever run when the user explicitly clicks "Install Ollama".
        with _requests.get('https://ollama.com/install.sh', stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(script_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
        # Sanity check: the download must look like a shell script before we run it.
        head = open(script_path, 'rb').read(256).decode('utf-8', errors='replace')
        if '#!/' not in head:
            _set_job(job_id, 'error', 'Installer download did not look like a script — aborted.')
            return
        proc = subprocess.run(['sh', script_path], capture_output=True, text=True, timeout=600)
        tail = (proc.stdout + proc.stderr)[-2000:]
        if proc.returncode == 0 or shutil.which('ollama'):
            _set_job(job_id, 'done', 'Ollama installed. If the service did not start, run "sudo systemctl start ollama".')
        else:
            _set_job(job_id, 'error', 'Install failed:\n' + tail)
    except Exception as e:
        _set_job(job_id, 'error', 'Install failed: ' + str(e))


def _run_ollama_pull(job_id, model):
    _set_job(job_id, 'running', f'Downloading {model}… this can take a few minutes')
    try:
        proc = subprocess.run(['ollama', 'pull', model], capture_output=True, text=True, timeout=1800)
        if proc.returncode == 0:
            _set_job(job_id, 'done', f'{model} is ready')
        else:
            _set_job(job_id, 'error', (proc.stderr or proc.stdout or 'pull failed')[-1000:])
    except Exception as e:
        _set_job(job_id, 'error', 'Pull failed: ' + str(e))


@bp.route('/api/voice/ollama/install', methods=['POST'])
@limiter.limit("5 per hour")
def voice_ollama_install():
    job_id = 'install_ollama'
    with _setup_lock:
        if _setup_jobs.get(job_id, {}).get('state') == 'running':
            return jsonify({'status': 'running', 'message': _setup_jobs[job_id]['message']}), 202
    threading.Thread(target=_run_ollama_install, args=(job_id,), daemon=True).start()
    return jsonify({'status': 'started', 'job': job_id}), 202


@bp.route('/api/voice/ollama/pull', methods=['POST'])
@limiter.limit("20 per hour")
def voice_ollama_pull():
    if not shutil.which('ollama'):
        return jsonify({'error': 'Ollama is not installed'}), 503
    data = request.get_json(silent=True) or {}
    model = (data.get('model') or '').strip()
    if not _valid_model_name(model):
        return jsonify({'error': 'invalid model name'}), 400
    job_id = 'pull_' + re.sub(r'[^A-Za-z0-9_-]', '_', model)
    with _setup_lock:
        if _setup_jobs.get(job_id, {}).get('state') == 'running':
            return jsonify({'status': 'running', 'job': job_id}), 202
    threading.Thread(target=_run_ollama_pull, args=(job_id, model), daemon=True).start()
    return jsonify({'status': 'started', 'job': job_id}), 202


# ─── Piper voice model download (one-click install of a missing voice) ──

VOICE_MODEL_URLS = {
    'piper-lessac-high': 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high',
    'piper-lessac-medium': 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium',
    'piper-kathleen-low': 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kathleen/low/en_US-kathleen-low',
}


def _run_voice_download(job_id, engine_id):
    engine = TTS_ENGINES.get(engine_id)
    base = VOICE_MODEL_URLS.get(engine_id)
    if not engine or engine['engine'] == 'browser' or not base:
        _set_job(job_id, 'done', 'Nothing to download')
        return
    model_path = engine['model']
    _set_job(job_id, 'running', f'Downloading {engine_id} voice…')
    try:
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        for suffix in ('.onnx', '.onnx.json'):
            with _requests.get(base + suffix, stream=True, timeout=300) as r:
                r.raise_for_status()
                with open(model_path + suffix, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        f.write(chunk)
        _set_job(job_id, 'done', f'{engine_id} is ready')
    except Exception as e:
        _set_job(job_id, 'error', 'Voice download failed: ' + str(e))


@bp.route('/api/voice/tts/install', methods=['POST'])
@limiter.limit("10 per hour")
def voice_tts_install():
    data = request.get_json(silent=True) or {}
    engine_id = data.get('engine', '')
    if engine_id not in TTS_ENGINES:
        return jsonify({'error': 'unknown engine'}), 400
    if TTS_ENGINES[engine_id]['engine'] == 'browser':
        return jsonify({'status': 'done', 'message': 'Browser voice needs no install'})
    job_id = 'voice_' + engine_id
    with _setup_lock:
        if _setup_jobs.get(job_id, {}).get('state') == 'running':
            return jsonify({'status': 'running', 'job': job_id}), 202
    threading.Thread(target=_run_voice_download, args=(job_id, engine_id), daemon=True).start()
    return jsonify({'status': 'started', 'job': job_id}), 202
