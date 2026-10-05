// Cloudflare Pages Function — aéroports voisins au départ (UN SEUL appel).
// Emplacement : functions/api/nearby.js  →  /api/nearby
//
// Utilise le Data API Travelpayouts v2/prices/nearest-places-matrix : renvoie les prix
// des liaisons incluant les villes les plus proches de l'origine et de la destination,
// en un seul appel (remplace les ~3 appels /api/calendar de l'ancienne version).
//
// Appel : /api/nearby?origin=NTE&destination=LIS&month=2026-03&oneway=0
// Réponse : { origin, destination, month, list:[{origin,dest,price,changes}] } trié par prix

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  const origin      = (p.get("origin")      || "").toUpperCase();
  const destination = (p.get("destination") || "").toUpperCase();
  const month  = p.get("month") || "";        // YYYY-MM (optionnel)
  const oneway = p.get("oneway") === "1";

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!origin || !destination)
    return new Response(JSON.stringify({ error: "origin et destination requis" }), { status: 400, headers: cors });
  if (!env.TP_TOKEN)
    return new Response(JSON.stringify({ error: "TP_TOKEN non configuré" }), { status: 500, headers: cors });

  const api = new URL("https://api.travelpayouts.com/v2/prices/nearest-places-matrix");
  api.searchParams.set("origin", origin);
  api.searchParams.set("destination", destination);
  api.searchParams.set("show_to_affiliates", "true");
  api.searchParams.set("currency", "eur");
  api.searchParams.set("limit", "20");
  api.searchParams.set("distance", "300");       // rayon (km) autour des villes cibles
  if (month) api.searchParams.set("depart_date", month);   // YYYY-MM
  api.searchParams.set("token", env.TP_TOKEN);

  // regroupe par aéroport d'origine, garde le prix mini
  function group(rows, filterFn) {
    const by = {};
    for (const row of rows) {
      if (!row || typeof row.value !== "number" || !row.origin) continue;
      if (filterFn && !filterFn(row)) continue;
      const o = row.origin;
      if (!by[o] || row.value < by[o].price)
        by[o] = { origin: o, dest: row.destination || destination, price: row.value, changes: (row.number_of_changes ?? null) };
    }
    return Object.values(by).sort((a, b) => a.price - b.price);
  }

  try {
    const r = await fetch(api.toString(), { headers: { "Accept": "application/json" } });
    const j = await r.json();
    const rows = (j && Array.isArray(j.data)) ? j.data : [];
    const wantRT = !oneway;
    // garde d'abord le bon type de trajet (A/R vs aller simple) pour des prix cohérents
    let list = group(rows, (row) => (!!row.return_date) === wantRT);
    if (!list.length) list = group(rows, null);   // repli : n'importe quel type trouvé
    return new Response(JSON.stringify({ origin, destination, month, list }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: "échec appel Travelpayouts", detail: String(e) }),
      { status: 502, headers: cors });
  }
}
