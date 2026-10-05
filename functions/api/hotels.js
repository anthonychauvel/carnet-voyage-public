// Cloudflare Pages Function — HÔTELS (prix en cache Hotellook).
// Emplacement : functions/api/hotels.js  →  /api/hotels
//
// Pendant de /api/prices, côté hébergement : gratuit, illimité, ton TP_TOKEN.
// Les prix viennent du cache Hotellook (indicatifs), l'appel part du serveur :
// aucun cookie ne se pose chez toi, donc pas d'inflation à la réouverture.
//
// Appel :
//   /api/hotels?location=Lisbonne&checkIn=2026-03-06&checkOut=2026-03-09
//              &lat=38.72&lng=-9.14&maxKm=3&minStars=2&privateOnly=1&limit=30

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=3600"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

// Auberges de jeunesse / dortoirs : exclus par défaut (chambre + SDB privatives voulues).
const DORM_RE = /\b(hostel|hostels|auberge de jeunesse|backpacker|backpackers|dormitor|dorm\b|youth hostel|jugendherberge|ostello|albergue)\b/i;

function haversine(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!env.TP_TOKEN) return json({ error: "TP_TOKEN non configuré" }, 500);

  const location = (p.get("location") || "").trim();
  const checkIn  = p.get("checkIn")  || "";
  const checkOut = p.get("checkOut") || "";
  if (!location || !checkIn || !checkOut)
    return json({ error: "location, checkIn et checkOut requis" }, 400);

  const lat = parseFloat(p.get("lat")), lng = parseFloat(p.get("lng"));
  let centre = (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;
  const maxKm       = parseFloat(p.get("maxKm") || "0") || 0;
  const minStars    = parseInt(p.get("minStars") || "0", 10) || 0;
  const privateOnly = p.get("privateOnly") !== "0";      // exclut les dortoirs par défaut
  const limit       = Math.min(parseInt(p.get("limit") || "40", 10) || 40, 100);
  const adults      = parseInt(p.get("adults") || "2", 10) || 2;

  // Géocodage serveur si pas de coords (ex. ville tapée « Camaret-sur-Mer ») : permet de
  // situer les hôtels et d'écarter/étiqueter ceux d'une grande ville voisine (Brest).
  if (!centre && location && env.OPENTRIPMAP_KEY) {
    try {
      const g = await fetch(`https://api.opentripmap.com/0.1/en/places/geoname?name=${encodeURIComponent(location)}&apikey=${env.OPENTRIPMAP_KEY}`);
      if (g.ok) { const gj = await g.json(); if (gj && gj.lat != null && gj.lon != null) centre = { lat: gj.lat, lng: gj.lon }; }
    } catch (_) {}
  }

  const cache = caches.default;
  const ckey = new Request(`https://escale.cache/hotels/${encodeURIComponent(location)}-${checkIn}-${checkOut}`);
  let raw = null;
  try { const hit = await cache.match(ckey); if (hit) raw = await hit.json(); } catch (_) {}

  if (!raw) {
    const src = "http://engine.hotellook.com/api/v2/cache.json"
      + `?location=${encodeURIComponent(location)}`
      + `&checkIn=${checkIn}&checkOut=${checkOut}`
      + `&currency=eur&limit=100&token=${encodeURIComponent(env.TP_TOKEN)}`;
    try {
      const r = await fetch(src, { headers: { Accept: "application/json" } });
      if (p.get("raw") === "1") { const t = await r.text();
        return json({ _debug: "hotellook", status: r.status,
          ctype: r.headers.get("content-type"),
          url: src.replace(encodeURIComponent(env.TP_TOKEN), "***"),
          body: t.slice(0, 1200) }); }
      raw = await r.json();
      if (Array.isArray(raw)) {
        context.waitUntil(cache.put(ckey, new Response(JSON.stringify(raw), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=21600" }
        })));
      }
    } catch (e) {
      return json({ error: "Hotellook injoignable", detail: String(e) }, 502);
    }
  }

  if (!Array.isArray(raw))
    return json({ hotels: [], total: 0, note: "aucun tarif en cache pour cette ville / ces dates" });

  // nombre de nuits, pour convertir prix moyen ↔ total
  const nights = Math.max(1, Math.round(
    (new Date(checkOut) - new Date(checkIn)) / 86400000));

  let excludedDorm = 0, excludedFar = 0, excludedStars = 0;

  const hotels = raw.map(h => {
    const geo = (h.location && h.location.geo) || {};
    const hlat = typeof geo.lat === "number" ? geo.lat : null;
    const hlng = typeof geo.lon === "number" ? geo.lon : (typeof geo.lng === "number" ? geo.lng : null);
    const perNight = typeof h.priceFrom === "number" ? h.priceFrom
                   : (typeof h.priceAvg === "number" ? h.priceAvg : null);
    return {
      id: h.hotelId ?? null,
      name: h.hotelName || "Hôtel",
      stars: typeof h.stars === "number" ? h.stars : 0,
      pricePerNight: perNight != null ? Math.round(perNight) : null,
      priceTotal: perNight != null ? Math.round(perNight * nights) : null,
      priceAvg: typeof h.priceAvg === "number" ? Math.round(h.priceAvg) : null,
      lat: hlat, lng: hlng,
      distanceKm: (centre && hlat != null && hlng != null)
        ? Math.round(haversine(centre, { lat: hlat, lng: hlng }) * 10) / 10 : null,
      city: (h.location && h.location.name) || location,
      country: (h.location && h.location.country) || "",
      // note voyageurs absente du cache Hotellook : ⚡ Google Hotels la fournit
      rating: null, reviews: null,
      url: h.hotelId
        ? `https://search.hotellook.com/hotels?hotelId=${h.hotelId}&checkIn=${checkIn}&checkOut=${checkOut}&adults=${adults}`
        : null
    };
  })
  .filter(h => {
    if (privateOnly && DORM_RE.test(h.name)) { excludedDorm++; return false; }
    if (minStars && h.stars < minStars)      { excludedStars++; return false; }
    return h.pricePerNight != null;
  });

  // Rayon adaptatif : si peu d'hôtels dans maxKm, on élargit (jusqu'à 50 km) pour ne pas
  // renvoyer une liste vide. La distance est renvoyée → le client l'affiche (ex. « 52 km »).
  let radiusKm = maxKm || null, nearestKm = null;
  let list = hotels;
  if (centre) {
    const withKm = hotels.filter(h => h.distanceKm != null);
    if (withKm.length) nearestKm = Math.min(...withKm.map(h => h.distanceKm));
    if (maxKm) {
      let rad = maxKm;
      const inRad = () => hotels.filter(h => h.distanceKm == null || h.distanceKm <= rad);
      let cur = inRad();
      while (cur.filter(h => h.distanceKm != null).length < 8 && rad < 80) { rad = Math.min(80, rad * 3); cur = inRad(); }
      radiusKm = rad; list = cur;
      excludedFar = hotels.length - list.length;
    }
  }
  list = list.sort((a, b) => a.pricePerNight - b.pricePerNight).slice(0, limit);

  return json({
    source: "hotellook_cache", location, checkIn, checkOut, nights,
    hotels: list, total: list.length, radiusKm, nearestKm,
    filtered: { dortoirs: excludedDorm, tropLoin: excludedFar, categorie: excludedStars },
    note: "prix en cache, indicatifs · notes voyageurs disponibles via ⚡"
  });
}
