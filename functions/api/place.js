// Cloudflare Pages Function — RECHERCHE DE LIEUX (villes & aéroports, monde entier).
// Emplacement : functions/api/place.js  →  /api/place?term=...
//
// Proxifie l'autocomplétion Travelpayouts. AUCUN token requis (comme /api/cities).
// Sert à ajouter n'importe quelle ville/aéroport de la planète en départ ou en
// destination. Réponse normalisée + cache 24 h.
//
// Appel : /api/place?term=miami   ou   /api/place?term=pékin

export async function onRequest(context) {
  const { request } = context;
  const p = new URL(request.url).searchParams;
  const term = (p.get("term") || "").trim();

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=86400"
  };
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (term.length < 2) return json([]);

  const cache = caches.default;
  const ckey = new Request(`https://escale.cache/place/${encodeURIComponent(term.toLowerCase())}`);
  try { const hit = await cache.match(ckey); if (hit) return json(await hit.json()); } catch (_) {}

  const src = "https://autocomplete.travelpayouts.com/places2"
            + "?locale=fr&types[]=city&types[]=airport&term=" + encodeURIComponent(term);

  try {
    const r = await fetch(src, { headers: { Accept: "application/json" } });
    const raw = await r.json();
    const arr = Array.isArray(raw) ? raw : [];

    const out = arr.map(x => {
      const c = x.coordinates || {};
      const lat = typeof c.lat === "number" ? c.lat : null;
      const lng = typeof c.lon === "number" ? c.lon : (typeof c.lng === "number" ? c.lng : null);
      if (!x.code || lat == null || lng == null) return null;
      return {
        code: String(x.code).toUpperCase(),
        type: x.type === "airport" ? "airport" : "city",
        name: x.name || x.city_name || x.code,
        city: x.city_name || x.name || "",
        country: x.country_name || x.country_code || "",
        lat, lng
      };
    }).filter(Boolean);

    // villes d'abord, puis aéroports ; limite raisonnable
    out.sort((a, b) => (a.type === b.type ? 0 : a.type === "city" ? -1 : 1));
    const trimmed = out.slice(0, 8);

    context.waitUntil(cache.put(ckey, new Response(JSON.stringify(trimmed), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }
    })));
    return json(trimmed);
  } catch (e) {
    return json({ error: "autocomplétion indisponible", detail: String(e) }, 502);
  }
}
