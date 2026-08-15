"""Lego file browser (Files) routes."""
from flask import Blueprint, jsonify, request, send_file
import os, json
from pathlib import Path
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

    all_items.sort(key=lambda x: (x['_sort_dir'], x['_sort_name']))
    total = len(all_items)

    start = (page - 1) * per_page
    page_items = all_items[start:start + per_page]
    for item in page_items:
        item.pop('_sort_name', None)
        item.pop('_sort_dir', None)

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

    if not target.is_file():
        return jsonify({'error': 'not found'}), 404
    ext = target.suffix.lower()
    if ext in ('.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'):
        thumb = _generate_thumbnail(target)
        if thumb and thumb.exists():
            resp = send_file(str(thumb), mimetype='image/webp')
            resp.headers['Cache-Control'] = 'public, max-age=86400'
            return resp
        return send_file(str(target), mimetype=f'image/{ext.lstrip(".")}')
    if ext in ('.heic', '.heif'):
        thumb = _generate_thumbnail(target)
        if thumb and thumb.exists():
            resp = send_file(str(thumb), mimetype='image/webp')
            resp.headers['Cache-Control'] = 'public, max-age=86400'
            return resp
        return jsonify({'error': 'cannot thumbnail heic'}), 400
    return jsonify({'error': 'not an image'}), 400