// ===== Module: music =====
// Glossy-black media player. Metadata, covers, stars and play counts come from
// Navidrome (via the server's Subsonic proxy); file tags are only a fallback.
// Views: Albums · Artists · Songs · Genres · Favorites · Recently added ·
// Most played · Playlists · Now Playing · Search - each is a #music/<view> route.
// Globals other modules rely on: musicAudio, musicPlaylist, musicCurrentIdx,
// loadMusic, playMusic, togglePlayMusic, nextSong, prevSong, mzApplyRoute.

var musicPlaylist = [];      // every track
var musicCurrentIdx = -1;    // library index of the current track
var musicAudio = null;

var mz = {
  loaded: false, source: '', error: '',
  byId: new Map(), artists: new Map(), albums: new Map(), genres: new Map(), playlists: [],
  view: { type: 'albums', key: '' }, sort: { col: '', dir: 1 }, ctx: [], sel: -1,
  query: '', prevView: null, searchTimer: null, plCache: {},
  queue: [], origQueue: null, qi: -1, shuffle: false, repeat: 'off',
  counted: false, seeking: false,
  ac: null, an: null, fdata: null, tdata: null, vizRaf: 0, peaks: [],
  prefs: { vol: 1, muted: false, haptics: true, coverOpen: false, viz: !/iPad|iPhone|iPod/.test(navigator.userAgent), sideW: { glossy: 232, spotify: 320 }, queueW: 290 },
  coarse: !!(window.matchMedia && matchMedia('(pointer: coarse)').matches),
};
try {
  var _mzp = JSON.parse(localStorage.getItem('mzPrefs2') || '{}');
  Object.keys(_mzp).forEach(function (k) { if (k in mz.prefs) mz.prefs[k] = _mzp[k]; });
  mz.prefs.viz = !/iPad|iPhone|iPod/.test(navigator.userAgent);   // never stay switched off because of one earlier failure
} catch (_) {}
try { mz.prefs.sideW = Object.assign({ glossy: 232, spotify: 320 }, mz.prefs.sideW || {}); } catch (_) {}
mz.theme = 'glossy';
try { var _mzt = localStorage.getItem('mzTheme'); if (_mzt === 'spotify' || _mzt === 'glossy') mz.theme = _mzt; } catch (_) {}
mz.mixCache = {};
function mzDefaultType() { return mz.theme === 'spotify' ? 'home' : 'albums'; }
(function () { var w = document.querySelector('#music-screen .wm'); if (w) w.dataset.mzt = mz.theme; })();
mz.view = { type: mzDefaultType(), key: '' };
function mzSavePrefs() { try { localStorage.setItem('mzPrefs2', JSON.stringify(mz.prefs)); } catch (_) {} }

// ─── helpers ─────────────────────────────────────────────
function mzEl(id) { return document.getElementById(id); }
function mzEnc(f) { return String(f).split('/').map(encodeURIComponent).join('/'); }
function mzHue(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
function mzFmt(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' + s : s);
}
function formatMusicTime(sec) { return mzFmt(sec); }
function mzPlural(n, w) { return n.toLocaleString() + ' ' + w + (n === 1 ? '' : 's'); }
function mzDur(sec) {
  var h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
  return h ? h + ' hr ' + m + ' min' : m + ' min';
}
function mzShuffled(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function mzCur() { return mz.qi >= 0 ? mz.queue[mz.qi] : null; }
// ─── haptics (vibration on Android / mobile browsers that support it) ──────
// A light tick for any tap on a touch screen, plus distinct patterns for the events that matter.
var MZ_HAPTIC = {
  tick: 8, tap: 12, select: 14, toggle: 18, play: 22, pause: 12, skip: 16, open: 20, close: 14, detent: 6,
  like: [12, 40, 18], unlike: 10, queue: [10, 30, 10], remote: [10, 25, 10], success: [14, 40, 24], warn: [30, 60, 30],
};
function mzCanVibrate() {
  return mz.prefs.haptics !== false && typeof navigator.vibrate === 'function' && (mz.coarse || /Android/i.test(navigator.userAgent));
}
function mzHaptic(kind) {
  if (!mzCanVibrate()) return;
  try { navigator.vibrate(MZ_HAPTIC[kind] || 10); } catch (_) { /* some browsers block it without a recent tap */ }
}
function mzToggleHaptics() {
  mz.prefs.haptics = mz.prefs.haptics === false; mzSavePrefs();
  if (mz.prefs.haptics) mzHaptic('success');
  mzToast(mz.prefs.haptics ? 'Vibration on' : 'Vibration off');
}
function mzScreenOpen() { var s = mzEl('music-screen'); return !!(s && s.classList.contains('active')); }
function mzCoverUrl(c, size) { return '/api/music/artwork/' + mzEnc(c) + (size ? '?size=' + size : ''); }
function mzArt(t, size, cls, id) {
  var letter = escapeHtml((t.al || t.t || '♪').charAt(0).toUpperCase());
  return '<div class="wm-art ' + (cls || '') + '"' + (id ? ' id="' + id + '"' : '') + ' style="--h:' + t.h + '">' + letter +
    (t.c ? '<img loading="lazy" decoding="async" alt="" src="' + escapeHtml(mzCoverUrl(t.c, size)) + '" onerror="this.remove()">' : '') + '</div>';
}
function mzToast(msg) {
  var t = mzEl('wm-toast');
  if (!t) { t = document.createElement('div'); t.id = 'wm-toast'; t.className = 'wm-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.dataset.mzt = mz.theme; t.style.opacity = '1';
  clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; }, 1600);
}

var MZ_ICON = {
  play: '<polygon points="7 4 20 12 7 20"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  repeat: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  repeatOne: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15" font-size="8" fill="currentColor" stroke="none" text-anchor="middle" font-weight="700">1</text></svg>',
  vol: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>',
  mute: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19" fill="currentColor"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>',
};

// ─── library ─────────────────────────────────────────────
function mzIngest(d) {
  mz.source = d.source || '';
  mz.error = d.error || (d.source === 'files' ? 'Showing tags read from the files. Add DECLOUD_NAVIDROME_USER and DECLOUD_NAVIDROME_PASS to .env to use Navidrome metadata.' : '');
  musicPlaylist = d.tracks || [];
  mz.playlists = d.playlists || [];
  mz.byId = new Map(); mz.artists = new Map(); mz.albums = new Map(); mz.genres = new Map(); mz.plCache = {};
  musicPlaylist.forEach(function (t, i) {
    t.i = i; t.h = mzHue(t.ar); t.k = (t.t + ' ' + t.ar + ' ' + t.al + ' ' + t.g).toLowerCase();
    mz.byId.set(t.f, t);
    var ak = t.ai || t.ar, a = mz.artists.get(ak);
    if (!a) { a = { id: ak, name: t.ar, tracks: [], albums: new Set() }; mz.artists.set(ak, a); }
    a.tracks.push(t);
    if (t.li) {
      var al = mz.albums.get(t.li);
      if (!al) { al = { id: t.li, name: t.al || 'Unknown Album', tracks: [], who: {}, aa: t.aa, year: '', added: 0, g: '', first: t }; mz.albums.set(t.li, al); }
      al.tracks.push(t); al.who[t.ar] = (al.who[t.ar] || 0) + 1;
      if (t.y && !al.year) al.year = t.y;
      if (t.g && !al.g) al.g = t.g;
      if (t.a > al.added) al.added = t.a;
      a.albums.add(al);
    }
    if (t.g) { var g = mz.genres.get(t.g); if (!g) { g = []; mz.genres.set(t.g, g); } g.push(t); }
  });
  mz.albums.forEach(function (al) {
    al.tracks.sort(function (x, y) { return (x.dn - y.dn) || ((x.n || 999) - (y.n || 999)) || x.t.localeCompare(y.t); });
    var names = Object.keys(al.who), best = names[0] || '';
    names.forEach(function (n) { if (al.who[n] > al.who[best]) best = n; });
    al.artist = al.aa || (names.length > 3 ? 'Various Artists' : best);
    al.h = mzHue(al.name + al.artist);
    al.first = al.tracks[0];
  });
}

var mzLoading = null;
function loadMusic() {
  if (!mzLoading) mzLoading = mzLoad().finally(function () { mzLoading = null; });
  return mzLoading;
}
async function mzLoad() {
  var content = mzEl('wm-content');
  if (!content) return;
  if (!musicAudio) { musicAudio = mzEl('music-audio'); mzBindAudio(); mzBindUI(); }
  mzConnect();
  if (!mz.loaded) content.innerHTML = '<div class="wm-empty">Loading your library…</div>';
  else mzRender();
  try {
    var r = await fetch('/api/music/library');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var d = await r.json();
    var had = mz.loaded;
    mzIngest(d);
    if (had && mz.queue.length) {
      mz.queue = mz.queue.map(function (t) { return mz.byId.get(t.f) || t; });
      mz.origQueue = null;
    }
    mz.loaded = true;
    if (!had) {
      if (mz.pendingMsg) { var pm = mz.pendingMsg; mz.pendingMsg = null; mzOnState(pm); }
      mzRestoreState();
    }
    mzRender();
  } catch (e) {
    if (!mz.loaded) content.innerHTML = '<div class="wm-empty">Failed to load music</div>';
  }
}

// ─── routing ─────────────────────────────────────────────
function mzRoute(v) {
  if (v.type === mzDefaultType() && !v.key) return 'music';
  return 'music/' + v.type + (v.key ? '/' + encodeURIComponent(v.key) : '');
}
function mzGo(type, key) {
  mz.view = { type: type, key: key || '' };
  mz.sel = -1; mz.sort = { col: '', dir: 1 };
  if (type !== 'search') { mz.query = ''; var si = mzEl('wm-search-input'); if (si) si.value = ''; }
  navSet(mzRoute(mz.view));
  mzRender();
  var c = mzEl('wm-content'); if (c) c.scrollTop = 0;
}
// Apply a #music/... route from back/forward or a deep link (never pushes history)
function mzApplyRoute(parts) {
  mzCloseMenu();
  var wEl = document.querySelector('#music-screen .wm');
  if (parts[0] === 'player') {                                   // the phone's full-screen player sits on top of the current page
    if (mz.theme === 'spotify' && mzCur() && typeof mzSp !== 'undefined' && mzSp) mzSp.npSet(true, true);
    return;
  }
  if (typeof mzSp !== 'undefined' && mzSp) mzSp.npSet(false, true);
  var type = parts[0] || mzDefaultType(), key = parts[1] ? navSafeDecode(parts[1]) : '';
  var ok = ['albums', 'artists', 'songs', 'genres', 'favorites', 'recent', 'played', 'now', 'search', 'artist', 'album', 'genre', 'playlist'];
  if (mz.theme === 'spotify') ok.push('home', 'mix', 'library');
  if (ok.indexOf(type) < 0) { type = mzDefaultType(); key = ''; }
  if (type === 'now' && !mzCur() && !mzHasSavedState()) type = mzDefaultType();
  if (type !== 'search') { mz.query = ''; var si = mzEl('wm-search-input'); if (si) si.value = ''; }
  mz.view = { type: type, key: key }; mz.sel = -1; mz.sort = { col: '', dir: 1 };
  mzRender();
  var c = mzEl('wm-content'); if (c) c.scrollTop = 0;
}
function mzHideNP() { if (typeof mzSp !== 'undefined' && mzSp) mzSp.npSet(false, false); }
function mzCloseSheet() { mzCloseMenu(); }

// ─── media keys / OS media widgets (KDE, lock screen) ────
// Explicit play / pause (not a toggle), so the OS can never send the wrong one. They also work when
// this device is only a remote: the command goes to the device that is actually playing.
function mzMediaPlay() {
  if (mz.remote && mz.rs) { if (!mz.rs.st.playing) { mzCmd('play'); mzRemoteOptimistic(true); } return; }
  if (!musicAudio) return;
  if (!musicAudio.src && mzCur()) mzStartCurrent(0);
  mzTryPlay(null);
}
function mzMediaPause() {
  if (mz.remote && mz.rs) { if (mz.rs.st.playing) { mzCmd('pause'); mzRemoteOptimistic(false); } return; }
  if (musicAudio) musicAudio.pause();
}
function mzMediaSeekTo(sec) {
  if (!isFinite(sec) || sec < 0) return;
  if (mz.remote && mz.rs) { mzCmd('seek', sec); mz.rs.st.pos = sec; mz.rs.at = Date.now(); return; }
  if (musicAudio) musicAudio.currentTime = sec;
}
function mzMediaSeekBy(delta) {
  var cur = mz.remote ? mzRemotePos() : (musicAudio ? musicAudio.currentTime : 0);
  mzMediaSeekTo(Math.max(0, cur + delta));
}

// ─── help for first-time users (glossy theme) ────────────
function mzToggleHelp(e) {
  if (e) e.stopPropagation();
  var h = mzEl('wm-help'); if (!h) return;
  var open = h.style.display === 'none';
  h.style.display = open ? '' : 'none'; h.setAttribute('aria-hidden', open ? 'false' : 'true');
  var cmd = mzEl('wm-help-cmd'); if (cmd) cmd.textContent = 'curl -fsSL ' + location.origin + '/static/tools/decloud-mpris.py -o ~/decloud-mpris.py && python3 ~/decloud-mpris.py';
  if (open) { var b = h.querySelector('button'); if (b) b.focus(); }
}
function mzCloseHelp() { var h = mzEl('wm-help'); if (h) { h.style.display = 'none'; h.setAttribute('aria-hidden', 'true'); } }
function mzTipSeen() { try { return localStorage.getItem('mzTipSeen') === '1'; } catch (_) { return true; } }
function mzDismissTip() { try { localStorage.setItem('mzTipSeen', '1'); } catch (_) {} var t = document.querySelector('#wm-content .wm-tip'); if (t) t.remove(); }
function mzTipHtml() {
  if (mz.theme !== 'glossy' || mzTipSeen() || mz.view.type === 'now') return '';
  return '<div class="wm-tip" role="note"><div><b>New here?</b> Double-click a song to play it, or hover its number and press the play button. Press <b>⋯</b> on a song for more options.</div>' +
    '<button class="wm-btn" data-act="g-tip-help">Show me around</button><button class="wm-btn" data-act="g-tip-ok">Got it</button></div>';
}

// ─── window controls + phone player ────────────────────
function mzIsMobile() { return !!(window.matchMedia && matchMedia('(max-width: 760px)').matches); }
function mzNowTap(e) {
  if (e && e.target && e.target.closest('a, button')) return;                   // a link or button inside the bar handles itself
  if (typeof mzSp !== 'undefined' && mzSp && mzSp.justDragged && mzSp.justDragged()) return;       // the finger was swiping, not tapping
  if (mz.theme === 'spotify') { if (mzIsMobile()) mzNPOpen(); return; }          // Spotify desktop: the title and artist are links; the queue button opens the queue
  mzGo('now');
}
// title and artist under the cover. In the Spotify theme on desktop they are links (title: its album, artist: the artist page)
function mzNowText(t) {
  var ti = mzEl('wm-now-title'), ar = mzEl('wm-now-artist'); if (!ti || !ar || !t) return;
  if (mz.theme === 'spotify' && !mzIsMobile()) {
    var E = escapeHtml;
    ti.innerHTML = t.li ? '<a class="npl" data-act="np-album" data-v="' + E(t.li) + '">' + E(t.t) + '</a>' : E(t.t);
    ar.innerHTML = '<a class="npl" data-act="np-artist" data-v="' + E(t.ai || t.ar) + '">' + E(t.ar) + '</a>' +
      (t.al && t.li ? ' · <a class="npl" data-act="np-album" data-v="' + E(t.li) + '">' + E(t.al) + '</a>' : (t.al ? ' · ' + E(t.al) : ''));
  } else { ti.textContent = t.t; ar.textContent = t.ar + (t.al ? ' · ' + t.al : ''); }
}
// phone full-screen player: a sheet (see music-spotify.js) that can also be dragged open/closed
function mzNPOpen() {
  if (!mzCur() || typeof mzSp === 'undefined' || !mzSp) return;
  navSet('music/player'); mzSp.npSet(true, true);
}
function mzNPClose() {
  if (nav.cur === 'music/player' && navCanBack()) { history.back(); return; }
  if (typeof mzSp !== 'undefined' && mzSp) mzSp.npSet(false, true);
  navSet(mzRoute(mz.view));
}
function mzToggleSidebar() { var w = document.querySelector('#music-screen .wm'); if (w) w.classList.toggle('side-hidden'); }
function mzFullscreen() {
  var el = mzEl('music-screen');
  try { if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); } catch (_) {}
}

