# DeCloud: Promo-Blocker Fixes, 2026-10-19

**Spec:** `SECURITY_AUDIT-2026-10-19.md`, section 4 ("Promo blockers").
**Branch:** `main`, 6 local commits on top of `0008c73`. **Not pushed.**
**Tests:** written but **not run**. This sandbox has no Python interpreter (`.venv/bin/python` is missing and there is no `python3`). The only checks that ran here are `bash -n decloud install.sh`, which passed, and a by-hand run of the new `install.sh` and `decloud` snippets in bash with a stubbed `PYBIN`: they are idempotent, fill an empty `DECLOUD_PIN=` line, handle a missing final newline, and follow last-wins.

| Commit | Blocker |
|---|---|
| `349120a` | fix(N1): Origin/Host checks; open mode is explicit, loopback-only, no Funnel |
| `2a04aa7` | fix(N2): always provision a passcode; refuse Funnel without one |
| `cdd027c` | fix(N3): release only after CI succeeds; SHA-pin release actions |
| `1fe0d9b` | fix(N4): don't tell users to share the passcode; global login throttle (includes the N16 doc items) |
| `bda452e` | fix(N6): reject line breaks in values written to .env |
| `2f4d00e` | fix(SECURITY.md): add a private vulnerability-reporting policy (blocker 6 has no N-number) |

---

## N1: Origin/Host validation, and open mode defanged

**Code**
- `shared.py:207` `host_allowed()` accepts these Host values:
  - `localhost`
  - any IP literal (DNS rebinding needs a hostname, so an IP-literal Host is safe)
  - `*.ts.net` and `*.trycloudflare.com`
  - anything listed in the new `DECLOUD_ALLOWED_HOSTS` (comma-separated)
- `shared.py:226` `origin_matches_host()`: Origin must be present, http(s), and have the same hostname **and port** as Host (default ports are normalised). `null`, missing, foreign and other-port origins are rejected.
- `shared.py:243` `_check_host_and_origin()` is a `before_request` hook. It is registered before `_require_auth` and runs in **every** mode, including open mode:
  - A Host that isn't allowlisted gets 403 `BAD_HOST` on any request.
  - A WebSocket upgrade, or a `POST/PUT/PATCH/DELETE /api/*` request, without a matching Origin gets 403 `BAD_ORIGIN`.
- `shared.py:276-282`: `ws_is_authenticated()` repeats the Host/Origin check inside the handler as defense in depth.
- Open mode now requires an explicit opt-in:
  - `shared.py:94` `INSECURE_OPEN = DECLOUD_INSECURE_OPEN == '1'`.
  - With no PIN and no flag, the app **fails closed**: `_is_authenticated` and `ws_is_authenticated` return False (`shared.py:258, 282`), and `_require_auth` no longer short-circuits (`shared.py:307`).
  - `/api/auth/login` returns 503 `NO_PIN` and `/api/auth/check` returns 401 `NO_PIN` (`routes/auth.py:57-60, 113-116`).
  - A loud console warning is printed in both no-PIN cases (`shared.py:95-106`).
- `app.py:63` `open_mode_refusal()`. In open mode, `app.py` will not start if:
  - `DECLOUD_HOST` is not loopback, or
  - `tailscale funnel status` reports `Funnel on` (`app.py:49`).

  The refusal fires at `app.py:102`. While open mode runs, `app.py:78` re-checks every 30 s and exits if a Funnel is switched on. This covers the "keep running" case.
- `scripts/decloud_tui.py:73`: the TUI now sends `Origin`, so its login POST still works.

**Docs:** new settings documented in `.env.example:62-76`. The curl login recipe in `AGENTS.md:75-77` now sends `-H 'Origin: …'`.

**Tests**
- New `tests/test_origin_host.py` (23 tests): Host allowlist, Origin matching, API and WebSocket rejection in PIN mode and in open mode, fail-closed with no PIN, and the open-mode bind/Funnel refusals.
- `tests/test_ws_auth.py`: base environ now carries Host/Origin, plus 7 new tests.
- Fixtures in `tests/conftest.py` and `tests/test_routes.py` now send `Origin: http://localhost`, so they behave like a same-origin browser.
- The three existing open-mode tests now also set `INSECURE_OPEN`.

## N2: Passcode provisioning

- `setup.ps1:56-74`: removed the `-replace '^DECLOUD_PIN=.*$'` that never matched. Now, whenever `.env` has no non-empty `DECLOUD_PIN=` line (new or pre-existing `.env`), a PIN is generated and **appended**. Appending is enough because the loader is last-wins, and it avoids rewriting the file's encoding. A missing final newline is handled. `setup.ps1:98` prints the last PIN line only.
- `install.sh:156-175`: PIN generation moved out of `if [ ! -f .env ]`. It now runs whenever `.env` lacks a non-empty PIN, which covers a hand-copied `.env.example`. `install.sh:321` reads the real last `DECLOUD_PIN=` line; before, it also matched the comment.
- `decloud:81` `has_pin()` follows the same rules as `shared.py`: a variable in the environment wins over `.env`, `.env` is last-wins, and quotes and whitespace are stripped.
- `decloud:100`: `start_tunnel` refuses Funnel without a PIN. It runs after `stop_tunnel`, so an existing Funnel is switched off and not restarted.
- `decloud:190` passcode display fixed the same way as `install.sh:321`.
- `decloud.ps1:17` no longer says "open mode".
- **Tests:** new `tests/test_install_pin.py`. It runs the real snippets pulled from `install.sh`, `decloud` and `setup.ps1` in a temp dir:
  - bash on Linux/macOS;
  - PowerShell wherever `pwsh` or `powershell` is installed (GitHub ubuntu and windows runners both have it);
  - plus a static check that the broken `-replace` is gone.

