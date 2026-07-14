// Minimal service worker: exists so CoWatch is installable as a PWA
// (standalone display = no browser chrome on phones). Deliberately
// network-only — the app is realtime and the server already controls
// caching with Cache-Control: no-cache; adding SW caching would risk the
// stale-CSS/new-JS mixes we just eliminated.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // network passthrough — no respondWith: the browser fetches as normal
});