// ─── view building ───────────────────────────────────────
var MZ_ICON_SVG = function (d) { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; };
var MZ_NAV_ICON = {
  now: MZ_ICON_SVG('<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>'),
  albums: MZ_ICON_SVG('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/>'),
  artists: MZ_ICON_SVG('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6"/>'),
  songs: MZ_ICON_SVG('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
  genres: MZ_ICON_SVG('<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.2"/>'),
  favorites: MZ_ICON_SVG('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
  recent: MZ_ICON_SVG('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>'),
  played: MZ_ICON_SVG('<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="9"/>'),
  playlist: MZ_ICON_SVG('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="13" y2="18"/>'),
};
var MZ_NAV = [
  ['', [['now', 'Now Playing']]],
  ['Browse', [['albums', 'Albums'], ['artists', 'Artists'], ['songs', 'Songs'], ['genres', 'Genres']]],
  ['Your music', [['favorites', 'Favorites'], ['recent', 'Recently added'], ['played', 'Most played']]],
];
function mzSideHtml() {
  var out = '', v = mz.view;
  MZ_NAV.forEach(function (sec) {
    if (sec[0]) out += '<h6>' + sec[0] + '</h6>';
    sec[1].forEach(function (it) {
      var on = v.type === it[0] || (it[0] === 'albums' && v.type === 'album') || (it[0] === 'artists' && v.type === 'artist') || (it[0] === 'genres' && v.type === 'genre');
      var count = '';
      if (it[0] === 'songs') count = '<small>' + musicPlaylist.length.toLocaleString() + '</small>';
      if (it[0] === 'albums') count = '<small>' + mz.albums.size.toLocaleString() + '</small>';
      if (it[0] === 'artists') count = '<small>' + mz.artists.size.toLocaleString() + '</small>';
      out += '<button class="wm-nav' + (on ? ' active' : '') + '" data-act="nav" data-v="' + it[0] + '"' + (on ? ' aria-current="page"' : '') + '>' + (MZ_NAV_ICON[it[0]] || '') + '<span>' + it[1] + '</span>' + count + '</button>';
    });
  });
  if (mz.playlists.length) {
    out += '<h6>Playlists</h6>';
    mz.playlists.forEach(function (p) {
      var on = v.type === 'playlist' && v.key === p.id;
      out += '<button class="wm-nav' + (on ? ' active' : '') + '" data-act="playlist" data-v="' + escapeHtml(p.id) + '" title="' + escapeHtml(p.name) + '"' + (on ? ' aria-current="page"' : '') + '>' + MZ_NAV_ICON.playlist + '<span>' + escapeHtml(p.name) + '</span><small>' + p.n + '</small></button>';
    });
  }
  return out;
}

function mzSortList(list) {
  var s = mz.sort; if (!s.col) return list;
  var get = {
    n: function (t) { return t.dn * 1000 + (t.n || 0); }, t: function (t) { return t.t.toLowerCase(); },
    d: function (t) { return t.d; }, ar: function (t) { return t.ar.toLowerCase(); },
    al: function (t) { return t.al.toLowerCase(); }, g: function (t) { return t.g.toLowerCase(); },
    a: function (t) { return t.a; }, pc: function (t) { return t.pc || 0; },
  }[s.col];
  return list.slice().sort(function (a, b) {
    var x = get(a), y = get(b);
    return (typeof x === 'number' ? x - y : x.localeCompare(y)) * s.dir || a.t.localeCompare(b.t);
  });
}

function mzHeaderHtml(o) {
  function th(col, label, cls) {
    var on = mz.sort.col === col;
    return '<span class="' + (cls || '') + (on ? ' sorted' : '') + '" data-act="sort" data-v="' + col + '"' + (on ? ' data-dir="' + (mz.sort.dir > 0 ? '▲' : '▼') + '"' : '') + '>' + label + '</span>';
  }
  return '<div class="wm-hdr">' + th('n', '#') + '<span></span>' + th('t', 'Title') + th('d', 'Length') + th('ar', 'Artist') +
    (o.album ? th('al', 'Album', 'c-album') : '') + th('g', 'Genre', 'c-genre') + '<span class="c-act"></span></div>';
}
function mzRowHtml(t, i, o) {
  var cur = mzCur(), playing = cur && cur.f === t.f;
  return '<div class="wm-row trk' + (playing ? ' playing' : '') + (mz.sel === i ? ' sel' : '') + '" data-act="row" data-c="' + i + '" data-t="' + escapeHtml(t.f) + '">' +
    '<span class="num"><i>' + (o.num === 'n' ? (t.n || '') : i + 1) + '</i><button class="rp" data-act="g-play" data-c="' + i + '" aria-label="Play ' + escapeHtml(t.t) + '" title="Play"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="7 4 20 12 7 20"/></svg></button></span>' +
    '<span class="star' + (t.fav ? ' on' : '') + '" data-act="star" data-t="' + escapeHtml(t.f) + '" role="button" aria-label="Favorite" title="' + (t.fav ? 'Remove from favorites' : 'Add to favorites') + '">' + (t.fav ? '★' : '☆') + '</span>' +
    '<span>' + escapeHtml(t.t) + '</span><span class="len">' + mzFmt(t.d) + '</span>' +
    '<span class="dim">' + escapeHtml(t.ar) + '</span>' +
    (o.album ? '<span class="dim c-album">' + escapeHtml(t.al) + '</span>' : '') +
    '<span class="dim c-genre">' + escapeHtml(t.g) + '</span>' +
    '<span class="act"><button class="rm" data-act="g-more" data-t="' + escapeHtml(t.f) + '" aria-label="More options for ' + escapeHtml(t.t) + '" title="More options"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button></span></div>';
}
function mzTableHtml(tracks, o) {
  o = o || {};
  var list = mzSortList(tracks);
  mz.ctx = list;
  if (!list.length) return '<div class="wm-empty">' + (o.empty || 'Nothing here yet.') + '</div>';
  return '<div class="wm-table' + (o.album ? '' : ' noalbum') + '">' + mzHeaderHtml(o) +
    list.map(function (t, i) { return mzRowHtml(t, i, o); }).join('') + '</div>';
}
function mzTileHtml(al) {
  return '<div class="wm-tile" data-act="album" data-v="' + escapeHtml(al.id) + '">' + mzArt(al.first, 300) +
    '<b>' + escapeHtml(al.name) + '</b><small>' + escapeHtml(al.artist) + (al.year ? ' · ' + escapeHtml(al.year) : '') + '</small></div>';
}
function mzAlbumsGrid(list) { return '<div class="wm-albums">' + list.map(mzTileHtml).join('') + '</div>'; }
function mzLinkRows(head, rows) {
  return '<div class="wm-hdr link"><span>' + head[0] + '</span><span>' + head[1] + '</span><span>' + head[2] + '</span></div>' + rows.join('');
}

function mzBar(title, sub, btns) {
  var b = '';
  (btns || []).forEach(function (x) { b += '<button class="wm-btn" data-act="' + x[0] + '">' + x[1] + '</button>'; });
  return '<h1>' + escapeHtml(title) + '</h1><span class="sub">' + escapeHtml(sub || '') + '</span>' + b;
}
function mzSumDur(tracks) { return tracks.reduce(function (s, t) { return s + (t.d || 0); }, 0); }

// Returns {title, crumb, sub, btns, html}
function mzBuildView() {
  var v = mz.view, all = musicPlaylist, PS = [['play-all', '▶ Play'], ['shuffle-all', 'Shuffle']];
  switch (v.type) {
    case 'albums': {
      var list = Array.from(mz.albums.values()).sort(function (a, b) { return a.artist.localeCompare(b.artist) || (a.year || '').localeCompare(b.year || '') || a.name.localeCompare(b.name); });
      return { title: 'Albums', sub: mzPlural(list.length, 'album'), btns: [['shuffle-lib', 'Shuffle all']], html: list.length ? mzAlbumsGrid(list) : '<div class="wm-empty">No albums found.</div>' };
    }
    case 'artists': {
      var arts = Array.from(mz.artists.values()).sort(function (a, b) { return a.name.localeCompare(b.name); });
      return { title: 'Artists', sub: mzPlural(arts.length, 'artist'), btns: [],
        html: mzLinkRows(['Artist', 'Albums', 'Songs'], arts.map(function (a) {
          return '<div class="wm-row link" data-act="artist" data-v="' + escapeHtml(a.id) + '"><span>' + escapeHtml(a.name) + '</span><span class="dim">' + a.albums.size + '</span><span class="dim">' + a.tracks.length + '</span></div>';
        })) };
    }
    case 'genres': {
      var gs = Array.from(mz.genres.entries()).sort(function (a, b) { return b[1].length - a[1].length; });
      return { title: 'Genres', sub: mzPlural(gs.length, 'genre'), btns: [],
        html: gs.length ? mzLinkRows(['Genre', 'Songs', 'Artists'], gs.map(function (g) {
          var n = new Set(g[1].map(function (t) { return t.ai || t.ar; })).size;
          return '<div class="wm-row link" data-act="genre" data-v="' + escapeHtml(g[0]) + '"><span>' + escapeHtml(g[0]) + '</span><span class="dim">' + g[1].length + '</span><span class="dim">' + n + '</span></div>';
        })) : '<div class="wm-empty">No genre tags in this library.</div>' };
    }
    case 'songs':
      return { title: 'Songs', sub: mzPlural(all.length, 'song') + ' · ' + mzDur(mzSumDur(all)), btns: PS,
        html: mzTableHtml(mz.sort.col ? all : all.slice().sort(function (a, b) { return a.t.localeCompare(b.t); }), { album: true }) };
    case 'favorites': {
      var f = all.filter(function (t) { return t.fav; });
      return { title: 'Favorites', sub: mzPlural(f.length, 'song'), btns: f.length ? PS : [], html: mzTableHtml(f, { album: true, empty: 'Click the ☆ next to a song to add it here.' }) };
    }
    case 'recent': {
      var r = all.slice().sort(function (a, b) { return b.a - a.a; }).slice(0, 200);
      return { title: 'Recently added', sub: 'latest ' + r.length + ' songs', btns: PS, html: mzTableHtml(r.slice(), { album: true, keep: true }) };
    }
    case 'played': {
      var p = all.filter(function (t) { return t.pc > 0; }).sort(function (a, b) { return b.pc - a.pc; }).slice(0, 200);
      return { title: 'Most played', sub: p.length + ' songs', btns: p.length ? PS : [], html: mzTableHtml(p, { album: true, empty: 'Play some music and it will show up here.' }) };
    }
    case 'artist': {
      var a = mz.artists.get(v.key); if (!a) return mzMissing();
      var albums = Array.from(a.albums).sort(function (x, y) { return (y.year || '').localeCompare(x.year || ''); });
      var tracks = a.tracks.slice().sort(function (x, y) { return x.al.localeCompare(y.al) || (x.dn - y.dn) || ((x.n || 999) - (y.n || 999)); });
      var head = '<div class="wm-head">' + mzArt(a.tracks[0], 300, 'round') + '<div><h2>' + escapeHtml(a.name) + '</h2><p>' +
        mzPlural(albums.length, 'album') + ' · ' + mzPlural(a.tracks.length, 'song') + ' · ' + mzDur(mzSumDur(a.tracks)) + '</p></div></div>';
      return { title: a.name, crumb: ['Artists', a.name], sub: '', btns: PS, html: head + (albums.length > 1 ? mzAlbumsGrid(albums) : '') + mzTableHtml(tracks, { album: true, keep: true }) };
    }
    case 'album': {
      var al = mz.albums.get(v.key); if (!al) return mzMissing();
      var headA = '<div class="wm-head">' + mzArt(al.first, 400) + '<div><h2>' + escapeHtml(al.name) + '</h2><p>' + escapeHtml(al.artist) +
        (al.year ? ' · ' + escapeHtml(al.year) : '') + (al.g ? ' · ' + escapeHtml(al.g) : '') + '</p><p>' + mzPlural(al.tracks.length, 'song') + ' · ' + mzDur(mzSumDur(al.tracks)) + '</p></div></div>';
      return { title: al.name, crumb: ['Albums', al.name], sub: '', btns: PS, html: headA + mzTableHtml(al.tracks, { num: 'n' }) };
    }
    case 'genre': {
      var gt = mz.genres.get(v.key); if (!gt) return mzMissing();
      return { title: v.key, crumb: ['Genres', v.key], sub: mzPlural(gt.length, 'song'), btns: PS, html: mzTableHtml(gt, { album: true }) };
    }
    case 'playlist': {
      var pl = mz.playlists.filter(function (x) { return x.id === v.key; })[0];
      var ids = mz.plCache[v.key];
      if (!ids) { mzLoadPlaylist(v.key); return { title: pl ? pl.name : 'Playlist', crumb: ['Playlists', pl ? pl.name : ''], sub: 'loading…', btns: [], html: '<div class="wm-empty">Loading…</div>' }; }
      var pt = ids.map(function (id) { return mz.byId.get(id); }).filter(Boolean);
      return { title: pl ? pl.name : 'Playlist', crumb: ['Playlists', pl ? pl.name : ''], sub: mzPlural(pt.length, 'song'), btns: pt.length ? PS : [], html: mzTableHtml(pt, { album: true, keep: true }) };
    }
    case 'search':
      return mzSearchView();
    case 'now':
      return { title: 'Now Playing', sub: '', btns: [], now: true, html: '' };
  }
  return mzMissing();
}
function mzMissing() { return { title: 'Not found', sub: '', btns: [], html: '<div class="wm-empty">That item is no longer in your library.</div>' }; }

async function mzLoadPlaylist(id) {
  try {
    var r = await fetch('/api/music/playlist/' + encodeURIComponent(id));
    var d = await r.json();
    mz.plCache[id] = d.ids || [];
  } catch (e) { mz.plCache[id] = []; }
  if (mz.view.type === 'playlist' && mz.view.key === id) mzRender();
}

function mzSearchView() {
  var q = mz.query.trim().toLowerCase();
  if (!q) return { title: 'Search', sub: '', btns: [], html: '<div class="wm-empty">Type to search songs, artists and albums.</div>' };
  var terms = q.split(/\s+/);
  function hit(s) { return terms.every(function (t) { return s.indexOf(t) >= 0; }); }
  var songs = musicPlaylist.filter(function (t) { return hit(t.k); });
  var arts = Array.from(mz.artists.values()).filter(function (a) { return hit(a.name.toLowerCase()); }).slice(0, 5);
  var albs = Array.from(mz.albums.values()).filter(function (a) { return hit((a.name + ' ' + a.artist).toLowerCase()); }).slice(0, 8);
  var html = '';
  if (arts.length) html += mzLinkRows(['Artists', 'Albums', 'Songs'], arts.map(function (a) {
    return '<div class="wm-row link" data-act="artist" data-v="' + escapeHtml(a.id) + '"><span>' + escapeHtml(a.name) + '</span><span class="dim">' + a.albums.size + '</span><span class="dim">' + a.tracks.length + '</span></div>';
  }));
  if (albs.length) html += mzAlbumsGrid(albs);
  html += mzTableHtml(songs.slice(0, 300), { album: true, empty: songs.length || arts.length || albs.length ? '' : 'No results for “' + escapeHtml(mz.query) + '”.' });
  return { title: 'Search', sub: mzPlural(songs.length, 'song') + ' found', btns: songs.length ? PS_SEARCH : [], html: html };
}
var PS_SEARCH = [['play-all', '▶ Play'], ['shuffle-all', 'Shuffle']];

function mzRender() {
  var content = mzEl('wm-content'); if (!content || !mz.loaded) return;
  var wv = document.querySelector('#music-screen .wm'); if (wv) wv.dataset.view = mz.view.type;
  if (mz.theme === 'spotify' && typeof mzSp !== 'undefined' && mzSp) { mzSp.render(); return; }
  var vw = mzBuildView(), v = mz.view;
  mzEl('wm-side').innerHTML = mzSideHtml();
  var crumb = ['Library'].concat(vw.crumb ? vw.crumb.slice(0, -1) : []);
  mzEl('wm-crumb').textContent = crumb.join('  ›  ');
  var bar = mzEl('wm-bar');
  bar.style.display = vw.now ? 'none' : '';
  bar.innerHTML = mzBar(vw.title, vw.sub, vw.btns);
  if (vw.now) { mzRenderNow(content); return; }
  var keepScroll = content.scrollTop;
  content.innerHTML = mzTipHtml() + (mz.error && !vw.now ? '<div class="wm-empty" style="padding:8px 18px;text-align:left;color:#e0b25a">' + escapeHtml(mz.error) + '</div>' : '') + vw.html;
  if (mz.view === v) content.scrollTop = keepScroll;
  mzMarkPlaying();
}

// ─── Now Playing (visualizer + queue) ────────────────────
function mzRenderNow(content) {
  var t = mzCur();
  if (!t) { content.innerHTML = '<div class="wm-empty">Nothing is playing. Double-click a song to start.</div>'; return; }
  var upcoming = mz.queue.slice(0, 400);
  content.innerHTML = '<div class="wm-npv"><div class="wm-split q" id="wm-qsplit" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize · double-click to reset"></div><div class="wm-stage" id="wm-stage"><canvas id="wm-viz" role="img" aria-label="Audio visualizer around the album cover"></canvas>' +
    '<div class="meta"><b>' + escapeHtml(t.t) + '</b><span>' + escapeHtml(t.ar) + (t.al ? ' · ' + escapeHtml(t.al) : '') + '</span></div></div>' +
    '<div class="wm-qlist"><h3><span>Now playing · ' + mz.queue.length + '</span><a data-act="q-clear">Clear</a></h3>' +
    upcoming.map(function (q, i) {
      return '<div class="wm-q' + (i === mz.qi ? ' playing' : '') + '" data-act="q-jump" data-c="' + i + '" data-t="' + escapeHtml(q.f) + '"><span class="num">' + (i + 1) + '</span>' +
        '<div class="t"><div>' + escapeHtml(q.t) + '</div><small>' + escapeHtml(q.ar) + '</small></div><span class="len">' + mzFmt(q.d) + '</span></div>';
    }).join('') + '</div></div>';
  var cur = content.querySelector('.wm-q.playing');
  if (cur) cur.scrollIntoView({ block: 'center' });
  mzVizStart();
}

function mzMarkPlaying() {
  var cur = mzCur(), id = cur ? cur.f : null;
  document.querySelectorAll('#wm-content .trk[data-t]').forEach(function (r) { r.classList.toggle('playing', r.dataset.t === id); });
  document.querySelectorAll('#wm-content .wm-q, #wm-content .qrow').forEach(function (r) { r.classList.toggle('playing', parseInt(r.dataset.c, 10) === mz.qi); });
  if (mz.theme === 'spotify' && typeof mzSp !== 'undefined' && mzSp) mzSp.markPlaying();
}

// ─── remember what was playing + live control across devices ──────────
// localStorage keeps a fast local copy; the server holds the shared session. A WebSocket
// ("Connect") links every open device: one is ACTIVE (it outputs the sound and reports its
// state), the others are REMOTES - their transport shows the active device's state and their
// buttons send commands to it, so pausing on your phone pauses the desktop and vice versa.
var MZ_STATE_KEY = 'mzPlayState', mzSaveAt = 0, mzPushAt = 0, mzPushT = 0, mzLastSig = '', mzSnapFrom = 0;
mz.rev = 0; mz.ws = null; mz.wsTry = 0; mz.hb = 0; mz.devices = []; mz.activeId = null;
mz.remote = false; mz.rs = null; mz.pendingMsg = null; mz.inflight = null;
function mzQueueSig() {
  var q = mz.queue, step = Math.max(1, Math.floor(q.length / 40)), parts = [q.length];
  for (var i = 0; i < q.length; i += step) parts.push(q[i].f);
  parts.push(q[q.length - 1].f);
  return parts.join('|');
}
function mzDevice() {
  try {
    var id = localStorage.getItem('mzDev');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('mzDev', id); }
    return id;
  } catch (_) { return 'anon'; }
}
// each open tab is its own device, so two tabs in one browser can remote-control each other
var mzTabId = (function () {
  try { var t = sessionStorage.getItem('mzTab'); if (!t) { t = Math.random().toString(36).slice(2, 6); sessionStorage.setItem('mzTab', t); } return t; } catch (_) { return 'x'; }
})();
function mzMe() { return mzDevice() + '.' + mzTabId; }
function mzDeviceLabel() {
  var u = navigator.userAgent;
  var os = /Android/.test(u) ? 'Android' : /iPhone|iPad|iPod/.test(u) ? 'iOS' : /Windows/.test(u) ? 'Windows' : /Mac OS/.test(u) ? 'Mac' : /CrOS/.test(u) ? 'ChromeOS' : /Linux/.test(u) ? 'Linux' : '';
  var br = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Browser';
  return os ? br + ' on ' + os : br;
}
function mzHasSavedState() { try { return !!localStorage.getItem(MZ_STATE_KEY); } catch (_) { return false; } }
function mzReadLocal() { try { return JSON.parse(localStorage.getItem(MZ_STATE_KEY) || 'null'); } catch (_) { return null; } }
function mzWsOpen() { return !!(mz.ws && mz.ws.readyState === 1); }
function mzSend(o) { if (!mzWsOpen()) return false; try { mz.ws.send(JSON.stringify(o)); return true; } catch (_) { return false; } }

// The part of the queue worth sharing: 1,500 ids around the current track.
function mzSnapshot() {
  var from = Math.max(0, mz.qi - 100), q = mz.queue.slice(from, from + 1500);
  return {
    q: q.map(function (t) { return t.f; }), qi: mz.qi - from,
    pos: musicAudio && isFinite(musicAudio.currentTime) ? Math.round(musicAudio.currentTime * 10) / 10 : 0,
    playing: !!(musicAudio && !musicAudio.paused), sh: mz.shuffle, rp: mz.repeat,
  };
}
function mzSaveState(force) {
  if (mz.remote) return;                           // a remote only mirrors; it must not overwrite the session
  var now = Date.now();
  if (!force && now - mzSaveAt < 2000) return;
  mzSaveAt = now;
  try {
    if (!mz.queue.length || mz.qi < 0) { localStorage.removeItem(MZ_STATE_KEY); return; }
    var st = mzSnapshot(); st.rev = mz.rev;
    localStorage.setItem(MZ_STATE_KEY, JSON.stringify(st));
  } catch (_) {}
  mzPushSoon(force);
}

// what to tell the server: the queue only when it changed, otherwise a tiny progress update
function mzBody() {
  var st = mzSnapshot(), cur = mzCur();
  var sig = mzQueueSig(), full = sig !== mzLastSig;
  var from = full ? Math.max(0, mz.qi - 100) : mzSnapFrom;        // index offset stays fixed between full pushes
  var body = { dev: mzMe(), label: mzDeviceLabel(), cur: cur.f, qi: mz.qi - from, pos: st.pos, playing: st.playing, sh: st.sh, rp: st.rp };
  if (full) body.q = mz.queue.slice(from, from + 1500).map(function (t) { return t.f; });
  return { body: body, sig: sig, from: from };
}
function mzPushSoon(force) {
  if (!mz.queue.length || mz.qi < 0) return;
  if (force) { clearTimeout(mzPushT); mzPushT = setTimeout(function () { mzPush(false); }, mzWsOpen() ? 40 : 600); return; }
  if (Date.now() - mzPushAt > (mzWsOpen() ? 5000 : 10000) && musicAudio && !musicAudio.paused) mzPush(false);
}
function mzAckOk(info, updated) {
  mz.rev = updated; if (info.body.q) { mzLastSig = info.sig; mzSnapFrom = info.from; }
  try { var l = mzReadLocal(); if (l) { l.rev = mz.rev; localStorage.setItem(MZ_STATE_KEY, JSON.stringify(l)); } } catch (_) {}
}
function mzPush(leaving) {
  if (mz.remote || !mzCur()) return;
  mzPushAt = Date.now();
  var info = mzBody();
  if (mzSend(Object.assign({ t: 'state' }, info.body))) { mz.inflight = info; return; }
  var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info.body), keepalive: !!leaving && !info.body.q };
  fetch('/api/music/session', opts).then(function (r) { return r.json(); }).then(function (d) {
    if (d.ok) mzAckOk(info, d.updated); else if (d.stale) { mzLastSig = ''; mzPush(false); }   // server had no/other queue: send it whole
  }).catch(function () {});
}

