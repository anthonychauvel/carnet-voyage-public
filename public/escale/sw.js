// Service worker minimal pour Escale.
// - Le "shell" (page + icônes) est mis en cache → lancement instantané et hors-ligne.
// - Les appels /api/ passent toujours par le réseau (données fraîches, jamais en cache).

const CACHE = "escale-v126-carnet";
const SHELL = ["./", "./index.html", "./manifest.json",
  "./icon-192.png", "./icon-512.png",
  "./icon-maskable-192.png", "./icon-maskable-512.png", "./favicon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Push en arrière-plan (envoyé par /api/cron via VAPID). Affiche la notification même
// quand l'app est fermée. Le corps est un JSON {title, body, url}.
self.addEventListener("push", (e) => {
  let d = { title: "Escale", body: "", url: "./" };
  try { if (e.data) d = Object.assign(d, e.data.json()); }
  catch (_) { try { if (e.data) d.body = e.data.text(); } catch (_) {} }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: "./icon-192.png", badge: "./icon-192.png",
    tag: "escale-radar", renotify: true, data: { url: d.url || "./" }
  }));
});

// Notifications Radar (locales, affichées via registration.showNotification depuis l'app).
// Un tap ramène sur l'onglet Escale déjà ouvert, ou en ouvre un nouveau.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Jamais de cache pour l'API prix/calendrier : toujours le réseau.
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: "hors-ligne" }), { headers: { "Content-Type": "application/json" } })
    ));
    return;
  }
  // Shell : cache d'abord, réseau en repli.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
