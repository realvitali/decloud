// ===== Module: lego (Files) =====
// A Finder / Nautilus style browser: sidebar of places, path bar, list and icon views, sortable columns,
// type-to-filter, keyboard navigation, context menu. Photos and videos open in the shared viewer from gallery.js.
var legoCurrentPath = '';
var fm = {
  items: [], view: 'list', sortKey: 'name', sortDir: 1, q: '', sel: new Set(), anchor: -1, seq: 0, shown: [],
  places: [], backup: '', isRoot: false, ptype: 'mouse', loading: false, counts: 0,
};
(function () {
  try { fm.view = localStorage.getItem('fmView') === 'grid' ? 'grid' : 'list'; var s = (localStorage.getItem('fmSort') || 'name:1').split(':'); fm.sortKey = ['name', 'date', 'size', 'kind'].indexOf(s[0]) >= 0 ? s[0] : 'name'; fm.sortDir = s[1] === '-1' ? -1 : 1; } catch (_) {}
})();

var FM_IMG = 'jpg jpeg png gif webp bmp heic heif avif'.split(' ');
var FM_VID = 'mp4 mov m4v webm mkv 3gp avi'.split(' ');
var FM_AUD = 'mp3 wav flac ogg m4a aac opus'.split(' ');
var FM_DOC = 'pdf txt md doc docx odt rtf epub'.split(' ');
var FM_ARC = 'zip 7z tar gz rar bz2 xz'.split(' ');
var FM_CODE = 'py js ts html css json xml yaml yml sh c cpp h java rs go'.split(' ');

function fmEl(id) { return document.getElementById(id); }
function fmKindOf(it) {
  if (it.is_dir) return 'Folder';
  var e = it.ext;
  if (FM_IMG.indexOf(e) >= 0) return 'Image';
  if (FM_VID.indexOf(e) >= 0) return 'Video';
  if (FM_AUD.indexOf(e) >= 0) return 'Audio';
  if (e === 'pdf') return 'PDF';
  if (FM_DOC.indexOf(e) >= 0) return 'Document';
  if (FM_ARC.indexOf(e) >= 0) return 'Archive';
  if (FM_CODE.indexOf(e) >= 0) return 'Code';
  return e ? e.toUpperCase() + ' file' : 'File';
}
function fmIconOf(it) {
  if (it.is_dir) return UI_ICON.folder;
  var k = fmKindOf(it);
  return k === 'Image' ? UI_ICON.image : k === 'Video' ? UI_ICON.video : k === 'Audio' ? UI_ICON.music : (k === 'Document' || k === 'PDF') ? UI_ICON.doc : k === 'Archive' ? UI_ICON.archive : k === 'Code' ? UI_ICON.code : UI_ICON.file;
}
function fmIsMedia(it) { return !it.is_dir && (FM_IMG.indexOf(it.ext) >= 0 || FM_VID.indexOf(it.ext) >= 0); }
function fmShortDate(ts) {
  if (!ts) return '';
  var d = new Date(ts * 1000), n = new Date();
  var s = d.getDate() + ' ' + UI_MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  var h = d.getHours(), m = d.getMinutes();
  return s + (d.getFullYear() === n.getFullYear() ? ', ' + (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h >= 12 ? 'PM' : 'AM') : '');
}

// ── loading ───────────────────────────────────────────────
// loadLego('') is the top of the tree, loadLego() with no argument opens the default place (the home folder)
async function loadLego(path, opts) {
  var dflt = path === undefined || path === null;
  path = dflt ? '' : path;
  var seq = ++fm.seq;
  if (!dflt) { legoCurrentPath = path; if (!(opts && opts.silent)) navSet('lego/' + path); }
  fm.q = ''; var qi = fmEl('fm-q'); if (qi) qi.value = '';
  fm.sel = new Set(); fm.anchor = -1; fm.loading = true;
  fmCloseMenu(); fmPaintChrome();
  var list = fmEl('lego-list');
  list.className = 'fm-list';
  list.innerHTML = '<div class="fm-skel">' + Array(9).fill('<div class="fm-skel-row"><i></i><b></b><s></s></div>').join('') + '</div>';
  fmEl('fm-status').textContent = '';
  try {
    var r = await fetch('/api/lego/browse?' + (dflt ? '' : 'path=' + encodeURIComponent(path) + '&') + 'per_page=5000');
    var data = await r.json();
    if (seq !== fm.seq) return;
    if (data.error) throw new Error(data.error);
    fm.items = data.items || []; fm.loading = false;
    fm.places = data.places || []; fm.backup = data.backup || ''; fm.isRoot = !!data.is_root;
    if (dflt) { legoCurrentPath = data.path || ''; if (!(opts && opts.silent)) navReplace('lego/' + legoCurrentPath); }
    fmPaintChrome(data.breadcrumbs);
    fmRender();
    fmLoadCounts(seq);
  } catch (e) {
    if (seq !== fm.seq) return;
    fm.loading = false; fm.items = [];
    list.className = 'fm-list';
    list.innerHTML = '<div class="fm-empty"><div class="fm-empty-ico">' + UI_ICON.folder + '</div><div class="fm-empty-t">Couldn\'t open this folder</div><div class="fm-empty-s"></div><button class="ui-btn ui-btn-main" onclick="loadLego(legoCurrentPath,{silent:true})">Try again</button></div>';
    list.querySelector('.fm-empty-s').textContent = e.message || 'Something went wrong.';
    fmPaintChrome();
  }
}

