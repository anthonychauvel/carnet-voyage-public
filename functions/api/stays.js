// Cloudflare Pages Function — HÔTELS BOOKING (photos + notes) via RapidAPI booking-com18.
// Emplacement : functions/api/stays.js  →  /api/stays
//
// Complète /api/hotels (cache Hotellook, gratuit mais sans photo ni note).
// Ici : vraies PHOTOS + NOTES voyageurs + prix Booking, en 2 temps :
//   1. stays/auto-complete : ville -> dest_id (+ type)
//   2. stays/search        : dest_id + dates -> hôtels
//
// Quota RapidAPI partagé (Basic 530/mois) → appel UNIQUEMENT sur bouton + cache 6 h.
// Sans RAPIDAPI_KEY : { configured:false } (l'app garde le cache Hotellook / ⚡ Google).
//
// Appel :
//   /api/stays?q=Lisbonne&checkIn=2026-03-06&checkOut=2026-03-09
//             [&adults=2&minStars=2&maxKm=3&lat=..&lng=..&privateOnly=1]

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=1800"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const num = (x) => (typeof x === "number" ? x : (x != null && !isNaN(parseFloat(x)) ? parseFloat(x) : null));

function host(env) { return env.RAPIDAPI_HOST || "booking-com18.p.rapidapi.com"; }
function rapidHeaders(env) {
  return { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": host(env), Accept: "application/json" };
}

const DORM_RE = /\b(hostel|hostels|auberge de jeunesse|backpacker|backpackers|dormitor|dorm\b|youth hostel|jugendherberge|ostello|albergue)\b/i;

function haversine(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// grosse photo : les URLs viennent en square60, on tente une taille correcte
function bigPhoto(url) {
  if (!url) return null;
  return url.replace(/\/square60\//, "/square300/").replace(/\/max\d+\//, "/max500/");
}

async function resolveDest(env, q) {
  const u = `https://${host(env)}/stays/auto-complete?query=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: rapidHeaders(env) });
  const j = await r.json();
  const arr = Array.isArray(j?.data) ? j.data : [];
  if (!arr.length) return null;
  const pick = arr.find(x => (x.dest_type || x.search_type || x.type) === "city") || arr[0];
  return pick ? {
    // "id" est le token que le nouveau /stays/search exige comme locationId
    // (base64 "eyJ..."), à ne pas confondre avec dest_id (l'UFI numérique).
    location_id: pick.id ?? null,
    dest_id: pick.dest_id ?? pick.city_ufi ?? pick.ufi ?? pick.value,
    dest_type: pick.dest_type || pick.search_type || pick.type || "city",
    label: pick.label || pick.name || pick.city_name || pick.cityName || q,
    lat: num(pick.latitude ?? pick.lat), lng: num(pick.longitude ?? pick.lon ?? pick.lng)
  } : null;
}

function ymd(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? { y: m[1], mo: String(+m[2]), d: String(+m[3]) } : null;
}
// Lien de réservation Booking. Deux formats de date envoyés ENSEMBLE : "checkin="
// (ISO, documenté par la Demand API) et "checkin_year/month/monthday" (vu sur une
// vraie URL de résultats Booking captée récemment) — impossible de vérifier lequel
// le site utilise vraiment depuis cet environnement (pas d'accès réseau sortant),
// donc les deux sont envoyés plutôt que de parier sur un seul.
function bookingSearchUrl(name, checkIn, checkOut, adults) {
  if (!name) return null;
  const u = new URL("https://www.booking.com/searchresults.html");
  u.searchParams.set("ss", name);
  u.searchParams.set("checkin", checkIn || "");
  u.searchParams.set("checkout", checkOut || "");
  const ci = ymd(checkIn), co = ymd(checkOut);
  if (ci) { u.searchParams.set("checkin_year", ci.y); u.searchParams.set("checkin_month", ci.mo); u.searchParams.set("checkin_monthday", ci.d); }
  if (co) { u.searchParams.set("checkout_year", co.y); u.searchParams.set("checkout_month", co.mo); u.searchParams.set("checkout_monthday", co.d); }
  u.searchParams.set("group_adults", String(adults || 2));
  u.searchParams.set("no_rooms", "1");
  u.searchParams.set("group_children", "0");
  return u.toString();
}

function normalizeStay(x, centre, checkIn, checkOut, adults) {
  const pb = x.priceBreakdown || {};
  const gross = pb.grossPrice || {};
  const strike = pb.strikethroughPrice || {};
  const lat = num(x.latitude), lng = num(x.longitude);
  const perTotal = num(gross.value);
  return {
    id: x.id ?? null,
    name: x.name || "Hôtel",
    stars: x.accuratePropertyClass || x.propertyClass || 0,
    rating: num(x.reviewScore),                       // /10
    ratingWord: x.reviewScoreWord || null,
    reviews: x.reviewCount ?? null,
    priceTotal: perTotal != null ? Math.round(perTotal) : null,
    priceStrike: strike.value ? Math.round(num(strike.value)) : null,
    currency: gross.currency || x.currency || "EUR",
    photo: bigPhoto((x.photoUrls && x.photoUrls[0]) || null),
    lat, lng,
    distanceKm: (centre && lat != null && lng != null)
      ? Math.round(haversine(centre, { lat, lng }) * 10) / 10 : null,
    checkin: x.checkin ? x.checkin.fromTime : null,
    country: x.countryCode || null,
    url: bookingSearchUrl(x.name ? (x.name + " " + (x.city_name || "")) : null, checkIn, checkOut, adults)
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!env.RAPIDAPI_KEY) return json({ configured: false, reason: "RAPIDAPI_KEY non configurée" });

  const q = (p.get("q") || "").trim();
  const checkIn = p.get("checkIn") || "", checkOut = p.get("checkOut") || "";
  if (!q || !checkIn || !checkOut)
    return json({ configured: true, error: "q, checkIn et checkOut requis" }, 400);

  const adults = parseInt(p.get("adults") || "2", 10) || 2;
  const minStars = parseInt(p.get("minStars") || "0", 10) || 0;
  const maxKm = parseFloat(p.get("maxKm") || "0") || 0;
  const privateOnly = p.get("privateOnly") !== "0";
  const lat = parseFloat(p.get("lat")), lng = parseFloat(p.get("lng"));
  const centre = (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;

  const nights = Math.max(1, Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000));

  const ttl = parseInt(env.CARS_TTL || "21600", 10);
  const ckey = new Request(`https://escale.cache/stays/${encodeURIComponent(q)}-${checkIn}-${checkOut}-${adults}`);
  const cache = caches.default;
  try { const hit = await cache.match(ckey); if (hit) { const o = await hit.json(); return json({ ...applyFilters(o, { minStars, maxKm, privateOnly, centre, nights }), cached: true }); } } catch (_) {}

  try {
    const loc = await resolveDest(env, q);
    if (!loc || loc.dest_id == null)
      return json({ configured: true, hotels: [], total: 0, note: "ville introuvable côté Booking" });

    const su = new URL(`https://${host(env)}/stays/search`);
    // Le fournisseur exige "locationId" = le token "id" de l'auto-complete (base64),
    // PAS l'UFI dest_id. On envoie le token ; on garde dest_id/destType par compat.
    su.searchParams.set("locationId", String(loc.location_id ?? loc.dest_id));
    su.searchParams.set("destId", String(loc.dest_id));
    su.searchParams.set("destType", loc.dest_type || "city");
    su.searchParams.set("checkinDate", checkIn);
    su.searchParams.set("checkoutDate", checkOut);
    su.searchParams.set("adults", String(adults));
    su.searchParams.set("rooms", "1");
    su.searchParams.set("units", "metric");
    su.searchParams.set("currencyCode", "EUR");
    const r = await fetch(su.toString(), { headers: rapidHeaders(env) });
    const j = await r.json();

    const rows = Array.isArray(j?.data) ? j.data
              : (Array.isArray(j?.data?.hotels) ? j.data.hotels
              : (Array.isArray(j?.data?.results) ? j.data.results
              : (Array.isArray(j?.data?.properties) ? j.data.properties : null)));
    if (!rows || !rows.length)
      return json({ configured: true, hotels: [], total: 0, label: loc.label,
        note: "aucun hôtel Booking pour cette ville / ces dates" });

    // on garde une base large en cache (filtres appliqués à la lecture)
    const base = rows.map(x => normalizeStay(x, centre, checkIn, checkOut, adults)).filter(h => h.priceTotal != null);
    const out = { configured: true, label: loc.label, checkIn, checkOut, nights,
      currency: base[0]?.currency || "EUR", hotelsBase: base, fetched_at: new Date().toISOString() };
    context.waitUntil(cache.put(ckey, new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` }
    })));
    return json(applyFilters(out, { minStars, maxKm, privateOnly, centre, nights }));

  } catch (e) {
    return json({ configured: true, hotels: [], error: "hôtels Booking indisponibles", detail: String(e) }, 502);
  }
}

// filtres appliqués à la volée (permet de garder un cache large)
function applyFilters(out, f) {
  let drop = { dortoirs: 0, tropLoin: 0, categorie: 0 };
  const hotels = (out.hotelsBase || []).map(h => ({
    ...h,
    // recalcule la distance si un centre est fourni maintenant
    distanceKm: f.centre && h.lat != null && h.lng != null
      ? Math.round(haversine(f.centre, { lat: h.lat, lng: h.lng }) * 10) / 10 : h.distanceKm,
    pricePerNight: h.priceTotal != null ? Math.round(h.priceTotal / (out.nights || f.nights || 1)) : null
  })).filter(h => {
    if (f.privateOnly && DORM_RE.test(h.name)) { drop.dortoirs++; return false; }
    if (f.minStars && h.stars < f.minStars) { drop.categorie++; return false; }
    if (f.maxKm && h.distanceKm != null && h.distanceKm > f.maxKm) { drop.tropLoin++; return false; }
    return true;
  }).sort((a, b) => a.priceTotal - b.priceTotal).slice(0, 100);
  return { configured: out.configured, label: out.label, checkIn: out.checkIn, checkOut: out.checkOut,
    nights: out.nights, currency: out.currency, hotels, total: hotels.length, filtered: drop };
}
