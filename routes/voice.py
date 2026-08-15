"""Voice assistant routes: STT, TTS, Hermes voice, intent, Vui proxy.

Note: STT (Whisper) and TTS (Piper) are stable. The Vui voice assistant
proxy is experimental and requires a separate Vui server to be running.
"""
from flask import Blueprint, jsonify, request, send_file, Response
import os, json, subprocess, uuid, re, threading, tempfile, shutil
from shared import (
    app, _requests, _ws_lib, OLLAMA_URL, VUI_URL,
    get_whisper_model, TTS_ENGINES, STT_ENGINES, limiter,
)

bp = Blueprint('voice', __name__)

@bp.route('/api/voice/stt', methods=['POST'])
def voice_stt():
    """Transcribe audio blob to text using faster-whisper."""
    try:
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({'error': 'No audio file provided'}), 400

        model_name = request.form.get('model', 'base')

        # Save to temp wav file
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False, dir='/tmp') as tmp:
            audio_file.save(tmp.name)
            tmp_path = tmp.name

        # Convert to wav 16kHz mono if needed (whisper handles webm but wav is safer)
        wav_path = tmp_path.rsplit('.', 1)[0] + '.wav'
        subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_path, '-ar', '16000', '-ac', '1', '-f', 'wav', wav_path],
            capture_output=True, timeout=30
        )

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
        return jsonify({'error': str(e)}), 500

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

        # Piper TTS
        model_path = os.path.join(os.path.dirname(__file__), engine['model'])
        config_path = model_path.replace('.onnx', '.onnx.json')

        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False, dir='/tmp') as tmp:
            output_path = tmp.name

        proc = subprocess.run(
            ['piper', '-m', model_path, '-c', config_path, '-f', output_path],
            input=text.encode('utf-8'),
            capture_output=True,
            timeout=30
        )

        if proc.returncode != 0:
            return jsonify({'error': 'TTS failed: ' + proc.stderr.decode()}), 500

        return send_file(output_path, mimetype='audio/wav', as_attachment=False,
                        download_name='tts.wav')
    except Exception as e:
        return jsonify({'error': str(e)}), 500

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

    model_path = os.path.join(os.path.dirname(__file__), engine['model'])
    config_path = model_path.replace('.onnx', '.onnx.json')

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False, dir='/tmp') as tmp:
        output_path = tmp.name

    proc = subprocess.run(
        ['piper', '-m', model_path, '-c', config_path, '-f', output_path],
        input=text.encode('utf-8'),
        capture_output=True,
        timeout=30
    )

    if proc.returncode != 0:
        return jsonify({'error': 'TTS failed'}), 500

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

