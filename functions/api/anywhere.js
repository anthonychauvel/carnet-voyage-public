// Cloudflare Pages Function — recherche « n'importe où » (façon Explore).
// Emplacement : functions/api/anywhere.js  →  /api/anywhere
//
// Renvoie le vol le moins cher VERS CHAQUE destination au départ d'un aéroport.
// Utilise aviasales/v3/prices_for_dates avec seulement l'origine + unique=true.
//
// Appel : /api/anywhere?origin=NTE&month=2026-03&oneway=0

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;

  const origin = (p.get("origin") || "").toUpperCase();
  const month  = p.get("month") || "";        // YYYY-MM (optionnel)
  const depart = p.get("depart") || "";        // YYYY-MM-DD exact (prioritaire sur month)
  const ret    = p.get("return") || "";        // YYYY-MM-DD exact (retour)
  const oneway = p.get("oneway") === "1";
  const direct = p.get("direct") === "1" || p.get("direct") === "true";

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!origin)
    return new Response(JSON.stringify({ error: "origin requis" }), { status: 400, headers: cors });
  if (!env.TP_TOKEN)
    return new Response(JSON.stringify({ error: "TP_TOKEN non configuré" }), { status: 500, headers: cors });

  const api = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  api.searchParams.set("origin", origin);              // pas de destination = partout
  api.searchParams.set("unique", "true");              // 1 résultat par destination
  api.searchParams.set("sorting", "price");
  api.searchParams.set("one_way", oneway ? "true" : "false");
  // direct=true : ne renvoie QUE le moins cher SANS correspondance, par destination.
  // Nécessaire pour "Directs par aéroport" : le résultat "unique" par défaut (direct=false)
  // renvoie le moins cher tout court, correspondance comprise — sur un petit aéroport
  // (Brest) la correspondance est presque toujours moins chère qu'un vol direct, donc
  // filtrer transfers===0 sur cette liste-là masque des vols directs qui existent
  // réellement (constaté BES vide / NTE plein, 23/08/2026).
  api.searchParams.set("direct", direct ? "true" : "false");
  api.searchParams.set("currency", "eur");
  api.searchParams.set("limit", "1000");
  if (depart) {                                  // dates exactes prioritaires
    api.searchParams.set("departure_at", depart);
    if (!oneway && ret) api.searchParams.set("return_at", ret);
  } else if (month) {
    api.searchParams.set("departure_at", month);
    if (!oneway) api.searchParams.set("return_at", month);
  }
  api.searchParams.set("token", env.TP_TOKEN);

  try {
    const r = await fetch(api.toString(), { headers: { "Accept": "application/json" } });
    const j = await r.json();
    const rows = Array.isArray(j?.data) ? j.data : [];
    const out = rows.map(o => ({
      destination: o.destination,
      price: o.price,
      transfers: o.transfers ?? null,
      airline: o.airline || null,           // code IATA compagnie (ex. TO, FR, AF)
      duration_to: o.duration_to ?? null,   // durée aller (min) — pour le filtre durée
      departure_at: o.departure_at || null,
      return_at: o.return_at || null,
      seen_at: o.found_at || o.expires_at || null,
      seen_kind: o.found_at ? "found" : (o.expires_at ? "expires" : null),
      link: o.link ? "https://www.aviasales.com" + o.link : null
    })).filter(o => typeof o.price === "number")
       .sort((a, b) => a.price - b.price);

    return new Response(JSON.stringify({ origin, month: month || null, count: out.length, results: out }),
      { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: "échec appel Travelpayouts", detail: String(e) }),
      { status: 502, headers: cors });
  }
}
