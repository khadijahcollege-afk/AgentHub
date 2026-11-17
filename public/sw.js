// Service worker AgentHub — shell cache untuk PWA Android.
// Prinsip: API dan data pengguna TIDAK PERNAH di-cache (berisi token & percakapan);
// yang di-cache hanya aset statis UI supaya buka ulang terasa instan.
// Bila ganti file statis, naikkan CACHE agar cache lama dibuang.
// Query versi di index.html (?v=1.6.14) yang membuat aset baru langsung dipakai
// pada pemuatan pertama; CACHE yang dinaikkan mencegah entri lama menumpuk.
const CACHE = 'agenthub-shell-v16';

const SHELL = [
  '/public/style.css',
  '/public/workspace.css',
  '/public/pwa.js',
  '/public/app.js',
  '/public/machines.js',
  '/public/i18n.js',
  '/public/i18n-dict.js',
  '/public/model-access.js',
  '/public/qrcode.min.js',
  '/public/download.js',
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

  // Aset statis. Kode (JS/CSS) SELALU dari jaringan lebih dulu: kalau cache
  // didahulukan, perbaikan UI baru tidak pernah terlihat sampai cache dibuang —
  // user terus melihat versi lama dan menganggap bug-nya belum diperbaiki.
  // Gambar tetap cache-first karena isinya jarang berubah.
  if (url.pathname.startsWith('/public/')) {
    const isCode = /\.(?:js|css)$/.test(url.pathname);
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (!isCode && hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return hit || Response.error();
      }
    })());
  }
});
