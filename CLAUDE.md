# CLAUDE.md — DeCloud quick reference for agents

Read `AGENTS.md` in full before making changes. This file is the short version
for agents that only read CLAUDE.md.

## Hard rules

1. **Smallest change that works.** YAGNI. No speculative refactors, no new
   dependencies when stdlib/native does it.
2. **Never break the security invariants:** opaque session tokens (passcode
   never in the browser); every user-supplied filesystem path goes through
   `shared.safe_join_browse` / `Path.is_relative_to`; no `shell=True`;
   `.env` loader is last-wins.
3. **Every push bumps the version + changelog:**
   `.venv/bin/python scripts/bump_version.py patch -m "summary" -c "bullet;bullet"`
   CI auto-creates the git tag + GitHub release. Never tag manually.
4. **Never commit secrets/runtime files** (`.env`, `settings.json`, `*.pid`,
   `tunnel.url`, `sessions.json`, `voice_*` files).

## Test before every commit

```bash
.venv/bin/python -m pytest -q
node --check static/js/modules/<file>.js    # per changed JS file
bash -n decloud install.sh
.venv/bin/python scripts/check_version.py
uvx pip-audit -r requirements.txt           # if deps changed
```

Boot check: `curl -s http://localhost:8899/ -o /dev/null -w "%{http_code}\n"` → 200.

## Map

- `routes/*.py` — Flask blueprints (one per feature)
- `static/js/modules/*.js` — vanilla JS; inline `onclick`s in
  `templates/index.html` call GLOBAL functions (add a function before using it)
- `shared.py` — auth/sessions/config/LLM helpers
- `scripts/decloud_update.py` + `scripts/decloud_tui.py` — terminal updater + TUI
- `routes/version.py` — `VERSION` + `CHANGELOG[0]` (single source of truth)

## Frontend rule

Escape every string from user input/files/LLM with `escapeHtml` (core.js), and
use `data-*` attributes + `this.dataset.x` instead of interpolating values into
inline `onclick` handlers.

## Known debt (do NOT touch mid-feature)

Dead code: `executeVoiceAction`/`confirmVoiceCommand` in `voice.js` and the
`/api/voice/intent` route (unused — voice uses `/api/voice/chat`). Big-file
splits (`shared.py`, `routes/voice.py`) are post-release work.
