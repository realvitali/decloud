"""Universe (people graph) and journal voice routes.

Requires external tools. Set env vars in .env to enable:
- DECLOUD_JOURNAL_DIR: path to your Obsidian vault (for journal features)
- DECLOUD_OSINT_DIR: path to osint-tools (for universe scanner)
"""
import os, sys, subprocess
from pathlib import Path
from flask import Blueprint, jsonify, request
from datetime import datetime
from shared import app, get_whisper_model, STT_ENGINES

bp = Blueprint('universe', __name__)

JOURNAL_DIR = os.environ.get('DECLOUD_JOURNAL_DIR', '')
OSINT_DIR = os.environ.get('DECLOUD_OSINT_DIR', '')

def _journal_path():
    """Get the journal directory path, or None if not configured."""
    return Path(JOURNAL_DIR) if JOURNAL_DIR else None

def _not_configured(msg='Journal directory not configured. Set DECLOUD_JOURNAL_DIR in .env'):
    return jsonify({'error': msg}), 503

@bp.route('/api/journal/voice', methods=['POST'])
def journal_voice():
    """Transcribe audio and append to today's journal."""
    import tempfile
    journal_dir = _journal_path()
    if not journal_dir:
        return _not_configured()
    try:
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({'error': 'No audio file provided'}), 400

        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False, dir=tempfile.gettempdir()) as tmp:
            audio_file.save(tmp.name)
            tmp_path = tmp.name

        wav_path = tmp_path.rsplit('.', 1)[0] + '.wav'
        subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_path, '-ar', '16000', '-ac', '1', '-f', 'wav', wav_path],
            capture_output=True, timeout=30
        )

        model = get_whisper_model(STT_ENGINES.get('whisper-base', STT_ENGINES['whisper-base'])['model'])
        segments, info = model.transcribe(wav_path, beam_size=1, language='en')
        text = ' '.join(seg.text.strip() for seg in segments).strip()

        os.unlink(tmp_path)
        if os.path.exists(wav_path):
            os.unlink(wav_path)

        if not text:
            return jsonify({'error': 'No speech detected'}), 400

        app.logger.info(f'[JOURNAL-VOICE] Transcribed: "{text[:80]}"')

        today = datetime.now().strftime('%Y-%m-%d')
        journal_path = journal_dir / f'{today}.md'
        now_str = datetime.now().strftime('%I:%M%p').lower()

        entry = f'\n\n--- Voice note ({now_str}) ---\n{text}\n'

        if journal_path.exists():
            with open(journal_path, 'a') as f:
                f.write(entry)
        else:
            journal_path.write_text(f'# {today}\n{entry}')

        return jsonify({'ok': True, 'text': text, 'date': today})
    except Exception as e:
        app.logger.error(f'[JOURNAL-VOICE] Error: {e}')
        return jsonify({'error': str(e)}), 500

def _load_universe_scanner():
    """Import universe_scanner if available."""
    if not OSINT_DIR or not os.path.isdir(OSINT_DIR):
        return None
    if OSINT_DIR not in sys.path:
        sys.path.insert(0, OSINT_DIR)
    try:
        import universe_scanner
        return universe_scanner
    except ImportError:
        return None

def _universe_not_configured():
    return _not_configured('Universe scanner not configured. Set DECLOUD_OSINT_DIR in .env')

@bp.route('/api/universe/data')
def universe_data():
    mod = _load_universe_scanner()
    if not mod:
        return _universe_not_configured()
    return jsonify(mod.get_universe_data())

@bp.route('/api/universe/people')
def universe_people():
    mod = _load_universe_scanner()
    if not mod:
        return _universe_not_configured()
    people = mod.load_people()
    return jsonify([{**v, "name": k} for k, v in people.items()])

@bp.route('/api/universe/person/<name>')
def universe_person(name):
    journal_dir = _journal_path()
    if not journal_dir:
        return _not_configured()
    safe = name.replace(" ", "_")
    path = journal_dir / 'People' / f"{safe}.md"
    if not path.exists():
        return jsonify({"error": "Not found"}), 404
    return jsonify({"name": name, "content": path.read_text()})

@bp.route('/api/universe/person/<name>', methods=['POST'])
def universe_person_update(name):
    journal_dir = _journal_path()
    if not journal_dir:
        return _not_configured()
    safe = name.replace(" ", "_")
    path = journal_dir / 'People' / f"{safe}.md"
    if not path.exists():
        return jsonify({"error": "Not found"}), 404
    data = request.get_json(silent=True) or {}
    new_notes = data.get("notes", "")
    text = path.read_text()
    if "## Auto" in text:
        parts = text.split("## Auto", 1)
        if parts[0].startswith("---"):
            fm_end = parts[0].index("---", 3) + 3
            frontmatter = parts[0][:fm_end]
            text = frontmatter + "\n\n" + new_notes + "\n\n## Auto" + parts[1]
        else:
            text = new_notes + "\n\n## Auto" + parts[1]
    else:
        text = text + "\n\n" + new_notes
    path.write_text(text)
    return jsonify({"ok": True})

@bp.route('/api/universe/scan', methods=['POST'])
def universe_scan():
    mod = _load_universe_scanner()
    if not mod:
        return _universe_not_configured()
    mentions = mod.scan_journals()
    connections = mod.detect_connections(mentions)
    count = mod.update_person_files(mentions, connections)
    return jsonify({"scanned": count, "mentions": len(mentions), "connections": sum(len(v) for v in connections.values())})

@bp.route('/api/universe/add', methods=['POST'])
def universe_add_person():
    journal_dir = _journal_path()
    if not journal_dir:
        return _not_configured()
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Name required"}), 400

    safe = name.replace(" ", "_")
    path = journal_dir / 'People' / f"{safe}.md"
    if path.exists():
        return jsonify({"error": "Person already exists"}), 400

    content = f"""---
name: "{name}"
category: "{data.get("category", "contact")}"
money_received: {data.get("money_received", 0)}
last_mentioned: ""
mention_count: 0
first_mentioned: ""
created: "{datetime.now().strftime('%Y-%m-%d')}"
---

# {name}

{data.get("notes", "")}

## Connections
<!-- Auto-populated: people mentioned in the same journal entries -->

## Auto
<!-- Auto-updated by journal scanner. Do not edit below this line. -->
mention_count: 0
mention_dates: []
last_mentioned: ""
first_mentioned: ""
bubble_size: 5
connections: {{}}
updated: ""
"""
    path.write_text(content)
    return jsonify({"ok": True, "name": name})
