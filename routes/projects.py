"""Projects (GitHub/Vercel) routes."""
from flask import Blueprint, jsonify, request
import json, subprocess
from shared import PROJECTS_CONFIG

bp = Blueprint('projects', __name__)

@bp.route('/api/projects')
def api_projects():
    """Return project configurations."""
    return jsonify(PROJECTS_CONFIG)


@bp.route('/api/projects/<project_id>/github')
def api_project_github(project_id):
    """Return recent commits, open PRs, and open issues using gh CLI."""
    project = next((p for p in PROJECTS_CONFIG if p['id'] == project_id), None)
    if not project:
        return jsonify({'error': 'Project not found'}), 404

    repo = project['repo']

    commits = []
    commit_count = None
    try:
        result = subprocess.run(
            ['gh', 'api', f'repos/{repo}/commits', '-X', 'GET', '-f', 'per_page=10'],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0:
            raw = json.loads(result.stdout)
            commits = [{
                'sha': c.get('sha', ''),
                'message': (c.get('commit', {}).get('message', '') or '').split('\n')[0][:200],
                'author': (c.get('commit', {}).get('author', {}).get('name', '') or
                           c.get('author', {}).get('login', '') or ''),
                'author_avatar': (c.get('author', {}) or {}).get('avatar_url', ''),
                'date': c.get('commit', {}).get('author', {}).get('date', ''),
            } for c in raw[:10]]
    except Exception as e:
        return jsonify({'error': f'Failed to fetch commits: {e}'}), 500

    # Get open PRs count
    open_prs = None
    try:
        result = subprocess.run(
            ['gh', 'api', f'repos/{repo}/pulls', '-X', 'GET', '-f', 'state=open', '-f', 'per_page=1'],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0:
            prs = json.loads(result.stdout)
            open_prs = len(prs)
    except Exception:
        pass

    # Get open issues count via the repo summary (faster than listing)
    open_issues = None
    try:
        result = subprocess.run(
            ['gh', 'api', f'repos/{repo}', '-X', 'GET'],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0:
            repo_info = json.loads(result.stdout)
            open_issues = repo_info.get('open_issues_count')
            commit_count = repo_info.get('commits_count')  # may not be present
    except Exception:
        pass

    return jsonify({
        'commits': commits,
        'commit_count': commit_count,
        'open_prs': open_prs,
        'open_issues': open_issues,
        'repo': repo,
    })


@bp.route('/api/projects/<project_id>/vercel')
def api_project_vercel(project_id):
    """Return Vercel deploy info. Placeholder until vercel CLI is authed."""
    project = next((p for p in PROJECTS_CONFIG if p['id'] == project_id), None)
    if not project:
        return jsonify({'error': 'Project not found'}), 404

    # Check if vercel CLI is available and authed
    try:
        result = subprocess.run(
            ['vercel', 'whoami'],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return jsonify({
                'authed': False,
                'status': 'not_authenticated',
                'message': 'Vercel CLI not authenticated. Run: vercel login',
            })
        whoami = result.stdout.strip()
        return jsonify({
            'authed': True,
            'account': whoami,
            'project': project.get('vercel_project'),
            'status': 'placeholder',
            'message': 'Vercel authenticated. Deploy details coming soon.',
        })
    except FileNotFoundError:
        return jsonify({
            'authed': False,
            'status': 'not_installed',
            'message': 'Vercel CLI not installed',
        })
    except subprocess.TimeoutExpired:
        return jsonify({
            'authed': False,
            'status': 'timeout',
            'message': 'Vercel CLI timed out',
        })
