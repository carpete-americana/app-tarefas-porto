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
