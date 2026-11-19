/*
 * Finance Chat service worker: makes the app installable and lets the shell
 * open without a connection. Privacy rules:
 * - only the static files of the interface are cached;
 * - /api/* (sessions, accounts, transactions) and /health are never touched
 *   or stored: the browser talks to the server directly;
 * - no push, no background sync, no analytics.
 * Network first: when online the newest files are always used (no stale
 * version after an update); the cache is only a fallback when offline.
 */
const CACHE = 'finance-chat-shell-v3';
const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/js/ai-format.js',
  '/js/ai-settings.js',
  '/js/api.js',
  '/js/chat-view.js',
  '/js/history.js',
  '/js/navigation.js',
  '/js/settings.js',
  '/js/setup.js',
  '/favicon.svg',
  '/brand/finance-chat-symbol.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || (request.mode === 'navigate' ? caches.match('/') : Response.error())),
  );
});
