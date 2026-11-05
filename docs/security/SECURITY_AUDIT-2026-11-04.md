# DeCloud security audit: 2026-11-04

**Scope:** the whole working tree, including the unpushed My Lab work: the multi-device agent, signed updates, 3D Lab and AI across devices.

**Method:** four parallel static reviews, plus live probes against a local instance:
- My Lab, the agent and the AI relay
- auth, sessions and exposure
- filesystem, process and fetch routes
- frontend XSS

I also ran `pip-audit` and checked the vendored three.js byte-for-byte against the npm tarball.

**Result:** no Critical findings. I fixed 1 High, 6 Medium and the Low items listed below. There are 266 tests (18 new regression tests are in `tests/test_audit_2026_11.py`).

## Fixed

| Severity | Finding | Fix |
|---|---|---|
| High | With no release key pinned, an agent with auto-update on accepted any update its hub sent. Anyone with the device token (a stolen `settings.json` or a pairing code) could run code on it. The prompt also defaulted to yes. | Agents only accept updates signed with a key pinned in `lab_report.RELEASE_SIGNERS`. With no key, the hub has nothing to push. The prompt now defaults to No and says what it means. |
| Medium | `/api/voice/run_command` was still live (N5 from 2026-10-19). Its "talk"/"basic" tiers allowed any command, through `ssh -o ProxyCommand`, `rsync -e`, `git` aliases and so on. Confirmed live. | Removed the route and its access-level setting. |
| Medium | The `.env` newline guard (N6) was bypassable. The loader uses `str.splitlines()`, which also splits on `\v \f \x1c-\x1e \x85    `. The extra keys could then be used (`DECLOUD_COMFY_CMD`, `DECLOUD_INSECURE_OPEN`). | `env_value_is_single_line` now refuses every character `splitlines()` breaks on, plus NUL. Both writers use it and write `.env` with mode 0600. |
| Medium | In open mode, HTTP requests had no Origin check. A cross-site form could trigger rollback, the Ollama installer and similar endpoints. | Every state-changing `/api` request with a foreign Origin is refused in all modes. In open mode, Origin is required. |
| Medium | Open mode plus `decloud start` (Tailscale Serve) exposed an unauthenticated app to the tailnet. | `open_mode_refusal` also detects a Serve proxy to our port. `start_tunnel` refuses in open mode. |
| Medium | A malicious peer device could break the Lab, chat and discovery pages: deeply nested JSON caused a `RecursionError`, untyped `size`/`details` fields caused crashes, and bad discovery replies caused 500s. It could also pin hub workers by trickling bytes. | Peer errors are caught broadly. `/api/tags` rows are rebuilt with forced types. Replies have a total deadline. Each device gets one in-flight fetch. Discovery ignores junk replies and bounds ports. |
| Medium | The pairing prompt said "stats, nothing else", but the hub also gets model use/pull/delete and container restarts. | Both the web prompt and the CLI prompt now state exactly what the hub gets. |

### Low (fixed)

**Settings and secrets**
- Lab settings writes are now load→modify→save under one lock, so a removed device can't come back.
- `.env`, `app.log` and `tunnel.log` are owner-only. `decloud start` uses `umask 077`.
- Werkzeug's access log, which included full query strings, is no longer written to `app.log`.

**Docker and CI**
- `.dockerignore` now excludes session tokens, lab state and chats.
- The image runs as a non-root user.
- CI now runs with `permissions: contents: read`, and its actions are SHA-pinned.

**Crashes and resource limits**
- A non-ASCII PIN or CSRF token caused a 500; the comparison now works on bytes.
- NUL bytes in paths no longer cause a 500.
- Glob characters are rejected in book references.
- PDF covers are capped at about 1200 px.
- Pillow thumbnails are capped at 50 MP.
- yt-dlp downloads are limited by duration, live status and a 300 MB cap.
- Model downloads check free disk space, stop on overrun and use per-download `.part` files.

