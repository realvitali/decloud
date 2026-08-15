// ===== Module: media-session =====
// Media Session API integration — feeds iOS lock screen / Dynamic Island / Android notification
// with title, artist, artwork, progress bar, and play/pause/seek controls

var mediaSessionActive = false;

function initMediaSession() {
  if (!('mediaSession' in navigator)) return;

  // Action handlers — these let the lock screen control playback
  navigator.mediaSession.setActionHandler('play', function() {
    if (player && !player.paused) return; // already playing
    if (typeof togglePlay === 'function') togglePlay();
    else if (typeof togglePlayMusic === 'function') togglePlayMusic();
  });

  navigator.mediaSession.setActionHandler('pause', function() {
    if (player && player.paused) return;
    if (typeof togglePlay === 'function') togglePlay();
    else if (typeof togglePlayMusic === 'function') togglePlayMusic();
  });

  navigator.mediaSession.setActionHandler('seekbackward', function(details) {
    var audio = getActiveAudio();
    if (audio) {
      var skip = details.seekOffset || 15;
      audio.currentTime = Math.max(0, audio.currentTime - skip);
    }
  });

  navigator.mediaSession.setActionHandler('seekforward', function(details) {
    var audio = getActiveAudio();
    if (audio) {
      var skip = details.seekOffset || 15;
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + skip);
    }
  });

  navigator.mediaSession.setActionHandler('seekto', function(details) {
    var audio = getActiveAudio();
    if (audio && details.seekTime != null) {
      audio.currentTime = details.seekTime;
    }
  });

  navigator.mediaSession.setActionHandler('previoustrack', function() {
    if (typeof prevChapter === 'function') prevChapter();
    else if (typeof prevSong === 'function') prevSong();
  });

  navigator.mediaSession.setActionHandler('nexttrack', function() {
    if (typeof nextChapter === 'function') nextChapter();
    else if (typeof nextSong === 'function') nextSong();
  });

  mediaSessionActive = true;
}

function getActiveAudio() {
  // Prefer whichever is currently playing
  if (player && !player.paused && player.src) return player;
  if (musicAudio && !musicAudio.paused && musicAudio.src) return musicAudio;
  // Fallback to whichever has a src
  if (player && player.src) return player;
  if (musicAudio && musicAudio.src) return musicAudio;
  return null;
}

// Called by audiobook player when a chapter starts playing
function updateMediaSessionBook(bookTitle, chapterTitle, coverUrl) {
  if (!mediaSessionActive) return;

  var artwork = [];
  if (coverUrl) {
    artwork = [
      { src: coverUrl, sizes: '256x256', type: 'image/png' },
      { src: coverUrl, sizes: '512x512', type: 'image/png' }
    ];
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: chapterTitle || 'Unknown Chapter',
    artist: bookTitle || 'Audiobook',
    album: 'DeCloud Audiobooks',
    artwork: artwork
  });

  updateMediaSessionPosition();
}

// Called by music player when a song starts playing
function updateMediaSessionMusic(songName, artistName, coverUrl) {
  if (!mediaSessionActive) return;

  var artwork = [];
  if (coverUrl) {
    artwork = [
      { src: coverUrl, sizes: '256x256', type: 'image/png' },
      { src: coverUrl, sizes: '512x512', type: 'image/png' }
    ];
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: songName || 'Unknown Track',
    artist: artistName || 'DeCloud Music',
    album: 'DeCloud Music',
    artwork: artwork
  });

  updateMediaSessionPosition();
}

// Update the position state (progress bar on lock screen)
function updateMediaSessionPosition() {
  if (!mediaSessionActive) return;
  if (!('setPositionState' in navigator.mediaSession)) return;

  var audio = getActiveAudio();
  if (!audio || !audio.duration || isNaN(audio.duration)) return;

  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration)
    });
  } catch (e) {
    // Some browsers throw if duration is not finite
  }
}

// Set the playback state
function setMediaSessionPlaying(playing) {
  if (!mediaSessionActive) return;
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  if (playing) updateMediaSessionPosition();
}

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMediaSession);
} else {
  initMediaSession();
}
