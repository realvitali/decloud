"""Music search + download: input validation, filtering, job lifecycle.

The network is never touched — yt-dlp is faked with a stub module.
"""
import time

import pytest

import routes.music as music


class _FakeYDL:
    """Pretends to be yt_dlp.YoutubeDL with canned search results."""

    last_opts = None

    def __init__(self, opts):
        _FakeYDL.last_opts = opts
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=False):
        assert 'ytsearch' in url
        return {'entries': [
            {'id': 'goodvid01', 'title': 'A Song', 'channel': 'Artist', 'duration': 200},
            {'id': 'livevideo0', 'title': 'Live Stream', 'channel': 'X', 'duration': 0},      # live → skip
            {'id': 'longvideo0', 'title': 'Mix', 'channel': 'X', 'duration': 7200},           # 2h mix → skip
            {'id': 'goodvid02', 'title': 'Another', 'channel': 'B', 'duration': None},        # unknown → skip
            None,                                                                            # junk → skip
        ]}

    def download(self, urls):
        import shared
        (shared.MUSIC_DIR / 'downloaded.m4a').write_bytes(b'x' * 16)
        return 0


@pytest.fixture
def fake_ytdlp(monkeypatch):
    mod = type('M', (), {'YoutubeDL': _FakeYDL})()
    monkeypatch.setattr(music, '_ytdlp', lambda: mod)
    return mod


class TestMusicSearch:
    def test_requires_query(self, client, auth_headers):
        r = client.post('/api/music/search', json={'q': '  '}, headers=auth_headers)
        assert r.status_code == 400

    def test_filters_live_and_marathon(self, client, auth_headers, fake_ytdlp):
        r = client.post('/api/music/search', json={'q': 'song'}, headers=auth_headers)
        assert r.status_code == 200
        assert [s['id'] for s in r.get_json()] == ['goodvid01']

    def test_missing_ytdlp_is_503(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(music, '_ytdlp', lambda: None)
        r = client.post('/api/music/search', json={'q': 'song'}, headers=auth_headers)
        assert r.status_code == 503


class TestMusicDownload:
    def test_rejects_bad_ids(self, client, auth_headers, fake_ytdlp):
        for bad in ('', 'x', '../etc', 'has space', 'a' * 30, 'bad$id'):
            r = client.post('/api/music/download', json={'id': bad}, headers=auth_headers)
            assert r.status_code == 400, bad

    def test_download_lifecycle(self, client, auth_headers, fake_ytdlp, tmp_path, monkeypatch):
        import shared
        monkeypatch.setattr(shared, 'MUSIC_DIR', tmp_path)
        r = client.post('/api/music/download', json={'id': 'goodvid01', 'title': 'A Song'}, headers=auth_headers)
        assert r.status_code == 202
        job = r.get_json()['job']
        # The output template must target the (temp) music dir, never elsewhere
        assert str(tmp_path) in _FakeYDL.last_opts['outtmpl']
        assert _FakeYDL.last_opts['max_filesize'] <= 300 * 1024 * 1024   # no 10-hour downloads filling the disk
        for _ in range(100):
            j = client.get(f'/api/music/download/{job}', headers=auth_headers).get_json()
            if j['state'] != 'running':
                break
            time.sleep(0.05)
        assert j['state'] == 'done'
        assert (tmp_path / 'downloaded.m4a').exists()

    def test_unknown_job_is_404(self, client, auth_headers):
        assert client.get('/api/music/download/nope', headers=auth_headers).status_code == 404

class TestSongNames:
    def test_title_and_artist_from_the_name_and_edits(self, client, auth_headers, tmp_path, monkeypatch):
        import shared, routes.music as music
        monkeypatch.setattr(shared, 'MUSIC_DIR', tmp_path)
        (tmp_path / 'Owl City - Fireflies (Official Video).m4a').write_bytes(b'x')
        (tmp_path / 'Plain Song.mp3').write_bytes(b'x')
        songs = {s['filename']: s for s in client.get('/api/music/list', headers=auth_headers).get_json()}
        assert (songs['Owl City - Fireflies (Official Video).m4a']['title'], songs['Owl City - Fireflies (Official Video).m4a']['artist']) == ('Fireflies', 'Owl City')
        assert songs['Plain Song.mp3']['title'] == 'Plain Song' and songs['Plain Song.mp3']['artist'] == ''
        r = client.post('/api/music/meta', json={'filename': 'Plain Song.mp3', 'title': 'Real\nName', 'artist': 'Someone'}, headers=auth_headers)
        assert r.get_json()['title'] == 'RealName' and r.get_json()['artist'] == 'Someone'
        assert client.post('/api/music/meta', json={'filename': '../../etc/passwd', 'title': 'x'}, headers=auth_headers).status_code == 404
        client.post('/api/music/meta', json={'filename': 'Plain Song.mp3', 'title': '', 'artist': ''}, headers=auth_headers)
        songs = {s['filename']: s for s in client.get('/api/music/list', headers=auth_headers).get_json()}
        assert songs['Plain Song.mp3']['title'] == 'Plain Song' and not songs['Plain Song.mp3']['edited']
