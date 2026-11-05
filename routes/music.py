"""Music player routes."""
from flask import Blueprint, jsonify, request, send_file
import subprocess
import threading
import re
from shared import MUSIC_EXTS
import hashlib
import os

import shared
from shared import limiter

bp = Blueprint('music', __name__)

# ── Song search + download (into the music folder on this machine) ──
_dl_jobs = {}   # job_id -> {state, message, pct, title}
_dl_lock = threading.Lock()


def _ytdlp():
    try:
        import yt_dlp
        return yt_dlp
    except ImportError:
        return None


def _ytdlp_missing():
    return jsonify({'error': "Song downloads need yt-dlp on this machine — run: pip install yt-dlp"}), 503


@bp.route('/api/music/search', methods=['POST'])
@limiter.limit("20 per hour")
def music_search():
    ydl_mod = _ytdlp()
    if ydl_mod is None:
        return _ytdlp_missing()
    q = str((request.get_json(silent=True) or {}).get('q', '')).strip()[:200]
    if not q:
        return jsonify({'error': 'Type what you want to hear.'}), 400
    try:
        with ydl_mod.YoutubeDL({'quiet': True, 'no_warnings': True, 'extract_flat': True, 'skip_download': True}) as ydl:
            info = ydl.extract_info(f'ytsearch8:{q}', download=False)
    except Exception:
        return jsonify({'error': "Search failed — check this machine's internet connection."}), 502
    out = []
    for e in (info.get('entries') or [])[:8]:
        if not e or not e.get('id') or not e.get('title'):
            continue
        dur = int(e.get('duration') or 0)
        if not dur or dur > 1800:   # live streams / multi-hour mixes: skip
            continue
        out.append({
            'id': str(e['id']),
            'title': str(e['title'])[:200],
            'channel': str(e.get('channel') or e.get('uploader') or '')[:80],
            'duration': dur,
        })
    return jsonify(out)


@bp.route('/api/music/download', methods=['POST'])
@limiter.limit("10 per hour")
def music_download():
    ydl_mod = _ytdlp()
    if ydl_mod is None:
        return _ytdlp_missing()
    data = request.get_json(silent=True) or {}
    vid = str(data.get('id', '')).strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{6,20}', vid):
        return jsonify({'error': 'Bad track'}), 400
    job_id = hashlib.md5(vid.encode()).hexdigest()[:12]
    with _dl_lock:
        if _dl_jobs.get(job_id, {}).get('state') == 'running':
            return jsonify({'status': 'running', 'job': job_id}), 202
        _dl_jobs[job_id] = {'state': 'running', 'message': 'Starting download…', 'pct': 0,
                           'title': str(data.get('title', vid))[:200]}
    for k in [k for k, j in _dl_jobs.items() if j.get('state') != 'running' and len(_dl_jobs) > 40 and k != job_id]:
        _dl_jobs.pop(k, None)
    threading.Thread(target=_run_download, args=(job_id, vid, ydl_mod), daemon=True).start()
    return jsonify({'status': 'started', 'job': job_id}), 202


def _set_dl_job(job_id, **kw):
    with _dl_lock:
        _dl_jobs.setdefault(job_id, {}).update(kw)


def _run_download(job_id, vid, ydl_mod):
    def hook(d):
        if d.get('status') == 'downloading':
            total, got = d.get('total_bytes') or d.get('total_bytes_estimate') or 0, d.get('downloaded_bytes') or 0
            pct = int(got * 100 / total) if total else 0
            _set_dl_job(job_id, pct=pct, message='Downloading…')
        elif d.get('status') == 'finished':
            _set_dl_job(job_id, pct=100, message='Converting…')

    opts = {
        'format': 'bestaudio/best',
        'outtmpl': str(shared.MUSIC_DIR / '%(title).120s.%(ext)s'),
        # songs, not 10-hour videos or live streams that would fill the disk
        'max_filesize': 300 * 1024 * 1024,
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
        'progress_hooks': [hook],
        'writethumbnail': True,
        'postprocessors': [
            {'key': 'FFmpegExtractAudio', 'preferredcodec': 'm4a'},
            {'key': 'FFmpegMetadata'},
            {'key': 'EmbedThumbnail'},
        ],
    }
    if hasattr(ydl_mod, 'utils'):
        opts['match_filter'] = ydl_mod.utils.match_filter_func('duration <= 1800 & !is_live')
    try:
        with ydl_mod.YoutubeDL(opts) as ydl:
            ydl.download([f'https://www.youtube.com/watch?v={vid}'])
        _set_dl_job(job_id, state='done', message='Saved to your music folder')
    except Exception as e:
        _set_dl_job(job_id, state='error', message=f'Download failed: {str(e)[:200]}')


@bp.route('/api/music/download/<job_id>')
def music_download_status(job_id):
    j = _dl_jobs.get(job_id)
    if not j:
        return jsonify({'state': 'failed', 'message': 'Unknown download'}), 404
    return jsonify(j)

# Cache directory for extracted + cropped artwork.
# Resolved at request time so path changes apply immediately.
def _artwork_cache():
    cache = shared.MUSIC_DIR / '.artwork_cache'
    try:
        cache.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError):
        pass  # read-only fs — music app will show empty state
    return cache


def _artwork_cache_path(filename):
    """Return cached square artwork path, creating it if needed."""
    key = hashlib.md5(filename.encode()).hexdigest()[:12]
    return _artwork_cache() / f'{key}.png'


