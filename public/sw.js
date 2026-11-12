// Service worker AgentHub — shell cache untuk PWA Android.
// Prinsip: API dan data pengguna TIDAK PERNAH di-cache (berisi token & percakapan);
// yang di-cache hanya aset statis UI supaya buka ulang terasa instan.
// Bila ganti file statis, naikkan CACHE agar cache lama dibuang.
const CACHE = 'agenthub-shell-v3';

const SHELL = [
  '/public/style.css',
  '/public/app.js',
  '/public/machines.js',
  '/public/qrcode.min.js',
  '/public/icon-192.png',
  '/public/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API/streaming/auth: selalu jaringan, jangan sentuh cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/download')) return;

  // navigasi halaman: jaringan dulu (UI terbaru), fallback shell saat offline
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('/', fresh.clone());
        return fresh;
      } catch {
        return (await caches.open(CACHE)).match('/') || Response.error();
      }
    })());
    return;
  }

  // aset statis: cache dulu, segarkan di belakang
  if (url.pathname.startsWith('/public/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const fresh = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit || Response.error());
      return hit || fresh;
    })());
  }
});
