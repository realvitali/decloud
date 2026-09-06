# DeCloud — Agent Guide

Self-hosted PWA dashboard (Flask + vanilla JS). Read this before changing code.

## Commands

- Run tests: `python -m pytest -q` (or `uv run pytest -q`)
- Syntax check JS: `node --check static/js/modules/<file>.js`
- Boot the app: `python app.py` (binds 127.0.0.1:8899)

## Versioning & changelog (REQUIRED on every push)

Every push to `main` that changes code MUST bump the version and update the
changelog. Do NOT rely on the human to remind you.

Three places must stay in sync (single source of truth is `routes/version.py`):

1. `routes/version.py` — `VERSION = "x.y.z"` and `CHANGELOG[0]` must have the
   same `version` plus a `date` (today, `YYYY-MM-DD`) and a `changes` list.
2. `decloud` — `VERSION="x.y.z"` (shell script).
3. Nothing else. `manifest.json`, docs, etc. reference the version indirectly.

Use the helper script — it does all of the above correctly:

```
python scripts/bump_version.py patch -m "one-line summary" -c "change one;change two"
```

Bump type: `patch` for fixes/polish, `minor` for features, `major` for breaking.

After bumping: run tests, commit, and push. Two things catch mistakes:
- The CI check (`scripts/check_version.py`) fails any push where the three
  spots disagree or `CHANGELOG[0].version != VERSION`.
- The Release workflow (`.github/workflows/release.yml`) automatically creates
  the `v<version>` git tag + GitHub release on push — that's what the in-app
  updater consumes, so **never tag manually**; pushing the bump is enough.

## Conventions

- Backend: Flask blueprints in `routes/`. Shared state/helpers in `shared.py`.
- Frontend: plain JS modules in `static/js/modules/` (no build step). Inline
  `onclick` handlers in `templates/index.html` call global functions — if you
  add a handler, the function must exist; if you remove one, remove the call.
- `escapeHtml` lives in `static/js/modules/core.js` (single definition).
- Config split: non-secrets in `settings.json`, secrets in `.env` (never commit
  `.env`; use `shared.set_env_value` / `shared.set_voice_config`).
- Never commit `.env`, `settings.json`, `*.pid`, `tunnel.url`, `voice_*session*`,
  or `voice_history.json` (all gitignored).

## Security invariants (do not regress)

- Every filesystem path from user input must go through a containment check
  (`shared.safe_join_browse` or `Path.is_relative_to`), never raw `/` joins.
- Never use `shell=True`. Command allowlists are best-effort guardrails, not a
  security boundary (the owner has a full terminal).
- Keep the `.env` loader last-wins for duplicate keys (systemd env still wins).

## Tests

`tests/` covers auth, CSRF, WS auth, terminal allowlist, and path traversal.
When you change security-sensitive code, add a regression test.
