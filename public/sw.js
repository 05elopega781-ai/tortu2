'use strict';
self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function () {
  // The live overlay remains network-first; no stale game state is cached.
});