async function mzFetchSession() {
  try {
    var r = await fetch('/api/music/session');
    if (!r.ok) return null;
    var d = await r.json();
    return d.session && d.session.state && d.session.state.q ? { s: d.session, now: d.now, active: d.active } : null;
  } catch (_) { return null; }
}

// ─── Connect: the live channel ───────────────────────────
function mzConnect() {
  if (mz.ws && mz.ws.readyState <= 1) return;
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:', ws;
  try { ws = new WebSocket(proto + '//' + location.host + '/api/music/connect'); } catch (e) { return; }   // auth: the login cookie (never a token in the URL)
  mz.ws = ws;
  ws.onopen = function () {
    mz.wsTry = 0;
    mzSend({ t: 'hello', dev: mzMe(), label: mzDeviceLabel() });
    clearInterval(mz.hb); mz.hb = setInterval(function () { mzSend({ t: 'ping' }); }, 20000);
  };
  ws.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (_) { return; } mzOnMsg(m); };
  ws.onclose = function () {
    clearInterval(mz.hb);
    if (mz.ws === ws) { mz.ws = null; setTimeout(mzConnect, Math.min(10000, 1000 * Math.pow(2, mz.wsTry++))); }
  };
  ws.onerror = function () {};
}
function mzOnMsg(m) {
  switch (m.t) {
    case 'state': mzOnState(m); break;
    case 'cmd': mzOnCmd(m); break;
    case 'ack':
      if (m.ok && !m.ignored && mz.inflight) mzAckOk(mz.inflight, m.updated);
      else if (m.stale) { mzLastSig = ''; mzPush(false); }
      break;
    case 'nodevice': mzNoDevice(m.cmd); break;
    case 'blocked': mzTakeOver(); break;
  }
}
function mzDevLabel(id) {
  for (var i = 0; i < mz.devices.length; i++) if (mz.devices[i].id === id) return mz.devices[i].label;
  return 'another device';
}

