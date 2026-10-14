// DeCloud Service Worker
const CACHE_NAME = 'decloud-v97';

self.addEventListener('install', e => {
  self.skipWaiting(); // activate immediately
});

self.addEventListener('activate', e => {
  // Drop old caches. We don't force-navigate open pages: the page shows an
  // "Update ready — tap to reload" toast on controllerchange instead.
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network-first for everything — always get fresh content
  if (e.request.method !== 'GET') return;
  // Never cache API responses (personal data; server sends no-store anyway)
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Cache a copy for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
