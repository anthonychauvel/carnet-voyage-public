// Cloudflare Pages Function — ATTRACTIONS / ACTIVITÉS via RapidAPI booking-com18.
// Emplacement : functions/api/attractions.js  →  /api/attractions
//
// 2 temps : attraction/auto-complete (ville -> id) puis attraction/search (activités).
// Quota RapidAPI partagé (530/mois) → sur bouton + cache 12 h. Sans clé : configured:false.
//
// Appel : /api/attractions?q=Lisbonne

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=3600"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const num = (x) => (typeof x === "number" ? x : (x != null && !isNaN(parseFloat(x)) ? parseFloat(x) : null));
function host(env) { return env.RAPIDAPI_HOST || "booking-com18.p.rapidapi.com"; }
function H(env) { return { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": host(env), Accept: "application/json" }; }

async function place(env, q) {
  const u = `https://${host(env)}/attraction/auto-complete?query=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: H(env) });
  const j = await r.json();
  const arr = Array.isArray(j?.data?.destinations) ? j.data.destinations
            : (Array.isArray(j?.data) ? j.data : (Array.isArray(j?.data?.products) ? j.data.products : []));
  if (!arr.length) return null;
  const d = arr[0];
  return d.id ?? d.productId ?? d.dest_id ?? null;
}

function normAttraction(x) {
  const price = x.representativePrice || {};
  const rev = x.numericReviewsStats || {};
  const geo = x.ufiDetails || {};
  const bestseller = Array.isArray(x.flags) && x.flags.some(f => f.flag === "bestseller" && f.value);
  return {
    name: x.name || "Activité",
    desc: x.shortDescription || null,
    photo: (x.primaryPhoto && x.primaryPhoto.small) || null,
    price: num(price.publicAmount) ?? num(price.chargeAmount),
    currency: price.currency || "EUR",
    rating: num(rev.average),                       // /5
    reviews: rev.total ?? null,
    bestseller,
    freeCancellation: !!(x.cancellationPolicy && x.cancellationPolicy.hasFreeCancellation),
    lat: num(geo.latitude), lng: num(geo.longitude),
    slug: x.slug || null,
    url: x.slug ? `https://www.booking.com/attractions/${(geo.url && geo.url.country) || "fr"}/${x.slug}.html` : null
  };
}

// L'autocomplétion attractions de Booking est anglophone : "Palma de Majorque" n'y
// existe pas (il faut "Palma de Mallorca"), idem Séville/Seville, Londres/London…
// On traduit donc AVANT d'appeler Booking, via l'autocomplétion Travelpayouts
// (gratuite, sans token, déjà utilisée par /api/place et /api/seewhat) : nom FR →
// code IATA → nom EN. Fait en premier justement pour ne pas gaspiller de quota
// RapidAPI sur une requête vouée à ne rien trouver.
async function tpAuto(locale, term) {
  const u = `https://autocomplete.travelpayouts.com/places2?locale=${locale}&types[]=city&term=${encodeURIComponent(term)}`;
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
async function enName(q, code) {
  try {
    let c = (code || "").trim().toUpperCase();
    if (!c) {
      const fr = await tpAuto("fr", q);
      if (!fr.length) return null;
      c = String(fr[0].code || "").toUpperCase();
    }
    if (!c) return null;
    const en = await tpAuto("en", c);
    if (!en.length) return null;
    const hit = en.find(x => String(x.code || "").toUpperCase() === c) || en[0];
    return hit && hit.name ? String(hit.name) : null;
  } catch (_) { return null; }
}

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!env.RAPIDAPI_KEY) return json({ configured: false });

  const q = (p.get("q") || "").trim();
  const code = (p.get("code") || "").trim();   // code IATA si l'app le connaît (traduction plus fiable)
  if (!q) return json({ configured: true, error: "q requis" }, 400);

  const ttl = 43200; // 12 h : ça bouge peu
  const ckey = new Request(`https://escale.cache/attr/${encodeURIComponent(q)}`);
  const cache = caches.default;
  try { const hit = await cache.match(ckey); if (hit) return json({ ...(await hit.json()), cached: true }); } catch (_) {}

  try {
    // nom anglais d'abord (gratuit), nom saisi en repli
    const qEn = await enName(q, code);
    let id = qEn ? await place(env, qEn) : null;
    if (!id && (!qEn || qEn.toLowerCase() !== q.toLowerCase())) id = await place(env, q);
    if (!id) return json({ configured: true, attractions: [], total: 0, note: "ville introuvable pour les activités" });

    const su = new URL(`https://${host(env)}/attraction/search`);
    su.searchParams.set("id", String(id));
    su.searchParams.set("currency_code", "EUR");
    const r = await fetch(su.toString(), { headers: H(env) });
    const j = await r.json();
    const rows = j?.data?.products;
    if (!Array.isArray(rows) || !rows.length)
      return json({ configured: true, attractions: [], total: 0, note: "aucune activité trouvée pour cette ville" });

    const attractions = rows.map(normAttraction)
      .filter(a => a.name)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))     // les mieux notées d'abord
      .slice(0, 20);
    const out = { configured: true, q, currency: attractions[0]?.currency || "EUR", attractions, total: attractions.length };
    context.waitUntil(cache.put(ckey, new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } })));
    return json(out);
  } catch (e) {
    return json({ configured: true, attractions: [], error: "activités indisponibles", detail: String(e) }, 502);
  }
}
