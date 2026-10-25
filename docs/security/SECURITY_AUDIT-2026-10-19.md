# DeCloud Security Re-Audit — Public Launch Readiness

**Date:** 2026-10-19
**Baseline:** `SECURITY_AUDIT.md` (2026-08-19, v0.0.2 hardening)
**Scope:** every commit since 2026-08-19, from `b836845` to `0008c73`: 29 commits, 85 files, +9,559 / −1,876 lines. Main new surface: My Lab (`lab_report.py`, `routes/lab.py`), netloc, AI Model Advisor, Music Generator, ComfyUI lifecycle, System panel, the self-updater, the CLI and TUI, and the Windows installer.
**Method:** static review of all tracked files, plus a secret and personal-info sweep of the full git history (`git log --all -p`).
**Not done:** the test suite and live probes were **not run**. This box has no Python interpreter: `.venv/bin/python` is missing and there is no `python3` on PATH. Findings marked *PLAUSIBLE* are reasoned from code, not reproduced. `pip-audit` could not run either.

---

## Verdict

**NOT-READY.** Two Critical issues come from *open mode*, which is easy to fall into and makes any website you visit a remote shell. The fixes are small; see "Promo blockers".

---

## 1. Fixes from SECURITY_AUDIT.md: are they still in place?

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | Opaque session tokens; the passcode is never sent to the browser or accepted as Bearer | **Holds** | `routes/auth.py:52` `secrets.token_urlsafe(32)`; `shared.py:174-182` checks the token only against `SESSIONS` |
| 1b | Logout revokes the session | **Holds** | `routes/auth.py:104-106` |
| 2 | Passcode length / brute-force limits | **Holds, but weak for a public deployment** | 8-digit default (`install.sh:156`); 5/min per IP (`routes/auth.py:31`); backoff (`routes/auth.py:17-25`); 64-character cap (`shared.py:84`). See N7 |
| 3 | No `shell=True` | **Holds** | No `shell=True` in any tracked `.py`; `/api/command` uses fixed argv (`routes/terminal.py:24-82, 173-174`). But see N5 (`/api/voice/run_command`) |
| 4 | Binds 127.0.0.1 by default, warns otherwise | **Holds** | `app.py:55-66`; `Dockerfile:28`; `.env.example:12`; `docker-compose.yml:5` |
| 5 | WebSocket terminal gated, `?token=` fallback | **Holds in PIN mode** | `routes/terminal.py:194` calls `ws_is_authenticated` (`shared.py:188-216`). **No Origin check**: see N1 |
| 6 | localhost.run relay removed | **Holds** | `install.sh:111-117`; `decloud:106` uses only `tailscale funnel` |
| 9 | CSRF on cookie-authed state changes | **Holds in PIN mode** | `shared.py:241-249` (HMAC of the session token, `shared.py:157-159`). Skipped entirely in open mode (`shared.py:222-223`) |
| 10 | Security headers | **Holds** | `shared.py:302-329`. CSP still allows `'unsafe-inline'` and all of jsdelivr (N12) |
| — | Auth on every endpoint | **Holds in PIN mode** | `shared.py:218-236` gates all `/api/*`. Public non-API routes are only `/`, `/manifest.json`, `/sw.js`, `/kill-cache`, `/icons/<path>` (`routes/pwa.py:6,14,18,24,62`) and `/lab-agent.py` (`routes/lab.py:116-120`, the repo's own source). None returns user data |
| — | Path traversal guards | **Holds** | `shared.safe_join_browse` uses `is_relative_to` (`shared.py:513-531`); `routes/music.py:47-58`; `routes/lego.py:288-308`; `is_safe_book_ref` (`shared.py:534-544`) |
| — | Updater safety design | **Holds as described, but has gaps** | Ref whitelist `routes/update.py:43`; argv-only git at `:58-59, 87, 97`; no `-f` at `:97`; dirty tree refused at `:313` before fetch at `:326`; py_compile + boot probe at `:353, 358`; boot rollback at `:482-504` and `app.py:33-43`. The lock and rate limit apply to the web UI only (N9), and nothing verifies signatures (N3) |
| — | Request log omits query strings, so `?token=` is not logged | **Holds** | `shared.py:334` logs `request.path` only |
| — | Sessions are in-memory; a restart logs everyone out | **No longer true (doc drift)** | Sessions now persist to `sessions.json` (`shared.py:102-143`). That's fine as a feature, but the old audit text is wrong. See N16 |

---

## 2. Regressions and new issues (most severe first)

### Critical

**N1. Open mode turns any web page into a remote shell.**
- In open mode (`DECLOUD_PIN` unset), `_require_auth` returns early (`shared.py:222-223`) and `ws_is_authenticated` returns `True` (`shared.py:196-197`).
- There is no check of `Origin` or `Host` anywhere: grepping `shared.py`, `app.py` and `routes/` turns up nothing.
- Browsers do not apply CORS to WebSockets. Any site the owner visits can therefore open `ws://localhost:8899/api/terminal/ws` (`routes/terminal.py:188`) and get an interactive `bash --login` (`routes/terminal.py:263`).
- DNS rebinding also gives same-origin access to every `/api/*` route, including `/api/voice/run_command` (N5) and `/api/voice/config` (N6).
- Binding to 127.0.0.1 does **not** stop this, because the browser is on the same machine.
- *Confidence: high from the code; PLAUSIBLE end to end, since there was no live browser test.*
- **Fix:** have `ws_is_authenticated` and `before_request` reject a missing or foreign `Origin`, and allowlist accepted `Host` values. Better still, drop open mode, or limit it to an explicit `DECLOUD_INSECURE_OPEN=1` that also refuses non-loopback binds and Funnel.

**N2. Easy install paths end up in open mode, sometimes on the public internet.**
- **Windows installer never sets a passcode** (`setup.ps1:61-63`):
  - `-replace '^DECLOUD_PIN=.*$'` runs on a `-Raw` string with no `(?m)`, and the template line is the comment `# DECLOUD_PIN=` (`.env.example:67`), so the pattern never matches.
  - The generated passcode is thrown away and nothing is appended.
  - Every Windows install therefore runs in open mode. It also prints an empty passcode (`setup.ps1:89-90`).
  - The passcode cannot be set from the UI afterwards: open mode refuses `/api/auth/pin` (`routes/auth.py:128-129`).
- **Linux installer can start a public Funnel with no passcode:**
  - `install.sh:142` only creates a PIN when `.env` does not already exist.
  - The `.env.example` header (lines 1-5) tells users to copy it to `.env`, and that copy has no PIN.
  - `install.sh:293` then runs `decloud start`, which starts `tailscale funnel --bg --https=443` (`decloud:106`). The result is an unauthenticated public web shell. Nothing refuses Funnel in open mode (`decloud:98-110`, `app.py:56-66`).
- **No warning is ever printed for open mode:** `shared.py:82-89` only warns when the PIN is *short*.
- **Fix:** write the PIN line properly (append when there is no `DECLOUD_PIN=` line, as `install.sh:158-165` does). In `install.sh`, generate a PIN whenever `.env` has none, not only when the file is new. Have `app.py` and `decloud start` refuse a tunnel or non-loopback bind without a PIN, and print a loud open-mode warning.

### High

**N3. Updates are not signature-checked, and every push to `main` becomes a release.**
- The updater installs whatever tag the configured `origin` serves: `git fetch --tags origin` (`routes/update.py:91`). There is no `git verify-tag`, GPG or sigstore check, and the tags are lightweight and unsigned.
- `DECLOUD_UPDATE_REPO` can point the version check (`routes/update.py:49-51`) at a different repo from the one git fetches from.
- `.github/workflows/release.yml:7-12, 55-69` tags and publishes on **any** push to `main`. It has `contents: write`, does not depend on CI passing, and calls `softprops/action-gh-release@v2`, which is pinned by tag, not SHA.
- Once the project is public, a compromised maintainer token or third-party action can push code to every install that clicks Update. The boot probe only proves the app starts, not that the code is benign.
- **Fix:** gate the release job on CI (`needs:` / `workflow_run`), pin actions by SHA, sign tags, and run `git verify-tag` against a pinned key before checkout.

**N4. The public-Funnel story makes one 8-digit passcode the only thing between the internet and a shell, and the docs tell users to share it.**
- `PERMANENT_TUNNEL.md:32-38` and `README.md:56` ("Friends don't need Tailscale — they just open the link") tell owners to give friends and family the URL and the passcode.
- That passcode opens the interactive terminal, file shred and the self-updater. Neither doc says so.
- The rate limit is per IP only (`routes/auth.py:31`, `shared.py:31-36`), and there is no global failed-login throttle. 8 digits is about 26.6 bits (`install.sh:156`). A distributed brute force against a public Funnel URL is realistic.
- **Fix:** add a global (not per-IP) failed-login throttle or lockout. Default to a passphrase rather than 8 digits. Make the docs say plainly: "the passcode is a shell on your machine; don't share it". Recommend Tailscale Serve (tailnet-only) over Funnel.

### Medium

**N5. The `/api/voice/run_command` tiers are not a boundary.**
- `routes/voice.py:305-388` runs `shlex.split(command)` from the request body.
- The default `basic` tier (`shared.py:629`) allows `python3`, `pip`, `ssh`, `curl`, `git`, `npm`, `systemctl` (`routes/voice.py:329-334`). For example, `python3 -Ic …` gets past the regex `python3?\s*-c` (`routes/voice.py:343`).
- `talk` ("read-only") allows `find` (`routes/voice.py:319`), so `find -execdir …` or `find -delete` work; `exec\s` (`routes/voice.py:342`) misses `-execdir`. `cat` can read `.env`.
- In PIN mode only the owner can reach this, and the owner already has the terminal. But the UI presents these tiers as restrictions, and in open mode this is part of N1.
- The endpoint's only callers are dead code (`static/js/modules/voice.js:490, 593`, per CLAUDE.md "Known debt").
- **Fix:** delete the route.

**N6. Newline injection into `.env` can lead to code execution.**
- `shared.set_env_value` (`shared.py:824-851`) writes `f'{key}={value}'` with no CR/LF check.
- Callers pass values that are only `.strip()`ed:
  - `api_key` and `hermes_home` (`routes/voice.py:677-686`)
  - the new passcode (`routes/auth.py:134,142`)
  - library paths (`routes/settings.py:110-116`, via `_update_env_file`)
- An embedded `\nDECLOUD_COMFY_CMD=…` is executed by `/api/comfy/start` after a restart (`routes/comfy.py:33-38, 101`).
- `hermes_home` takes effect at once (`shared.py:848`) and chooses the binary that `_hermes_bin()` runs (`routes/voice.py:410-414`).
- Owner-only in PIN mode; reachable by anyone in open mode (N1).
- **Fix:** reject `\r` and `\n` in `set_env_value` and `_update_env_file`.

**N7. `X-Forwarded-For` is trusted even when no proxy is in front.**
- `ProxyFix(x_for=1)` (`shared.py:25`) makes the client-supplied XFF the rate-limit and backoff key (`shared.py:33`, `routes/auth.py:14-15`).
- Behind Tailscale Funnel/Serve the proxy appends the real IP, so this is fine.
- Without a proxy (`DECLOUD_HOST` set to a LAN or tailnet IP, as `PERMANENT_TUNNEL.md:69` and `Dockerfile:24-27` suggest), each request can claim a new IP. That skips the 5/min login limit entirely.
- `routes/netloc.py:39-42` also trusts the *first* XFF hop. That is informational only, but spoofable.
- *PLAUSIBLE.*
- **Fix:** enable ProxyFix only when a `DECLOUD_TRUST_PROXY` setting is on, or only for loopback peers.

**N8. My Lab opens an undocumented LAN listener, `0.0.0.0:8898`, inside the DeCloud process.**
- It is opt-in through "Let other devices add this computer" (`routes/lab.py:63-78`, `lab_report.py:307`). README and SECURITY_AUDIT still say "zero exposed ports" (`app.py:66`, `README.md:212-216`).
- Anyone on the LAN can, without authenticating:
  - **(a) Stall the lab port with one idle connection.** The TLS handshake runs in the accept loop because the listening socket itself is wrapped (`lab_report.py:364-367`).
  - **(b) Exhaust the main app's memory.** A negative `Content-Length` becomes `rfile.read(min(-1, 4096))`, i.e. `read(-1)`, which reads until EOF (`lab_report.py:330-332`). This runs in the DeCloud process.
  - **(c) Queue unlimited threads.** Each `/pair/finish` pops its session and then blocks on `approve_lock` for up to 120 s (`lab_report.py:351-356`). The 3-session cap (`:342`) never limits the queue.
  - **(d) Show spoofed "Allow?" prompts** with any hub name (`lab_report.py:347`).
  - **(e) Make the 6-digit pairing code guessable.** `/pair/start` has no rate limit, and a bogus finish frees the slot, so an active MITM can cycle sessions until the device's code matches the hub's. Expect about 10⁶ handshakes, within the hub's 150 s window (`lab_report.py:482`). *PLAUSIBLE.*
- A paired token only exposes the system report (process, container and service names), so the impact is mostly availability.
- **Fixes:**
  - Set `do_handshake_on_connect=False` and do the handshake in the worker thread.
  - Reject `Content-Length` values that are negative or over 4 KB.
  - Rate-limit `/pair/start` globally, e.g. one per 5 s.
  - Keep a failed session's slot busy until its TTL expires.
  - Document the port, and `DECLOUD_LAB_PORT`.

**N9. Updater gaps (in addition to N3).**
- **No cross-process lock or rate limit.** The lock is a `threading.Lock` (`routes/update.py:38`), and the 3/15 min limit is on the HTTP route only (`:423`). The CLI (`decloud:247`) and TUI (`scripts/decloud_tui.py:527`) run `perform_update` in their own process and can race the web updater.
- **The CLI/TUI restarts itself, not the service.** `_schedule_restart` kills `os.getpid()` (`routes/update.py:459`). The service keeps running the old code on top of the new tree.
- **Downgrades are allowed.** Any whitelisted tag is accepted, with no "newer than current" check (`routes/update.py:297-335`), so you can roll back to tags from before security fixes (see the `routes/version.py:129` changelog).

**N10. Docker is root, broken as shipped, and leaks secrets into the image.**
- **Port mapping never connects.** Compose maps `127.0.0.1:8899:8899` (`docker-compose.yml:5`), but the container binds `127.0.0.1` (`Dockerfile:28`) and compose never overrides it. Forwarded traffic arrives on the container's eth0, so the app cannot be reached. Users will then improvise `DECLOUD_HOST=0.0.0.0` and `-p 8899:8899`.
- **Runs as root.** There is no `USER` line, and the base image is not digest-pinned (`Dockerfile:1`).
- **Secrets end up in the image.** `.dockerignore` lacks `sessions.json`, `sessions.tmp`, `lab-state/` (the private key and token), `secrets/`, `auth.json` and `credentials.json`, all of which `.gitignore` covers. `COPY . .` (`Dockerfile:17`) bakes them in.
- **Unpinned extra install.** `Dockerfile:14` installs `flask-limiter` unpinned, on top of the pinned `requirements.txt`.
- On the plus side, compose *requires* `DECLOUD_PIN` and `SECRET_KEY` (`docker-compose.yml:23-24`).

**N11. Uninstall leaves public exposure behind.**
- `uninstall.sh:27-34` never runs `tailscale funnel --https=443 off`, and Funnel was started with `--bg`, so the config persists.
- On Linux it does not kill the `decloud start` supervisor loop (`decloud:52-59`).
- `.env` is deleted (`uninstall.sh:83`). A surviving loop would restart the app with no PIN, behind a live Funnel. *PLAUSIBLE.*

**N12. A single XSS would give full takeover.**
- The CSP allows `'unsafe-inline'` and all of `https://cdn.jsdelivr.net` (`shared.py:319`).
- CDN scripts load without SRI hashes (`templates/index.html:1090-1093`; three.js and qrcode are new since the last audit).
- The session token sits in JS-readable `sessionStorage` (`static/js/modules/auth.js:99`) and is sent as Bearer (`static/js/modules/core.js:16`). That cancels out the HttpOnly cookie.
- No exploitable XSS was found in the changed code, and peer Lab data is escaped (`static/js/modules/system.js:99-341`, server-side `_clean` at `routes/lab.py:136-162`). But nothing would contain one if it appeared.

**N13. Cloud LLM: the API key can be sent to any server, and part of it is echoed.**
- `llm_cloud_base_url` accepts any http(s) URL (`routes/voice.py:668-674`), and the key is sent there as Bearer (`shared.py:753-757`). This is also a server-side request to a user-chosen URL.
- The first 4 and last 4 characters of the key come back from `/api/voice/status` and `/api/voice/config` (`routes/voice.py:589`).
- Owner-only in PIN mode.

**N14. The Hermes voice brain ignores `voice_access`.**
- User text goes straight to `hermes chat` (`routes/voice.py:459-464`), and nothing passes on or enforces the `voice_access` tier.
- If the user's Hermes setup has shell tools enabled, a prompt injection can run them. *Depends on external config.*

**N15. The lab-agent install snippet trusts whatever transport the page is on.**
- `static/js/modules/system.js:249-250` builds `curl -fsSL ${location.origin}/lab-agent.py -o …; python3 … --install-service` with no checksum.
- Over plain `http://<lan-ip>:8899`, a LAN attacker can swap the script and get a persistent service on the new device.
- With the default bind, the URL is `http://localhost:8899`, which is wrong on the target machine (a functional bug).

### Low

- **L1. Session temp file:**
  - `SESSIONS_FILE.with_suffix('.tmp')` writes **`sessions.tmp`** (`shared.py:135`), but `.gitignore` lists `sessions.json.tmp`. A leftover file holding live tokens is therefore not ignored.
  - It is also written with the default umask before `chmod 600` (`shared.py:136-139`).
- **L2. Paired-device tokens in a world-readable file.** Tokens are stored in `settings.json` (`routes/lab.py:181`), which is written with the default umask (`shared.py:818`); it is `-rw-rw-r--` on this box. `.env` is created before it is chmodded (`install.sh:144-171`), and the TUI session file is written, then chmodded (`scripts/decloud_tui.py:56-57`).
- **L3. `install.sh` shell hygiene:**
  - `install.sh:178` runs `eval echo "$PIPER_DIR"`, which executes shell code from `.env`.
  - The `curl … | bash` usage advertised at `install.sh:5` is broken: piped, `BASH_SOURCE` is empty.
  - `install.sh:66` runs `curl | sh` for uv.
  - Piper models come from a moving `resolve/main` ref with no hash check (`install.sh:182-189`).
- **L4. Duplicate app instance on Linux.** `install.sh:276` starts the systemd unit and `:293` starts a second supervised instance, which crash-loops on the busy port. The unit also has no systemd sandboxing (`install.sh:256-272`).
- **L5. Model downloads.** A client-supplied `files` list skips the repo-membership and size checks, with no free-disk check (`routes/models.py:406-413, 280-293`). Files stay inside the target dir thanks to `_slug` (`routes/models.py:240-241`).
- **L6. ComfyUI start/stop.** No lock or rate limit on start, so repeated clicks spawn several GPU processes (`routes/comfy.py:101-106`). Stop sends SIGKILL to a possibly reused PID from `comfy.pid` (`routes/comfy.py:126-131`).
- **L7. Minor argument and path hygiene:**
  - `pid` goes into the osint argv unvalidated (`routes/osint.py:74-80`).
  - Person names in universe are unvalidated, a traversal risk on Windows (`routes/universe.py:113-141`).
  - Every TTS start spawns a worker, with no dedup (`routes/books.py:524-528`).
- **L8. Small auth and UI gaps:**
  - `/api/auth/pin` has a 10/hour limit but no backoff (`routes/auth.py:113`).
  - The crash overlay builds `innerHTML` from `err.stack` (`static/js/modules/core.js:82-83`).
  - Some server-provided values are inserted without `escapeHtml` (`static/js/modules/settings.js:22-24, 183, 190`). They are not attacker-controlled today.
- **L9. CI hardening.**
  - `ci.yml` has no `permissions:` block, installs `pytest` unpinned (`ci.yml:40`), and pins actions by tag.
  - `release.yml:55,65` interpolates `${{ steps.meta.outputs.version }}` into shell.
- **L10. Dependencies.** All are pinned with `==`, but without hashes, and transitive deps are unlocked. `flask-limiter==3.1.0` dates from 2023. `pip-audit` was not run (see Scope).

---

## 3. Promo-readiness: docs, license, hygiene

| Item | Status | Detail |
|---|---|---|
| LICENSE | **OK** | MIT, "Copyright (c) 2026 DeCloud contributors", standard text. `THIRD_PARTY_NOTICES.md` credits liquid-taffy (MIT) properly |
| Secrets in tracked files and history | **Clean** | No API keys, tokens or private keys in `git log --all -p`. `.env`, `sessions.json`, `settings.json`, `app.log`, `lab-state/` and `voice_history.json` were never committed and are all ignored. Exception: L1 (`sessions.tmp`) |
| Personal info: tracked files | **Clean** | Only placeholders (`your-machine.tail1234.ts.net`, `/home/you`) |
| Personal info: history | **Owner decision** | `mrvitali@pm.me` is the author/committer of 25 of 34 commits, plus 5 as `vitali@local`. It also survives in old diffs of files that `36b0821` cleaned (index.html mailto links, CODE_OF_CONDUCT). Rewriting history before going public is the only way to remove it |
| README matches reality | **Partly** | See N16 |
| CONTRIBUTING | **Stale** | Refers to `static/js/apps/` and `app-audiobooks.js` (neither exists) and says to register blueprints in `app.py` (it's `routes/__init__.py`) (`CONTRIBUTING.md:28, 34-41, 65`). Says "Run existing tests if any" (`:48`) |
| Security policy | **Missing** | No `SECURITY.md` or private disclosure channel. `CODE_OF_CONDUCT.md:33` points only to public GitHub Issues. A project shipping a web shell needs one before launch |
| `.gitignore` | **Good** | Apart from L1. `.dockerignore` lags behind it (N10) |

**N16. Doc drift (affects promo credibility).**

`README.md`:
- `:5-23` does not mention My Lab, the 8898 listener, Music Generator or netloc.
- `:84-93` omits `decloud update` / `decloud tui`.
- `:98` says app.py does "SSL/network setup" (it doesn't).
- `:212-216` says "Localhost by default … no open ports", but the Lab port exists.
- `:232` says "99 tests"; the old audit says 93; 118 `def test_` functions exist today, none verified here.
- There is no Docker section, and Docker doesn't work as shipped (N10).

`SECURITY_AUDIT.md`:
- Still says "Sessions are in-memory. A restart logs everyone out." Sessions are now persisted (`shared.py:102-143`).
- Its WebSocket correction contradicts the comment at `shared.py:191`.

`PERMANENT_TUNNEL.md`:
- `:28` "No account needed" is false.
- `:65-70` "Private-Only Mode … `http://your-machine:8899`" can't work with the 127.0.0.1 bind and pushes users toward a LAN bind over plain HTTP.
- `:3, 17` say `decloud start` makes the app public, without a clear warning.

Elsewhere:
- `install.sh:323` labels the public Funnel URL "TAILNET URL".
- `UPGRADE.md:49` is stale v0.0.2 guidance.

---

## 4. Promo blockers: fix these before promoting

1. **N1:** Origin/Host checks on the WebSocket and API, and either remove open mode or make it an explicit flag that is loopback-only and refuses Funnel.
2. **N2:** fix the passcode write in `setup.ps1:61-63`. Generate a PIN in `install.sh` whenever `.env` lacks one. Refuse to start Funnel without a PIN.
3. **N3:** gate `release.yml` on CI passing and SHA-pin `action-gh-release`. Tag signing plus `git verify-tag` is strongly recommended once strangers are pulling updates.
4. **N4 + N16:** stop telling users to share the passcode. State clearly that it unlocks a shell. Add a global login throttle.
5. **N6:** reject CR/LF in `set_env_value` and `_update_env_file` (a one-line fix).
6. **Add `SECURITY.md`** with a private reporting channel.
7. **Get the test suite running and green** on this release. It could not be executed for this audit.

Everything else (N5, N7-N15, L1-L10) can follow shortly after launch. N5 (delete the dead route) and N8 (Lab DoS) are the cheapest to fix.

---

## 5. Still good

- Authentication core: opaque tokens, constant-time comparisons (`routes/auth.py:43,131`), HttpOnly + SameSite=Strict cookie (`routes/auth.py:67-73`), session cap (`routes/auth.py:55-58`), and the PIN-change flow invalidates all sessions (`routes/auth.py:147-151`).
- No `shell=True` anywhere; the quick-command allowlist is unchanged (`routes/terminal.py:24-82`).
- File browser, music and books path containment (see the table in section 1).
- Peer Lab reports are rebuilt with forced types on the server (`routes/lab.py:136-162`) and escaped on the client. The accent colour is regex-checked (`routes/lab.py:45,224`).
- Lab cert pinning on the hub (`lab_report.py:403-413`). Keys are written 0600 (`lab_report.py:238-241`). Agent tokens only unlock `GET /api/lab/report` (`lab_report.py:322-327`).
- The service worker never caches `/api/` (`static/sw.js:23`), and API responses are `no-store` (`shared.py:328-329`).
- Model downloads go only to huggingface.co, and filenames are slugged into the target dir (`routes/models.py:42, 240-241, 277`).
- Ollama pull and Piper URLs are fixed or regex-validated (`routes/voice.py:707, 721, 783`).
- `archive/vui/vui_proxy_routes.py` is never imported (dead code, not reachable).
- The secret key comes from a CSPRNG and the placeholder is refused (`install.sh:147`, `shared.py:92-99`). `.env` is set to 600 (`install.sh:171`) and locked with icacls on Windows (`setup.ps1:69`).
- docker-compose requires a PIN and a secret, publishes only on 127.0.0.1, and mounts neither the home directory nor `docker.sock`.
- No `pull_request_target` in CI and no repository secrets used. All direct Python dependencies are `==`-pinned.

---

**One-line verdict: NOT-READY.** Open mode (the default on Windows, and easy to hit on Linux behind a public Funnel) is a drive-by remote shell. Fix N1-N4 and N6 and add `SECURITY.md`, and the project moves to READY-WITH-FIXES.
