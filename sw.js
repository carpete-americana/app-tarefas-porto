// Sem cache, de propósito: só existe para a app ser instalável. Os dados estão no localStorage.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
