// ===== Module: gallery =====
// Gallery: the Camera and Screenshots folders as a photo library (day sections, pinch to zoom the grid, a fast scrubber,
// multi-select) plus the full-screen viewer (swipe, pinch/double-tap zoom, drag down to close, video, info sheet) that the
// Files browser reuses. Depends on ui-kit.js, nav.js.

var GL_TABS = {
  library:     { album: 'camera',      title: 'Library',     filter: 'i', icon: 'photos' },
  videos:      { album: 'camera',      title: 'Videos',      filter: 'v',  icon: 'video' },
  screenshots: { album: 'screenshots', title: 'Screenshots', filter: null, icon: 'screenshot' },
};
var GL_COLS = { narrow: [2, 3, 4, 5, 7], wide: [4, 6, 8, 10, 13] };

var gl = {
  tab: 'library', albums: {}, list: [], sel: new Set(), selecting: false, secs: [], dur: {}, obs: null,
  loadSeq: 0, scrollRaf: 0, railTimer: 0, lp: null, lastSel: -1,
};

function glEl(id) { return document.getElementById(id); }
function glTab() { return GL_TABS[gl.tab] || GL_TABS.library; }
function glNarrow() { return window.matchMedia('(max-width: 700px)').matches; }
function glZoomKey() { return glNarrow() ? 'glZoomN' : 'glZoomW'; }
function glZoomIdx() {
  var arr = glNarrow() ? GL_COLS.narrow : GL_COLS.wide, v = NaN;
  try { v = parseInt(localStorage.getItem(glZoomKey()), 10); } catch (_) {}
  if (isNaN(v)) v = glNarrow() ? 1 : 2;
  return Math.max(0, Math.min(arr.length - 1, v));
}
function glCols() { return (glNarrow() ? GL_COLS.narrow : GL_COLS.wide)[glZoomIdx()]; }

