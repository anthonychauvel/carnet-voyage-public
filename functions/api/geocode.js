// Cloudflare Pages Function — géocodage d'adresse / lieu (pour le point manuel de l'itinéraire).
// Emplacement : functions/api/geocode.js  →  /api/geocode
//
// Utilise Nominatim (OpenStreetMap) — gratuit, sans clé. Appel CÔTÉ SERVEUR avec un
// User-Agent identifiant l'app (exigé par la politique d'usage Nominatim), et mis en cache.
//
// Appel : /api/geocode?q=Tour Eiffel Paris   (ou une adresse)
// Réponse : { name, lat, lon }

export async function onRequest(context) {
  const { request } = context;
  const q = (new URL(request.url).searchParams.get("q") || "").trim();

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=86400"
  };
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!q) return json({ error: "q requis" }, 400);

  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=0`,
      { headers: { "User-Agent": "Escale/1.0 (vol-bm4.pages.dev)", "Accept": "application/json" } }
    );
    if (!r.ok) throw new Error("nominatim " + r.status);
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return json({ error: "adresse introuvable" }, 404);
    const p = j[0];
    return json({ name: p.display_name || q, lat: parseFloat(p.lat), lon: parseFloat(p.lon) });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}
