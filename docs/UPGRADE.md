# Upgrading a running DeCloud install to v0.0.2 (alpha WIP)

This file is for the agent (or human) operating the PC where DeCloud runs.
It upgrades an existing install in place, keeping your `.env` (passcode,
paths, secrets) untouched.

## 0. Before you start

- The remote PC keeps running the OLD code until step 4 — plan a ~1 minute
  window where the app restarts.
- Your `.env` is NEVER overwritten. Do not extract a fresh `.env`.
- After the upgrade every device has to log in again once (session tokens
  are in-memory and the service restarts). The passcode is unchanged.

## 1. Transfer the release package to this PC

From the laptop (over Tailscale, or however you prefer):

```sh
scp decloud-v0.0.2-wip.tar.gz <user>@<this-pc>:/tmp/
```

## 2. Back up the current install

```sh
cd ~/decloud        # adjust if installed elsewhere
tar czf /tmp/decloud-backup-$(date +%F-%H%M%S).tar.gz \
    --exclude='audio_cache' --exclude='thumb_cache' --exclude='.venv' \
    --exclude='__pycache__' .
```

## 3. Extract the new code

```sh
cd ~/decloud
tar xzf /tmp/decloud-v0.0.2-wip.tar.gz
chmod +x decloud install.sh uninstall.sh 2>/dev/null || true
chmod 600 .env 2>/dev/null || true          # .env untouched, just re-lock perms
```

The tarball contains no `.env`, no caches, no `.venv`, no logs — only code,
static assets, and scripts. Your existing `.env`, `audio_cache/` (generated
audiobooks!), and `.venv` all survive.

Python dependencies are unchanged in this release, so the existing `.venv`
keeps working. If the app fails to boot with an import error, run:

```sh
./.venv/bin/pip install -r requirements.txt
```

## 4. Restart the service

```sh
systemctl --user restart decloud
systemctl --user status decloud
tail -30 app.log        # look for a clean boot line and NO tracebacks
```

If it was started via the wrapper instead:

```sh
./decloud restart && ./decloud status
```

## 5. Verify locally on this PC

```sh
curl -s http://localhost:8899/api/auth/check
# open mode:  {"authenticated":true,"open_mode":true}
# pin mode:   {"authenticated":false,"open_mode":false}  -> expected until login
./decloud qr            # funnel URL should be unchanged
```

## 6. Test from the laptop (the real test)

1. Open the funnel URL in the browser.
2. **Hard-refresh once** (Ctrl+Shift+R) — the PWA service worker cache
   version bumped to v90.
3. Log in with the SAME passcode as before (6–8 digits, tap the new ✓ GO
   key after entering it).
4. Check, in this order:
   - Home dashboard loads, system monitor shows the **real OS** (not
     "Linux Mint 22.3").
   - **Books**: list loads, chapter counts are correct, open a book,
     word highlighting follows audio, bookmarks/resume work.
   - **AI chat** (Ollama): streams replies, shows errors instead of hanging
     when Ollama is down.
   - **Terminal over the tunnel** (this was broken before): opens, runs
     commands, resizes. The upgrade passes the session token on the
     WebSocket so it works cross-origin now.
   - **Files**: browse, thumbnails, swipe mode, trash/poof/shred all work.
5. Try logging in with a WRONG passcode 5+ times quickly — it should lock
   out for a minute (rate limit).

## 7. If anything is broken

Roll back:

```sh
cd ~/decloud
tar xzf /tmp/decloud-backup-<timestamp>.tar.gz   # restores old code
systemctl --user restart decloud
```

and report what failed (paste the tail of `app.log`).

## What changed (v0.0.2 alpha WIP)

- **Security**: opaque session tokens (the PIN is no longer stored in a
  cookie); CSRF protection on state-changing calls; WebSocket terminal and
  voice sockets now require the session token (explicitly, and via
  `?token=` for tunnel use); shell-free allowlisted quick commands (no
  `shell=True` anywhere); login brute-force backoff; security headers
  (CSP, X-Frame-Options, nosniff, Referrer-Policy); the third-party
  `localhost.run` relay fallback was REMOVED — tunnel is Tailscale Funnel
  only (or cloudflared, manually).
- **Cross-platform**: real OS detection (deb/rpm/macOS/Windows), Windows
  installer (`setup.ps1`) and wrapper (`decloud.ps1`), PTY terminal
  degrades gracefully on Windows.
- **Books**: correct per-book chapter totals and done counts.