// ── opening / routing ─────────────────────────────────────
function glOpen(tab) {
  if (!GL_TABS[tab]) { try { tab = localStorage.getItem('glTab') || 'library'; } catch (_) { tab = 'library'; } }
  if (!GL_TABS[tab]) tab = 'library';
  showScreen('gallery-screen');
  navSet(tab === 'library' ? 'gallery' : 'gallery/' + tab);
  return glLoad(tab, false);
}
// from the router (back/forward, reload): never pushes history itself
async function glRoute(tab, viewPath) {
  if (!GL_TABS[tab]) tab = 'library';
  await glLoad(tab, false);
  if (viewPath) {
    var i = gl.list.findIndex(function (it) { return it.p === viewPath; });
    if (i >= 0) glbOpen(glCtx(i), true);
  }
}
function glSetTab(tab) {
  if (!GL_TABS[tab] || tab === gl.tab) { var sc = glEl('gl-scroll'); if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  glExitSelect();
  navReplace(tab === 'library' ? 'gallery' : 'gallery/' + tab);
  glLoad(tab, false);
}

async function glLoad(tab, force) {
  var seq = ++gl.loadSeq;
  gl.tab = tab; try { localStorage.setItem('glTab', tab); } catch (_) {}
  glPaintTabs();
  var T = glTab(), grid = glEl('gl-grid'), empty = glEl('gl-empty');
  if (!gl.albums[T.album] || force) {
    if (!gl.albums[T.album]) { grid.innerHTML = glSkeleton(); empty.style.display = 'none'; glEl('gl-sub').textContent = 'Loading…'; }
    try {
      var r = await fetch('/api/gallery/items?album=' + T.album + (force ? '&r=1' : ''));
      var d = await r.json();
      if (seq !== gl.loadSeq) return;
      if (d.error) throw new Error(d.error);
      gl.albums[T.album] = d;
    } catch (e) {
      if (seq !== gl.loadSeq) return;
      grid.innerHTML = '';
      empty.style.display = '';
      empty.innerHTML = '<div class="gl-empty-ico">' + UI_ICON.photos + '</div><div class="gl-empty-t">Couldn\'t load your photos</div><div class="gl-empty-s"></div><button class="ui-btn ui-btn-main" onclick="glLoad(gl.tab,true)">Try again</button>';
      empty.querySelector('.gl-empty-s').textContent = e.message || 'Check your connection.';
      glEl('gl-sub').textContent = '';
      return;
    }
  }
  if (seq !== gl.loadSeq) return;
  var all = (gl.albums[T.album].items || []);
  gl.list = T.filter ? all.filter(function (x) { return x.t === T.filter; }) : all;
  gl.sel = new Set(); gl.lastSel = -1;
  glRender(false);
  glEl('gl-scroll').scrollTop = 0;
  glRailUpdate();
  if (T.filter !== 'i') glLoadDurations(T.album);
}

function glSkeleton() {
  var n = glCols() * 6, h = '<div class="gl-row" style="--cols:' + glCols() + '">';
  for (var i = 0; i < n; i++) h += '<div class="gl-tile gl-skel"></div>';
  return h + '</div>';
}

function glPaintTabs() {
  document.querySelectorAll('#gl-tabs [data-tab]').forEach(function (b) {
    var on = b.dataset.tab === gl.tab;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  glEl('gl-title').textContent = glTab().title;
}

// ── grid ──────────────────────────────────────────────────
function glRender(keepScroll) {
  var sc = glEl('gl-scroll'), grid = glEl('gl-grid'), empty = glEl('gl-empty'), list = gl.list, T = glTab();
  var top = sc.scrollTop, ratio = sc.scrollHeight > sc.clientHeight ? top / (sc.scrollHeight - sc.clientHeight) : 0;
  if (gl.obs) { gl.obs.disconnect(); gl.obs = null; }
  var photos = 0, videos = 0; list.forEach(function (x) { if (x.t === 'v') videos++; else photos++; });
  var parts = []; if (photos) parts.push(uiNum(photos) + (T.album === 'screenshots' ? (photos === 1 ? ' Screenshot' : ' Screenshots') : (photos === 1 ? ' Photo' : ' Photos'))); if (videos) parts.push(uiNum(videos) + (videos === 1 ? ' Video' : ' Videos'));
  glEl('gl-sub').textContent = parts.join(', ');
  if (!list.length) {
    grid.innerHTML = '';
    var missing = gl.albums[T.album] && gl.albums[T.album].missing;
    empty.style.display = '';
    empty.innerHTML = '<div class="gl-empty-ico">' + UI_ICON[T.icon] + '</div><div class="gl-empty-t"></div><div class="gl-empty-s"></div>';
    empty.querySelector('.gl-empty-t').textContent = missing ? 'No ' + (T.album === 'camera' ? 'Camera' : 'Screenshots') + ' folder' : 'Nothing here yet';
    empty.querySelector('.gl-empty-s').textContent = missing ? 'Back up your phone into a folder with that name inside the Files drive.' : 'New ' + (T.filter === 'v' ? 'videos' : T.album === 'screenshots' ? 'screenshots' : 'photos and videos') + ' will show up here.';
    gl.secs = []; return;
  }
  empty.style.display = 'none';
  var html = [], cur = null, k = '', cnt = 0, startI = 0;
  function closeDay() { if (cur !== null) html.push('</div></div>'); }
  for (var i = 0; i < list.length; i++) {
    var it = list[i], dk = uiDayKey(it.d);
    if (dk !== cur) {
      closeDay(); cur = dk;
      html.push('<section class="gl-day" data-k="' + dk + '" data-m="' + uiMonthLabel(it.d) + '"><div class="gl-dayh"><span class="gl-daytxt">' + uiDayLabel(it.d) + '</span>' +
        '<button class="gl-dayck" data-day="' + dk + '" aria-label="Select all from this day">' + UI_ICON.check + '</button></div><div class="gl-row" style="--cols:' + glCols() + '">');
    }
    html.push('<div class="gl-tile' + (gl.sel.has(i) ? ' sel' : '') + '" data-i="' + i + '" role="button" tabindex="0" aria-label="' + (it.t === 'v' ? 'Video, ' : 'Photo, ') + uiDayLabel(it.d) + ', ' + uiTime(it.d) + '">' +
      '<img data-src="' + uiThumbUrl(it) + '" alt="" draggable="false" decoding="async">' +
      (it.t === 'v' ? '<span class="gl-vb">' + UI_ICON.play + '<b data-p="' + escapeHtml(it.p) + '">' + (gl.dur[it.p] ? uiDuration(gl.dur[it.p]) : '') + '</b></span>' : '') +
      '<span class="gl-ck">' + UI_ICON.check + '</span></div>');
  }
  closeDay();
  grid.innerHTML = html.join('');
  glObserve();
  requestAnimationFrame(function () {
    glMeasure();
    if (keepScroll) { var max = sc.scrollHeight - sc.clientHeight; sc.scrollTop = Math.min(max, keepScroll === 'ratio' ? ratio * max : top); }
    glRailUpdate();
  });
  glPaintSelect();
}

function glObserve() {
  var sc = glEl('gl-scroll');
  gl.obs = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      var img = e.target; gl.obs.unobserve(img);
      img.onload = function () { img.classList.add('in'); }; img.onerror = function () { img.classList.add('bad'); };
      img.src = img.dataset.src; img.removeAttribute('data-src');
    });
  }, { root: sc, rootMargin: '700px 0px' });
  glEl('gl-grid').querySelectorAll('img[data-src]').forEach(function (im) { gl.obs.observe(im); });
}

async function glLoadDurations(album) {
  if (gl.durAlbum === album && gl.durDone) return glFillDurations();
  gl.durAlbum = album; gl.durDone = false;
  try {
    var d = await (await fetch('/api/gallery/durations?album=' + album)).json();
    Object.assign(gl.dur, d); gl.durDone = true; glFillDurations();
  } catch (_) {}
}
function glFillDurations() {
  glEl('gl-grid').querySelectorAll('.gl-vb b[data-p]').forEach(function (b) { var s = gl.dur[b.dataset.p]; if (s) b.textContent = uiDuration(s); });
}

