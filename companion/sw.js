/**
 * Service Worker for BMAD Board Companion PWA.
 * Caches the app shell for offline "Add to Home Screen" support.
 * Handles push notifications and background events.
 * API calls always go to network (never cached).
 */

const CACHE_NAME = 'bmad-companion-v2';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or WebSocket upgrades
  if (url.pathname.startsWith('/api/') || event.request.headers.get('upgrade') === 'websocket') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      // Return cached version, but also update cache in background
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// Handle messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data?.type === 'show-notification') {
    self.registration.showNotification(event.data.title, {
      body: event.data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'bmad-companion',
      renotify: true,
      data: event.data
    });
  }
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing window if available
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({
            type: 'notification-click',
            view: event.notification.data?.view || 'dashboard'
          });
          return;
        }
      }
      // Open new window if no existing client
      return self.clients.openWindow('/');
    })
  );
});

// Handle push events (for future server-sent push notifications)
self.addEventListener('push', (event) => {
  let data = { title: 'BMAD Board', body: 'Something happened' };

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'bmad-push',
      data
    })
  );
});