function fmCrumbs(bc) {
  if (!bc) { bc = [{ name: fm.isRoot ? 'Computer' : 'Files', path: '' }]; legoCurrentPath.split('/').filter(Boolean).forEach(function (p, i, a) { bc.push({ name: p, path: a.slice(0, i + 1).join('/') }); }); }
  var el = fmEl('lego-breadcrumbs');
  el.innerHTML = bc.map(function (b, i) {
    var last = i === bc.length - 1;
    return (i ? '<span class="fm-sep">' + UI_ICON.fwd + '</span>' : '') + '<button class="fm-crumb' + (last ? ' on' : '') + '" data-path="' + escapeHtml(b.path) + '"' + (last ? ' aria-current="page"' : '') + '>' + escapeHtml(b.name) + '</button>';
  }).join('');
  el.scrollLeft = el.scrollWidth;
}

function fmPaintChrome(bc) {
  fmCrumbs(bc);
  fmEl('fm-up').disabled = !legoCurrentPath;
  fmEl('fm-v-list').classList.toggle('on', fm.view === 'list'); fmEl('fm-v-grid').classList.toggle('on', fm.view === 'grid');
  fmEl('fm-back').disabled = !navCanBack();
  // sidebar
  var side = fmEl('fm-side'), cur = legoCurrentPath;
  var ICO = { home: UI_ICON.home, desktop: UI_ICON.file, documents: UI_ICON.doc, downloads: UI_ICON.download, pictures: UI_ICON.image, music: UI_ICON.music, videos: UI_ICON.video, backup: UI_ICON.archive, camera: UI_ICON.camera, screenshots: UI_ICON.screenshot };
  function place(nm, path, ic) { var on = path === cur || (path && cur.indexOf(path + '/') === 0 && !fm.places.some(function (q) { return q.path.length > path.length && (cur === q.path || cur.indexOf(q.path + '/') === 0); })); return '<button class="fm-place' + (on ? ' on' : '') + '" data-path="' + escapeHtml(path) + '">' + ic + '<span>' + escapeHtml(nm) + '</span></button>'; }
  var h = '<div class="fm-side-h">Places</div>';
  fm.places.forEach(function (p) { h += place(p.name, p.path, ICO[p.icon] || UI_ICON.folder); });
  if (fm.isRoot) h += place('Computer', '', UI_ICON.server || UI_ICON.folder);
  h += '<div class="fm-side-h">Library</div><button class="fm-place" data-go="gallery">' + UI_ICON.photos + '<span>Gallery</span></button>';
  side.innerHTML = h;
}

// ── sort / filter ─────────────────────────────────────────
function fmSorted() {
  var q = fm.q.trim().toLowerCase(), k = fm.sortKey, d = fm.sortDir;
  var a = fm.items.filter(function (x) { return !q || x.name.toLowerCase().indexOf(q) >= 0; });
  a.sort(function (x, y) {
    if (x.is_dir !== y.is_dir) return x.is_dir ? -1 : 1;                                       // folders first, like Nautilus
    var c = 0;
    if (k === 'date') c = (x.mtime || 0) - (y.mtime || 0);
    else if (k === 'size') c = (x.is_dir ? 0 : x.size) - (y.is_dir ? 0 : y.size);
    else if (k === 'kind') c = fmKindOf(x).localeCompare(fmKindOf(y));
    if (!c) c = x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' });
    return c * (k === 'name' ? d : d);
  });
  return a;
}

