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

# ─── Install tunnel client (for secure HTTPS access from phone) ──
# localhost.run is primary — free, no account, no interstitial page.
# Just needs SSH (pre-installed on macOS/Linux/WSL).
# cloudflared is offered as a fallback.
TUNNEL_TOOL=""

if command -v ssh &>/dev/null; then
    TUNNEL_TOOL="localhost-run"
    echo "✓ Tunnel client ready (localhost.run via SSH)"
elif command -v cloudflared &>/dev/null; then
    TUNNEL_TOOL="cloudflared"
    echo "✓ Tunnel client ready (cloudflared)"
elif command -v npx &>/dev/null; then
    TUNNEL_TOOL="localtunnel"
    echo "✓ Tunnel client ready (localtunnel via npx)"
else
    # Try to install cloudflared as fallback
    echo "→ Installing cloudflared (for secure HTTPS tunnel)..."
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64|amd64)  CF_ARCH="amd64" ;;
        aarch64|arm64) CF_ARCH="arm64" ;;
        *)             CF_ARCH="" ;;
    esac
    if [ -n "$CF_ARCH" ] && [ "$OS_TYPE" != "macos" ]; then
        curl -sSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
            -o "$HOME/.local/bin/cloudflared" 2>/dev/null && \
            chmod +x "$HOME/.local/bin/cloudflared" && \
            TUNNEL_TOOL="cloudflared" && echo "✓ cloudflared installed"
    fi
    if [ -z "$TUNNEL_TOOL" ]; then
        echo "⚠ No tunnel client available. SSH is required for localhost.run:"
        echo "   (SSH comes pre-installed on macOS, Linux, and WSL)"
    fi
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

    # Generate a random 6-digit PIN for app access
    PIN=$($PYBIN -c "import secrets; print(''.join(str(secrets.randbelow(10)) for _ in range(6)))")
    echo "DECLOUD_PIN=$PIN" >> .env
    echo "✓ .env created (edit it to customize paths)"
fi

# Lock down .env — contains PIN, SECRET_KEY, and any user-supplied tokens.
chmod 600 .env 2>/dev/null || true

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

# ─── Start DeCloud (app + tunnel together) ───────────────────────
echo ""
echo "→ Starting DeCloud..."
chmod +x "$APP_DIR/decloud"

# Check if app is already running (from systemd)
if curl -s http://localhost:${DECLOUD_PORT:-8899}/ > /dev/null 2>&1; then
    echo "✓ App already running via systemd"
    # Just start the tunnel if not already running
    if [ ! -f "$APP_DIR/tunnel.pid" ] || ! kill -0 $(cat "$APP_DIR/tunnel.pid" 2>/dev/null) 2>/dev/null; then
        echo "Starting tunnel..."
        nohup ssh -R 80:localhost:${DECLOUD_PORT:-8899} nokey@localhost.run \
            -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
            -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
            > "$APP_DIR/tunnel.log" 2>&1 &
        echo $! > "$APP_DIR/tunnel.pid"
        sleep 3
    else
        echo "✓ Tunnel already running"
    fi
else
    # No systemd or app not running — start both
    "$APP_DIR/decloud" start
fi

# Get the tunnel URL from the log
TUNNEL_LOG="$APP_DIR/tunnel.log"
TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.lhr\.life' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)

if [ -n "$TUNNEL_URL" ]; then
    echo "✓ Tunnel active: $TUNNEL_URL"
    ACCESS_URL="$TUNNEL_URL"
else
    echo "⚠ Tunnel failed to start. Local access only:"
    ACCESS_URL="https://localhost:${PORT}"
    echo "  $ACCESS_URL"
    echo "  To start tunnel manually: cloudflared tunnel --url https://localhost:${PORT}"
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
    echo "📱 TEMPORARY TUNNEL (test only): $TUNNEL_URL"
    echo "   PIN: ${DECLOUD_PIN:-set DECLOUD_PIN env var}"
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