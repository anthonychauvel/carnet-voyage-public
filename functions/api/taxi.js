// Cloudflare Pages Function — TRANSFERT / TAXI via RapidAPI booking-com18.
// Emplacement : functions/api/taxi.js  →  /api/taxi
//
// 2 temps : taxi/auto-complete (lieu -> id) puis taxi/search (prix par véhicule).
// Quota RapidAPI partagé (530/mois) → sur bouton + cache 6 h. Sans clé : configured:false.
//
// Appel :
//   /api/taxi?from=Lisbon%20airport&to=Lisbonne%20centre&date=2026-03-06&time=10:00&passengers=2

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=1800"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const jsonNoCache = (o, s = 200) => new Response(JSON.stringify(o), { status: s,
  headers: { ...CORS, "Cache-Control": "no-store" } });
const num = (x) => (typeof x === "number" ? x : (x != null && !isNaN(parseFloat(x)) ? parseFloat(x) : null));
function host(env) { return env.RAPIDAPI_HOST || "booking-com18.p.rapidapi.com"; }
function H(env) { return { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": host(env), Accept: "application/json" }; }

function pickPlaceId(x) {
  // "placeId" (camelCase) est le champ réellement renvoyé par l'auto-complete —
  // vérifié sur un vrai appel Paris/Caen. Les autres noms restent en repli.
  return x.placeId ?? x.id ?? x.place_id ?? x.googlePlaceId ?? x.resultId ?? x.locationId ?? x.value ?? null;
}
async function place(env, q) {
  const tryQ = async (term) => {
    const u = `https://${host(env)}/taxi/auto-complete?query=${encodeURIComponent(term)}`;
    const r = await fetch(u, { headers: H(env) });
    const j = await r.json();
    const arr = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.data?.results) ? j.data.results : []);
    return arr.length ? pickPlaceId(arr[0]) : null;
  };
  // essaie tel quel, puis en retirant " airport" si présent (ex. villes sans aéroport unique)
  return (await tryQ(q)) || (/ airport$/i.test(q) ? await tryQ(q.replace(/ airport$/i, "")) : null);
}

function normTaxi(x) {
  const pr = x.price || {};
  return {
    category: x.categoryLocalised || x.category || x.vehicleType || "Taxi",
    vehicleType: x.vehicleType || null,
    supplier: x.supplierName || null,
    price: num(pr.amount),
    currency: pr.currencyCode || "EUR",
    passengers: x.passengerCapacity ?? null,
    bags: x.bags ?? null,
    durationMin: x.duration ?? null,
    distanceKm: num(x.drivingDistance),
    meetGreet: !!x.meetGreet,
    freeCancellation: (x.cancellationLeadTimeMinutes || 0) > 0 && x.nonRefundable !== true,
    image: x.imageUrl || null,
    desc: x.descriptionLocalised || x.description || null
  };
}

// Diagnostic du 23/08 : le fournisseur renvoyait "Pickup date time is in the past"
// alors que le lieu ET la date étaient corrects — signe qu'il attend un datetime
// COMBINÉ, pas 2 champs séparés (sinon il retombe sur "aujourd'hui" + l'heure seule,
// donc "dans le passé" dès qu'on teste l'après-midi). On envoie les deux formes.
function taxiSearchUrl(env, pickId, dropId, date, time, passengers) {
  const hhmmss = time.length === 5 ? time + ":00" : time;
  const dt = `${date}T${hhmmss}`;
  const su = new URL(`https://${host(env)}/taxi/search`);
  su.searchParams.set("pick_up_place_id", String(pickId));
  su.searchParams.set("pickUpPlaceId", String(pickId));
  su.searchParams.set("drop_off_place_id", String(dropId));
  su.searchParams.set("dropOffPlaceId", String(dropId));
  su.searchParams.set("pick_up_date", date);
  su.searchParams.set("pickUpDate", date);
  su.searchParams.set("pick_up_time", time);
  su.searchParams.set("pickUpTime", time);
  su.searchParams.set("pickUpDateTime", dt);
  su.searchParams.set("pickupDateTime", dt);
  su.searchParams.set("pick_up_date_time", dt);
  su.searchParams.set("passenger", String(passengers));
  su.searchParams.set("passengers", String(passengers));
  su.searchParams.set("currency_code", "EUR");
  su.searchParams.set("currencyCode", "EUR");
  return su;
}

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!env.RAPIDAPI_KEY) return json({ configured: false });

  const from = (p.get("from") || "").trim();
  const to = (p.get("to") || "").trim();
  const date = p.get("date") || "";
  const time = p.get("time") || "10:00";
  const passengers = p.get("passengers") || "2";
  if (!from || !to || !date) return json({ configured: true, error: "from, to et date requis" }, 400);

  if (p.get("raw") === "1") {
    const [pickId, dropId] = await Promise.all([place(env, from), place(env, to)]);
    if (!pickId || !dropId) return jsonNoCache({ _debug: "taxi/full", step: "resolve", pickId, dropId,
      note: "résolution du lieu échouée — le souci est dans place()/pickPlaceId()" });

    const su = taxiSearchUrl(env, pickId, dropId, date, time, passengers);
    const r = await fetch(su.toString(), { headers: H(env) });
    let body; try { body = await r.json(); } catch (_) { body = (await r.text()).slice(0, 1200); }
    return jsonNoCache({ _debug: "taxi/full", step: "search", pickId, dropId, status: r.status,
      topKeys: (body && typeof body === "object") ? Object.keys(body) : null,
      dataKeys: (body?.data && typeof body.data === "object") ? Object.keys(body.data) : null,
      raw: body });
  }

  const ttl = parseInt(env.CARS_TTL || "21600", 10);
  const ckey = new Request(`https://escale.cache/taxi/${encodeURIComponent(from)}-${encodeURIComponent(to)}-${date}-${time}-${passengers}`);
  const cache = caches.default;
  try { const hit = await cache.match(ckey); if (hit) return json({ ...(await hit.json()), cached: true }); } catch (_) {}

  try {
    const [pickId, dropId] = await Promise.all([place(env, from), place(env, to)]);
    if (!pickId || !dropId) return json({ configured: true, taxis: [], total: 0, note: "lieu introuvable pour le transfert" });

    const su = taxiSearchUrl(env, pickId, dropId, date, time, passengers);
    const r = await fetch(su.toString(), { headers: H(env) });
    const j = await r.json();
    const rows = Array.isArray(j?.data) ? j.data
              : (Array.isArray(j?.data?.results) ? j.data.results
              : (Array.isArray(j?.data?.taxis) ? j.data.taxis
              : (Array.isArray(j?.results) ? j.results : null)));
    if (!Array.isArray(rows) || !rows.length)
      return json({ configured: true, taxis: [], total: 0, note: "aucun transfert pour ce trajet / cette date" });

    const taxis = rows.map(normTaxi).filter(t => t.price != null).sort((a, b) => a.price - b.price).slice(0, 15);
    const out = { configured: true, from, to, date, currency: taxis[0]?.currency || "EUR", taxis, total: taxis.length };
    if (taxis.length) context.waitUntil(cache.put(ckey, new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } })));
    return json(out);
  } catch (e) {
    return json({ configured: true, taxis: [], error: "transfert indisponible", detail: String(e) }, 502);
  }
}
