"""Music player routes."""
from flask import Blueprint, jsonify, request, send_file, Response, stream_with_context
import subprocess
from pathlib import Path
from shared import MUSIC_EXTS
import hashlib
import json
import secrets
import datetime
import requests
import os
import re
import threading
import time

import shared
from shared import limiter

bp = Blueprint('music', __name__)

# Cache directory for extracted + cropped artwork.
# Resolved at request time so path changes apply immediately.
def _artwork_cache():
    cache = shared.MUSIC_DIR / '.artwork_cache'
    try:
        cache.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError):
        pass  # read-only fs. Music app will show empty state
    return cache


def _artwork_cache_path(filename):
    """Return cached square artwork path, creating it if needed."""
    key = hashlib.md5(filename.encode()).hexdigest()[:12]
    return _artwork_cache() / f'{key}.png'


@bp.route('/api/music/list')
def music_list():
    """List all music files in the music directory."""
    songs = []
    if shared.MUSIC_DIR.exists():
        for f in sorted(shared.MUSIC_DIR.iterdir()):
            if f.suffix.lower() in MUSIC_EXTS:
                size_mb = f.stat().st_size / (1024 * 1024)
                songs.append({
                    'name': f.stem,
                    'filename': f.name,
                    'ext': f.suffix.lower().lstrip('.'),
                    'size_mb': round(size_mb, 1),
                })
    return jsonify(songs)


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


def _file_stream(filename):
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


def _file_artwork(filename):
    """Extract embedded artwork, crop to square, cache it."""
    filepath = _safe_music_path(filename)
    if not filepath or not filepath.is_file():
        return jsonify({'error': 'Not found'}), 404

    cache_path = _artwork_cache_path(filename)
    none_marker = cache_path.with_suffix('.none')

    def _art_response():
        resp = send_file(str(cache_path), mimetype='image/png')
        # /api/ responses default to no-store; artwork is immutable and heavy
        resp.headers['Cache-Control'] = 'private, max-age=86400'
        return resp

    # Serve from cache if exists
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return _art_response()
    if none_marker.exists():
        resp = jsonify({'error': 'No artwork'})
        resp.headers['Cache-Control'] = 'private, max-age=3600'
        return resp, 404

    # Extract + crop to square in one ffmpeg pass (first video/cover stream)
    try:
        subprocess.run(
            [
                'ffmpeg', '-y', '-i', str(filepath),
                '-map', '0:v:0',
                '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=256:256',
                '-frames:v', '1',
                str(cache_path),
            ],
            capture_output=True, timeout=8
        )
        if cache_path.exists() and cache_path.stat().st_size > 0:
            return _art_response()
        try:
            cache_path.unlink()
        except OSError:
            pass
        try:
            none_marker.touch()
        except OSError:
            pass
        return jsonify({'error': 'No artwork'}), 404
    except Exception:
        return jsonify({'error': 'Failed'}), 500


# ─── Library index (tags, cached) ────────────────────────────────────────
# One recursive scan with mutagen, cached on disk by (mtime, size) so only new
# or changed files are re-read. Falls back to "NN - Artist - Title" filenames.
_APP_DIR = Path(__file__).resolve().parent.parent
_INDEX_FILE = _APP_DIR / 'music_index.json'
_STATE_FILE = _APP_DIR / 'music_state.json'   # favorites + play counts
_index_lock = threading.Lock()
_state_lock = threading.Lock()
_FILENAME_RE = re.compile(r'^(?:\d+\s*-\s*)?(.+?)\s+-\s+(.+)$')


def _first(tags, key):
    v = tags.get(key) if tags else None
    return (v[0] if isinstance(v, list) and v else v or '') if tags else ''


