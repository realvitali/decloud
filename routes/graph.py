"""Connection graph routes — serve the CabinVault relationship graph via DeCloud."""
from flask import Blueprint, jsonify, send_file, Response
import json, os, subprocess, datetime

bp = Blueprint('graph', __name__)

VAULT = os.path.expanduser("~/Documents/CabinVault")
GRAPH_JSON = os.path.join(VAULT, "network-graph.json")
GRAPH_HTML = os.path.join(VAULT, "network-web.html")
ENGINE = os.path.join(VAULT, "_Meta/scripts/connection_engine.py")
REPORT = os.path.join(VAULT, "connection-report.md")


def _run_engine():
    """Regenerate the graph from journals. Returns (ok, error)."""
    if not os.path.exists(ENGINE):
        return False, "connection_engine.py not found"
    try:
        r = subprocess.run(
            ['python3', ENGINE],
            capture_output=True, text=True, timeout=60,
            cwd=os.path.dirname(ENGINE),
        )
        if r.returncode != 0:
            return False, r.stderr[-500:]
        return True, None
    except Exception as e:
        return False, str(e)


@bp.route('/api/graph')
def api_graph():
    """Return the connection graph JSON (regenerates first)."""
    ok, err = _run_engine()
    if not ok:
        return jsonify({'error': f'Engine failed: {err}'}), 500
    if not os.path.exists(GRAPH_JSON):
        return jsonify({'error': 'network-graph.json not found'}), 404
    return send_file(GRAPH_JSON, mimetype='application/json')


@bp.route('/api/graph/report')
def api_graph_report():
    """Return the connection report (reminders + scores) as text."""
    ok, err = _run_engine()
    if not ok:
        return jsonify({'error': f'Engine failed: {err}'}), 500
    if not os.path.exists(REPORT):
        return jsonify({'error': 'connection-report.md not found'}), 404
    return send_file(REPORT, mimetype='text/markdown')


@bp.route('/graph')
def graph_page():
    """Serve the interactive graph visualization."""
    if not os.path.exists(GRAPH_HTML):
        return "Graph visualization not found. Run the connection engine first.", 404
    return send_file(GRAPH_HTML, mimetype='text/html')
