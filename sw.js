// Offline shell. Everything the app needs is static, so this is cache-first with a
// versioned cache: bump VERSION on release and the old one is dropped on activate.
// ponytail: no stale-while-revalidate, no runtime cache eviction. The whole app is
// under 1 MB and the version bump is the invalidation story.
const VERSION = 'crusher-v6';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
  './public/app.js', './public/charts.js', './public/local.js', './public/sync.js', './public/device.js', './public/style.css',
  './lib/engine.js', './lib/agegrade.js', './lib/feats-core.js', './lib/garmin.js', './lib/demo.js',
  './data/feats-ledger.json', './data/feats-extra.json', './data/feats-extra2.json', './data/feats-extra3.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    // One bad URL fails the whole addAll, so each file is cached on its own.
    .then(c => Promise.all(SHELL.map(u => c.add(u).catch(err => console.warn('skip', u, err)))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  e.respondWith(caches.match(request, { ignoreSearch: true }).then(hit => hit || fetch(request)
    .then(res => {
      // Cache what we fetch (fonts included) so the second launch works on a plane.
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(request, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => request.mode === 'navigate' ? caches.match('./index.html') : Response.error())));
});
