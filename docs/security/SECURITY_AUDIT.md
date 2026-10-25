# DeCloud Security Audit Report

**Date:** August 19, 2026
**Scope:** All tracked files in the repository (post-v0.0.2 hardening)
**Status:** Critical and high issues fixed and covered by automated tests

---

## Executive summary

DeCloud is a self-hosted personal dashboard. After the v0.0.2 hardening
pass, the security model is:

- A passcode (`DECLOUD_PIN`, 8+ characters recommended) is the only
  credential ever sent to the server, and only to `/api/auth/login`.
- Login mints an **opaque session token** (never the passcode) held in an
  in-memory table with a 30-day TTL; the browser gets it as an HttpOnly,
  SameSite=Strict cookie plus a CSRF token.
- Every API endpoint is gated by that session token. WebSocket upgrades
  are gated twice: by `before_request` (the handshake is a normal Flask
  request) **and** by an explicit in-handler check that also accepts
  `?token=` for cross-origin tunnel use.
- State-changing requests authenticated only by cookie require a valid
  `X-CSRF-Token` (Bearer-authenticated requests are CSRF-safe by
  construction).
- Shell execution is allowlisted and **never** uses `sh -c`
  (`shell=False` everywhere user input is involved).
- The app binds 127.0.0.1 by default and prints a loud warning otherwise.
  Remote access is via Tailscale Funnel only — the third-party
  `localhost.run` relay fallback was removed.

