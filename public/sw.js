// Carnet de voyage — fonctionnement hors ligne
// Pages et fichiers de l'appli : réseau d'abord (toujours la dernière version), copie locale si pas de réseau.
// La synchro (/api/…) passe toujours par le réseau : les données restent dans le téléphone en attendant.
const CACHE = 'carnet-2026-10-04c';
const CORE = ['./', './index.html', './manifest.json', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    if (url.pathname.endsWith('.mp4')) return;   // vidéo du tuto : lue en direct (pas de cache, lecture par morceaux)
    e.respondWith(timeout(fetch(req), 6000)
      .then(r => { if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; })
      .catch(() => caches.match(req, {ignoreSearch: true}).then(m => m || caches.match('./index.html'))));
    return;
  }
  // Bibliothèques externes (lecteur de ZIP) : copie locale d'abord
  if (/(^|\.)cdn\.jsdelivr\.net$|(^|\.)unpkg\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; })));
  }
});