function fmRender() {
  var list = fmEl('lego-list'), items = fm.shown = fmSorted();
  list.className = 'fm-list ' + (fm.view === 'grid' ? 'fm-grid' : 'fm-rows');
  var head = fmEl('fm-head');
  head.style.display = fm.view === 'list' ? '' : 'none';
  function th(key, label) { return '<button class="fm-th' + (fm.sortKey === key ? ' on' : '') + '" data-sort="' + key + '">' + label + (fm.sortKey === key ? '<span class="fm-arrow">' + (fm.sortDir > 0 ? UI_ICON.up : UI_ICON.down) + '</span>' : '') + '</button>'; }
  head.innerHTML = '<span></span>' + th('name', 'Name') + th('date', 'Date Modified') + th('size', 'Size') + th('kind', 'Kind');
  if (!items.length) {
    list.innerHTML = '<div class="fm-empty"><div class="fm-empty-ico">' + (fm.q ? UI_ICON.search : UI_ICON.folder) + '</div><div class="fm-empty-t">' + (fm.q ? 'No results' : 'This folder is empty') + '</div><div class="fm-empty-s">' + (fm.q ? 'Nothing here matches "' + escapeHtml(fm.q) + '".' : '') + '</div></div>';
    fmStatus(); return;
  }
  var html = [];
  items.forEach(function (it, i) {
    var media = fmIsMedia(it), ph = '<span class="fm-ico' + (it.is_dir ? ' dir' : '') + '">' + fmIconOf(it) + '</span>';
    var thumb = media ? '<img class="fm-th-img" data-src="' + uiThumbUrl({ p: it.path, m: it.mtime }) + '" alt="" draggable="false" decoding="async">' : '';
    var sub = it.is_dir ? (it.child_count > 0 ? it.child_count + ' items' : '') : uiSize(it.size);
    html.push('<div class="fm-row' + (fm.sel.has(i) ? ' sel' : '') + '" role="option" tabindex="-1" data-i="' + i + '" data-dir="' + (it.is_dir ? 1 : 0) + '">' +
      '<span class="fm-icon">' + ph + thumb + '</span>' +
      '<span class="fm-name"><b>' + escapeHtml(it.name) + '</b><small>' + escapeHtml(fmShortDate(it.mtime)) + (sub ? ' · ' + sub : '') + '</small></span>' +
      '<span class="fm-date">' + escapeHtml(fmShortDate(it.mtime)) + '</span>' +
      '<span class="fm-size" data-sz="' + i + '">' + (it.is_dir ? (it.child_count > 0 ? it.child_count + ' items' : '') : uiSize(it.size)) + '</span>' +
      '<span class="fm-kind">' + fmKindOf(it) + '</span></div>');
  });
  list.innerHTML = html.join('');
  fmThumbs();
  fmStatus();
}

function fmThumbs() {
  if (fm.obs) fm.obs.disconnect();
  fm.obs = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      var im = e.target; fm.obs.unobserve(im);
      im.onload = function () { im.classList.add('in'); }; im.onerror = function () { im.remove(); };
      im.src = im.dataset.src; im.removeAttribute('data-src');
    });
  }, { root: fmEl('lego-list'), rootMargin: '400px 0px' });
  fmEl('lego-list').querySelectorAll('img[data-src]').forEach(function (im) { fm.obs.observe(im); });
}

function fmStatus() {
  var n = fm.shown.length, sel = Array.from(fm.sel).map(function (i) { return fm.shown[i]; }).filter(Boolean), t = '';
  if (sel.length) {
    var sz = sel.reduce(function (a, x) { return a + (x.is_dir ? 0 : x.size); }, 0);
    t = sel.length + ' of ' + uiNum(n) + ' selected' + (sz ? ', ' + uiSize(sz) : '');
  } else {
    var files = fm.shown.filter(function (x) { return !x.is_dir; }), total = files.reduce(function (a, x) { return a + x.size; }, 0);
    t = uiNum(n) + (n === 1 ? ' item' : ' items') + (total ? ', ' + uiSize(total) : '');
    if (fm.q) t += ' matching "' + fm.q + '"';
  }
  fmEl('fm-status').textContent = t;
}