@bp.route('/api/voice/hermes', methods=['POST'])
def voice_hermes():
    """Full voice round-trip: audio in -> STT -> LLM -> TTS -> audio out.
    Uses Whisper for STT, Ollama (minimax-m3:cloud) for LLM, Piper for TTS.
    Returns JSON with transcript text + TTS audio URL."""
    try:
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({'error': 'No audio file provided'}), 400

        # 1. STT - transcribe audio
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False, dir='/tmp') as tmp:
            audio_file.save(tmp.name)
            tmp_path = tmp.name

        wav_path = tmp_path.rsplit('.', 1)[0] + '.wav'
        subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_path, '-ar', '16000', '-ac', '1', '-f', 'wav', wav_path],
            capture_output=True, timeout=30
        )

        stt_model = request.form.get('stt_model', 'whisper-base')
        model = get_whisper_model(STT_ENGINES.get(stt_model, STT_ENGINES['whisper-base'])['model'])
        segments, info = model.transcribe(wav_path, beam_size=1, language='en')
        transcript = ' '.join(seg.text.strip() for seg in segments).strip()

        os.unlink(tmp_path)
        if os.path.exists(wav_path):
            os.unlink(wav_path)

        if not transcript:
            return jsonify({'error': 'No speech detected', 'transcript': ''}), 400

        app.logger.info(f'[HERMES-VOICE] STT: "{transcript}"')

        # 2. LLM - call Ollama with conversational model (no intent parsing)
        conversation_json = request.form.get('conversation', '[]')
        try:
            conversation = json.loads(conversation_json)
        except Exception:
            conversation = []

        llm_model = request.form.get('model', 'minimax-m3:cloud')

        messages = [
            {"role": "system", "content": "You are DeCloud, a helpful AI companion. Respond naturally and concisely as if speaking. Keep responses short (1-3 sentences) since they'll be read aloud as speech. No markdown, no code blocks, just plain conversational text."}
        ]
        messages.extend(conversation[-6:])  # last 6 messages for context
        messages.append({"role": "user", "content": transcript})

        ollama_payload = {
            'model': llm_model,
            'messages': messages,
            'stream': False,
            'options': {'temperature': 0.7, 'top_p': 0.9}
        }

        resp = _requests.post(f'{OLLAMA_URL}/api/chat', json=ollama_payload, timeout=60)
        resp.raise_for_status()
        result = resp.json()
        reply_text = result.get('message', {}).get('content', '').strip()

        if not reply_text:
            reply_text = "I didn't catch that, could you say that again?"

        app.logger.info(f'[HERMES-VOICE] LLM reply: "{reply_text[:100]}"')

        # 3. TTS - generate audio from reply
        tts_engine_id = request.form.get('tts_engine', 'piper-lessac-high')
        engine = TTS_ENGINES.get(tts_engine_id, TTS_ENGINES['piper-lessac-high'])

        audio_id = str(uuid.uuid4())[:8]
        audio_out = f'/tmp/voice_hermes_{audio_id}.wav'

        subprocess.run(
            engine['cmd'] + ['-m', engine['model'], '-t', reply_text, '-o', audio_out],
            capture_output=True, timeout=30
        )

        # Read the audio file and return as base64
        import base64 as _b64
        with open(audio_out, 'rb') as f:
            audio_b64 = _b64.b64encode(f.read()).decode('utf-8')
        os.unlink(audio_out)

        return jsonify({
            'transcript': transcript,
            'reply': reply_text,
            'audio': f'data:audio/wav;base64,{audio_b64}',
        })
    except Exception as e:
        app.logger.error(f'[HERMES-VOICE] Error: {e}')
        return jsonify({'error': str(e)}), 500

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
        model = data.get('model', 'qwen2.5:14b-instruct-q4_K_M')
        conversation = data.get('conversation', [])

        if not text:
            return jsonify({'error': 'No text provided'}), 400

        # System prompt that defines available actions
        system_prompt = """You are DeCloud, a voice assistant for the DeCloud app. 
Parse the user's request and respond with a JSON action object ONLY. No markdown, no explanation, just valid JSON.

Available actions:
1. {"action": "navigate", "screen": "audiobooks|lego|chat|generate|home"} - Navigate to a screen
2. {"action": "play_book", "title": "book name (fuzzy match)", "chapter": number_or_null} - Start playing an audiobook
3. {"action": "stop_playback"} - Stop audio playback
4. {"action": "pause_playback"} - Pause audio
5. {"action": "resume_playback"} - Resume audio
6. {"action": "run_command", "command": "the shell command", "description": "what it does in plain english", "requires_confirmation": true} - Run a terminal command (ALWAYS requires_confirmation=true)
7. {"action": "search_files", "query": "search term", "path": "optional path"} - Search for files on your drive
8. {"action": "generate_image", "prompt": "description"} - Generate an AI image
9. {"action": "chat", "message": "what to ask the AI"} - Send a message to the AI chat
10. {"action": "respond", "message": "your spoken response"} - Just talk to the user (questions, jokes, explanations)

Rules:
- For terminal commands, ALWAYS set requires_confirmation=true and explain what the command does in "description"
- For dangerous commands (rm, shred, dd, mkfs, etc), add "dangerous": true
- If the request is ambiguous, use {"action": "respond", "message": "clarifying question"}
- If the user wants to read/listen to a book, use play_book with a fuzzy title match
- Keep responses short and natural for speech output
- Return ONLY valid JSON, no markdown fences"""

        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(conversation[-4:])  # Last 4 messages for context
        messages.append({"role": "user", "content": text})

        # Call Ollama
        ollama_payload = {
            'model': model,
            'messages': messages,
            'stream': False,
            'options': {'temperature': 0.3, 'top_p': 0.9}
        }

        resp = _requests.post(f'{OLLAMA_URL}/api/chat', json=ollama_payload, timeout=60)
        resp.raise_for_status()
        result = resp.json()

        llm_text = result.get('message', {}).get('content', '').strip()

        # Strip markdown code fences if present
        llm_text = re.sub(r'^```(?:json)?\s*', '', llm_text)
        llm_text = re.sub(r'\s*```$', '', llm_text)

        # Parse JSON
        try:
            action = json.loads(llm_text)
        except json.JSONDecodeError:
            # Try to extract JSON from the text
            json_match = re.search(r'\{.*\}', llm_text, re.DOTALL)
            if json_match:
                action = json.loads(json_match.group())
            else:
                action = {"action": "respond", "message": "I didn't catch that, could you rephrase?"}

        return jsonify({'action': action, 'raw_llm': llm_text})
    except Exception as e:
        app.logger.error(f'[INTENT] error: {e}')
        return jsonify({'error': str(e)}), 500

