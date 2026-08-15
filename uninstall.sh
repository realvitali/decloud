#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# DeCloud — Uninstaller
# Removes the service, tunnel, venv, and config files.
# Your books/files/music are NOT touched — only DeCloud's own files.
# Works on: Linux (systemd), macOS (launchd), WSL
# ═══════════════════════════════════════════════════════════════
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="decloud"

# Detect OS
OS_TYPE="linux"
if [[ "$(uname)" == "Darwin" ]]; then
    OS_TYPE="macos"
elif [[ "$(uname -r)" == *microsoft* ]] || [[ "$(uname -r)" == *Microsoft* ]]; then
    OS_TYPE="wsl"
fi

echo "╔══════════════════════════════════════════════╗"
echo "║   DeCloud — Uninstaller                      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ─── Stop tunnel ────────────────────────────────────────────────
if [ -f "$APP_DIR/tunnel.pid" ]; then
    echo "→ Stopping tunnel..."
    kill "$(cat "$APP_DIR/tunnel.pid")" 2>/dev/null || true
    rm -f "$APP_DIR/tunnel.pid"
    echo "✓ Tunnel stopped"
else
    pkill -f "cloudflared tunnel.*localhost" 2>/dev/null && echo "✓ Tunnel stopped" || echo "• No tunnel found (skip)"
fi

# ─── Stop and remove service ────────────────────────────────────
if [ "$OS_TYPE" = "macos" ]; then
    PLIST_FILE="$HOME/Library/LaunchAgents/com.decloud.app.plist"
    if [ -f "$PLIST_FILE" ]; then
        echo "→ Removing LaunchAgent..."
        launchctl unload "$PLIST_FILE" 2>/dev/null || true
        rm -f "$PLIST_FILE"
        echo "✓ LaunchAgent removed"
    else
        echo "• No LaunchAgent found (skip)"
    fi

elif [ "$OS_TYPE" = "wsl" ]; then
    if [ -f "$APP_DIR/decloud.pid" ]; then
        echo "→ Stopping WSL background process..."
        kill "$(cat "$APP_DIR/decloud.pid")" 2>/dev/null || true
        rm -f "$APP_DIR/decloud.pid"
        echo "✓ Process stopped"
    else
        pkill -f "python.*app.py" 2>/dev/null && echo "✓ Process killed" || echo "• No process found (skip)"
    fi

else
    if systemctl --user list-unit-files 2>/dev/null | grep -q "$SERVICE_NAME"; then
        echo "→ Stopping user service..."
        systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
        systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
        systemctl --user daemon-reload
        echo "✓ Service removed"
    else
        echo "• No service found (skip)"
    fi
fi

# ─── Remove venv ────────────────────────────────────────────────
if [ -d "$APP_DIR/.venv" ]; then
    echo "→ Removing virtual environment..."
    rm -rf "$APP_DIR/.venv"
    echo "✓ venv removed"
else
    echo "• No venv found (skip)"
fi

# ─── Remove .env ────────────────────────────────────────────────
if [ -f "$APP_DIR/.env" ]; then
    echo "→ Removing .env config..."
    rm -f "$APP_DIR/.env"
    echo "✓ .env removed"
else
    echo "• No .env found (skip)"
fi

# ─── Remove cached/runtime files ────────────────────────────────
echo "→ Cleaning cache files..."
rm -rf "$APP_DIR/audio_cache" 2>/dev/null || true
rm -rf "$APP_DIR/thumb_cache" 2>/dev/null || true
rm -rf "$APP_DIR/text_cache" 2>/dev/null || true
rm -rf "$APP_DIR/voice_clips" 2>/dev/null || true
rm -rf "$APP_DIR/voices" 2>/dev/null || true
rm -rf "$APP_DIR/telemetry" 2>/dev/null || true
rm -rf "$APP_DIR/decloud.log" 2>/dev/null || true
rm -rf "$APP_DIR/decloud.pid" 2>/dev/null || true
rm -rf "$APP_DIR/tunnel.log" 2>/dev/null || true
rm -rf "$APP_DIR/tunnel.pid" 2>/dev/null || true
rm -rf "$APP_DIR/__pycache__" 2>/dev/null || true
rm -rf "$APP_DIR/routes/__pycache__" 2>/dev/null || true
echo "✓ Caches cleared"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✓ Uninstall complete!                      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Your books, files, and music were NOT touched."
echo "To fully remove DeCloud, delete this folder:"
echo "  rm -rf $APP_DIR"