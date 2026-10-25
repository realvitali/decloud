"""Telemetry, app usage, and logs routes."""
from flask import Blueprint, jsonify, request, Response
import json, math, threading, time
from shared import USAGE_FILE, _read_logs, _write_private

bp = Blueprint('telemetry', __name__)

_usage_lock = threading.Lock()
USAGE_MAX_ENTRIES = 5000  # ponytail: keep the newest N events, plenty for stats


def _load_usage():
    try:
        log = json.loads(USAGE_FILE.read_text())
        return log if isinstance(log, list) else []
    except Exception:  # missing or corrupt
        return []


def _num(v):
    """Finite non-negative number, else None (bools aren't durations)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v if math.isfinite(v) and v >= 0 else None


@bp.route('/api/telemetry/app-usage', methods=['GET', 'POST'])
def app_usage():
    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        duration = _num(data.get('duration', 0))
        if duration is None:
            return jsonify({'error': 'duration must be a finite number'}), 400
        entry = {
            'app_id': str(data.get('app_id', 'unknown'))[:64],
            'action': str(data.get('action', 'open'))[:16],
            'duration': duration,
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
        }
        with _usage_lock:
            log = _load_usage()
            log.append(entry)
            _write_private(USAGE_FILE, json.dumps(log[-USAGE_MAX_ENTRIES:]))
        return jsonify({'ok': True, 'entry': entry})

    # GET — aggregated stats
    log = _load_usage()

    per_app = {}
    total_opens = 0
    today = time.strftime('%Y-%m-%d')
    today_stats = {}

    for e in log:
        if not isinstance(e, dict):
            continue
        aid = str(e.get('app_id', 'unknown'))
        ts = str(e.get('timestamp', ''))
        action = e.get('action', '')
        dur = _num(e.get('duration', 0)) or 0  # skip legacy junk values

        if aid not in per_app:
            per_app[aid] = {'opens': 0, 'total_time': 0}
        if action == 'open':
            per_app[aid]['opens'] += 1
            total_opens += 1
        if action == 'close':
            per_app[aid]['total_time'] += dur

        if ts.startswith(today):
            if aid not in today_stats:
                today_stats[aid] = {'opens': 0, 'total_time': 0}
            if action == 'open':
                today_stats[aid]['opens'] += 1
            if action == 'close':
                today_stats[aid]['total_time'] += dur

    return jsonify({
        'total_opens': total_opens,
        'per_app': per_app,
        'today': today_stats,
    })


# ─── API: Logs ─────────────────────────────────────────────────

@bp.route('/api/logs')
def get_logs():
    limit = request.args.get('limit', 100, type=int)
    return jsonify(_read_logs(limit=limit))

@bp.route('/api/logs/export')
def export_logs():
    logs = _read_logs(limit=100000)
    text = '\n'.join(f"[{l['timestamp']}] {l['level']}: {l['message']}" for l in logs)
    return Response(
        text,
        mimetype='text/plain',
        headers={'Content-Disposition': 'attachment; filename="decloud-logs.txt"'},
    )

# ─── API: Telemetry Export ────────────────────────────────────
@bp.route('/api/telemetry/export')
def export_telemetry():
    log = _load_usage()
    return Response(
        json.dumps(log, indent=2),
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment; filename="telemetry-usage.json"'},
    )