// number of items inside each folder, fetched quietly (cached on the server)
async function fmLoadCounts(seq) {
  var dirs = fm.items.filter(function (x) { return x.is_dir && x.child_count === -1; }), i = 0;
  async function worker() {
    while (i < dirs.length) {
      if (seq !== fm.seq) return;
      var d = dirs[i++];
      try {
        var info = await (await fetch('/api/lego/folder_info?path=' + encodeURIComponent(d.path))).json();
        if (seq !== fm.seq) return;
        d.child_count = info.child_count || 0;
        var idx = fm.shown.indexOf(d);
        if (idx >= 0) {
          var row = fmEl('lego-list').querySelector('.fm-row[data-i="' + idx + '"]');
          if (row) {
            var txt = d.child_count > 0 ? d.child_count + ' items' : 'Empty';
            row.querySelector('.fm-size').textContent = txt;
            var sm = row.querySelector('small'); sm.textContent = fmShortDate(d.mtime) + ' · ' + txt;
          }
        }
      } catch (_) {}
    }
  }
  await Promise.all([worker(), worker(), worker()]);
}

function fmSearch(v) { fm.q = v || ''; fm.sel = new Set(); fmRender(); }
function fmSetView(v) { fm.view = v; try { localStorage.setItem('fmView', v); } catch (_) {} fmPaintChrome(); fmRender(); }
function fmSetSort(key) {
  if (fm.sortKey === key) fm.sortDir = -fm.sortDir; else { fm.sortKey = key; fm.sortDir = key === 'date' || key === 'size' ? -1 : 1; }
  try { localStorage.setItem('fmSort', fm.sortKey + ':' + fm.sortDir); } catch (_) {}
  fm.sel = new Set(); fmRender();
}
function fmBack() { if (navCanBack()) history.back(); else if (legoCurrentPath) fmUp(); }
function fmUp() { if (!legoCurrentPath) return; loadLego(legoCurrentPath.split('/').slice(0, -1).join('/')); }

// ── selection / opening ───────────────────────────────────
function fmPaintSel() {
  fmEl('lego-list').querySelectorAll('.fm-row').forEach(function (r) { r.classList.toggle('sel', fm.sel.has(+r.dataset.i)); });
  fmStatus();
}
function fmSelectOnly(i, scroll) {
  fm.sel = new Set(i >= 0 ? [i] : []); fm.anchor = i; fmPaintSel();
  if (scroll && i >= 0) { var r = fmEl('lego-list').querySelector('.fm-row[data-i="' + i + '"]'); if (r) r.scrollIntoView({ block: 'nearest' }); }
}
function fmOpenItem(it) {
  if (!it) return;
  if (it.is_dir) { loadLego(it.path); return; }
  if (fmIsMedia(it)) {
    var media = fm.shown.filter(fmIsMedia).map(fmAsMedia), idx = media.findIndex(function (m) { return m.p === it.path; }), folder = legoCurrentPath;
    glbOpen({
      items: media, index: Math.max(0, idx),
      hash: function (m) { return 'view/' + m.p; },
      parent: function () { return 'lego/' + folder; },
      onDelete: function (done) { fmForget(new Set(done.map(function (x) { return x.p; }))); },
    });
    return;
  }
  uiDownload([{ p: it.path }]);
  uiToast('Downloading ' + it.name + '…');
}
function fmAsMedia(it) { return { p: it.path, t: FM_VID.indexOf(it.ext) >= 0 ? 'v' : 'i', d: it.taken || it.mtime || 0, s: it.size, m: it.mtime }; }
// after the viewer / gallery deletes things
function fmForget(gone) {
  fm.items = fm.items.filter(function (x) { return !gone.has(x.path); });
  if (navActive('lego-screen')) { fm.sel = new Set(); fmRender(); }
}