// a state broadcast: decide whether I am the active device, a remote, or idle
function mzOnState(m) {
  mz.devices = m.devices || []; mz.activeId = m.active || null;
  if (!mz.loaded) { mz.pendingMsg = m; mzUpdateRemoteUI(); return; }
  var s = m.s, me = mzMe();
  if (!s || !s.state || !s.state.q) { mz.remote = false; mzUpdateRemoteUI(); return; }
  mz.rev = s.updated;
  if (m.active === me) { mz.remote = false; mz.rs = null; mzUpdateRemoteUI(); return; }
  var st = Object.assign({}, s.state);
  if (st.playing) st.pos = (st.pos || 0) + Math.max(0, m.now - s.updated);      // it kept playing since the report
  if (m.active) {                                                                // someone else is playing: I am a remote
    var wasRemote = mz.remote;
    mz.remote = true;
    mz.rs = { st: st, at: Date.now() };
    if (musicAudio && !musicAudio.paused) musicAudio.pause();
    mzApplyRemote(st);
    if (!wasRemote) { mzHaptic('remote'); mzToast('Listening on ' + mzDevLabel(m.active)); }
  } else {                                                                       // nobody is playing
    mz.remote = false; mz.rs = null;
    if (s.dev !== me && musicAudio && musicAudio.paused) mzApplyState(st, {});   // pick up the latest idle session
  }
  mzUpdateRemoteUI();
}

// mirror the active device's state without touching local audio
function mzApplyRemote(st) {
  var tracks = st.q.map(function (id) { return mz.byId.get(id); }).filter(Boolean);
  var at = tracks.findIndex(function (t) { return t.f === st.q[st.qi]; });
  if (at < 0) return;
  var prev = mzCur();
  mz.queue = tracks; mz.qi = at; mz.origQueue = null;
  mz.shuffle = !!st.sh; mz.repeat = st.rp || 'off';
  musicCurrentIdx = mzCur().i;
  if (!prev || prev.f !== mzCur().f || mz.view.type === 'now') mzUpdateNow(true);
  else { mzUpdateModes(); mzSyncHeart(); }
  mzSetPlayIcon(!!st.playing);
  mzRemoteTick();
}
function mzRemotePos() {
  if (!mz.rs) return 0;
  var p = mz.rs.st.pos || 0;
  if (mz.rs.st.playing) p += (Date.now() - mz.rs.at) / 1000;
  var t = mzCur(); return t && t.d ? Math.min(p, t.d) : p;
}
function mzRemoteTick() {
  if (!mz.remote || !mz.rs || mz.seeking) return;
  var t = mzCur(); if (!t || !t.d) return;
  var pos = mzRemotePos(), pct = pos / t.d * 100, sk = mzEl('wm-seek');
  sk.value = Math.round(pct * 10); sk.style.setProperty('--p', pct + '%');
  mzEl('wm-cur').textContent = mzFmt(pos);
  var mf = mzEl('sp-minifill'); if (mf) mf.style.width = pct + '%';
}
setInterval(function () { if (mz.remote) mzRemoteTick(); }, 500);

function mzUpdateRemoteUI() {
  var w = document.querySelector('#music-screen .wm'); if (w) w.classList.toggle('remote', !!mz.remote);
  var r = mzEl('wm-remote');
  if (r) {
    r.style.display = mz.remote ? '' : 'none';
    r.textContent = mz.remote ? 'Listening on ' + mzDevLabel(mz.activeId) : '';
  }
  var b = mzEl('wm-devbtn'); if (b) { b.classList.toggle('on', !!mz.remote); b.title = mz.remote ? 'Listening on ' + mzDevLabel(mz.activeId) : 'Connect to a device'; }
}

// remote → active device
function mzCmd(a, v, state) {
  if (!mzSend({ t: 'cmd', a: a, v: v, state: state })) mzNoDevice(a, v, state);
}
function mzNoDevice(a, v, state) {       // the active device is gone: take over and do it here
  if (!mz.remote) return;
  var st = mz.rs ? Object.assign({}, mz.rs.st, { pos: mzRemotePos() }) : null;
  mz.remote = false; mz.rs = null; mzUpdateRemoteUI();
  if (st && mzApplyState(st, {})) {
    if (a === 'load' && state) mzApplyState(Object.assign({}, state), { play: true });
    else if (a === 'play') mzTryPlay(null);
    else if (a === 'next') mzAdvance(false);
    else if (a === 'prev') prevSong();
  }
}
function mzRemoteOptimistic(playing) {
  if (!mz.rs) return;
  mz.rs.st.pos = mzRemotePos(); mz.rs.at = Date.now(); mz.rs.st.playing = playing;
  mzSetPlayIcon(playing);
}
// take over playback on this device (the active one could not start audio, or it vanished)
function mzTakeOver() {
  if (!mz.remote || !mz.rs) return;
  var st = Object.assign({}, mz.rs.st, { pos: mzRemotePos() });
  mz.remote = false; mz.rs = null;
  if (mzApplyState(st, { play: true })) { mzHaptic('warn'); mzToast('Playing on this device instead'); }
  mzUpdateRemoteUI();
}
function mzTryPlay(from) {
  if (!musicAudio) return;
  var p = musicAudio.play();
  if (p && p.catch) p.catch(function () { mzSetPlayIcon(false); if (from) mzSend({ t: 'blocked', to: from }); });
}
function mzStartCurrent(pos) {
  var t = mzCur(); if (!t) return;
  mz.counted = false; mz.resumeAt = pos || 0;
  musicAudio.src = '/api/music/stream/' + mzEnc(t.f);
}

// active device ← command from a remote (or from the server during a transfer)
function mzOnCmd(m) {
  var a = m.a, from = m.from || null;
  if (!musicAudio) return;
  switch (a) {
    case 'play':
      if (!musicAudio.src) mzStartCurrent(mz.rs ? mzRemotePos() : 0);
      mzTryPlay(from); break;
    case 'pause': case 'stop': musicAudio.pause(); break;
    case 'next': mzAdvance(false); break;
    case 'prev': prevSong(); break;
    case 'seek': if (isFinite(m.v)) { musicAudio.currentTime = m.v; mzSaveState(true); } break;
    case 'shuffle': if (mz.shuffle !== !!m.v) mzToggleShuffle(); break;
    case 'repeat': mz.repeat = m.v === 'all' || m.v === 'one' ? m.v : 'off'; mzUpdateModes(); mzSaveState(true); break;
    case 'vol': mz.prefs.vol = Math.max(0, Math.min(1, +m.v || 0)); mz.prefs.muted = false; mzSavePrefs(); mzApplyVolume(); break;
    case 'jump': {
      var idx = -1;
      for (var i = 0; i < mz.queue.length; i++) { if (mz.queue[i].f === m.v) { idx = i; if (i > mz.qi) break; } }
      if (idx >= 0) { mz.qi = idx; mzStart(); }
      break;
    }
    case 'load':
      if (m.state && m.state.q) { mz.remote = false; mzApplyState(m.state, { play: true, from: from }); }
      break;
    case 'qnext': { var t1 = mz.byId.get(m.v); if (t1) mzQueueNext(t1); break; }
    case 'qadd': { var t2 = mz.byId.get(m.v); if (t2) mzQueueAdd(t2); break; }
    case 'qremove': {
      for (var k = mz.queue.length - 1; k >= 0; k--) if (mz.queue[k].f === m.v && k !== mz.qi) { mz.queue.splice(k, 1); if (k < mz.qi) mz.qi--; break; }
      mzSaveState(true); break;
    }
    case 'qclear': mz.queue = mz.queue.slice(mz.qi, mz.qi + 1); mz.qi = mz.queue.length ? 0 : -1; mz.origQueue = null; mzSaveState(true); break;
    case 'handoff': {                                 // give playback to m.to: report the exact position first
      if (!mzCur()) break;
      var info = mzBody();
      mzSend(Object.assign({ t: 'handoff', to: m.to }, info.body));
      mz.inflight = info;
      musicAudio.pause();
      break;
    }
    case 'takeover':
      mz.remote = false; mz.rs = null;
      if (m.state && mzApplyState(m.state, { play: !!m.play })) { mzHaptic('success'); mzToast('Playing on this device'); }
      mzUpdateRemoteUI(); break;
  }
}

