/* ==========================================================================
   sw.js - app-shell service worker for Sunshine Gadgets POS.

   Caches only this app's own static files, cache-first on the very first
   load and network-first-with-cache-fallback afterwards. Anything that
   isn't a same-origin GET (Firestore/Firebase Auth API calls in
   particular) is passed straight through untouched - this worker never
   intercepts or caches cloud requests.
   ========================================================================== */

'use strict';

var CACHE_VERSION = 'sunshine-pos-v3';

var APP_SHELL = [
  './',
  'index.html',
  'analytics.html',
  'manifest.json',
  'css/styles.css',
  'js/db.js',
  'js/app.js',
  'js/analytics.js',
  'js/sync.js',
  'js/install.js',
  'js/firebase-config.js',
  'js/vendor/firebase/firebase-app-compat.js',
  'js/vendor/firebase/firebase-auth-compat.js',
  'js/vendor/firebase/firebase-firestore-compat.js',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(APP_SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) { return key !== CACHE_VERSION; })
            .map(function (key) { return caches.delete(key); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Only ever handle same-origin GET requests for our own files. Everything
  // else (Firestore/Firebase Auth calls, POST/PUT, cross-origin requests)
  // passes straight through to the network, untouched.
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(function (cached) {
      var networkFetch = fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            var copy = response.clone();
            caches.open(CACHE_VERSION).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        })
        .catch(function () { return cached; });

      // Network-first-with-cache-fallback, except on the very first install
      // there's nothing cached yet, so cache-first naturally degrades to
      // "wait for network" until install populates the cache.
      return cached ? networkFetch.catch(function () { return cached; }) : networkFetch;
    })
  );
});
