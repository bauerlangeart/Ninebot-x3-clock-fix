// SPDX-License-Identifier: MIT
// Caches the app shell so the tool works offline after the first visit.
// Bump VERSION whenever a cached file changes.
const VERSION = 'g3d-clock-fix-v3';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'lib/ble-transport.js',
  'lib/nb-crypto.js',
  'lib/nb-protocol.js',
  'lib/timezone.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates arrive when online), cache as offline fallback.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
