// Cloudflare Pages Function — LOCATION DE VOITURE (Booking via RapidAPI booking-com18).
// Emplacement : functions/api/cars.js  →  /api/cars
//
// Prix réels de location, en 2 temps côté serveur :
//   1. car/auto-complete  : ville/coords -> pickUpId (chaîne encodée)
//   2. car/search         : pickUpId + dates -> offres (loueur, modèle, prix)
//
// Quota partagé RapidAPI (plan Basic 530/mois), donc appel UNIQUEMENT sur bouton,
// jamais en fond, + cache serveur (défaut 6 h). Sans clé, l'app retombe sur le
// deep-link Discover Cars (rien ne casse).
//
// VARIABLES (Cloudflare ▸ Settings ▸ Variables and secrets)
//   RAPIDAPI_KEY    ta clé RapidAPI                         [Encrypt ✔]  (obligatoire)
//   RAPIDAPI_HOST   défaut "booking-com18.p.rapidapi.com"                (facultatif)
//   CARS_TTL        cache résultat en s, défaut 21600 (6 h)              (facultatif)
//
// Appel :
//   /api/cars?q=Lisbonne&pickUpDate=2026-03-06&dropOffDate=2026-03-09
//            [&pickUpTime=10:00&dropOffTime=10:00&lat=..&lng=..&driverAge=30]

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
function rapidHeaders(env) {
  return { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": host(env), Accept: "application/json" };
}

// --- étape 1 : résoudre un lieu en pickUpId ---
async function resolvePickUp(env, q) {
  const u = `https://${host(env)}/car/auto-complete?query=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: rapidHeaders(env) });
  const j = await r.json();
  const arr = Array.isArray(j?.data) ? j.data : [];
  if (!arr.length) return null;
  // préfère une ville, sinon un aéroport, sinon le 1er
  const pick = arr.find(x => x.type === "city") || arr.find(x => x.type === "airport") || arr[0];
  return pick ? { id: pick.id, label: pick.title || pick.name, city: pick.city, country: pick.country } : null;
}

// --- normalisation d'une offre voiture ---
function normalizeCar(x, nights) {
  const c = x.content || {};
  const sup = c.supplier || {};
  const v = x.vehicle_info || {};
  const pr = x.pricing_info || {};
  const route = (x.route_info && x.route_info.pickup) || {};
  const rating = sup.rating || {};
  const total = num(pr.drive_away_price);
  return {
    supplier: sup.name || (x.supplier_info && x.supplier_info.name) || "Loueur",
    supplierLogo: sup.imageUrl || (x.supplier_info && x.supplier_info.logo_url) || null,
    rating: num(rating.average) ?? num(x.rating_info && x.rating_info.average),   // /10 chez Booking
    ratingTitle: rating.title || null,
    reviews: rating.subtitle ? String(rating.subtitle).replace(/[^\d]/g, "") : (x.rating_info ? x.rating_info.no_of_ratings : null),
    car: v.v_name || v.group || "Véhicule",
    group: v.group || null,
    similar: v.group_or_similar || null,
    transmission: v.transmission || null,
    seats: v.seats || null,
    doors: v.doors || null,
    bags: v.suitcases ? { big: v.suitcases.big, small: v.suitcases.small } : null,
    aircon: v.aircon === 1 || v.aircon === "1",
    unlimitedMileage: v.unlimited_mileage === 1 || v.mileage === "Unlimited mileage",
    freeCancellation: v.free_cancellation === 1,
    image: v.image_url || v.image_thumbnail_url || null,
    priceTotal: total,
    pricePerDay: total != null && nights ? Math.round(total / nights) : null,
    currency: pr.currency || "USD",
    payWhen: x.pay_when_text || (pr.pay_when === "PAY_LOCAL" ? "Paiement sur place" : null),
    locationName: route.name || null,
    locationType: route.location_type || null,     // IN_TERMINAL / SHUTTLE_BUS…
    lat: num(route.latitude), lng: num(route.longitude),
    url: x.forward_url || null
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  // sans clé → l'app garde le deep-link Discover Cars
  if (!env.RAPIDAPI_KEY) return json({ configured: false, reason: "RAPIDAPI_KEY non configurée" });

  const q = (p.get("q") || "").trim();
  const pickUpDate  = p.get("pickUpDate")  || "";
  const dropOffDate = p.get("dropOffDate") || "";
  const pickUpTime  = p.get("pickUpTime")  || "10:00";
  const dropOffTime = p.get("dropOffTime") || "10:00";
  const driverAge   = p.get("driverAge")   || "30";
  const lat = p.get("lat"), lng = p.get("lng");

  if ((!q && !(lat && lng)) || !pickUpDate || !dropOffDate)
    return json({ configured: true, error: "q (ou lat/lng), pickUpDate et dropOffDate requis" }, 400);

  const nights = Math.max(1, Math.round((new Date(dropOffDate) - new Date(pickUpDate)) / 86400000));

  // --- cache résultat : même ville/dates = 0 crédit pendant CARS_TTL ---
  const ttl = parseInt(env.CARS_TTL || "1800", 10); // 30 min : le lien de réservation reste frais
  const ckey = new Request(`https://escale.cache/cars/${encodeURIComponent(q || lat + "," + lng)}-${pickUpDate}-${dropOffDate}`);
  const cache = caches.default;
  try { const hit = await cache.match(ckey); if (hit) return json({ ...(await hit.json()), cached: true }); } catch (_) {}

  try {
    // étape 1 : pickUpId
    let pickUpId = null, label = q;
    const loc = await resolvePickUp(env, q || `${lat},${lng}`);
    if (!loc || !loc.id)
      return json({ configured: true, cars: [], total: 0, note: "lieu introuvable pour la location de voiture" });
    pickUpId = loc.id; label = loc.label || q;

    // étape 2 : recherche
    const su = new URL(`https://${host(env)}/car/search`);
    su.searchParams.set("pickUpId", pickUpId);
    su.searchParams.set("dropOffId", pickUpId);          // même lieu par défaut
    su.searchParams.set("pickUpDate", pickUpDate);
    su.searchParams.set("dropOffDate", dropOffDate);
    su.searchParams.set("pickUpTime", pickUpTime);
    su.searchParams.set("dropOffTime", dropOffTime);
    su.searchParams.set("driverAge", driverAge);
    su.searchParams.set("currencyCode", "EUR");

    const r = await fetch(su.toString(), { headers: rapidHeaders(env) });
    const j = await r.json();

    if (p.get("raw") === "1") return json({ _debug: "cars/search", status: r.status,
      topKeys: (j && typeof j === "object") ? Object.keys(j) : null,
      dataKeys: (j?.data && typeof j.data === "object") ? Object.keys(j.data) : null,
      raw: j });

    // le bug connu de cette API : data peut être null malgré status true
    const results = j?.data?.search_results;
    if (!Array.isArray(results) || !results.length)
      return json({ configured: true, cars: [], total: 0, label,
        note: "aucune voiture disponible pour ce lieu / ces dates" });

    const cars = results.map(x => normalizeCar(x, nights))
                        .filter(c => c.priceTotal != null)
                        .sort((a, b) => a.priceTotal - b.priceTotal)
                        .slice(0, 20);

    const out = {
      configured: true, label, pickUpDate, dropOffDate, nights,
      currency: cars[0]?.currency || "EUR",
      cars, total: cars.length, fetched_at: new Date().toISOString()
    };
    if (cars.length)
      context.waitUntil(cache.put(ckey, new Response(JSON.stringify(out), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` }
      })));
    return json(out);

  } catch (e) {
    return json({ configured: true, cars: [], error: "location de voiture indisponible", detail: String(e) }, 502);
  }
}