// ── scrubber: drag the handle to jump through years and months ──
function glMeasure() {
  var sc = glEl('gl-scroll'), days = glEl('gl-grid').querySelectorAll('.gl-day'), out = [], lastM = '', base = sc.getBoundingClientRect().top - sc.scrollTop;
  days.forEach(function (d) {
    var m = d.dataset.m;
    out.push({ top: d.getBoundingClientRect().top - base, m: m, newMonth: m !== lastM });
    lastM = m;
  });
  gl.secs = out;
  var rail = glEl('gl-rail'), marks = glEl('gl-marks'); marks.innerHTML = '';
  var H = sc.scrollHeight, lastY = '';
  out.forEach(function (s) {
    var y = s.m.slice(-4);
    if (y !== lastY) {
      lastY = y;
      var t = document.createElement('i'); t.textContent = y; t.style.top = (s.top / H * 100) + '%'; marks.appendChild(t);
    }
  });
  rail.classList.toggle('none', H <= sc.clientHeight + 40);
}
function glSecAt(y) {
  var s = gl.secs, lo = 0, hi = s.length - 1, r = 0;
  while (lo <= hi) { var mid = (lo + hi) >> 1; if (s[mid].top <= y + 60) { r = mid; lo = mid + 1; } else hi = mid - 1; }
  return s[r];
}
function glRailUpdate() {
  var sc = glEl('gl-scroll'), rail = glEl('gl-rail'), h = glEl('gl-handle');
  var max = sc.scrollHeight - sc.clientHeight; if (max <= 0) return;
  var f = sc.scrollTop / max, track = rail.clientHeight - 36;
  h.style.transform = 'translateY(' + (f * track) + 'px)';
  var s = glSecAt(sc.scrollTop); if (s) glEl('gl-bubble').textContent = s.m;
}
function glRailShow() {
  var rail = glEl('gl-rail'); rail.classList.add('active');
  clearTimeout(gl.railTimer);
  gl.railTimer = setTimeout(function () { if (!gl.railDrag) rail.classList.remove('active'); }, 1300);
}
function glInitEvents() {
  var sc = glEl('gl-scroll'), grid = glEl('gl-grid'), rail = glEl('gl-rail');
  sc.addEventListener('scroll', function () {
    if (gl.scrollRaf) return;
    gl.scrollRaf = requestAnimationFrame(function () { gl.scrollRaf = 0; glRailUpdate(); glRailShow(); });
  }, { passive: true });

  rail.addEventListener('pointerdown', function (e) {
    gl.railDrag = true; rail.setPointerCapture(e.pointerId); rail.classList.add('active', 'drag'); railMove(e); e.preventDefault();
  });
  rail.addEventListener('pointermove', function (e) { if (gl.railDrag) railMove(e); });
  function railEnd() { if (!gl.railDrag) return; gl.railDrag = false; rail.classList.remove('drag'); glRailShow(); }
  rail.addEventListener('pointerup', railEnd); rail.addEventListener('pointercancel', railEnd);
  function railMove(e) {
    var r = rail.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientY - r.top - 18) / (r.height - 36)));
    sc.scrollTop = f * (sc.scrollHeight - sc.clientHeight);
  }

  // tap / long-press / select on tiles
  grid.addEventListener('pointerdown', function (e) {
    var t = e.target.closest('.gl-tile[data-i]'); if (!t) return;
    gl.lp = { i: +t.dataset.i, x: e.clientX, y: e.clientY, fired: false };
    gl.lp.timer = setTimeout(function () {
      if (!gl.lp) return; gl.lp.fired = true;
      if (!gl.selecting) glEnterSelect();
      glToggle(gl.lp.i, true); uiBuzz(14);
    }, 460);
  });
  grid.addEventListener('pointermove', function (e) {
    if (gl.lp && !gl.lp.fired && Math.hypot(e.clientX - gl.lp.x, e.clientY - gl.lp.y) > 9) { clearTimeout(gl.lp.timer); gl.lp = null; }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) {
    grid.addEventListener(n, function () { if (gl.lp) { clearTimeout(gl.lp.timer); if (!gl.lp.fired) gl.lp = null; } });
  });
  grid.addEventListener('contextmenu', function (e) { if (e.target.closest('.gl-tile')) e.preventDefault(); });
  grid.addEventListener('click', function (e) {
    if (gl.lp && gl.lp.fired) { gl.lp = null; return; }          // the long press already handled this touch
    var ck = e.target.closest('.gl-dayck');
    if (ck) { glSelectDay(ck.dataset.day); return; }
    var t = e.target.closest('.gl-tile[data-i]'); if (!t) return;
    var i = +t.dataset.i;
    if (gl.selecting) { if (e.shiftKey && gl.lastSel >= 0) glSelectRange(gl.lastSel, i); else glToggle(i); }
    else if (e.shiftKey || e.ctrlKey || e.metaKey) { glEnterSelect(); glToggle(i, true); }
    else glbOpen(glCtx(i));
  });
  grid.addEventListener('keydown', function (e) {
    var t = e.target.closest('.gl-tile[data-i]'); if (!t) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); }
  });

  // pinch / ctrl+wheel to change the grid density
  var pinch = null;
  sc.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) pinch = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) };
  }, { passive: true });
  sc.addEventListener('touchmove', function (e) {
    if (!pinch || e.touches.length !== 2) return;
    var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), r = d / pinch.d;
    if (r > 1.22) { glZoom(1); pinch.d = d; uiBuzz(6); } else if (r < 0.82) { glZoom(-1); pinch.d = d; uiBuzz(6); }
    e.preventDefault();
  }, { passive: false });
  sc.addEventListener('touchend', function (e) { if (e.touches.length < 2) pinch = null; }, { passive: true });
  var wheelAcc = 0;
  sc.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault(); wheelAcc += e.deltaY;
    if (wheelAcc > 40) { glZoom(-1); wheelAcc = 0; } else if (wheelAcc < -40) { glZoom(1); wheelAcc = 0; }
  }, { passive: false });
  window.addEventListener('resize', function () { if (navActive('gallery-screen')) { glApplyCols(); glMeasure(); glRailUpdate(); } });

  document.addEventListener('keydown', function (e) {
    if (!navActive('gallery-screen') || glb.open || document.getElementById('ui-confirm')) return;
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === 'Escape' && gl.selecting) { e.preventDefault(); glExitSelect(); }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); glEnterSelect(); gl.list.forEach(function (_, i) { gl.sel.add(i); }); glPaintSelect(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && gl.selecting && gl.sel.size) { e.preventDefault(); glDeleteSelected(); }
    else if (e.key === '+' || e.key === '=') glZoom(1);
    else if (e.key === '-') glZoom(-1);
  });
}

