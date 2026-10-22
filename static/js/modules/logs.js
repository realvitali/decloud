// ===== Module: logs =====
// Home > Logs: the server's audit trail (sign-ins, terminal unlocks, file deletions, restarts).
var lg = { group: '', seq: 0 };
var LG_META = {
  login_ok: ['Signed in', 'lock', 'ok'], login_fail: ['Wrong password', 'lock', 'bad'], logout: ['Signed out', 'lock', 'info'], password_changed: ['Password changed', 'lock', 'warn'],
  totp_ok: ['Terminal unlocked', 'shield', 'ok'], totp_fail: ['Wrong terminal code', 'shield', 'bad'], totp_locked: ['Terminal code locked out', 'shield', 'bad'],
  terminal_open: ['Terminal opened', 'shield', 'info'], terminal_denied: ['Terminal blocked (locked)', 'shield', 'bad'],
  file_trash: ['Moved to Trash', 'trash', 'warn'], file_poof: ['Poofed', 'trash', 'warn'], file_shred: ['Shredded', 'trash', 'bad'], file_done: ['Folder marked done', 'folder', 'info'],
  server_start: ['Server started', 'server', 'info'],
};
function logsAgo(ts) {
  var s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}
function logsDevice(ua) {
  if (!ua) return '';
  var os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  var br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|python|node/i.test(ua) ? 'script' : '';
  return [br, os].filter(Boolean).join(' on ');
}
function logsGroup(g) {
  lg.group = g;
  document.querySelectorAll('#lg-chips button').forEach(function (b) { b.classList.toggle('on', b.dataset.g === g); });
  loadLogs();
}
async function loadLogs() {
  var list = document.getElementById('lg-list'), seq = ++lg.seq;
  if (!list.children.length) list.innerHTML = '<div class="lg-empty">Loading…</div>';
  try {
    var d = await (await fetch('/api/logs?limit=300&group=' + encodeURIComponent(lg.group))).json();
    if (seq !== lg.seq) return;
    var ev = d.events || [];
    if (!ev.length) { list.innerHTML = '<div class="lg-empty">Nothing logged yet.</div>'; return; }
    list.innerHTML = ev.map(function (e) {
      var m = LG_META[e.kind] || [e.kind, 'info', e.ok ? 'info' : 'bad'];
      var who = [e.ip, logsDevice(e.ua)].filter(Boolean).join(' · ');
      var when = new Date(e.ts * 1000);
      return '<div class="lg-row ' + m[2] + '"><span class="lg-ico">' + (UI_ICON[m[1]] || UI_ICON.info) + '</span><div class="lg-main"><b>' + escapeHtml(m[0]) + '</b>' +
        (e.detail && e.detail !== m[0] ? '<span class="lg-detail">' + escapeHtml(e.detail) + '</span>' : '') +
        (who ? '<span class="lg-who">' + escapeHtml(who) + '</span>' : '') + '</div><time title="' + escapeHtml(when.toLocaleString()) + '">' + escapeHtml(logsAgo(e.ts)) + '</time></div>';
    }).join('');
  } catch (e) { if (seq === lg.seq) list.innerHTML = '<div class="lg-empty">Could not load the logs.</div>'; }
}