function mzTransfer(id) {
  if (!mzSend({ t: 'transfer', to: id })) { mzHaptic('warn'); mzToast('Not connected to the server'); } else mzHaptic('select');
}
function mzDevicesMenu(e) {
  e.stopPropagation();
  var me = mzMe(), m = mzEl('wm-menu');
  var h = '<div class="wm-menu-h">Connect to a device</div>';
  mz.devices.forEach(function (d) {
    var label = d.label + (d.id === me ? ' · this device' : '');
    h += '<button data-act="xfer" data-v="' + escapeHtml(d.id) + '">' + (d.active ? '<span class="dot-on">●</span> ' : '<span class="dot-off">○</span> ') + escapeHtml(label) + (d.active ? '<small> · playing</small>' : '') + '</button>';
  });
  if (mz.devices.length < 2) h += '<div class="wm-menu-h" style="text-transform:none;letter-spacing:0;padding-top:8px">Open DeCloud on another device to control playback between them.</div>';
  m.innerHTML = h; m.style.display = '';
  var r = e.currentTarget.getBoundingClientRect(), mr = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(r.right - mr.width, window.innerWidth - mr.width - 4)) + 'px';
  m.style.top = Math.max(4, r.top - mr.height - 8) + 'px';
}

// Put a saved session in place. Always paused unless asked to play.
function mzApplyState(st, opts) {
  opts = opts || {};
  var curId = st.q[st.qi], tracks = st.q.map(function (id) { return mz.byId.get(id); }).filter(Boolean);
  var at = tracks.findIndex(function (t) { return t.f === curId; });
  if (at < 0) return false;                      // the track is gone from the library
  var prev = mzCur(), sameTrack = prev && prev.f === curId && musicAudio && musicAudio.src;
  mz.queue = tracks; mz.qi = at; mz.origQueue = null;
  mz.shuffle = !!st.sh; mz.repeat = st.rp || 'off';
  if (!musicAudio) musicAudio = mzEl('music-audio');
  var t = mzCur(), pos = st.pos || 0;
  musicCurrentIdx = t.i;
  if (sameTrack) {
    try { musicAudio.currentTime = pos; } catch (_) {}
  } else {
    mz.counted = false; mz.resumeAt = pos;
    musicAudio.src = '/api/music/stream/' + mzEnc(t.f);
  }
  mzLastSig = tracks.length === st.q.length ? mzQueueSig() : '';   // if tracks went missing the indexes differ: resend in full
  mzSnapFrom = 0;
  mzUpdateNow();
  mzSetPlayIcon(!musicAudio.paused && !!sameTrack);
  if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(!musicAudio.paused && !!sameTrack);
  if (opts.play) mzTryPlay(opts.from || null);     // browsers may block autoplay: then it just stays paused
  else if (!sameTrack) musicAudio.pause();
  return true;
}

// at page load: use whichever of (this device's copy, the server's session) is newer
async function mzRestoreState() {
  if (mzCur() || mz.remote) return;               // already queued, or mirroring a device that is playing
  var local = mzReadLocal(), srv = await mzFetchSession();
  if (mzCur() || mz.remote) return;
  mz.rev = (local && local.rev) || 0;
  if (srv && srv.active && srv.active !== mzMe()) return;   // another device is playing: the live channel will mirror it
  var mine = srv && srv.s.dev === mzMe();
  var useServer = srv && (!local || (!mine && srv.s.updated > (local.rev || 0)));
  if (useServer) {
    var st = srv.s.state;
    if (!mine && st.playing) st.pos = (st.pos || 0) + Math.max(0, srv.now - srv.s.updated);
    if (mzApplyState(st, { play: mine && st.playing })) {
      mz.rev = srv.s.updated;
      if (!mine) mzToast('Resumed from ' + (srv.s.label || 'another device'));
      return;
    }
  }
  if (local && local.q && local.q.length && mzApplyState(local, { play: local.playing }) && !srv) mzSaveState(true);
}

// no live channel (offline / proxy blocks WebSockets): fall back to catching up when the tab returns
async function mzSync() {
  if (mzWsOpen() || !mz.loaded || (musicAudio && !musicAudio.paused)) return;
  var srv = await mzFetchSession();
  if (!srv || srv.s.updated <= mz.rev || srv.s.dev === mzMe()) return;
  if (musicAudio && !musicAudio.paused) return;
  var st = srv.s.state;
  if (st.playing) st.pos = (st.pos || 0) + Math.max(0, srv.now - srv.s.updated);
  if (mzApplyState(st, {})) { mz.rev = srv.s.updated; mzToast('Synced from ' + (srv.s.label || 'another device')); }
}

// ─── queue / playback ────────────────────────────────────
function mzPlayList(list, start, forceShuffle) {
  if (!list.length) return;
  if (!musicAudio) musicAudio = mzEl('music-audio');
  if (forceShuffle) mz.shuffle = true;
  var q = list.slice(), qi;
  if (mz.shuffle) {
    var first = q.splice(forceShuffle ? Math.floor(Math.random() * q.length) : start, 1)[0];
    q = [first].concat(mzShuffled(q)); qi = 0;
  } else qi = start;
  if (mz.remote) { mzRemoteLoad(q, qi); return; }
  mz.origQueue = list.slice(); mz.queue = q; mz.qi = qi;
  mzHaptic('play');
  mzStart();
  mzUpdateModes();
}
// "play this list" while another device is playing: it plays there (like Spotify Connect)
function mzRemoteLoad(q, qi) {
  var from = Math.max(0, qi - 100), ids = q.slice(from, from + 1500).map(function (t) { return t.f; });
  var st = { q: ids, qi: qi - from, pos: 0, playing: true, sh: mz.shuffle, rp: mz.repeat };
  mzCmd('load', null, st);
  mz.rs = { st: st, at: Date.now() };
  mzApplyRemote(st);
}
function playMusic(idx) { mzPlayList(musicPlaylist, idx); }

function mzStart() {
  var t = mzCur(); if (!t) return;
  if (!musicAudio) musicAudio = mzEl('music-audio');
  musicCurrentIdx = t.i; mz.counted = false; mz.resumeAt = 0;
  musicAudio.src = '/api/music/stream/' + mzEnc(t.f);
  mzSaveState(true);
  mzTryPlay(null);
  mzUpdateNow();
}
function mzAdvance(auto) {
  if (!mz.queue.length) return;
  if (mz.qi + 1 < mz.queue.length) mz.qi++;
  else if (mz.repeat === 'all' || !auto) mz.qi = 0;
  else { musicAudio.pause(); musicAudio.currentTime = 0; return; }
  mzStart();
}
function nextSong() { mzHaptic('skip'); if (mz.remote) { mzCmd('next'); return; } mzAdvance(false); }
function prevSong() {
  mzHaptic('skip');
  if (mz.remote) { mzCmd('prev'); return; }
  if (!mz.queue.length) return;
  if (musicAudio.currentTime > 3 || (mz.qi === 0 && mz.repeat !== 'all')) { musicAudio.currentTime = 0; return; }
  mz.qi = mz.qi > 0 ? mz.qi - 1 : mz.queue.length - 1;
  mzStart();
}
function togglePlayMusic() {
  mzHaptic(musicAudio && !musicAudio.paused && !mz.remote ? 'pause' : (mz.remote && mz.rs && mz.rs.st.playing ? 'pause' : 'play'));
  if (mz.remote && mz.rs) { var pl = !mz.rs.st.playing; mzCmd(pl ? 'play' : 'pause'); mzRemoteOptimistic(pl); return; }
  if (!musicAudio) return;
  if (!musicAudio.src && mzCur()) { mzStartCurrent(0); mzTryPlay(null); return; }
  if (!musicAudio || !musicAudio.src) { if (mz.loaded && musicPlaylist.length) mzPlayList(musicPlaylist, 0, true); return; }
  if (musicAudio.paused) { var p = musicAudio.play(); if (p && p.catch) p.catch(function () {}); }
  else musicAudio.pause();
}
function mzStop() {
  if (mz.remote) { mzCmd('pause'); mzCmd('seek', 0); mzRemoteOptimistic(false); mz.rs.st.pos = 0; return; }
  if (musicAudio && musicAudio.src) { musicAudio.pause(); musicAudio.currentTime = 0; } }
function seekMusic() {}

