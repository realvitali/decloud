# DeCloud — Agent Handoff Document

> Written 2026-09-02. This is the authoritative "how the code actually works right now"
> reference for handing DeCloud to another agent or developer. Read this before touching
> anything. It documents real behavior, quirks, and known issues — not aspirational design.

---

## 1. What DeCloud Is

A self-hosted personal cloud OS. Single Flask app + vanilla-JS frontend (no framework, no
build step). Runs on `localhost:8899`, reached remotely via Tailscale **Serve** (tailnet-only).
MIT-licensed, public at `github.com/realvitali/decloud`.

**Core philosophy:** everything local, nothing leaves the machine, passcode-gated, no accounts.

---

## 2. Architecture

```
app.py                  # entry point; binds 127.0.0.1; update safety-net; registers blueprints
shared.py               # THE hub: Flask app, auth, config, paths, LLM helpers, security headers
routes/                 # one file per feature (Flask blueprints)
  auth.py               #   login/logout, session tokens, CSRF
  books.py music.py files(lego.py)   #   media libraries
  ollama.py comfy.py    #   AI chat + image gen
  agents.py bots.py     #   Hermes agent profiles as chat bots
  system.py             #   system monitor (CPU/RAM/disk/temps + NEW: specs)
  terminal.py           #   web terminal (xterm + WebSocket)
  voice.py journal.py   #   voice assistant + journaling (experimental)
  universe.py           #   journal "universe" graph
  osint.py              #   privacy watcher
  projects.py           #   project tracking (experimental)
  update.py version.py  #   self-update + version/changelog
  devices.py telemetry.py pwa.py graph.py settings.py
static/js/modules/      # one JS file per feature, loaded as classic <script> tags (NOT ES modules)
templates/index.html    # single-page app; ALL screens live here
decloud                 # bash lifecycle wrapper (start/stop/restart/qr/status)
install.sh setup.ps1    # Linux / Windows installers
```

