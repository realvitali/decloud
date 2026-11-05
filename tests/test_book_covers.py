"""Cover generation should keep existing files and provide a usable fallback."""
import fitz
from PIL import Image

import routes.books as books
import shared


def test_plain_text_gets_versioned_hardcover_without_overwriting_legacy(tmp_path, monkeypatch):
    library, cache = tmp_path / 'library', tmp_path / 'cache'
    library.mkdir()
    cache.mkdir()
    (library / 'A_Book.txt').write_text('a book')
    legacy = cache / 'A_Book_cover.png'
    legacy.write_bytes(b'old cover')
    monkeypatch.setattr(shared, 'BOOKS_DIR', library)
    monkeypatch.setattr(books, 'AUDIO_DIR', cache)
    cover = books._ensure_book_cover('A_Book')
    assert cover.name == 'A_Book_hardcover_v2.png'
    assert Image.open(cover).size == (400, 600)
    assert legacy.read_bytes() == b'old cover'
    assert books._ensure_book_cover('A_Book') == cover


def test_unillustrated_pdf_gets_hardcover(tmp_path, monkeypatch):
    library, cache = tmp_path / 'library', tmp_path / 'cache'
    library.mkdir()
    cache.mkdir()
    with fitz.open() as doc:
        doc.new_page().insert_text((72, 72), 'Text-only title page')
        doc.set_metadata({'title': 'A Real Title', 'author': 'An Author'})
        doc.save(library / 'Test.pdf')
    monkeypatch.setattr(shared, 'BOOKS_DIR', library)
    monkeypatch.setattr(books, 'AUDIO_DIR', cache)
    cover = books._ensure_book_cover('Test')
    assert cover.name == 'Test_hardcover_v2.png'
    assert Image.open(cover).size == (400, 600)


def test_library_metadata_settings_and_text_reader(client, auth_headers, tmp_path, monkeypatch):
    library, cache = tmp_path / 'library', tmp_path / 'cache'
    library.mkdir()
    cache.mkdir()
    (library / 'Plain.txt').write_text('word ' * 1000)
    with fitz.open() as doc:
        doc.new_page().insert_text((72, 72), 'Text')
        doc.set_metadata({'author': 'A Writer'})
        doc.save(library / 'Novel.pdf')
    monkeypatch.setattr(shared, 'BOOKS_DIR', library)
    monkeypatch.setattr(books, 'AUDIO_DIR', cache)
    assert client.post('/api/book/Plain/position', json={'opened': True}, headers=auth_headers).status_code == 200
    settings = client.post('/api/book/Plain/settings', json={'font_size': 2}, headers=auth_headers).get_json()
    assert settings['font_size'] == 2
    assert client.get('/api/book/Plain/settings', headers=auth_headers).get_json()['font_size'] == 2
    items = {b['id']: b for b in client.get('/api/books', headers=auth_headers).get_json()}
    assert items['Novel']['author'] == 'A Writer'
    assert items['Novel']['length_pages'] == 1
    assert items['Plain']['length_pages'] == 4
    assert items['Plain']['last_opened'] > 0
    assert client.get('/api/books/text?book=Plain', headers=auth_headers).get_json()['chapters']
    assert 'word' in client.get('/api/books/text?book=Plain&chapter=0', headers=auth_headers).get_json()['text']
    assert client.get('/api/books/text?book=Novel', headers=auth_headers).get_json()['chapters']
    assert 'Text' in client.get('/api/books/text?book=Novel&chapter=0', headers=auth_headers).get_json()['text']
