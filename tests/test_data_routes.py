"""Regression tests for the books / voice / telemetry / system audit fixes."""
import json

import pytest

import shared


@pytest.fixture
def books(tmp_path, monkeypatch):
    import routes.books as books_module
    books_dir, audio = tmp_path / 'books', tmp_path / 'audio'
    books_dir.mkdir()
    audio.mkdir()
    monkeypatch.setattr(shared, 'BOOKS_DIR', books_dir)
    monkeypatch.setattr(books_module, 'AUDIO_DIR', audio)
    return books_dir, audio


class TestBookIdTraversal:
    @pytest.mark.parametrize('url', [
        '/api/audio/..%5C..%5Csecret',
        '/api/book/..%5Cx/settings',
        '/api/book/..%5Cx/position',
        '/api/tts/status/..%5Cx',
        '/api/audio/..%5Cx/cover',
    ])
    def test_backslash_rejected(self, client, auth_headers, url):
        assert client.get(url, headers=auth_headers).status_code == 400

    def test_helper(self):
        assert shared.is_safe_book_ref('Good_Book')
        for bad in ('..\\x', 'a/b', '..', '.hidden', 'a\0b', ''):
            assert not shared.is_safe_book_ref(bad)

    def test_universe_person(self, client, auth_headers, tmp_path, monkeypatch):
        import routes.universe as uni
        monkeypatch.setattr(uni, 'JOURNAL_DIR', str(tmp_path))
        r = client.get('/api/universe/person/..%5C..%5Cx', headers=auth_headers)
        assert r.status_code == 400


class TestBookText:
    def test_txt_only_chapter_zero(self, books):
        books_dir, _ = books
        (books_dir / 'Plain.txt').write_text('word ' * 1000)
        assert shared.get_book_chapter_text('Plain', 0)[0]
        assert shared.get_book_chapter_text('Plain', 10**9) == ('', '')

    def test_json_chapters(self, books):
        books_dir, _ = books
        (books_dir / 'J.json').write_text(json.dumps([{'title': 'A', 'text': 'aa'}]))
        assert shared.get_book_chapter_text('J', 0) == ('aa', 'A')
        assert shared.get_book_chapter_text('J', 1) == ('', '')

    def test_llm_chat_uses_llm_complete(self, monkeypatch):
        monkeypatch.setattr(shared, 'llm_complete', lambda *a, **k: ' hi ')
        assert shared.llm_chat([]) == 'hi'

        def boom(*a, **k):
            raise RuntimeError('down')
        monkeypatch.setattr(shared, 'llm_complete', boom)
        assert shared.llm_chat([]).startswith('[LLM error')

    def test_cache_is_capped(self):
        for i in range(shared._PDF_CACHE_BOOKS + 3):
            shared._cache_book(shared._pdf_chapters_cache, f'b{i}', [])
        assert len(shared._pdf_chapters_cache) <= shared._PDF_CACHE_BOOKS


class TestTts:
    def test_refuses_second_worker(self, client, auth_headers, books):
        books_dir, audio = books
        (books_dir / 'Busy.json').write_text('[]')
        (audio / 'Busy.tts_lock').write_text('40')
        r = client.post('/api/tts/start/Busy', headers=auth_headers)
        assert r.status_code == 409

    def test_failed_lock_reports_error(self, client, auth_headers, books):
        _, audio = books
        (audio / 'Dead.tts_lock').write_text('-1')
        r = client.get('/api/tts/status/Dead', headers=auth_headers)
        assert r.get_json()['status'] == 'error'


class TestVoiceRunCommand:
    @pytest.mark.parametrize('access,cmd', [
        ('talk', 'find . -delete'),
        ('talk', 'find . -execdir id ;'),
        ('basic', 'git -c core.sshCommand=id fetch'),
        ('basic', 'tar -cf x.tar --to-command=id .'),
        ('basic', 'python3 x.py'),
        ('basic', 'python3 -m http.server'),
    ])
    def test_blocked(self, client, auth_headers, monkeypatch, access, cmd):
        monkeypatch.setattr(shared, 'get_voice_config', lambda: {'voice_access': access})
        r = client.post('/api/voice/run_command', json={'command': cmd}, headers=auth_headers)
        assert r.status_code == 403, r.get_json()

    def test_plain_find_allowed(self, client, auth_headers, monkeypatch, tmp_path):
        monkeypatch.setattr(shared, 'get_voice_config', lambda: {'voice_access': 'talk'})
        r = client.post('/api/voice/run_command', json={'command': f'find {tmp_path} -maxdepth 0'},
                        headers=auth_headers)
        assert r.status_code == 200

    def test_intent_route_removed(self, client, auth_headers):
        r = client.post('/api/voice/intent', json={'text': 'hi'}, headers=auth_headers)
        assert r.status_code in (404, 405)


class TestTelemetry:
    @pytest.fixture(autouse=True)
    def usage(self, tmp_path, monkeypatch):
        import routes.telemetry as tel
        monkeypatch.setattr(tel, 'USAGE_FILE', tmp_path / 'usage.json')
        monkeypatch.setattr(tel, 'USAGE_MAX_ENTRIES', 3)
        return tmp_path / 'usage.json'

    def test_bad_duration_rejected(self, client, auth_headers):
        for bad in ('x', float('inf'), True, -1):
            r = client.post('/api/telemetry/app-usage',
                            data=json.dumps({'app_id': 'a', 'action': 'close', 'duration': bad}),
                            content_type='application/json', headers=auth_headers)
            assert r.status_code == 400
        assert client.get('/api/telemetry/app-usage', headers=auth_headers).status_code == 200

    def test_legacy_junk_and_cap(self, client, auth_headers, usage):
        usage.write_text(json.dumps([{'app_id': 'a', 'action': 'close', 'duration': 'x'}]))
        assert client.get('/api/telemetry/app-usage', headers=auth_headers).status_code == 200
        for _ in range(5):
            client.post('/api/telemetry/app-usage', json={'app_id': 'a', 'action': 'open'},
                        headers=auth_headers)
        assert len(json.loads(usage.read_text())) == 3


def test_system_info(client, auth_headers):
    r = client.get('/api/system', headers=auth_headers)
    assert r.status_code == 200
    d = r.get_json()
    assert 'cpu_percent' in d
    if 'gpu' in d:
        assert set(d['gpu']) == {'gpu_percent', 'name'}
