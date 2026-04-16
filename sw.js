const CACHE_NAME = 'TableTennisRatings';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192x192.png',
  './icon-512x512.png'
];

// Install: cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.map(name => name !== CACHE_NAME && caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: different strategies for navigation vs. other GETs
self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // 1) Navigation (page loads)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(netRes => netRes)
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 2) Other requests (CSS, JS, images, etc.)
  event.respondWith(
    caches.match(event.request).then(cachedRes => {
      if (cachedRes) return cachedRes;

      return fetch(event.request)
        .then(netRes => {
          // Only cache valid, same‑origin responses
          if (
            netRes.ok &&
            new URL(event.request.url).origin === self.location.origin
          ) {
            const clone = netRes.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return netRes;
        })
        .catch(() => {
          // If both cache & network fail, return a simple fallback (optional)
          return new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable'
          });
        });
    })
  );
});