def _read_track(path, rel):
    title = artist = album = genre = year = ''
    track = 0
    dur = 0.0
    try:
        import mutagen
        m = mutagen.File(str(path), easy=True)
        if m is not None:
            dur = float(getattr(m.info, 'length', 0) or 0)
            title = str(_first(m.tags, 'title')).strip()
            artist = str(_first(m.tags, 'artist')).strip()
            album = str(_first(m.tags, 'album')).strip()
            genre = str(_first(m.tags, 'genre')).strip()
            year = str(_first(m.tags, 'date')).strip()[:4]
            tn = str(_first(m.tags, 'tracknumber')).split('/')[0]
            track = int(tn) if tn.isdigit() else 0
    except Exception:
        pass
    if not title or not artist:
        mt = _FILENAME_RE.match(path.stem)
        if mt:
            artist = artist or mt.group(1).strip()
            title = title or mt.group(2).strip()
        else:
            title = title or path.stem
    # "Various Artists"-style albums keep per-track artist; fine as is.
    return {'f': rel, 't': title, 'ar': artist or 'Unknown Artist', 'al': album,
            'g': genre, 'y': year, 'n': track, 'd': round(dur, 1)}


def _build_index():
    base = shared.MUSIC_DIR
    try:
        cache = json.loads(_INDEX_FILE.read_text()) if _INDEX_FILE.exists() else {}
    except Exception:
        cache = {}
    if cache.get('_dir') != str(base):
        cache = {'_dir': str(base)}
    out, fresh = [], {'_dir': str(base)}
    if base.exists():
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for name in files:
                p = Path(root) / name
                if p.suffix.lower() not in MUSIC_EXTS or name.startswith('.'):
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                rel = str(p.relative_to(base))
                key = [st.st_mtime, st.st_size]
                hit = cache.get(rel)
                if hit and hit.get('k') == key:
                    rec = hit['r']
                else:
                    rec = _read_track(p, rel)
                rec = dict(rec, a=int(st.st_mtime))
                fresh[rel] = {'k': key, 'r': {k: v for k, v in rec.items() if k != 'a'}}
                out.append(rec)
    try:
        tmp = _INDEX_FILE.with_suffix('.tmp')
        tmp.write_text(json.dumps(fresh))
        tmp.replace(_INDEX_FILE)
    except OSError:
        pass
    out.sort(key=lambda r: (r['ar'].lower(), r['al'].lower(), r['n'], r['t'].lower()))
    return out


def _load_state():
    try:
        return json.loads(_STATE_FILE.read_text())
    except Exception:
        return {'favs': [], 'plays': {}}


def _save_state(st):
    tmp = _STATE_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(st))
    tmp.replace(_STATE_FILE)



# ─── Navidrome / Subsonic (primary metadata source) ──────────────────────
# Tags, covers, stars and play counts come from Navidrome (more accurate than
# reading files). Credentials stay server-side; streams and covers are proxied
# so the browser only ever talks to DeCloud. Without credentials the file-tag
# index above is used instead.
_nd_cache = {'ts': 0, 'data': None}
_nd_lock = threading.Lock()
_ND_TTL = 20


def _nd_conf():
    user = os.environ.get('DECLOUD_NAVIDROME_USER', '')
    pw = os.environ.get('DECLOUD_NAVIDROME_PASS', '')
    base = os.environ.get('DECLOUD_NAVIDROME_URL', 'http://127.0.0.1:4533/navidrome').rstrip('/')
    return (base, user, pw) if user and pw else None


def _nd_params(conf, extra=None):
    base, user, pw = conf
    salt = secrets.token_hex(6)
    p = {'u': user, 't': hashlib.md5((pw + salt).encode()).hexdigest(), 's': salt,
         'v': '1.16.1', 'c': 'decloud', 'f': 'json'}
    p.update(extra or {})
    return p


def _nd_get(endpoint, **params):
    conf = _nd_conf()
    if not conf:
        raise RuntimeError('Navidrome is not configured')
    r = requests.get(f'{conf[0]}/rest/{endpoint}.view', params=_nd_params(conf, params), timeout=30)
    r.raise_for_status()
    j = r.json().get('subsonic-response', {})
    if j.get('status') != 'ok':
        raise RuntimeError((j.get('error') or {}).get('message', 'Navidrome error'))
    return j