function mzToggleShuffle() {
  mzHaptic('toggle');
  if (mz.remote) { mz.shuffle = !mz.shuffle; mzCmd('shuffle', mz.shuffle); mzUpdateModes(); return; }
  var cur = mzCur();
  mz.shuffle = !mz.shuffle;
  if (cur && mz.queue.length) {
    if (mz.shuffle) {
      mz.origQueue = mz.origQueue || mz.queue.slice();
      mz.queue = mz.queue.slice(0, mz.qi + 1).concat(mzShuffled(mz.queue.slice(mz.qi + 1)));
    } else if (mz.origQueue) {
      var at = mz.origQueue.indexOf(cur);
      if (at >= 0) { mz.queue = mz.origQueue.slice(); mz.qi = at; }
    }
    if (mz.view.type === 'now') mzRender();
  }
  mzUpdateModes(); mzSaveState(true);
}
function mzToggleRepeat() {
  mzHaptic('toggle');
  mz.repeat = mz.repeat === 'off' ? 'all' : mz.repeat === 'all' ? 'one' : 'off'; mzUpdateModes();
  if (mz.remote) mzCmd('repeat', mz.repeat); else mzSaveState(true);
}
function mzUpdateModes() {
  var s = mzEl('wm-shuffle'), r = mzEl('wm-repeat');
  if (s) { s.classList.toggle('on', mz.shuffle); s.setAttribute('aria-pressed', mz.shuffle ? 'true' : 'false'); s.title = mz.shuffle ? 'Shuffle: on' : 'Shuffle: off'; }
  if (r) { r.classList.toggle('on', mz.repeat !== 'off'); r.setAttribute('aria-pressed', mz.repeat !== 'off' ? 'true' : 'false'); r.title = mz.repeat === 'off' ? 'Repeat: off' : mz.repeat === 'all' ? 'Repeat: all songs' : 'Repeat: this song'; r.innerHTML = mz.repeat === 'one' ? MZ_ICON.repeatOne : MZ_ICON.repeat; }
}
function mzQueueNext(t) {
  mzHaptic('queue');
  if (mz.remote) { mzCmd('qnext', t.f); mzToast('Playing next'); return; }
  if (!mzCur()) { mzPlayList([t], 0); return; }
  mz.queue.splice(mz.qi + 1, 0, t); if (mz.origQueue) mz.origQueue.push(t);
  mzToast('Playing next'); mzSaveState(true); if (mz.view.type === 'now') mzRender();
}
function mzQueueAdd(t) {
  mzHaptic('queue');
  if (mz.remote) { mzCmd('qadd', t.f); mzToast('Added to queue'); return; }
  if (!mzCur()) { mzPlayList([t], 0); return; }
  mz.queue.push(t); if (mz.origQueue) mz.origQueue.push(t);
  mzToast('Added to queue'); mzSaveState(true); if (mz.view.type === 'now') mzRender();
}
function mzToggleFav(t) {
  t = t || mzCur(); if (!t) return;
  t.fav = !t.fav; mzHaptic(t.fav ? 'like' : 'unlike');
  fetch('/api/music/favorite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.f, on: t.fav }) })
    .then(function (r) { if (!r.ok) throw new Error(); })
    .catch(function () { t.fav = !t.fav; mzHaptic('warn'); mzToast('Could not update favorite'); mzRender(); });
  document.querySelectorAll('.trk[data-t="' + CSS.escape(t.f) + '"] .star').forEach(function (el) { mzSetStar(el, t.fav); });
  mzSyncHeart();
  if (mz.theme === 'spotify') mzToast(t.fav ? 'Added to Liked Songs' : 'Removed from Liked Songs');
}
function mzSetStar(el, on) {
  el.classList.toggle('on', on);
  el.innerHTML = (mz.theme === 'spotify' && typeof mzSp !== 'undefined' && mzSp) ? mzSp.heart(on) : (on ? '★' : '☆');
}
function mzSyncHeart() {
  var h = mzEl('wm-now-heart'), t = mzCur(); if (!h) return;
  var on = !!(t && t.fav);
  h.classList.toggle('on', on);
  h.innerHTML = typeof mzSp !== 'undefined' && mzSp ? mzSp.heart(on) : '';
}

// volume
function mzApplyVolume() {
  if (musicAudio) { musicAudio.volume = mz.prefs.vol; musicAudio.muted = mz.prefs.muted; }
  var v = mzEl('wm-vol'), m = mzEl('wm-mute');
  if (v) { v.value = Math.round((mz.prefs.muted ? 0 : mz.prefs.vol) * 100); v.style.setProperty('--p', v.value + '%'); }
  if (m) m.innerHTML = (mz.prefs.muted || mz.prefs.vol === 0) ? MZ_ICON.mute : MZ_ICON.vol;
}
function mzToggleMute() { mz.prefs.muted = !mz.prefs.muted; mzSavePrefs(); mzApplyVolume(); }

// ─── audio events + transport UI ─────────────────────────
function mzBindAudio() {
  musicAudio.onplay = function () { mzSaveState(true); mzSetPlayIcon(true); mzVizStart(); if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(true); };
  musicAudio.onpause = function () { mzSaveState(true); mzSetPlayIcon(false); if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(false); };
  musicAudio.onloadedmetadata = function () {
    if (mz.resumeAt) { try { musicAudio.currentTime = Math.min(mz.resumeAt, Math.max(0, musicAudio.duration - 1)); } catch (_) {} mz.resumeAt = 0; }
    var d = mzEl('wm-dur'); if (d) d.textContent = mzFmt(musicAudio.duration);
    if (typeof updateMediaSessionPosition === 'function') updateMediaSessionPosition();
  };
  musicAudio.ontimeupdate = function () {
    var dur = musicAudio.duration, cur = musicAudio.currentTime;
    if (!dur || !isFinite(dur)) return;
    if (!mz.seeking) {
      var pct = cur / dur * 100, sk = mzEl('wm-seek');
      sk.value = Math.round(pct * 10); sk.style.setProperty('--p', pct + '%');
      mzEl('wm-cur').textContent = mzFmt(cur);
      var mf = mzEl('sp-minifill'); if (mf) mf.style.width = pct + '%';
    }
    if (!mz.counted && cur > Math.min(30, dur / 2)) {
      mz.counted = true;
      var t = mzCur();
      if (t) {
        t.pc = (t.pc || 0) + 1; t.lp = Math.floor(Date.now() / 1000);
        fetch('/api/music/played', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.f }) }).catch(function () {});
      }
    }
    mzSaveState(false);
    if (typeof updateMediaSessionPosition === 'function') updateMediaSessionPosition();
  };
  musicAudio.onseeked = function () { mzSaveState(true); };
  musicAudio.onended = function () {
    if (mz.repeat === 'one') { musicAudio.currentTime = 0; musicAudio.play(); return; }
    mzAdvance(true);
  };
  mzApplyVolume();
}
function mzSetPlayIcon(playing) {
  var i = mzEl('wm-play-icon'); if (i) i.innerHTML = playing ? MZ_ICON.pause : MZ_ICON.play;
  var w = document.querySelector('#music-screen .wm'); if (w) w.classList.toggle('paused', !playing);
}
function mzUpdateNow(quiet) {
  var t = mzCur(); if (!t) return;
  mzNowText(t);
  mzEl('wm-now-art').outerHTML = mzArt(t, 160, 'wm-now-art', 'wm-now-art');
  var wA = document.querySelector('#music-screen .wm');
  if (wA) wA.style.setProperty('--wm-amb', t.c ? 'url("' + mzCoverUrl(t.c, 240) + '")' : 'none');     // blurred backdrop behind the glossy glass panels
  if (mz.theme === 'spotify' && typeof mzSp !== 'undefined' && mzSp && mzSp.miniTint) mzSp.miniTint(t);
  mzEl('wm-dur').textContent = mzFmt(t.d); mzEl('wm-cur').textContent = '0:00';
  var sk = mzEl('wm-seek'); sk.value = 0; sk.style.setProperty('--p', '0%');
  if (!quiet) {
    if (typeof updateMediaSessionMusic === 'function') updateMediaSessionMusic(t.t, t.ar, t.c ? mzCoverUrl(t.c, 512) : '');
    if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(true);
  }
  if (mz.view.type === 'now') mzRender(); else mzMarkPlaying();
  mzUpdateModes(); mzSyncHeart();
}

// ─── visualizer: Trap Nation ───────────────────────────────────────────────────────
// The real thing is one solid shape wrapped around the logo: 50 bass bands (25-200 Hz only, mirrored left and
// right into 100 points) joined by straight lines, so every peak is a pointed "horn". Behind the white shape sit
// six more copies in yellow, red, magenta, blue, cyan and green. Each is a slower, time-averaged version of the
// same shape, so when the white one snaps back after a kick the colours linger around its edge: the rainbow rim.
// The cover sits in the middle and swells with the bass. Paused (or mirroring another device) it just breathes.
var MZ_TN_BANDS = 50, MZ_TN_POINTS = 100;
// How much each of the 50 bands (25..200 Hz) is allowed to push the shape out. Bass music keeps most of its punch around
// 50-80 Hz (band ~11, about 40 degrees either side of the top), has little at 25 Hz (a dip at the very top) and
// next to nothing near 200 Hz (the bottom). That is what makes the real shape a pair of horns on top and an empty bottom.
var MZ_TN_WEIGHT = (function () {
  var pts = [[0, 0.22], [4, 0.6], [8, 0.95], [11, 1], [15, 0.85], [20, 0.5], [26, 0.2], [34, 0.07], [42, 0.03], [49, 0.02]], w = [], j, k;
  for (j = 0; j < 50; j++) {
    for (k = 0; k < pts.length - 1 && j > pts[k + 1][0]; k++);
    var a = pts[k], b = pts[k + 1], f = (j - a[0]) / (b[0] - a[0]);
    f = f * f * (3 - 2 * f);                                  // smoothstep between the points
    w.push(a[1] + (b[1] - a[1]) * f);
  }
  return w;
})();
var MZ_TN_COLORS = [[255, 185, 15], [255, 0, 0], [255, 0, 255], [58, 95, 205], [72, 209, 204], [50, 205, 50]];
mz.vz = { img: null, imgId: '', bg: null, col: [250, 45, 72], parts: [], v: [], raw: [], layers: [], hist: [], peak: 0.3, bpeak: 0.12,
  base: 0, kick: 0, prevRaw: 0, lastBeat: 0, beats: 0, t0: 0, R: 0, live: false, fps: 60 };

