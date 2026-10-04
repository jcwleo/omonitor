// omonitor service worker, for Web Push only. It has no fetch handler, so it never caches or intercepts a page load.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : '' }; }
  // One notification per session: a newer one replaces the older instead of stacking up.
  const tag = m.threadId ? `omonitor:${m.threadId}` : `omonitor:${m.kind || 'note'}`;
  e.waitUntil(self.registration.showNotification(m.title || 'omonitor', {
    body: m.body || '', tag, renotify: true, icon: 'app/icon-180.png', data: { threadId: m.threadId || null },
  }));
});

// Opens the session: an open dashboard is focused and told which one; otherwise the app opens at #session=<id>.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.threadId;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const w = await wins[0].focus();
      if (id) w.postMessage({ type: 'omonitor:open', threadId: id });
      return;
    }
    await self.clients.openWindow(id ? `./#session=${encodeURIComponent(id)}` : './');
  })());
});