async function fmTrashSelected() {
  var sel = Array.from(fm.sel).map(function (i) { return fm.shown[i]; }).filter(function (x) { return x && !x.is_dir; });
  if (!sel.length) { uiToast('Only files can be moved to Trash'); return; }
  var ok = await uiConfirm(sel.length === 1 ? 'Move "' + sel[0].name + '" to Trash?' : 'Move ' + sel.length + ' items to Trash?', 'They go to "file types / trash", so you can still get them back.', 'Move to Trash', true);
  if (!ok) return;
  var done = new Set(), bad = 0;
  for (var i = 0; i < sel.length; i++) { var r = await uiPost('/api/lego/trash', { path: sel[i].path }); if (r.ok) done.add(sel[i].path); else bad++; }
  if (done.size) { fmForget(done); if (typeof glForget === 'function') glForget(Array.from(done).map(function (p) { return { p: p }; })); uiToast(done.size === 1 ? 'Moved to Trash' : done.size + ' moved to Trash'); }
  if (bad) uiToast(bad + ' could not be moved');
}
async function fmPoofSelected() {
  var sel = Array.from(fm.sel).map(function (i) { return fm.shown[i]; }).filter(function (x) { return x && !x.is_dir; });
  var done = new Set();
  for (var i = 0; i < sel.length; i++) { var r = await uiPost('/api/lego/poof', { path: sel[i].path }); if (r.ok) done.add(sel[i].path); }
  if (done.size) { fmForget(done); uiToast(done.size + ' poofed'); }
}
async function fmShredSelected() {
  var sel = Array.from(fm.sel).map(function (i) { return fm.shown[i]; }).filter(function (x) { return x && !x.is_dir; });
  if (!sel.length) return;
  var ok = await uiConfirm('Permanently shred ' + (sel.length === 1 ? '"' + sel[0].name + '"' : sel.length + ' files') + '?', 'This cannot be undone.', 'Shred', true);
  if (!ok) return;
  var done = new Set();
  for (var i = 0; i < sel.length; i++) { var r = await uiPost('/api/lego/shred', { path: sel[i].path }); if (r.ok) done.add(sel[i].path); else uiToast('Shred failed: ' + r.error); }
  if (done.size) { fmForget(done); uiToast(done.size + ' shredded'); }
}
async function markFolderDone() {
  if (!legoCurrentPath) return;
  var name = legoCurrentPath.split('/').pop();
  var ok = await uiConfirm('Mark "' + name + '" as done?', 'It is renamed to "' + name + ' (MANUALLY DONE)" and moved into "manually done".', 'Mark as done', false);
  if (!ok) return;
  var r = await uiPost('/api/lego/mark_done', { path: legoCurrentPath });
  if (!r.ok) { uiToast(r.error); return; }
  loadLego(legoCurrentPath.split('/').slice(0, -1).join('/'));
}

// ── menus ─────────────────────────────────────────────────
function fmCloseMenu() { var m = fmEl('fm-menu'); if (m) m.hidden = true; }
function fmShowMenu(x, y, entries) {
  var m = fmEl('fm-menu'); m.innerHTML = '';
  entries.forEach(function (e) {
    if (e === '-') { m.appendChild(document.createElement('hr')); return; }
    var b = document.createElement('button'); b.className = e.danger ? 'danger' : ''; if (e.on) b.classList.add('on');
    b.innerHTML = (e.icon || '<span class="fm-mi"></span>') + '<span></span>'; b.lastChild.textContent = e.label;
    b.addEventListener('click', function () { fmCloseMenu(); e.run(); });
    m.appendChild(b);
  });
  m.hidden = false;
  var r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
}
function fmSortMenu(ev) {
  var r = ev.currentTarget.getBoundingClientRect();
  var names = { name: 'Name', date: 'Date Modified', size: 'Size', kind: 'Kind' };
  var e = Object.keys(names).map(function (k) { return { label: names[k] + (fm.sortKey === k ? (fm.sortDir > 0 ? '  ↑' : '  ↓') : ''), on: fm.sortKey === k, run: function () { fmSetSort(k); } }; });
  fmShowMenu(r.right - 190, r.bottom + 6, e);
}
function fmMoreMenu(ev) {
  var r = ev.currentTarget.getBoundingClientRect(), e = [
    { label: 'Swipe to clean up this folder', icon: UI_ICON.swipe, run: function () { openSwipeMode(legoCurrentPath); } },
    { label: 'Open Gallery', icon: UI_ICON.photos, run: function () { glOpen(); } },
    { label: 'Refresh', icon: UI_ICON.search, run: function () { loadLego(legoCurrentPath, { silent: true }); } },
  ];
  if (fm.backup && legoCurrentPath.indexOf(fm.backup + '/') === 0 && legoCurrentPath.indexOf(fm.backup + '/manually done') !== 0) e.push('-', { label: 'Mark folder as done…', icon: UI_ICON.check, run: markFolderDone });
  fmShowMenu(r.right - 230, r.bottom + 6, e);
}
function fmItemMenu(x, y) {
  var sel = Array.from(fm.sel).map(function (i) { return fm.shown[i]; }).filter(Boolean), one = sel.length === 1 ? sel[0] : null, files = sel.filter(function (s) { return !s.is_dir; });
  var e = [];
  if (one) e.push({ label: one.is_dir ? 'Open' : fmIsMedia(one) ? 'View' : 'Download', icon: UI_ICON[one.is_dir ? 'folder' : 'image'], run: function () { fmOpenItem(one); } });
  if (files.length) e.push({ label: files.length > 1 ? 'Download ' + files.length + ' files' : 'Download', icon: UI_ICON.download, run: function () { uiDownload(files.map(function (f) { return { p: f.path }; })); } });
  if (files.length) e.push('-', { label: 'Move to Trash', icon: UI_ICON.trash, danger: true, run: fmTrashSelected }, { label: 'Poof', icon: UI_ICON.swipe, run: fmPoofSelected }, { label: 'Shred…', icon: UI_ICON.trash, danger: true, run: fmShredSelected });
  if (e.length) fmShowMenu(x, y, e);
}

