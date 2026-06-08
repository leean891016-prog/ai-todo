// Version: increment on each deploy to force cache refresh
const VERSION = 'v16';
const CACHE = 'ai-todo-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192-v2.png', 'icon-512-v2.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for HTML, cache-first for static assets
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // HTML: always try network first
  if (e.request.destination === 'document' || url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Static assets: cache-first
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});

// Notify clients when a new version is ready
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
    self.clients.claim();
  }
});
