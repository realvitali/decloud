"""Whole-book synthesis source coverage, progress and startup."""
import json
import sys
import time
import wave
from pathlib import Path
from types import SimpleNamespace

import fitz
import routes.books as books
import shared
import tts_worker_json as worker


def test_pdf_source_keeps_opening_and_last_page(tmp_path):
    pdf = tmp_path / 'book.pdf'
    with fitz.open() as doc:
        for text in ('Opening text', 'First section text', 'Final page text'):
            doc.new_page().insert_text((72, 72), text)
        doc.set_toc([[1, 'Section', 2]])
        doc.save(pdf)
    sections = worker.load_book(pdf)
    assert 'Opening text' in sections[0]['text']
    assert 'First section text' in sections[0]['text']
    assert 'Final page text' in sections[0]['text']


def test_txt_whole_book_and_progress(tmp_path, monkeypatch):
    source = tmp_path / 'book.txt'
    source.write_text('word ' * 1800, encoding='utf-8')
    audio = tmp_path / 'audio'
    audio.mkdir()
    observed = []

    def fake_piper(text, output, voice):
        observed.append(int((audio / 'book.tts_lock').read_text()))
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(22050)
            wav.writeframes(b'\0' * 1200)

    def fake_ffmpeg(args, **kwargs):
        Path(args[-1]).write_bytes(b'audio')
        return SimpleNamespace(returncode=0, stderr='')

    monkeypatch.setattr(worker, 'tts_piper', fake_piper)
    monkeypatch.setattr(worker.subprocess, 'run', fake_ffmpeg)
    monkeypatch.setattr(sys, 'argv', ['tts_worker_json.py', str(source), str(audio), 'book'])
    worker.main()
    data = json.loads((audio / 'book.json').read_text())
    assert data['has_audio'] and data['chapters'][0]['text'] == source.read_text()
    assert len(observed) > 1 and observed[0] == 0 and observed[-1] > 0
    assert not (audio / 'book.tts_lock').exists()


def test_status_reports_whole_book_percent_and_eta(client, auth_headers, tmp_path, monkeypatch):
    monkeypatch.setattr(books, 'AUDIO_DIR', tmp_path)
    (tmp_path / 'book.tts_lock').write_text('50')
    (tmp_path / 'book.tts_started').write_text(str(time.time() - 20))
    data = client.get('/api/tts/status/book', headers=auth_headers).get_json()
    assert data['status'] == 'converting' and data['progress'] == 50
    assert 18 <= data['eta_seconds'] <= 25
    assert 'done_chapters' not in data


def test_only_real_audio_metadata_reports_complete(client, auth_headers, tmp_path, monkeypatch):
    monkeypatch.setattr(books, 'AUDIO_DIR', tmp_path)
    metadata = tmp_path / 'book.json'
    metadata.write_text(json.dumps({'has_audio': False, 'chapters': []}))
    assert client.get('/api/tts/status/book', headers=auth_headers).get_json()['progress'] == 0
    metadata.write_text(json.dumps({'has_audio': True, 'chapters': [{'file': 'book_chapter_0.mp3'}]}))
    assert client.get('/api/tts/status/book', headers=auth_headers).get_json()['progress'] == 0
    (tmp_path / 'book_chapter_0.mp3').write_bytes(b'audio')
    assert client.get('/api/tts/status/book', headers=auth_headers).get_json()['progress'] == 100


def test_start_uses_full_txt_source(client, auth_headers, tmp_path, monkeypatch):
    library, audio = tmp_path / 'library', tmp_path / 'audio'
    library.mkdir()
    audio.mkdir()
    source = library / 'book.txt'
    source.write_text('text')
    monkeypatch.setattr(shared, 'BOOKS_DIR', library)
    monkeypatch.setattr(books, 'AUDIO_DIR', audio)
    calls = []
    monkeypatch.setattr(books.subprocess, 'Popen', lambda args, **kwargs: calls.append(args))
    result = client.post('/api/tts/start/book', headers=auth_headers)
    assert result.status_code == 200
    assert calls[0][1].endswith('tts_worker_json.py') and calls[0][2] == str(source)
    assert (audio / 'book.tts_started').exists()
