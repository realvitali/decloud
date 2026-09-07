# DeCloud — Agent Guide

Self-hosted PWA dashboard (Flask + vanilla JS + a `textual` TUI). Read this
whole file before changing code — it is written so a junior agent (or an
LLM with a short context window) can iterate without breaking things.

## Golden rules (read first, always)

1. **Smallest change that works.** YAGNI. One fix = one commit. No speculative
   abstractions, no "while I'm here" refactors, no new dependency when the
   stdlib/native feature already does it.
2. **Never break these invariants** (they are the product's security story):
   - Auth = opaque session tokens; the passcode never leaves the server.
   - Every filesystem path from user input goes through a containment check
     (`shared.safe_join_browse` or `Path.is_relative_to`) — never raw joins.
   - No `shell=True` anywhere. Command allowlists are guardrails, not a
     security boundary (the owner has a full terminal).
   - `.env` loader is last-wins for duplicate keys; systemd env still wins.
3. **Every push bumps the version + changelog.** See "Release protocol" below.
   Do NOT rely on the human to remind you.
4. **Never commit secrets or runtime files**: `.env`, `settings.json`, `*.pid`,
   `tunnel.url`, `sessions.json`, `voice_hermes_session.txt`, `voice_history.json`.
5. **If it's risky, don't do it.** This app is used by real people. When in
   doubt between a risky refactor and a safe fix, take the safe fix and write
   the refactor down in the "Known debt" section of this file.

## Environment setup (once per machine)

```bash
git clone https://github.com/realvitali/decloud && cd decloud
uv venv .venv                       # or: python3 -m venv .venv
uv pip install -r requirements.txt          # core app
uv pip install -r requirements-dev.txt      # pytest (dev only)
uv pip install -r requirements-tui.txt      # textual (for `decloud tui`)
```

## Project map (where things live)

| Area | Location | Notes |
|---|---|---|
| Entrypoint / boot | `app.py` | binds 127.0.0.1, update rollback safety net |
| Shared state + helpers | `shared.py` | auth/sessions, .env, paths, LLM, caches |
| API routes | `routes/*.py` | one file per feature (books, lego, music, voice, …) |
| Frontend | `static/js/modules/*.js` | vanilla JS, no build step; inline `onclick`s in `templates/index.html` call GLOBAL functions |
| HTML | `templates/index.html` | single page |
| CSS | `static/css/app.css` | theme vars in `:root` / `[data-theme]` |
| CLI + TUI | `scripts/decloud_*.py` + `decloud` | update CLI, TUI dashboard |
| Tests | `tests/` | auth, CSRF, WS, allowlist, traversal |
| Version truth | `routes/version.py` | `VERSION` + `CHANGELOG[0]` |

Frontend rule of thumb: if you add an inline `onclick="fn(...)"` in
`index.html`, the function must already exist globally; if you remove a
function, remove its calls. Use `escapeHtml` (core.js) for ANY string that
originates from user input, filesystem names, or the LLM — and use
`data-*` attributes + `this.dataset.x` instead of interpolating values into
inline handlers.

## Testing (run these before every commit)

```bash
.venv/bin/python -m pytest -q                        # full suite (must be green)
node --check static/js/modules/<file>.js             # JS syntax per changed file
bash -n decloud install.sh                           # shell syntax
.venv/bin/python scripts/check_version.py            # version consistency
```

Realistic end-to-end checks (do these for feature work):

```bash
# 1. Boot check
python app.py &  # or: systemctl --user restart decloud
curl -s http://localhost:8899/ -o /dev/null -w "%{http_code}\n"   # expect 200

# 2. Exercise the API you changed (needs a session)
PIN=$(grep '^DECLOUD_PIN=' .env | cut -d= -f2- | tr -d '[:space:]')
SESS=$(curl -s -X POST localhost:8899/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"pin\":\"$PIN\"}" | python -c "import sys,json;print(json.load(sys.stdin)['session'])")
curl -s localhost:8899/api/<your-endpoint> -H "Authorization: Bearer $SESS"

# 3. TUI smoke test (headless — verifies the dashboard still mounts and polls)
#    See tests/tui_smoke.py pattern; or minimal:
timeout 60 .venv/bin/python - <<'EOF'
import asyncio
from scripts.decloud_tui import DeCloudTUI
async def main():
    app = DeCloudTUI()
    async with app.run_test(size=(110, 38)) as pilot:
        await pilot.pause()
        await asyncio.sleep(4)
        print("panels:", len(list(app.screen.query('Panel'))))
asyncio.run(main())
EOF
```

### Bug-testing protocol (when fixing a reported bug)

1. **Reproduce first.** Read the logs (`tail -50 app.log`), check the browser
   console if it's frontend, and reproduce via `curl` if it's an API bug.
2. **Write a regression test** in `tests/` that fails before your fix and
   passes after — especially for anything security-sensitive (auth, paths).
3. Fix with the smallest change.
4. Run the full suite + the realistic checks above.
5. Bump version (patch) and push.

### Dependency testing (when adding/changing deps)

```bash
uvx pip-audit -r requirements.txt        # CVE scan — must come back clean
```

- Pin everything (`==`), and keep optional extras in separate files
  (`requirements-dev.txt`, `requirements-tui.txt`).
- Prefer stdlib. Adding a dependency is a last resort; justify it in the
  changelog bullet.

## Release protocol (every push that changes code)

1. Bump with the helper (it updates `routes/version.py` AND the `decloud`
   script, and adds a dated changelog entry):
   ```bash
   .venv/bin/python scripts/bump_version.py patch -m "one-line summary" -c "bullet one;bullet two"
   ```
   `patch` = fixes/polish, `minor` = features, `major` = breaking.
2. Run the test block above. Push only when green.
3. `git push origin main` — that's it. The CI `version-check` job fails if the
   three version spots disagree, and the **Release workflow auto-creates the
   `v<version>` git tag + GitHub release** (that's what the in-app updater and
   `decloud update` consume). **Never tag manually.**

## Definition of Done (checklist before you report "done")

- [ ] `pytest` green; changed JS passes `node --check`
- [ ] App boots (`curl /` → 200) after your change
- [ ] `pip-audit` clean if deps changed
- [ ] Version bumped via `scripts/bump_version.py`, changelog written
- [ ] Security-sensitive change has a regression test
- [ ] No secrets/runtime files staged (`git status` reviewed)
- [ ] CI green on push (ubuntu + macos + windows + version check)

## Known debt (safe cleanup queue — do NOT do these mid-feature)

- `shared.py` (~860 lines) and `routes/voice.py` are catch-alls; split into
  smaller modules post-release (sessions → own module, voice config → own).
- Dead frontend code: `executeVoiceAction` / `confirmVoiceCommand` in
  `static/js/modules/voice.js` and the `/api/voice/intent` backend route are
  no longer called (the voice agent uses `/api/voice/chat` now). Remove in a
  dedicated cleanup PR with its own tests.
- OSINT module is orphaned (no UI entry point) — remove or re-wire.
- In-memory `_LOGIN_ATTEMPTS` and unbounded caches could use pruning.
- Sessions are file-backed and single-process; multi-worker would need a
  shared store.
