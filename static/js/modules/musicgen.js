// ===== Module: musicgen =====
// Music Generator — local MiniMax Music 3 via the user's ComfyUI.

let musicGenPromptId = null;
let musicGenPollTimer = null;

function loadMusicGen() {
  musicGenCheckStatus();
  musicGenLoadHistory();
}

async function musicGenCheckStatus() {
  const bar = document.getElementById('musicgen-status');
  try {
    const r = await fetch('/api/musicgen/status');
    const d = await r.json();
    if (!d.comfy_online) {
      bar.textContent = 'ComfyUI is offline — start it to generate songs.';
      bar.className = 'musicgen-status offline';
      return;
    }
    if (!d.workflow_configured) {
      bar.textContent = 'ComfyUI is online, but the music workflow is not configured yet.';
      bar.className = 'musicgen-status offline';
      document.getElementById('musicgen-setup-hint').style.display = '';
      return;
    }
    bar.textContent = `Ready — ${d.history_count} songs in your library.`;
    bar.className = 'musicgen-status online';
    document.getElementById('musicgen-setup-hint').style.display = 'none';
  } catch (e) {
    bar.textContent = 'Could not reach the server.';
    bar.className = 'musicgen-status offline';
  }
}

async function musicGenLoadHistory() {
  const el = document.getElementById('musicgen-history');
  try {
    const r = await fetch('/api/musicgen/history');
    const d = await r.json();
    const songs = d.songs || [];
    if (!songs.length) {
      el.innerHTML = '<div class="music-empty">No songs yet. Describe one above and hit Generate.</div>';
      return;
    }
    el.innerHTML = songs.map((s) => {
      const title = s.prompt || (s.lyrics ? s.lyrics.split('\n')[0] : 'Song');
      const dur = s.duration_sec ? ` · ${Math.floor(s.duration_sec / 60)}:${String(Math.round(s.duration_sec % 60)).padStart(2, '0')}` : '';
      const created = s.created ? new Date(s.created * 1000).toLocaleDateString() : '';
      return `
        <div class="musicgen-song" data-id="${s.id}">
          <div class="musicgen-song-head">
            <div class="musicgen-song-title" title="${escapeHtml(s.prompt || '')}">${escapeHtml(title)}</div>
            <div class="musicgen-song-meta">${escapeHtml(created)}${dur}${s.instrumental ? ' · instrumental' : ''}</div>
          </div>
          ${s.lyrics ? `<div class="musicgen-song-lyrics">${escapeHtml(s.lyrics).slice(0, 200)}${s.lyrics.length > 200 ? '…' : ''}</div>` : ''}
          <audio class="musicgen-player" controls preload="none" src="/api/musicgen/audio/${encodeURIComponent(s.id)}"></audio>
          <div class="musicgen-song-actions">
            <a class="settings-export-btn" href="/api/musicgen/audio/${encodeURIComponent(s.id)}" download>Download</a>
            <button class="settings-export-btn" onclick="musicGenDelete('${s.id}')">Delete</button>
            <button class="settings-export-btn" onclick="musicGenAgain('${s.id}')">Again</button>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="music-empty">Could not load your songs.</div>';
  }
}

async function musicGenGenerate() {
  const prompt = document.getElementById('musicgen-prompt').value.trim();
  const lyrics = document.getElementById('musicgen-lyrics').value.trim();
  const instrumentalSel = document.getElementById('musicgen-instrumental').value;
  const durationSel = document.getElementById('musicgen-duration').value;
  const progress = document.getElementById('musicgen-progress');
  const btn = document.getElementById('musicgen-generate-btn');

  if (!prompt && !lyrics) {
    alert('Describe the song, or write lyrics — or both.');
    return;
  }

  btn.disabled = true;
  progress.style.display = '';
  document.getElementById('musicgen-progress-text').textContent = 'Queuing…';
  document.getElementById('musicgen-progress-fill').style.width = '4%';

  try {
    const r = await fetch('/api/musicgen/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt,
        lyrics: lyrics,
        instrumental: instrumentalSel === 'true',
        duration: durationSel ? parseInt(durationSel) : null,
      })
    });
    const d = await r.json();
    if (!r.ok) {
      alert(d.error || 'Generation failed');
      progress.style.display = 'none';
      btn.disabled = false;
      return;
    }
    musicGenPromptId = d.prompt_id;
    musicGenPoll();
  } catch (e) {
    alert('Could not reach the server: ' + (e.message || 'network'));
    progress.style.display = 'none';
    btn.disabled = false;
  }
}

async function musicGenPoll() {
  if (!musicGenPromptId) return;
  try {
    const r = await fetch(`/api/musicgen/progress/${musicGenPromptId}`);
    const d = await r.json();
    if (r.status === 503) {
      document.getElementById('musicgen-progress-text').textContent = 'ComfyUI hiccup — retrying…';
    } else if (d.done) {
      clearInterval(musicGenPollTimer);
      musicGenPromptId = null;
      document.getElementById('musicgen-progress').style.display = 'none';
      document.getElementById('musicgen-generate-btn').disabled = false;
      if (d.error) {
        alert(d.error);
        return;
      }
      document.getElementById('musicgen-prompt').value = '';
      document.getElementById('musicgen-lyrics').value = '';
      musicGenLoadHistory();
      return;
    } else {
      const running = d.running || 0;
      const pending = d.pending || 0;
      document.getElementById('musicgen-progress-text').textContent =
        pending > 0 ? `In queue (${pending} ahead of you)…` : 'Generating… (this can take a few minutes)';
      const fill = document.getElementById('musicgen-progress-fill');
      const w = parseFloat(fill.style.width) || 4;
      if (w < 92) fill.style.width = Math.min(92, w + 1.5) + '%';
    }
  } catch (e) {
    document.getElementById('musicgen-progress-text').textContent = 'Connection lost — retrying…';
  }
  musicGenPollTimer = setTimeout(musicGenPoll, 4000);
}

async function musicGenDelete(id) {
  if (!confirm('Delete this song?')) return;
  try {
    await fetch(`/api/musicgen/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
    musicGenLoadHistory();
  } catch (e) {
    alert('Delete failed: ' + (e.message || 'network'));
  }
}

async function musicGenAgain(id) {
  try {
    const r = await fetch('/api/musicgen/history');
    const d = await r.json();
    const song = (d.songs || []).find((s) => s.id === id);
    if (song) {
      document.getElementById('musicgen-prompt').value = song.prompt || '';
      document.getElementById('musicgen-lyrics').value = song.lyrics || '';
      window.scrollTo(0, 0);
    }
  } catch (e) {}
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Expose for inline handlers
window.loadMusicGen = loadMusicGen;
window.musicGenGenerate = musicGenGenerate;
window.musicGenDelete = musicGenDelete;
window.musicGenAgain = musicGenAgain;
