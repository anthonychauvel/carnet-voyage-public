// Cloudflare Pages Function — points d'intérêt géolocalisés pour l'onglet Itinéraire.
// Emplacement : functions/api/poi.js  →  /api/poi
//
// Proxy vers OpenTripMap (gratuit avec une clé). Nécessite la variable
// d'environnement OPENTRIPMAP_KEY (Cloudflare Pages → Settings → Environment variables).
//
// Appel : /api/poi?city=Lisbonne
// Réponse : { city, center:{lat,lon}, pois:[{xid,name,lat,lon,kind,rate,dist}] }

export async function onRequest(context) {
  const { request, env } = context;
  const city = (new URL(request.url).searchParams.get("city") || "").trim();
  const key = env.OPENTRIPMAP_KEY;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=86400"
  };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });

  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!key) return json({ error: "Clé OpenTripMap absente (variable OPENTRIPMAP_KEY côté Cloudflare)." }, 500);
  if (!city) return json({ error: "Paramètre city requis." }, 400);

  const rateNum = (r) => { const n = parseInt(r, 10) || 0; return n + (String(r).includes("h") ? 0.5 : 0); };

  try {
    // 1) géocodage de la ville
    const g = await fetch(`https://api.opentripmap.com/0.1/en/places/geoname?name=${encodeURIComponent(city)}&apikey=${key}`);
    if (!g.ok) throw new Error("geoname " + g.status);
    const gj = await g.json();
    if (!gj || gj.lat == null || gj.lon == null) return json({ error: "Ville introuvable." }, 404);

    // 2) lieux notables dans un rayon large (grand pool → on trie par notoriété ensuite)
    const r = await fetch(`https://api.opentripmap.com/0.1/en/places/radius?radius=12000&lon=${gj.lon}&lat=${gj.lat}&kinds=interesting_places&rate=2&format=json&limit=500&apikey=${key}`);
    if (!r.ok) throw new Error("radius " + r.status);
    const list = await r.json();

    const seen = new Set(), pois = [];
    (Array.isArray(list) ? list : [])
      .filter(p => p && p.point && p.name && p.name.length > 1)
      .map(p => ({
        xid: p.xid, name: p.name,
        lat: p.point.lat, lon: p.point.lon,
        kind: (p.kinds || "").split(",")[0] || "",
        rate: rateNum(p.rate), dist: Math.round(p.dist || 0)
      }))
      .sort((a, b) => b.rate - a.rate)
      .forEach(p => { const k = p.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); pois.push(p); } });

    return json({ city: gj.name || city, center: { lat: gj.lat, lon: gj.lon }, pois: pois.slice(0, 50) });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}
