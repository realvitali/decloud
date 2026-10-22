// ===== Module: music-spotify =====
// "Spotify" theme renderer for the music player. music.js owns data, playback,
// routing and the theme switch; this file only builds the Spotify-style markup
// (sidebar library, home shelves, entity pages, search, queue) and handles its
// few extra click actions. Styles live in app.css under .wm[data-mzt="spotify"].

var mzSp = (function () {
  var SP = {};
  var libFilter = '', libSort = 'recent', tintCache = {};
  var ME = 'raj';

  function esc(s) { return escapeHtml(s); }
  function dateStr(sec) { return sec ? new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }
  function plural(n, w) { return n.toLocaleString() + ' ' + w + (n === 1 ? '' : 's'); }
  function fitSize(title) { var n = title.length; return n <= 11 ? 96 : n <= 18 ? 72 : n <= 28 ? 48 : 32; }

  var I = {
    home: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M10.533 1.27893C5.35215 1.27893 1.12598 5.41887 1.12598 10.5579C1.12598 15.697 5.35215 19.8369 10.533 19.8369C12.767 19.8369 14.8235 19.0671 16.4402 17.7794L20.7929 22.132C21.1834 22.5226 21.8166 22.5226 22.2071 22.132C22.5976 21.7415 22.5976 21.1083 22.2071 20.7178L17.8634 16.3741C19.1616 14.7849 19.94 12.7634 19.94 10.5579C19.94 5.41887 15.7138 1.27893 10.533 1.27893ZM3.12598 10.5579C3.12598 6.55226 6.42768 3.27893 10.533 3.27893C14.6383 3.27893 17.94 6.55226 17.94 10.5579C17.94 14.5636 14.6383 17.8369 10.533 17.8369C6.42768 17.8369 3.12598 14.5636 3.12598 10.5579Z"/></svg>',
    lib: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zM15.5 2.134A1 1 0 0 0 14 3v18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6.464a1 1 0 0 0-.5-.866l-6-3.464zM9 2a1 1 0 0 0-1 1v18a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1z"/></svg>',
    play: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"/></svg>',
    clock: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z"/><path d="M8 3.25a.75.75 0 0 1 .75.75v3.25H11a.75.75 0 0 1 0 1.5H7.25V4A.75.75 0 0 1 8 3.25z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
    heartOff: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1.69 2A4.582 4.582 0 0 1 8 2.023 4.583 4.583 0 0 1 11.88.817h.002a4.618 4.618 0 0 1 3.782 3.65v.003a4.543 4.543 0 0 1-1.011 3.84L9.35 14.629a1.765 1.765 0 0 1-2.093.464 1.762 1.762 0 0 1-.605-.463L1.348 8.309A4.582 4.582 0 0 1 1.689 2zm3.158.252A3.082 3.082 0 0 0 2.49 7.337l.005.005L7.8 13.664a.264.264 0 0 0 .311.069.262.262 0 0 0 .09-.069l5.312-6.33a3.043 3.043 0 0 0 .68-2.573 3.118 3.118 0 0 0-2.551-2.463 3.079 3.079 0 0 0-2.612.816l-.007.007a1.501 1.501 0 0 1-2.045 0l-.009-.008a3.082 3.082 0 0 0-2.121-.861z"/></svg>',
    heartOn: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M15.724 4.22A4.313 4.313 0 0 0 12.192.814a4.269 4.269 0 0 0-3.622 1.13.837.837 0 0 1-1.14 0 4.272 4.272 0 0 0-6.21 5.855l5.916 7.05a1.128 1.128 0 0 0 1.727 0l5.916-7.05a4.228 4.228 0 0 0 .945-3.577z"/></svg>',
    note: '<svg viewBox="0 0 24 24" width="40%" height="40%" fill="currentColor"><path d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6V3z"/></svg>',
  };
  SP.heart = function (on) { return on ? I.heartOn : I.heartOff; };

  // ─── cover helpers ─────────────────────────────────────
  function cov(id, hue, letter, size, cls, inner) {
    var ch = esc(String(letter == null ? '' : letter).replace(/^[^A-Za-z0-9À-￿]+/, '').charAt(0).toUpperCase() || '♪');
    return '<div class="wm-art sp-art ' + (cls || '') + '" style="--h:' + hue + '">' + (inner || ch) +
      (id ? '<img draggable="false" loading="lazy" decoding="async" alt="" src="' + esc(mzCoverUrl(id, size)) + '" onerror="this.remove()">' : '') + '</div>';
  }
  function trackCov(t, size, cls) { return cov(t.c, t.h, t.al || t.t, size, cls); }
  function albumCov(al, size, cls) { return cov(al.first.c, al.h, al.name, size, cls); }
  function artistCov(a, size, cls) { return cov(a.tracks[0].c, mzHue(a.name), a.name, size, 'round ' + (cls || '')); }
  function likedCov(cls) { return '<div class="wm-art sp-art sp-liked ' + (cls || '') + '">' + I.heartOn.replace('width="16" height="16"', 'width="45%" height="45%"') + '</div>'; }
  function songsCov(cls) { return '<div class="wm-art sp-art sp-allsongs ' + (cls || '') + '">' + I.note + '</div>'; }
  function plCov(pl, size, cls) {
    var first = pl && mz.plCache[pl.id] && mz.byId.get(mz.plCache[pl.id][0]);
    return cov((pl && pl.c) || (first && first.c) || '', mzHue(pl ? pl.name : 'pl'), pl ? pl.name : '♪', size, cls);
  }

  // ─── tint (page header colour from the cover) ──────────
  function colorOf(img) {
    try {
      var c = document.createElement('canvas'); c.width = c.height = 12;
      var x = c.getContext('2d'); x.drawImage(img, 0, 0, 12, 12);
      var d = x.getImageData(0, 0, 12, 12).data, r = 0, g = 0, b = 0, w = 0;
      for (var i = 0; i < d.length; i += 4) {
        var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        var wt = 0.05 + Math.pow((mx - mn) / (mx || 1), 2) * 3;
        r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
      }
      r /= w; g /= w; b /= w;
      var max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2, h = 0, s = 0;
      if (max !== min) {
        var dd = max - min; s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
        if (max === r / 255) h = ((g - b) / 255 / dd + (g < b ? 6 : 0)); else if (max === g / 255) h = ((b - r) / 255 / dd + 2); else h = ((r - g) / 255 / dd + 4);
        h *= 60;
      }
      return 'hsl(' + Math.round(h) + ' ' + Math.round(Math.min(70, Math.max(25, s * 100))) + '% 32%)';
    } catch (e) { return null; }
  }
  function tint(page, coverId, hue) {
    if (!page) return;
    page.style.setProperty('--tint', 'hsl(' + hue + ' 30% 30%)');
    if (!coverId) return;
    if (tintCache[coverId]) { page.style.setProperty('--tint', tintCache[coverId]); return; }
    var img = new Image();
    img.onload = function () { var c = colorOf(img); if (c) { tintCache[coverId] = c; if (page.isConnected) page.style.setProperty('--tint', c); } };
    img.src = mzCoverUrl(coverId, 64);
  }

  // ─── data helpers ──────────────────────────────────────
  function sumDur(list) { return list.reduce(function (s, t) { return s + (t.d || 0); }, 0); }
  function albumsArr() { return Array.from(mz.albums.values()); }
  function albumLastPlayed(al) { return al.tracks.reduce(function (m, t) { return Math.max(m, t.lp || 0); }, 0); }
  function artistPlays(a) { return a.tracks.reduce(function (s, t) { return s + (t.pc || 0); }, 0); }
  function liked() { return musicPlaylist.filter(function (t) { return t.fav; }); }

  function mixes() {
    var all = musicPlaylist, out = [];
    var arts = Array.from(mz.artists.values()).filter(function (a) { return a.tracks.length >= 6 && !/unknown/i.test(a.name); })
      .sort(function (a, b) { return artistPlays(b) - artistPlays(a); }).slice(0, 18);
    var pool = mzShuffled(arts);
    for (var n = 0; n < 3 && pool.length >= 3 * (n + 1); n++) {
      var grp = pool.slice(n * 3, n * 3 + 3), list = [];
      grp.forEach(function (a) { list = list.concat(mzShuffled(a.tracks).slice(0, 14)); });
      list = list.concat(mzShuffled(all).slice(0, 8));
      out.push({ id: 'daily' + (n + 1), title: 'Daily Mix ' + (n + 1), sub: grp.map(function (a) { return a.name; }).join(', ') + ' and more', tracks: mzShuffled(list), hue: [200, 330, 140][n] });
    }
    var rep = all.filter(function (t) { return t.pc >= 2; }).sort(function (a, b) { return b.pc - a.pc; }).slice(0, 50);
    if (rep.length >= 10) out.push({ id: 'onrepeat', title: 'On Repeat', sub: 'Songs you love right now', tracks: rep, hue: 270 });
    var fresh = mzShuffled(all.filter(function (t) { return !t.pc; })).slice(0, 50);
    if (fresh.length >= 10) out.push({ id: 'discover', title: 'Discover Mix', sub: 'Songs you haven\'t played yet', tracks: fresh, hue: 25 });
    out.forEach(function (m) { mz.mixCache[m.id] = m; });
    return out;
  }
  function getMix(id) { if (!mz.mixCache[id]) mixes(); return mz.mixCache[id]; }
  function mixCov(m, size, cls) {
    var t = m.tracks[0];
    return '<div class="wm-art sp-art sp-mix ' + (cls || '') + '" style="--h:' + m.hue + '"><span class="tag">' + esc(m.title) + '</span>' +
      (t && t.c ? '<img loading="lazy" decoding="async" alt="" src="' + esc(mzCoverUrl(t.c, size)) + '" onerror="this.remove()">' : '') + '</div>';
  }

  // ─── building blocks ───────────────────────────────────
  function card(o) {
    return '<div class="sp-cardx" data-act="sp-open" data-k="' + o.k + '" data-v="' + esc(o.v) + '">' +
      '<div class="sp-cover">' + o.cover + '<button class="sp-cardplay" data-act="sp-playctx" data-k="' + o.k + '" data-v="' + esc(o.v) + '" aria-label="Play">' + I.play + '</button></div>' +
      '<div class="sp-ct">' + esc(o.title) + '</div><div class="sp-cs">' + esc(o.sub) + '</div></div>';
  }
  function albumCard(al) { return card({ k: 'album', v: al.id, cover: albumCov(al, 300), title: al.name, sub: (al.year ? al.year + ' • ' : '') + al.artist }); }
  function artistCard(a) { return card({ k: 'artist', v: a.id, cover: artistCov(a, 300), title: a.name, sub: 'Artist' }); }
  function plCard(p) { return card({ k: 'playlist', v: p.id, cover: plCov(p, 300), title: p.name, sub: 'By ' + ME }); }
  function mixCard(m) { return card({ k: 'mix', v: m.id, cover: mixCov(m, 300), title: m.title, sub: m.sub }); }
  function shelf(title, cards, showAll) {
    if (!cards.length) return '';
    return '<section class="sp-shelf"><div class="sp-shelf-h"><h2>' + esc(title) + '</h2>' + (showAll ? '<a data-act="sp-showall" data-v="' + showAll + '">Show all</a>' : '') +
      '</div><div class="sp-cards">' + cards.join('') + '</div></section>';
  }
  function gridSection(title, cards) {
    return '<div class="sp-page"><div class="sp-pbody">' + BACK + '<h1 class="sp-gridtitle">' + esc(title) + '</h1><div class="sp-grid">' + cards.join('') + '</div></div></div>';
  }

  function openTarget(k, v) {
    switch (k) {
      case 'album': mzGo('album', v); break;
      case 'artist': mzGo('artist', v); break;
      case 'playlist': mzGo('playlist', v); break;
      case 'mix': mzGo('mix', v); break;
      case 'liked': mzGo('favorites'); break;
      case 'songs': mzGo('songs'); break;
      case 'genre': mzGo('genre', v); break;
      case 'view': mzGo(v); break;
    }
  }
  function collectionTracks(k, v) {
    switch (k) {
      case 'album': var al = mz.albums.get(v); return al ? al.tracks : [];
      case 'artist': var a = mz.artists.get(v); return a ? a.tracks : [];
      case 'mix': var m = getMix(v); return m ? m.tracks : [];
      case 'liked': return liked();
      case 'songs': return musicPlaylist;
      case 'genre': return mz.genres.get(v) || [];
      case 'playlist': return (mz.plCache[v] || []).map(function (id) { return mz.byId.get(id); }).filter(Boolean);
    }
    return [];
  }
  async function playCollection(k, v) {
    if (k === 'playlist' && !mz.plCache[v]) {
      try { var r = await fetch('/api/music/playlist/' + encodeURIComponent(v)); mz.plCache[v] = (await r.json()).ids || []; } catch (_) { mz.plCache[v] = []; }
    }
    var list = collectionTracks(k, v);
    if (list.length) mzPlayList(list, 0);
  }

  // ─── sidebar ───────────────────────────────────────────
  function libCore() {
    var v = mz.view, items = [];
    function item(k, id, cover, title, sub, on) {
      return '<div class="sp-li' + (on ? ' on' : '') + '" data-act="sp-lib" data-k="' + k + '" data-v="' + esc(id) + '">' + cover + '<div class="sp-lit"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></div></div>';
    }
    var f = libFilter;
    if (!f || f === 'playlists') {
      var nl = liked().length;
      items.push(item('liked', '', likedCov(), 'Liked Songs', 'Playlist • ' + plural(nl, 'song'), v.type === 'favorites'));
      mz.playlists.slice().sort(libSort === 'alpha' ? function (a, b) { return a.name.localeCompare(b.name); } : function () { return 0; }).forEach(function (p) {
        items.push(item('playlist', p.id, plCov(p, 100), p.name, 'Playlist • ' + ME, v.type === 'playlist' && v.key === p.id));
      });
    }
    if (!f || f === 'albums') {
      var al = albumsArr();
      al.sort(libSort === 'alpha' ? function (a, b) { return a.name.localeCompare(b.name); } : function (a, b) { return (albumLastPlayed(b) - albumLastPlayed(a)) || (b.added - a.added); });
      al.slice(0, f ? 400 : 60).forEach(function (a) { items.push(item('album', a.id, albumCov(a, 100), a.name, 'Album • ' + a.artist, v.type === 'album' && v.key === a.id)); });
    }
    if (!f || f === 'artists') {
      var ar = Array.from(mz.artists.values());
      ar.sort(libSort === 'alpha' ? function (a, b) { return a.name.localeCompare(b.name); } : function (a, b) { return artistPlays(b) - artistPlays(a) || b.tracks.length - a.tracks.length; });
      ar.slice(0, f ? 400 : 40).forEach(function (a) { items.push(item('artist', a.id, artistCov(a, 100), a.name, 'Artist', v.type === 'artist' && v.key === a.id)); });
    }
    function chip(k, label) { return '<button class="sp-chip' + (libFilter === k ? ' on' : '') + '" data-act="sp-chip" data-v="' + k + '">' + label + '</button>'; }
    return {
      items: items,
      chips: '<div class="sp-chips">' + chip('playlists', 'Playlists') + chip('artists', 'Artists') + chip('albums', 'Albums') + '</div>',
      tools: '<div class="sp-lib-tools"><button class="sp-sortbtn" data-act="sp-sort">' + (libSort === 'alpha' ? 'Alphabetical' : 'Recents') +
        ' <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M15 14.5H5V13h10v1.5zm0-5.75H5v-1.5h10v1.5zM15 3H5V1.5h10V3zM3 3H1V1.5h2V3zm0 11.5H1V13h2v1.5zm0-5.75H1v-1.5h2v1.5z"/></svg></button></div>',
    };
  }
  function sideHtml() {
    var c = libCore();
    return '<div class="sp-panel sp-lib"><div class="sp-lib-head"><div class="sp-libtitle">' + I.lib + '<span>Your Library</span></div></div>' +
      c.chips + c.tools + '<div class="sp-lib-list">' + c.items.join('') + '</div></div>' +
      '<div class="sp-cp" id="sp-cp"><div class="sp-cp-art" id="sp-cp-art"></div><button class="sp-cp-close" data-act="sp-cover-toggle" aria-label="Hide the album art" title="Hide the album art"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M14.5 4.5 8 11 1.5 4.5l1.06-1.06L8 8.88l5.44-5.44z"/></svg></button></div>';
  }
  var AVATAR = '<button class="sp-mavatar" onclick="mzThemeMenu(event)" aria-label="Account and theme">R</button>';
  var BACK = '<button class="sp-mback" onclick="history.back()" aria-label="Back"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 5 8 12 15 19"/></svg></button>';
  function libraryView() {
    var c = libCore();
    return { html: '<div class="sp-page sp-libpage"><div class="sp-pbody"><div class="sp-mtop">' + AVATAR + '<h1 class="sp-gridtitle">Your Library</h1></div>' +
      c.chips + c.tools + '<div class="sp-lib-list">' + c.items.join('') + '</div></div></div>', hue: 230 };
  }

  // ─── track table ───────────────────────────────────────
  function artistLinks(t) {
    return '<a class="lnk" data-act="artist" data-v="' + esc(t.ai || t.ar) + '">' + esc(t.ar) + '</a>';
  }
  function rowHtml(t, i, o) {
    var cur = mzCur(), playing = cur && cur.f === t.f;
    var n = o.num === 'n' ? (t.n || i + 1) : i + 1;
    var title = '<div class="tt"><b>' + esc(t.t) + '</b><small>' + (o.hideArtist ? '' : artistLinks(t)) + '</small></div>';
    return '<div class="sp-row trk' + (playing ? ' playing' : '') + (mz.sel === i ? ' sel' : '') + (o.cls ? ' ' + o.cls : '') + '" data-act="row" data-c="' + i + '" data-t="' + esc(t.f) + '">' +
      '<span class="c0"><i class="n">' + n + '</i><i class="eq"></i><button class="pl" data-act="play-row" data-c="' + i + '" aria-label="Play">' + I.play + '</button></span>' +
      '<span class="c1">' + (o.cover ? trackCov(t, 100, 'sm') : '') + title + '</span>' +
      (o.album ? '<span class="c-alb"><a class="lnk" data-act="album" data-v="' + esc(t.li) + '">' + esc(t.al) + '</a></span>' : '') +
      (o.date ? '<span class="c-date">' + dateStr(t.a) + '</span>' : '') +
      (o.plays ? '<span class="c-plays">' + (t.pc ? t.pc.toLocaleString() : '') + '</span>' : '') +
      '<span class="c-end"><span class="star' + (t.fav ? ' on' : '') + '" data-act="star" data-t="' + esc(t.f) + '">' + SP.heart(t.fav) + '</span><time>' + mzFmt(t.d) + '</time>' +
      '<span class="more" data-act="sp-more" data-t="' + esc(t.f) + '" aria-label="More"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></span></span></div>';
  }
  function tableHtml(tracks, o) {
    o = o || {};
    var list = o.noSort ? tracks : mzSortList(tracks);
    mz.ctx = list;
    if (!list.length) return '<div class="sp-empty">' + (o.empty || 'Nothing here yet.') + '</div>';
    function th(col, label, cls) {
      var on = mz.sort.col === col;
      return '<span class="' + (cls || '') + (on ? ' on' : '') + '" data-act="sort" data-v="' + col + '">' + label + '</span>';
    }
    var head = '<div class="sp-th"><span class="c0">#</span>' + th('t', 'Title', 'c1') + (o.album ? th('al', 'Album', 'c-alb') : '') + (o.date ? th('a', 'Date added', 'c-date') : '') +
      (o.plays ? th('pc', 'Plays', 'c-plays') : '') + '<span class="c-end">' + th('d', I.clock, 'clk') + '</span></div>';
    var cls = 'sp-tbl' + (o.album ? ' alb' : '') + (o.date ? ' dt' : '') + (o.plays ? ' pl' : '');
    return '<div class="' + cls + '">' + head + list.map(function (t, i) { return rowHtml(t, i, o); }).join('') + '</div>';
  }

  // ─── entity page ───────────────────────────────────────
  function actions() {
    return '<div class="sp-actions"><button class="sp-bigplay" data-act="sp-playpage" aria-label="Play">' + I.play.replace('width="16" height="16"', 'width="24" height="24"') +
      '</button><button class="sp-shufbtn' + (mz.shuffle ? ' on' : '') + '" data-act="sp-shufflepage" title="Shuffle" aria-label="Shuffle">' + I.shuffle + '</button></div>';
  }
  function page(o) {
    var t = o.title;
    var meta = o.meta || '';
    var head = '<div class="sp-phead">' + BACK + '<div class="sp-pcover">' + o.cover + '</div><div class="sp-ptext"><div class="sp-kind">' + esc(o.kind) + '</div>' +
      '<h1 style="font-size:' + fitSize(t) + 'px">' + esc(t) + '</h1><div class="sp-meta">' + meta + '</div></div></div>';
    return { html: '<div class="sp-page" id="sp-page">' + head + '<div class="sp-pbody">' + actions() + (o.body || '') + '</div></div>', tint: o.tint, hue: o.hue || 230 };
  }
  function metaLine(parts, tracks) {
    return parts.concat([plural(tracks.length, 'song') + (tracks.length ? ', ' + mzDur(sumDur(tracks)) : '')]).filter(Boolean).join(' <span class="dot">•</span> ');
  }

  // ─── views ─────────────────────────────────────────────
  function homeView() {
    var h = new Date().getHours(), greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    var recentAlb = albumsArr().filter(albumLastPlayed).sort(function (a, b) { return albumLastPlayed(b) - albumLastPlayed(a); });
    var quick = [{ k: 'liked', v: '', cover: likedCov(), title: 'Liked Songs' }];
    recentAlb.slice(0, 7).forEach(function (al) { quick.push({ k: 'album', v: al.id, cover: albumCov(al, 160), title: al.name }); });
    if (quick.length < 8) mz.playlists.forEach(function (p) { if (quick.length < 8) quick.push({ k: 'playlist', v: p.id, cover: plCov(p, 160), title: p.name }); });
    if (quick.length < 8) albumsArr().sort(function (a, b) { return b.added - a.added; }).forEach(function (al) { if (quick.length < 8) quick.push({ k: 'album', v: al.id, cover: albumCov(al, 160), title: al.name }); });
    var q = '<div class="sp-quicks">' + quick.map(function (x) {
      return '<div class="sp-quick" data-act="sp-open" data-k="' + x.k + '" data-v="' + esc(x.v) + '">' + x.cover + '<b>' + esc(x.title) + '</b>' +
        '<button class="sp-cardplay" data-act="sp-playctx" data-k="' + x.k + '" data-v="' + esc(x.v) + '" aria-label="Play">' + I.play + '</button></div>';
    }).join('') + '</div>';
    var shelves = '';
    var mx = mixes();
    shelves += shelf('Made for ' + ME, mx.map(mixCard));
    shelves += shelf('Recently played', recentAlb.slice(0, 20).map(albumCard), 'albums');
    var topArt = Array.from(mz.artists.values()).filter(function (a) { return !/unknown/i.test(a.name) && a.tracks.length >= 3; })
      .sort(function (a, b) { return artistPlays(b) - artistPlays(a) || b.tracks.length - a.tracks.length; }).slice(0, 20);
    shelves += shelf('Your top artists', topArt.map(artistCard), 'artists');
    shelves += shelf('Recently added', albumsArr().sort(function (a, b) { return b.added - a.added; }).slice(0, 20).map(albumCard), 'albums');
    shelves += shelf('Albums for you', mzShuffled(albumsArr().filter(function (a) { return a.tracks.length >= 4; })).slice(0, 20).map(albumCard), 'albums');
    shelves += shelf('Your playlists', mz.playlists.slice(0, 20).map(plCard));
    return { html: '<div class="sp-page sp-home" id="sp-page"><div class="sp-pbody"><div class="sp-mtop">' + AVATAR + '</div><h1 class="sp-greet">' + greet + '</h1>' + q + shelves + '</div></div>', hue: 150 + (h * 7) % 120 };
  }

  function searchView() {
    var qs = mz.query.trim().toLowerCase();
    if (!qs) {
      var tiles = [];
      var gs = Array.from(mz.genres.entries()).filter(function (g) { return g[1].length >= 6; }).sort(function (a, b) { return b[1].length - a[1].length; }).slice(0, 18);
      var base = [['Liked Songs', 'liked', ''], ['Recently Added', 'view', 'recent'], ['Most Played', 'view', 'played'], ['All Songs', 'songs', ''], ['Artists', 'view', 'artists'], ['Albums', 'view', 'albums']];
      base.forEach(function (b) { tiles.push({ title: b[0], k: b[1], v: b[2], t: null }); });
      gs.forEach(function (g) { tiles.push({ title: g[0], k: 'genre', v: g[0], t: g[1].filter(function (x) { return x.c; })[0] }); });
      return { html: '<div class="sp-page"><div class="sp-pbody"><h2 class="sp-browse">Browse all</h2><div class="sp-tiles">' + tiles.map(function (t) {
        return '<div class="sp-tile" style="--h:' + mzHue(t.title) + '" data-act="sp-open" data-k="' + t.k + '" data-v="' + esc(t.v) + '"><b>' + esc(t.title) + '</b>' +
          (t.t ? '<img loading="lazy" alt="" src="' + esc(mzCoverUrl(t.t.c, 160)) + '" onerror="this.remove()">' : '') + '</div>';
      }).join('') + '</div></div></div>', hue: 220 };
    }
    var terms = qs.split(/\s+/);
    function hit(s) { return terms.every(function (t) { return s.indexOf(t) >= 0; }); }
    var songs = musicPlaylist.filter(function (t) { return hit(t.k); });
    var arts = Array.from(mz.artists.values()).filter(function (a) { return hit(a.name.toLowerCase()); }).sort(function (a, b) { return b.tracks.length - a.tracks.length; });
    var albs = albumsArr().filter(function (a) { return hit((a.name + ' ' + a.artist).toLowerCase()); });
    if (!songs.length && !arts.length && !albs.length) return { html: '<div class="sp-page"><div class="sp-pbody"><div class="sp-empty"><h2>No results found for “' + esc(mz.query) + '”</h2><p>Please make sure your words are spelled correctly, or use fewer or different keywords.</p></div></div></div>', hue: 220 };
    var top;
    var exactArt = arts.filter(function (a) { return a.name.toLowerCase().indexOf(qs) === 0; })[0];
    if (exactArt) top = { cover: artistCov(exactArt, 300), title: exactArt.name, type: 'Artist', k: 'artist', v: exactArt.id };
    else if (albs[0] && (!songs[0] || albs[0].name.toLowerCase().indexOf(qs) === 0)) top = { cover: albumCov(albs[0], 300), title: albs[0].name, type: albs[0].artist, k: 'album', v: albs[0].id, pill: 'Album' };
    else if (songs[0]) top = { cover: trackCov(songs[0], 300), title: songs[0].t, type: songs[0].ar, k: 'song', v: songs[0].f, pill: 'Song' };
    else top = { cover: artistCov(arts[0], 300), title: arts[0].name, type: 'Artist', k: 'artist', v: arts[0].id };
    mz.ctx = songs.slice(0, 300);
    var topHtml = '<div class="sp-topres" data-act="sp-open" data-k="' + top.k + '" data-v="' + esc(top.v) + '">' + top.cover + '<h3>' + esc(top.title) + '</h3><div><span class="pill">' + esc(top.pill || top.type) + '</span>' +
      (top.pill ? ' <span class="dim">' + esc(top.type) + '</span>' : '') + '</div><button class="sp-cardplay" data-act="sp-playctx" data-k="' + (top.k === 'song' ? 'songs1' : top.k) + '" data-v="' + esc(top.v) + '" aria-label="Play">' + I.play + '</button></div>';
    var songRows = mz.ctx.slice(0, 4).map(function (t, i) { return rowHtml(t, i, { cover: true, cls: 'compact' }); }).join('');
    var out = '<div class="sp-page"><div class="sp-pbody"><div class="sp-sr"><div><h2>Top result</h2>' + topHtml + '</div><div><h2>Songs</h2><div class="sp-tbl compact">' + songRows + '</div></div></div>';
    out += shelf('Artists', arts.slice(0, 12).map(artistCard)) + shelf('Albums', albs.slice(0, 12).map(albumCard));
    return { html: out + '</div></div>', hue: 220 };
  }

  function listPage(opts, tracks) {
    var empty = opts.empty;
    var body = tableHtml(tracks, { album: true, date: true, cover: true, empty: empty });
    return page({ kind: opts.kind || 'Playlist', title: opts.title, cover: opts.cover, hue: opts.hue, tint: opts.tint,
      meta: metaLine(opts.metaParts || ['<b>' + ME + '</b>'], tracks), body: body });
  }

  function build() {
    var v = mz.view, all = musicPlaylist;
    switch (v.type) {
      case 'home': return homeView();
      case 'search': return searchView();
      case 'albums': return { html: gridSection('Albums', albumsArr().sort(function (a, b) { return a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name); }).map(albumCard)), hue: 230 };
      case 'artists': return { html: gridSection('Artists', Array.from(mz.artists.values()).sort(function (a, b) { return a.name.localeCompare(b.name); }).map(artistCard)), hue: 230 };
      case 'genres': return searchViewGenres();
      case 'songs': return listPage({ title: 'All Songs', cover: songsCov(), hue: 0 }, all);
      case 'favorites': return listPage({ title: 'Liked Songs', cover: likedCov(), hue: 260, empty: 'Songs you like will appear here. Click the heart next to a song.' }, liked());
      case 'recent': return listPage({ title: 'Recently Added', cover: songsCov(), hue: 150 }, all.slice().sort(function (a, b) { return b.a - a.a; }).slice(0, 200));
      case 'played': return listPage({ title: 'Most Played', cover: songsCov(), hue: 20, empty: 'Play some music and it will show up here.' }, all.filter(function (t) { return t.pc > 0; }).sort(function (a, b) { return b.pc - a.pc; }).slice(0, 200));
      case 'genre': {
        var gt = mz.genres.get(v.key); if (!gt) return missing();
        var f = gt.filter(function (t) { return t.c; })[0];
        return listPage({ kind: 'Genre', title: v.key, cover: f ? trackCov(f, 300) : songsCov(), tint: f && f.c, hue: mzHue(v.key), metaParts: [] }, gt);
      }
      case 'mix': {
        var m = getMix(v.key); if (!m) return missing();
        return listPage({ kind: 'Made for ' + ME, title: m.title, cover: mixCov(m, 300), hue: m.hue, tint: m.tracks[0] && m.tracks[0].c, metaParts: [esc(m.sub)] }, m.tracks);
      }
      case 'playlist': {
        var pl = mz.playlists.filter(function (x) { return x.id === v.key; })[0];
        if (!mz.plCache[v.key]) { mzLoadPlaylist(v.key); return page({ kind: 'Playlist', title: pl ? pl.name : 'Playlist', cover: plCov(pl, 300), hue: 200, meta: 'Loading…', body: '' }); }
        var pt = mz.plCache[v.key].map(function (id) { return mz.byId.get(id); }).filter(Boolean);
        return listPage({ title: pl ? pl.name : 'Playlist', cover: plCov(pl, 300), tint: (pl && pl.c) || (pt[0] && pt[0].c), hue: mzHue(pl ? pl.name : 'p') }, pt);
      }
      case 'album': {
        var al = mz.albums.get(v.key); if (!al) return missing();
        var body = tableHtml(al.tracks, { num: 'n', noSort: !mz.sort.col, hideArtist: al.tracks.every(function (t) { return t.ar === al.artist; }) });
        var by = '<a class="lnk bold" data-act="artist" data-v="' + esc(al.first.ai || al.first.ar) + '">' + trackCov(al.first, 40, 'xs') + esc(al.artist) + '</a>';
        return page({ kind: 'Album', title: al.name, cover: albumCov(al, 400), tint: al.first.c, hue: al.h, meta: metaLine([by, al.year], al.tracks), body: body });
      }
      case 'artist': return artistView();
      case 'now': return queueView();
      case 'library': return libraryView();
    }
    return missing();
  }
  function searchViewGenres() {
    var gs = Array.from(mz.genres.entries()).sort(function (a, b) { return b[1].length - a[1].length; });
    return { html: '<div class="sp-page"><div class="sp-pbody"><h1 class="sp-gridtitle">Genres</h1><div class="sp-tiles">' + gs.map(function (g) {
      var f = g[1].filter(function (x) { return x.c; })[0];
      return '<div class="sp-tile" style="--h:' + mzHue(g[0]) + '" data-act="sp-open" data-k="genre" data-v="' + esc(g[0]) + '"><b>' + esc(g[0]) + '</b>' + (f ? '<img loading="lazy" alt="" src="' + esc(mzCoverUrl(f.c, 160)) + '" onerror="this.remove()">' : '') + '</div>';
    }).join('') + '</div></div></div>', hue: 230 };
  }
  function missing() { return { html: '<div class="sp-page"><div class="sp-pbody"><div class="sp-empty"><h2>Couldn\'t find that page</h2><p>It may have been removed from your library.</p></div></div></div>', hue: 230 }; }

  function artistView() {
    var a = mz.artists.get(mz.view.key); if (!a) return missing();
    var popular = a.tracks.slice().sort(function (x, y) { return (y.pc || 0) - (x.pc || 0) || x.al.localeCompare(y.al) || (x.n || 999) - (y.n || 999); });
    var albums = Array.from(a.albums).sort(function (x, y) { return (y.year || '').localeCompare(x.year || ''); });
    mz.ctx = popular;
    var rows = popular.slice(0, 5).map(function (t, i) { return rowHtml(t, i, { cover: true, plays: true, cls: 'artist' }); }).join('');
    var cover = a.tracks.filter(function (t) { return t.c; })[0];
    var head = '<div class="sp-ahead">' + BACK + '<div class="sp-abg">' + (cover ? '<img alt="" src="' + esc(mzCoverUrl(cover.c, 600)) + '" onerror="this.remove()">' : '') + '</div>' +
      '<div class="sp-ptext"><div class="sp-kind"><svg viewBox="0 0 24 24" width="24" height="24" fill="#4cb3ff"><path d="M10.814.5a1.658 1.658 0 0 1 2.372 0l2.512 2.572 3.595-.043a1.658 1.658 0 0 1 1.678 1.678l-.043 3.595 2.572 2.512c.667.65.667 1.722 0 2.372l-2.572 2.512.043 3.595a1.658 1.658 0 0 1-1.678 1.678l-3.595-.043-2.512 2.572a1.658 1.658 0 0 1-2.372 0l-2.512-2.572-3.595.043a1.658 1.658 0 0 1-1.678-1.678l.043-3.595L.5 13.186a1.658 1.658 0 0 1 0-2.372l2.572-2.512-.043-3.595a1.658 1.658 0 0 1 1.678-1.678l3.595.043L10.814.5zm6.584 9.12a1 1 0 0 0-1.414-1.413l-6.011 6.01-1.894-1.893a1 1 0 0 0-1.414 1.414l3.308 3.308 7.425-7.425z" fill="#4cb3ff"/><path d="M10.5 15.9l-2.4-2.4 1.1-1.1 1.3 1.3 4.3-4.3 1.1 1.1z" fill="#fff"/></svg> Your library artist</div>' +
      '<h1 style="font-size:' + (a.name.length <= 11 ? 96 : a.name.length <= 20 ? 72 : 48) + 'px">' + esc(a.name) + '</h1><div class="sp-meta">' + plural(a.tracks.length, 'song') + ' • ' + mzDur(sumDur(a.tracks)) + '</div></div></div>';
    var body = actions() + '<h2 class="sp-h2">Popular</h2><div class="sp-tbl pl compact art">' + rows + '</div>' +
      (albums.length ? shelf('Discography', albums.map(albumCard)) : '');
    return { html: '<div class="sp-page sp-artistpage" id="sp-page">' + head + '<div class="sp-pbody">' + body + '</div></div>', tint: cover && cover.c, hue: mzHue(a.name) };
  }

  function queueView() {
    var cur = mzCur();
    if (!cur) return { html: '<div class="sp-page"><div class="sp-pbody"><h1 class="sp-gridtitle">Queue</h1><div class="sp-empty"><h2>Nothing in the queue</h2><p>Start playing something and it will show up here.</p></div></div></div>', hue: 230 };
    function qrow(t, i) {
      return '<div class="sp-row qrow compact' + (i === mz.qi ? ' playing' : '') + '" data-act="q-jump" data-c="' + i + '" data-t="' + esc(t.f) + '">' +
        '<span class="c0"><i class="n">' + (i === mz.qi ? '' : i + 1) + '</i><i class="eq"></i><button class="pl" data-act="q-jump" data-c="' + i + '">' + I.play + '</button></span>' +
        '<span class="c1">' + trackCov(t, 100, 'sm') + '<div class="tt"><b>' + esc(t.t) + '</b><small>' + artistLinks(t) + '</small></div></span>' +
        '<span class="c-end"><time>' + mzFmt(t.d) + '</time></span></div>';
    }
    var next = mz.queue.slice(mz.qi + 1, mz.qi + 201);
    var out = '<div class="sp-page"><div class="sp-pbody">' + BACK + '<h1 class="sp-gridtitle">Queue</h1><h2 class="sp-h2">Now playing</h2><div class="sp-tbl compact">' + qrow(cur, mz.qi) + '</div>';
    if (next.length) {
      out += '<div class="sp-qhead"><h2 class="sp-h2">Next in queue</h2><button class="sp-textbtn" data-act="sp-clearq">Clear queue</button></div><div class="sp-tbl compact">' +
        next.map(function (t, n) { return qrow(t, mz.qi + 1 + n); }).join('') + '</div>';
    }
    return { html: out + '</div></div>', hue: 230 };
  }

  // ─── public API ────────────────────────────────────────
  SP.render = function () {
    var content = mzEl('wm-content'); if (!content) return;
    mzEl('wm-side').innerHTML = sideHtml();
    cpTrack = null; SP.coverSync();
    var hb = document.querySelector('#music-screen .sp-homebtn'); if (hb) hb.classList.toggle('on', mz.view.type === 'home');
    var tabOn = mz.view.type === 'home' ? 'home' : mz.view.type === 'search' ? 'search' : mz.view.type === 'library' ? 'library' : '';
    var tb = mzEl('sp-tabbar'); if (tb) tb.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === tabOn); });
    var vw = build(), keep = content.scrollTop, same = mz.view;
    content.innerHTML = (mz.error ? '<div class="sp-notice">' + esc(mz.error) + '</div>' : '') + vw.html;
    if (mz.view === same) content.scrollTop = keep;
    tint(mzEl('sp-page'), vw.tint, vw.hue || 230);
    mzMarkPlaying();
  };
  SP.miniTint = function (t) {
    var w = document.querySelector('#music-screen .wm'); if (!w) return;
    w.style.setProperty('--sp-mini', 'hsl(' + t.h + ' 22% 22%)');
    if (!t.c) return;
    if (tintCache['m' + t.c]) { w.style.setProperty('--sp-mini', tintCache['m' + t.c]); return; }
    var img = new Image();
    img.onload = function () { var c = colorOf(img); if (c) { tintCache['m' + t.c] = c; w.style.setProperty('--sp-mini', c); } };
    img.src = mzCoverUrl(t.c, 64);
  };
  // the big album cover (old Spotify desktop): the little cover in the player bar expands into the sidebar
  var cpTrack = null;
  SP.coverApply = function () {
    var w = rootEl(); if (!w) return;
    var on = mz.theme === 'spotify' && mz.prefs.coverOpen === true;
    w.classList.toggle('cover-open', on);
    var b = mzEl('sp-expand'); if (b) { b.setAttribute('aria-expanded', on ? 'true' : 'false'); }
    cpTrack = null; SP.coverSync();
  };
  SP.coverToggle = function () {
    mz.prefs.coverOpen = !mz.prefs.coverOpen; mzSavePrefs(); SP.coverApply(); mzHaptic('tick');
  };
  SP.coverSync = function () {
    var t = mzCur(), art = mzEl('sp-cp-art'); if (!t || !art || cpTrack === t.f) return;
    cpTrack = t.f;
    art.innerHTML = '<div class="sp-cp-link" data-act="np-album" data-v="' + esc(t.li || '') + '">' + cov(t.c, t.h, t.al || t.t, 640, '') + '</div>';
  };
  SP.markPlaying = function () {
    SP.coverSync();
    var cur = mzCur();
    document.querySelectorAll('#wm-side .sp-li').forEach(function (el) { el.classList.remove('playing'); });
    if (cur) {
      var key = cur.li;
      document.querySelectorAll('#wm-side .sp-li[data-k="album"]').forEach(function (el) { el.classList.toggle('playing', el.dataset.v === key); });
    }
  };
  SP.click = function (a, el, e) {
    var k = el.dataset.k, v = el.dataset.v;
    switch (a) {
      case 'sp-home': mzGo('home'); break;
      case 'sp-search': mzGo('search'); mzEl('wm-search-input').focus(); break;
      case 'sp-chip': libFilter = libFilter === v ? '' : v; if (mz.view.type === 'library') SP.render(); else mzEl('wm-side').innerHTML = sideHtml(); break;
      case 'sp-sort': libSort = libSort === 'recent' ? 'alpha' : 'recent'; if (mz.view.type === 'library') SP.render(); else mzEl('wm-side').innerHTML = sideHtml(); break;
      case 'sp-cover-toggle': SP.coverToggle(); break;
      case 'sp-tab': mzGo(v); if (v === 'search') mzEl('wm-search-input').focus(); break;
      case 'sp-more': { e.stopPropagation(); var rr = el.getBoundingClientRect(); mzOpenMenu(rr.left, rr.bottom, el.dataset.t, false, null); break; }
      case 'sp-lib': case 'sp-open':
        if (k === 'song') { var t = mz.byId.get(v); if (t) mzPlayList([t], 0); } else openTarget(k, v);
        break;
      case 'sp-playctx': {
        e.stopPropagation();
        if (k === 'songs1') { var one = mz.byId.get(v); if (one) mzPlayList([one], 0); } else playCollection(k, v);
        break;
      }
      case 'sp-playpage': mzPlayList(mz.ctx, 0); break;
      case 'sp-shufflepage': mzPlayList(mz.ctx, 0, true); SP.render(); break;
      case 'play-row': e.stopPropagation(); mzPlayCtx(parseInt(el.dataset.c, 10)); break;
      case 'sp-showall': mzGo(v); break;
      case 'sp-clearq':
        if (mz.remote) { mzCmd('qclear'); break; }
        mz.queue = mz.queue.slice(mz.qi, mz.qi + 1); mz.qi = mz.queue.length ? 0 : -1; mz.origQueue = null; mzSaveState(true); mzRender(); break;
    }
  };
  // ─── phone full-screen player: a sheet that follows your finger ──────
  // Swipe up on the mini player to pull it open, swipe down on the player to dismiss it. It tracks the
  // finger 1:1, then snaps (distance or flick speed decides) with an iOS-style ease.
  var npEl = null, npTimer = 0, npHideT = 0, npTrack = null, npLast = {}, lastDragAt = 0, npIsOpen = false;
  var NP = {
    play: '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><polygon points="7 4 20 12 7 20"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  };
  function sheet() { return npEl || (npEl = mzEl('sp-np')); }
  function rootEl() { return document.querySelector('#music-screen .wm'); }
  function sheetH() { var n = sheet(); return (n && n.offsetHeight) || window.innerHeight || 800; }
  function setY(px, anim) {
    var n = sheet(); if (!n) return;
    n.style.transition = anim ? 'transform .42s cubic-bezier(.32,.72,0,1)' : 'none';
    n.style.transform = 'translate3d(0,' + Math.round(px) + 'px,0)';
  }

  SP.npSet = function (open, animate) {
    var n = sheet(), w = rootEl(); if (!n || !w) return;
    clearTimeout(npHideT);
    if (open) {
      if (!mzCur()) return;
      if (!npIsOpen) mzHaptic('open');
      npIsOpen = true;
      n.style.visibility = 'visible'; n.setAttribute('aria-hidden', 'false'); w.classList.add('np-open');
      npSync(true);
      if (animate && !n.classList.contains('shown')) { setY(sheetH(), false); void n.offsetHeight; }   // start from just below the screen
      n.classList.add('shown'); setY(0, animate);
      clearInterval(npTimer); npTimer = setInterval(npSync, 250);
    } else {
      if (npIsOpen) mzHaptic('close');
      npIsOpen = false;
      w.classList.remove('np-open'); n.setAttribute('aria-hidden', 'true'); clearInterval(npTimer);
      setY(sheetH(), animate);
      npHideT = setTimeout(function () { n.style.visibility = 'hidden'; n.classList.remove('shown'); }, animate ? 440 : 0);
    }
  };
  SP.justDragged = function () { return Date.now() - lastDragAt < 400; };
  SP.npQueue = function () {
    SP.npSet(false, true);
    if (nav.cur === 'music/player') navReplace('music/now');          // swap the player's history entry for the queue page
    mz.view = { type: 'now', key: '' }; mz.sel = -1; mz.sort = { col: '', dir: 1 };
    mzRender();
    var c = mzEl('wm-content'); if (c) c.scrollTop = 0;
  };

  // keep the sheet's contents in step with playback (local, or mirrored from another device)
  function npSync(force) {
    var t = mzCur(), n = sheet(); if (!t || !n) return;
    if (force === true || npTrack !== t.f) {
      npTrack = t.f; npLast = {};
      mzEl('sp-np-from').textContent = t.al || t.t;
      mzEl('sp-np-title').textContent = t.t;
      mzEl('sp-np-artist').textContent = t.ar;
      mzEl('sp-np-art').innerHTML = cov(t.c, t.h, t.al || t.t, 640, '');
    }
    var playing = mz.remote ? !!(mz.rs && mz.rs.st.playing) : !!(musicAudio && !musicAudio.paused);
    if (npLast.playing !== playing) { npLast.playing = playing; mzEl('sp-np-play').innerHTML = playing ? NP.pause : NP.play; }
    var fav = !!t.fav;
    if (npLast.fav !== fav) { npLast.fav = fav; var h = mzEl('sp-np-heart'); h.innerHTML = SP.heart(fav); h.classList.toggle('on', fav); }
    mzEl('sp-np-shuffle').classList.toggle('on', !!mz.shuffle);
    var rep = mz.repeat;
    if (npLast.rep !== rep) { npLast.rep = rep; var r = mzEl('sp-np-repeat'); r.innerHTML = rep === 'one' ? MZ_ICON.repeatOne : MZ_ICON.repeat; r.classList.toggle('on', rep !== 'off'); }
    var rem = mz.remote ? 'Listening on ' + mzDevLabel(mz.activeId) : '';
    if (npLast.rem !== rem) { npLast.rem = rem; mzEl('sp-np-remote').textContent = rem; mzEl('sp-np-dev').classList.toggle('on', !!rem); }
    if (!mz.seeking) {
      var pos = mz.remote ? mzRemotePos() : (musicAudio ? musicAudio.currentTime : 0);
      var dur = mz.remote ? t.d : ((musicAudio && isFinite(musicAudio.duration) && musicAudio.duration) || t.d);
      var sk = mzEl('sp-np-seek');
      if (dur) { var pct = Math.min(100, pos / dur * 100); sk.value = Math.round(pct * 10); sk.style.setProperty('--p', pct + '%'); }
      mzEl('sp-np-cur').textContent = mzFmt(pos); mzEl('sp-np-dur').textContent = mzFmt(dur);
    }
  }

  SP.initNP = function () {
    var n = sheet(), w = rootEl(); if (!n || !w) return;
    var tr = w.querySelector('.wm-transport');
    function phone() { return mz.theme === 'spotify' && mzIsMobile(); }

    // seek bar inside the sheet
    var sk = mzEl('sp-np-seek');
    function seekDur() { var t = mzCur(); return mz.remote ? (t && t.d) : ((musicAudio && isFinite(musicAudio.duration) && musicAudio.duration) || (t && t.d)); }
    sk.addEventListener('input', function () { mz.seeking = true; sk.style.setProperty('--p', sk.value / 10 + '%'); var d = seekDur(); if (d) mzEl('sp-np-cur').textContent = mzFmt(d * sk.value / 1000); });
    sk.addEventListener('change', function () { var d = seekDur(); if (d) mzMediaSeekTo(d * sk.value / 1000); mz.seeking = false; mzHaptic('tick'); });
    mzEl('sp-np-more').addEventListener('click', function (e) {
      var t = mzCur(); if (!t) return;
      var r = e.currentTarget.getBoundingClientRect(); mzOpenMenu(r.left, r.bottom, t.f, false, null);
    });

    // dragging
    var g = null;
    function begin(e, from) {
      if (e.target.closest('button, input') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      g = { from: from, id: e.pointerId, el: e.currentTarget, y0: e.clientY, last: { y: e.clientY, t: performance.now() }, v: 0, moved: false };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}      // keeps the drag alive when the pointer leaves the small mini player
    }
    function move(e) {
      if (!g || e.pointerId !== g.id) return;
      var dy = e.clientY - g.y0;                                   // > 0 = finger moving down
      if (!g.moved) {
        if (Math.abs(dy) < 8) return;
        if (g.from === 'mini' && dy > 0) { g = null; return; }    // the mini player only opens upward
        g.moved = true;
        clearTimeout(npHideT);
        n.style.visibility = 'visible'; n.classList.add('shown');
        if (g.from === 'mini') { npSync(true); setY(sheetH(), false); }
      }
      var now = performance.now();
      g.v = 0.6 * g.v + 0.4 * ((e.clientY - g.last.y) / Math.max(1, now - g.last.t));    // px/ms, smoothed
      g.last = { y: e.clientY, t: now };
      var h = sheetH();
      var past = g.from === 'mini' ? (-dy > h * 0.2) : (dy > h * 0.18);          // a small "detent" buzz as you cross the point of no return
      if (past !== g.past) { g.past = past; mzHaptic('detent'); }
      setY(g.from === 'mini' ? Math.max(0, h + dy) : (dy < 0 ? dy * 0.12 : dy), false);    // a little rubber-band if you push up on the open sheet
    }
    function end(e) {
      if (!g || e.pointerId !== g.id) return;
      var d = g; g = null;
      try { d.el.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!d.moved) { if (d.from === 'mini' && phone() && mzCur()) mzNowTap(); return; }   // a tap on the mini player (the click is retargeted by the capture, so handle it here)
      lastDragAt = Date.now();
      var h = sheetH(), dy = e.clientY - d.y0;
      if (d.from === 'mini') {
        if (-dy > h * 0.2 || d.v < -0.4) { navSet('music/player'); SP.npSet(true, true); }
        else SP.npSet(false, true);
      } else if (dy > h * 0.18 || d.v > 0.5) {
        SP.npSet(false, true);
        if (nav.cur === 'music/player' && navCanBack()) history.back(); else navSet(mzRoute(mz.view));
      } else setY(0, true);                                         // not far enough: spring back
    }
    function cancel(e) { if (g && e.pointerId === g.id) { var d = g; g = null; if (d.moved) { if (d.from === 'mini') SP.npSet(false, true); else setY(0, true); } } }
    [tr, n].forEach(function (el, i) {
      if (!el) return;
      el.addEventListener('pointerdown', function (e) { if (phone() && mzCur()) begin(e, i === 0 ? 'mini' : 'sheet'); });
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', cancel);
    });
    window.addEventListener('resize', function () { if (n.classList.contains('shown') && !g) setY(0, false); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', SP.initNP); else SP.initNP();

  return SP;
})();