// ── events ────────────────────────────────────────────────
function fmInit() {
  var list = fmEl('lego-list'), screen = fmEl('lego-screen');
  if (!list) return;
  list.addEventListener('pointerdown', function (e) { fm.ptype = e.pointerType || 'mouse'; });
  list.addEventListener('click', function (e) {
    var row = e.target.closest('.fm-row'); if (!row) { if (e.target === list) fmSelectOnly(-1); return; }
    var i = +row.dataset.i, it = fm.shown[i];
    if (fm.ptype !== 'mouse') { fmOpenItem(it); return; }                       // touch / pen: one tap opens
    if (e.shiftKey && fm.anchor >= 0) { fm.sel = new Set(); for (var k = Math.min(fm.anchor, i); k <= Math.max(fm.anchor, i); k++) fm.sel.add(k); fmPaintSel(); }
    else if (e.ctrlKey || e.metaKey) { if (fm.sel.has(i)) fm.sel.delete(i); else fm.sel.add(i); fm.anchor = i; fmPaintSel(); }
    else fmSelectOnly(i);
  });
  list.addEventListener('dblclick', function (e) { var row = e.target.closest('.fm-row'); if (row && fm.ptype === 'mouse') fmOpenItem(fm.shown[+row.dataset.i]); });
  list.addEventListener('contextmenu', function (e) {
    var row = e.target.closest('.fm-row'); if (!row) return;
    e.preventDefault();
    var i = +row.dataset.i; if (!fm.sel.has(i)) fmSelectOnly(i);
    fmItemMenu(e.clientX, e.clientY);
  });
  // long press on touch = context menu
  var lp = null;
  list.addEventListener('touchstart', function (e) {
    var row = e.target.closest('.fm-row'); if (!row) return;
    var t = e.touches[0]; lp = { x: t.clientX, y: t.clientY, i: +row.dataset.i };
    lp.timer = setTimeout(function () { if (!lp) return; fm.sel = new Set([lp.i]); fmPaintSel(); uiBuzz(14); fmItemMenu(lp.x, lp.y); lp.fired = true; }, 520);
  }, { passive: true });
  list.addEventListener('touchmove', function (e) { if (lp && !lp.fired) { var t = e.touches[0]; if (Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 9) { clearTimeout(lp.timer); lp = null; } } }, { passive: true });
  list.addEventListener('touchend', function (e) { if (lp) { clearTimeout(lp.timer); if (lp.fired) e.preventDefault(); lp = null; } });

  fmEl('fm-head').addEventListener('click', function (e) { var b = e.target.closest('[data-sort]'); if (b) fmSetSort(b.dataset.sort); });
  fmEl('lego-breadcrumbs').addEventListener('click', function (e) { var b = e.target.closest('[data-path]'); if (b) loadLego(b.dataset.path); });
  fmEl('fm-side').addEventListener('click', function (e) {
    var b = e.target.closest('.fm-place'); if (!b) return;
    if (b.dataset.go === 'gallery') glOpen(); else loadLego(b.dataset.path);
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('#fm-menu') && !e.target.closest('#fm-sort,#fm-more')) fmCloseMenu(); });
  window.addEventListener('blur', fmCloseMenu);

  document.addEventListener('keydown', function (e) {
    if (!navActive('lego-screen') || glb.open || document.getElementById('ui-confirm')) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT') { if (e.key === 'Escape') { e.target.value = ''; fmSearch(''); e.target.blur(); } else if (e.key === 'ArrowDown') { e.preventDefault(); e.target.blur(); fmSelectOnly(0, true); } return; }
    if (e.altKey || e.ctrlKey && e.key !== 'a') return;
    var n = fm.shown.length, cur = fm.sel.size ? Math.max.apply(null, Array.from(fm.sel)) : -1, step = 0;
    if (e.key === '/' || (e.key === 'f' && e.ctrlKey)) { e.preventDefault(); fmEl('fm-q').focus(); return; }
    if (e.key === 'Escape') { var m = fmEl('fm-menu'); if (!m.hidden) { e.preventDefault(); fmCloseMenu(); } else if (fm.sel.size) { e.preventDefault(); fmSelectOnly(-1); } return; }
    if (e.ctrlKey && e.key === 'a') { e.preventDefault(); fm.sel = new Set(fm.shown.map(function (_, i) { return i; })); fmPaintSel(); return; }
    if (e.key === 'ArrowDown') step = fm.view === 'grid' ? fmCols() : 1; else if (e.key === 'ArrowUp') step = fm.view === 'grid' ? -fmCols() : -1;
    else if (e.key === 'ArrowRight' && fm.view === 'grid') step = 1; else if (e.key === 'ArrowLeft' && fm.view === 'grid') step = -1;
    if (step) { e.preventDefault(); var j = cur < 0 ? (step > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cur + step)); if (n) fmSelectOnly(j, true); return; }
    if (e.key === 'Enter' && cur >= 0) { e.preventDefault(); fmOpenItem(fm.shown[cur]); }
    else if (e.key === 'Backspace') { e.preventDefault(); fmUp(); }
    else if (e.key === 'Delete' && fm.sel.size) { e.preventDefault(); fmTrashSelected(); }
    else if (e.key === ' ' && cur >= 0 && fmIsMedia(fm.shown[cur])) { e.preventDefault(); fmOpenItem(fm.shown[cur]); }
  });
}
function fmCols() {
  var rows = fmEl('lego-list').querySelectorAll('.fm-row'); if (rows.length < 2) return 1;
  var t = rows[0].offsetTop, c = 1; while (c < rows.length && rows[c].offsetTop === t) c++; return c;
}
if (fmEl('lego-list')) fmInit();