@bp.route('/api/voice/run_command', methods=['POST'])
@limiter.limit("20 per minute")
def voice_run_command():
    """Execute a shell command and return output. Used after user confirmation.
    
    Uses an allowlist of safe commands — anything not explicitly permitted
    is rejected. This is more restrictive than the terminal but appropriate
    for voice-initiated commands which can't be reviewed character-by-character.
    """
    try:
        data = request.get_json(silent=True) or {}
        command = data.get('command', '').strip()

        if not command:
            return jsonify({'error': 'No command provided'}), 400

        # Strict allowlist: only permit known-safe commands
        # Extract the base command (first word, before any arguments)
        base_cmd = command.split()[0] if command.split() else ''
        # Strip path prefixes (e.g. /usr/bin/ls → ls)
        base_cmd = base_cmd.split('/')[-1]
        
        ALLOWED_COMMANDS = {
            'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'which',
            'date', 'cal', 'uptime', 'whoami', 'hostname', 'uname',
            'free', 'df', 'du', 'ps', 'top', 'nvidia-smi',
            'tailscale', 'ip', 'ss', 'ping',
            'curl', 'wget',
            'echo', 'printf',
            'systemctl', 'journalctl',
            'python3', 'python', 'pip', 'uv',
            'git', 'gh',
            'ollama',
        }
        
        if base_cmd not in ALLOWED_COMMANDS:
            return jsonify({
                'error': f'Command "{base_cmd}" is not in the allowed list. Use the terminal app for unrestricted commands.'
            }), 403

        # Additional blocklist for dangerous patterns even within allowed commands
        DANGEROUS_PATTERNS = [
            r'rm\s', r'mv\s.*\s/', r'cp\s.*\s/',
            r'>\s*/dev/sd', r'>\s*/dev/null.*<',
            r'mkfs', r'dd\s+if=', r'shutdown', r'reboot',
            r'chmod\s+777', r'chown\s+',
            r':\(\)\s*\{', r'fork\s*bomb',
            r'curl.*\|\s*sh', r'wget.*\|\s*sh',
            r'eval\s', r'exec\s',
        ]
        for pat in DANGEROUS_PATTERNS:
            if re.search(pat, command):
                return jsonify({'error': f'Blocked: command matches dangerous pattern'}), 403

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


