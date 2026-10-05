// Cloudflare Pages Function — proxy vers le Data API Aviasales/Travelpayouts.
// Emplacement dans le repo : functions/api/prices.js
// → URL publique : https://ton-site.pages.dev/api/prices
//
// Config (une fois, dashboard Cloudflare Pages) :
//   Settings ▸ Variables and Secrets ▸ Add
//   Name : TP_TOKEN   Value : ton token Travelpayouts (Profil ▸ API token)   [Encrypt ✔]
//
// Appel : /api/prices?origin=NTE&destination=DUB&depart=2026-03-06&return=2026-03-08
//
// Endpoint utilisé : aviasales/v3/prices_for_dates (recommandé par la doc,
// remplace v1/prices/cheap). Renvoie prix, escales, durée et lien vers l'offre.

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;

  const origin      = (p.get("origin")      || "").toUpperCase();
  const destination = (p.get("destination") || "").toUpperCase();
  const depart = p.get("depart") || "";   // YYYY-MM-DD
  const ret    = p.get("return") || "";   // YYYY-MM-DD

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

  // On interroge au niveau du MOIS (YYYY-MM) : le cache est plus souvent rempli
  // qu'à la date exacte → prix indicatif fiable « le moins cher ce mois-là ».
  const departMonth = depart ? depart.slice(0, 7) : "";
  const returnMonth = ret ? ret.slice(0, 7) : "";
  const roundTrip = !!returnMonth;

  const api = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  api.searchParams.set("origin", origin);
  api.searchParams.set("destination", destination);
  if (departMonth) api.searchParams.set("departure_at", departMonth);
  if (returnMonth) api.searchParams.set("return_at", returnMonth);
  api.searchParams.set("one_way", roundTrip ? "false" : "true");
  api.searchParams.set("direct", "false");   // on veut un résultat même s'il faut une escale
  api.searchParams.set("currency", "eur");
  api.searchParams.set("sorting", "price");
  api.searchParams.set("limit", "1");        // le moins cher suffit
  api.searchParams.set("token", env.TP_TOKEN);

  try {
    const r = await fetch(api.toString(), { headers: { "Accept": "application/json" } });
    const j = await r.json();
    const best = Array.isArray(j?.data) && j.data.length ? j.data[0] : null;

    return new Response(JSON.stringify({
      origin, destination,
      price: best ? best.price : null,
      airline: best ? best.airline : null,
      transfers: best ? (best.transfers ?? null) : null,   // 0 = direct
      duration_to: best ? (best.duration_to ?? null) : null, // durée réelle aller (min)
      departure_at: best ? (best.departure_at || null) : null,  // vraie date du vol le moins cher
      return_at: best ? (best.return_at || null) : null,
      seen_at: best ? (best.found_at || best.expires_at || null) : null,   // fraîcheur du prix caché
      seen_kind: best ? (best.found_at ? "found" : (best.expires_at ? "expires" : null)) : null,
      link: best && best.link ? "https://www.aviasales.com" + best.link : null,
      note: best ? "indicatif (cache Aviasales, ≤ 7 j)" : "aucun tarif en cache pour cette route/période"
    }), { headers: cors });

  } catch (e) {
    return new Response(JSON.stringify({ error: "échec appel Travelpayouts", detail: String(e) }),
      { status: 502, headers: cors });
  }
}
