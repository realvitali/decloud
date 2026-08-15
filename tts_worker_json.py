#!/usr/bin/env python3
"""
JSON-based TTS worker for the DeCloud.
Reads chapter text from a JSON file instead of a PDF, generates audio with Piper TTS.
JSON format: [{"chapter": 1, "title": "...", "text": "..."}, ...]
"""
import sys, wave, subprocess, os, json, re
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
    lock_file.write_text('0')

    with open(json_path) as f:
        chapters = json.load(f)

    print(f"Loaded {len(chapters)} chapters from {json_path}")

    chapter_data = []
    total = len(chapters)

    for idx, chapter in enumerate(chapters):
        title = chapter.get('title', f'Chapter {idx+1}')
        text = chapter.get('text', '')

        if not text or len(text) < 200:
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
            chunk_file = audio_dir / f'{book_id}_ch{idx}_p{ci}.wav'
            print(f"  TTS chunk {ci+1}/{len(chunks)} ({len(chunk_text)} chars)...")
            try:
                tts_piper(chunk_text, str(chunk_file), voice_model)
                if chunk_file.exists() and chunk_file.stat().st_size > 1000:
                    chunk_files.append(str(chunk_file))
                    print(f"    OK: {chunk_file.stat().st_size // 1024}KB")
                else:
                    print(f"    FAILED: file too small")
            except Exception as e:
                print(f"    ERROR: {e}")

        # Combine into one MP3
        if chunk_files:
            combined = audio_dir / f'{book_id}_chapter_{idx}.mp3'
            if len(chunk_files) == 1:
                subprocess.run([
                    'ffmpeg', '-y', '-i', chunk_files[0],
                    '-codec:a', 'libmp3lame', '-qscale:a', '2', str(combined)
                ], capture_output=True)
                Path(chunk_files[0]).unlink()
            else:
                concat_file = audio_dir / f'{book_id}_ch{idx}_concat.txt'
                concat_file.write_text('\n'.join(f"file '{f}'" for f in chunk_files))
                result = subprocess.run([
                    'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
                    '-i', str(concat_file),
                    '-codec:a', 'libmp3lame', '-qscale:a', '2', str(combined)
                ], capture_output=True, text=True)
                if result.returncode == 0:
                    for f in chunk_files:
                        Path(f).unlink()
                    concat_file.unlink()
                    print(f"  Combined: {combined.stat().st_size // 1024}KB")
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

        # Update progress
        pct = int((idx + 1) / total * 100)
        lock_file.write_text(str(pct))
        print(f"  Progress: {pct}%")

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
    main()
