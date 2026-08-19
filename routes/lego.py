"""Lego file browser (Files) routes."""
from flask import Blueprint, jsonify, request, send_file
import os, json, subprocess
from pathlib import Path
import random as _random
import shutil as _shutil
from shared import (
    FILES_DIR, format_size,
    _folder_info_cache,
    safe_join_browse, _generate_thumbnail,
)

bp = Blueprint('lego', __name__)

@bp.route('/api/lego/browse')
@bp.route('/api/files/browse')
def lego_browse():
    """Browse Files drive. Query: path=<relative>, page=<n>, per_page=<n>"""
    import os as _os, time as _time
    subpath = request.args.get('path', '')
    page = max(1, request.args.get('page', 1, type=int))
    per_page = min(500, request.args.get('per_page', 200, type=int))
    target = safe_join_browse(FILES_DIR, *subpath.split('/')) if subpath else FILES_DIR

    if not target.exists() or not target.is_dir():
        return jsonify({'error': 'not found or not a directory'}), 404

    # Use os.scandir — gets is_dir and stat from the directory entry itself
    # much faster than pathlib iterdir + stat on slow exfat
    all_items = []
    try:
        with _os.scandir(str(target)) as it:
            for entry in it:
                if entry.name.startswith('.'):
                    continue
                try:
                    is_dir = entry.is_dir()
                    rel_path = str(Path(entry.path).relative_to(FILES_DIR))
                    if is_dir:
                        all_items.append({
                            'name': entry.name,
                            'is_dir': True,
                            'size': 0,
                            'size_human': '',
                            'modified': '',
                            'ext': '',
                            'path': rel_path,
                            'child_count': -1,
                            'has_images': False,
                            '_sort_name': entry.name.lower(),
                            '_sort_dir': 0,
                        })
                    else:
                        st = entry.stat()
                        all_items.append({
                            'name': entry.name,
                            'is_dir': False,
                            'size': st.st_size,
                            'size_human': format_size(st.st_size),
                            'modified': _time.strftime('%Y-%m-%d %H:%M', _time.localtime(st.st_mtime)),
                            'ext': Path(entry.name).suffix.lower().lstrip('.'),
                            'path': rel_path,
                            'child_count': 0,
                            'has_images': False,
                            '_sort_name': entry.name.lower(),
                            '_sort_dir': 1,
                        })
                except (PermissionError, OSError):
                    continue
    except PermissionError:
        return jsonify({'error': 'permission denied'}), 403

    # Sort: folders first, then alpha
    all_items.sort(key=lambda x: (x['_sort_dir'], x['_sort_name']))
    total = len(all_items)

    # Paginate
    start = (page - 1) * per_page
    page_items = all_items[start:start + per_page]
    # Clean up sort keys before sending
    for item in page_items:
        item.pop('_sort_name', None)
        item.pop('_sort_dir', None)

    # Build breadcrumb path
    breadcrumbs = [{'name': 'Files', 'path': ''}]
    if subpath:
        parts = subpath.split('/')
        for i, part in enumerate(parts):
            if part:
                breadcrumbs.append({'name': part, 'path': '/'.join(parts[:i+1])})

    return jsonify({
        'items': page_items,
        'path': subpath,
        'breadcrumbs': breadcrumbs,
        'item_count': total,
        'page': page,
        'per_page': per_page,
        'has_more': start + per_page < total,
    })

# In-memory cache for folder info (child_count, has_images)
_folder_info_cache = {}  # path -> (mtime, child_count, has_images)

@bp.route('/api/lego/folder_info')
def lego_folder_info():
    """Lazy get folder child_count + has_images. Query: path=<relative>"""
    subpath = request.args.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400
    target = safe_join_browse(FILES_DIR, *subpath.split('/'))
    if not target.exists() or not target.is_dir():
        return jsonify({'error': 'not found'}), 404

    try:
        mtime = target.stat().st_mtime
    except OSError:
        mtime = 0

    cache_key = str(target)
    cached = _folder_info_cache.get(cache_key)
    if cached and cached[0] == mtime:
        return jsonify({'child_count': cached[1], 'has_images': cached[2]})

    child_count = 0
    has_images = False
    img_exts = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'}
    try:
        for child in target.iterdir():
            child_count += 1
            if not has_images and child.suffix.lower() in img_exts:
                has_images = True
    except (PermissionError, OSError):
        pass

    _folder_info_cache[cache_key] = (mtime, child_count, has_images)
    return jsonify({'child_count': child_count, 'has_images': has_images})

