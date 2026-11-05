"""Books library, audio, TTS, summarize, and Q&A routes."""
from flask import Blueprint, jsonify, request, send_file
import json, re, subprocess
from shared import (
    app, BASE_DIR, AUDIO_DIR, VOICES, llm_chat,
    get_book_chapter_text, get_text_up_to_position,
)

import shared

bp = Blueprint('books', __name__)


@bp.before_request
def _reject_unsafe_book_id():
    """Every <book_id> URL param is joined into AUDIO_DIR / BOOKS_DIR paths
    and glob patterns, so reject traversal (incl. Windows '%5C..%5C')."""
    book_id = (request.view_args or {}).get('book_id')
    if book_id is not None and not shared.is_safe_book_ref(book_id):
        return jsonify({'error': 'invalid book'}), 400


def _llm_failed(msg):
    """Log the raw LLM error server-side; give the client a friendly one."""
    app.logger.error(f'[BOOKS] {msg}')
    return jsonify({'error': 'The AI model is unavailable right now. Check Settings → AI and try again.'}), 503

@bp.route('/api/voices')
def list_voices():
    return jsonify(list(VOICES.values()))

# ─── API: Books Library ──────────────────────────────────────
@bp.route('/api/books')
def list_books():
    books = []
    if shared.BOOKS_DIR.exists():
        # Collect both PDF and JSON source files
        # JSON sources first (preferred), then PDFs
        source_files = []
        for f in sorted(shared.BOOKS_DIR.rglob('*.json')):
            source_files.append((f, 'json'))
        for f in sorted(shared.BOOKS_DIR.rglob('*.pdf')):
            source_files.append((f, 'pdf'))
        for f in sorted(shared.BOOKS_DIR.rglob('*.txt')):
            # Skip non-book txt files
            if f.stat().st_size > 3000:
                source_files.append((f, 'txt'))

        pdf_by_id = {f.stem: f for f, kind in source_files if kind == 'pdf'}

        # Deduplicate by book_id (prefer JSON source over PDF if same stem)
        seen_ids = set()
        for f, ftype in source_files:
            book_id = f.stem
            if book_id in seen_ids:
                continue
            seen_ids.add(book_id)

            settings_file = AUDIO_DIR / f'{book_id}_settings.json'
            lock_file = AUDIO_DIR / f'{book_id}.tts_lock'
            json_meta = AUDIO_DIR / f'{book_id}.json'

            # Load settings (with defaults)
            settings = {'voice': 'kathleen-low'}
            if settings_file.exists():
                settings = json.loads(settings_file.read_text())

            # Determine status
            if lock_file.exists():
                lock_content = lock_file.read_text().strip()
                if lock_content == '-1':
                    status = 'error'
                else:
                    status = 'generating'
            elif json_meta.exists():
                status = 'ready'
            else:
                status = 'new'

            # Real chapter counts: prefer the TTS worker's metadata file,
            # then the JSON source length. PDFs/TXTs without metadata get
            # None (unknown) so the UI can hide the number instead of lying.
            chapters_done = 0
            total_chapters = None
            for i in range(200):  # generous cap — books can exceed 30 chapters
                if (AUDIO_DIR / f'{book_id}_chapter_{i}.mp3').exists():
                    chapters_done = i + 1
                else:
                    break
            if json_meta.exists():
                try:
                    meta = json.loads(json_meta.read_text())
                    if isinstance(meta.get('total_chapters'), int):
                        total_chapters = meta['total_chapters']
                except Exception:
                    pass
            if total_chapters is None and ftype == 'json':
                try:
                    with open(f) as jf:
                        total_chapters = len(json.load(jf))
                except Exception:
                    pass

            # Per-chapter status (backward-compatible 30-slot array)
            chapters = []
            for i in range(30):  # check up to 30 chapters
                chapter_file = AUDIO_DIR / f'{book_id}_chapter_{i}.mp3'
                if chapter_file.exists():
                    chapters.append({'index': i, 'status': 'done', 'file': f'{book_id}_chapter_{i}.mp3'})
                else:
                    chapters.append({'index': i, 'status': 'pending'})

            author, length_pages = '', None
            pdf = pdf_by_id.get(book_id)
            if pdf:
                try:
                    import fitz
                    with fitz.open(str(pdf)) as doc:
                        author = str((doc.metadata or {}).get('author') or '').strip()[:160]
                        if author.lower() in ('owner', 'user', 'unknown', 'admin', 'administrator'):
                            author = ''
                        length_pages = len(doc)
                except Exception:
                    pass
            elif ftype == 'txt':
                try:
                    length_pages = max(1, (len(f.read_text(encoding='utf-8', errors='replace').split()) + 249) // 250)
                except OSError:
                    pass
            elif ftype == 'json':
                try:
                    chapters_data = json.loads(f.read_text(encoding='utf-8'))
                    if isinstance(chapters_data, list):
                        words = sum(len(str(ch.get('text', '')).split()) for ch in chapters_data if isinstance(ch, dict))
                        length_pages = max(1, (words + 249) // 250)
                except (OSError, ValueError):
                    pass
            last_opened = 0
            try:
                position = json.loads((AUDIO_DIR / f'{book_id}_position.json').read_text())
                last_opened = float(position.get('last_opened', position.get('updated', 0)))
            except (OSError, ValueError, TypeError):
                pass
            books.append({
                'id': book_id,
                'title': book_id.replace('_', ' '),
                'author': author,
                'length_pages': length_pages,
                'last_opened': last_opened,
                'filename': f.name,
                'source_type': ftype,
                'size_mb': round(f.stat().st_size / 1024 / 1024, 1),
                'status': status,
                'voice': settings.get('voice', 'kathleen-low'),
                'chapters': chapters,
                'chapters_done': chapters_done,
                'total_chapters': total_chapters,
            })
    return jsonify(books)

@bp.route('/api/books/text')
def get_book_text():
    """Serve extracted plain text from a book PDF.
    Query params: book (book id), chapter (0-indexed chapter number).
    Results are cached in memory to avoid re-parsing the PDF on every request.
    """
    book_id = request.args.get('book')       # e.g. 'Cybernetics_Wiener'
    chapter_idx = request.args.get('chapter') # e.g. '0'
    chapter_file = request.args.get('file')  # fallback: direct file name

    # Reject path traversal in book/file references (they feed glob patterns).
    if book_id and not shared.is_safe_book_ref(book_id):
        return jsonify({'error': 'invalid book'}), 400
    if chapter_file and not shared.is_safe_book_ref(chapter_file):
        return jsonify({'error': 'invalid file'}), 400

    if chapter_file:
        # Search subfolders for the file
        matches = list(shared.BOOKS_DIR.rglob(chapter_file))
        pdf_path = matches[0] if matches else (shared.BOOKS_DIR / chapter_file)
    elif book_id:
        # Check for JSON source first, then PDF (search subfolders)
        json_matches = list(shared.BOOKS_DIR.rglob(f'{book_id}.json'))
        json_source = json_matches[0] if json_matches else (shared.BOOKS_DIR / f'{book_id}.json')
        pdf_matches = list(shared.BOOKS_DIR.rglob(f'{book_id}.pdf'))
        if json_source.exists():
            # Serve from JSON source
            with open(json_source) as jf:
                chapters_data = json.load(jf)
            total = len(chapters_data)
            if chapter_idx is not None:
                try:
                    idx = int(chapter_idx)
                    if idx < 0 or idx >= total:
                        return jsonify({'error': 'chapter out of range'}), 404
                    ch = chapters_data[idx]
                    return jsonify({
                        'text': ch.get('text', ''),
                        'chapter': idx,
                        'title': ch.get('title', f'Chapter {idx+1}'),
                        'total_chapters': total
                    })
                except ValueError:
                    pass
            # Return chapter list
            sections = [{'start': i, 'title': c.get('title', f'Chapter {i+1}'), 'level': 1} for i, c in enumerate(chapters_data)]
            return jsonify({'chapters': sections, 'total_pages': total})
        elif pdf_matches:
            pdf_path = pdf_matches[0]
        else:
            text, title = shared.get_book_chapter_text(book_id, 0)
            if not text:
                return jsonify({'error': 'book not found'}), 404
            if chapter_idx is not None:
                if chapter_idx != '0':
                    return jsonify({'error': 'chapter out of range'}), 404
                return jsonify({'text': text, 'chapter': 0, 'title': title, 'total_chapters': 1})
            return jsonify({'chapters': [{'start': 0, 'title': title, 'level': 1}], 'total_pages': 1})
    else:
        return jsonify({'error': 'need book or file param'}), 400

    if not pdf_path.exists():
        return jsonify({'error': 'not found'}), 404

    try:
        # Chapters come from the PDF's built-in TOC (levels 1-2), cached per book
        key = book_id or pdf_path.stem
        sections = shared.pdf_sections(key, pdf_path)
        if not sections:
            return jsonify({'error': 'no chapters found'}), 500

        if chapter_idx is not None:
            try:
                idx = int(chapter_idx)
                if idx < 0 or idx >= len(sections):
                    return jsonify({'error': 'chapter out of range'}), 404
                text, title = shared.pdf_chapter_text(key, pdf_path, idx)
                return jsonify({
                    'text': text,
                    'chapter': idx,
                    'title': title,
                    'total_chapters': len(sections)
                })
            except ValueError:
                pass

        return jsonify({'chapters': sections, 'total_pages': sum(s['end'] - s['start'] + 1 for s in sections)})

    except Exception:
        app.logger.exception('[BOOKS] could not read PDF %s', pdf_path)
        return jsonify({'error': 'Could not read this PDF'}), 500

# ─── API: Book Settings ───────────────────────────────────────
@bp.route('/api/book/<book_id>/settings', methods=['GET', 'POST'])
def book_settings(book_id):
    settings_file = AUDIO_DIR / f'{book_id}_settings.json'
    if request.method == 'GET':
        if settings_file.exists():
            return jsonify(json.loads(settings_file.read_text()))
        return jsonify({'voice': 'kathleen-low'})

    # POST - update settings
    data = request.json or {}
    settings = {}
    if settings_file.exists():
        settings = json.loads(settings_file.read_text())
    if 'voice' in data and data['voice'] in VOICES:
        settings['voice'] = data['voice']
    if type(data.get('font_size')) is int and -2 <= data['font_size'] <= 2:
        settings['font_size'] = data['font_size']
    settings_file.write_text(json.dumps(settings, indent=2))
    return jsonify(settings)

# ─── API: Reading position sync (cross-device resume) ──────────
# The PWA saves playback/bookmark position in localStorage per device.
# These endpoints mirror that state on the server so a phone and a
# laptop resume from the same spot. The newest write wins (by epoch).
def _position_file(book_id):
    return AUDIO_DIR / f'{book_id}_position.json'

@bp.route('/api/book/<book_id>/position', methods=['GET', 'POST'])
def book_position(book_id):
    import time as _time
    pos_file = _position_file(book_id)
    if request.method == 'GET':
        if pos_file.exists():
            try:
                return jsonify(json.loads(pos_file.read_text()))
            except Exception:
                pass
        return jsonify({})

    # POST — validate and merge, newest fields win
    data = request.get_json(silent=True) or {}
    current = {}
    if pos_file.exists():
        try:
            current = json.loads(pos_file.read_text())
        except Exception:
            current = {}

    now = _time.time()
    updated = False
    opened = data.get('opened') is True
    if opened:
        current['last_opened'] = now

    def _merge_section(key, allowed_keys):
        nonlocal updated
        incoming = data.get(key)
        if not isinstance(incoming, dict):
            return
        section = dict(current.get(key) or {})
        for k in allowed_keys:
            if k not in incoming:
                continue
            v = incoming[k]
            # Strict types: indices are ints, positions/times are numbers
            if k in ('chapter', 'word_index') and not isinstance(v, int):
                continue
            if k in ('time', 'scroll') and not isinstance(v, (int, float)):
                continue
            if v != section.get(k):
                section[k] = v
                section['updated'] = now
                updated = True
        if section:
            current[key] = section
            updated = True

    _merge_section('audio', ('chapter', 'time'))
    _merge_section('reader', ('chapter', 'word_index', 'scroll'))
    if isinstance(data.get('mode'), str) and data['mode'] in ('audio', 'reader'):
        if current.get('mode') != data['mode']:
            current['mode'] = data['mode']
            updated = True

    if updated or opened:
        if updated:
            current['updated'] = now
        try:
            pos_file.write_text(json.dumps(current, indent=2))
        except OSError:
            app.logger.exception('[BOOKS] could not save position for %s', book_id)
            return jsonify({'error': 'could not save position'}), 500
    return jsonify(current)

# ─── API: Book Chapter Status ────────────────────────────────
@bp.route('/api/book/<book_id>/chapters')
def book_chapters(book_id):
    """Return per-chapter status for a book."""
    chapters = []
    for i in range(200):
        chapter_file = AUDIO_DIR / f'{book_id}_chapter_{i}.mp3'
        if chapter_file.exists():
            chapters.append({'index': i, 'status': 'done', 'size_kb': chapter_file.stat().st_size // 1024})
        else:
            chapters.append({'index': i, 'status': 'pending'})
    return jsonify(chapters)

# ─── API: Audio files ────────────────────────────────────────
@bp.route('/api/audio/<book_id>')
def audio_status(book_id):
    audio_path = AUDIO_DIR / f'{book_id}.json'
    if audio_path.exists():
        with open(audio_path) as f:
            return jsonify(json.load(f))
    return jsonify({'has_audio': False})

@bp.route('/api/audio/<book_id>/stream/<int:chapter_idx>')
def audio_stream(book_id, chapter_idx):
    audio_file = AUDIO_DIR / f'{book_id}_chapter_{chapter_idx}.mp3'
    if audio_file.exists():
        return send_file(str(audio_file), mimetype='audio/mpeg')
    return jsonify({'error': f'chapter {chapter_idx} not found'}), 404

@bp.route('/api/audio/<book_id>/cover')
def audio_cover(book_id):
    cover_file = _ensure_book_cover(book_id)
    if cover_file and cover_file.exists():
        return send_file(str(cover_file), mimetype='image/png')
    return '', 404

def _ensure_book_cover(book_id):
    """Use a PDF's illustrated first page, or generate a hardcover image.

    The new fallback has its own cache name so older generated covers are not
    overwritten. No author is invented when the source lacks metadata.
    """
    import hashlib
    title, author = book_id.replace('_', ' ').replace('-', ' '), ''
    if title.islower():
        title = title.title()
    pdf_matches = [f for f in shared.BOOKS_DIR.rglob('*.pdf') if f.stem == book_id]
    if pdf_matches:
        try:
            import fitz
            with fitz.open(str(pdf_matches[0])) as doc:
                metadata = doc.metadata or {}
                pdf_title = str(metadata.get('title') or '').strip()
                if (pdf_title and not pdf_title.lower().startswith(('microsoft word', 'untitled'))
                        and not pdf_title.lower().endswith(('.doc', '.docx'))):
                    title = pdf_title[:200]
                author = str(metadata.get('author') or '').strip()[:160]
                if author.lower() in ('owner', 'user', 'unknown', 'admin', 'administrator'):
                    author = ''
                page = doc[0] if len(doc) else None
                # A small publisher logo is not cover artwork. Only use an
                # image when it occupies a substantial part of the page.
                has_artwork = bool(page and any(
                    (fitz.Rect(image['bbox']) & page.rect).get_area() >= page.rect.get_area() * 0.3
                    for image in page.get_image_info() if image.get('bbox')
                ))
                if has_artwork:
                    cover_file = AUDIO_DIR / f'{book_id}_cover.png'
                    if not cover_file.exists():
                        # cap the render at ~1200 px wide: a hostile PDF can declare a huge page
                        scale = max(0.1, min(2.0, 1200 / max(1.0, page.rect.width)))
                        page.get_pixmap(matrix=fitz.Matrix(scale, scale)).save(str(cover_file))
                    return cover_file
        except Exception:
            pass
    cover_file = AUDIO_DIR / f'{book_id}_hardcover_v2.png'
    if cover_file.exists():
        return cover_file
    try:
        from PIL import Image, ImageDraw, ImageFont
        h = int(hashlib.md5(book_id.encode()).hexdigest(), 16)
        palettes = [(55, 48, 43), (40, 55, 50), (53, 46, 61), (67, 42, 40), (39, 49, 65)]
        size = (400, 600)
        img = Image.new('RGB', size, palettes[h % len(palettes)])
        draw = ImageDraw.Draw(img)
        draw.rectangle((0, 0, 20, 599), fill=(25, 25, 28))
        gold = (203, 184, 140)
        draw.rectangle((29, 22, 380, 577), outline=gold, width=2)
        draw.rectangle((36, 29, 373, 570), outline=gold, width=1)

        def font_at(size):
            candidates = ['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
                          '/System/Library/Fonts/Supplemental/Georgia.ttf',
                          'C:/Windows/Fonts/georgia.ttf']
            for candidate in candidates:
                try:
                    return ImageFont.truetype(candidate, size)
                except OSError:
                    continue
            try:
                return ImageFont.load_default(size=size)
            except TypeError:
                return ImageFont.load_default()

        def wrap(text, font, max_width):
            lines, line = [], ''
            for word in text.split():
                candidate = (line + ' ' + word).strip()
                if draw.textlength(candidate, font=font) <= max_width:
                    line = candidate
                    continue
                if line:
                    lines.append(line)
                line = ''
                for char in word:
                    if line and draw.textlength(line + char, font=font) > max_width:
                        lines.append(line)
                        line = ''
                    line += char
            if line:
                lines.append(line)
            return lines

        for font_size in range(30, 12, -2):
            font = font_at(font_size)
            lines = wrap(title, font, 295)
            if len(lines) * (font_size + 10) <= 230:
                break
        author_font = font_at(18)
        author_lines = wrap(author, author_font, 285) if author else []
        spacing = font_size + 10
        total_height = len(lines) * spacing + (28 + len(author_lines) * 25 if author_lines else 0)
        y = max(65, (size[1] - total_height) // 2)
        for line in lines:
            width = draw.textlength(line, font=font)
            draw.text(((410 - width) / 2, y), line, fill=(240, 226, 192), font=font)
            y += spacing
        if author_lines:
            y += 28
            for line in author_lines:
                width = draw.textlength(line, font=author_font)
                draw.text(((410 - width) / 2, y), line, fill=gold, font=author_font)
                y += 25
        img.save(str(cover_file))
        return cover_file
    except Exception:
        return None

# ─── API: TTS Generation ─────────────────────────────────────
@bp.route('/api/tts/status/<book_id>')
def tts_status(book_id):
    lock_file = AUDIO_DIR / f'{book_id}.tts_lock'
    json_file = AUDIO_DIR / f'{book_id}.json'
    if lock_file.exists():
        progress_str = lock_file.read_text().strip()
        if progress_str == '-1':  # worker crashed or was stopped
            return jsonify({'status': 'error', 'error': 'Audio generation failed or was stopped'})
        progress = max(0, min(99, int(progress_str))) if progress_str.isdigit() else 0
        eta_seconds = None
        import time
        try:
            started = float((AUDIO_DIR / f'{book_id}.tts_started').read_text())
            elapsed = time.time() - started
            if 0 < progress < 100 and elapsed > 0:
                eta_seconds = max(0, round(elapsed * (100 - progress) / progress))
        except (OSError, ValueError):
            pass
        return jsonify({'status': 'converting', 'progress': progress, 'eta_seconds': eta_seconds})
    if json_file.exists():
        try:
            metadata = json.loads(json_file.read_text())
            chapters = metadata.get('chapters') or []
            audio_present = all(
                isinstance(chapter, dict) and type(chapter.get('index', idx)) is int
                and 0 <= chapter.get('index', idx) < 10000
                and (AUDIO_DIR / f"{book_id}_chapter_{chapter.get('index', idx)}.mp3").is_file()
                for idx, chapter in enumerate(chapters)
            )
            if metadata.get('has_audio') and chapters and audio_present:
                return jsonify({'status': 'ready', 'progress': 100, 'eta_seconds': 0})
        except (OSError, ValueError, AttributeError):
            return jsonify({'status': 'error', 'error': 'Could not read audiobook data'})
    return jsonify({'status': 'not_started', 'progress': 0, 'eta_seconds': None})

@bp.route('/api/tts/start/<book_id>', methods=['POST'])
def tts_start(book_id):
    """Start TTS generation with the book's configured voice."""
    # Match the reader's JSON, PDF, then TXT source preference exactly.
    sources = shared.find_book_source(book_id)
    source_path = sources.get('.json') or sources.get('.pdf') or sources.get('.txt')
    if not source_path:
        return jsonify({'error': 'Book source not found'}), 404
    worker_script = BASE_DIR / 'tts_worker_json.py'

    # Load book settings for voice
    settings_file = AUDIO_DIR / f'{book_id}_settings.json'
    voice_id = 'kathleen-low'
    if settings_file.exists():
        voice_id = json.loads(settings_file.read_text()).get('voice', 'kathleen-low')

    # Launch TTS conversion in background. sys.executable works on
    # Linux, macOS, and Windows alike (python3 does not exist on Windows).
    lock_file = AUDIO_DIR / f'{book_id}.tts_lock'
    # A lock without '-1' means a worker is still running (crashes and Stop
    # both leave '-1'), so don't start a second one on the same files.
    if lock_file.exists() and lock_file.read_text().strip() != '-1':
        return jsonify({'error': 'Audio is already being generated for this book'}), 409
    lock_file.write_text('0')
    import time
    (AUDIO_DIR / f'{book_id}.tts_started').write_text(str(time.time()))
    import sys as _sys
    try:
        subprocess.Popen(
            [_sys.executable, str(worker_script), str(source_path), str(AUDIO_DIR), book_id, voice_id],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    except OSError:
        lock_file.write_text('-1')
        return jsonify({'error': 'Could not start audio generation'}), 500
    return jsonify({'status': 'started', 'voice': voice_id})

@bp.route('/api/tts/stop/<book_id>', methods=['POST'])
def tts_stop(book_id):
    """Stop ongoing TTS generation."""
    lock_file = AUDIO_DIR / f'{book_id}.tts_lock'
    if lock_file.exists():
        # Write -1 to signal error stop
        lock_file.write_text('-1')
    # Kill any running tts_worker processes for this book.
    # pkill is POSIX-only — Windows relies on the lock file (the worker
    # checks it between chapters), which is written just above.
    import platform as _platform
    if _platform.system() != 'Windows':
        # Escape the book id so it can't act as a regex that matches other
        # processes (e.g. a book id containing '.' or '*').
        subprocess.run(['pkill', '-f', 'tts_worker.*' + re.escape(book_id)], capture_output=True, timeout=10)
    return jsonify({'status': 'stopped'})

# ─── API: Summarize & Q&A (uses local LLM) ────────────────────
@bp.route('/api/summarize', methods=['POST'])
def summarize():
    """Summarize what the user has read so far.
    Body: {book_id, chapter_idx, word_index, mode: 'chapter'|'sofar'}
    Returns: {chapter_summary, sofar_summary}
    """
    data = request.json or {}
    book_id = data.get('book_id', '')
    try:
        chapter_idx = int(data.get('chapter_idx', 0) or 0)
    except (TypeError, ValueError):
        chapter_idx = 0
    word_index = data.get('word_index')  # position in current chapter
    mode = data.get('mode', 'both')  # 'chapter', 'sofar', or 'both'

    if not book_id:
        return jsonify({'error': 'book_id required'}), 400

    # Get current chapter text up to position
    current_text, current_title = get_book_chapter_text(book_id, chapter_idx)
    if not current_text:
        return jsonify({'error': 'could not load chapter text'}), 500

    chapter_portion = get_text_up_to_position(current_text, word_index)

    result = {}

    # Chapter summary: summarize just the portion read in this chapter
    if mode in ('chapter', 'both'):
        if len(chapter_portion) > 200:
            msg = llm_chat([
                {'role': 'system', 'content': 'Summarize the passage in 1-2 short sentences. Plain language. No em dashes.'},
                {'role': 'user', 'content': f'"{current_title}"\n\n{chapter_portion[:4000]}'}
            ], timeout=30)
            if msg.startswith('[LLM error'):
                return _llm_failed(msg)
            result['chapter_summary'] = msg
        else:
            result['chapter_summary'] = 'Not enough text read yet. Keep reading!'

    # So-far summary: summarize across all chapters read
    if mode in ('sofar', 'both'):
        # Gather text from all previous chapters + current portion
        # chapter_idx is in range here (current_text loaded); stop once the
        # 6000-char prompt budget below is full instead of reading every chapter.
        all_text_parts = []
        for i in range(chapter_idx):
            if sum(len(p) for p in all_text_parts) >= 6000:
                break
            ch_text, ch_title = get_book_chapter_text(book_id, i)
            if ch_text:
                all_text_parts.append(f'[{ch_title}]: {ch_text[:2000]}')
        all_text_parts.append(f'[{current_title} (so far)]: {chapter_portion[:2000]}')
        combined = '\n\n'.join(all_text_parts)

        if len(combined) > 200:
            msg = llm_chat([
                {'role': 'system', 'content': 'Summarize everything the reader has covered in one short paragraph. Main themes and how ideas connect. Plain language. No em dashes.'},
                {'role': 'user', 'content': f'Book: "{book_id.replace("_", " ")}"\n\n{combined[:6000]}'}
            ], timeout=60)
            if msg.startswith('[LLM error'):
                return _llm_failed(msg)
            result['sofar_summary'] = msg
        else:
            result['sofar_summary'] = 'Not enough text read yet. Keep reading!'

    result['chapter_title'] = current_title
    result['chapter_idx'] = chapter_idx
    return jsonify(result)

@bp.route('/api/ask', methods=['POST'])
def ask_question():
    """Ask a follow-up question about the text read so far.
    Body: {book_id, chapter_idx, word_index, question, context_summaries}
    """
    data = request.json or {}
    book_id = data.get('book_id', '')
    try:
        chapter_idx = int(data.get('chapter_idx', 0) or 0)
    except (TypeError, ValueError):
        chapter_idx = 0
    word_index = data.get('word_index')
    question = data.get('question', '')
    context_summaries = data.get('context_summaries', {})

    if not question:
        return jsonify({'error': 'question required'}), 400

    # Build context from summaries + current chapter text
    context_parts = []
    if context_summaries.get('sofar_summary'):
        context_parts.append(f'Summary of all chapters read so far:\n{context_summaries["sofar_summary"]}')
    if context_summaries.get('chapter_summary'):
        context_parts.append(f'Summary of current chapter so far:\n{context_summaries["chapter_summary"]}')

    # Also include the actual text portion for reference
    current_text, current_title = get_book_chapter_text(book_id, chapter_idx)
    chapter_portion = get_text_up_to_position(current_text, word_index)
    if chapter_portion:
        context_parts.append(f'Current chapter text read so far:\n{chapter_portion[:6000]}')

    full_context = '\n\n'.join(context_parts)

    answer = llm_chat([
        {'role': 'system', 'content': 'You are a friendly study companion helping the user understand a book they are reading. Answer their question based on the context provided. Be concise, clear, and conversational. If the answer is not in the context, say so. Do not use em dashes.'},
        {'role': 'user', 'content': f'Context:\n{full_context}\n\nQuestion: {question}'}
    ])
    if answer.startswith('[LLM error'):
        return _llm_failed(answer)

    return jsonify({'answer': answer})
