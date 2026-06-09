// Minimal Service Worker — push only, no caching
const VERSION = 'v65';

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