def format_size(size):
    """Format bytes as human-readable."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024:
            return f'{size:.0f} {unit}' if unit == 'B' else f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} TB'

@bp.route('/api/lego/download')
def lego_download():
    """Download a file from Files. Query: path=<relative path>"""
    subpath = request.args.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400
    target = safe_join_browse(FILES_DIR, *subpath.split('/'))
    if not target.exists() or not target.is_file():
        return jsonify({'error': 'not found'}), 404
    return send_file(str(target), as_attachment=True, download_name=target.name)

@bp.route('/api/lego/thumbnail')
def lego_thumbnail():
    """Serve a cached WebP thumbnail. Query: path=<relative path>"""
    subpath = request.args.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400
    target = safe_join_browse(FILES_DIR, *subpath.split('/'))
    if not target.exists():
        return jsonify({'error': 'not found'}), 404

    # If it's a directory, find the first image inside it
    if target.is_dir():
        img_exts = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'}
        try:
            for child in sorted(target.iterdir(), key=lambda x: x.name.lower()):
                if child.suffix.lower() in img_exts and child.is_file():
                    thumb = _generate_thumbnail(child)
                    if thumb and thumb.exists():
                        resp = send_file(str(thumb), mimetype='image/webp')
                        resp.headers['Cache-Control'] = 'public, max-age=86400'
                        return resp
        except (PermissionError, OSError):
            pass
        return jsonify({'error': 'no images in folder'}), 404

    # File: generate thumbnail from it
    if not target.is_file():
        return jsonify({'error': 'not found'}), 404
    ext = target.suffix.lower()
    if ext in ('.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'):
        thumb = _generate_thumbnail(target)
        if thumb and thumb.exists():
            resp = send_file(str(thumb), mimetype='image/webp')
            resp.headers['Cache-Control'] = 'public, max-age=86400'
            return resp
        # Fallback to raw if thumbnail generation fails
        return send_file(str(target), mimetype=f'image/{ext.lstrip(".")}')
    if ext in ('.heic', '.heif'):
        thumb = _generate_thumbnail(target)
        if thumb and thumb.exists():
            resp = send_file(str(thumb), mimetype='image/webp')
            resp.headers['Cache-Control'] = 'public, max-age=86400'
            return resp
        return jsonify({'error': 'cannot thumbnail heic'}), 400
    return jsonify({'error': 'not an image'}), 400


# ─── API: Lego Swipe Mode ──────────────────────────────────
import random as _random

@bp.route('/api/lego/random_image')
def lego_random_image():
    """Get a random image file from a folder (non-recursive, fast). Query: path=<relative>"""
    subpath = request.args.get('path', '')
    target = safe_join_browse(FILES_DIR, *subpath.split('/')) if subpath else FILES_DIR
    if not target.exists() or not target.is_dir():
        return jsonify({'error': 'not found'}), 404

    img_exts = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'}
    images = []
    try:
        for entry in target.iterdir():
            if entry.is_file() and entry.suffix.lower() in img_exts:
                images.append(entry)
    except (PermissionError, OSError):
        pass

    if not images:
        return jsonify({'error': 'no images found'}), 404

    pick = _random.choice(images)
    return jsonify({
        'path': str(pick.relative_to(FILES_DIR)),
        'name': pick.name,
        'total_images': len(images),
    })


@bp.route('/api/lego/trash', methods=['POST'])
def lego_trash():
    """Move a file to /file types/trash/ inside Files."""
    data = request.get_json(silent=True) or {}
    subpath = data.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400

    target = safe_join_browse(FILES_DIR, *subpath.split('/'))
    files_root_resolved = FILES_DIR.resolve()
    target_resolved = target.resolve()

    if not str(target_resolved).startswith(str(files_root_resolved) + '/') and target_resolved != files_root_resolved:
        return jsonify({'error': 'path outside Files'}), 403
    if not target_resolved.is_file():
        return jsonify({'error': 'can only trash files'}), 400
    if target.is_symlink():
        return jsonify({'error': 'cannot trash symlinks'}), 400

    trash_dir = (FILES_DIR / 'file types' / 'trash')
    trash_dir.mkdir(parents=True, exist_ok=True)
    dest = trash_dir / target_resolved.name

    if dest.exists():
        stem = target_resolved.stem
        suffix = target_resolved.suffix
        i = 1
        while dest.exists():
            dest = trash_dir / f'{stem}_{i}{suffix}'
            i += 1

    try:
        _shutil.move(str(target_resolved), str(dest))
        return jsonify({'ok': True, 'moved_to': str(dest.relative_to(FILES_DIR))})
    except Exception as e:
        return jsonify({'error': f'trash error: {str(e)}'}), 500


# ─── API: Lego Shred & Poof ────────────────────────────────
import shutil as _shutil

@bp.route('/api/lego/shred', methods=['POST'])
def lego_shred():
    """Securely shred a single file using shred -uvz. Locked down to one file inside Files."""
    data = request.get_json(silent=True) or {}
    subpath = data.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400

    target = safe_join_browse(FILES_DIR, *subpath.split('/'))

    # Hard safety checks
    files_root_resolved = FILES_DIR.resolve()
    target_resolved = target.resolve()

    # Must be inside Files (strict prefix match)
    if not str(target_resolved).startswith(str(files_root_resolved) + '/') and target_resolved != files_root_resolved:
        return jsonify({'error': 'path outside Files'}), 403

    # Must be a file, not a directory
    if not target_resolved.is_file():
        return jsonify({'error': 'can only shred files, not directories'}), 400

    # Must not be a symlink (prevent following links outside Files)
    if target.is_symlink():
        return jsonify({'error': 'cannot shred symlinks'}), 400

    try:
        result = subprocess.run(
            ['shred', '-uvz', '-n', '3', str(target_resolved)],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            return jsonify({'error': f'shred failed: {result.stderr.strip()}'}), 500
        return jsonify({'ok': True, 'shredded': target_resolved.name})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'shred timed out'}), 500
    except Exception as e:
        return jsonify({'error': f'shred error: {str(e)}'}), 500


@bp.route('/api/lego/poof', methods=['POST'])
def lego_poof():
    """Move a file to /file types/poof/ inside Files."""
    data = request.get_json(silent=True) or {}
    subpath = data.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400

    target = safe_join_browse(FILES_DIR, *subpath.split('/'))

    files_root_resolved = FILES_DIR.resolve()
    target_resolved = target.resolve()

    # Must be inside Files (strict prefix match)
    if not str(target_resolved).startswith(str(files_root_resolved) + '/') and target_resolved != files_root_resolved:
        return jsonify({'error': 'path outside Files'}), 403

    # Must be a file
    if not target_resolved.is_file():
        return jsonify({'error': 'can only poof files'}), 400

    # Must not be a symlink
    if target.is_symlink():
        return jsonify({'error': 'cannot poof symlinks'}), 400

    # Must not already be in the poof directory
    poof_dir = (FILES_DIR / 'file types' / 'poof')
    poof_dir.mkdir(parents=True, exist_ok=True)
    dest = poof_dir / target_resolved.name

    # If name collision, append number
    if dest.exists():
        stem = target_resolved.stem
        suffix = target_resolved.suffix
        i = 1
        while dest.exists():
            dest = poof_dir / f'{stem}_{i}{suffix}'
            i += 1

    try:
        _shutil.move(str(target_resolved), str(dest))
        return jsonify({'ok': True, 'moved_to': str(dest.relative_to(FILES_DIR))})
    except Exception as e:
        return jsonify({'error': f'poof error: {str(e)}'}), 500


@bp.route('/api/lego/mark_done', methods=['POST'])
def lego_mark_done():
    """Rename a folder by appending ' (MANUALLY DONE)' to its name."""
    data = request.get_json(silent=True) or {}
    subpath = data.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400

    target = safe_join_browse(FILES_DIR, *subpath.split('/'))

    files_root_resolved = FILES_DIR.resolve()
    target_resolved = target.resolve()

    # Must be inside Files
    if not str(target_resolved).startswith(str(files_root_resolved) + '/') and target_resolved != files_root_resolved:
        return jsonify({'error': 'path outside Files'}), 403

    # Must be a directory
    if not target_resolved.is_dir():
        return jsonify({'error': 'can only mark folders'}), 400

    # Must not be a symlink
    if target.is_symlink():
        return jsonify({'error': 'cannot mark symlinks'}), 400

    # Must not be the root
    if target_resolved == files_root_resolved:
        return jsonify({'error': 'cannot mark root'}), 400

    # Already marked?
    if ' (MANUALLY DONE)' in target_resolved.name:
        return jsonify({'error': 'already marked done'}), 400

    new_name = target_resolved.name + ' (MANUALLY DONE)'

    # Move into /manually done/ folder
    done_dir = FILES_DIR / 'manually done'
    done_dir.mkdir(parents=True, exist_ok=True)
    dest = done_dir / new_name

    # Name collision check
    if dest.exists():
        return jsonify({'error': 'a folder with that name already exists in manually done/'}), 409

    try:
        _shutil.move(str(target_resolved), str(dest))
        new_rel = str(dest.relative_to(FILES_DIR))
        return jsonify({'ok': True, 'new_path': new_rel, 'new_name': new_name})
    except Exception as e:
        return jsonify({'error': f'move/rename error: {str(e)}'}), 500