**Key architectural fact:** the frontend is a single `index.html` with every screen as a
`<div class="screen">`. JS modules are plain scripts that attach functions to `window`/global
scope. There is **no module system** — load order matters (see Quirks #1).

---

## 3. Auth Model (important)

- Passcode = `DECLOUD_PIN` in `.env` (8+ chars recommended, max 64).
- Login exchanges the PIN for an **opaque session token** (random, stored in in-memory
  `SESSIONS` dict with 30-day TTL, max 50 sessions). The PIN is **never** stored in the browser.
- CSRF: every state-changing request needs a CSRF token derived from the session token
  (`hmac(SECRET_KEY, token)`).
- `SECRET_KEY` in `.env`; if missing, an ephemeral one is generated (sessions won't survive
  restart — warn the user to set it).
- WebSocket endpoints (terminal, voice) require the session token via `?token=` query param.
- Rate limiting + brute-force backoff on login.

---

## 4. Config / Paths

All via `.env` (see `.env.example`). Key vars:

| Var | Default | Notes |
|---|---|---|
| `DECLOUD_PIN` | *(required)* | passcode |
| `SECRET_KEY` | *(generated)* | session signing |
| `DECLOUD_PORT` | 8899 | |
| `DECLOUD_HOST` | 127.0.0.1 | binding wider prints a loud warning |
| `DECLOUD_BOOKS_DIR` | ~/Books | |
| `DECLOUD_MUSIC_DIR` | ~/Music/decloud-music | |
| `DECLOUD_FILES_DIR` | ~/Files | |
| `OLLAMA_HOST` | localhost:11434 | |
| `DECLOUD_LLM_MODEL` | llama3.2 | |
| `COMFY_URL` | localhost:8188 | |
| `DECLOUD_PIPER_DIR` | ~/.local/share/piper | TTS voices |
| `DECLOUD_JOURNAL_DIR` | *(unset)* | Obsidian vault for journal |
| `DECLOUD_HERMES_HOME` | *(unset)* | for Agents panel |

Library paths are also editable in Settings → Paths (writes back to `.env`).

---

## 5. Tunneling (recently changed — READ THIS)

**DeCloud is tailnet-only by design. There is NO public Funnel mode anymore.**

- `./decloud start` → starts app + `tailscale serve` (tailnet-only).
- The `share` command (which switched to public Funnel) was **removed** 2026-09-02.
- All funnel references scrubbed from code + docs. Remaining "funnel" mentions are:
  - `routes/devices.py` — Tailscale's real `funnel-ingress-node` API field (legit, keep).
  - `routes/version.py` — historical changelog entry (keep).
  - `PERMANENT_TUNNEL.md` — the "why Serve not Funnel" explanation (keep).
- If public access is ever needed, use a Cloudflare Named Tunnel with your own auth in front.
- The `decloud-funnel.service` systemd unit was disabled (leftover from the old Funnel era).

---

## 6. Quirks & Gotchas (the stuff that bites)

1. **Script load order is fragile.** `lego3d.js` runs `restoreFromHash()` at load, which can
   call `showScreen()` → `trackAppOpen()` (defined in `telemetry.js`, loaded LATER) and
   reference `voiceOpen` (a `let` in `voice.js`, also loaded later). This caused a real crash
   on `#system` deep-links. **Fix applied:** both are now guarded with `typeof` checks in
   `home.js`. If you add a cross-module call, guard it the same way.

2. **Cache-busting is mandatory.** CSS/JS load with `?v=N` in `templates/index.html`. Every
   visual/JS change requires bumping `?v=N` (currently v97) or the user sees stale assets.
   This was the root cause of repeated "still purple" / "still broken" complaints.

3. **The running process can go stale.** DeCloud runs under systemd
   (`cabin-command-center.service`). If you `git checkout`/rebase the working tree, the running
   process keeps serving OLD code until restarted. Symptom: "my music is gone" (it wasn't —
   the process was stale). Always `systemctl --user restart cabin-command-center.service`
   after code changes.

4. **`detect_os()` version duplication.** `/etc/os-release` `PRETTY_NAME` already contains the
   version on Mint ("Linux Mint 22.3"), so the old code produced "Linux Mint 22.3 22.3".
   Fixed with a `version.split()[0] not in pretty` guard. Don't regress this.

5. **Voice orb is experimental-gated.** Hidden by default (`display:none` in CSS). Only shows
   when Settings → "Experimental Apps" toggle is on AND you're on the home screen. The orb's
   show path sets `display:flex` explicitly (not `''`), because the CSS default is `none`.

6. **Experimental apps** (Journal, Legos, Projects, Voice) are flagged `experimental: true` in
   the `APPS` array in `core.js` and hidden behind the same toggle.

7. **GPU detection** in `routes/system.py` tries `nvidia-smi` first, falls back to `lspci`.
   On non-NVIDIA machines the `lspci` path needs `lspci` installed.

8. **Self-update** (`routes/update.py`) is git-based: it refuses to update if the tree is
   dirty, downloads/verifies/test-boots the new version, and auto-rolls-back on failed boot.
   The `app.py` boot safety-net checks a "last-good" marker.

---

## 7. Recent Changes (this session, uncommitted as of writing)

- **Funnel removal** — `share` command + all funnel refs gone; tailnet-only.
- **Voice orb gating** — hidden behind experimental toggle.
- **System specs tile** — fastfetch-style (OS/kernel/CPU/cores/GPU/RAM/disk/host) at top of
  System screen. New fields in `/api/system`: `cpu_model`, `gpu`, `disk_total`, `disk_used`.
- **Crash "Copy details" button** — crash overlay now has a copy-to-clipboard button.
- **Crash load-order fix** — `trackAppOpen`/`voiceOpen` `typeof` guards.
- **Learn tab** — per-app documentation in Settings (HTML panel + `renderLearnDocs()` in
  settings.js + `.learn-card` CSS). `APP_DOCS` array in settings.js is the source of truth;
  update it whenever an app changes.
- **`detect_os()` dedup fix** in shared.py.

---

## 8. Known Issues / TODO

- **Music path question** (resolved): path never changed; the "gone" symptom was a stale
  process. No code fix needed.
- **Learn tab docs** must be kept in sync with app changes (user's explicit requirement).
- **Voice chat** is still broken/unreliable — that's why it's experimental-gated.
- **Spark (DGX) migration** is a separate, ongoing effort — not part of this repo.

---

## 9. How to Run / Test

```bash
cd /home/vitali/cabin-command-center
./decloud start          # or: systemctl --user restart cabin-command-center.service
./decloud status         # check app + tunnel
./decloud qr             # show tailnet URL + QR
```

- Local: `http://localhost:8899`
- Tailnet: `https://cabin.tail44f1bb.ts.net` (tailnet-only)
- Auth: passcode from `.env` (`DECLOUD_PIN`)

**Testing note (user requirement):** DeCloud must be E2E-tested with a real browser
(clicks/scrolls like a human), not just curl/API. The user is NOT QA.

---

## 10. Git

- Branch: **`merged`** (NOT `main`, NOT detached HEAD). All fixes live on `merged`.
- `main` is the public GitHub branch; `merged` is ahead of it (12 commits at time of writing).
- Push flow: commit on `merged`, then merge/push to `main` when ready to publish.
- `.env` is gitignored (contains `DECLOUD_PIN` — never commit it).
