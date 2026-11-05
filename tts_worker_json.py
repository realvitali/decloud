#!/usr/bin/env python3
"""
Whole-book TTS worker for PDF, TXT, and chapter JSON sources.
"""
import sys, wave, subprocess, os, json
from pathlib import Path

_PIPER_DIR = os.environ.get('DECLOUD_PIPER_DIR', str(Path.home() / '.local' / 'share' / 'piper'))
VOICE_MAP = {
    'kathleen-low': os.path.join(_PIPER_DIR, 'en_US-kathleen-low.onnx'),
    'lessac-medium': os.path.join(_PIPER_DIR, 'en_US-lessac-medium.onnx'),
    'lessac-high': os.path.join(_PIPER_DIR, 'en_US-lessac-high.onnx'),
}

def tts_piper(text, output_path, voice_model):
    import piper
    voice = piper.PiperVoice.load(voice_model)
    with wave.open(output_path, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(voice.config.sample_rate)
        for audio_chunk in voice.synthesize(text):
            wav_file.writeframes(audio_chunk.audio_int16_bytes)


def load_book(source):
    """Read all book text, preserving the reader's section boundaries."""
    if source.suffix.lower() == '.txt':
        return [{'title': source.stem.replace('_', ' '), 'text': source.read_text(encoding='utf-8', errors='replace')}]
    if source.suffix.lower() == '.pdf':
        import fitz
        from book_sections import pdf_sections_from_document
        with fitz.open(str(source)) as doc:
            sections = pdf_sections_from_document(doc, source.stem.replace('_', ' '))
            chapters = [{'title': section['title'],
                         'text': '\n'.join(doc[p].get_text() for p in range(section['start'], section['end'] + 1))}
                        for section in sections]
            # Keep the reader's established section indexes while including
            # any readable front matter before its first TOC entry.
            if chapters and sections[0]['start'] > 0:
                opening = '\n'.join(doc[p].get_text() for p in range(sections[0]['start']))
                chapters[0]['text'] = opening + '\n' + chapters[0]['text']
            return chapters
    with open(source, encoding='utf-8') as f:
        chapters = json.load(f)
    if not isinstance(chapters, list) or not all(isinstance(c, dict) for c in chapters):
        raise ValueError('Invalid book source')
    return chapters

def main():
    if len(sys.argv) < 4:
        print("Usage: tts_worker_json.py <json_path> <audio_dir> <book_id> [voice_id]")
        sys.exit(1)

    json_path = Path(sys.argv[1])
    audio_dir = Path(sys.argv[2])
    book_id = sys.argv[3]
    voice_id = sys.argv[4] if len(sys.argv) > 4 else 'kathleen-low'
    audio_dir.mkdir(parents=True, exist_ok=True)

    voice_model = VOICE_MAP.get(voice_id, VOICE_MAP['kathleen-low'])
    print(f"Using voice: {voice_id}")

    lock_file = audio_dir / f'{book_id}.tts_lock'
    json_file = audio_dir / f'{book_id}.json'
    if lock_file.exists() and lock_file.read_text().strip() == '-1':
        return
    if not lock_file.exists():
        lock_file.write_text('0')

    chapters = load_book(json_path)

    print(f"Loaded {len(chapters)} chapters from {json_path}")

    chapter_data = []
    total = len(chapters)
    total_words = sum(len(str(chapter.get('text', '')).split()) for chapter in chapters)
    if not total_words:
        raise ValueError('Book has no readable text')
    words_done = 0

    for idx, chapter in enumerate(chapters):
        title = chapter.get('title', f'Chapter {idx+1}')
        text = chapter.get('text', '')

        if not text or not text.strip():
            print(f"  WARNING: Not enough text for chapter {idx+1}")
            continue

        print(f"\nChapter {idx+1}/{total}: {title} ({len(text)} chars)")

        # Split into ~2500 char chunks for Piper
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

        # TTS each chunk
        chunk_files = []
        for ci, chunk_text in enumerate(chunks):
            if lock_file.read_text().strip() == '-1':
                return
            chunk_file = audio_dir / f'{book_id}_ch{idx}_p{ci}.wav'
            print(f"  TTS chunk {ci+1}/{len(chunks)} ({len(chunk_text)} chars)...")
            try:
                tts_piper(chunk_text, str(chunk_file), voice_model)
                if chunk_file.exists() and chunk_file.stat().st_size > 1000:
                    chunk_files.append(str(chunk_file))
                    print(f"    OK: {chunk_file.stat().st_size // 1024}KB")
                else:
                    raise RuntimeError('Audio generation produced an empty file')
            except Exception as e:
                raise RuntimeError(f'Audio generation failed: {e}') from e
            if lock_file.read_text().strip() == '-1':
                return
            words_done += len(chunk_text.split())
            lock_file.write_text(str(min(99, int(words_done * 100 / total_words))))

        # Combine into one MP3
        if chunk_files:
            combined = audio_dir / f'{book_id}_chapter_{idx}.mp3'
            joined = None
            input_file = chunk_files[0]
            if len(chunk_files) > 1:
                # Combine PCM directly; filenames containing quotes or spaces
                # must not be interpreted as ffmpeg concat-file directives.
                joined = audio_dir / f'{book_id}_ch{idx}_combined.wav'
                with wave.open(str(joined), 'wb') as output:
                    params = None
                    for chunk_path in chunk_files:
                        with wave.open(chunk_path, 'rb') as chunk:
                            current = (chunk.getnchannels(), chunk.getsampwidth(), chunk.getframerate())
                            if params is None:
                                params = current
                                output.setnchannels(current[0])
                                output.setsampwidth(current[1])
                                output.setframerate(current[2])
                            elif current != params:
                                raise ValueError('Generated audio chunks have mismatched formats')
                            while True:
                                frames = chunk.readframes(65536)
                                if not frames:
                                    break
                                output.writeframes(frames)
                input_file = str(joined)
            subprocess.run([
                'ffmpeg', '-y', '-i', input_file,
                '-codec:a', 'libmp3lame', '-qscale:a', '2', str(combined)
            ], capture_output=True, timeout=600, check=True)
            for chunk_path in chunk_files:
                Path(chunk_path).unlink(missing_ok=True)
            if joined:
                joined.unlink(missing_ok=True)

            # Get duration
            if not combined.exists() or combined.stat().st_size == 0:
                raise RuntimeError('Audio conversion produced an empty file')
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
                'duration': round(duration, 1),
                'text': text,  # Full chapter text for word highlighting
                'file': combined.name,
            })

        # Write metadata incrementally after each chapter so the app can use audio as it's ready
        metadata = {
            'book_id': book_id,
            'has_audio': True,
            'voice': voice_id,
            'chapters': chapter_data,
            'total_chapters': total,  # total expected, not just completed
        }
        json_file.write_text(json.dumps(metadata, indent=2))

        if lock_file.read_text().strip() == '-1':
            return

    # Final metadata write
    metadata = {
        'book_id': book_id,
        'has_audio': True,
        'voice': voice_id,
        'chapters': chapter_data,
        'total_chapters': total,
    }
    json_file.write_text(json.dumps(metadata, indent=2))
    lock_file.unlink()
    print(f"\nDone! {len(chapter_data)} chapters, saved to {json_file}")

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Failure status: '-1' in the lock = error (read by tts_status /
        # list_books), so a crash never leaves the book "converting" forever.
        if len(sys.argv) >= 4:
            (Path(sys.argv[2]) / f'{sys.argv[3]}.tts_lock').write_text('-1')
        raise
