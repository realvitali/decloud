#!/usr/bin/env python3
"""
Chapter-aware TTS worker for the DeCloud.
Uses PyMuPDF to get the real TOC, extracts clean text per chapter,
and generates audio with Piper TTS (kathleen-low voice).
"""
import sys
import wave
import subprocess

import os, json, re
from pathlib import Path
import fitz  # pymupdf

# ─── Voice selection ──────────────────────────────────────────
_PIPER_DIR = os.environ.get('DECLOUD_PIPER_DIR', str(Path.home() / '.local' / 'share' / 'piper'))
VOICE_MAP = {
    'kathleen-low': os.path.join(_PIPER_DIR, 'en_US-kathleen-low.onnx'),
    'lessac-medium': os.path.join(_PIPER_DIR, 'en_US-lessac-medium.onnx'),
    'lessac-high': os.path.join(_PIPER_DIR, 'en_US-lessac-high.onnx'),
}
PIPER_MODEL = VOICE_MAP.get('kathleen-low', VOICE_MAP['kathleen-low'])

# Pages to skip (front matter, copyright, etc.)
SKIP_PATTERNS = [
    r"downloaded from", r"http://", r"mit\.edu", r"guest on",
    r"© \d{4}", r"all rights reserved", r"no part of this book",
    r"library of congress", r"isbn", r"printed and bound",
    r"foreword", r"preface to the second edition",
    r"^xi*$", r"^xii*$", r"^xiii*$", r"^xiv*$", r"^xv*$",
    r"^xvi*$", r"^xvii*$", r"^xviii*$", r"^xix*$", r"^xx*$",
]


def clean_text(text: str) -> str:
    """Remove copyright headers/footers and watermark lines."""
    lines = text.split('\n')
    cleaned = []
    for line in lines:
        line = line.strip()
        # Skip watermark lines
        if re.search(r"downloaded from|http://|mit\.edu|guest on", line.lower()):
            continue
        if re.search(r"© \d{4}|all rights reserved|no part of this book", line):
            continue
        if re.search(r"isbn|library of congress|printed and bound", line.lower()):
            continue
        # Skip standalone page numbers like "xi" or "xii" etc
        if re.match(r'^[ivx]+$', line.lower()):
            continue
        if re.match(r'^\d{1,3}\s*$', line):
            continue
        # Skip very short lines that are just headers/footers
        if len(line) < 10:
            continue
        cleaned.append(line)
    return ' '.join(cleaned)


def is_page_empty(text: str) -> bool:
    """Return True if page has almost no real content (only watermarks/numbers)."""
    cleaned = clean_text(text)
    # If less than 100 chars of clean text, page is effectively empty
    return len(cleaned) < 100


def get_chapters(pdf_path):
    """Extract chapter boundaries from PDF TOC."""
    doc = fitz.open(str(pdf_path))
    toc = doc.get_toc()

    chapters = []
    for entry in toc:
        level, title, page_num = entry[0], entry[1], entry[2]
        # Chapters are at level 2 under "Part I" / "Part II" headings
        if level != 2:
            continue
        # Skip non-chapter entries
        skip_titles = ['contents', 'foreword', 'preface', 'wiener filtering', 'wiener and',
                       'wiener', 'note', 'preface']
        if any(title.lower().startswith(s) for s in skip_titles):
            continue
        if not title or len(title.strip()) < 3:
            continue
        # Skip pure page numbers
        if re.match(r'^\d+$', title.strip()):
            continue
        # Skip entries starting with "Chapter" (notes section, not actual chapters)
        if title.lower().startswith('chapter'):
            continue
        # Skip sub-section titles that aren't numbered chapters
        # Only accept: "Introduction", "I:", "II:", ... "X:"
        # Skip any "Introduction" that's not near the front (notes section has one too)
        if title == 'Introduction' and page_num > 200:
            continue
        if title != 'Introduction' and not re.match(r'^[IVX]+:', title):
            continue
        chapters.append({'title': title.strip(), 'pdf_page': page_num})

    # Deduplicate (sometimes same chapter appears twice)
    seen = set()
    unique = []
    for c in chapters:
        if c['title'] not in seen:
            seen.add(c['title'])
            unique.append(c)
    return unique


def extract_chapter_text(pdf_path, start_page, end_page):
    """Extract clean text from a page range."""
    doc = fitz.open(str(pdf_path))
    texts = []
    for i in range(start_page - 1, min(end_page - 1, len(doc))):
        page = doc[i]
        text = page.get_text()
        if not text or is_page_empty(text):
            continue
        cleaned = clean_text(text)
        if len(cleaned) > 50:
            texts.append(cleaned)
    return ' '.join(texts)