function mzVizEnsure() {
  if (mz.ac) {
    if (mz.ac.state === 'suspended' && Date.now() - (mz.acTry || 0) > 800) { mz.acTry = Date.now(); try { mz.ac.resume().catch(function () {}); } catch (_) {} }
    return true;
  }
  if (mz.vzFailAt && Date.now() - mz.vzFailAt < 10000) return false;           // a failure is retried later, never remembered forever
  // Routing the element through Web Audio mutes it if the context cannot start, so only do it once the page was tapped
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    mz.ac = new AC();
    var src = mz.ac.createMediaElementSource(musicAudio);
    // fine frequency resolution for the bass range, raw (the shape does its own smoothing), and a narrow dB window so only loud bass counts
    mz.an = mz.ac.createAnalyser(); mz.an.fftSize = 8192; mz.an.smoothingTimeConstant = 0; mz.an.minDecibels = -70; mz.an.maxDecibels = -10;
    src.connect(mz.an); mz.an.connect(mz.ac.destination);
    mz.fdata = new Uint8Array(mz.an.frequencyBinCount);
    if (mz.ac.state === 'suspended') mz.ac.resume().catch(function () {});
    return true;
  } catch (e) { mz.ac = null; mz.vzFailAt = Date.now(); return false; }
}
// the most colourful bright tone of the cover (used to tint the drifting dust)
function mzDominant(img) {
  try {
    var c = document.createElement('canvas'); c.width = c.height = 16;
    var x = c.getContext('2d'); x.drawImage(img, 0, 0, 16, 16);
    var d = x.getImageData(0, 0, 16, 16).data, r = 0, g = 0, b = 0, w = 0;
    for (var i = 0; i < d.length; i += 4) {
      var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      var wt = 0.02 + Math.pow((mx - mn) / (mx || 1), 2) * 4 + (mx > 90 ? 0.15 : 0);
      r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
    }
    r /= w; g /= w; b /= w;
    var m = Math.max(r, g, b);
    if (m < 170 && m > 0) { var f = 170 / m; r *= f; g *= f; b *= f; }
    return [Math.min(255, Math.round(r)), Math.min(255, Math.round(g)), Math.min(255, Math.round(b))];
  } catch (e) { return null; }
}
function mzVizBlur(img) {
  try {
    var c = document.createElement('canvas'); c.width = c.height = 40;
    var x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
    var sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height, sz = Math.min(sw, sh);
    x.drawImage(img, (sw - sz) / 2, (sh - sz) / 2, sz, sz, 0, 0, 40, 40);       // upscaled later: that is the blur
    return c;
  } catch (e) { return null; }
}
function mzVizLoadArt() {
  var t = mzCur(); if (!t || mz.vz.imgId === t.f) return;
  mz.vz.imgId = t.f; mz.vz.img = null; mz.vz.bg = null;
  if (!t.c) { mz.vz.col = [250, 45, 72]; return; }
  var im = new Image();
  im.onload = function () { if (mz.vz.imgId !== t.f) return; mz.vz.img = im; mz.vz.bg = mzVizBlur(im); var c = mzDominant(im); if (c) mz.vz.col = c; };
  im.src = mzCoverUrl(t.c, 500);
}
function mzVizStart() {
  if (mz.view.type !== 'now') return;
  mzVizLoadArt();
  if (mz.vizRaf) return;                                    // already animating; the loop itself connects the audio when it starts playing
  mz.vizRaf = requestAnimationFrame(mzVizLoop);
}
// An error inside the animation must never take the whole app down (any uncaught error shows the crash screen),
// so a failing frame just stops the visualizer after a few tries.
function mzVizLoop(ts) {
  try { mzVizFrame(ts); mz.vzErr = 0; }
  catch (e) {
    console.warn('visualizer frame skipped:', e && e.message);
    mz.vzErr = (mz.vzErr || 0) + 1;
    if (mz.vzErr < 5 && !mz.vizRaf) mz.vizRaf = requestAnimationFrame(mzVizLoop);
  }
}
function mzVizFrame(ts) {
  mz.vizRaf = 0;
  var cv = mzEl('wm-viz');
  if (!cv || mz.view.type !== 'now' || document.hidden) return;
  var V = mz.vz, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) { mz.vizRaf = requestAnimationFrame(mzVizLoop); return; }
  // render at no more than ~0.9 megapixels and let CSS scale it up: keeps it smooth on every machine
  var sc = Math.max(0.5, Math.min(window.devicePixelRatio || 1, Math.sqrt(900000 / (w * h))));
  if (cv.width !== Math.round(w * sc) || cv.height !== Math.round(h * sc)) { cv.width = Math.round(w * sc); cv.height = Math.round(h * sc); }
  var c = cv.getContext('2d'); c.setTransform(sc, 0, 0, sc, 0, 0); c.clearRect(0, 0, w, h);
  var t = ts / 1000, dt = Math.min(0.1, V.t0 ? Math.max(0.001, t - V.t0) : 0.016); V.t0 = t;
  V.fps = V.fps * 0.92 + (1 / dt) * 0.08;
  var lite = V.fps < 28;                                    // slow machine: drop the extras, keep the shape
  mzVizLoadArt();
  var calm = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches), j, k, i;

  // connect the analyser as soon as this device is the one playing (also when playback starts while this page is open)
  var playing = !!(musicAudio && !musicAudio.paused && !mz.remote);
  if (playing && mz.prefs.viz) mzVizEnsure();
  var live = !!(playing && mz.prefs.viz && mz.ac && mz.ac.state === 'running' && mz.an && mz.fdata && isFinite(mz.ac.sampleRate) && mz.an.fftSize > 0);   // bad audio data counts as not live
  V.live = live;
  var NB = MZ_TN_BANDS, NP = MZ_TN_POINTS, raw = V.raw, data = null, binHz = 1;
  if (live) { mz.an.getByteFrequencyData(mz.fdata); data = mz.fdata; binHz = mz.ac.sampleRate / mz.an.fftSize; }

  // ---- 50 bands between 25 and 200 Hz (interpolated between FFT bins)
  var W = MZ_TN_WEIGHT, v = V.v, en = V.en || (V.en = []);
  for (j = 0; j < NB; j++) {
    if (live) {
      var b = (25 + j / (NB - 1) * 175) / binHz, i0 = Math.floor(b), fr = b - i0;
      raw[j] = (data[i0] * (1 - fr) + data[i0 + 1] * fr) / 255 || 0;
      en[j] = Math.pow(raw[j], 2.6) * W[j];                      // contrast: only strong energy counts, then the bass-music weighting
    } else raw[j] = en[j] = 0;
  }
  var bm = 0; for (j = 4; j <= 14; j++) bm += raw[j]; bm /= 11;                      // 40-75 Hz: where kicks live
  var sm = [], top = 0;
  for (j = 0; j < NB; j++) {                                  // smooth with 2 neighbours each side: broad, rounded horns
    var acc = 0, n = 0;
    for (k = -4; k <= 4; k++) { var q = j + k, wq = 5 - Math.abs(k); if (q >= 0 && q < NB) { acc += en[q] * wq; n += wq; } }
    sm[j] = acc / n; if (sm[j] > top) top = sm[j];
  }
  V.peak = Math.max(V.peak * 0.998, top, 0.12);              // follow this track's own loudness: its biggest hit reaches full height
  for (j = 0; j < NB; j++) {
    var val = live ? Math.min(1, Math.max(0, sm[j] / V.peak - 0.14) / 0.86)
      : W[j] * (0.1 + 0.07 * Math.sin(t * 1.3 + j * 0.23) + 0.08 * Math.pow(Math.max(0, Math.sin(t * 2.4)), 4));   // idle: a slow breathing
    v[j] = Math.max(val, (v[j] || 0) * Math.exp(-dt * 11));                                 // snaps up instantly, falls quickly
  }
  // the coloured layers are slower and slower averages of the same shape
  var layers = V.layers;
  for (k = 0; k < MZ_TN_COLORS.length; k++) {
    var L = layers[k] || (layers[k] = []), a = 1 - Math.exp(-dt / (0.07 * (k + 1)));
    for (j = 0; j < NB; j++) L[j] = (L[j] || 0) + (v[j] - (L[j] || 0)) * a;
  }

  // ---- kick: drives the cover's swell, the background zoom and the beat counter
  V.bpeak = Math.max(V.bpeak * 0.996, bm, 0.1);
  var bassNow = bm / V.bpeak;
  V.hist.push(bassNow); if (V.hist.length > 48) V.hist.shift();
  var avg = 0; for (i = 0; i < V.hist.length; i++) avg += V.hist[i]; avg /= V.hist.length;
  if (live && bassNow > 0.62 && bassNow > avg * 1.3 + 0.06 && bassNow - V.prevRaw > 0.06 && t - V.lastBeat > 0.2) {
    if (!calm && !document.hidden && mz.prefs.haptics !== false && mzCanVibrate()) { try { navigator.vibrate(Math.round(14 + bassNow * 22)); } catch (_) {} }   // the phone thumps with the kick
    V.kick = Math.max(V.kick, Math.max(0.5, Math.min(1, (bassNow - avg) * 1.8 + 0.5))); V.lastBeat = t; V.beats++;
  }
  V.prevRaw = bassNow;
  V.kick *= Math.exp(-dt * 8.5);
  V.base = Math.max(V.base * Math.exp(-dt * 9), v[11]);
  var kk = calm ? 0 : V.kick;

  var col = V.col, rgb = col.join(','), cx = w / 2, cy = h * 0.45, base = Math.min(w, h * 0.9);
  var Rc = base * 0.19 * (1 + (calm ? 0 : V.base * 0.16)); V.R = Rc;
  var R0 = Rc * 1.07, H = Rc * 0.95;

  // ---- background: the cover, blurred, nudging in on every kick
  if (V.bg && !lite) {
    var bw = Math.max(w, h) * (1.1 + kk * 0.05);
    c.globalAlpha = 0.3 + kk * 0.1; c.drawImage(V.bg, cx - bw / 2, cy - bw / 2, bw, bw); c.globalAlpha = 1;
  }
  // drifting dust, like the snow in the original
  if (!calm && !lite) {
    if (!V.parts.length) for (k = 0; k < 60; k++) V.parts.push({ x: Math.random() * w, y: Math.random() * h, r: 0.7 + Math.random() * 1.8, vy: -(6 + Math.random() * 18), vx: (Math.random() - 0.5) * 12 });
    var spd = 0.6 + kk * 3;
    c.fillStyle = 'rgba(255,255,255,' + (0.35 + kk * 0.3).toFixed(3) + ')'; c.beginPath();
    for (k = 0; k < V.parts.length; k++) {
      var p = V.parts[k];
      p.y += p.vy * dt * spd; p.x += p.vx * dt * spd;
      if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
      if (p.x < -10) p.x = w + 10; else if (p.x > w + 10) p.x = -10;
      c.moveTo(p.x + p.r, p.y); c.arc(p.x, p.y, p.r, 0, 6.2832);
    }
    c.fill();
  }

  // ---- dizzy: the whole picture jolts on a kick, then sways and wobbles around the cover
  c.save();
  if (!calm) {
    var sway = Math.sin(t * 2.3) * (0.025 + kk * 0.05) + Math.sin(t * 5.1) * kk * 0.02, tr = kk * 0.1 + V.base * 0.035, jx = (Math.random() - 0.5) * tr * Rc, jy = (Math.random() - 0.5) * tr * Rc;   // a fast tremble that follows the bass
    c.translate(cx + jx, cy + jy); c.rotate(sway); c.scale(1 + Math.sin(t * 3.7) * kk * 0.03, 1 + Math.cos(t * 3.1) * kk * 0.03); c.translate(-cx, -cy);
  }
  // ---- the shapes, back to front: green, cyan, blue, magenta, red, yellow, then the white one
  c.lineJoin = 'miter'; c.miterLimit = 8; c.lineWidth = 3;
  var pts = [], trem = calm ? 0 : Math.min(0.14, kk * 0.1 + V.base * 0.05);       // the edge itself buzzes
  function shape(arr, style) {
    c.beginPath();
    for (i = 0; i < NP; i++) {
      var jj = i < NB ? i : NP - 1 - i, th = i / NP * 6.2832, r = R0 + arr[jj] * H * (1 + Math.sin(i * 2.3 + t * 80) * trem) + Math.sin(i * 1.7 - t * 63) * trem * Rc * 0.35 * arr[jj];
      var x = cx + Math.sin(th) * r, y = cy - Math.cos(th) * r;
      pts[i] = [x, y];
    }
    c.moveTo((pts[0][0] + pts[NP - 1][0]) / 2, (pts[0][1] + pts[NP - 1][1]) / 2);       // curve through midpoints: no corners
    for (i = 0; i < NP; i++) { var p2 = pts[(i + 1) % NP]; c.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + p2[0]) / 2, (pts[i][1] + p2[1]) / 2); }
    c.closePath(); c.fillStyle = style; c.strokeStyle = style; c.fill(); c.stroke();
  }
  for (k = MZ_TN_COLORS.length - 1; k >= 0; k--) { var cc = MZ_TN_COLORS[k]; shape(layers[k], 'rgb(' + cc[0] + ',' + cc[1] + ',' + cc[2] + ')'); }
  if (!calm && kk > 0.08 && !lite) {                         // colour fringes slip apart on the hit
    c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = Math.min(0.5, kk * 0.55);
    var fo = kk * Rc * 0.12;
    c.translate(-fo, 0); shape(v, 'rgb(255,30,60)'); c.translate(fo * 2, 0); shape(v, 'rgb(30,210,255)'); c.restore();
  }
  shape(v, '#fff');

  // ---- the cover in the middle, swelling with the bass
  c.save(); c.beginPath(); c.arc(cx, cy, Rc, 0, 6.2832); c.clip();
  if (V.img) {
    var sw = V.img.naturalWidth || V.img.width, sh = V.img.naturalHeight || V.img.height, sz = Math.min(sw, sh);
    c.drawImage(V.img, (sw - sz) / 2, (sh - sz) / 2, sz, sz, cx - Rc, cy - Rc, Rc * 2, Rc * 2);
  } else {
    var fg = c.createLinearGradient(cx - Rc, cy - Rc, cx + Rc, cy + Rc); fg.addColorStop(0, 'rgba(' + rgb + ',.9)'); fg.addColorStop(1, 'rgba(20,20,26,1)');
    c.fillStyle = fg; c.fillRect(cx - Rc, cy - Rc, Rc * 2, Rc * 2);
  }
  c.restore();
  c.restore();
  mz.vizRaf = requestAnimationFrame(mzVizLoop);
}

// ─── context menu ────────────────────────────────────────
function mzCloseMenu() { var m = mzEl('wm-menu'); if (m) m.style.display = 'none'; }
function mzOpenMenu(x, y, id, fromQueue, qIdx) {
  var t = mz.byId.get(id); if (!t) return;
  function it(a, label) { return '<button data-act="m-' + a + '" data-t="' + escapeHtml(id) + '" data-c="' + (qIdx == null ? '' : qIdx) + '">' + label + '</button>'; }
  var m = mzEl('wm-menu');
  var sp = mz.theme === 'spotify';
  m.innerHTML = (sp ? it('queue', 'Add to queue') + it('next', 'Play next') + '<hr>' + it('artist', 'Go to artist') + (t.li ? it('album', 'Go to album') : '') + '<hr>' +
      it('fav', t.fav ? 'Remove from Liked Songs' : 'Save to your Liked Songs') + (fromQueue ? it('remove', 'Remove from queue') : '')
    : it('play', 'Play') + it('next', 'Play next') + it('queue', 'Add to queue') + '<hr>' +
      it('fav', t.fav ? 'Remove from favorites' : 'Add to favorites') + '<hr>' +
      it('artist', 'Go to artist') + (t.li ? it('album', 'Go to album') : '') + (fromQueue ? '<hr>' + it('remove', 'Remove from queue') : ''));
  m.style.display = '';
  var r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
}

// ─── search ──────────────────────────────────────────────
function mzSearch(v) {
  clearTimeout(mz.searchTimer);
  mz.searchTimer = setTimeout(function () {
    mz.query = v;
    if (v.trim() || (mz.theme === 'spotify' && mz.view.type === 'search')) {
      if (!v.trim()) { mzRender(); return; }
      if (mz.view.type !== 'search') { mz.prevView = mz.view; mz.view = { type: 'search', key: '' }; mz.sort = { col: '', dir: 1 }; navSet('music/search'); }
      mzRender();
      var c = mzEl('wm-content'); if (c) c.scrollTop = 0;
    } else if (mz.view.type === 'search') {
      if (mz.theme === 'spotify') { mzRender(); return; }   // Spotify keeps the Browse-all page
      var pv = mz.prevView || { type: mzDefaultType(), key: '' };
      mzGo(pv.type, pv.key);
    }
  }, 120);
}

// ─── themes ──────────────────────────────────────────────
var MZ_NP_ICON = {
  glossy: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  spotify: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z"/></svg>',
};
function mzApplyTheme() {
  var w = document.querySelector('#music-screen .wm'); if (w) w.dataset.mzt = mz.theme;
  var np = mzEl('wm-npbtn'); if (np) np.innerHTML = MZ_NP_ICON[mz.theme];
  var si = mzEl('wm-search-input'); if (si) si.placeholder = mz.theme === 'spotify' ? 'What do you want to play?' : 'Search';
  mzSyncHeart(); mzApplySizes();
  if (mzCur()) mzNowText(mzCur());
  if (typeof mzSp !== 'undefined' && mzSp && mzSp.coverApply) mzSp.coverApply();
}
function mzSetTheme(name) {
  if (name === mz.theme || (name !== 'glossy' && name !== 'spotify')) return;
  var wasDefault = mz.view.type === mzDefaultType() && !mz.view.key;
  mz.theme = name;
  try { localStorage.setItem('mzTheme', name); } catch (_) {}
  mzApplyTheme();
  if (wasDefault || (name !== 'spotify' && (mz.view.type === 'home' || mz.view.type === 'mix'))) {
    mz.view = { type: mzDefaultType(), key: '' }; navReplace(mzRoute(mz.view));
  }
  mz.sort = { col: '', dir: 1 }; mz.sel = -1;
  mzRender();
  var c = mzEl('wm-content'); if (c) c.scrollTop = 0;
  mzHaptic('select');
  mzToast(name === 'spotify' ? 'Theme: Spotify' : 'Theme: Glossy Black');
}
function mzThemeMenu(e) {
  e.stopPropagation();
  var m = mzEl('wm-menu');
  function it(v, label) { return '<button data-act="theme" data-v="' + v + '">' + (mz.theme === v ? '✓ ' : '\u2003') + label + '</button>'; }
  m.innerHTML = '<div class="wm-menu-h">Theme</div>' + it('glossy', 'Glossy Black') + it('spotify', 'Spotify') +
    (typeof navigator.vibrate === 'function' && (mz.coarse || /Android/i.test(navigator.userAgent)) ? '<hr><button data-act="haptics">' + (mz.prefs.haptics === false ? '\u2003' : '✓ ') + 'Vibration feedback</button>' : '') +
    '<hr><button data-act="exit">Back to DeCloud</button>';
  m.style.display = '';
  var r = e.currentTarget.getBoundingClientRect(), mr = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(r.right - mr.width, window.innerWidth - mr.width - 4)) + 'px';
  m.style.top = Math.min(r.bottom + 6, window.innerHeight - mr.height - 4) + 'px';
}
function mzSearchFocus() {
  if (mz.theme === 'spotify' && mz.view.type !== 'search' && mz.loaded) {
    mz.prevView = mz.view; mz.view = { type: 'search', key: '' }; mz.sort = { col: '', dir: 1 };
    navSet('music/search'); mzRender();
  }
}

