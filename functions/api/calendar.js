// Cloudflare Pages Function — calendrier de prix par jour (façon Kayak).
// Emplacement : functions/api/calendar.js  →  /api/calendar
//
// Renvoie, pour un mois donné et une route, le prix le moins cher PAR JOUR
// de départ, avec durée et nombre d'escales. Utilise aviasales/v3/grouped_prices
// (group_by=departure_at), l'endpoint recommandé qui fournit prix + durée + escales.
//
// Appel : /api/calendar?origin=NTE&destination=DUB&month=2026-03&oneway=0

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;

  const origin      = (p.get("origin")      || "").toUpperCase();
  const destination = (p.get("destination") || "").toUpperCase();
  const month  = p.get("month") || "";       // YYYY-MM
  const oneway = p.get("oneway") === "1";

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!origin || !destination || !month)
    return new Response(JSON.stringify({ error: "origin, destination et month requis" }), { status: 400, headers: cors });
  if (!env.TP_TOKEN)
    return new Response(JSON.stringify({ error: "TP_TOKEN non configuré" }), { status: 500, headers: cors });

  const api = new URL("https://api.travelpayouts.com/aviasales/v3/grouped_prices");
  api.searchParams.set("origin", origin);
  api.searchParams.set("destination", destination);
  api.searchParams.set("group_by", "departure_at");
  api.searchParams.set("departure_at", month);      // YYYY-MM
  api.searchParams.set("one_way", oneway ? "true" : "false");
  api.searchParams.set("direct", "false");
  api.searchParams.set("currency", "eur");
  api.searchParams.set("token", env.TP_TOKEN);

  try {
    const r = await fetch(api.toString(), { headers: { "Accept": "application/json" } });
    const j = await r.json();

    // data = { "2026-03-06": {price, transfers, duration, airline, return_at, link}, ... }
    const out = {};
    if (j && j.data && typeof j.data === "object") {
      for (const date of Object.keys(j.data)) {
        const o = j.data[date];
        if (!o || typeof o.price !== "number") continue;
        out[date] = {
          price: o.price,
          transfers: o.transfers ?? null,     // 0 = direct = trajet le plus court
          duration: o.duration ?? null,       // durée en minutes
          airline: o.airline ?? null,
          return_at: o.return_at || null,
          seen_at: o.found_at || o.expires_at || null,
          seen_kind: o.found_at ? "found" : (o.expires_at ? "expires" : null),
          link: o.link ? "https://www.aviasales.com" + o.link : null
        };
      }
    }
    return new Response(JSON.stringify({ origin, destination, month, days: out }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: "échec appel Travelpayouts", detail: String(e) }),
      { status: 502, headers: cors });
  }
}
