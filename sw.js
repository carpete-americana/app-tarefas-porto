// Rede primeiro; se falhar, usa a última cópia guardada. Assim a app abre sem ligação e nunca serve versões velhas quando há rede.
const CACHE = 'tarefas-porto-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/admin')) return;
  e.respondWith(
    fetch(r).then((res) => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then((k) => k.put(r, c)); }
      return res;
    }).catch(() => caches.match(r).then((m) => m || caches.match('/')))
  );
});

// Notificações push: o servidor manda {title, body, url, icon, tag}. No iPhone é obrigatório mostrar sempre uma notificação.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Tarefas', {
    body: d.body || '', icon: d.icon || '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
