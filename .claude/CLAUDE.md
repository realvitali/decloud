# CLAUDE.md — DeCloud quick reference for agents

Read `docs/AGENTS.md` in full before making changes. This file is the short version
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
   The changelog is the update log users read in Settings → About: list every
   user-visible addition, change and fix since the last release, one plain-words
   bullet each (`-c "…;…"`), not just a one-line summary.
   Release signing is OFF while `lab_report.RELEASE_SIGNERS` is empty (the
   default) — then skip it. Once a key is pinned, the maintainer signs each
   release with `scripts/sign_release.py sign`; agents never sign.
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
- `static/js/modules/*.js` — vanilla JS; handlers in `static/js/handlers.js`
  call GLOBAL functions (add a function before using it)
- `shared.py` — auth/sessions/config/LLM helpers
- `scripts/decloud_update.py` + `scripts/decloud_tui.py` — terminal updater + TUI
- `routes/version.py` — `VERSION` + `CHANGELOG[0]` (single source of truth)

## Frontend rule

Escape every string from user input/files/LLM with `escapeHtml` (core.js).
**No inline handlers or `<script>` blocks** — the CSP is `script-src 'self'`.
Write `data-onclick="<key>"` (or data-onchange/onkeydown/…) in markup and add
`<key>: function (event) { … }` to `static/js/handlers.js` (`this` = element), or
use `addEventListener`. Pass values via `data-*` + `this.dataset.x`. A test fails
on any `onclick="…"`.

## Known debt (do NOT touch mid-feature)

Big-file splits (`shared.py`, `routes/voice.py`) are post-release work.
