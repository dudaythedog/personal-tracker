/* Personal Tracker service worker — offline app shell, no dependencies.
   Network-first for same-origin GET; cache is the offline fallback. */
'use strict';

// Bump this on every deploy that changes cached files.
var CACHE = 'personal-tracker-v2';
var ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Network-first: a GitHub Pages deploy shows up on the next load,
// and the cache is only used when offline. Only good responses are cached.
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // never cache third parties

  var isNav = req.mode === 'navigate';
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(isNav ? './index.html' : req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(isNav ? './index.html' : req).then(function (cached) {
        return cached || caches.match('./');
      });
    })
  );
});
