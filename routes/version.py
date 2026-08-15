"""Version info route for About panel."""
import os
import json
from pathlib import Path
from flask import Blueprint, jsonify

bp = Blueprint('version', __name__)

VERSION_FILE = Path(__file__).parent.parent / 'version.json'

VERSION = "0.0.1"

CHANGELOG = [
    {
        "version": "0.0.1",
        "date": "2026-08-14",
        "changes": [
            "First public release — experimental alpha",
            "Things might break or be buggy. Report to mrvitali@pm.me",
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


@bp.route('/api/version')
def get_version():
    """Return current version and changelog."""
    current = CHANGELOG[0] if CHANGELOG else {"version": "0.0.0", "date": "", "changes": []}
    return jsonify({
        "version": current["version"],
        "date": current["date"],
        "changelog": CHANGELOG
    })
