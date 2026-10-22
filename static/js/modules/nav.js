// ===== Module: nav =====
// Central history router. The URL hash is the single source of truth for
// "where am I": showScreen() and a few sub-views (Files folder, image viewer,
// project, music artist/album/now-playing) push entries through navSet(), and
// popstate/hashchange (mouse back/forward, Alt+←/→, phone back gesture) are
// applied back onto the UI without pushing again.
//
// Hash grammar:  ''  |  <screen>  |  lego/<path>  |  view/<image path>  |
//                gallery[/videos|screenshots]  |  gview/<tab>/<path>  |  project/<id>  |  music[/artists|albums|songs|now|artist/<n>|album/<k>]

var NAV_SCREEN_KEY = {
  'home-screen': '', 'book-screen': 'audiobooks', 'reader-screen': 'reader',
  'music-screen': 'music', 'lego-screen': 'lego', 'gallery-screen': 'gallery', 'logs-screen': 'logs', 'ollama-screen': 'ollama',
  'comfy-screen': 'comfy', 'musicgen-screen': 'musicgen', 'agents-screen': 'agents',
  'project-screen': 'projects', 'system-screen': 'system', 'terminal-screen': 'terminal',
  'osint-screen': 'privacy', 'universe-screen': 'universe', 'journal-screen': 'journal',
  'legos-screen': 'legos', 'settings-screen': 'settings',
};
var NAV_KEY_SCREEN = {};
Object.keys(NAV_SCREEN_KEY).forEach(function (id) { NAV_KEY_SCREEN[NAV_SCREEN_KEY[id]] = id; });
NAV_KEY_SCREEN.project = 'project-screen';

var nav = { cur: '', want: '', q: false, applying: false };

function navSafeDecode(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }
function navHash() { return location.hash.slice(1).split('/').map(navSafeDecode).join('/'); }
function navUrl(h) { return h ? '#' + h.split('/').map(encodeURIComponent).join('/') : location.pathname + location.search; }
function navCanBack() { return !!(history.state && history.state.n > 0); }
function navScreenOf(h) { return NAV_KEY_SCREEN[(h || '').split('/')[0]] || ''; }
function navActive(id) { var s = document.getElementById(id); return !!(s && s.classList.contains('active')); }

// Queue a history entry. Calls made in the same tick collapse into one entry
// (last wins), so "showScreen('lego-screen'); loadLego(path)" is a single step.
function navSet(h) {
  if (nav.applying) { nav.cur = h; return; }
  nav.want = h;
  if (!nav.q) { nav.q = true; Promise.resolve().then(navFlush); }
}
function navFlush() {
  nav.q = false;
  if (nav.want === nav.cur) return;
  nav.cur = nav.want;
  history.pushState({ n: ((history.state && history.state.n) || 0) + 1 }, '', navUrl(nav.cur));
}
// Same logical place, different detail (e.g. paging through photos): no new entry.
function navReplace(h) {
  nav.cur = nav.want = h;
  if (nav.applying) return;
  history.replaceState({ n: (history.state && history.state.n) || 0 }, '', navUrl(h));
}
// Called by showScreen. Skips when a more specific hash for that screen is pending.
function navShow(id) {
  if (!(id in NAV_SCREEN_KEY)) return;
  var pend = nav.applying ? nav.cur : (nav.q ? nav.want : nav.cur);
  if (navScreenOf(pend) === id) return;
  navSet(NAV_SCREEN_KEY[id]);
}

function navCloseOverlays(h) {
  try { if (typeof closeAISpread === 'function') closeAISpread(); } catch (_) {}
  var np = document.getElementById('notif-panel'); if (np) np.classList.remove('open');
  var sw = document.getElementById('lego-swipe'); if (sw) sw.style.display = 'none';
  var key = h.split('/')[0];
  if (key !== 'view' && key !== 'gview' && typeof glbHide === 'function') glbHide();
  if (key !== 'music' && typeof mzHideNP === 'function') mzHideNP();
  if (typeof mzCloseSheet === 'function') mzCloseSheet();
}

function navRoute(h) {
  var parts = h.split('/'), key = parts[0], rest = parts.slice(1), p;
  switch (key) {
    case '': showScreen('home-screen'); break;
    case 'audiobooks': showScreen('book-screen'); loadBooks(); break;
    case 'reader':
      if (typeof currentBook !== 'undefined' && currentBook) showScreen('reader-screen');
      else { showScreen('book-screen'); loadBooks(); }
      break;
    case 'music': {
      var was = navActive('music-screen');
      showScreen('music-screen');
      if (typeof mzApplyRoute === 'function') mzApplyRoute(rest);
      if (!was || !mz.loaded) loadMusic();
      break;
    }
    case 'lego':
      p = rest.join('/');
      if (!rest.length) { showScreen('lego-screen'); if (!fm.items.length) loadLego(undefined, { silent: true }); }     // bare #lego: the default place
      else if (!navActive('lego-screen') || p !== legoCurrentPath) { showScreen('lego-screen'); loadLego(p, { silent: true }); }
      break;
    case 'view': fmRouteView(rest.join('/')); break;
    case 'logs': showScreen('logs-screen'); loadLogs(); break;
    case 'gallery': showScreen('gallery-screen'); glRoute(rest[0] || 'library', ''); break;
    case 'gview': showScreen('gallery-screen'); glRoute(rest[0], rest.slice(1).join('/')); break;
    case 'project': openProject(rest.join('/')); break;
    case 'projects': openProjectList(); break;
    case 'ollama': showScreen('ollama-screen'); loadOllamaModels(); break;
    case 'comfy': showScreen('comfy-screen'); loadComfyStatus(); loadComfyModels(); loadComfyGallery(); break;
    case 'musicgen': showScreen('musicgen-screen'); loadMusicGen(); break;
    case 'agents': showScreen('agents-screen'); break;
    case 'system': showScreen('system-screen'); loadSystem(); break;
    case 'terminal': showScreen('terminal-screen'); break;
    case 'privacy': showScreen('osint-screen'); break;
    case 'universe': showScreen('universe-screen'); break;
    case 'journal': showScreen('journal-screen'); switchJournalTab('journal-tab-voice'); break;
    case 'legos': showScreen('legos-screen'); break;
    case 'settings': showScreen('settings-screen'); loadSettings(); break;
    default: showScreen('home-screen');
  }
}

function navApply(h, force) {
  if (!force && h === nav.cur) return;
  nav.applying = true; nav.want = h;
  try { navCloseOverlays(h); navRoute(h); }
  catch (e) { console.error('nav error:', e); }
  finally { nav.applying = false; nav.cur = nav.want = h; }
}

nav.cur = nav.want = navHash();
if (!history.state) { try { history.replaceState({ n: 0 }, '', location.href); } catch (_) {} }
window.addEventListener('popstate', function () { navApply(navHash()); });
window.addEventListener('hashchange', function () { navApply(navHash()); });
