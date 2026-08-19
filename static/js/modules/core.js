// ===== Module: core =====
// ═══ DeCloud ═══

// ─── Auth: wrap all fetch calls with session-token header ────────
// The session cookie (decloud_session) is set by /api/auth/login and
// sent automatically with same-origin requests. We also add a Bearer
// header carrying the opaque session token as a fallback for
// cross-origin (tunnel) scenarios. The PIN itself never lives in
// browser storage.
const _originalFetch = window.fetch;
window.fetch = function(input, init) {
  init = init || {};
  // Don't modify if already has Authorization header
  if (!init.headers || (init.headers instanceof Headers && !init.headers.has('Authorization'))) {
    // Add auth header from sessionStorage if we have a session token
    const token = sessionStorage.getItem('decloud_session');
    if (token) {
      init.headers = init.headers || {};
      if (init.headers instanceof Headers) {
        init.headers.set('Authorization', 'Bearer ' + token);
      } else {
        init.headers['Authorization'] = 'Bearer ' + token;
      }
    }
  }
  // CSRF token on state-changing requests (server requires it when the
  // request is authenticated only by cookie)
  const method = (init.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = sessionStorage.getItem('decloud_csrf');
    if (csrf) {
      init.headers = init.headers || {};
      if (init.headers instanceof Headers) {
        init.headers.set('X-CSRF-Token', csrf);
      } else {
        init.headers['X-CSRF-Token'] = csrf;
      }
    }
  }
  // Always include credentials (cookies)
  init.credentials = 'same-origin';
  return _originalFetch.call(this, input, init);
};

// ─── Crash Recovery (runs before anything else can break) ──
window.addEventListener('error', function(e) {
  // Ignore errors from Safari's native share sheet / visibility changes
  var msg = (e.message || '').toLowerCase();
  if (msg.includes('share') || msg.includes('visibility') || msg.includes('abort')) return;
  console.error('Uncaught error:', e.error || e.message);
  showCrashRecovery(e.error || new Error(e.message));
});
window.addEventListener('unhandledrejection', function(e) {
  console.error('Unhandled promise rejection:', e.reason);
});

function showCrashRecovery(err) {
  // Only show once per page load
  if (document.getElementById('decloud-crash-overlay')) return;
  var overlay = document.createElement('div');
  overlay.id = 'decloud-crash-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif;padding:24px;text-align:center';
  overlay.innerHTML =
    '<div style="font-size:48px;margin-bottom:16px">X</div>' +
    '<h2 style="margin:0 0 8px;font-size:20px">DeCloud crashed</h2>' +
    '<p style="margin:0 0 20px;opacity:0.7;font-size:14px;max-width:320px">Something went wrong loading the dashboard. A Force Refresh will clear the cache and reload.</p>' +
    '<button onclick="forceRefresh()" style="background:#6366f1;color:white;border:none;padding:14px 28px;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:12px">Force Refresh</button>' +
    '<details style="margin-top:16px;opacity:0.5;font-size:12px;max-width:400px;word-break:break-word"><summary>Error details</summary><pre style="text-align:left;white-space:pre-wrap;padding:8px">' +
    (err && err.stack ? err.stack : (err && err.message ? err.message : String(err))) +
    '</pre></details>';
  document.body.appendChild(overlay);
}

// ─── SVG Icons (Lucide/Feather style) ─────────────────────
const ICONS = {
  book: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  lego: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/><circle cx="8" cy="5" r="0.5" fill="currentColor"/><circle cx="12" cy="5" r="0.5" fill="currentColor"/><circle cx="16" cy="5" r="0.5" fill="currentColor"/></svg>',
  brick: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="9" rx="1"/><rect x="7" y="7" width="4" height="3" rx="0.5"/><rect x="13" y="7" width="4" height="3" rx="0.5"/><line x1="12" y1="10" x2="12" y2="19"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  music: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  brain: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
  bot: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>',
  activity: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/><line x1="20" y1="9" x2="22" y2="9"/><line x1="20" y1="14" x2="22" y2="14"/><line x1="2" y1="9" x2="4" y2="9"/><line x1="2" y1="14" x2="4" y2="14"/></svg>',
  memory: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><line x1="7" y1="6" x2="7" y2="18"/><line x1="17" y1="6" x2="17" y2="18"/></svg>',
  gpu: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  server: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  layers: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  universe: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="7" y1="7" x2="10" y2="10"/><line x1="17" y1="7" x2="14" y2="10"/><line x1="7" y1="17" x2="10" y2="14"/><line x1="17" y1="17" x2="14" y2="14"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  message: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  gitCommit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>',
  gitHub: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>',
};

const APPS = [
  { id: 'audiobooks', svg: ICONS.book,    label: 'Books',     color: '#6366f1', screen: 'book-screen' },
  { id: 'music',      svg: ICONS.music,   label: 'Music',     color: '#ec4899', screen: 'music-screen' },
  { id: 'files',      svg: ICONS.lego,    label: 'Files',     color: '#f59e0b', screen: 'lego-screen' },
  { id: 'journal',    svg: ICONS.universe, label: 'Journal',  color: '#a855f7', screen: 'journal-screen' },
  { id: 'ai',         svg: ICONS.brain,   label: 'AI',        color: '#8b5cf6', screen: null, spread: true },
  { id: 'legos',      svg: ICONS.brick,   label: 'Legos',     color: '#ef4444', screen: 'legos-screen' },
  { id: 'projects',   svg: ICONS.layers,  label: 'Projects',  color: '#0ea5e9', screen: 'project-screen' },
  { id: 'system',     svg: ICONS.activity,label: 'System',    color: '#4ade80', screen: 'system-screen' },
  { id: 'terminal',   svg: ICONS.terminal,label: 'Terminal',  color: '#fbbf24', screen: 'terminal-screen' },
  { id: 'settings',   svg: ICONS.settings, label: 'Settings', color: '#6b7280', screen: 'settings-screen' },
];

// AI sub-apps (shown in radial spread)
const AI_SUBAPPS = [
  { id: 'ollama',  svg: ICONS.brain,  label: 'AI Chat',  color: '#8b5cf6', screen: 'ollama-screen' },
  { id: 'comfy',   svg: ICONS.image,  label: 'Generate', color: '#ec4899', screen: 'comfy-screen' },
  { id: 'agents',  svg: ICONS.bot,    label: 'Agents',  color: '#34d399', screen: 'agents-screen' },
];

// ─── Projects (data-driven; add your own in Settings) ─────────
const PROJECTS = [
  // Example template — copy and fill in:
  // {
  //   id: 'my-project',
  //   name: 'My Project',
  //   domain: 'myproject.com',
  //   repo: 'user/repo',
  //   stack: ['React', 'Node'],
  //   localPath: '/home/user/projects/my-project/',
  //   color: '#0ea5e9',
  //   monetized: false,
  // },
];

// ─── Agents ───────────────────────────────────────────────
let agentDetailsOpen = {};
