// pFMS service worker: push notifications for the team page, and just
// enough to make the page installable. No caching — the app is always
// fetched live, so a deploy never leaves a stale bundle behind.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Network only. A fetch listener is what makes browsers treat the page as
// installable; doing nothing in it means every request goes to the network.
self.addEventListener('fetch', () => {});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'pFMS';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/tomsawyerlabs.svg',
      badge: '/tomsawyerlabs.svg',
      tag: data.tag,
      renotify: !!data.tag,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