## N3: release.yml

- `.github/workflows/release.yml:16-33` now triggers on `workflow_run: [CI] completed` for `main`. The job runs only if all of these hold:
  - `conclusion == 'success'`
  - `event == 'push'`
  - `head_branch == 'main'`
  - `head_repository == github.repository`
- `:38` checks out and tags `workflow_run.head_sha`, the exact commit CI tested.
- SHA pins, resolved from GitHub with `git ls-remote` today:
  - `actions/checkout@11d5960…` (v4.4.0), at `:36`
  - `actions/setup-python@a26af69…` (v5.6.0), at `:41`
  - `softprops/action-gh-release@3bb1273…` (v2.6.2), at `:88`
- `:11-14`: follow-up note on tag signing and `git verify-tag`.
- **Tests:** new `tests/test_release_workflow.py`, using text checks only (no YAML dependency).

## N4 + N16: Docs and global login throttle

- `routes/auth.py:34-50, 68-76`: global failed-login throttle.
  - 20 failures per 60 s across **all** clients returns 429 `LOGIN_THROTTLED` with `Retry-After`.
  - It is checked **before** the passcode compare, so guesses made during a lockout reveal nothing.
  - Existing sessions are unaffected.
- `README.md`:
  - Funnel is now described as public (`:46, :56`).
  - The "Friends don't need Tailscale" line is removed.
  - A shell / don't-share warning is added (`:60-64`), along with a `DECLOUD_PIN` table note (`:73`).
  - The Security section (`:208-226`) covers fail-closed, open mode, the global cap and the Origin/Host checks.
- `PERMANENT_TUNNEL.md`:
  - Public warning at the top (`:5`).
  - "Sharing with Friends/Family" is replaced by "Don't share your passcode" (`:34`).
  - "No account needed" is fixed (N16).
  - The cloudflared section now needs `DECLOUD_ALLOWED_HOSTS` (`:67-70`). This is required by N1 for custom domains.
  - Private-Only mode is rewritten to use `tailscale serve`, since the old `http://your-machine:8899` could not work with the 127.0.0.1 bind (N16).
  - "Friends can't access" troubleshooting is reworded.
- Console output:
  - `install.sh:330` "TAILNET URL" becomes "PUBLIC URL (Tailscale Funnel)" (N16), and `:366` adds the warning.
  - `decloud:210` `qr` adds the warning.
  - `setup.ps1:100-106` adds the warning and recommends Serve over Funnel.
- **Tests:**
  - 4 global-throttle tests in `tests/test_auth.py` (`TestGlobalLoginThrottle`), using distinct `REMOTE_ADDR`s.
  - `tests/conftest.py` clears the global counter after each test.
  - New `tests/test_docs_security.py`.

## N6: CR/LF in .env writes

- `shared.py:909` `env_value_is_single_line()` rejects CR, LF **and** every other break that `str.splitlines()` (the `.env` loader) splits on, such as `\x85` and ` `. Checking only `\r\n` would have left those open.
- It is used in `set_env_value` (`shared.py:921`) and `_update_env_file` (`routes/settings.py:16`), which return False before touching the file.
- **Tests:** new `tests/test_env_injection.py`. It covers unit tests for both writers and the `/api/settings/paths` and `/api/auth/pin` routes. The routes are pointed at a temp `BASE_DIR`, so the real `.env` is never touched.

## Blocker 6: SECURITY.md

- New `SECURITY.md`:
  - GitHub private vulnerability reporting is the preferred channel: `https://github.com/realvitali/decloud/security/advisories/new`.
  - A `security@<your-domain>` **placeholder** for the owner to fill in or delete.
  - Response targets, supported versions and scope.
- `README.md:241` and `CODE_OF_CONDUCT.md:33-34` link to it.
- **Owner action:** turn on *Settings → Code security → Private vulnerability reporting* on GitHub, or the link will 404 for reporters.
- **Tests:** new `tests/test_security_policy.py`.

---

## Behaviour changes to know before shipping

