"""Version info route for About panel.

Single source of truth: VERSION below, which must match CHANGELOG[0].
`date` shown in the About panel is the release date of that entry.
"""
import json
from flask import Blueprint, jsonify

bp = Blueprint('version', __name__)

VERSION = "0.0.5"

CHANGELOG = [
    {
        "version": "0.0.5",
        "date": "2026-09-06",
        "changes": [
            "Persistent sessions + XSS hardening via event delegation",
            "Sessions now persist across app restarts (sessions.json, chmod 600)",
            "Refactor inline onclick handlers to data-* attributes in file browser, books, and agents (closes quote-breakout XSS)",
            "ProxyFix trusts the tunnel hop so rate limits/backoff are per-client",
        ]
    },
    {
        "version": "0.0.4",
        "date": "2026-09-06",
        "changes": [
            "Security hardening + polish: fix path traversal in books, XSS sinks, and deploy/config issues",
            "Fix arbitrary file read via books routes (book_id/file traversal)",
            "Fix XSS across terminal, agent logs, file browser, reader, and chat (escaped output + single-quote)",
            "Docker: require passcode + secret, localhost-only port, fix .dockerignore secret leak",
            "Remove localhost.run relay from installer (Tailscale/cloudflared only)",
            "Bump cryptography to 50.0.0 to close 11 known CVEs",
            "Sanitize universe names, reject change_pin in open mode, ProxyFix for per-client limits",
            "Add upload size cap and input validation",
        ]
    },
    {
        "version": "0.0.3",
        "date": "2026-09-06",
        "changes": [
            "Voice agent: drives Hermes natively with a persistent session (falls back to local Ollama/cloud when Hermes isn't installed)",
            "Voice agent: modular STT/LLM/TTS engines configurable from Settings → Voice — no terminal needed",
            "Voice agent: command access tiers (Talk / Basic / Full) with a confirmation for unrestricted access",
            "Voice agent: remembers your conversation, can be named, and shows clear errors instead of failing silently",
            "Voice agent: browser or Whisper speech recognition, Piper or browser speech",
            "Security: fixed open-mode auth bypass on fresh installs (duplicate passcode in .env)",
            "Security: fixed path traversal in the music and file-browser routes",
            "UI: voice overlay now matches the black/white minimalism theme",
            "Settings: change your passcode in-app; library paths apply instantly without restart",
            "Devices: real Tailscale device list with names, OS, and online status",
            "Fixes: TTS autoplay on phones, stuck 'speaking' state, book-reader crash, duplicate HTML cleanup",
        ]
    },
    {
        "version": "0.0.2",
        "date": "2026-08-19",
        "changes": [
            "Security: opaque session tokens replace the PIN cookie — the passcode is never stored in the browser",
            "Security: CSRF protection on all state-changing requests",
            "Security: WebSocket terminal/voice sockets require the session token (works over tunnels now)",
            "Security: quick commands run shell-free (allowlisted argv table, no shell=True)",
            "Security: brute-force backoff + rate limits on login; 8-digit passcode default",
            "Security: removed third-party localhost.run relay — Tailscale Funnel only",
            "Security: binds 127.0.0.1 by default; loud warning otherwise",
            "Security: CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy headers",
            "Books: correct chapter counts per book (no more 30-chapter cap)",
            "Books: reading position syncs across devices (phone and laptop resume the same spot)",
            "Books: cover generator uses cross-platform fonts",
            "AI chat: consistent default model, input caps, real error messages from summarize/Q&A",
            "Cross-platform: real OS detection (Debian/Fedora/macOS/Windows)",
            "Windows: setup.ps1 installer + decloud.ps1 lifecycle wrapper; terminal degrades gracefully",
            "Tests: 74 security tests (auth, CSRF, WebSocket, allowlist, traversal, symlinks) + CI on Ubuntu/macOS/Windows",
        ]
    },
    {
        "version": "0.0.1",
        "date": "2026-08-14",
        "changes": [
            "First public release — experimental alpha",
            "Report issues on GitHub",
            ".env now loaded on manual start (not just systemd)",
            "Settings: library paths save to .env for real",
            "AI chat surfaces model errors instead of hanging",
            "Universe: fixed duplicated empty-state message",
            "Projects: onboarding empty state",
            "ComfyUI: offline install guidance",
            "Notifications built from real system stats",
            "App writes request logs (Logs screen works)",
            "Safari share sheet crash fixed",
            "First-run onboarding walkthrough added",
        ]
    },
]


def _current_entry():
    """Changelog entry matching VERSION; falls back to the newest entry."""
    for entry in CHANGELOG:
        if entry.get('version') == VERSION:
            return entry
    return CHANGELOG[0] if CHANGELOG else {"version": VERSION, "date": "", "changes": []}


@bp.route('/api/version')
def get_version():
    """Return current version and changelog."""
    current = _current_entry()
    return jsonify({
        "version": current["version"],
        "date": current["date"],
        "changelog": CHANGELOG,
    })
