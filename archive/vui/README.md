# Archived: Vui voice-assistant integration

Removed from the active app on 2026-09-05.

Vui was a separate full-duplex WebRTC voice server (localhost:8081) that
DeCloud proxied through Flask. The integration was experimental and is
replaced by the standalone Voice Agent project going forward.

Contents:
- `vui_proxy_routes.py` — the backend proxy routes (HTTP + WebSocket) that
  lived in `routes/voice.py`.
- `vui_frontend.js` — the browser-side WebRTC/WebSocket client code that
  lived in `static/js/modules/voice.js`.
- `vui_settings.html` — the Vui settings rows + capability list that lived
  in `templates/index.html`.

To restore, merge these back into their original files and re-add
`VUI_URL` to `shared.py`:

```python
VUI_URL = os.environ.get('DECLOUD_VUI_URL', 'http://127.0.0.1:8081')
```