def _epoch(iso):
    if not iso:
        return 0
    try:
        return int(datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp())
    except ValueError:
        return 0


def _nd_song(s):
    path = s.get('path') or ''
    base = str(shared.MUSIC_DIR).rstrip('/') + '/'
    if path.startswith(base):
        path = path[len(base):]
    genre = s.get('genre') or (s.get('genres') or [{}])[0].get('name', '')
    return {
        'f': s['id'], 't': s.get('title') or '', 'ar': s.get('artist') or 'Unknown Artist',
        'ai': s.get('artistId') or s.get('artist') or '', 'al': s.get('album') or '',
        'li': s.get('albumId') or '', 'aa': s.get('displayAlbumArtist') or s.get('albumArtist') or '',
        'y': str(s.get('year') or ''), 'g': genre, 'n': s.get('track') or 0,
        'dn': s.get('discNumber') or 1, 'd': s.get('duration') or 0,
        'a': _epoch(s.get('created')), 'c': s.get('coverArt') or '', 'p': path,
        'fav': bool(s.get('starred')), 'pc': s.get('playCount') or 0,
        'lp': _epoch(s.get('played')), 'br': s.get('bitRate') or 0, 'sx': s.get('suffix') or '',
    }


def _nd_library():
    songs, off, page = [], 0, 500
    for q in ('', '""'):
        songs, off = [], 0
        while off < 200000:
            res = _nd_get('search3', query=q, artistCount=0, albumCount=0,
                          songCount=page, songOffset=off).get('searchResult3', {})
            got = res.get('song', [])
            songs.extend(got)
            if len(got) < page:
                break
            off += page
        if songs:
            break
    tracks = [_nd_song(s) for s in songs if s.get('id')]
    try:
        pls = _nd_get('getPlaylists').get('playlists', {}).get('playlist', [])
        playlists = [{'id': p['id'], 'name': p.get('name', ''), 'n': p.get('songCount', 0),
                      'c': p.get('coverArt', ''), 'd': p.get('duration', 0)} for p in pls]
    except Exception:
        playlists = []
    return {'source': 'navidrome', 'tracks': tracks, 'playlists': playlists}


def _file_library():
    with _index_lock:
        recs = _build_index()
    with _state_lock:
        st = _load_state()
    favs, plays = set(st.get('favs', [])), st.get('plays', {})
    tracks = []
    for r in recs:
        folder = r['f'].rsplit('/', 1)[0] if '/' in r['f'] else ''
        n, last = plays.get(r['f'], [0, 0])
        tracks.append({
            'f': r['f'], 't': r['t'], 'ar': r['ar'], 'ai': r['ar'], 'al': r['al'],
            'li': (folder + '||' + r['al'].lower()) if r['al'] else '', 'aa': '',
            'y': r['y'], 'g': r['g'], 'n': r['n'], 'dn': 1, 'd': r['d'], 'a': r['a'],
            'c': r['f'], 'p': r['f'], 'fav': r['f'] in favs, 'pc': n, 'lp': last,
            'br': 0, 'sx': r['f'].rsplit('.', 1)[-1],
        })
    return {'source': 'files', 'tracks': tracks, 'playlists': []}


def _library_data():
    """The whole library (Navidrome if configured, else file tags), cached briefly."""
    now = time.time()
    with _nd_lock:
        if _nd_cache['data'] and now - _nd_cache['ts'] < _ND_TTL:
            return _nd_cache['data']
    error = ''
    data = None
    if _nd_conf():
        try:
            data = _nd_library()
        except Exception as e:
            error = str(e)
    if data is None:
        data = _file_library()
        if error:
            data['error'] = 'Navidrome unavailable (' + error + '). Showing file tags'
    elif not data['tracks']:
        data['error'] = 'Navidrome returned no songs'
    if not error:
        with _nd_lock:
            _nd_cache.update(ts=now, data=data)
    return data