function glApplyCols() {
  var c = glCols();
  glEl('gl-grid').querySelectorAll('.gl-row').forEach(function (r) { r.style.setProperty('--cols', c); });
  glEl('gl-grid').style.setProperty('--cols', c);
}
function glZoom(dir) {                       // dir +1: bigger photos (fewer columns)
  var arr = glNarrow() ? GL_COLS.narrow : GL_COLS.wide, i = glZoomIdx() - dir;
  if (i < 0 || i >= arr.length) return;
  var sc = glEl('gl-scroll'), max = sc.scrollHeight - sc.clientHeight, ratio = max > 0 ? sc.scrollTop / max : 0;
  try { localStorage.setItem(glZoomKey(), i); } catch (_) {}
  glApplyCols();
  requestAnimationFrame(function () { glMeasure(); var m2 = sc.scrollHeight - sc.clientHeight; sc.scrollTop = ratio * m2; glRailUpdate(); });
}

// ── selecting ─────────────────────────────────────────────
function glEnterSelect() { gl.selecting = true; glPaintSelect(); }
function glExitSelect() { gl.selecting = false; gl.sel = new Set(); gl.lastSel = -1; glPaintSelect(); }
function glToggleSelect() { if (gl.selecting) glExitSelect(); else glEnterSelect(); }
function glToggle(i, on) {
  if (on === true) gl.sel.add(i); else if (gl.sel.has(i)) gl.sel.delete(i); else gl.sel.add(i);
  gl.lastSel = i;
  var t = glEl('gl-grid').querySelector('.gl-tile[data-i="' + i + '"]'); if (t) t.classList.toggle('sel', gl.sel.has(i));
  glPaintSelect(true);
}
function glSelectRange(a, b) { var lo = Math.min(a, b), hi = Math.max(a, b); for (var i = lo; i <= hi; i++) gl.sel.add(i); gl.lastSel = b; glPaintSelect(); }
function glSelectDay(dk) {
  var idx = []; gl.list.forEach(function (it, i) { if (String(uiDayKey(it.d)) === String(dk)) idx.push(i); });
  var all = idx.every(function (i) { return gl.sel.has(i); });
  if (!gl.selecting) glEnterSelect();
  idx.forEach(function (i) { if (all) gl.sel.delete(i); else gl.sel.add(i); });
  uiBuzz(8); glPaintSelect();
}
function glPaintSelect(light) {
  var scr = glEl('gallery-screen'), n = gl.sel.size;
  scr.classList.toggle('selecting', gl.selecting);
  glEl('gl-select-btn').textContent = gl.selecting ? 'Done' : 'Select';
  glEl('gl-title').textContent = gl.selecting ? (n ? uiNum(n) + ' selected' : 'Select items') : glTab().title;
  glEl('gl-selbar').classList.toggle('on', gl.selecting);
  glEl('gl-selbar').querySelectorAll('button[data-act]').forEach(function (b) { b.disabled = !n; });
  if (!light) {
    glEl('gl-grid').querySelectorAll('.gl-tile').forEach(function (t) { t.classList.toggle('sel', gl.sel.has(+t.dataset.i)); });
  }
  glEl('gl-grid').querySelectorAll('.gl-day').forEach(function (d) {
    var all = true, any = false;
    d.querySelectorAll('.gl-tile[data-i]').forEach(function (t) { if (gl.sel.has(+t.dataset.i)) any = true; else all = false; });
    var b = d.querySelector('.gl-dayck'); if (b) b.classList.toggle('on', any && all);
  });
}
function glSelectedItems() { return Array.from(gl.sel).sort(function (a, b) { return a - b; }).map(function (i) { return gl.list[i]; }).filter(Boolean); }
function glDownloadSelected() { var it = glSelectedItems(); if (!it.length) return; uiDownload(it); uiToast(it.length === 1 ? 'Downloading…' : 'Downloading ' + it.length + ' files…'); }
async function glDeleteSelected() {
  var items = glSelectedItems(); if (!items.length) return;
  var ok = await uiConfirm(items.length === 1 ? 'Move 1 item to Trash?' : 'Move ' + items.length + ' items to Trash?', 'They go to "file types / trash" in your Files drive, so you can still get them back.', 'Move to Trash', true);
  if (!ok) return;
  var done = await glTrash(items);
  if (done.length) { uiToast(done.length === 1 ? 'Moved to Trash' : done.length + ' moved to Trash'); uiBuzz(12); }
  if (done.length < items.length) uiToast((items.length - done.length) + ' could not be moved');
  glExitSelect();
}
// moves items to Trash; returns the ones that worked and updates every cached list
async function glTrash(items) {
  var done = [], i = 0;
  async function worker() {
    while (i < items.length) {
      var it = items[i++], r = await uiPost('/api/lego/trash', { path: it.p });
      if (r.ok) done.push(it);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (done.length) glForget(done);
  return done;
}
function glForget(items) {
  var gone = new Set(items.map(function (x) { return x.p; }));
  Object.keys(gl.albums).forEach(function (a) { var d = gl.albums[a]; d.items = (d.items || []).filter(function (x) { return !gone.has(x.p); }); });
  var T = glTab(), all = (gl.albums[T.album] && gl.albums[T.album].items) || [];
  gl.list = T.filter ? all.filter(function (x) { return x.t === T.filter; }) : all;
  gl.sel = new Set();
  if (navActive('gallery-screen')) glRender(true);
  if (typeof fm !== 'undefined' && fm.items) fmForget(gone);
}

// ── the viewer ────────────────────────────────────────────
var glb = { open: false, items: [], i: 0, ctx: null, s: 1, tx: 0, ty: 0, dragX: 0, dragY: 0, sl: [], chrome: true, infoOpen: false, origFor: '', busy: false };

function glCtx(i) {
  var tab = gl.tab;
  return {
    items: gl.list, index: i,
    hash: function (it) { return 'gview/' + tab + '/' + it.p; },
    parent: function () { return tab === 'library' ? 'gallery' : 'gallery/' + tab; },
    onDelete: function (done) { glForget(done); },
  };
}

function glbDom() {
  if (glb.root) return;
  glb.root = glEl('glb'); glb.stage = glEl('glb-stage'); glb.track = glEl('glb-track');
  glb.sl = Array.prototype.slice.call(glb.track.querySelectorAll('.glb-slide'));
  initGlbEvents();
}

function glbOpen(ctx, fromRoute) {
  glbDom();
  glb.ctx = ctx; glb.items = ctx.items.slice(); glb.i = Math.max(0, Math.min(glb.items.length - 1, ctx.index || 0));
  if (!glb.items.length) return;
  glb.root.hidden = false; glb.open = true; glb.chrome = true; glb.infoOpen = false;
  glb.root.classList.remove('hide-ui', 'info'); glb.root.classList.add('opening');
  document.documentElement.classList.add('glb-lock');
  glb.s = 1; glb.tx = glb.ty = glb.dragX = glb.dragY = 0;
  glbFill(true);
  requestAnimationFrame(function () { requestAnimationFrame(function () { glb.root.classList.add('show'); glb.root.classList.remove('opening'); }); });
  if (!fromRoute) { var h = ctx.hash(glb.items[glb.i]); if (/^(gview|view)\//.test(nav.cur)) navReplace(h); else navSet(h); }
  glb.root.focus({ preventScroll: true });
}

function glbHide() {
  if (!glb.root || !glb.open) return;
  glb.open = false; glb.root.classList.remove('show', 'info', 'hide-ui');
  glbStopVideo();
  document.documentElement.classList.remove('glb-lock');
  var r = glb.root; setTimeout(function () { if (!glb.open) { r.hidden = true; glb.sl.forEach(function (s) { s.innerHTML = ''; }); } }, 220);
}
function glbClose() {
  if (!glb.open) return;
  if (glb.infoOpen) { glbInfo(false); return; }
  if (/^(gview|view)\//.test(nav.cur)) {
    if (navCanBack()) { history.back(); return; }
    var parent = glb.ctx && glb.ctx.parent ? glb.ctx.parent() : '';
    glbHide(); navSet(parent); return;
  }
  glbHide();
}

function glbItem(k) { var j = glb.i + k; return j >= 0 && j < glb.items.length ? glb.items[j] : null; }

// put the right photos in the three slides and place them
function glbFill(full) {
  var sl = glb.sl;
  glb.sl.forEach(function (s, k) { s.style.transform = 'translate3d(' + ((k - 1) * 100) + '%,0,0)'; });
  if (full) sl.forEach(function (s, k) { glbPaintSlide(s, glbItem(k - 1)); });
  glbActivate();
  glbTop();
  glbPreload();
}
function glbPaintSlide(s, it) {
  s.innerHTML = ''; s.dataset.p = it ? it.p : '';
  if (!it) return;
  var im = document.createElement('img'); im.className = 'glb-img'; im.draggable = false; im.alt = '';
  im.src = uiThumbUrl(it, 'sm');                             // already in the browser cache from the grid
  var big = new Image(); big.onload = function () { if (s.dataset.p === it.p && im.isConnected) { im.src = big.src; im.dataset.big = '1'; glbApply(); } };
  big.src = uiThumbUrl(it, 'md');
  s.appendChild(im);
  if (it.t === 'v') { var b = document.createElement('div'); b.className = 'glb-play'; b.innerHTML = UI_ICON.play; s.appendChild(b); }
}
function glbPreload() { [glbItem(-2), glbItem(2)].forEach(function (it) { if (it) { var i = new Image(); i.src = uiThumbUrl(it, 'md'); } }); }

function glbCurSlide() { return glb.sl[1]; }
function glbCurImg() { return glbCurSlide().querySelector('.glb-img'); }
function glbStopVideo() {
  glb.sl.forEach(function (s) { var v = s.querySelector('video'); if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {} v.remove(); } });
}
function glbActivate() {
  glbStopVideo(); glb.s = 1; glb.tx = glb.ty = 0; glb.origFor = '';
  var it = glb.items[glb.i]; if (!it) return;
  var s = glbCurSlide();
  if (it.t === 'v') {
    var v = document.createElement('video'); v.className = 'glb-video'; v.controls = true; v.playsInline = true; v.preload = 'metadata';
    v.setAttribute('playsinline', ''); v.setAttribute('controlslist', 'nodownload'); v.poster = uiThumbUrl(it, 'md');
    v.src = uiFileUrl(it);
    s.appendChild(v);
    var p = s.querySelector('.glb-play'); if (p) p.style.display = 'none';
    v.addEventListener('play', function () { glb.root.classList.add('hide-ui'); });
    v.addEventListener('pause', function () { if (!v.ended) glb.root.classList.remove('hide-ui'); });
  }
  glbApply();
}

function glbTop() {
  var it = glb.items[glb.i]; if (!it) return;
  glEl('glb-date').textContent = uiDayLabel(it.d); glEl('glb-time').textContent = uiTime(it.d);
  glEl('glb-count').textContent = (glb.i + 1) + ' of ' + glb.items.length;
  glb.root.classList.toggle('first', glb.i === 0); glb.root.classList.toggle('last', glb.i === glb.items.length - 1);
  if (glb.infoOpen) glbInfo(true);
}

function glbApply(anim) {
  glb.track.style.transition = anim ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
  glb.track.style.transform = 'translate3d(' + glb.dragX + 'px,0,0)';
  var im = glbCurImg(), s = glb.s;
  if (im) {
    var dy = Math.max(0, glb.dragY), k = glb.s === 1 && dy ? Math.max(0.55, 1 - dy / 700) : 1;
    im.style.transition = anim ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
    im.style.transform = 'translate3d(' + glb.tx + 'px,' + (glb.ty + glb.dragY) + 'px,0) scale(' + (s * k) + ')';
  }
  var v = glbCurSlide().querySelector('video');
  if (v && glb.dragY) { v.style.transform = 'translate3d(0,' + glb.dragY + 'px,0) scale(' + Math.max(0.55, 1 - glb.dragY / 700) + ')'; } else if (v) v.style.transform = '';
  glb.root.style.setProperty('--glb-bg', String(Math.max(0, 1 - Math.abs(glb.dragY) / 380)));
}

function glbFit() {
  var im = glbCurImg(), vw = glb.stage.clientWidth, vh = glb.stage.clientHeight;
  var nw = (im && im.naturalWidth) || vw, nh = (im && im.naturalHeight) || vh, f = Math.min(vw / nw, vh / nh);
  return { w: nw * f, h: nh * f, vw: vw, vh: vh };
}
function glbClampPan() {
  var f = glbFit(), mx = Math.max(0, (f.w * glb.s - f.vw) / 2), my = Math.max(0, (f.h * glb.s - f.vh) / 2);
  glb.tx = Math.max(-mx, Math.min(mx, glb.tx)); glb.ty = Math.max(-my, Math.min(my, glb.ty));
}
function glbZoomAt(ns, cx, cy, anim) {
  var r = glb.stage.getBoundingClientRect(), fx = cx - r.left - r.width / 2, fy = cy - r.top - r.height / 2;
  ns = Math.max(1, Math.min(6, ns));
  var k = ns / glb.s; glb.tx = fx - (fx - glb.tx) * k; glb.ty = fy - (fy - glb.ty) * k; glb.s = ns;
  if (ns === 1) { glb.tx = glb.ty = 0; }
  glbApply(anim); glbMaybeOriginal();
}
// zoomed in: swap the 1600px preview for the real file
function glbMaybeOriginal() {
  var it = glb.items[glb.i]; if (!it || it.t !== 'i' || glb.s < 1.4 || glb.origFor === it.p) return;
  if (/\.(heic|heif|avif)$/i.test(it.p)) return;
  glb.origFor = it.p;
  var big = new Image(), want = it.p;
  big.onload = function () { var im = glbCurImg(); if (glb.open && glb.items[glb.i] && glb.items[glb.i].p === want && im) { im.src = big.src; glbApply(); } };
  big.src = uiFileUrl(it);
}

function glbGo(dir) {
  if (glb.busy) return;
  var j = glb.i + dir; if (j < 0 || j >= glb.items.length) { glb.dragX = 0; glbApply(true); return; }
  glb.busy = true;
  var w = glb.stage.clientWidth; glb.dragX = -dir * w; glbApply(true);
  setTimeout(function () {
    glb.i = j; glb.dragX = 0;
    if (dir > 0) glb.sl.push(glb.sl.shift()); else glb.sl.unshift(glb.sl.pop());
    glb.track.style.transition = 'none'; glb.track.style.transform = 'translate3d(0,0,0)';
    glb.sl.forEach(function (s, k) { s.style.transform = 'translate3d(' + ((k - 1) * 100) + '%,0,0)'; });
    var fresh = dir > 0 ? 2 : 0; glbPaintSlide(glb.sl[fresh], glbItem(fresh - 1));
    glb.sl.forEach(function (s, k) { var im = s.querySelector('.glb-img'); if (im && k !== 1) im.style.transform = ''; });
    glbActivate(); glbTop(); glbPreload();
    if (glb.ctx) navReplace(glb.ctx.hash(glb.items[glb.i]));
    glb.busy = false;
  }, 260);
}

function glbToggleChrome() { glb.chrome = !glb.chrome; glb.root.classList.toggle('hide-ui', !glb.chrome); }

async function glbInfo(show) {
  glb.infoOpen = show; glb.root.classList.toggle('info', show);
  if (!show) return;
  var it = glb.items[glb.i], box = glEl('glb-info-body'); box.innerHTML = '<div class="glb-info-load">Loading…</div>';
  try {
    var d = await (await fetch('/api/gallery/info?path=' + uiQuery(it.p))).json();
    if (!glb.infoOpen || glb.items[glb.i] !== it) return;
    var rows = [['Date', uiFullDate(d.taken) + ' at ' + uiTime(d.taken)], ['File', d.name], ['Size', uiSize(d.size) + (d.w ? ' · ' + d.w + ' × ' + d.h + (d.w * d.h > 1e6 ? ' (' + (d.w * d.h / 1e6).toFixed(d.w * d.h >= 1e7 ? 0 : 1) + ' MP)' : '') : '')]];
    if (d.dur) rows.push(['Length', uiDuration(d.dur)]);
    if (d.camera) rows.push(['Camera', d.camera]);
    if (d.exposure) rows.push(['Exposure', d.exposure]);
    rows.push(['Location', d.path]);
    box.innerHTML = rows.map(function (r) { return '<div class="glb-info-r"><span>' + escapeHtml(r[0]) + '</span><b>' + escapeHtml(r[1]) + '</b></div>'; }).join('');
  } catch (_) { box.innerHTML = '<div class="glb-info-load">Couldn\'t load details</div>'; }
}

function glbDownload() { var it = glb.items[glb.i]; if (it) { uiDownload([it]); uiToast('Downloading…'); } }
async function glbDelete() {
  var it = glb.items[glb.i]; if (!it) return;
  var wasPlaying = glbCurSlide().querySelector('video'); if (wasPlaying) wasPlaying.pause();
  var ok = await uiConfirm('Move this ' + (it.t === 'v' ? 'video' : 'photo') + ' to Trash?', it.p.split('/').pop() + '\nYou can still get it back from "file types / trash".', 'Move to Trash', true);
  if (!ok) return;
  var r = await uiPost('/api/lego/trash', { path: it.p });
  if (!r.ok) { uiToast('Couldn\'t move it: ' + r.error); return; }
  uiBuzz(12); uiToast('Moved to Trash');
  glb.items.splice(glb.i, 1);
  if (glb.ctx && glb.ctx.onDelete) glb.ctx.onDelete([it]);
  if (!glb.items.length) { glbClose(); return; }
  if (glb.i >= glb.items.length) glb.i = glb.items.length - 1;
  glb.dragX = glb.dragY = 0; glbFill(true);
  if (glb.ctx) navReplace(glb.ctx.hash(glb.items[glb.i]));
}

function initGlbEvents() {
  var st = glb.stage, pts = new Map(), g = null, lastTap = { t: 0, x: 0, y: 0 }, tapTimer = 0;

  function dist() { var a = Array.from(pts.values()); return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
  function mid() { var a = Array.from(pts.values()); return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }; }

  st.addEventListener('pointerdown', function (e) {
    if (glb.busy) return;
    if (e.target.tagName === 'VIDEO') { var r = e.target.getBoundingClientRect(); if (e.clientY > r.bottom - 70) return; }   // the native controls
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { st.setPointerCapture(e.pointerId); } catch (_) {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) g = { mode: null, x0: e.clientX, y0: e.clientY, t0: performance.now(), vx: 0, vy: 0, lx: e.clientX, ly: e.clientY, lt: performance.now(), tx0: glb.tx, ty0: glb.ty, moved: false };
    else if (pts.size === 2 && g) { g.mode = 'pinch'; g.d0 = dist(); g.s0 = glb.s; g.moved = true; glb.dragX = 0; glb.dragY = 0; glbApply(); }
  });
  st.addEventListener('pointermove', function (e) {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    var now = performance.now();
    if (g.mode === 'pinch') {
      if (pts.size < 2) return;
      var m = mid(); glbZoomAt(g.s0 * dist() / g.d0, m.x, m.y);
      return;
    }
    var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    var dt = Math.max(1, now - g.lt); g.vx = (e.clientX - g.lx) / dt; g.vy = (e.clientY - g.ly) / dt; g.lx = e.clientX; g.ly = e.clientY; g.lt = now;
    if (!g.mode) {
      if (Math.hypot(dx, dy) < 7) return;
      g.moved = true;
      g.mode = glb.s > 1.02 ? 'pan' : (Math.abs(dx) > Math.abs(dy) ? 'page' : 'vert');
      var v = glbCurSlide().querySelector('video'); if (v && g.mode !== 'page' && g.mode !== 'vert') g.mode = null;
    }
    if (g.mode === 'page') {
      var edge = (dx > 0 && glb.i === 0) || (dx < 0 && glb.i === glb.items.length - 1);
      glb.dragX = edge ? dx * 0.3 : dx; glbApply();
    } else if (g.mode === 'vert') {
      glb.dragY = dy < 0 ? dy * 0.35 : dy; glbApply();
    } else if (g.mode === 'pan') {
      glb.tx = g.tx0 + dx; glb.ty = g.ty0 + dy; glbApply();
    }
  });
  function up(e) {
    if (!pts.has(e.pointerId)) return;
    var was = pts.size; pts.delete(e.pointerId);
    try { st.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!g) return;
    if (g.mode === 'pinch') {
      if (pts.size === 0 || was === 2) {
        if (glb.s < 1.05) { glb.s = 1; glb.tx = glb.ty = 0; } else glbClampPan();
        glbApply(true);
        if (pts.size === 1) { var rest = Array.from(pts.values())[0]; g = { mode: 'pan', x0: rest.x, y0: rest.y, tx0: glb.tx, ty0: glb.ty, vx: 0, vy: 0, lx: rest.x, ly: rest.y, lt: performance.now(), moved: true }; if (glb.s <= 1.02) g.mode = null; return; }
      }
      g = null; return;
    }
    var w = glb.stage.clientWidth;
    if (g.mode === 'page') {
      var go = (Math.abs(glb.dragX) > w * 0.22 || Math.abs(g.vx) > 0.45) ? (glb.dragX < 0 || g.vx < -0.45 ? 1 : -1) : 0;
      if (go && ((go > 0 && glb.i < glb.items.length - 1) || (go < 0 && glb.i > 0))) glbGo(go); else { glb.dragX = 0; glbApply(true); }
    } else if (g.mode === 'vert') {
      if (glb.dragY > 120 || g.vy > 0.7) { glb.dragY = glb.dragY; glbClose(); setTimeout(function () { glb.dragY = 0; glbApply(); }, 260); }
      else if (glb.dragY < -45) { glb.dragY = 0; glbApply(true); glbInfo(true); }
      else { glb.dragY = 0; glbApply(true); }
    } else if (g.mode === 'pan') { glbClampPan(); glbApply(true); }
    else if (!g.moved) { tap(e); }
    g = null;
  }
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', function (e) { if (pts.has(e.pointerId)) { pts.delete(e.pointerId); g = null; glb.dragX = glb.dragY = 0; glbApply(true); } });

  function tap(e) {
    var now = performance.now(), isVideo = e.target.tagName === 'VIDEO' || !!glbCurSlide().querySelector('video');
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(tapTimer); lastTap.t = 0;
      if (!isVideo) { if (glb.s > 1.02) glbZoomAt(1, e.clientX, e.clientY, true); else glbZoomAt(2.6, e.clientX, e.clientY, true); glbClampPan(); glbApply(true); }
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (isVideo) return;
    clearTimeout(tapTimer); tapTimer = setTimeout(glbToggleChrome, 260);
  }

  st.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (e.ctrlKey) { glbZoomAt(glb.s * Math.exp(-e.deltaY * 0.012), e.clientX, e.clientY); glbClampPan(); glbApply(); }
    else if (glb.s > 1.02) { glb.tx -= e.deltaX; glb.ty -= e.deltaY; glbClampPan(); glbApply(); }
    else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 24) { var t = Date.now(); if (t - (glb.wheelT || 0) > 380) { glb.wheelT = t; glbGo(e.deltaX > 0 ? 1 : -1); } }
  }, { passive: false });

  glb.root.addEventListener('keydown', function (e) {
    if (document.getElementById('ui-confirm')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); glbGo(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); glbGo(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); glbClose(); }
    else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); glbInfo(!glb.infoOpen); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); glbDelete(); }
    else if (e.key === '+' || e.key === '=') glbZoomAt(glb.s * 1.4, st.clientWidth / 2, st.clientHeight / 2, true);
    else if (e.key === '-') { glbZoomAt(glb.s / 1.4, st.clientWidth / 2, st.clientHeight / 2, true); glbClampPan(); glbApply(true); }
    else if (e.key === '0') glbZoomAt(1, 0, 0, true);
  });
  window.addEventListener('resize', function () { if (glb.open) { glbClampPan(); glbApply(); } });
}

// the markup precedes the scripts, so wire up right away (before desktop.js, whose Escape-goes-home must see our preventDefault)
if (glEl('gl-grid')) { glInitEvents(); glPaintTabs(); glApplyCols(); }
