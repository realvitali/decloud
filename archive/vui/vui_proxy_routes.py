"""Archived Vui proxy routes (was in routes/voice.py).

Original file section: "# ─── Vui proxy ───" through end of voice.py.
"""

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
        """Proxy WebSocket messages between browser and Vui's WS endpoint.

        Authentication is checked HERE because Flask's before_request
        hooks never run for WebSocket upgrades."""
        from shared import ws_is_authenticated
        if not ws_is_authenticated(getattr(ws, 'environ', {})):
            try:
                ws.send(json.dumps({'type': 'error', 'text': 'Authentication required'}))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return

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