// ─── resizable panes ─────────────────────────────────────
var MZ_SIDE_DEFAULT = { glossy: 232, spotify: 320 }, MZ_COLLAPSED = 72, MZ_QUEUE_DEFAULT = 290;
function mzClampSide(raw, theme) {
  if (theme === 'spotify') return raw < 150 ? MZ_COLLAPSED : Math.max(240, Math.min(raw, 560));
  return Math.max(180, Math.min(raw, 420));
}
function mzApplySizes() {
  var w = document.querySelector('#music-screen .wm'); if (!w) return;
  var sw = mz.prefs.sideW[mz.theme] || MZ_SIDE_DEFAULT[mz.theme];
  w.style.setProperty('--wm-side-w', sw + 'px');
  w.style.setProperty('--wm-q-w', mz.prefs.queueW + 'px');
  w.classList.toggle('side-collapsed', mz.theme === 'spotify' && sw <= MZ_COLLAPSED + 8);
}
function mzResizeStart(e, handle) {
  e.preventDefault();
  var queue = handle.id === 'wm-qsplit', w = handle.closest('.wm');
  var box = (queue ? handle.parentElement : mzEl('wm-side')).getBoundingClientRect();
  handle.setPointerCapture(e.pointerId); handle.classList.add('drag'); w.classList.add('resizing');
  function move(ev) {
    if (queue) mz.prefs.queueW = Math.round(Math.max(200, Math.min(box.right - ev.clientX, 560)));
    else mz.prefs.sideW[mz.theme] = Math.round(mzClampSide(ev.clientX - box.left, mz.theme));
    mzApplySizes();
  }
  function end() {
    handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
    handle.classList.remove('drag'); w.classList.remove('resizing'); mzSavePrefs();
  }
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}
function mzResizeReset(handle) {
  if (handle.id === 'wm-qsplit') mz.prefs.queueW = MZ_QUEUE_DEFAULT; else mz.prefs.sideW[mz.theme] = MZ_SIDE_DEFAULT[mz.theme];
  mzApplySizes(); mzSavePrefs();
}

// ─── events ──────────────────────────────────────────────
var mzBound = false;
function mzSelect(c) {
  mz.sel = c;
  document.querySelectorAll('#wm-content .trk.sel').forEach(function (r) { r.classList.remove('sel'); });
  var row = document.querySelector('#wm-content .trk[data-c="' + c + '"]');
  if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
}
function mzPlayCtx(c) {
  if (mz.ctx[c]) mzPlayList(mz.ctx, c);
}

function mzBindUI() {
  if (mzBound) return; mzBound = true;
  var root = mzEl('music-screen');

  root.addEventListener('click', function (e) {       // any tap on a control gives a light tick (touch screens only)
    if ((e.pointerType === 'touch' || (e.pointerType !== 'mouse' && mz.coarse)) && e.target.closest('button, [role="button"], [data-act], input[type=range], .wm-nav')) mzHaptic('tick');
  }, true);
  root.addEventListener('click', function (e) {
    if (!e.target.closest('#wm-menu')) mzCloseMenu();
    if (!e.target.closest('#wm-help') && !e.target.closest('#wm-helpbtn')) mzCloseHelp();
    var el = e.target.closest('[data-act]'); if (!el || !root.contains(el)) return;
    var a = el.dataset.act, v = el.dataset.v, c = parseInt(el.dataset.c, 10), tid = el.dataset.t, t = tid ? mz.byId.get(tid) : null;
    switch (a) {
      case 'nav': mzGo(v); break;
      case 'playlist': mzGo('playlist', v); break;
      case 'album': mzGo('album', v); break;
      case 'artist': mzGo('artist', v); break;
      case 'genre': mzGo('genre', v); break;
      case 'row': if (mz.coarse) mzPlayCtx(c); else mzSelect(c); break;
      case 'star': e.stopPropagation(); if (t) mzToggleFav(t); break;
      case 'sort':
        mz.sort = mz.sort.col === v ? { col: v, dir: -mz.sort.dir } : { col: v, dir: 1 };
        mzRender(); break;
      case 'play-all': mz.shuffle = false; mzUpdateModes(); mzPlayList(mz.ctx, 0); break;
      case 'shuffle-all': mzPlayList(mz.ctx, 0, true); break;
      case 'shuffle-lib': mzPlayList(musicPlaylist, 0, true); break;
      case 'q-jump':
        if (mz.remote) { if (mz.queue[c]) mzCmd('jump', mz.queue[c].f); } else { mz.qi = c; mzStart(); }
        break;
      case 'q-clear':
        if (mz.remote) { mzCmd('qclear'); break; }
        mz.queue = mz.queue.slice(mz.qi, mz.qi + 1); mz.qi = mz.queue.length ? 0 : -1; mz.origQueue = null; mzSaveState(true); mzRender(); break;
      case 'm-play': if (t) mzPlayList([t], 0); mzCloseMenu(); break;
      case 'm-next': if (t) mzQueueNext(t); mzCloseMenu(); break;
      case 'm-queue': if (t) mzQueueAdd(t); mzCloseMenu(); break;
      case 'm-fav': if (t) mzToggleFav(t); mzCloseMenu(); break;
      case 'm-artist': mzCloseMenu(); if (t) mzGo('artist', t.ai || t.ar); break;
      case 'm-album': mzCloseMenu(); if (t) mzGo('album', t.li); break;
      case 'm-remove':
        mzCloseMenu();
        if (!isNaN(c) && c !== mz.qi) {
          if (mz.remote) { if (mz.queue[c]) mzCmd('qremove', mz.queue[c].f); break; }
          mz.queue.splice(c, 1); if (c < mz.qi) mz.qi--; mzSaveState(true); mzRender();
        }
        break;
      case 'g-play': e.stopPropagation(); mzPlayCtx(c); break;
      case 'g-more': { e.stopPropagation(); var gr = el.getBoundingClientRect(); mzOpenMenu(gr.left, gr.bottom + 4, tid, false, null); break; }
      case 'g-tip-help': mzDismissTip(); mzToggleHelp(e); break;
      case 'g-tip-ok': mzDismissTip(); break;
      case 'np-album': if (v) mzGo('album', v); break;
      case 'np-artist': if (v) mzGo('artist', v); break;
      case 'theme': mzCloseMenu(); mzSetTheme(v); break;
      case 'xfer': mzCloseMenu(); mzTransfer(v); break;
      case 'haptics': mzCloseMenu(); mzToggleHaptics(); break;
      case 'exit': mzCloseMenu(); goHome(); break;
      default: if (typeof mzSp !== 'undefined' && mzSp && mzSp.click) mzSp.click(a, el, e);
    }
  });
  root.addEventListener('dblclick', function (e) {
    var row = e.target.closest('.trk[data-act="row"]');
    if (row && !e.target.closest('.star')) mzPlayCtx(parseInt(row.dataset.c, 10));
  });
  root.addEventListener('contextmenu', function (e) {
    var row = e.target.closest('.trk[data-t], .wm-q[data-t], .qrow[data-t]');
    if (!row) return;
    e.preventDefault();
    var q = row.classList.contains('wm-q') || row.classList.contains('qrow');
    if (!q) mzSelect(parseInt(row.dataset.c, 10));
    mzOpenMenu(e.clientX, e.clientY, row.dataset.t, q, q ? parseInt(row.dataset.c, 10) : null);
  });
  root.addEventListener('pointerdown', function (e) {
    var h = e.target.closest('.wm-split'); if (h && e.button === 0) mzResizeStart(e, h);
  });
  root.addEventListener('dblclick', function (e) { var h = e.target.closest('.wm-split'); if (h) mzResizeReset(h); });
  root.addEventListener('keydown', function (e) {
    var h = e.target.closest && e.target.closest('.wm-split'); if (!h || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    var d = (e.key === 'ArrowRight' ? 1 : -1) * (h.id === 'wm-qsplit' ? -16 : 16);
    if (h.id === 'wm-qsplit') mz.prefs.queueW = Math.max(200, Math.min(mz.prefs.queueW + d, 560));
    else mz.prefs.sideW[mz.theme] = mzClampSide((mz.prefs.sideW[mz.theme] || MZ_SIDE_DEFAULT[mz.theme]) + d, mz.theme);
    mzApplySizes(); mzSavePrefs();
  });
  window.addEventListener('blur', mzCloseMenu);
  mzEl('wm-content').addEventListener('scroll', mzCloseMenu, { passive: true });

  var sk = mzEl('wm-seek');
  sk.addEventListener('input', function () {
    mz.seeking = true; sk.style.setProperty('--p', sk.value / 10 + '%');
    var dur = mz.remote ? (mzCur() || {}).d : musicAudio.duration;
    if (dur) mzEl('wm-cur').textContent = mzFmt(dur * sk.value / 1000);
  });
  sk.addEventListener('change', function () {
    if (mz.remote) {
      var t = mzCur(); if (t && t.d) { var to = t.d * sk.value / 1000; mzCmd('seek', to); if (mz.rs) { mz.rs.st.pos = to; mz.rs.at = Date.now(); } }
    } else if (musicAudio.duration) musicAudio.currentTime = musicAudio.duration * sk.value / 1000;
    mz.seeking = false; mzHaptic('tick');
  });
  var vol = mzEl('wm-vol');
  vol.addEventListener('input', function () {
    mz.prefs.vol = vol.value / 100; mz.prefs.muted = false; mzSavePrefs(); mzApplyVolume();
    if (mz.remote) mzCmd('vol', mz.prefs.vol);          // volume belongs to the device that is playing
  });

  document.addEventListener('keydown', function (e) {
    if (!mzScreenOpen()) return;
    var typing = /input|textarea|select/i.test(e.target.tagName || '');
    if (e.key === 'Escape') { mzCloseMenu(); mzCloseHelp(); if (typing) e.target.blur(); return; }
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) { e.preventDefault(); mzEl('wm-search-input').focus(); return; }
    if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlayMusic(); }
    else if (e.key === 'ArrowRight' && musicAudio && musicAudio.src) musicAudio.currentTime += 10;
    else if (e.key === 'ArrowLeft' && musicAudio && musicAudio.src) musicAudio.currentTime -= 10;
    else if (e.key === 'ArrowDown') { e.preventDefault(); mzSelect(Math.min(mz.ctx.length - 1, mz.sel + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mzSelect(Math.max(0, mz.sel - 1)); }
    else if (e.key === 'Enter' && mz.sel >= 0) mzPlayCtx(mz.sel);
    else if (e.key === 'n') nextSong();
    else if (e.key === 'p') prevSong();
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) mzVizStart(); });
  mzSetPlayIcon(false); mzUpdateModes(); mzApplyVolume(); mzApplyTheme();
}

// Save position on the way out; and, if a session was saved, bring it back at page load
// (paused, or playing if the browser allows autoplay) even when Music isn't the open screen.
window.addEventListener('pagehide', function () { mzSaveState(true); clearTimeout(mzPushT); mzPush(true); });
document.addEventListener('visibilitychange', function () {
  if (document.hidden) { mzSaveState(true); clearTimeout(mzPushT); mzPush(true); }
  else { if (!mz.ws && mz.loaded) mzConnect(); mzSync(); }
});
window.addEventListener('focus', function () { if (!mz.ws && mz.loaded) mzConnect(); mzSync(); });
(function () {
  function boot() { setTimeout(function () { if (mzHasSavedState()) loadMusic(); else mzFetchSession().then(function (srv) { if (srv) loadMusic(); }); }, 0); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