**Temp files**
- STT, journal and the Ollama installer now use private temp directories with cleanup.
- The TUI session file is created 0600.

**Agent hardening**
- `systemctl` gets `--` before its arguments.
- The duplicate `_read` (which caused a crash on non-UTF-8 DMI data) is removed.
- The key is created under umask 077, and the state directory is 0700.
- Hub names are stripped of control characters before they are printed.
- A self-test timeout no longer leaves a `.new` file behind.

**Public routes and processes**
- `/lab-node.sh` caches its `tailscale` call and is rate-limited.
- ComfyUI start/stop takes a lock and never signals a reused PID.
- The Hermes profile and OSINT profile IDs are validated.
- Universe YAML fields are escaped.
- `_LOGIN_ATTEMPTS` is bounded.

**Frontend**
- Music uses `data-id` instead of an inline string.
- Project fields are escaped and colors validated.
- `noopener` is set on new windows.
- The double escaping in chat code blocks is fixed.
- Thumbnails use `Cache-Control: private`.

**Files app**
- Removed Poof, Shred, the in-folder custom Trash, Swipe mode and the visit tracking (and their routes).
- Added plain file actions with the same containment rules: upload (never overwrites), new folder, rename (same folder only) and delete to the system trash (freedesktop / macOS).
- The last path part is not resolved, so a symlink is renamed or deleted itself. Names can't carry separators, dots or control characters.

**Removed and fixed in passing**
- Removed the dead `tts_worker.py`, which built an ffmpeg concat list from file names.
- `install.sh` no longer aborts before printing the passcode when Tailscale is missing.
- `install.sh` no longer uses `eval` on a `.env` value.
- The startup banner recommends private Serve, not public Funnel.

## Verified sound

**Auth and sessions**
- Every `/api/*` route needs auth. The only public routes are `/`, static files, `/sw.js`, `/manifest.json`, `/kill-cache`, `/lab-agent.py`, `/lab-node.sh`, login and check.
- Sessions use an opaque `token_urlsafe(32)` HttpOnly, `SameSite=Strict` cookie. Logout revokes. A PIN change clears all sessions.
- CSRF uses an HMAC token. A Bearer token is accepted only from the header. The Host allowlist blocks DNS rebinding.

**Server**
- No `shell=True` anywhere.
- `safe_join_browse` resolves paths and then checks `is_relative_to`.
- No user-controlled SSRF beyond the owner's cloud LLM URL.

**Pairing and updates**
- Pairing uses commitment-based SAS plus a pinned certificate fingerprint.
- Peer reports are rebuilt with forced types and allowlists.
- Signature verification calls `ssh-keygen -Y verify` with a fixed principal and namespace and strict manifest checks. The hub updater also requires `version == tag` and `commit == tag commit`.

**Frontend and service worker**
- Every interpolated string reaches the DOM through `escapeHtml`, `textContent` or `data-*`. The chat markdown escapes first.
- The service worker never caches `/api`.

**Dependencies**
- `pip-audit` found no known vulnerabilities.
- The vendored three.js matches npm byte-for-byte; the only change is the import path in the two addons.

## Open / owner decisions

- **The live instance's PIN equals the test PIN** in `tests/conftest.py`, which is in the public repo. Change it.
- **Author email in history:** `mrvitali@pm.me` is in the git history (see 2026-10-19). Removing it means rewriting history.
- ~~`script-src 'unsafe-inline'`~~ **done**: all 195 inline handlers moved to `static/js/handlers.js` (delegated listeners, `this` = element), the `/kill-cache` script moved to a file, and the CSP is now `script-src 'self'`. Tests fail on any new inline handler or unknown handler key.
- **Smaller remaining items:**
  - The UDP discovery responder reflects about 12×.
  - The `lab-node.sh` venv installs psutil unpinned.
  - A signed old agent can be replayed, with no expiry.
  - There's no HSTS (Tailscale Serve terminates TLS).
  - `*.ts.net` and `*.trycloudflare.com` are allowlisted for any tunnel.
