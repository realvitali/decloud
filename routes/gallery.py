"""Gallery routes: photos and videos from the Camera and Screenshots folders of the Files drive."""
from flask import Blueprint, jsonify, request, send_file, abort
import calendar, hashlib, json, mimetypes, os, re, subprocess, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import shared
from shared import limiter
from shared import safe_join_browse, browse_root as _root

bp = Blueprint('gallery', __name__)

IMG_EXTS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'}
VID_EXTS = {'mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp', 'avi'}
# album id -> folder name inside the Files drive (matched case-insensitively)
ALBUMS = {'camera': 'camera', 'screenshots': 'screenshots'}

THUMB_DIR = Path(shared.__file__).resolve().parent / 'thumb_cache' / 'gallery'
SIZES = {'sm': 420, 'md': 1600}
_thumb_slots = threading.Semaphore(3)      # ffmpeg / PIL work is CPU heavy; keep the server responsive
_list_cache = {}                           # album -> (dir mtime, payload)
_meta_cache = {}                           # rel path + mtime -> {'dur': s, 'w': px, 'h': px}
_meta_pool = ThreadPoolExecutor(max_workers=3)

_NAME_DATE = re.compile(r'(?<!\d)(20\d{2}|19\d{2})[-_]?([01]\d)[-_]?([0-3]\d)[-_ T]?([0-2]\d)[-_.:]?([0-5]\d)[-_.:]?([0-5]\d)')


def _album_dir(album):
    want = ALBUMS.get(album)
    if not want:
        return None
    root = Path(shared.FILES_DIR)
    try:
        for entry in os.scandir(root):
            if entry.is_dir() and entry.name.lower() == want:
                return Path(entry.path)
    except OSError:
        pass
    return None


def _taken(name, mtime):
    """Seconds since 1970 for the wall-clock time the photo was taken, so the browser can show exactly what the
    phone's filename says without a timezone shift. Filename first, then mtime."""
    m = _NAME_DATE.search(name)
    if m:
        try:
            y, mo, d, h, mi, s = (int(x) for x in m.groups())
            if 1 <= mo <= 12 and 1 <= d <= 31 and h < 24:
                return calendar.timegm((y, mo, d, h, mi, s))
        except (ValueError, OverflowError):
            pass
    m = re.match(r'^(1[5-9]\d{8})(\d{3})?(?!\d)', name)          # unix seconds or milliseconds in the name
    if m:
        try:
            return calendar.timegm(time.localtime(int(m.group(1))))
        except (ValueError, OverflowError, OSError):
            pass
    return calendar.timegm(time.localtime(mtime))


def _kind(ext):
    return 'i' if ext in IMG_EXTS else ('v' if ext in VID_EXTS else '')


def _media_file(subpath):
    """Resolve a request path to a media file inside the Files drive, or None."""
    if not subpath:
        return None
    target = safe_join_browse(_root(), *subpath.split('/'))
    try:
        if not target.is_file() or target.name.startswith('.'):
            return None
    except OSError:
        return None
    return target if _kind(target.suffix.lower().lstrip('.')) else None


@bp.route('/api/gallery/items')
def gallery_items():
    """Every photo/video of an album, newest first. Compact rows: p=path, t=i|v, d=taken (wall clock secs), s=size, m=mtime."""
    album = request.args.get('album', 'camera')
    folder = _album_dir(album)
    if folder is None:
        return jsonify({'album': album, 'items': [], 'missing': True})
    try:
        stamp = folder.stat().st_mtime
    except OSError:
        return jsonify({'album': album, 'items': [], 'missing': True})
    hit = _list_cache.get(album)
    if hit and hit[0] == stamp and not request.args.get('r'):
        return jsonify(hit[1])
    files_root = _root()
    items = []
    try:
        with os.scandir(folder) as it:
            for e in it:
                if e.name.startswith('.'):
                    continue
                try:
                    if not e.is_file():
                        continue
                    t = _kind(e.name.rsplit('.', 1)[-1].lower() if '.' in e.name else '')
                    if not t:
                        continue
                    st = e.stat()
                except OSError:
                    continue
                items.append({'p': os.path.relpath(e.path, str(files_root)), 't': t, 'd': _taken(e.name, st.st_mtime),
                              's': st.st_size, 'm': int(st.st_mtime)})
    except OSError:
        return jsonify({'album': album, 'items': [], 'missing': True})
    items.sort(key=lambda x: (-x['d'], x['p']))
    payload = {'album': album, 'items': items, 'photos': sum(1 for x in items if x['t'] == 'i'),
               'videos': sum(1 for x in items if x['t'] == 'v')}
    _list_cache[album] = (stamp, payload)
    return jsonify(payload)


def _ffprobe(path):
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'stream=width,height:format=duration', '-of', 'json', str(path)],
                           capture_output=True, text=True, timeout=20)
        j = json.loads(r.stdout or '{}')
        st = (j.get('streams') or [{}])[0]
        return {'dur': float((j.get('format') or {}).get('duration') or 0), 'w': st.get('width') or 0, 'h': st.get('height') or 0}
    except Exception:
        return {'dur': 0, 'w': 0, 'h': 0}


def _vmeta(target):
    key = f'{target}:{int(target.stat().st_mtime)}'
    if key not in _meta_cache:
        _meta_cache[key] = _ffprobe(target)
    return _meta_cache[key]


@bp.route('/api/gallery/durations')
def gallery_durations():
    """Video lengths of an album, so the grid can show 0:42 badges. Probed in parallel, cached."""
    folder = _album_dir(request.args.get('album', 'camera'))
    if folder is None:
        return jsonify({})
    files = []
    try:
        for e in os.scandir(folder):
            if not e.name.startswith('.') and e.is_file() and _kind(e.name.rsplit('.', 1)[-1].lower() if '.' in e.name else '') == 'v':
                files.append(Path(e.path))
    except OSError:
        return jsonify({})
    root = _root()
    out = {}
    for f, m in zip(files, _meta_pool.map(_vmeta, files)):
        out[os.path.relpath(str(f), str(root))] = round(m['dur'])
    return jsonify(out)


