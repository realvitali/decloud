// ===== Module: media-session =====
// Media Session API integration - feeds iOS lock screen / Dynamic Island / Android notification
// with title, artist, artwork, progress bar, and play/pause/seek controls

var mediaSessionActive = false;

// Which player do the OS media controls (KDE systray, lock screen, headset keys) belong to?
// The one that is playing; if none is, the one that last published its metadata.
var mediaSessionLast = 'music';

function mediaTarget() {
  var bookOn = typeof player !== 'undefined' && player && player.src && !player.paused;
  var musicOn = typeof musicAudio !== 'undefined' && musicAudio && musicAudio.src && !musicAudio.paused;
  if (typeof mz !== 'undefined' && mz.remote) return 'music';          // mirroring another device: still control the music
  if (bookOn && !musicOn) return 'book';
  if (musicOn && !bookOn) return 'music';
  return mediaSessionLast;
}

function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  var ms = navigator.mediaSession;
  function on(action, fn) { try { ms.setActionHandler(action, fn); } catch (e) { /* action not supported by this browser */ } }

  on('play', function() {
    if (mediaTarget() === 'book') { if (typeof player !== 'undefined' && player && player.paused && typeof togglePlay === 'function') togglePlay(); }
    else if (typeof mzMediaPlay === 'function') mzMediaPlay();
  });

  on('pause', function() {
    if (mediaTarget() === 'book') { if (typeof player !== 'undefined' && player && !player.paused && typeof togglePlay === 'function') togglePlay(); }
    else if (typeof mzMediaPause === 'function') mzMediaPause();
  });

  on('stop', function() {
    if (mediaTarget() === 'book') { if (typeof player !== 'undefined' && player && !player.paused && typeof togglePlay === 'function') togglePlay(); }
    else if (typeof mzStop === 'function') mzStop();
  });

  on('seekbackward', function(details) {
    var skip = (details && details.seekOffset) || 15;
    if (mediaTarget() === 'music' && typeof mzMediaSeekBy === 'function') { mzMediaSeekBy(-skip); return; }
    var audio = getActiveAudio();
    if (audio) audio.currentTime = Math.max(0, audio.currentTime - skip);
  });

  on('seekforward', function(details) {
    var skip = (details && details.seekOffset) || 15;
    if (mediaTarget() === 'music' && typeof mzMediaSeekBy === 'function') { mzMediaSeekBy(skip); return; }
    var audio = getActiveAudio();
    if (audio) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + skip);
  });

  on('seekto', function(details) {
    if (!details || details.seekTime == null) return;
    if (mediaTarget() === 'music' && typeof mzMediaSeekTo === 'function') { mzMediaSeekTo(details.seekTime); return; }
    var audio = getActiveAudio();
    if (audio) audio.currentTime = details.seekTime;
  });

  on('previoustrack', function() {
    if (mediaTarget() === 'book') { if (typeof prevChapter === 'function') prevChapter(); }
    else if (typeof prevSong === 'function') prevSong();
  });

  on('nexttrack', function() {
    if (mediaTarget() === 'book') { if (typeof nextChapter === 'function') nextChapter(); }
    else if (typeof nextSong === 'function') nextSong();
  });

  mediaSessionActive = true;
}

function getActiveAudio() {
  var book = typeof player !== 'undefined' ? player : null;
  var music = typeof musicAudio !== 'undefined' ? musicAudio : null;
  // Prefer whichever is currently playing
  if (book && !book.paused && book.src) return book;
  if (music && !music.paused && music.src) return music;
  // Otherwise the one that last published its metadata
  var order = mediaSessionLast === 'book' ? [book, music] : [music, book];
  for (var i = 0; i < order.length; i++) if (order[i] && order[i].src) return order[i];
  return null;
}

// Called by audiobook player when a chapter starts playing
function updateMediaSessionBook(bookTitle, chapterTitle, coverUrl) {
  mediaSessionLast = 'book';
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
  mediaSessionLast = 'music';
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
