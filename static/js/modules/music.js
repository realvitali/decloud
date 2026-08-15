// ===== Module: music =====
var musicPlaylist = [];
var musicCurrentIdx = 0;
var musicAudio = null;

async function loadMusic() {
  try {
    document.getElementById('music-list').innerHTML = Array(6).fill(
      '<div class="skeleton-music"><div style="flex:1"><div class="shimmer-block skeleton-title"></div><div class="shimmer-block skeleton-meta"></div></div></div>'
    ).join('');
    var r = await fetch('/api/music/list');
    musicPlaylist = await r.json();
    renderMusicList();
  } catch (e) {
    document.getElementById('music-list').innerHTML = '<div class="music-empty">Failed to load music</div>';
  }
}

function parseSongMeta(name) {
  var parts = name.split('_');
  if (parts.length > 1) {
    return { artist: parts[0], title: parts.slice(1).join(' ') };
  }
  return { artist: '', title: name };
}

function renderMusicList() {
  var el = document.getElementById('music-list');
  if (!el) return;
  if (!musicPlaylist.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <h3>No music yet</h3>
        <p>Add audio files to your music folder to get started.</p>
        <p class="empty-hint">Settings → Music folder to change the path</p>
      </div>`;
    return;
  }
  el.innerHTML = musicPlaylist.map(function(song, i) {
    var isPlaying = i === musicCurrentIdx;
    var meta = parseSongMeta(song.name);
    var cls = isPlaying ? ' playing' : '';
    var artUrl = '/api/music/artwork/' + encodeURIComponent(song.filename);
    return '<div class="music-song-row' + cls + '" data-idx="' + i + '" onclick="playMusic(' + i + ')">' +
      '<div class="music-song-thumb" data-art="' + artUrl + '">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>' +
      '</div>' +
      '<div class="music-song-info">' +
        '<div class="music-song-name">' + escapeHtml(meta.title) + '</div>' +
        (meta.artist ? '<div class="music-song-artist">' + escapeHtml(meta.artist) + '</div>' : '') +
      '</div>' +
      '<div class="music-song-more" onclick="event.stopPropagation(); showSongDetails(' + i + ')">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>' +
      '</div>' +
    '</div>';
  }).join('');
  // Lazily load artwork — each thumb gets its own image, cached by browser
  el.querySelectorAll('.music-song-thumb').forEach(function(thumb) {
    var url = thumb.dataset.art;
    if (!url) return;
    var img = new Image();
    img.onload = function() {
      if (img.naturalWidth > 1) {
        thumb.innerHTML = '<img src="' + url + '" class="music-thumb-img" alt="" />';
        thumb.classList.add('has-art');
      }
    };
    img.src = url;
  });
}

// Update only the playing state of existing rows (no full re-render)
function updateMusicPlayingState() {
  document.querySelectorAll('.music-song-row').forEach(function(row) {
    var idx = parseInt(row.dataset.idx);
    row.classList.toggle('playing', idx === musicCurrentIdx);
  });
}

function showSongDetails(idx) {
  var song = musicPlaylist[idx];
  if (!song) return;
  var meta = parseSongMeta(song.name);
  var modal = document.getElementById('song-details-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'song-details-modal';
    modal.className = 'modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.5);align-items:center;justify-content:center;padding:20px';
    document.body.appendChild(modal);
  }
  modal.innerHTML =
    '<div style="background:var(--glass);border:1px solid var(--glass-border);border-radius:16px;padding:20px;max-width:340px;width:100%;backdrop-filter:blur(20px)">' +
    '<div style="font-weight:700;font-size:1rem;margin-bottom:4px">' + escapeHtml(meta.title) + '</div>' +
    (meta.artist ? '<div style="color:var(--text-dim);font-size:0.85rem;margin-bottom:12px">' + escapeHtml(meta.artist) + '</div>' : '') +
    '<div style="font-size:0.78rem;color:var(--text-dim);line-height:1.6">' +
      '<div>Format: ' + song.ext.toUpperCase() + '</div>' +
      '<div>Size: ' + song.size_mb + ' MB</div>' +
      '<div>File: ' + escapeHtml(song.filename) + '</div>' +
    '</div>' +
    '<button onclick="document.getElementById(\'song-details-modal\').style.display=\'none\'" style="margin-top:16px;width:100%;padding:12px;border:1px solid var(--glass-border);border-radius:10px;background:var(--glass);color:var(--text);cursor:pointer;font-weight:600">Close</button>' +
    '</div>';
  modal.style.display = 'flex';
}

function playMusic(idx) {
  if (!musicPlaylist.length) return;
  musicCurrentIdx = idx;
  var song = musicPlaylist[idx];
  if (!musicAudio) musicAudio = document.getElementById('music-audio');
  musicAudio.src = '/api/music/stream/' + encodeURIComponent(song.filename);
  musicAudio.play();

  var meta = parseSongMeta(song.name);
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
