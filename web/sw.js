// Cache-first service worker for the app shell. Bump VERSION whenever files change.
const VERSION = 'tt-v9';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './css/themes.css', './css/layouts.css', './css/settings-appearance.css', './css/wysiwyg.css', './css/v2.css',
  './js/app.js', './js/store.js', './js/rules.js', './js/markdown.js', './js/sheet.js',
  './js/notes.js', './js/ui.js', './js/seed.js', './js/aurora.js', './js/data/srd.js',
  './js/data/schemes.js', './js/data/layouts.js', './js/data/overrides.js', './js/data/srd-spells.json',
  './js/api.js', './js/auth.js', './js/campaign.js', './js/wysiwyg.js', './js/spells.js', './js/auroraContent.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache API calls
  // On localhost (development) prefer the network so edits show up immediately; elsewhere cache-first.
  const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(e.request).then((res) => {
        if (res && res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => cached);
      return DEV ? network : (cached || network);
    }),
  );
});