@bp.route('/api/music/library')
def music_library():
    """Whole library in one request."""
    return jsonify(_library_data())


@bp.route('/api/music/meta')
def music_meta():
    """Title, artist, album, length and cover id for a few tracks (used by the desktop media-widget companion)."""
    ids = [i for i in (request.args.get('ids') or '').split(',') if i][:20]
    want = set(ids)
    out = {}
    for t in _library_data().get('tracks', []):
        if t['f'] in want:
            out[t['f']] = {'t': t['t'], 'ar': t['ar'], 'al': t['al'], 'd': t['d'], 'c': t['c']}
    return jsonify(out)


def _invalidate():
    with _nd_lock:
        _nd_cache.update(ts=0, data=None)


@bp.route('/api/music/playlist/<pid>')
def music_playlist(pid):
    try:
        entries = _nd_get('getPlaylist', id=pid).get('playlist', {}).get('entry', [])
        return jsonify({'ids': [e['id'] for e in entries if e.get('id')]})
    except Exception as e:
        return jsonify({'error': str(e)}), 502


def _bad_id(ident):
    return not isinstance(ident, str) or not ident or len(ident) > 600


@bp.route('/api/music/favorite', methods=['POST'])
def music_favorite():
    data = request.get_json(silent=True) or {}
    ident = data.get('id') or data.get('filename')
    if _bad_id(ident):
        return jsonify({'error': 'bad id'}), 400
    on = bool(data.get('on'))
    if _nd_conf():
        try:
            _nd_get('star' if on else 'unstar', id=ident)
        except Exception as e:
            return jsonify({'error': str(e)}), 502
        _invalidate()
        return jsonify({'ok': True, 'on': on})
    if not _safe_music_path(ident):
        return jsonify({'error': 'bad id'}), 400
    with _state_lock:
        st = _load_state()
        favs = [f for f in st.get('favs', []) if f != ident]
        if on:
            favs.append(ident)
        st['favs'] = favs
        _save_state(st)
    _invalidate()
    return jsonify({'ok': True, 'on': on})


@bp.route('/api/music/played', methods=['POST'])
def music_played():
    data = request.get_json(silent=True) or {}
    ident = data.get('id') or data.get('filename')
    if _bad_id(ident):
        return jsonify({'error': 'bad id'}), 400
    if _nd_conf():
        try:
            _nd_get('scrobble', id=ident, submission='true', time=int(time.time() * 1000))
        except Exception as e:
            return jsonify({'error': str(e)}), 502
        _invalidate()
        return jsonify({'ok': True})
    if not _safe_music_path(ident):
        return jsonify({'error': 'bad id'}), 400
    with _state_lock:
        st = _load_state()
        n, _ = st.setdefault('plays', {}).get(ident, [0, 0])
        st['plays'][ident] = [n + 1, int(time.time())]
        _save_state(st)
    _invalidate()
    return jsonify({'ok': True})


_PASS_HEADERS = ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified', 'ETag')


def _nd_proxy(endpoint, params, extra_headers=None, cache=None):
    """Stream a Navidrome response through DeCloud (Range-aware)."""
    conf = _nd_conf()
    headers = dict(extra_headers or {})
    rng = request.headers.get('Range')
    if rng:
        headers['Range'] = rng
    try:
        up = requests.get(f'{conf[0]}/rest/{endpoint}.view', params=_nd_params(conf, params),
                          headers=headers, stream=True, timeout=(5, 60))
    except requests.RequestException:
        return jsonify({'error': 'Navidrome unreachable'}), 502
    ctype = up.headers.get('Content-Type', '')
    if up.status_code >= 400 or 'json' in ctype or 'xml' in ctype:  # Subsonic reports errors as JSON/XML
        up.close()
        return jsonify({'error': 'Not found'}), 404

    def gen():
        try:
            for chunk in up.iter_content(65536):
                yield chunk
        finally:
            up.close()

    resp = Response(stream_with_context(gen()), status=up.status_code)
    for h in _PASS_HEADERS:
        if h in up.headers:
            resp.headers[h] = up.headers[h]
    if cache:
        resp.headers['Cache-Control'] = cache
    return resp


