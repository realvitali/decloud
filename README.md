# DeCloud

A self-hosted PWA dashboard for audiobooks, AI chat, file browsing, system monitoring, and more. Secure by default, no accounts, no cloud dependencies.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **📚 Audiobooks** — Real-time word highlighting, voice playback (Piper TTS), bookmarks. Reads PDF, JSON, and TXT.
- **💬 AI Chat** — Local LLM via Ollama, or cloud models
- **📁 Files** — Fast file browser with thumbnail previews, image gallery
- **🎨 Generate** — AI image generation via ComfyUI (FLUX, SDXL, etc)
- **📊 System Monitor** — CPU, RAM, GPU, network stats in real time
- **🖥️ Terminal** — Full interactive web terminal (WebSocket-based)
- **🎵 Music** — Browse and play your local music library
- **🔐 Privacy Scanner** — Optional OSINT tool to find and remove your data from broker sites
- **📓 Journal** — Optional Obsidian vault integration with voice notes (Whisper STT)

All features are optional — the app works with zero configuration. Features that need external services (Ollama, ComfyUI, Piper) gracefully degrade and show helpful messages until configured.

## Quick Start

### Prerequisites

- Linux or macOS (Linux recommended for GPU features)
- Python 3.10+
- [Tailscale](https://tailscale.com) for secure remote access (recommended)

### Install

```bash
git clone <repo-url> ~/decloud
cd ~/decloud
./install.sh
```

The installer:
1. Creates a Python virtual environment
2. Installs all dependencies
3. Creates a `.env` config file with a random secret key
4. Sets up a systemd service (auto-starts on boot, auto-restarts on crash)
5. Starts a secure tunnel via Tailscale Funnel
6. Prints the URL + QR code for your phone

### Access from anywhere

DeCloud uses **Tailscale Funnel** for secure remote access:

- **Permanent URL**: `https://your-machine.tail1234.ts.net`
- **No port forwarding** — works behind NAT/firewalls
- **End-to-end encrypted** — WireGuard + TLS 1.3
- **Friends don't need Tailscale** — they just open the link

The first time you open DeCloud, enter your passcode to unlock (tap ✓ after typing).

## Configuration

All configuration is via environment variables in `.env` (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `DECLOUD_PORT` | `8899` | Port to run on |
| `DECLOUD_PIN` | *(random)* | Passcode to unlock the app (8+ chars recommended) |
| `DECLOUD_BOOKS_DIR` | `~/Books` | Where your books live |
| `DECLOUD_FILES_DIR` | `~/Files` | Directory for the Files browser |
| `DECLOUD_MUSIC_DIR` | `~/Music/decloud-music` | Music library path |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama LLM endpoint |
| `DECLOUD_LLM_MODEL` | `llama3.2` | Default LLM model |
| `COMFY_URL` | `http://localhost:8188` | ComfyUI endpoint |
| `DECLOUD_PIPER_DIR` | `~/.local/share/piper` | Piper TTS voice models |

### Optional features

| Variable | Description |
|---|---|
| `DECLOUD_OSINT_DIR` | Path to osint-tools for privacy scanner |
| `DECLOUD_JOURNAL_DIR` | Obsidian vault path for journal features |
| `DECLOUD_HERMES_HOME` | Hermes Agent home for the Agents panel |

## CLI Commands

```bash
./decloud start      # Start app + tunnel
./decloud stop       # Stop everything
./decloud restart    # Restart app + tunnel
./decloud status     # Show what's running
./decloud qr         # Show current URL + QR code
./decloud version    # Show version
```

## Architecture

```
app.py                  # Entry point, SSL/network setup
shared.py               # Config, shared state, helpers
decloud                 # CLI wrapper (start/stop/qr/status)
requirements.txt        # Python dependencies
install.sh              # One-command installer

routes/                 # Flask Blueprints (one per feature)
  __init__.py           # Blueprint registry
  books.py              # Audiobook API
  ollama.py             # AI chat proxy
  lego.py               # File browser
  terminal.py           # WebSocket terminal
  system.py             # System stats
  ...

templates/
  index.html            # Single-page app entry

static/
  css/                  # Stylesheets (liquid glass design)
  js/
    app.js              # Bootstrap
    modules/            # Feature modules (one per app)
  icons/                # PWA icons
  manifest.json         # PWA manifest
  sw.js                 # Service worker
```

### Adding a new feature

1. Create `routes/myfeature.py` with a Blueprint
2. Register it in `routes/__init__.py`
3. Create `static/js/modules/myfeature.js`
4. Add it to the `APPS` array in `static/js/modules/core.js`
5. Bump the cache version in `static/sw.js`

No changes to `app.py` needed.

## Optional Integrations

### Ollama (AI Chat)
```bash
# Install: https://ollama.com
ollama pull llama3.2
```

### ComfyUI (Image Generation)
```bash
# Install: https://github.com/comfyanonymous/ComfyUI
# Start it, then set COMFY_URL in .env
```

### Piper TTS (Audiobook Voices)
```bash
# Install: pip install piper-tts
# Download voice models to ~/.local/share/piper/
# Get voices from: https://github.com/rhasspy/piper/blob/master/VOICES.md
```

## Design

Liquid glass aesthetic: frosted glass cards, rounded corners (22px), indigo accent (#6366f1). Light mode default with auto dark mode. Mobile-first responsive layout.

## Service Management

```bash
systemctl --user status decloud      # Check status
systemctl --user restart decloud     # Restart after config changes
systemctl --user stop decloud        # Stop
journalctl --user -u decloud -f      # View live logs
```

## Security

- **Passcode authentication** — the app is locked behind `DECLOUD_PIN`
  (8 digits generated at install; passphrases up to 64 chars). The
  passcode is only used at login; after that the app uses an opaque
  session token (never the passcode) with a 30-day expiry.
- **CSRF protection** — state-changing requests require a per-session
  CSRF token.
- **Rate limiting + lockout** — 5 login attempts per minute per IP, with
  exponential backoff after repeated failures.
- **Localhost by default** — the app binds to 127.0.0.1 unless you
  explicitly set `DECLOUD_HOST`; binding wider prints a loud warning.
- **Tailscale Funnel only** — no third-party relay fallbacks. End-to-end
  encrypted tunnel, no open ports. (cloudflared works manually if you
  prefer.)
- **Hardened shell** — quick commands run shell-free from a fixed
  allowlist; the interactive terminal requires the session token,
  including over tunnels.
- **Security headers** — CSP, X-Frame-Options, nosniff, Referrer-Policy,
  and no-store caching on API responses.
- **Local-only usage stats** — the Usage screen logs activity to a local
  JSON file; nothing is tracked externally, nothing leaves your machine.

See [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for the full audit and its
accepted limitations.

## Testing

```bash
pip install -r requirements-dev.txt
python -m pytest tests/        # 74 security + smoke tests
```

CI runs the suite on Ubuntu, macOS, and Windows.

## Windows

Windows is supported (the app itself runs anywhere Python 3.10+ does):

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1   # install + logon task
.\decloud.ps1 status                                   # manage the app
```

The interactive web terminal requires Linux/macOS (it uses a PTY) and
shows a friendly message on Windows; every other feature works.

## License

MIT — see [LICENSE](LICENSE).
