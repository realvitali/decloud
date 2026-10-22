// ===== Module: ui-kit =====
// Small shared pieces for the Gallery and the Files browser: line icons, formatters, a toast and a confirm sheet.

var UI_ICON = (function () {
  function ic(body, sw) { return '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.8) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>'; }
  return {
    back: ic('<polyline points="15 18 9 12 15 6"/>', 2.2),
    fwd: ic('<polyline points="9 18 15 12 9 6"/>', 2.2),
    up: ic('<polyline points="18 15 12 9 6 15"/>', 2.2),
    down: ic('<polyline points="6 9 12 15 18 9"/>', 2.2),
    close: ic('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 2.2),
    check: ic('<polyline points="20 6 9 17 4 12"/>', 2.6),
    home: ic('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>'),
    search: ic('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    list: ic('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
    grid: ic('<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>'),
    sort: ic('<path d="M7 4v16"/><polyline points="3 16 7 20 11 16"/><path d="M17 20V4"/><polyline points="13 8 17 4 21 8"/>'),
    more: ic('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
    folder: ic('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    file: ic('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/>'),
    image: ic('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 9"/>'),
    video: ic('<rect x="3" y="5" width="13" height="14" rx="2.5"/><path d="M16 10l5-3v10l-5-3z"/>'),
    music: ic('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    doc: ic('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>'),
    archive: ic('<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><line x1="10" y1="13" x2="14" y2="13"/>'),
    code: ic('<polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/>'),
    lock: ic('<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
    refresh: ic('<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>'),
    shield: ic('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    server: ic('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="16.5" x2="7.01" y2="16.5"/>'),
    camera: ic('<path d="M4 8h3l1.6-2.5h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.6"/>'),
    screenshot: ic('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><line x1="10" y1="18.5" x2="14" y2="18.5"/>'),
    download: ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    trash: ic('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
    info: ic('<circle cx="12" cy="12" r="9.5"/><line x1="12" y1="11" x2="12" y2="17"/><circle cx="12" cy="7.6" r="0.6" fill="currentColor"/>'),
    plus: ic('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 2.2),
    minus: ic('<line x1="5" y1="12" x2="19" y2="12"/>', 2.2),
    play: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
    photos: ic('<rect x="3" y="3" width="18" height="18" rx="4.5"/><circle cx="9" cy="9.5" r="2"/><path d="M21 15.5l-4.8-4.8L7 20.5"/>'),
    swipe: ic('<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M10 10V4a1.5 1.5 0 0 1 3 0v6"/><path d="M13 10.5V6a1.5 1.5 0 0 1 3 0v6.5"/><path d="M16 11.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L3.5 15a1.6 1.6 0 0 1 2.6-1.8L7 14"/>'),
    check_circle: ic('<circle cx="12" cy="12" r="9.5"/><polyline points="8 12.5 11 15.5 16 9"/>', 2),
  };
})();

var UI_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var UI_MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var UI_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "wall clock seconds": epoch seconds whose UTC fields are the local time on the phone. Read them with the getUTC* methods.
function uiWallNow() { var n = new Date(); return Math.floor((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds())) / 1000); }
function uiDayKey(wall) { return Math.floor(wall / 86400); }
function uiDayLabel(wall) {
  var d = new Date(wall * 1000), today = uiDayKey(uiWallNow()), k = uiDayKey(wall);
  if (k === today) return 'Today';
  if (k === today - 1) return 'Yesterday';
  var base = UI_DAYS[d.getUTCDay()].slice(0, 3) + ', ' + d.getUTCDate() + ' ' + UI_MONTHS[d.getUTCMonth()];
  return d.getUTCFullYear() === new Date().getFullYear() ? base : base + ' ' + d.getUTCFullYear();
}
function uiMonthLabel(wall) { var d = new Date(wall * 1000); return UI_MONTHS_LONG[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
function uiTime(wall) {
  var d = new Date(wall * 1000), h = d.getUTCHours(), m = d.getUTCMinutes();
  return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function uiFullDate(wall) { var d = new Date(wall * 1000); return UI_DAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + UI_MONTHS_LONG[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
function uiSize(n) {
  if (!n && n !== 0) return '';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
}
function uiDuration(s) {
  s = Math.max(0, Math.round(s || 0));
  var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x : m + ':' + (x < 10 ? '0' : '') + x;
}
function uiNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function uiBuzz(ms) { try { if (navigator.vibrate && matchMedia('(pointer:coarse)').matches) navigator.vibrate(ms || 8); } catch (_) {} }
function uiQuery(path) { return encodeURIComponent(path); }
function uiThumbUrl(it, size) { return '/api/gallery/thumb?path=' + uiQuery(it.p) + '&s=' + (size || 'sm') + (it.m ? '&m=' + it.m : ''); }
function uiFileUrl(it, download) { return download ? '/api/lego/download?path=' + uiQuery(it.p) : '/api/gallery/file?path=' + uiQuery(it.p); }   // downloads work for any file, not just media
function uiDownload(items) {
  items.forEach(function (it, i) {
    setTimeout(function () {
      var a = document.createElement('a'); a.href = uiFileUrl(it, true); a.download = ''; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
    }, i * 450);                                   // browsers drop a burst of downloads, so space them
  });
}

// Toast: a short pill at the bottom.
var uiToastTimer = 0;
function uiToast(msg) {
  var t = document.getElementById('ui-toast');
  if (!t) { t = document.createElement('div'); t.id = 'ui-toast'; t.className = 'ui-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(uiToastTimer); uiToastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
}

// Confirm sheet. Resolves true / false. danger=true makes the confirm button red.
function uiConfirm(title, message, okLabel, danger) {
  return new Promise(function (resolve) {
    var old = document.getElementById('ui-confirm'); if (old) old.remove();
    var el = document.createElement('div'); el.id = 'ui-confirm'; el.className = 'ui-confirm';
    el.innerHTML = '<div class="ui-confirm-card" role="alertdialog" aria-modal="true"><div class="ui-confirm-title"></div><div class="ui-confirm-msg"></div>' +
      '<div class="ui-confirm-btns"><button class="ui-btn" data-v="0">Cancel</button><button class="ui-btn ui-btn-main' + (danger ? ' danger' : '') + '" data-v="1"></button></div></div>';
    el.querySelector('.ui-confirm-title').textContent = title;
    el.querySelector('.ui-confirm-msg').textContent = message || '';
    el.querySelector('[data-v="1"]').textContent = okLabel || 'OK';
    function done(v) { document.removeEventListener('keydown', key, true); el.classList.remove('show'); setTimeout(function () { el.remove(); }, 160); resolve(v); }
    function key(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); } }
    el.addEventListener('click', function (e) { if (e.target === el) done(false); var b = e.target.closest('[data-v]'); if (b) done(b.dataset.v === '1'); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); el.querySelector('.ui-btn-main').focus(); });
  });
}

// POST helper that always resolves to {ok, error}
async function uiPost(url, body) {
  try {
    var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var d = await r.json().catch(function () { return {}; });
    return r.ok && !d.error ? { ok: true, data: d } : { ok: false, error: d.error || ('HTTP ' + r.status) };
  } catch (e) { return { ok: false, error: e.message || 'network error' }; }
}

// <i data-i="name"></i> placeholders in the HTML become inline icons
function uiHydrate(root) {
  (root || document).querySelectorAll('i[data-i]').forEach(function (el) {
    var svg = UI_ICON[el.dataset.i]; if (!svg) return;
    var s = document.createElement('span'); s.className = 'ui-i'; s.innerHTML = svg; el.replaceWith(s);
  });
}
uiHydrate();