VUI_URL = 'http://127.0.0.1:8081'

@bp.route('/api/voice/vui/offer', methods=['POST'])
def vui_offer_proxy():
    """Proxy WebRTC SDP offer to Vui."""
    try:
        resp = _requests.post(f'{VUI_URL}/offer', json=request.get_json(), timeout=10)
        return jsonify(resp.json())
    except _requests.exceptions.ConnectionError:
        return jsonify({'error': 'Vui is not running'}), 503
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.route('/api/voice/vui/voices', methods=['GET'])
def vui_voices_proxy():
    """List available Vui voice prompts."""
    try:
        resp = _requests.get(f'{VUI_URL}/prompts', timeout=5)
        return jsonify(resp.json())
    except _requests.exceptions.ConnectionError:
        return jsonify({'error': 'Vui is not running'}), 503
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.route('/api/voice/vui/voice', methods=['POST'])
def vui_load_voice_proxy():
    """Switch Vui's active voice prompt."""
    try:
        voice_name = request.json.get('voice', '')
        if not voice_name:
            return jsonify({'error': 'voice required'}), 400
        resp = _requests.post(f'{VUI_URL}/load-prompt', json={'file': voice_name}, timeout=10)
        return jsonify(resp.json())
    except _requests.exceptions.ConnectionError:
        return jsonify({'error': 'Vui is not running'}), 503
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─── Vui WebSocket proxy (registered via register()) ──────────

def register(sock):
    @sock.route('/api/voice/vui/ws')
    def vui_ws_proxy(ws):
        """Proxy WebSocket messages between browser and Vui's WS endpoint."""
        import urllib.parse
        cid = request.args.get('cid', '')
        vui_ws_url = f'ws://127.0.0.1:8081/ws?cid={urllib.parse.quote(cid)}'

        try:
            vui_conn = _ws_lib.create_connection(vui_ws_url, timeout=5)
        except Exception as e:
            ws.send(json.dumps({'type': 'error', 'text': f'Cannot connect to Vui: {e}'}))
            return

        def browser_to_vui():
            try:
                while True:
                    msg = ws.receive()
                    if msg is None:
                        break
                    vui_conn.send(msg)
            except Exception:
                pass
            try:
                vui_conn.close()
            except Exception:
                pass

        def vui_to_browser():
            try:
                while True:
                    msg = vui_conn.recv()
                    if not msg:
                        break
                    ws.send(msg)
            except Exception:
                pass

        t = threading.Thread(target=vui_to_browser, daemon=True)
        t.start()
        browser_to_vui()
        t.join(timeout=1)

@bp.route('/api/voice/vui', methods=['POST'])
def voice_vui_proxy():
    """Proxy audio to Vui's /v1/voice-note endpoint. Returns transcript + reply + audio."""
    try:
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({'error': 'No audio provided'}), 400

        files = {'audio': (audio_file.filename or 'recording.webm', audio_file.read(), audio_file.mimetype or 'audio/webm')}
        resp = _requests.post(f'{VUI_URL}/v1/voice-note', files=files, timeout=120)

        if resp.status_code == 409:
            return jsonify({'error': 'Vui is busy (another session active). Close the Vui browser tab if open.'}), 503
        if resp.status_code != 200:
            return jsonify({'error': f'Vui error: {resp.text[:200]}'}), 502

        data = resp.json()
        return jsonify({
            'ok': data.get('ok', False),
            'asr_text': data.get('asr_text', ''),
            'reply_text': data.get('reply_text', ''),
            'audio': data.get('audio', ''),
            'audio_format': data.get('audio_format', 'wav'),
            'sample_rate': data.get('sample_rate', 24000),
        })
    except _requests.exceptions.ConnectionError:
        return jsonify({'error': 'Vui is not running on port 8081'}), 503
    except Exception as e:
        app.logger.error(f'[VUI] error: {e}')
        return jsonify({'error': str(e)}), 500