@bp.route('/api/music/stream/<path:ident>')
def music_stream(ident):
    if _nd_conf():
        if _bad_id(ident):
            return jsonify({'error': 'bad id'}), 400
        return _nd_proxy('stream', {'id': ident, 'format': 'raw'})
    return _file_stream(ident)


@bp.route('/api/music/artwork/<path:ident>')
@limiter.exempt
def music_artwork(ident):
    if _nd_conf():
        if _bad_id(ident):
            return jsonify({'error': 'bad id'}), 400
        size = min(1200, max(48, request.args.get('size', 300, type=int)))
        return _nd_proxy('getCoverArt', {'id': ident, 'size': size}, cache='private, max-age=86400')
    return _file_artwork(ident)


# ─── Cross-device "now playing" session ──────────────────────────────────
# One shared session (queue, position, mode flags) so another device can resume
# where this one stopped. `updated` comes from the server clock, so devices with
# skewed clocks can't make stale state win. Position-only updates omit the queue.
_SESSION_FILE = _APP_DIR / 'music_session.json'
_session_lock = threading.Lock()


def _load_session():
    try:
        return json.loads(_SESSION_FILE.read_text())
    except Exception:
        return None


@bp.route('/api/music/session', methods=['GET'])
def music_session_get():
    with _session_lock:
        data = _load_session()
    return jsonify({'session': data, 'now': time.time(), 'active': _effective_active(data)})


class _Bad(Exception):
    pass


_GONE_GRACE = 8.0           # seconds a dropped device keeps its role (covers a page refresh)
_ACTIVE_IDLE = 300          # a paused device stays "active" this long, then playback is free to move
_conns = {}                 # device id -> {'ws', 'label', 'lock'}
_conn_lock = threading.RLock()
_gone = {}                  # device id -> Timer (grace period before a dropped device counts as stopped)
_pending = {}               # transfer target -> Timer


def _effective_active(sess):
    """The device that is currently outputting (or recently was), if it is still connected."""
    if not sess:
        return None
    a = sess.get('active')
    if not a or (a not in _conns and a not in _gone):     # a just-dropped device (page refresh) keeps its role briefly
        return None
    st = sess.get('state') or {}
    if not st.get('playing') and time.time() - sess.get('updated', 0) > _ACTIVE_IDLE:
        return None
    return a


def _devices(sess):
    act = _effective_active(sess)
    with _conn_lock:
        items = sorted(((d, c['label']) for d, c in _conns.items() if not c.get('ctl')), key=lambda x: (x[1], x[0]))
    seen, out = {}, []
    for d, label in items:                      # "Chrome on Linux", "Chrome on Linux (2)" ...
        seen[label] = seen.get(label, 0) + 1
        out.append({'id': d, 'label': label if seen[label] == 1 else '%s (%d)' % (label, seen[label]), 'active': d == act})
    return out


def _send(dev, obj):
    with _conn_lock:
        c = _conns.get(dev)
    if not c:
        return False
    try:
        with c['lock']:
            c['ws'].send(json.dumps(obj))
        return True
    except Exception:
        return False


def _state_msg(sess):
    return {'t': 'state', 's': sess, 'devices': _devices(sess), 'active': _effective_active(sess), 'now': time.time()}


def _broadcast(sess=None, skip=None):
    sess = sess if sess is not None else _load_session()
    msg = _state_msg(sess or {})
    with _conn_lock:
        ids = list(_conns)
    for d in ids:
        if d != skip:
            _send(d, msg)