// the viewer routes (view/<path>) arrive here when a page is reloaded on a photo
async function fmRouteView(p) {
  var folder = p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '';
  if (!navActive('lego-screen') || legoCurrentPath !== folder || fm.loading) { showScreen('lego-screen'); await loadLego(folder, { silent: true }); }
  var it = fm.shown.find(function (x) { return x.path === p; });
  if (!it) return;
  var media = fm.shown.filter(fmIsMedia).map(fmAsMedia), idx = media.findIndex(function (m) { return m.p === p; });
  glbOpen({
    items: media, index: Math.max(0, idx), hash: function (m) { return 'view/' + m.p; }, parent: function () { return 'lego/' + folder; },
    onDelete: function (done) { fmForget(new Set(done.map(function (x) { return x.p; }))); },
  }, true);
}

// ─── Swipe Mode (Tinder for files) ──────────────────────────
let swipeFolderPath = '';
let swipeCurrentPath = '';
let swipeTotal = 0;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeCurrentX = 0;
let swipeCurrentY = 0;
let swipeDragging = false;
let swipeNextImg = new Image();  // preloaded next image

async function openSwipeMode(path) {
  swipeFolderPath = path || '';
  document.getElementById('lego-swipe').style.display = 'flex';
  document.getElementById('lego-swipe-empty').style.display = 'none';
  document.getElementById('lego-swipe-card').style.display = '';
  await loadNextSwipeImage();
}

function closeSwipeMode() {
  document.getElementById('lego-swipe').style.display = 'none';
  loadLego(legoCurrentPath);
}

async function loadNextSwipeImage() {
  const card = document.getElementById('lego-swipe-card');
  const info = document.getElementById('lego-swipe-info');
  card.className = 'lego-swipe-card';
  card.style.transform = '';
  card.style.opacity = '';

  // Use preloaded image if available (instant swap)
  if (swipeNextImg._path) {
    swipeCurrentPath = swipeNextImg._path;
    swipeTotal = swipeNextImg._total;
    document.getElementById('lego-swipe-img').src = swipeNextImg.src;
    document.getElementById('lego-swipe-card-name').textContent = swipeNextImg._name;
    info.textContent = `${swipeTotal} images left`;
    card.style.display = '';
    document.getElementById('lego-swipe-empty').style.display = 'none';
    const nextPath = swipeNextImg._path;
    swipeNextImg = new Image();  // clear it
    // Start preloading the next one in background
    preloadNextSwipeImage();
    return;
  }

  // No preload ready - fetch one
  info.textContent = 'Loading...';
  try {
    const r = await fetch(`/api/lego/random_image?path=${encodeURIComponent(swipeFolderPath)}`);
    const d = await r.json();
    if (d.error) {
      card.style.display = 'none';
      document.getElementById('lego-swipe-empty').style.display = '';
      info.textContent = 'No images';
      return;
    }
    swipeCurrentPath = d.path;
    swipeTotal = d.total_images;
    document.getElementById('lego-swipe-img').src = `/api/gallery/thumb?path=${encodeURIComponent(d.path)}&s=md`;
    document.getElementById('lego-swipe-card-name').textContent = d.name;
    info.textContent = `${swipeTotal} images left`;
    card.style.display = '';
    document.getElementById('lego-swipe-empty').style.display = 'none';
    preloadNextSwipeImage();
  } catch (e) {
    info.textContent = 'Error: ' + e.message;
  }
}

