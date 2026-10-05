// Cloudflare Pages Function — derniers bons plans (billets pas chers trouvés récemment).
// Emplacement : functions/api/deals.js  →  /api/deals
//
// Utilise le Data API Travelpayouts aviasales/v3/get_latest_prices (cache gratuit).
// N'utilise AUCUN budget live (SerpApi / SearchApi / Scrape.do / Kayak) — c'est du cache.
//
// Appel : /api/deals?origin=NTE&oneway=0
// Réponse : { origin, list:[{origin,destination,price,transfers,depart,ret,airline,link}] }

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  const origin = (p.get("origin") || "").toUpperCase();
  const oneway = p.get("oneway") === "1";

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!env.TP_TOKEN)
    return new Response(JSON.stringify({ error: "TP_TOKEN non configuré" }), { status: 500, headers: cors });

  const api = new URL("https://api.travelpayouts.com/aviasales/v3/get_latest_prices");
  api.searchParams.set("currency", "eur");
  if (origin) api.searchParams.set("origin", origin);
  api.searchParams.set("period_type", "year");
  api.searchParams.set("page", "1");
  api.searchParams.set("limit", "100");
  api.searchParams.set("one_way", oneway ? "true" : "false");
  api.searchParams.set("sorting", "price");
  api.searchParams.set("trip_class", "0");
  api.searchParams.set("show_to_affiliates", "true");
  api.searchParams.set("token", env.TP_TOKEN);

  try {
    const r = await fetch(api.toString(), { headers: { "Accept": "application/json" } });
    const j = await r.json();
    const rows = (j && Array.isArray(j.data)) ? j.data : [];
    const list = rows.map(x => ({
      origin: x.origin,
      destination: x.destination,
      price: (x.price ?? x.value ?? null),
      transfers: (x.transfers ?? x.number_of_changes ?? null),
      depart: (x.departure_at || x.depart_date || "").slice(0, 10),
      ret: (x.return_at || x.return_date || "").slice(0, 10),
      airline: x.airline || null,
      seen_at: x.found_at || x.expires_at || null,
      seen_kind: x.found_at ? "found" : (x.expires_at ? "expires" : null),
      link: x.link ? ("https://www.aviasales.com" + x.link) : null
    })).filter(x => x.price != null).slice(0, 60);
    return new Response(JSON.stringify({ origin, list }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: "échec appel Travelpayouts", detail: String(e) }),
      { status: 502, headers: cors });
  }
}
