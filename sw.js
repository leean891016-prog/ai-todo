// Version: increment on each deploy to force cache refresh
const VERSION = 'v39';
const CACHE = 'ai-todo-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192-v2.png', 'icon-512-v2.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    // Notify all open pages to reload
    const allClients = await self.clients.matchAll();
    allClients.forEach(client => client.postMessage({ type: 'NEW_VERSION' }));
  })());
});

// Network-first for HTML, cache-first for static assets
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

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
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
    self.clients.claim();
  }
});

// Web Push: show notification when push received
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || '⏰ 待办提醒';
  const options = {
    body: data.body || '',
    icon: 'icon-192-v2.png',
    badge: 'icon-192-v2.png',
    tag: data.tag || 'ai-todo',
    requireInteraction: data.requireInteraction || false,
    vibrate: [200, 100, 200],
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification click → open app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
      } else {
        clients.openWindow('./');
      }
    })
  );
});
