// ===== Module: music =====
var musicPlaylist = [];
var musicCurrentIdx = 0;
var musicAudio = null;

// ── Song search + download (saved into the music folder on the host) ──
async function musicSearch() {
  var input = document.getElementById('music-search-input');
  var box = document.getElementById('music-search-results');
  if (!input || !box) return;
  var q = input.value.trim();
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="music-search-note">Searching…</div>';
  try {
    var r = await fetch('/api/music/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q }) });
    var results = await r.json();
    if (!r.ok || !Array.isArray(results)) throw new Error((results && results.error) || 'Search failed');
    if (!results.length) { box.innerHTML = '<div class="music-search-note">No results. Try different words.</div>'; return; }
    box.innerHTML = results.map(function(s) {
      return '<div class="music-result-row">' +
        '<div class="music-result-info"><b>' + escapeHtml(s.title) + '</b>' +
        '<span>' + escapeHtml(s.channel) + (s.duration ? ' · ' + musicFmtTime(s.duration) : '') + '</span></div>' +
        '<button class="lab-btn primary" data-id="' + escapeHtml(s.id) + '" data-onclick="cf5d0898" data-title="' + escapeHtml(s.title) + '">Download</button>' +
      '</div>';
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="music-search-note">' + escapeHtml(friendlyError(e)) + '</div>';
  }
}

// The search bar opens from the header's search button and closes with × or Escape
function toggleMusicSearch(open) {
  var bar = document.getElementById('music-search-bar'), input = document.getElementById('music-search-input');
  var btn = document.getElementById('music-search-toggle');
  if (!bar) return;
  bar.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) { input.focus(); return; }
  input.value = '';
  document.getElementById('music-search-results').innerHTML = '';
  if (btn) btn.focus();
}
document.addEventListener('keydown', function(e) {
  if (e.target && e.target.id === 'music-search-input' && e.key === 'Enter') { e.preventDefault(); musicSearch(); return; }
  if (e.target && e.target.id === 'music-search-input' && e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();   // close search, don't leave Music
    toggleMusicSearch(false);
  }
}, true);
document.addEventListener('search', function(e) {   // the input's built-in clear (x) empties the results too
  if (e.target && e.target.id === 'music-search-input' && !e.target.value) document.getElementById('music-search-results').innerHTML = '';
}, true);

function musicFmtTime(s) {
  var m = Math.floor(s / 60);
  return m + ':' + String(Math.round(s % 60)).padStart(2, '0');
}

async function musicDownload(id, btn) {
  var title = btn ? btn.dataset.title : id;
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  try {
    var r = await fetch('/api/music/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, title: title }) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not start the download');
    for (var i = 0; i < 600; i++) {
      await new Promise(function(res) { setTimeout(res, 2000); });
      var j = await (await fetch('/api/music/download/' + encodeURIComponent(d.job))).json();
      if (btn) btn.textContent = j.state === 'running' ? (j.pct ? (j.pct + '%') : 'Starting…') : (j.state === 'done' ? 'Saved ✓' : 'Failed');
      if (j.state !== 'running') {
        if (j.state === 'done') { showToast('Downloaded "' + title + '" to your music folder'); loadMusic(); }
        else showToast(j.message || 'Download failed');
        return;
      }
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Download'; }
    showToast(friendlyError(e));
  }
}

async function loadMusic() {
  try {
    document.getElementById('music-list').innerHTML = Array(6).fill(
      '<div class="skeleton-music skeleton-tile"><div class="shimmer-block skeleton-cover"></div><div class="shimmer-block skeleton-titlename"></div></div>'
    ).join('');
    var r = await fetch('/api/music/list');
    musicPlaylist = await r.json();
    renderMusicList();
  } catch (e) {
    document.getElementById('music-list').innerHTML = '<div class="music-empty">Failed to load music</div>';
  }
}

// Title and artist come from the server (your edits, the file's tags, or "Artist - Title")
function parseSongMeta(song) {
  return { title: song.title || song.name, artist: song.artist || '' };
}

function renderMusicList() {
  var el = document.getElementById('music-list');
  if (!el) return;
  if (!musicPlaylist.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${ICONS.music}</div>
        <h3>No music yet</h3>
        <p>Add audio files to your music folder, or search above to download songs straight onto this computer.</p>
        <p class="empty-hint">Settings → Music folder to change the path</p>
      </div>`;
    return;
  }
  el.innerHTML = musicPlaylist.map(function(song, i) {
    var isPlaying = i === musicCurrentIdx;
    var cls = isPlaying ? ' playing' : '';
    var meta = parseSongMeta(song);
    var artUrl = '/api/music/artwork/' + encodeURIComponent(song.filename);
    return '<div class="music-tile' + cls + '" data-idx="' + i + '" data-onclick="c70bba1d">' +
      '<div class="music-tile-cover">' +
        '<img src="' + artUrl + '" alt="" loading="lazy" data-onload="lea99a7f" data-onerror="ee677121">' +
        (isPlaying ? '<div class="music-tile-playing"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>' : '') +
        '<div class="music-tile-more" role="button" tabindex="0" aria-label="Edit song" title="Edit song" data-onclick="cc39d5bd">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>' +
        '</div>' +
      '</div>' +
      '<div class="music-tile-name">' + escapeHtml(meta.title) + '</div>' +
      (meta.artist ? '<div class="music-tile-artist">' + escapeHtml(meta.artist) + '</div>' : '') +
    '</div>';
  }).join('');
}

// Update only the playing state of existing tiles (no full re-render)
function updateMusicPlayingState() {
  document.querySelectorAll('.music-tile').forEach(function(tile) {
    var idx = parseInt(tile.dataset.idx);
    var wasPlaying = tile.classList.contains('playing');
    var nowPlaying = idx === musicCurrentIdx;
    tile.classList.toggle('playing', nowPlaying);
    if (nowPlaying !== wasPlaying) {
      var cover = tile.querySelector('.music-tile-cover');
      var badge = cover.querySelector('.music-tile-playing');
      if (nowPlaying && !badge) {
        cover.insertAdjacentHTML('beforeend', '<div class="music-tile-playing"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>');
      } else if (!nowPlaying && badge) {
        badge.remove();
      }
    }
  });
}

function showSongDetails(idx) {
  var song = musicPlaylist[idx];
  if (!song) return;
  var meta = parseSongMeta(song);
  var modal = document.getElementById('song-details-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'song-details-modal';
    modal.className = 'modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.5);align-items:center;justify-content:center;padding:20px';
    document.body.appendChild(modal);
  }
  modal.innerHTML =
    '<form class="song-edit" data-idx="' + idx + '">' +
      '<label for="song-edit-title">Song</label><input id="song-edit-title" maxlength="200" autocomplete="off" value="' + escapeHtml(meta.title) + '">' +
      '<label for="song-edit-artist">Artist</label><input id="song-edit-artist" maxlength="200" autocomplete="off" value="' + escapeHtml(meta.artist) + '">' +
      '<div class="song-edit-file">' + escapeHtml(song.ext.toUpperCase()) + ' · ' + song.size_mb + ' MB · ' + escapeHtml(song.filename) + '</div>' +
      '<div class="song-edit-actions">' +
        (song.edited ? '<button type="button" class="song-edit-reset" data-onclick="cb7a51e3">Use automatic</button>' : '') +
        '<button type="button" data-onclick="c6fe321a">Cancel</button>' +
        '<button type="submit" class="primary">Save</button>' +
      '</div>' +
    '</form>';
  modal.style.display = 'flex';
}

async function saveSongMeta(idx, reset) {
  var song = musicPlaylist[idx];
  if (!song) return;
  var body = reset ? { filename: song.filename, title: '', artist: '' }
    : { filename: song.filename, title: document.getElementById('song-edit-title').value, artist: document.getElementById('song-edit-artist').value };
  var r = await fetch('/api/music/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function() { return null; });
  var d = r ? await r.json().catch(function() { return {}; }) : {};
  if (!r || !r.ok) { showToast(d.error || 'Could not save.'); return; }
  song.title = d.title; song.artist = d.artist; song.edited = d.edited;
  document.getElementById('song-details-modal').style.display = 'none';
  renderMusicList();
  if (idx === musicCurrentIdx && document.getElementById('music-player').style.display !== 'none') {
    document.getElementById('music-player-title').textContent = d.title;
    var pa = document.getElementById('music-player-artist'); if (pa) pa.textContent = d.artist;
  }
}
document.addEventListener('submit', function(e) {
  var form = e.target.closest && e.target.closest('.song-edit');
  if (!form) return;
  e.preventDefault();
  saveSongMeta(+form.dataset.idx, false);
});

function playMusic(idx) {
  if (!musicPlaylist.length) return;
  musicCurrentIdx = idx;
  var song = musicPlaylist[idx];
  if (!musicAudio) musicAudio = document.getElementById('music-audio');
  musicAudio.src = '/api/music/stream/' + encodeURIComponent(song.filename);
  musicAudio.play();

  var meta = parseSongMeta(song);
  var artUrl = '/api/music/artwork/' + encodeURIComponent(song.filename);

  // Show player bar and fill it
  var player = document.getElementById('music-player');
  player.style.display = '';
  document.getElementById('music-player-title').textContent = meta.title;
  document.getElementById('music-player-artist').textContent = meta.artist || '';
  var artImg = document.getElementById('music-player-art');
  artImg.style.display = 'none';
  artImg.src = artUrl;
  artImg.onload = function() {
    if (artImg.naturalWidth > 1) artImg.style.display = '';
  };
  artImg.onerror = function() { artImg.style.display = 'none'; };

  // Media Session for lock screen
  if (typeof updateMediaSessionMusic === 'function') {
    updateMediaSessionMusic(meta.title, meta.artist || 'DeCloud Music', artUrl);
    setMediaSessionPlaying(true);
  }

  musicAudio.onloadedmetadata = function() {
    document.getElementById('music-duration').textContent = formatMusicTime(musicAudio.duration);
    if (typeof updateMediaSessionPosition === 'function') updateMediaSessionPosition();
    if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(true);
  };
  musicAudio.ontimeupdate = function() {
    if (!musicAudio.duration) return;
    var pct = (musicAudio.currentTime / musicAudio.duration) * 100;
    document.getElementById('music-progress-fill').style.width = pct + '%';
    document.getElementById('music-current').textContent = formatMusicTime(musicAudio.currentTime);
    if (typeof updateMediaSessionPosition === 'function') updateMediaSessionPosition();
  };
  musicAudio.onended = function() { nextSong(); };

  setMusicPlayIcon(true);
  updateMusicPlayingState();
}

function togglePlayMusic() {
  if (!musicAudio || !musicAudio.src) return;
  if (musicAudio.paused) {
    musicAudio.play();
    setMusicPlayIcon(true);
    if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(true);
  } else {
    musicAudio.pause();
    setMusicPlayIcon(false);
    if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(false);
  }
}

function setMusicPlayIcon(playing) {
  var icon = document.getElementById('music-play-icon');
  if (!icon) return;
  if (playing) {
    icon.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';
  } else {
    icon.innerHTML = '<polygon points="6 4 20 12 6 20 6 4"/>';
  }
}

function nextSong() {
  if (!musicPlaylist.length) return;
  playMusic((musicCurrentIdx + 1) % musicPlaylist.length);
}

function prevSong() {
  if (!musicPlaylist.length) return;
  playMusic((musicCurrentIdx - 1 + musicPlaylist.length) % musicPlaylist.length);
}

function seekMusic(e) {
  if (!musicAudio || !musicAudio.duration) return;
  var bar = document.getElementById('music-progress-bar');
  var rect = bar.getBoundingClientRect();
  var pct = (e.clientX - rect.left) / rect.width;
  musicAudio.currentTime = pct * musicAudio.duration;
}

function formatMusicTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' + s : s);
}
