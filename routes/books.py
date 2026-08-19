"""Books library, audio, TTS, summarize, and Q&A routes."""
from flask import Blueprint, jsonify, request, send_file
import json, subprocess
from shared import (
    app, BASE_DIR, BOOKS_DIR, AUDIO_DIR, VOICES,
    _pdf_text_cache, _pdf_chapters_cache,
    LLM_MODEL, LLM_TIMEOUT, llm_chat,
    get_book_chapter_text, get_text_up_to_position,
    format_size,
)

bp = Blueprint('books', __name__)

@bp.route('/api/voices')
def list_voices():
    return jsonify(list(VOICES.values()))

# ─── API: Books Library ──────────────────────────────────────
@bp.route('/api/books')
def list_books():
    books = []
    if BOOKS_DIR.exists():
        # Collect both PDF and JSON source files
        # JSON sources first (preferred), then PDFs
        source_files = []
        for f in sorted(BOOKS_DIR.rglob('*.json')):
            source_files.append((f, 'json'))
        for f in sorted(BOOKS_DIR.rglob('*.pdf')):
            source_files.append((f, 'pdf'))
        for f in sorted(BOOKS_DIR.rglob('*.txt')):
            # Skip non-book txt files
            if f.stat().st_size > 3000:
                source_files.append((f, 'txt'))

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

            books.append({
                'id': book_id,
                'title': book_id.replace('_', ' '),
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

    if chapter_file:
        # Search subfolders for the file
        matches = list(BOOKS_DIR.rglob(chapter_file))
        pdf_path = matches[0] if matches else (BOOKS_DIR / chapter_file)
    elif book_id:
        # Check for JSON source first, then PDF (search subfolders)
        json_matches = list(BOOKS_DIR.rglob(f'{book_id}.json'))
        json_source = json_matches[0] if json_matches else (BOOKS_DIR / f'{book_id}.json')
        pdf_matches = list(BOOKS_DIR.rglob(f'{book_id}.pdf'))
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
            return jsonify({'error': 'book not found'}), 404
    else:
        return jsonify({'error': 'need book or file param'}), 400

    if not pdf_path.exists():
        return jsonify({'error': 'not found'}), 404

    try:
        import fitz

        # Build chapter list from PDF's built-in Table of Contents
        # Only level 1 (major sections) and level 2 (chapters) — skip sub-sections
        if book_id and book_id not in _pdf_chapters_cache:
            doc = fitz.open(pdf_path)
            toc = doc.get_toc()
            sections = []
            for entry in toc:
                level, title, page = entry[0], entry[1].strip(), entry[2]
                page_idx = page - 1
                if level <= 2 and title and page_idx >= 0:
                    sections.append({
                        'start': page_idx,
                        'title': title,
                        'level': level
                    })
            _pdf_chapters_cache[book_id] = sections
            _pdf_text_cache[book_id] = {}
            doc.close()

        sections = _pdf_chapters_cache.get(book_id, [])
        if not sections:
            return jsonify({'error': 'no chapters found'}), 500

        # Attach end page (start of next chapter) to each section
        for i, sec in enumerate(sections):
            if i + 1 < len(sections):
                sec['end'] = sections[i + 1]['start'] - 1
            else:
                doc = fitz.open(pdf_path)
                sec['end'] = len(doc) - 1
                doc.close()

        if chapter_idx is not None:
            try:
                idx = int(chapter_idx)
                if idx < 0 or idx >= len(sections):
                    return jsonify({'error': 'chapter out of range'}), 404

                # Serve from cache or extract fresh
                if book_id and idx in _pdf_text_cache.get(book_id, {}):
                    text = _pdf_text_cache[book_id][idx]
                else:
                    doc = fitz.open(pdf_path)
                    ch = sections[idx]
                    text = '\n'.join([doc[p].get_text() for p in range(ch['start'], ch['end'] + 1)])
                    doc.close()
                    if book_id:
                        _pdf_text_cache.setdefault(book_id, {})[idx] = text

                return jsonify({
                    'text': text,
                    'chapter': idx,
                    'title': sections[idx]['title'],
                    'total_chapters': len(sections)
                })
            except ValueError:
                pass

        return jsonify({'chapters': sections, 'total_pages': sum(s['end'] - s['start'] + 1 for s in sections)})

    except Exception as e:
        return jsonify({'error': str(e)}), 500

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
    settings_file.write_text(json.dumps(settings, indent=2))
    return jsonify(settings)

# ─── API: Book Chapter Status ────────────────────────────────
@bp.route('/api/book/<book_id>/chapters')
def book_chapters(book_id):
    """Return per-chapter status for a book."""
    chapters = []
    for i in range(30):
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
    cover_file = AUDIO_DIR / f'{book_id}_cover.png'
    if cover_file.exists():
        return send_file(str(cover_file), mimetype='image/png')
    # Auto-generate cover on the fly
    _ensure_book_cover(book_id)
    if cover_file.exists():
        return send_file(str(cover_file), mimetype='image/png')
    return '', 404

def _ensure_book_cover(book_id):
    """Auto-generate a cover image for a book if missing."""
    import hashlib
    cover_file = AUDIO_DIR / f'{book_id}_cover.png'
    if cover_file.exists():
        return
    # Try extracting first page from PDF
    pdf_matches = list(BOOKS_DIR.rglob(f'{book_id}.pdf'))
    if pdf_matches:
        try:
            import fitz
            doc = fitz.open(str(pdf_matches[0]))
            page = doc[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            pix.save(str(cover_file))
            doc.close()
            return
        except Exception:
            pass
    # Generate a colored placeholder
    try:
        from PIL import Image, ImageDraw, ImageFont
        h = int(hashlib.md5(book_id.encode()).hexdigest(), 16)
        r = max(40, min(200, (h >> 8) & 0xFF))
        g = max(40, min(200, (h >> 16) & 0xFF))
        b = max(40, min(200, (h >> 24) & 0xFF))
        size = (400, 600)
        img = Image.new('RGB', size, (r, g, b))
        draw = ImageDraw.Draw(img)
        overlay = Image.new('RGBA', size, (0, 0, 0, 0))
        draw_o = ImageDraw.Draw(overlay)
        for y in range(size[1] * 2 // 3, size[1]):
            alpha = int((y - size[1] * 2 // 3) / (size[1] // 3) * 160)
            draw_o.line([(0, y), (size[0], y)], fill=(0, 0, 0, alpha))
        img = Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB')
        draw = ImageDraw.Draw(img)
        title = book_id.replace('_', ' ')
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
        except Exception:
            font = ImageFont.load_default()
        words = title.split()
        lines = []
        line = ""
        for w in words:
            test = (line + " " + w).strip()
            bbox = draw.textbbox((0, 0), test, font=font)
            if bbox[2] - bbox[0] > size[0] - 40:
                if line:
                    lines.append(line)
                line = w
            else:
                line = test
        if line:
            lines.append(line)
        y = size[1] - 30 - len(lines) * 36
        for l in lines:
            bbox = draw.textbbox((0, 0), l, font=font)
            x = (size[0] - (bbox[2] - bbox[0])) // 2
            draw.text((x, y), l, fill=(255, 255, 255), font=font)
            y += 36
        img.save(str(cover_file))
    except Exception:
        pass

# ─── API: TTS Generation ─────────────────────────────────────
@bp.route('/api/tts/status/<book_id>')
def tts_status(book_id):
    lock_file = AUDIO_DIR / f'{book_id}.tts_lock'
    json_file = AUDIO_DIR / f'{book_id}.json'
    if lock_file.exists():
        progress_str = lock_file.read_text().strip()
        progress = int(progress_str) if progress_str.isdigit() else 0
        # Count completed chapters from metadata
        done_chapters = 0
        total_chapters = 0
        eta = None
        if json_file.exists():
            try:
                meta = json.loads(json_file.read_text())
                done_chapters = len(meta.get('chapters', []))
                total_chapters = meta.get('total_chapters', done_chapters)
                # If total_chapters equals done_chapters, the worker hasn't set the real total yet
                # Use the source JSON to get the real total
                if total_chapters <= done_chapters:
                    source_json_matches = list(BOOKS_DIR.rglob(f'{book_id}.json'))
                    source_json = source_json_matches[0] if source_json_matches else None
                    if source_json and source_json.exists():
                        src = json.loads(source_json.read_text())
                        total_chapters = len(src)
            except:
                pass
        # Estimate ETA from lock file mtime + progress
        import time
        if progress > 0 and done_chapters > 0:
            elapsed = time.time() - lock_file.stat().st_mtime + (done_chapters * 60)  # rough
            # Better: use file age
            lock_age = time.time() - lock_file.stat().st_ctime
            if lock_age > 5 and done_chapters > 0:
                per_chapter = lock_age / done_chapters
                remaining = total_chapters - done_chapters
                eta_seconds = per_chapter * remaining
                eta_mins = int(eta_seconds // 60)
                eta_secs = int(eta_seconds % 60)
                eta = f"{eta_mins}m {eta_secs}s" if eta_mins > 0 else f"{eta_secs}s"
        return jsonify({
            'status': 'converting',
            'progress': progress_str,
            'done_chapters': done_chapters,
            'total_chapters': total_chapters,
            'eta': eta
        })
    if json_file.exists():
        return jsonify({'status': 'ready'})
    return jsonify({'status': 'not_started'})

@bp.route('/api/tts/start/<book_id>', methods=['POST'])
def tts_start(book_id):
    """Start TTS generation with the book's configured voice."""
    # Check for JSON source first (search subfolders)
    json_matches = list(BOOKS_DIR.rglob(f'{book_id}.json'))
    pdf_matches = list(BOOKS_DIR.rglob(f'{book_id}.pdf'))
    json_source = json_matches[0] if json_matches else (BOOKS_DIR / f'{book_id}.json')
    pdf_path = pdf_matches[0] if pdf_matches else (BOOKS_DIR / f'{book_id}.pdf')

    if json_source.exists():
        source_path = json_source
        worker_script = BASE_DIR / 'tts_worker_json.py'
    elif pdf_path.exists():
        source_path = pdf_path
        worker_script = BASE_DIR / 'tts_worker.py'
    else:
        return jsonify({'error': 'Book source not found'}), 404

    # Load book settings for voice
    settings_file = AUDIO_DIR / f'{book_id}_settings.json'
    voice_id = 'kathleen-low'
    if settings_file.exists():
        voice_id = json.loads(settings_file.read_text()).get('voice', 'kathleen-low')

    # Launch TTS conversion in background. sys.executable works on
    # Linux, macOS, and Windows alike (python3 does not exist on Windows).
    lock_file = AUDIO_DIR / f'{book_id}.tts_lock'
    lock_file.write_text('0')
    import sys as _sys
    subprocess.Popen(
        [_sys.executable, str(worker_script), str(source_path), str(AUDIO_DIR), book_id, voice_id],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
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
        subprocess.run(['pkill', '-f', f'tts_worker.*{book_id}'], capture_output=True)
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
    chapter_idx = int(data.get('chapter_idx', 0))
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
            result['chapter_summary'] = msg
        else:
            result['chapter_summary'] = 'Not enough text read yet. Keep reading!'

    # So-far summary: summarize across all chapters read
    if mode in ('sofar', 'both'):
        # Gather text from all previous chapters + current portion
        all_text_parts = []
        for i in range(chapter_idx):
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
    chapter_idx = int(data.get('chapter_idx', 0))
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

    return jsonify({'answer': answer})