def _thumb_path(target, size):
    st = target.stat()
    h = hashlib.md5(f'{target}:{st.st_mtime_ns}:{st.st_size}:{size}'.encode()).hexdigest()[:20]
    return THUMB_DIR / f'{h}.jpg'


def _make_image_thumb(target, out, px):
    from PIL import Image, ImageOps
    with Image.open(target) as im:
        try:
            im.draft('RGB', (px * 2, px * 2))         # JPEG: decode at a fraction of the size (200 MP shots are slow otherwise)
        except Exception:
            pass
        try:
            im = ImageOps.exif_transpose(im)          # honour the phone's rotation flag
        except Exception:
            pass
        if im.mode not in ('RGB', 'L'):
            bg = Image.new('RGB', im.size, (0, 0, 0))
            rgba = im.convert('RGBA')
            bg.paste(rgba, mask=rgba.split()[-1])
            im = bg
        elif im.mode == 'L':
            im = im.convert('RGB')
        im.thumbnail((px, px), Image.LANCZOS)
        tmp = out.with_suffix('.tmp')
        im.save(tmp, 'JPEG', quality=72 if px <= 600 else 82, optimize=True, progressive=px > 600)
    os.replace(tmp, out)


def _make_video_thumb(target, out, px):
    tmp = out.with_suffix('.tmp.jpg')
    for seek in ('0.6', '0'):                           # very short clips have nothing at 0.6 s
        r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', seek, '-i', str(target), '-frames:v', '1',
                            '-vf', f'scale=\'min({px},iw)\':-2', '-q:v', '4', str(tmp)],
                           capture_output=True, timeout=45)
        if r.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
            os.replace(tmp, out)
            return
    try:
        tmp.unlink()
    except OSError:
        pass
    raise RuntimeError('no frame')


@bp.route('/api/gallery/thumb')
@limiter.exempt
def gallery_thumb():
    """A cached JPEG preview. s=sm (grid, 420px) or md (viewer, 1600px). Videos give a poster frame."""
    target = _media_file(request.args.get('path', ''))
    if target is None:
        abort(404)
    size = request.args.get('s', 'sm')
    px = SIZES.get(size, SIZES['sm'])
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    out = _thumb_path(target, px)
    if not out.exists():
        with _thumb_slots:
            if not out.exists():
                try:
                    if _kind(target.suffix.lower().lstrip('.')) == 'v':
                        _make_video_thumb(target, out, px)
                    else:
                        _make_image_thumb(target, out, px)
                except Exception:
                    if _kind(target.suffix.lower().lstrip('.')) == 'i' and target.suffix.lower() not in ('.heic', '.heif', '.avif'):
                        return send_file(str(target), conditional=True, max_age=3600)   # unreadable by PIL: let the browser try
                    abort(415)
    resp = send_file(str(out), mimetype='image/jpeg', conditional=True)
    resp.headers['Cache-Control'] = 'private, max-age=604800, immutable' if request.args.get('m') else 'private, max-age=3600'
    return resp


@bp.route('/api/gallery/file')
@limiter.exempt
def gallery_file():
    """The original, inline, with Range support so videos seek and stream."""
    target = _media_file(request.args.get('path', ''))
    if target is None:
        abort(404)
    mime = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
    resp = send_file(str(target), mimetype=mime, conditional=True, max_age=3600)
    resp.headers['Cache-Control'] = 'private, max-age=3600'
    if request.args.get('dl'):
        resp.headers['Content-Disposition'] = 'attachment; filename="%s"' % target.name.replace('"', '')
    return resp


def _exif_bits(target):
    out = {}
    try:
        from PIL import Image, ExifTags
        with Image.open(target) as im:
            out['w'], out['h'] = im.size
            ex = im.getexif()
            if ex:
                sub = ex.get_ifd(0x8769) if hasattr(ex, 'get_ifd') else {}
                def tag(n):
                    for k, v in ExifTags.TAGS.items():
                        if v == n:
                            return ex.get(k) if k in ex else sub.get(k)
                make, model = tag('Make'), tag('Model')
                if model:
                    out['camera'] = (f'{make} {model}' if make and str(make) not in str(model) else str(model)).strip()
                f = tag('FNumber'); e = tag('ExposureTime'); iso = tag('ISOSpeedRatings'); fl = tag('FocalLength')
                bits = []
                if f: bits.append(f'ƒ/{float(f):.1f}')
                if e:
                    e = float(e); bits.append(f'1/{round(1 / e)} s' if 0 < e < 1 else f'{e:g} s')
                if iso: bits.append(f'ISO {iso if not isinstance(iso, tuple) else iso[0]}')
                if fl: bits.append(f'{float(fl):.0f} mm')
                if bits:
                    out['exposure'] = ' · '.join(bits)
    except Exception:
        pass
    return out


@bp.route('/api/gallery/info')
def gallery_info():
    target = _media_file(request.args.get('path', ''))
    if target is None:
        abort(404)
    st = target.stat()
    info = {'name': target.name, 'size': st.st_size, 'taken': _taken(target.name, st.st_mtime), 'path': request.args.get('path', '')}
    if _kind(target.suffix.lower().lstrip('.')) == 'v':
        m = _vmeta(target)
        info.update({'w': m['w'], 'h': m['h'], 'dur': round(m['dur'], 1), 'video': True})
    else:
        info.update(_exif_bits(target))
    return jsonify(info)
