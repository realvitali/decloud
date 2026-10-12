// ===== Module: netloc — tailnet connection awareness =====
// Checks where the client connects from. If NOT via Tailscale, shows a
// dismissible splash banner explaining the situation. Never blocks access.
// The user said: "apps will be static from last save" when off-tailnet —
// that's the funnel serving cached content; the banner just explains it.

const NetLoc = (() => {
  const KEY = 'decloud_netloc_dismissed_until';
  let timer = null;

  function dismissed() {
    try {
      const until = parseFloat(sessionStorage.getItem(KEY) || '0');
      return Date.now() < until;
    } catch { return false; }
  }

  function setDismissed() {
    try { sessionStorage.setItem(KEY, String(Date.now() + 6 * 3600 * 1000)); } catch {}
  }

  function banner(type, hint) {
    if (document.getElementById('netloc-banner')) return;
    const el = document.createElement('div');
    el.id = 'netloc-banner';
    const isPublic = type === 'public';
    const icon = isPublic ? '🌍' : '🏠';
    const title = isPublic
      ? 'Not connected to your tailnet'
      : 'On home network — not via Tailscale';
    const detail = isPublic
      ? `${hint}<br><b>Apps may be a stale snapshot.</b> Open Tailscale on this device and connect, then reload — everything comes back live.`
      : `${hint} For the secure end-to-end path, connect to your tailnet.`;
    el.innerHTML = `
      <div class="nl-card">
        <div class="nl-icon">${icon}</div>
        <div class="nl-body">
          <div class="nl-title">${title}</div>
          <div class="nl-detail">${detail}</div>
          <div class="nl-actions">
            <button class="nl-btn nl-primary" id="nl-reload">I've connected — reload</button>
            <button class="nl-btn" id="nl-dismiss">Continue anyway</button>
          </div>
        </div>
      </div>`;
    el.querySelector('#nl-dismiss').onclick = () => { setDismissed(); el.remove(); };
    el.querySelector('#nl-reload').onclick = () => { location.reload(); };
    document.body.appendChild(el);
  }

  async function check() {
    try {
      const r = await fetch('/api/netloc', { cache: 'no-store' });
      const d = await r.json();
      if (d.type !== 'tailscale' && !dismissed()) {
        banner(d.type, d.hint);
      }
    } catch { /* offline or auth wall — stay quiet */ }
  }

  function start() {
    check();
    // re-check periodically (in case network changes while open)
    timer = setInterval(() => {
      if (!document.getElementById('netloc-banner')) check();
    }, 30_000);
  }

  return { start, check };
})();

// boot after DOM is ready (works with the app's auth screen too)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', NetLoc.start);
} else {
  NetLoc.start();
}
