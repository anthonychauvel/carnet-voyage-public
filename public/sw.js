// Carnet de voyage — fonctionnement hors ligne
// Pages et fichiers de l'appli : réseau d'abord (toujours la dernière version), copie locale si pas de réseau.
// La synchro (/api/…) passe toujours par le réseau : les données restent dans le téléphone en attendant.
const CACHE = 'carnet-2026-10-06a';
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
    // Partage Android (« Partager → Carnet de voyage ») : on range le document, puis on ouvre l'appli
    if (e.request.method === 'POST' && url.pathname.endsWith('/partage-recu')) {
      e.respondWith((async () => {
        try {
          const fd = await e.request.formData(), c = await caches.open('share-inbox');
          for (const k of await c.keys()) await c.delete(k);
          const f = fd.getAll('files').find(x => x && x.size);
          if (f) await c.put(new Request('./share/file?name=' + encodeURIComponent(f.name || 'document')), new Response(f, {headers: {'Content-Type': f.type || 'application/octet-stream'}}));
          const txt = [fd.get('title'), fd.get('text'), fd.get('url')].filter(Boolean).join('\n');
          if (txt) await c.put(new Request('./share/text'), new Response(txt));
        } catch (_) {}
        return Response.redirect('./?partage=1', 303);
      })());
      return;
    }
    // Rappels : « rappels.ics?c=… » est fabriqué ici, sur le téléphone, pour que l'iPhone ouvre Calendrier (« Ajouter tout »)
    if (url.pathname.endsWith('/rappels.ics') && url.searchParams.get('c')) {
      let b = url.searchParams.get('c').replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
      let txt = ''; try { txt = decodeURIComponent(escape(atob(b))); } catch (_) {}
      e.respondWith(new Response(txt, {headers: {'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="rappels.ics"', 'Cache-Control': 'no-store'}}));
      return;
    }
    if (url.pathname.startsWith('/api/')) return;
    if (url.pathname.startsWith('/escale/')) return;   // Escale a son propre service worker
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