# ─── Song title / artist ─────────────────────────────────────────
# Shown as title with the artist under it. Order: the owner's edit, the file's
# own tags, then "Artist - Title" in the name, minus video-site noise.
_NOISE = re.compile(r'\s*[\(\[](?:official\s+)?(?:music\s+|lyric\s+)?(?:video|audio|lyrics?|visuali[sz]er|hd|hq|4k|explicit)[^\)\]]*[\)\]]', re.I)
_SPLIT = re.compile(r'\s+[-–—]\s+')
_tag_cache = {}   # path -> (mtime, title, artist)


def _tags(f):
    """(title, artist) from the file's tags, cached by mtime."""
    mtime = f.stat().st_mtime
    hit = _tag_cache.get(str(f))
    if hit and hit[0] == mtime:
        return hit[1], hit[2]
    title = artist = ''
    try:
        from mutagen import File as MutagenFile
        tags = MutagenFile(str(f), easy=True)
        if tags is not None:
            title = str((tags.get('title') or [''])[0]).strip()
            artist = str((tags.get('artist') or [''])[0]).strip()
    except Exception:
        pass
    _tag_cache[str(f)] = (mtime, title, artist)
    return title, artist


def song_meta(f, overrides):
    o = overrides.get(f.name) if isinstance(overrides.get(f.name), dict) else {}
    tag_title, tag_artist = _tags(f)
    raw = _NOISE.sub('', tag_title or f.stem).strip()
    parts = _SPLIT.split(raw, maxsplit=1)
    if len(parts) == 2 and parts[0] and parts[1]:
        artist, title = parts[0].strip(), parts[1].strip()
    else:
        artist, title = tag_artist, raw
    return {'title': str(o.get('title') or title or f.stem)[:200], 'artist': str(o.get('artist') if 'artist' in o else artist)[:200],
            'edited': bool(o)}


@bp.route('/api/music/list')
def music_list():
    """List all music files in the music directory."""
    songs = []
    overrides = shared.load_settings().get('music_meta') or {}
    if shared.MUSIC_DIR.exists():
        for f in sorted(shared.MUSIC_DIR.iterdir()):
            if f.suffix.lower() in MUSIC_EXTS:
                size_mb = f.stat().st_size / (1024 * 1024)
                songs.append({
                    'name': f.stem,
                    'filename': f.name,
                    'ext': f.suffix.lower().lstrip('.'),
                    'size_mb': round(size_mb, 1),
                    **song_meta(f, overrides),
                })
    return jsonify(songs)


@bp.route('/api/music/meta', methods=['POST'])
def music_meta():
    """Set a song's title and artist as shown in DeCloud (the file is untouched).
    Empty title and artist go back to the automatic ones."""
    data = request.get_json(silent=True) or {}
    filename = str(data.get('filename') or '')
    path = _safe_music_path(filename)
    if not path or not path.is_file() or path.parent != shared.MUSIC_DIR.resolve():
        return jsonify({'error': 'Song not found.'}), 404
    clean = lambda v: re.sub(r'[\x00-\x1f\x7f]', '', str(v or '')).strip()[:200]
    title, artist = clean(data.get('title')), clean(data.get('artist'))

    def change(settings):
        meta = settings.get('music_meta') if isinstance(settings.get('music_meta'), dict) else {}
        if title or artist:
            meta[path.name] = {'title': title, 'artist': artist}
        else:
            meta.pop(path.name, None)
        settings['music_meta'] = meta
    shared.update_settings(change)
    return jsonify({'ok': True, **song_meta(path, shared.load_settings().get('music_meta') or {})})


def _safe_music_path(filename):
    """Resolve a music file path and ensure it stays within MUSIC_DIR."""
    base = shared.MUSIC_DIR.resolve()
    candidate = (shared.MUSIC_DIR / filename).resolve()
    try:
        if candidate.is_relative_to(base):
            return candidate
    except AttributeError:
        if os.path.commonpath([str(base), str(candidate)]) == str(base):
            return candidate
    return None


@bp.route('/api/music/stream/<path:filename>')
def music_stream(filename):
    """Stream a music file. Uses Flask send_file which handles
    HTTP Range requests natively for fast seeking on iOS."""
    filepath = _safe_music_path(filename)
    if not filepath or not filepath.is_file():
        return jsonify({'error': 'Not found'}), 404

    mime_types = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
        '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    }
    mime = mime_types.get(filepath.suffix.lower(), 'application/octet-stream')

    resp = send_file(str(filepath), mimetype=mime)
    resp.headers['Accept-Ranges'] = 'bytes'
    return resp


@bp.route('/api/music/artwork/<path:filename>')
def music_artwork(filename):
    """Extract embedded artwork, crop to square, cache it."""
    filepath = _safe_music_path(filename)
    if not filepath or not filepath.is_file():
        return jsonify({'error': 'Not found'}), 404

    cache_path = _artwork_cache_path(filename)

    # Serve from cache if exists
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return send_file(str(cache_path), mimetype='image/png')

    # Extract + crop to square in one ffmpeg pass
    try:
        subprocess.run(
            [
                'ffmpeg', '-y', '-i', str(filepath),
                '-map', '0:1',
                '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=256:256',
                '-frames:v', '1',
                str(cache_path),
            ],
            capture_output=True, timeout=5
        )
        if cache_path.exists() and cache_path.stat().st_size > 0:
            return send_file(str(cache_path), mimetype='image/png')
        return jsonify({'error': 'No artwork'}), 404
    except Exception:
        return jsonify({'error': 'Failed'}), 500
