// Cloudflare Pages Function — météo « normales » à destination pour un mois.
// Emplacement : functions/api/weather.js  →  /api/weather
//
// Proxy vers Open-Meteo (archive ERA5 — gratuit, sans clé) appelé CÔTÉ SERVEUR :
// aucun souci CORS/navigateur, et ça passe par le service worker comme /api/prices.
// Renvoie des normales indicatives pour un mois, moyennées sur le MÊME MOIS de
// l'an passé (l'archive ne couvre pas le futur) :  { hi, lo, rainDays, year }.
//
// Appel : /api/weather?lat=53.42&lng=-6.27&m=8   (m = index de mois 0..11)

export async function onRequest(context) {
  const { request } = context;
  const p = new URL(request.url).searchParams;
  const lat = parseFloat(p.get("lat"));
  const lng = parseFloat(p.get("lng"));
  const m   = parseInt(p.get("m"), 10);   // 0..11

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=86400"   // normales : 24 h de cache CDN
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!isFinite(lat) || !isFinite(lng) || !(m >= 0 && m <= 11))
    return new Response(JSON.stringify({ error: "lat, lng et m (0..11) requis" }), { status: 400, headers: cors });

  const pad = n => String(n).padStart(2, "0");
  const year = new Date().getUTCFullYear() - 1;
  const last = new Date(year, m + 1, 0).getDate();
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}`
    + `&start_date=${year}-${pad(m + 1)}-01&end_date=${year}-${pad(m + 1)}-${pad(last)}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;

  try {
    const r = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) throw new Error("open-meteo " + r.status);
    const j = await r.json();
    const d = j.daily || {};
    const tmax = d.temperature_2m_max || [], tmin = d.temperature_2m_min || [], pr = d.precipitation_sum || [];
    const avg = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
    const hi = avg(tmax), lo = avg(tmin);
    if (hi == null)
      return new Response(JSON.stringify({ error: "pas de données pour ce point/mois" }), { headers: cors });
    const rainDays = pr.filter(x => x != null && x >= 1).length;
    return new Response(JSON.stringify({ hi: Math.round(hi), lo: Math.round(lo), rainDays, year }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 502, headers: cors });
  }
}
