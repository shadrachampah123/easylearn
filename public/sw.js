const CACHE_NAME = 'easylearn-static-v2';
const APP_CACHE_PREFIX = 'easylearn-';
const PRECACHE_ASSETS = ['/manifest.json'];

function isCacheableStaticAsset(requestUrl, origin) {
  if (requestUrl.origin !== origin) return false;
  const path = requestUrl.pathname;
  return path === '/manifest.json' || path.startsWith('/_next/static/') || path.startsWith('/icons/');
}

function isExplicitlyPrivate(response) {
  const cacheControl = response.headers.get('Cache-Control') || '';
  return /(?:^|,)\s*(?:private|no-store)\b/i.test(cacheControl);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames
        .filter((name) => name.startsWith(APP_CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    )),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (!isCacheableStaticAsset(requestUrl, self.location.origin)) return;

  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.ok && response.type === 'basic' && !isExplicitlyPrivate(response)) {
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          } catch {
            // A cache write failure must not turn a successful asset response into an error.
          }
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        return cached || new Response('Offline', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-96.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(data.title || 'EasyLearn', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});