def tts_piper(text: str, output_path: str):
    """Convert text to WAV using Piper TTS."""
    import piper
    voice = piper.PiperVoice.load(PIPER_MODEL)
    with wave.open(output_path, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(voice.config.sample_rate)
        for audio_chunk in voice.synthesize(text):
            wav_file.writeframes(audio_chunk.audio_int16_bytes)


def main():
    if len(sys.argv) < 4:
        print("Usage: tts_worker.py <pdf_path> <audio_dir> <book_id> [voice_id]")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    audio_dir = Path(sys.argv[2])
    book_id = sys.argv[3]
    voice_id = sys.argv[4] if len(sys.argv) > 4 else 'kathleen-low'
    audio_dir.mkdir(parents=True, exist_ok=True)

    # Resolve voice model
    global PIPER_MODEL
    PIPER_MODEL = VOICE_MAP.get(voice_id, VOICE_MAP['kathleen-low'])
    print(f"Using voice: {voice_id} ({PIPER_MODEL})")
    lock_file = audio_dir / f'{book_id}.tts_lock'
    json_file = audio_dir / f'{book_id}.json'
    audio_dir.mkdir(parents=True, exist_ok=True)
    lock_file.write_text('0')

    print(f"Processing: {pdf_path.name}")

    # Get chapters from TOC
    chapters = get_chapters(pdf_path)
    print(f"Found {len(chapters)} chapters: {[c['title'] for c in chapters]}")

    if not chapters:
        lock_file.write_text('-1')
        print("ERROR: No chapters found in PDF")
        return

    chapter_data = []
    total = len(chapters)

    for idx, chapter in enumerate(chapters):
        title = chapter['title']
        start = chapter['pdf_page']

        # End is next chapter's start (or end of book)
        if idx + 1 < len(chapters):
            end = chapters[idx + 1]['pdf_page']
        else:
            end = start + 200  # fallback

        print(f"\nChapter {idx+1}/{total}: {title} (pages {start}-{end})")

        # Extract text
        text = extract_chapter_text(pdf_path, start, end)
        if not text or len(text) < 200:
            print(f"  WARNING: Not enough text for chapter {idx+1}")
            continue

        # Truncate to avoid memory issues with Piper (~3000 chars per call is safe)
        # Split into ~2500 char chunks
        chunks = []
        words = text.split()
        current = []
        current_len = 0
        for word in words:
            if current_len + len(word) > 2500 and current:
                chunks.append(' '.join(current))
                current = [word]
                current_len = len(word)
            else:
                current.append(word)
                current_len += len(word) + 1
        if current:
            chunks.append(' '.join(current))

        # TTS each sub-chunk and concatenate
        chunk_files = []
        for ci, chunk_text in enumerate(chunks):
            chunk_file = audio_dir / f'{book_id}_ch{idx}_p{ci}.wav'
            print(f"  TTS chunk {ci+1}/{len(chunks)} ({len(chunk_text)} chars)...")
            try:
                tts_piper(chunk_text, str(chunk_file))
                if chunk_file.exists() and chunk_file.stat().st_size > 1000:
                    chunk_files.append(str(chunk_file))
                    print(f"    OK: {chunk_file.stat().st_size // 1024}KB")
                else:
                    print(f"    FAILED: file too small")
            except Exception as e:
                print(f"    ERROR: {e}")

        # Combine all chunk WAVs into one chapter MP3
        if chunk_files:
            combined = audio_dir / f'{book_id}_chapter_{idx}.mp3'
            if len(chunk_files) == 1:
                # Convert single WAV to MP3
                subprocess.run([
                    'ffmpeg', '-y', '-i', chunk_files[0],
                    '-codec:a', 'libmp3lame', '-qscale:a', '2',
                    str(combined)
                ], capture_output=True)
                Path(chunk_files[0]).unlink()
            else:
                import subprocess
                # Use ffmpeg to concatenate WAVs then convert to MP3
                concat_file = audio_dir / f'{book_id}_ch{idx}_concat.txt'
                concat_file.write_text('\n'.join(f"file '{f}'" for f in chunk_files))
                result = subprocess.run([
                    'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
                    '-i', str(concat_file),
                    '-codec:a', 'libmp3lame', '-qscale:a', '2',
                    str(combined)
                ], capture_output=True, text=True)
                if result.returncode == 0:
                    # Clean up temp chunks
                    for f in chunk_files:
                        Path(f).unlink()
                    concat_file.unlink()
                    print(f"  Combined into: {combined.stat().st_size // 1024}KB")
                else:
                    print(f"  Combine failed: {result.stderr[:200]}")

            # Get duration
            duration = 0
            try:
                from mutagen.mp3 import MP3
                audio = MP3(str(combined))
                duration = audio.info.length
            except:
                pass

            chapter_data.append({
                'index': idx,
                'title': title,
                'start_page': start,
                'end_page': end - 1,
                'duration': round(duration, 1),
                'text': text[:1000],  # Store first 1000 chars for transcript
                'file': combined.name,
            })

        # Update progress
        pct = int((idx + 1) / total * 100)
        lock_file.write_text(str(pct))
        print(f"  Progress: {pct}%")

    # Write metadata
    metadata = {
        'book_id': book_id,
        'has_audio': True,
        'voice': voice_id,
        'chapters': chapter_data,
        'total_chapters': len(chapter_data),
    }
    json_file.write_text(json.dumps(metadata, indent=2))
    lock_file.unlink()

    # Clean up old garbage chunks
    for f in audio_dir.glob(f'{book_id}_chunk_*.mp3'):
        f.unlink()

    print(f"\nDone! {len(chapter_data)} chapters, saved to {json_file}")


if __name__ == '__main__':
    main()