1. **Existing installs with no PIN are locked after updating.** This includes every Windows install made with the old `setup.ps1`. The app still boots, so the updater's boot probe passes. But every API call is refused and the login screen shows "No passcode is set…". Fix: re-run `setup.ps1` or `install.sh`, or add `DECLOUD_PIN=` by hand, then restart. Put this in the release notes.
2. **Scripted POSTs need an Origin header now.** `curl` and other tools must send `-H 'Origin: http://localhost:8899'`. Bearer auth does not exempt a request: I followed the spec literally ("absent or cross-site"). Browsers always send Origin on POST and on WebSocket, so the UI is unaffected.
3. **Custom hostnames must be allowlisted.** This covers a cloudflared named tunnel on your own domain, a MagicDNS short name, and similar: set `DECLOUD_ALLOWED_HOSTS`. Otherwise the result is 403 `BAD_HOST`.
4. **The global throttle can be used to lock you out.** An attacker who keeps up more than 20 failed logins per minute blocks *new* logins for everyone, the owner included, until they stop. Already logged-in devices keep working. This trade-off comes with any global lockout.
5. **Some error messages are misleading.** A rejected newline in `/api/settings/paths`, `/api/auth/pin` or the voice config surfaces as the existing "could not write .env (check permissions)" message. The rejection is correct; the message is not. I left it as is to keep the change minimal.

## Verify on the host (could not be done here)

- **The Funnel path end to end.** Through the Funnel URL, log in from a phone and open the terminal. The Origin check assumes Tailscale Serve/Funnel keeps the original `Host` header when it proxies to `localhost:8899`. As far as I know it does, but I did not test it. If it rewrote Host, every remote POST and WebSocket would get 403 `BAD_ORIGIN`.
- **The Funnel detection string.** With a Funnel on, `tailscale funnel status` must contain `Funnel on`, which is what `app.py:_funnel_active` and the open-mode refusal look for. If Tailscale isn't on `PATH`, detection is skipped and treated as "no Funnel".
- **Manual probes** with the app running:
  ```bash
  # DNS-rebinding Host -> 403 BAD_HOST
  curl -si -H 'Host: evil.example:8899' http://localhost:8899/ | head -1
  # Cross-site WebSocket -> 403 BAD_ORIGIN
  curl -si http://localhost:8899/api/terminal/ws -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Origin: https://evil.example' | head -1
  # Open mode refuses a LAN bind
  DECLOUD_PIN= DECLOUD_INSECURE_OPEN=1 DECLOUD_HOST=0.0.0.0 .venv/bin/python app.py   # -> REFUSING TO START
  ```

## Deliberately NOT addressed

- **N3, remainder:** tag signing and `git verify-tag` in `routes/update.py`. This is only noted in the workflow. It needs a maintainer key decision.
- **N4, remainder:** the default is still an 8-digit PIN rather than a passphrase. The Funnel → Serve change is documented as a recommendation only; `decloud start` still starts Funnel.
- **N16, remainder:**
  - The README feature list is missing My Lab, Music Generator and netloc.
  - README doesn't document `decloud update` / `decloud tui`.
  - README:98 "SSL/network setup".
  - README "zero open ports" vs. the Lab port 8898.
  - The README test count.
  - There is no Docker section.
  - `SECURITY_AUDIT.md`'s in-memory-sessions and WebSocket statements.
  - `UPGRADE.md:49`.
  - `install.sh` "tunnel URL changes every few hours".
  - Stale `CONTRIBUTING.md` paths.
- **Not promo blockers, so left for later:** N5 (delete `/api/voice/run_command`), N7 (ProxyFix/XFF trust), N8 (Lab listener DoS and pairing), N9 (updater lock, restart, downgrade), N10 (Docker), N11 (uninstall leaves Funnel), N12 (CSP/SRI/sessionStorage), N13, N14, N15.
- **L1–L10.** This includes L9: `ci.yml` actions are still tag-pinned, and `release.yml` still interpolates `${{ steps.meta.outputs.version }}` into shell.
- **Blocker 7 ("get the test suite running and green"):** not possible here; see below.
- **Version bump and changelog** (`scripts/bump_version.py`, required by AGENTS.md before every push): not done, because it needs Python and nothing was pushed. Run it before pushing.

## Running the tests on the host

```bash
cd ~/decloud            # repo root
# .venv here has no interpreter; recreate it if yours is the same
uv venv .venv           # or: python3 -m venv .venv
uv pip install -r requirements.txt -r requirements-dev.txt

# Full suite (must be green before pushing)
.venv/bin/python -m pytest -q

# Just the new and changed security tests
.venv/bin/python -m pytest -q tests/test_origin_host.py tests/test_ws_auth.py tests/test_auth.py \
  tests/test_install_pin.py tests/test_env_injection.py tests/test_release_workflow.py \
  tests/test_docs_security.py tests/test_security_policy.py tests/test_routes.py

# Rest of the AGENTS.md pre-commit block
bash -n decloud install.sh
.venv/bin/python scripts/check_version.py
```

On Windows (PowerShell): `.venv\Scripts\python.exe -m pytest -q`. The bash snippet tests skip themselves on Windows, and the `setup.ps1` tests run there.

Then bump the version and push:

```bash
.venv/bin/python scripts/bump_version.py patch -m "Security: promo blockers N1-N4, N6 + SECURITY.md" \
  -c "Origin/Host checks; open mode needs DECLOUD_INSECURE_OPEN=1;Installers always set a passcode; no Funnel without one;Releases only after CI passes;Global login throttle; don't-share-the-passcode docs;Reject newlines in .env writes"
git push origin main
```
