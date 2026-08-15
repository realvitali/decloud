"""Music player routes."""
from flask import Blueprint, jsonify, request, send_file, Response
import subprocess
from pathlib import Path
from shared import MUSIC_DIR, MUSIC_EXTS
import hashlib
import os

bp = Blueprint('music', __name__)

# Cache directory for extracted + cropped artwork
# Create parents if missing so we don't crash on fresh installs
ARTWORK_CACHE = MUSIC_DIR / '.artwork_cache'
try:
    ARTWORK_CACHE.mkdir(parents=True, exist_ok=True)
except PermissionError:
    pass  # read-only fs — music app will show empty state


def _artwork_cache_path(filename):
    """Return cached square artwork path, creating it if needed."""
    key = hashlib.md5(filename.encode()).hexdigest()[:12]
    return ARTWORK_CACHE / f'{key}.png'


@bp.route('/api/music/list')
def music_list():
    """List all music files in the music directory."""
    songs = []
    if MUSIC_DIR.exists():
        for f in sorted(MUSIC_DIR.iterdir()):
            if f.suffix.lower() in MUSIC_EXTS:
                size_mb = f.stat().st_size / (1024 * 1024)
                songs.append({
                    'name': f.stem,
                    'filename': f.name,
                    'ext': f.suffix.lower().lstrip('.'),
                    'size_mb': round(size_mb, 1),
                })
    return jsonify(songs)


@bp.route('/api/music/stream/<path:filename>')
def music_stream(filename):
    """Stream a music file. Uses Flask send_file which handles
    HTTP Range requests natively for fast seeking on iOS."""
    filepath = MUSIC_DIR / filename
    if not filepath.exists():
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
    filepath = MUSIC_DIR / filename
    if not filepath.exists():
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
