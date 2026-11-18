/* ClipHeist service worker: caches the app shell so the Studio works offline. */
var CACHE = 'clipheist-v5';
var SHELL = [
  './',
  'index.html',
  'editor.html',
  'manifest.webmanifest',
  'assets/css/styles.css',
  'assets/js/config.js',
  'assets/js/youtube.js',
  'assets/js/media/demux.js',
  'assets/js/media/mp4mux.js',
  'assets/js/media/exact.js',
  'assets/js/ai/analyze.js',
  'assets/js/editor.js',
  'assets/img/logo.svg',
  'assets/img/hero.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Google / YouTube API traffic
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) { return hit || caches.match('editor.html'); });
    })
  );
});