async function preloadNextSwipeImage() {
  try {
    const r = await fetch(`/api/lego/random_image?path=${encodeURIComponent(swipeFolderPath)}`);
    const d = await r.json();
    if (!d.error) {
      swipeNextImg = new Image();
      swipeNextImg.src = `/api/gallery/thumb?path=${encodeURIComponent(d.path)}&s=md`;
      swipeNextImg._path = d.path;
      swipeNextImg._name = d.name;
      swipeNextImg._total = d.total_images;
    }
  } catch (e) {}
}

async function swipeLeft() {
  if (!swipeCurrentPath) return;
  const card = document.getElementById('lego-swipe-card');
  card.className = 'lego-swipe-card fly-left';
  try {
    await fetch('/api/lego/trash', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: swipeCurrentPath }),
    });
  } catch (e) {}
  swipeCurrentPath = '';
  setTimeout(loadNextSwipeImage, 350);
}

async function swipeRight() {
  if (!swipeCurrentPath) return;
  const card = document.getElementById('lego-swipe-card');
  card.className = 'lego-swipe-card fly-right';
  try {
    await fetch('/api/lego/poof', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: swipeCurrentPath }),
    });
  } catch (e) {}
  swipeCurrentPath = '';
  setTimeout(loadNextSwipeImage, 350);
}

async function swipeShred() {
  if (!swipeCurrentPath) return;
  if (!confirm('Permanently shred this file?\nThis cannot be undone.')) return;
  const card = document.getElementById('lego-swipe-card');
  card.className = 'lego-swipe-card fly-up';
  try {
    await fetch('/api/lego/shred', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: swipeCurrentPath }),
    });
  } catch (e) {}
  swipeCurrentPath = '';
  setTimeout(loadNextSwipeImage, 350);
}

// Touch/drag gestures on the card
(function() {
  const card = document.getElementById('lego-swipe-card');
  if (!card) return;

  function onStart(e) {
    if (!swipeCurrentPath) return;
    swipeDragging = true;
    card.classList.add('swiping');
    const t = e.touches ? e.touches[0] : e;
    swipeStartX = t.clientX;
    swipeStartY = t.clientY;
    swipeCurrentX = 0;
    swipeCurrentY = 0;
  }

  function onMove(e) {
    if (!swipeDragging) return;
    e.preventDefault();
    const t = e.touches ? e.touches[0] : e;
    swipeCurrentX = t.clientX - swipeStartX;
    swipeCurrentY = t.clientY - swipeStartY;
    const rot = swipeCurrentX / 20;
    card.style.transform = `translate(${swipeCurrentX}px, ${swipeCurrentY * 0.3}px) rotate(${rot}deg)`;

    // Show hints based on drag direction
    const hintLeft = document.getElementById('lego-swipe-hint-left');
    const hintRight = document.getElementById('lego-swipe-hint-right');
    if (swipeCurrentX < -40) {
      hintLeft.style.opacity = Math.min(1, Math.abs(swipeCurrentX) / 100);
    } else {
      hintLeft.style.opacity = 0;
    }
    if (swipeCurrentX > 40) {
      hintRight.style.opacity = Math.min(1, swipeCurrentX / 100);
    } else {
      hintRight.style.opacity = 0;
    }
  }

  function onEnd(e) {
    if (!swipeDragging) return;
    swipeDragging = false;
    card.classList.remove('swiping');
    document.getElementById('lego-swipe-hint-left').style.opacity = 0;
    document.getElementById('lego-swipe-hint-right').style.opacity = 0;

    if (swipeCurrentX < -120) {
      swipeLeft();
    } else if (swipeCurrentX > 120) {
      swipeRight();
    } else {
      // Snap back
      card.style.transform = '';
    }
  }

  card.addEventListener('touchstart', onStart, { passive: true });
  card.addEventListener('touchmove', onMove, { passive: false });
  card.addEventListener('touchend', onEnd);
  card.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
})();

// ─── Terminal ───────────────────────────────────────────