def _validate_report(b):
    try:
        pos = float(b.get('pos', 0))
        qi = int(b.get('qi', 0))
    except (TypeError, ValueError):
        raise _Bad('bad numbers')
    if not (0 <= pos < 1e6) or qi < 0:
        raise _Bad('bad request')
    rp = b.get('rp', 'off')
    if rp not in ('off', 'all', 'one'):
        raise _Bad('bad repeat')
    q = b.get('q')
    if q is not None and (not isinstance(q, list) or not q or len(q) > 2000
                          or any(not isinstance(i, str) or not i or len(i) > 600 for i in q)):
        raise _Bad('bad queue')
    return pos, qi, rp, q


def _report(dev, label, b, force=False):
    """Merge a device's playback report into the shared session.

    Only the active device may update an active session, except that a device which starts
    playing takes over (and the previous one is told to stop). `force` is used for an
    explicit handoff, where the sender is still the active device anyway."""
    pos, qi, rp, q = _validate_report(b)
    stop = None
    with _session_lock:
        cur = _load_session() or {}
        act = _effective_active(cur)
        playing = bool(b.get('playing'))
        if act and act != dev and not playing and not force:
            return {'ok': True, 'ignored': True}        # a non-active device must not clobber the session
        st = dict(cur.get('state') or {})
        if q is not None:
            st['q'] = q
        queue = st.get('q') or []
        if qi >= len(queue):
            return {'ok': False, 'stale': True}
        if q is None and queue[qi] != b.get('cur'):
            return {'ok': False, 'stale': True}
        st.update(qi=qi, pos=round(pos, 1), playing=playing, sh=bool(b.get('sh')), rp=rp)
        if act == dev or playing:
            new_active = dev
        else:
            new_active = None                            # idle report with nobody active: store, but don't claim
        if playing and act and act != dev:
            stop = act
        out = {'state': st, 'updated': time.time(), 'dev': dev, 'label': label, 'active': new_active}
        try:
            tmp = _SESSION_FILE.with_suffix('.tmp')
            tmp.write_text(json.dumps(out))
            tmp.replace(_SESSION_FILE)
        except OSError:
            raise _Bad('could not save')
    if stop:
        _send(stop, {'t': 'cmd', 'a': 'stop', 'from': dev})
    _broadcast(out, skip=dev)
    return {'ok': True, 'updated': out['updated']}


@bp.route('/api/music/session', methods=['POST'])
def music_session_set():
    b = request.get_json(silent=True) or {}
    dev = str(b.get('dev') or '')[:60]
    if not dev:
        return jsonify({'error': 'bad request'}), 400
    try:
        return jsonify(_report(dev, str(b.get('label') or '')[:60], b))
    except _Bad as e:
        return jsonify({'error': str(e)}), 400


# ─── live "Connect" channel (WebSocket) ──────────────────────────────────
# Devices stay connected; the active one reports playback, the others become remotes whose
# commands are forwarded to it. A transfer first asks the old device for its exact position.
def _extrapolated(sess):
    st = dict(sess.get('state') or {})
    if st.get('playing'):
        st['pos'] = round(st.get('pos', 0) + max(0, time.time() - sess.get('updated', time.time())), 1)
    return st


def _finalize_transfer(target):
    t = _pending.pop(target, None)
    if t:
        t.cancel()
    with _session_lock:
        cur = _load_session()
        if not cur or target not in _conns:
            return
        st = _extrapolated(cur) if not cur.get('_fresh') else dict(cur.get('state') or {})
        cur.pop('_fresh', None)
        label = _conns[target]['label']
        out = {'state': st, 'updated': time.time(), 'dev': target, 'label': label, 'active': target}
        _SESSION_FILE.write_text(json.dumps(out))
    _send(target, {'t': 'cmd', 'a': 'takeover', 'state': st, 'play': bool(st.get('playing'))})
    _broadcast(out)


def _mark_gone(dev):
    """A device dropped. After a short grace (page refresh) an active one counts as stopped."""
    _gone.pop(dev, None)
    with _session_lock:
        cur = _load_session()
        if not cur or cur.get('active') != dev or dev in _conns:
            return
        st = _extrapolated(cur)
        st['playing'] = False
        out = dict(cur, state=st, updated=time.time(), active=None)
        _SESSION_FILE.write_text(json.dumps(out))
    _broadcast(out)


