"""Lego file browser (Files) routes."""
from flask import Blueprint, jsonify, request, send_file, current_app
import subprocess
from pathlib import Path
import shutil as _shutil
from shared import (
    format_size,
    _folder_info_cache,
    safe_join_browse, _generate_thumbnail,
)

import shared

bp = Blueprint('lego', __name__)

@bp.route('/api/lego/browse')
@bp.route('/api/files/browse')
def lego_browse():
    """Browse Files drive. Query: path=<relative>, page=<n>, per_page=<n>"""
    import os as _os, time as _time
    subpath = request.args.get('path', '')
    page = max(1, request.args.get('page', 1, type=int))
    per_page = min(500, request.args.get('per_page', 200, type=int))
    target = safe_join_browse(shared.FILES_DIR, *subpath.split('/')) if subpath else shared.FILES_DIR

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
                    rel_path = str(Path(entry.path).relative_to(shared.FILES_DIR))
                    mtime = entry.stat().st_mtime
                    if is_dir:
                        all_items.append({
                            'name': entry.name,
                            'is_dir': True,
                            'size': 0,
                            'size_human': '',
                            'modified': _time.strftime('%Y-%m-%d %H:%M', _time.localtime(mtime)),
                            'mtime': mtime,
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
                            'mtime': st.st_mtime,
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

    # Sort: folders first, then by name (default), date or size
    sort = request.args.get('sort', 'name')
    desc = request.args.get('order') == 'desc'
    keyf = {'date': lambda x: x['mtime'], 'size': lambda x: x['size']}.get(sort, lambda x: x['_sort_name'])
    all_items.sort(key=keyf, reverse=desc)
    all_items.sort(key=lambda x: x['_sort_dir'])   # stable: keeps the order within folders and files
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

@bp.route('/api/lego/folder_info')
def lego_folder_info():
    """Lazy get folder child_count + has_images. Query: path=<relative>"""
    subpath = request.args.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400
    target = safe_join_browse(shared.FILES_DIR, *subpath.split('/'))
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

@bp.route('/api/lego/download')
def lego_download():
    """Download a file from Files. Query: path=<relative path>"""
    subpath = request.args.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400
    target = safe_join_browse(shared.FILES_DIR, *subpath.split('/'))
    if not target.exists() or not target.is_file():
        return jsonify({'error': 'not found'}), 404
    return send_file(str(target), as_attachment=True, download_name=target.name)

@bp.route('/api/lego/thumbnail')
def lego_thumbnail():
    """Serve a cached WebP thumbnail. Query: path=<relative path>"""
    subpath = request.args.get('path', '')
    if not subpath:
        return jsonify({'error': 'path required'}), 400
    target = safe_join_browse(shared.FILES_DIR, *subpath.split('/'))
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
                        resp.headers['Cache-Control'] = 'private, max-age=86400'
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
            resp.headers['Cache-Control'] = 'private, max-age=86400'
            return resp
        # Fallback to raw if thumbnail generation fails
        return send_file(str(target), mimetype=f'image/{ext.lstrip(".")}')
    if ext in ('.heic', '.heif'):
        thumb = _generate_thumbnail(target)
        if thumb and thumb.exists():
            resp = send_file(str(thumb), mimetype='image/webp')
            resp.headers['Cache-Control'] = 'private, max-age=86400'
            return resp
        return jsonify({'error': 'cannot thumbnail heic'}), 400
    return jsonify({'error': 'not an image'}), 400


# ─── File operations: upload, new folder, rename, delete ─────────
# Every target is resolved inside FILES_DIR; the last path part is NOT
# resolved, so a symlink is renamed/deleted itself, never what it points to.
import os as _os
import re as _re
import time as _time
from datetime import datetime as _dt
from urllib.parse import quote as _quote


def _valid_name(name):
    """A plain file or folder name: no separators, no hidden/dot names, no control characters."""
    return (isinstance(name, str) and 0 < len(name.encode()) <= 255 and name == name.strip()
            and not name.startswith('.') and not _re.search(r'[/\\\x00-\x1f\x7f]', name))


def _locate(subpath, allow_root=False):
    """Path for a relative Files path, or None if it is malformed or escapes Files."""
    root = shared.FILES_DIR.resolve()
    parts = [p for p in str(subpath or '').split('/') if p]
    if any(p in ('.', '..') or '\0' in p for p in parts):
        return None
    if not parts:
        return root if allow_root else None
    try:
        parent = root.joinpath(*parts[:-1]).resolve()
    except (OSError, ValueError):
        return None
    if not parent.is_relative_to(root):
        return None
    return parent / parts[-1]


def _unique(folder, name):
    """name, or "name (2).ext" … when it is taken."""
    stem, ext = _os.path.splitext(name)
    cand, i = folder / name, 2
    while _os.path.lexists(cand):
        cand, i = folder / f'{stem} ({i}){ext}', i + 1
    return cand


def _trash_dir():
    """This computer's trash, so a delete can be undone from the desktop. None on Windows."""
    import platform
    if platform.system() == 'Darwin':
        return Path.home() / '.Trash'
    if platform.system() == 'Linux':
        return Path(_os.environ.get('XDG_DATA_HOME') or Path.home() / '.local' / 'share') / 'Trash'
    return None


def _move_to_trash(target):
    import platform
    trash = _trash_dir()
    if trash is None:
        return False
    files, info = (trash, None) if platform.system() == 'Darwin' else (trash / 'files', trash / 'info')
    files.mkdir(parents=True, exist_ok=True)
    dest = _unique(files, target.name)
    if info is not None:   # freedesktop.org trash: an .trashinfo file lets the desktop restore it
        info.mkdir(parents=True, exist_ok=True)
        (info / (dest.name + '.trashinfo')).write_text(
            f'[Trash Info]\nPath={_quote(str(target))}\nDeletionDate={_dt.now().strftime("%Y-%m-%dT%H:%M:%S")}\n')
    _shutil.move(str(target), str(dest))
    return True


@bp.route('/api/files/mkdir', methods=['POST'])
def files_mkdir():
    data = request.get_json(silent=True) or {}
    folder, name = _locate(data.get('path'), allow_root=True), data.get('name')
    if folder is None or not folder.is_dir() or not _valid_name(name):
        return jsonify({'error': 'Pick a folder name without slashes or a leading dot.'}), 400
    target = folder / name
    if _os.path.lexists(target):
        return jsonify({'error': 'Something with that name is already here.'}), 409
    target.mkdir()
    return jsonify({'ok': True, 'path': str(target.relative_to(shared.FILES_DIR.resolve()))})


@bp.route('/api/files/rename', methods=['POST'])
def files_rename():
    data = request.get_json(silent=True) or {}
    target, name = _locate(data.get('path')), data.get('name')
    if target is None or not _os.path.lexists(target) or not _valid_name(name):
        return jsonify({'error': 'Pick a name without slashes or a leading dot.'}), 400
    dest = target.parent / name
    if _os.path.lexists(dest):
        return jsonify({'error': 'Something with that name is already here.'}), 409
    _os.rename(target, dest)
    return jsonify({'ok': True, 'path': str(dest.relative_to(shared.FILES_DIR.resolve()))})


@bp.route('/api/files/delete', methods=['POST'])
def files_delete():
    """Move items to this computer's trash. Where there is none (Windows), only
    with permanent=true, which the page asks the user to confirm separately."""
    data = request.get_json(silent=True) or {}
    paths = data.get('paths') if isinstance(data.get('paths'), list) else [data.get('path')]
    targets = [_locate(p) for p in paths[:200]]
    if not targets or any(t is None or not _os.path.lexists(t) for t in targets):
        return jsonify({'error': 'Item not found.'}), 404
    if _trash_dir() is None and data.get('permanent') is not True:
        return jsonify({'error': 'This computer has no trash, so deleting is permanent.', 'code': 'NO_TRASH'}), 409
    done = 0
    for t in targets:
        try:
            if _trash_dir() is not None:
                _move_to_trash(t)
            elif t.is_dir() and not t.is_symlink():
                _shutil.rmtree(t)
            else:
                t.unlink()
            done += 1
        except OSError:
            current_app.logger.exception('[FILES] delete failed')
            return jsonify({'error': f'Could not delete {t.name}.', 'deleted': done}), 500
    return jsonify({'ok': True, 'deleted': done, 'trash': _trash_dir() is not None})


@bp.route('/api/files/upload', methods=['POST'])
def files_upload():
    folder = _locate(request.form.get('path'), allow_root=True)
    if folder is None or not folder.is_dir():
        return jsonify({'error': 'Folder not found.'}), 404
    saved = []
    for f in request.files.getlist('files')[:100]:
        name = _os.path.basename((f.filename or '').replace('\\', '/'))
        if not _valid_name(name):
            return jsonify({'error': f'"{name[:60]}" is not a name DeCloud can save.', 'saved': saved}), 400
        dest = _unique(folder, name)
        with open(dest, 'xb') as out:   # never overwrites
            _shutil.copyfileobj(f.stream, out, 1024 * 1024)
        saved.append(dest.name)
    return jsonify({'ok': True, 'saved': saved})
