// Offline-first: app files are served from cache, then refreshed in the background.
const CACHE = 'daftar-v4';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'fonts/Vazirmatn-var.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-180.png'];
self.addEventListener('install', e => {
  // cache:'reload' skips the browser's HTTP cache so a new version never installs old files
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(u => new Request(u, {cache: 'reload'}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const cached = await cache.match(key, {ignoreSearch: true});
    const fresh = fetch(req.mode === 'navigate' ? req.url : req, {cache: 'no-cache'}).then(res => { if (res && res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    return (await fresh) || new Response('آفلاین', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
  }));
});