def register(sock):
    from shared import ws_is_authenticated

    @sock.route('/api/music/connect')
    def music_connect(ws):
        # The HTTP auth gate already ran on the upgrade request (same-origin WebSockets carry the
        # login cookie, so the session token never has to appear in the URL or the request log).
        if not ws_is_authenticated(getattr(ws, 'environ', {})):
            try:
                ws.close()
            except Exception:
                pass
            return
        dev, label, lock = None, '', threading.Lock()
        try:
            while True:
                raw = ws.receive(timeout=60)
                if raw is None:                      # 60 s of silence: the client pings every 20 s
                    break
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                t = m.get('t')
                if t == 'hello':
                    dev = str(m.get('dev') or '')[:60]
                    label = str(m.get('label') or 'Browser')[:60]
                    if not dev:
                        break
                    with _conn_lock:
                        old = _conns.get(dev)
                        # a "controller" (e.g. the KDE media-widget companion) can send commands but never plays audio
                        _conns[dev] = {'ws': ws, 'label': label, 'lock': lock, 'ctl': str(m.get('role') or '') == 'controller'}
                    g = _gone.pop(dev, None)
                    if g:
                        g.cancel()
                    if old and old['ws'] is not ws:
                        try:
                            old['ws'].close()
                        except Exception:
                            pass
                    with _session_lock:
                        sess = _load_session() or {}
                    _send(dev, _state_msg(sess))
                    _broadcast(sess, skip=dev)       # everyone else learns about the new device
                elif not dev:
                    continue
                elif t == 'ping':
                    _send(dev, {'t': 'pong'})
                elif t == 'state':
                    if _conns.get(dev, {}).get('ctl'):
                        continue                       # controllers never report playback
                    try:
                        res = _report(dev, label, m)
                    except _Bad as e:
                        res = {'ok': False, 'error': str(e)}
                    _send(dev, dict(res, t='ack'))
                elif t == 'cmd':
                    with _session_lock:
                        sess = _load_session() or {}
                    act = _effective_active(sess)
                    if act and act != dev and _send(act, {'t': 'cmd', 'a': m.get('a'), 'v': m.get('v'), 'state': m.get('state'), 'from': dev}):
                        continue
                    _send(dev, {'t': 'nodevice', 'cmd': m.get('a')})
                elif t == 'blocked':                 # the active device's browser refused to start audio
                    _send(str(m.get('to') or ''), {'t': 'blocked', 'dev': dev})
                elif t == 'transfer':
                    target = str(m.get('to') or '')
                    with _session_lock:
                        sess = _load_session() or {}
                    act = _effective_active(sess)
                    if target not in _conns or _conns[target].get('ctl') or target == act:
                        continue
                    if act and act in _conns:
                        _send(act, {'t': 'cmd', 'a': 'handoff', 'to': target})
                        tm = threading.Timer(2.5, _finalize_transfer, args=(target,))
                        old = _pending.pop(target, None)
                        if old:
                            old.cancel()
                        _pending[target] = tm
                        tm.start()
                    else:
                        _finalize_transfer(target)
                elif t == 'handoff':                 # exact position from the device that is giving up playback
                    target = str(m.get('to') or '')
                    try:
                        _report(dev, label, m, force=True)
                        with _session_lock:
                            cur = _load_session() or {}
                            cur['_fresh'] = True
                            _SESSION_FILE.write_text(json.dumps(cur))
                    except _Bad:
                        pass
                    if target in _pending:
                        _finalize_transfer(target)
        except Exception:
            pass
        finally:
            if dev:
                with _conn_lock:
                    mine = _conns.get(dev) and _conns[dev]['ws'] is ws
                    if mine:
                        _conns.pop(dev, None)
                if mine:
                    tm = threading.Timer(_GONE_GRACE, _mark_gone, args=(dev,))
                    _gone[dev] = tm
                    tm.start()
                    _broadcast(None)
