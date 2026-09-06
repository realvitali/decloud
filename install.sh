#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# DeCloud — Installer
# Works on: Linux (systemd), macOS (launchd), WSL
# One command: curl -sSL <repo>/install.sh | bash
# Or: ./install.sh
# ═══════════════════════════════════════════════════════════════
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="decloud"

# ─── Detect OS ──────────────────────────────────────────────────
OS_TYPE="linux"
if [[ "$(uname)" == "Darwin" ]]; then
    OS_TYPE="macos"
elif [[ "$(uname -r)" == *microsoft* ]] || [[ "$(uname -r)" == *Microsoft* ]]; then
    OS_TYPE="wsl"
fi

echo "╔══════════════════════════════════════════════╗"
echo "║   DeCloud — Installer                        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Detected: $OS_TYPE ($(uname -s) $(uname -r))"
echo ""

# ─── One-click updates require a git clone ───────────────────────
# The in-app updater (Settings → About → Check for updates) checks out new
# versions via git. A ZIP/tarball install works fine but can't self-update.
if ! git -C "$APP_DIR" rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
    echo "⚠ This is NOT a git checkout — the in-app updater will be unavailable."
    echo "  The app installs and runs fine, but for one-click updates reinstall with:"
    echo ""
    echo "    git clone https://github.com/realvitali/decloud ~/decloud"
    echo "    cd ~/decloud && ./install.sh"
    echo ""
fi

# ─── Check Python ───────────────────────────────────────────────
if command -v python3 &>/dev/null; then
    PYBIN=python3
elif command -v python &>/dev/null; then
    PYBIN=python
else
    echo "✗ Python 3 is required."
    if [ "$OS_TYPE" = "macos" ]; then
        echo "  Install it: brew install python3"
    else
        echo "  Install it: sudo apt install python3 python3-venv"
        echo "  Or:         sudo dnf install python3 python3-devel"
    fi
    exit 1
