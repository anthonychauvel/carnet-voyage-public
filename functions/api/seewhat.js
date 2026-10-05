// Cloudflare Pages Function — QUOI VOIR (points d'intérêt OpenStreetMap / Overpass).
// Emplacement : functions/api/seewhat.js  →  /api/seewhat
//
// GRATUIT, SANS CLÉ, SANS QUOTA. Complète les activités Booking (« quoi réserver »)
// par un « quoi voir » : musées, monuments, sites naturels, plages, points de vue…
// autour de la destination. Couvre même les petites villes (Brest, Bastia…).
//
// Appel : /api/seewhat?lat=38.72&lng=-9.14&radius=8000   (ou ?q=Lisbonne pour géocoder)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=86400"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const num = (x) => (typeof x === "number" ? x : (x != null && !isNaN(parseFloat(x)) ? parseFloat(x) : null));

// géocodage léger via l'autocomplétion Travelpayouts (sans token) si on n'a que le nom
async function geocode(q) {
  try {
    const u = "https://autocomplete.travelpayouts.com/places2?locale=fr&types[]=city&term=" + encodeURIComponent(q);
    const r = await fetch(u, { headers: { Accept: "application/json" } });
    const j = await r.json();
    const c = Array.isArray(j) && j.length ? j[0].coordinates : null;
    return c ? { lat: c.lat, lng: c.lon } : null;
  } catch (_) { return null; }
}

// catégories OSM → libellé FR + emoji
function classify(tags) {
  const t = tags || {};
  if (t.tourism === "museum") return { cat: "Musée", emo: "🏛️" };
  if (t.tourism === "gallery") return { cat: "Galerie", emo: "🖼️" };
  if (t.tourism === "viewpoint") return { cat: "Point de vue", emo: "🌄" };
  if (t.tourism === "artwork") return { cat: "Œuvre / art", emo: "🎨" };
  if (t.tourism === "zoo") return { cat: "Zoo", emo: "🦁" };
  if (t.tourism === "theme_park") return { cat: "Parc", emo: "🎢" };
  if (t.tourism === "aquarium") return { cat: "Aquarium", emo: "🐠" };
  if (t.historic === "castle" || t.historic === "fort") return { cat: "Château / fort", emo: "🏰" };
  if (t.historic === "monument" || t.historic === "memorial") return { cat: "Monument", emo: "🗿" };
  if (t.historic === "ruins" || t.historic === "archaeological_site") return { cat: "Site historique", emo: "🏺" };
  if (t.historic) return { cat: "Patrimoine", emo: "🏛️" };
  if (t.amenity === "place_of_worship") return { cat: "Édifice religieux", emo: "⛪" };
  if (t.leisure === "park" || t.leisure === "garden") return { cat: "Parc / jardin", emo: "🌳" };
  if (t.natural === "beach" || t.leisure === "beach_resort") return { cat: "Plage", emo: "🏖️" };
  if (t.natural === "peak") return { cat: "Sommet", emo: "⛰️" };
  if (t.natural === "waterfall" || t.waterway === "waterfall") return { cat: "Cascade", emo: "💧" };
  if (t.natural) return { cat: "Site naturel", emo: "🌿" };
  if (t.tourism === "attraction") return { cat: "Attraction", emo: "📍" };
  return { cat: "À voir", emo: "📍" };
}

function hav(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export async function onRequest(context) {
  const { request } = context;
  const p = new URL(request.url).searchParams;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  let lat = num(p.get("lat")), lng = num(p.get("lng"));
  const q = (p.get("q") || "").trim();
  const radius = Math.min(parseInt(p.get("radius") || "8000", 10) || 8000, 20000);

  if ((lat == null || lng == null) && q) {
    const g = await geocode(q);
    if (g) { lat = g.lat; lng = g.lng; }
  }
  if (lat == null || lng == null)
    return json({ error: "lat/lng (ou q à géocoder) requis" }, 400);

  const cache = caches.default;
  const ckey = new Request(`https://escale.cache/see/${lat.toFixed(3)}-${lng.toFixed(3)}-${radius}`);
  try { const hit = await cache.match(ckey); if (hit) return json({ ...(await hit.json()), cached: true }); } catch (_) {}

  // requête Overpass : POI touristiques/patrimoniaux/naturels notables, avec nom
  const filters = [
    'node["tourism"~"museum|gallery|viewpoint|artwork|zoo|theme_park|aquarium|attraction"]',
    'node["historic"]', 'way["historic"]',
    'node["natural"~"beach|peak|waterfall"]',
    'node["leisure"~"park|garden"]', 'way["leisure"~"park|garden"]'
  ];
  const around = `(around:${radius},${lat},${lng})`;
  const body = "[out:json][timeout:20];(" +
    filters.map(f => f + around + '["name"];').join("") +
    ");out center 60;";

  // deux miroirs Overpass pour la robustesse
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ];
  let data = null;
  for (const ep of endpoints) {
    try {
      // POST puis, si échec, GET (?data=) — certains miroirs préfèrent l'un ou l'autre
      let r = await fetch(ep, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
      if (!r.ok) r = await fetch(ep + "?data=" + encodeURIComponent(body));
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.elements)) { data = j.elements; break; }
    } catch (_) {}
  }
  if (!data) return json({ places: [], total: 0, note: "OpenStreetMap momentanément indisponible" });

  const centre = { lat, lng };
  const seen = new Set();
  const places = data.map(el => {
    const t = el.tags || {};
    const name = t.name || t["name:fr"];
    if (!name) return null;
    const plat = el.lat ?? (el.center && el.center.lat);
    const plng = el.lon ?? (el.center && el.center.lon);
    if (plat == null || plng == null) return null;
    const key = name.toLowerCase();
    if (seen.has(key)) return null; seen.add(key);
    const c = classify(t);
    return {
      name, cat: c.cat, emo: c.emo,
      lat: plat, lng: plng,
      distanceKm: Math.round(hav(centre, { lat: plat, lng: plng }) * 10) / 10,
      wiki: t.wikipedia ? ("https://fr.wikipedia.org/wiki/" + encodeURIComponent(t.wikipedia.replace(/^..:/, ""))) : null,
      site: t.website || t["contact:website"] || null,
      osm: `https://www.openstreetmap.org/${el.type}/${el.id}`
    };
  }).filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 40);

  const out = { places, total: places.length, center: centre, radiusKm: Math.round(radius / 1000),
    note: "source OpenStreetMap — « quoi voir » (gratuit)" };
  context.waitUntil(cache.put(ckey, new Response(JSON.stringify(out), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" }
  })));
  return json(out);
}