## What was wrong before v0.0.2 (and what happened to each)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Passcode stored raw in a `decloud_pin` cookie and accepted as a Bearer credential — one leak = permanent full access (terminal, files, shred) | Critical | **Fixed.** Opaque session tokens with TTL + revocation on logout; raw passcode rejected everywhere |
| 2 | 6-digit numeric PIN as the sole barrier to a full shell | Critical | **Improved.** Installer generates 8 digits, passphrases up to 64 chars supported, startup warning below 8 chars; 5/min per-IP login limit + exponential backoff after repeated failures |
| 3 | `subprocess.run(..., shell=True)` in the quick-command route | High | **Fixed.** Fixed-argv table + python-native `stat`/`file`/`du` equivalents; 15 injection payloads covered by tests |
| 4 | Default config bound `0.0.0.0` in Dockerfile/`.env.example` while docs claimed localhost-only | High | **Fixed.** 127.0.0.1 defaults everywhere; non-localhost binds print a loud warning |
| 5 | WebSocket terminal worked only same-origin; over tunnels the handshake failed auth (and the docs implied otherwise) | Medium | **Fixed.** Explicit WS auth + `?token=` handshake parameter; verified with live WebSocket probes (blocked unauthenticated, connected with cookie and with token) |
| 6 | `localhost.run` third-party relay fallback — traffic transited an unknown host, contradicting "end-to-end encrypted, no cloud" claims | Medium | **Fixed.** Removed; Tailscale Funnel is the only supported tunnel (cloudflared documented as manual alternative) |
| 7 | "No telemetry" claim contradicted by local usage stats | Low | **Fixed in docs.** README now says "local-only usage stats, nothing leaves your machine" |
| 8 | Hardcoded OS string ("Linux Mint 22.3") on every system | Low | **Fixed.** Real detection from `/etc/os-release`/`platform.*` (verified: reports Fedora 44 on this box) |
| 9 | No CSRF protection on state-changing endpoints | Medium | **Fixed.** CSRF token minted at login, required for cookie-authed POST/PUT/PATCH/DELETE |
| 10 | No security headers (XSS/framing/mime hardening) | Medium | **Fixed.** CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control: no-store` on API responses |

### Correction of an earlier audit claim

A previous draft of this audit claimed the WebSocket terminal was
"unauthenticated" because Flask `before_request` hooks don't run for
WebSocket upgrades. **Empirically verified false:** flask-sock registers
normal Flask routes, so the handshake passes through `before_request` and
was HTTP-gated all along (probe: unauthenticated handshake → 401,
authenticated → connected). The real gap was narrower: browsers cannot set
auth headers on WebSocket connections and SameSite cookies are not sent
cross-origin, so terminal/voice sockets were unusable over tunnel URLs —
now solved with the explicit `?token=` mechanism.

## Remaining, accepted limitations

- **Sessions are in-memory.** A restart logs everyone out. Acceptable for
  a single-user self-hosted app; documented.
- **CSP allows `'unsafe-inline'` for scripts.** The SPA uses inline
  `onclick` handlers; removing them is frontend work tracked separately.
  External script sources are restricted to self + jsdelivr (xterm),
  and `object-src 'none'` / `frame-ancestors 'none'` are set.
- **Rate limiting is per-IP and in-memory.** Sufficient against casual
  attackers; a determined distributed brute-force is mitigated by the
  passcode length (8 digits ≈ 10^8) and backoff. Per-account lockout
  would need a persistent store.
- **HTTP on localhost is plaintext.** Intentional: the tunnel provides
  TLS; localhost traffic never leaves the machine. Binding beyond
  localhost (e.g. Tailscale Serve on the tailnet IP) is supported but
  warned about loudly.
- **`?token=` query parameters** are visible in request logs. The request
  logger records paths only (no query strings). Tokens expire in 30 days
  and revoke on logout/restart.

## Test coverage (93 tests, `pytest tests/`)

- Login: wrong passcode, missing passcode, raw-pin-as-Bearer rejection,
  cookie-is-token-not-pin, backoff/lockout, session cap, expiry, logout
  invalidation
- CSRF: cookie POST rejected without/with-wrong token, accepted with
  token; Bearer POST CSRF-safe
- WebSocket auth helper: cookie, Bearer, query token, unknown/expired
  tokens, raw passcode rejected, open mode
- Command allowlist: 15 injection payloads → 403; allowed commands work;
  table itself is shell-metacharacter-free
- File browser: traversal attempts on browse/download/shred/trash/poof,
  symlink-escape refusals for shred/trash/poof, auth required on every
  destructive endpoint
- Misc: security headers, API no-store, OS detection, Ollama input caps,
  book-position API (roundtrip, type rejection, newest-write-wins)
- Self-updater: auth on all endpoints, ref whitelist, dirty-tree refusal
  (fetch never runs), unknown-ref rejection, marker file handling,
  boot-failure rollback logic

CI runs the suite on Ubuntu, macOS, and Windows.

## Self-update safety design

The Settings → About updater is the highest-risk feature in the app (it
can change the code the user runs remotely), so it is built fail-safe:

1. **Explicit** — the UI shows the exact tag and release notes; nothing
   updates silently. The ref is a whitelisted tag name; git receives it
   as a single argument.
2. **Read-only until verified** — `git fetch` first, then `git checkout
   --detach` *without* `-f`, so git itself refuses to clobber any local
   modification. A dirty working tree is refused before anything runs.
3. **Verification before switch** — the new code must pass
   `py_compile` AND a live boot probe on a scratch port. Any failure
   checks the previous revision back out and the running app is never
   touched.
4. **Self-healing boot** — if the new code still crashes on the real
   startup (within 10 minutes of the update), `app.py` checks out the
   previous revision before exiting, so systemd's `Restart=always`
   brings the working version up instead of crash-looping.
5. **Revert path** — "Revert last update" returns to the recorded
   pre-update revision through the same guarded path.
6. **Bounded** — single-flight lock, 3 attempts/15 min rate limit,
   cached read-only version check against a hardcoded GitHub host (no
   SSRF surface).

Verified live in a throwaway clone: a deliberately broken release was
rejected by the boot probe and rolled back automatically with the
working version left running; a good release applied cleanly; the
revert endpoint returned to the previous revision. The restart is a
detached SIGTERM→SIGKILL escalation handled by the service manager
(install.sh sets `Restart=always`).

## Verdict

**SAFE to ship as a self-hosted alpha**, with the accepted limitations
above. Do not expose it beyond localhost/tailnet without a passcode, and
keep the passcode at 8+ characters.