fi
PYVER=$($PYBIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "✓ Python $PYVER found"

if [[ "$PYVER" < "3.10" ]]; then
    echo "✗ Python 3.10+ required. You have $PYVER"
    exit 1
fi

# ─── Install uv (fast Python package manager) ───────────────────
if ! command -v uv &>/dev/null; then
    echo "→ Installing uv (fast Python package manager)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi
echo "✓ uv ready"

# ─── Install qrencode (for QR code) ─────────────────────────────
if ! command -v qrencode &>/dev/null; then
    echo "→ Installing qrencode (for phone QR code)..."
    if [ "$OS_TYPE" = "macos" ]; then
        if command -v brew &>/dev/null; then
            brew install qrencode 2>/dev/null || echo "  (optional — skipped)"
        fi
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y qrencode 2>/dev/null || echo "  (optional — skipped)"
    elif command -v apt-get &>/dev/null; then
        sudo apt-get install -y qrencode 2>/dev/null || echo "  (optional — skipped)"
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm qrencode 2>/dev/null || echo "  (optional — skipped)"
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y qrencode 2>/dev/null || echo "  (optional — skipped)"
    else
        echo "  (qrencode not found — QR code will be skipped)"
    fi
fi

# ─── Install ffmpeg (audio: Whisper STT + Piper TTS) ─────────────
if ! command -v ffmpeg &>/dev/null; then
    echo "→ Installing ffmpeg (for voice)..."
    if [ "$OS_TYPE" = "macos" ]; then
        command -v brew &>/dev/null && brew install ffmpeg 2>/dev/null || echo "  (optional — skipped)"
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y ffmpeg 2>/dev/null || echo "  (optional — skipped)"
    elif command -v apt-get &>/dev/null; then
        sudo apt-get install -y ffmpeg 2>/dev/null || echo "  (optional — skipped)"
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm ffmpeg 2>/dev/null || echo "  (optional — skipped)"
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y ffmpeg 2>/dev/null || echo "  (optional — skipped)"
    else
        echo "  (ffmpeg not found — install it manually for voice)"
    fi
else
    echo "✓ ffmpeg ready"
fi

# ─── Tunnel client (for secure HTTPS access from phone) ──────────
# Tailscale Funnel is the only supported tunnel: it terminates TLS on your
# own machine and requires your own tailnet. We deliberately do NOT use
# third-party relays (localhost.run, localhost tunnel via SSH) — those
# forward plaintext HTTP through someone else's box, which contradicts
# DeCloud's privacy story. cloudflared (your own Cloudflare account) is the
# fallback.
TUNNEL_TOOL=""

if command -v tailscale &>/dev/null; then
    TUNNEL_TOOL="tailscale"
    echo "✓ Tunnel client ready (Tailscale Funnel)"
elif command -v cloudflared &>/dev/null; then
    TUNNEL_TOOL="cloudflared"
    echo "✓ Tunnel client ready (cloudflared — your own Cloudflare account)"
else
    echo "⚠ No tunnel client available."
    echo "  Install Tailscale: curl -fsSL https://tailscale.com/install.sh | sh"
    echo "  Then: sudo tailscale up  (login to your account)"
    echo "  (Alternative: install cloudflared from developers.cloudflare.com)"
fi

# ─── Create venv + install deps ─────────────────────────────────
echo "→ Creating virtual environment..."
cd "$APP_DIR"
uv venv .venv --python "$PYBIN"
echo "→ Installing dependencies (this takes a minute)..."
uv pip install -r requirements.txt
echo "✓ Dependencies installed"

# ─── Create .env from example if none exists ────────────────────
if [ ! -f .env ]; then
    echo "→ Creating .env from template..."
    cp .env.example .env

    # Generate a random secret key
    SECRET=$($PYBIN -c "import secrets; print(secrets.token_hex(32))")
    if [ "$OS_TYPE" = "macos" ]; then
        sed -i '' "s/change-me-to-a-random-string/$SECRET/" .env
    else
        sed -i "s/change-me-to-a-random-string/$SECRET/" .env
    fi

    # Generate a random 8-digit passcode for app access (longer = harder
    # to brute-force; the app warns if you shorten it below 8 characters)
    PIN=$($PYBIN -c "import secrets; print(''.join(str(secrets.randbelow(10)) for _ in range(8)))")
    # Idempotent: replace any existing DECLOUD_PIN line, else append.
    if grep -q '^DECLOUD_PIN=' .env 2>/dev/null; then
        if [ "$OS_TYPE" = "macos" ]; then
            sed -i '' "s/^DECLOUD_PIN=.*/DECLOUD_PIN=$PIN/" .env
        else
            sed -i "s/^DECLOUD_PIN=.*/DECLOUD_PIN=$PIN/" .env
        fi
    else
        echo "DECLOUD_PIN=$PIN" >> .env
    fi
    echo "✓ .env created (edit it to customize paths)"
fi

# Lock down .env — contains PIN, SECRET_KEY, and any user-supplied tokens.
chmod 600 .env 2>/dev/null || true

# ─── Piper TTS voices (downloaded so speech works out of the box) ──
PIPER_DIR=$(grep '^DECLOUD_PIPER_DIR=' .env 2>/dev/null | cut -d= -f2- | sed 's/^"//;s/"$//')
if [ -z "$PIPER_DIR" ]; then
    PIPER_DIR="$HOME/.local/share/piper"
fi
PIPER_DIR=$(eval echo "$PIPER_DIR")  # expand ~
mkdir -p "$PIPER_DIR"
_fetch_voice() {
    local name="$1" quality="$2"
    local base="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/${name}/${quality}/en_US-${name}-${quality}"
    if [ ! -f "$PIPER_DIR/en_US-${name}-${quality}.onnx" ]; then
        echo "→ Downloading Piper voice ${name} (${quality})…"
        curl -sSL "${base}.onnx" -o "$PIPER_DIR/en_US-${name}-${quality}.onnx" \
            || echo "  (voice ${name} download failed — speech will use browser TTS)"
    fi
    if [ ! -f "$PIPER_DIR/en_US-${name}-${quality}.onnx.json" ]; then
        curl -sSL "${base}.onnx.json" -o "$PIPER_DIR/en_US-${name}-${quality}.onnx.json" 2>/dev/null || true
    fi
}
_fetch_voice "lessac" "high"
_fetch_voice "lessac" "medium"
_fetch_voice "kathleen" "low"

# ─── SSL certs not needed — tunnel handles HTTPS ────────────────
# The app runs HTTP on localhost only (not exposed). The cloudflared
# tunnel provides trusted HTTPS externally. No local certs needed.

# ─── Service setup (platform-specific) ──────────────────────────
echo ""
PORT=$(grep DECLOUD_PORT .env 2>/dev/null | cut -d= -f2 || echo "8899")

if [ "$OS_TYPE" = "macos" ]; then
    echo "→ Setting up macOS LaunchAgent..."
    LAUNCH_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$LAUNCH_DIR"
    PLIST_FILE="$LAUNCH_DIR/com.decloud.app.plist"

    cat > "$PLIST_FILE" << 'PLISTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.decloud.app</string>
    <key>WorkingDirectory</key>
    <string>__APP_DIR__</string>
    <key>ProgramArguments</key>
    <array>
        <string>__APP_DIR__/.venv/bin/python</string>
        <string>__APP_DIR__/app.py</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>__APP_DIR__/decloud.log</string>
    <key>StandardErrorPath</key>
    <string>__APP_DIR__/decloud.log</string>
</dict>
</plist>
PLISTEOF
    sed -i '' "s|__APP_DIR__|${APP_DIR}|g" "$PLIST_FILE"
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    launchctl load "$PLIST_FILE" 2>/dev/null
    echo "✓ LaunchAgent installed and started"

elif [ "$OS_TYPE" = "wsl" ]; then
    echo "→ Setting up WSL background service..."
    pkill -f "python.*app.py" 2>/dev/null || true
    nohup "$APP_DIR/.venv/bin/python" "$APP_DIR/app.py" > "$APP_DIR/decloud.log" 2>&1 &
    echo $! > "$APP_DIR/decloud.pid"
    echo "✓ DeCloud started (PID: $(cat "$APP_DIR/decloud.pid"))"

else
    # Linux: systemd user service
    echo "→ Setting up systemd user service..."
    sudo loginctl enable-linger $(whoami) 2>/dev/null || true

    SERVICE_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SERVICE_DIR"
    SERVICE_FILE="$SERVICE_DIR/${SERVICE_NAME}.service"

    cat > "$SERVICE_FILE" << SVCEOF
[Unit]
Description=DeCloud
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${APP_DIR}/.venv/bin/python ${APP_DIR}/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
SVCEOF

    systemctl --user daemon-reload
    systemctl --user enable decloud
    systemctl --user restart decloud
    echo "✓ Service installed and started"
fi

# ─── Start DeCloud (app + Tailscale funnel together) ─────────────
echo ""
echo "→ Starting DeCloud..."
chmod +x "$APP_DIR/decloud"

# The decloud wrapper starts the app and the Tailscale funnel together
# (no third-party relays). A non-root user may need `sudo tailscale funnel`.
"$APP_DIR/decloud" start

# Get the funnel URL (can take a few seconds to appear)
TUNNEL_URL=""
for _ in 1 2 3 4 5; do
    TUNNEL_URL=$(tailscale funnel status 2>/dev/null | grep -oP 'https://[a-z0-9-]+\.tail[a-z0-9-]+\.ts\.net' | head -1)
    [ -n "$TUNNEL_URL" ] && break
    sleep 2
done

if [ -n "$TUNNEL_URL" ]; then
    echo "✓ Funnel active: $TUNNEL_URL"
    ACCESS_URL="$TUNNEL_URL"
else
    echo "⚠ Funnel not active yet. Local access only:"
    ACCESS_URL="http://localhost:${PORT}"
    echo "  $ACCESS_URL"
    echo "  To start the tunnel: sudo tailscale funnel ${PORT}"
fi

# ─── Done ───────────────────────────────────────────────────────
PIN=$(grep DECLOUD_PIN .env 2>/dev/null | cut -d= -f2 || echo "")
echo ""
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✓ DeCloud installed!                       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "🌐 LOCAL ACCESS: http://localhost:${PORT}"
if [ -n "$TUNNEL_URL" ]; then
    echo "📱 TAILNET URL: $TUNNEL_URL"
    echo "   PIN: ${PIN:-set in .env}"
    echo ""
    echo "⚠️  This tunnel URL changes every few hours. For permanent access:"
    echo ""
    echo "📌 SETUP PERMANENT TUNNEL (5 min):"
    echo ""
    echo "   1. Install cloudflared:"
    if [ "$OS_TYPE" = "macos" ]; then
        echo "      brew install cloudflared"
    else
        echo "      sudo apt install cloudflared  # or: sudo dnf install cloudflared"
    fi
    echo ""
    echo "   2. Create a free Cloudflare account & tunnel:"
    echo "      cloudflared tunnel login"
    echo "      cloudflared tunnel create decloud"
    echo ""
    echo "   3. Point a domain (yours or free subdomain):"
    echo "      cloudflared tunnel route dns decloud mydomain.com"
    echo ""
    echo "   4. Run the tunnel:"
    echo "      cloudflared tunnel run decloud"
    echo ""
    echo "   Result: https://decloud.mydomain.com (permanent, never changes)"
    echo ""
    echo "🔐 ALTERNATIVE (Private-only access):"
    echo "   Use Tailscale for permanent HTTPS from your own devices:"
    echo "      sudo tailscale serve https / http://localhost:${PORT}"
    echo ""
fi
echo ""

# Print PIN
if [ -n "$PIN" ]; then
    echo "🔐 Your access PIN: $PIN"
    echo "   (Change it: nano ${APP_DIR}/.env)"
    echo ""
fi

# QR code
if [ -n "$TUNNEL_URL" ] && command -v qrencode &>/dev/null; then
    echo "📱 Scan this QR code with your phone camera:"
    echo ""
    qrencode -t ANSIUTF8 "$TUNNEL_URL" 2>/dev/null || qrencode -t ANSI "$TUNNEL_URL" 2>/dev/null
    echo ""
    echo "Or open manually: $TUNNEL_URL"
    echo "PIN: $PIN"
    echo ""
    echo "   Add to Home Screen for a native app experience:"
    echo "   • iPhone: Safari → Share → Add to Home Screen"
    echo "   • Android: Chrome → ⋮ → Add to Home screen"
elif [ -n "$TUNNEL_URL" ]; then
    echo "📱 Open on your phone: $TUNNEL_URL"
    echo "   PIN: $PIN"
    echo ""
    echo "   Add to Home Screen for a native app experience:"
    echo "   • iPhone: Safari → Share → Add to Home Screen"
    echo "   • Android: Chrome → ⋮ → Add to Home screen"
else
    echo "📱 Install cloudflared for phone access:"
    echo "   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"
fi

echo ""
echo "Manage DeCloud:"
echo "  ./decloud status   — check what's running"
echo "  ./decloud qr       — show current tunnel URL + QR code"
echo "  ./decloud restart  — restart app + tunnel (new QR if tunnel changed)"
echo ""
echo "System service:"
if [ "$OS_TYPE" = "macos" ]; then
    echo "  launchctl list | grep decloud      # status"
    echo "  launchctl unload $PLIST_FILE       # stop"
    echo "  launchctl load $PLIST_FILE         # start"
elif [ "$OS_TYPE" = "wsl" ]; then
    echo "  ./decloud restart                  # restart everything"
else
    echo "  systemctl --user status decloud    # status"
    echo "  systemctl --user restart decloud   # restart"
    echo "  systemctl --user stop decloud      # stop"
fi
echo ""
echo "Uninstall: ./uninstall.sh"
echo "Edit settings: nano ${APP_DIR}/.env"