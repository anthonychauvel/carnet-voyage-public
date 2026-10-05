// Cloudflare Pages Function — PRIX LIVE avec bascule automatique de fournisseur.
// Emplacement : functions/api/live.js  →  /api/live
//
// CHAÎNE DE FOURNISSEURS (dans l'ordre) :
//   1. SerpApi      — Google Flights — 250 recherches/mois gratuites
//   2. SearchApi.io — Google Flights — 100 requêtes gratuites (relais)
//   3. épuisé       — l'app retombe sur les prix en cache Travelpayouts
//
// COMPTAGE
//   • SerpApi : on lit le VRAI compteur du compte via https://serpapi.com/account.json
//     (gratuit, ne consomme aucun crédit). C'est le chiffre qui fait foi, pas une
//     estimation locale : il reste juste même si tu appelles l'API depuis ailleurs.
//   • SearchApi : pas de compteur public → compteur interne (KV si disponible,
//     sinon Cache API) + coupure immédiate si le fournisseur renvoie une erreur de quota.
//
// VARIABLES (Cloudflare Pages ▸ Settings ▸ Variables and Secrets)
//   SERP_TOKEN        clé SerpApi                              [Encrypt ✔]
//   SEARCHAPI_TOKEN   clé SearchApi.io (facultatif, le relais) [Encrypt ✔]
//   SERP_BUDGET       seuil de bascule, défaut 249 (sur 250)
//   SEARCHAPI_BUDGET  seuil de bascule, défaut 99  (sur 100)
//   LIVE_TTL          cache serveur des résultats en s, défaut 21600 (6 h)
//   ESCALE_KV         binding KV facultatif mais recommandé (compteur durable)
//
// APPELS
//   /api/live                          → état des quotas (aucun crédit consommé)
//   /api/live?origin=NTE&destination=DUB&depart=2026-03-06&return=2026-03-08

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const month = () => new Date().toISOString().slice(0, 7);

/* ---------------------------------------------------------------- compteur
   KV si le binding existe (durable, global), sinon Cache API (best-effort).
   Le compteur ne sert que pour SearchApi : SerpApi a son propre compteur officiel. */
function ledger(env) {
  const kv = env.ESCALE_KV || null;
  const key = (id) => `escale:usage:${id}:${month()}`;
  const url = (id) => `https://escale.ledger/${id}/${month()}`;

  async function read(id) {
    try {
      if (kv) {
        const v = await kv.get(key(id), "json");
        return v || { used: 0, tripped: false };
      }
      const hit = await caches.default.match(new Request(url(id)));
      return hit ? await hit.json() : { used: 0, tripped: false };
    } catch (_) { return { used: 0, tripped: false }; }
  }
  async function write(id, v) {
    try {
      if (kv) { await kv.put(key(id), JSON.stringify(v), { expirationTtl: 60 * 60 * 24 * 40 }); return; }
      await caches.default.put(
        new Request(url(id)),
        new Response(JSON.stringify(v), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3456000" }
        })
      );
    } catch (_) {}
  }
  return {
    backend: kv ? "kv" : "cache",
    read,
    async bump(id, n = 1) { const v = await read(id); v.used = (v.used || 0) + n; await write(id, v); return v; },
    async trip(id) { const v = await read(id); v.tripped = true; await write(id, v); return v; }
  };
}

/* ------------------------------------------------- compteur officiel SerpApi
   account.json est gratuit et NE CONSOMME PAS de recherche. Mis en cache 60 s
   pour ne pas le rappeler à chaque double-tap. */
async function serpAccount(env, ctx) {
  const ck = new Request("https://escale.cache/serp-account");
  try {
    const hit = await caches.default.match(ck);
    if (hit) return await hit.json();
  } catch (_) {}
  try {
    const r = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(env.SERP_TOKEN)}`,
      { headers: { Accept: "application/json" } });
    const j = await r.json();
    const out = {
      used: typeof j.this_month_usage === "number" ? j.this_month_usage : null,
      limit: typeof j.searches_per_month === "number" ? j.searches_per_month : null,
      left: typeof j.total_searches_left === "number" ? j.total_searches_left : null,
      hour_used: j.this_hour_searches ?? null,
      hour_limit: j.account_rate_limit_per_hour ?? null,
      renewal: j.plan_renewal_date || null,
      ok: true
    };
    ctx.waitUntil(caches.default.put(ck, new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" }
    })));
    return out;
  } catch (_) {
    return { ok: false, used: null, limit: null, left: null };
  }
}

/* ------------------------------------------------------------- normalisation
   SerpApi et SearchApi renvoient la même forme (best_flights / other_flights),
   d'où un seul parseur pour les deux. */
// Prix Aviasales/Travelpayouts (gratuit) — sert à croiser avec le live et garder le moins cher.
async function tpPrice(env, origin, destination, depart, ret) {
  if (!env.TP_TOKEN) return null;
  try {
    const api = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
    api.searchParams.set("origin", origin);
    api.searchParams.set("destination", destination);
    if (depart) api.searchParams.set("departure_at", depart.slice(0, 7));
    if (ret) api.searchParams.set("return_at", ret.slice(0, 7));
    api.searchParams.set("one_way", ret ? "false" : "true");
    api.searchParams.set("direct", "false");
    api.searchParams.set("currency", "eur");
    api.searchParams.set("sorting", "price");
    api.searchParams.set("limit", "1");
    api.searchParams.set("token", env.TP_TOKEN);
    const r = await fetch(api.toString(), { headers: { Accept: "application/json" } });
    const j = await r.json();
    const b = Array.isArray(j?.data) && j.data.length ? j.data[0] : null;
    if (!b || typeof b.price !== "number") return null;
    return { price: b.price, transfers: b.transfers ?? null, duration: b.duration_to ?? null,
             url: b.link ? "https://www.aviasales.com" + b.link : null };
  } catch (_) { return null; }
}

// Compare le résultat live et le cache Aviasales, garde le moins cher, étiquette la source.
// Le PRIX AFFICHÉ reste celui de Google Flights (LIVE, réservable maintenant).
// Aviasales/Travelpayouts est du CACHE (« vu récemment, ≤ 7 j ») → seulement indicatif,
// jamais substitué au prix live. On l'expose à part, avec l'écart, pour information.
function pickCheapest(live, tp) {
  const out = { ...live };
  out.live_price = live.price ?? null;            // Google Flights, ferme
  out.tp_price = tp ? tp.price : null;            // Aviasales, indicatif
  out.tp_url = tp && tp.url ? tp.url : null;
  out.tp_stops = tp && tp.transfers != null ? tp.transfers : null;
  // le prix principal NE CHANGE PAS : c'est le live. La source reste Google.
  if (live.price != null) out.cheapest_source = "google";
  // repère informatif : Aviasales est-il plus bas (à confirmer) ?
  if (out.live_price != null && out.tp_price != null && out.tp_price < out.live_price)
    out.tp_cheaper_by = Math.round(out.live_price - out.tp_price);
  return out;
}

// Empaquette une offre brute SerpApi/SearchApi en objet compact (prix, escales, durée…).
function packOffer(o) {
  if (!o || typeof o.price !== "number") return null;
  const legs = o.flights || [];
  return {
    price: o.price,
    airlines: [...new Set(legs.map(f => f.airline).filter(Boolean))],
    stops: legs.length ? legs.length - 1 : null,
    duration: o.total_duration ?? null,
    departure_time: legs[0]?.departure_airport?.time || null,
    arrival_time: legs.length ? legs[legs.length - 1]?.arrival_airport?.time || null : null
  };
}

// Reproduit le trio « Le meilleur / Le moins cher / Le plus rapide », à partir des
// MÊMES données déjà reçues (aucun appel en plus, donc aucun coût de quota). Les
// trois peuvent être identiques si le fournisseur ne renvoie qu'une poignée d'offres
// pour la route — c'est attendu, pas un bug.
function normalize(j, provider, jPrice) {
  const poolOf = (resp) => [].concat(resp?.best_flights || [], resp?.other_flights || [])
                            .filter(o => typeof o?.price === "number");
  const all = poolOf(j).concat(jPrice ? poolOf(jPrice) : []);
  if (!all.length) return { price: null, currency: "EUR", offers: 0, provider };

  const byPrice = [...all].sort((a, b) => a.price - b.price);
  const withDur = all.filter(o => typeof o.total_duration === "number");
  const byDur = withDur.length ? [...withDur].sort((a, b) => a.total_duration - b.total_duration) : byPrice;

  const cheapestRaw = byPrice[0];
  const fastestRaw = byDur[0];
  // « Le meilleur » : le choix mis en avant par le fournisseur lui-même, dans la
  // requête PRINCIPALE uniquement (best_flights[0], tri "Meilleurs vols" par défaut)
  // — jamais celui du 2e appel "Prix" (jPrice), qui ne sert qu'à compléter
  // cheapest/fastest avec les offres que l'onglet "Meilleurs vols" écarte.
  const bestRaw = (j?.best_flights || []).find(o => typeof o?.price === "number") || cheapestRaw;

  const best = packOffer(bestRaw), cheapest = packOffer(cheapestRaw), fastest = packOffer(fastestRaw);
  const meta = j?.search_metadata || {};

  return {
    // rétro-compat : le 1er niveau reste le MOINS CHER (comportement historique,
    // sert de base à pickCheapest() et au cache serveur).
    ...cheapest,
    currency: "EUR",
    offers: all.length,
    insights: j?.price_insights ? {
      lowest: j.price_insights.lowest_price ?? null,
      level: j.price_insights.price_level ?? null,
      typical: j.price_insights.typical_price_range ?? null
    } : null,
    url: meta.google_flights_url || meta.request_url || null,
    provider,
    // les 3 chiffres à afficher comme sur Skyscanner
    trio: { best, cheapest, fastest }
  };
}

/* -------------------------------------------------- normalisation HÔTELS
   Exclut les auberges de jeunesse / dortoirs : on veut une chambre avec
   salle de bain privative. Trois leviers cumulés :
     · hotel_class=2,3,4,5  → les auberges, sans classement, sortent d'office
     · type "vacation rental" écarté
     · filet de sécurité sur le nom (hostel, auberge de jeunesse, dortoir…) */
const DORM_RE = /\b(hostel|hostels|auberge de jeunesse|backpacker|backpackers|dormitor|dorm\b|youth hostel|jugendherberge|ostello|albergue)\b/i;

function hav(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function ymd(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? { y: m[1], mo: String(+m[2]), d: String(+m[3]) } : null;
}
// Lien Booking défensif : deux formats de date envoyés ensemble (ISO + année/mois/jour
// séparés), impossible de vérifier lequel le site utilise réellement sans accès réseau
// sortant depuis cet environnement — voir la même fonction dans stays.js.
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

function normalizeHotels(j, provider, opts) {
  const centre = opts.centre, maxKm = opts.maxKm, privateOnly = opts.privateOnly;
  const props = [].concat(j?.properties || []);
  let dropped = { dortoirs: 0, tropLoin: 0, locations: 0 };

  const out = props.map(x => {
    const g = x.gps_coordinates || {};
    const lat = typeof g.latitude === "number" ? g.latitude : null;
    const lng = typeof g.longitude === "number" ? g.longitude : null;
    const perNight = x.rate_per_night?.extracted_lowest ?? null;
    const total = x.total_rate?.extracted_lowest ?? null;
    return {
      name: x.name || "Hébergement",
      type: x.type || "hotel",
      stars: x.extracted_hotel_class ?? null,
      rating: typeof x.overall_rating === "number" ? Math.round(x.overall_rating * 10) / 10 : null,
      reviews: x.reviews ?? null,
      locationRating: x.location_rating ?? null,
      pricePerNight: perNight != null ? Math.round(perNight) : null,
      priceTotal: total != null ? Math.round(total) : null,
      lat, lng,
      distanceKm: (centre && lat != null && lng != null)
        ? Math.round(hav(centre, { lat, lng }) * 10) / 10 : null,
      amenities: (x.amenities || []).slice(0, 6),
      freeCancellation: !!x.free_cancellation,
      thumb: x.images?.[0]?.thumbnail || null,
      // Lien Booking qui pré-remplit dates+voyageurs (le lien Google brut, x.link,
      // ne porte pas les dates de façon fiable — gardé à part comme comparaison,
      // sans promettre qu'il pré-remplit quoi que ce soit).
      url: bookingSearchUrl(x.name, opts.checkIn, opts.checkOut, opts.adults),
      googleUrl: x.link || null,
      essential: (x.essential_info || []).slice(0, 4)
    };
  })
  .filter(h => {
    if (privateOnly && (DORM_RE.test(h.name) || h.type === "vacation rental")) {
      if (h.type === "vacation rental") dropped.locations++; else dropped.dortoirs++;
      return false;
    }
    if (maxKm && h.distanceKm != null && h.distanceKm > maxKm) { dropped.tropLoin++; return false; }
    return true;
  })
  .filter(h => h.pricePerNight != null)
  .sort((a, b) => a.pricePerNight - b.pricePerNight);

  return { hotels: out.slice(0, 25), total: out.length, dropped, provider };
}

async function callSerpHotels(env, o) {
  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google_hotels");
  u.searchParams.set("q", o.q);
  u.searchParams.set("check_in_date", o.checkIn);
  u.searchParams.set("check_out_date", o.checkOut);
  u.searchParams.set("adults", String(o.adults || 2));
  if (o.children) { u.searchParams.set("children", String(o.children));
                    if (o.childrenAges) u.searchParams.set("children_ages", o.childrenAges); }
  u.searchParams.set("currency", "EUR");
  u.searchParams.set("hl", "fr");
  u.searchParams.set("gl", "fr");
  u.searchParams.set("sort_by", "3");                       // 3 = prix le plus bas
  if (o.privateOnly) u.searchParams.set("hotel_class", "2,3,4,5");
  if (o.minStars) u.searchParams.set("hotel_class",
        [2,3,4,5].filter(n => n >= o.minStars).join(","));
  if (o.rating) u.searchParams.set("rating", String(o.rating));   // 7=3.5+ 8=4.0+ 9=4.5+
  if (o.maxPrice) u.searchParams.set("max_price", String(o.maxPrice));
  u.searchParams.set("api_key", env.SERP_TOKEN);
  const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  return await r.json();
}

async function callSearchApiHotels(env, o) {
  const u = new URL("https://www.searchapi.io/api/v1/search");
  u.searchParams.set("engine", "google_hotels");
  u.searchParams.set("q", o.q);
  u.searchParams.set("check_in_date", o.checkIn);
  u.searchParams.set("check_out_date", o.checkOut);
  u.searchParams.set("adults", String(o.adults || 2));
  u.searchParams.set("currency", "EUR");
  u.searchParams.set("hl", "fr");
  u.searchParams.set("gl", "fr");
  u.searchParams.set("api_key", env.SEARCHAPI_TOKEN);
  const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  return await r.json();
}

const quotaError = (t) => /quota|run out|exceed|limit|insufficient|credit|402|429/i.test(String(t || ""));

/* --------------------------------------------------- Sky Scrapper (RapidAPI)
   Deuxième comparateur, EN PLUS de SerpApi/SearchApi (pas un repli) : l'intérêt
   est de voir les combinaisons « correspondance autonome » multi-compagnies que
   Google Flights ne voit pas (diagnostic Brest→Bangkok, notes du 22/08/2026).
   Réutilise RAPIDAPI_KEY (déjà branché pour hôtels/voiture) : il suffit de
   s'abonner en plus, gratuitement, à l'API "Sky Scrapper" sur RapidAPI pour que
   la même clé fonctionne dessus aussi (quota séparé, ~100/mois côté Sky Scrapper).
   Aller-retour : le paramètre natif round-trip de cette API n'est pas documenté
   de façon fiable → on fait 2 recherches aller simple (2 crédits) et on additionne
   le moins cher de chaque sens. C'est cohérent avec le principe même du
   self-transfer : des billets séparés, combinés côté client. */
const SKY_HOST = "sky-scrapper.p.rapidapi.com";
function skyHeaders(env) {
  return { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": SKY_HOST, Accept: "application/json" };
}

// IATA → identifiants internes Sky Scrapper. Un aéroport ne change jamais :
// cache très long (90 j), ne consomme le quota qu'une fois par aéroport au total.
async function skyResolve(env, iata) {
  const ck = new Request(`https://escale.cache/sky-airport/${iata}`);
  try { const hit = await caches.default.match(ck); if (hit) return await hit.json(); } catch (_) {}
  try {
    const u = new URL(`https://${SKY_HOST}/api/v1/flights/searchAirport`);
    u.searchParams.set("query", iata);
    u.searchParams.set("locale", "fr-FR");
    const r = await fetch(u.toString(), { headers: skyHeaders(env) });
    const j = await r.json();
    const hit0 = Array.isArray(j?.data) ? j.data[0] : null;
    const out = (hit0 && hit0.skyId && hit0.entityId) ? { skyId: hit0.skyId, entityId: hit0.entityId } : null;
    if (out) {
      caches.default.put(ck, new Response(JSON.stringify(out), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=7776000" }
      })).catch(() => {});
    }
    return out;
  } catch (_) { return null; }
}

// Une "itinerary" Sky Scrapper (aller simple, 1 leg) → même forme que packOffer().
function skyPackOffer(it) {
  const price = it?.price?.raw;
  if (typeof price !== "number") return null;
  const leg = (it.legs || [])[0] || {};
  const airlines = [...new Set((leg.carriers?.marketing || []).map(c => c?.name).filter(Boolean))];
  return {
    price: Math.round(price),
    airlines,
    stops: typeof leg.stopCount === "number" ? leg.stopCount : null,
    duration: typeof leg.durationInMinutes === "number" ? leg.durationInMinutes : null,
    departure_time: leg.departure || null,
    arrival_time: leg.arrival || null
  };
}

async function skyOneWay(env, from, to, date) {
  const u = new URL(`https://${SKY_HOST}/api/v1/flights/searchFlights`);
  u.searchParams.set("originSkyId", from.skyId);
  u.searchParams.set("destinationSkyId", to.skyId);
  u.searchParams.set("originEntityId", from.entityId);
  u.searchParams.set("destinationEntityId", to.entityId);
  u.searchParams.set("date", date);
  u.searchParams.set("adults", "1");
  u.searchParams.set("currency", "EUR");
  u.searchParams.set("countryCode", "FR");
  u.searchParams.set("market", "fr-FR");
  const r = await fetch(u.toString(), { headers: skyHeaders(env) });
  const j = await r.json();
  if (j?.status === false) throw new Error(String(j?.message || "Sky Scrapper : réponse en erreur"));
  const its = j?.data?.itineraries;
  return Array.isArray(its) ? its.map(skyPackOffer).filter(Boolean) : [];
}

// Combine le moins cher de chaque sens en une offre A/R (voir note ci-dessus).
function skyCombineRoundTrip(outOffers, backOffers) {
  const bestOut = outOffers.slice().sort((a, b) => a.price - b.price)[0];
  const bestBack = backOffers.slice().sort((a, b) => a.price - b.price)[0];
  if (!bestOut || !bestBack) return [];
  return [{
    price: bestOut.price + bestBack.price,
    airlines: [...new Set([...(bestOut.airlines || []), ...(bestBack.airlines || [])])],
    stops: (bestOut.stops || 0) + (bestBack.stops || 0),
    duration: (bestOut.duration || 0) + (bestBack.duration || 0),
    departure_time: bestOut.departure_time,
    arrival_time: bestBack.arrival_time
  }];
}

// Point d'entrée : { offers, calls } — calls = crédits RapidAPI réellement
// consommés (1 aller simple, 2 en aller-retour), pour un comptage de quota exact.
async function callSkyScrapper(env, origin, destination, depart, ret) {
  const [from, to] = await Promise.all([skyResolve(env, origin), skyResolve(env, destination)]);
  if (!from || !to) return { offers: [], calls: 0, error: "aéroport non résolu côté Sky Scrapper" };

  const outOffers = await skyOneWay(env, from, to, depart);
  if (!ret) return { offers: outOffers, calls: 1 };

  const backOffers = await skyOneWay(env, to, from, ret);
  return { offers: skyCombineRoundTrip(outOffers, backOffers), calls: 2 };
}

// Fait gagner à cheapest/fastest une offre externe si elle fait réellement mieux
// (ne touche jamais "best", qui reste le choix éditorial du fournisseur principal).
function mergeExternalOffer(trio, offers, source) {
  for (const o of offers) {
    if (!o || o.price == null) continue;
    const tagged = { ...o, source };
    if (!trio.cheapest || tagged.price < trio.cheapest.price) trio.cheapest = tagged;
    if (tagged.duration != null && (!trio.fastest || (trio.fastest.duration != null && tagged.duration < trio.fastest.duration)))
      trio.fastest = tagged;
  }
}

/* ---------------------------------------------------------------- requêtes */
async function callSerp(env, o, d, dep, ret, sortBy) {
  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google_flights");
  u.searchParams.set("departure_id", o);
  u.searchParams.set("arrival_id", d);
  u.searchParams.set("outbound_date", dep);
  if (ret) u.searchParams.set("return_date", ret);
  u.searchParams.set("type", ret ? "1" : "2");         // 1 = A/R, 2 = aller simple
  u.searchParams.set("currency", "EUR");
  u.searchParams.set("hl", "fr");
  u.searchParams.set("gl", "fr");
  // Sans ça, SerpApi répond en mode rapide et volontairement incomplet — documenté :
  // "results you receive by default may differ from what you see on Google Flights
  // in the browser". Constaté sur Brest→Montpellier (Volotea direct absent alors que
  // visible sur Google) — deep_search=true corrige exactement ce trou, au prix d'un
  // temps de réponse plus long (sans coût CPU Cloudflare, juste de l'attente réseau).
  // deep_search=true seul ne suffisait pas (constaté : toujours 273€ au lieu de 197€
  // avec &nocache=1). La doc précise que show_hidden "n'a aucun effet seul" — il faut
  // les DEUX ensemble pour retrouver les vols que l'algo "meilleurs vols" de Google
  // relègue par défaut (souvent des tarifs simples/economy basiques, ce qui correspond
  // au profil du Volotea manquant).
  u.searchParams.set("deep_search", "true");
  u.searchParams.set("show_hidden", "true");
  // sort_by : 1=Meilleurs vols (défaut, onglet "best_flights" de Google) / 2=Prix
  // (onglet "Prix le moins cher"). Constaté : ce sont 2 requêtes DISTINCTES côté
  // Google, pas juste un re-tri — sort_by=1 seul peut rater la vraie offre la moins
  // chère si elle est écartée de la sélection "top flights" (cas Volotea/BES→MPL).
  if (sortBy) u.searchParams.set("sort_by", sortBy);
  u.searchParams.set("api_key", env.SERP_TOKEN);
  const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  return await r.json();
}

async function callSearchApi(env, o, d, dep, ret) {
  const u = new URL("https://www.searchapi.io/api/v1/search");
  u.searchParams.set("engine", "google_flights");
  u.searchParams.set("departure_id", o);
  u.searchParams.set("arrival_id", d);
  u.searchParams.set("outbound_date", dep);
  if (ret) u.searchParams.set("return_date", ret);
  u.searchParams.set("flight_type", ret ? "round_trip" : "one_way");
  u.searchParams.set("currency", "EUR");
  u.searchParams.set("hl", "fr");
  u.searchParams.set("gl", "fr");
  u.searchParams.set("api_key", env.SEARCHAPI_TOKEN);
  const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  return await r.json();
}

/* ------------------------------------------------------------ état des quotas */
async function status(env, ctx) {
  const led = ledger(env);
  const out = { configured: false, backend: led.backend, providers: [], active: null, total_left: 0 };

  if (env.SERP_TOKEN) {
    const budget = parseInt(env.SERP_BUDGET || "249", 10);
    const acc = await serpAccount(env, ctx);
    const local = await led.read("serpapi");
    const used = acc.used != null ? acc.used : (local.used || 0);
    const left = Math.max(0, budget - used);
    out.providers.push({
      id: "serpapi", label: "SerpApi · Google Flights",
      used, budget, left,
      counter: acc.ok ? "compte SerpApi (officiel)" : "local (compte injoignable)",
      hour_used: acc.hour_used, hour_limit: acc.hour_limit,
      renewal: acc.renewal,
      available: left > 0 && !local.tripped
    });
  }
  if (env.SEARCHAPI_TOKEN) {
    const budget = parseInt(env.SEARCHAPI_BUDGET || "99", 10);
    const l = await led.read("searchapi");
    const left = Math.max(0, budget - (l.used || 0));
    out.providers.push({
      id: "searchapi", label: "SearchApi.io · Google Flights (relais)",
      used: l.used || 0, budget, left,
      counter: "local (" + led.backend + ")",
      available: left > 0 && !l.tripped
    });
  }

  out.configured = out.providers.length > 0;
  const first = out.providers.find(p => p.available);
  out.active = first ? first.id : null;
  out.total_left = out.providers.reduce((a, p) => a + (p.available ? p.left : 0), 0);
  out.exhausted = out.configured && !out.active;

  // Sky Scrapper : comparateur EN PLUS, quota et disponibilité suivis à part —
  // n'affecte jamais out.configured/out.active/out.exhausted ci-dessus.
  if (env.RAPIDAPI_KEY) {
    const budget = parseInt(env.SKY_BUDGET || "95", 10);
    const l = await led.read("skyscrapper");
    const left = Math.max(0, budget - (l.used || 0));
    out.sky = {
      id: "skyscrapper", label: "Sky Scrapper · combinaisons multi-compagnies",
      configured: true, used: l.used || 0, budget, left,
      counter: "local (" + led.backend + ")",
      available: left > 0 && !l.tripped
    };
  } else {
    out.sky = { id: "skyscrapper", configured: false };
  }

  // scrape.do (secours Kayak) : quota suivi localement, budget = crédits du forfait (~1000).
  // "used" est une ESTIMATION (~5 crédits/appel render) ; le décompte réel est sur scrape.do.
  if (env.SCRAPEDO_TOKEN || env.SCAPEDO_TOKEN) {
    const budget = parseInt(env.SCRAPEDO_BUDGET || env.SCAPEDO_BUDGET || "1000", 10);
    const l = await led.read("scrapedo");
    const left = Math.max(0, budget - (l.used || 0));
    out.scrapedo = {
      id: "scrapedo", label: "scrape.do · secours Kayak (crédits estimés)",
      configured: true, used: l.used || 0, budget, left,
      counter: "local (" + led.backend + ", ~5 crédits/appel estimés)",
      available: left > 0 && !l.tripped
    };
  } else {
    out.scrapedo = { id: "scrapedo", configured: false };
  }

  return out;
}

/* -------------------------------------------------------------- handler */
// SECOURS via scrape.do : récupère le prix Kayak le moins cher en scrapant la page.
// ⚠️ Contraire aux CGU de Kayak, FRAGILE (leur HTML change, anti-bot actif → scrape.do
// peut renvoyer une page de défi sans prix) et nécessite render=true (plusieurs crédits
// scrape.do par appel). Renvoie {price,url} ou null. N'est appelé QUE lorsque le quota
// principal est épuisé (voir onRequest), et le résultat est mis en cache (LIVE_TTL) pour
// ne pas re-scraper la même route/dates. Extraction heuristique du montant € le plus bas.
async function kayakScrape(env, origin, destination, depart, ret) {
  const token = env.SCRAPEDO_TOKEN || env.SCAPEDO_TOKEN;
  const none = { price: null, url: null, requested: false };
  if (!token || !origin || !destination || !depart) return none;
  const path = `${origin}-${destination}/${depart}` + (ret ? `/${ret}` : "");
  const kayakUrl = `https://www.kayak.fr/flights/${path}?sort=price_a`;
  const api = "https://api.scrape.do/?token=" + encodeURIComponent(token)
            + "&url=" + encodeURIComponent(kayakUrl) + "&render=true";
  try {
    const r = await fetch(api, { headers: { Accept: "text/html" } });
    // requête envoyée = crédits scrape.do consommés (facturés même sans prix exploitable)
    if (!r.ok) return { price: null, url: kayakUrl, requested: true };
    const html = await r.text();
    // Tous les montants "N €" plausibles pour un vol → on garde le plus petit.
    // Gère les séparateurs de milliers (espace normal/insécable/fine, point, virgule).
    const prices = [];
    const re = /(\d[\d \u00a0\u202f.,]{0,8}\d|\d)\s*€/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const n = parseInt(m[1].replace(/[ \u00a0\u202f.,]/g, ""), 10);
      if (Number.isFinite(n) && n >= 20 && n <= 5000) prices.push(n);
    }
    if (!prices.length) return { price: null, url: kayakUrl, requested: true };
    prices.sort((a, b) => a - b);
    return { price: prices[0], url: kayakUrl, requested: true };
  } catch (_) { return { price: null, url: kayakUrl, requested: false }; }
}

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  const kind = (p.get("kind") || "flight").toLowerCase();
  const origin      = (p.get("origin")      || "").toUpperCase();
  const destination = (p.get("destination") || "").toUpperCase();
  const depart = p.get("depart") || "";
  const ret    = p.get("return") || "";

  const st = await status(env, context);

  /* ---------- HÔTELS EN DIRECT (même quota que les vols) ---------- */
  if (kind === "hotel") {
    const q = (p.get("q") || "").trim();
    const checkIn = p.get("checkIn") || "", checkOut = p.get("checkOut") || "";
    if (!q || !checkIn || !checkOut)
      return json({ ...st, error: "q, checkIn et checkOut requis" }, 400);
    if (!st.configured) return json({ configured: false });

    const lat = parseFloat(p.get("lat")), lng = parseFloat(p.get("lng"));
    const opts = {
      q, checkIn, checkOut,
      adults: parseInt(p.get("adults") || "2", 10) || 2,
      children: parseInt(p.get("children") || "0", 10) || 0,
      childrenAges: p.get("childrenAges") || "",
      privateOnly: p.get("privateOnly") !== "0",
      minStars: parseInt(p.get("minStars") || "0", 10) || 0,
      rating: parseInt(p.get("rating") || "0", 10) || 0,
      maxPrice: parseInt(p.get("maxPrice") || "0", 10) || 0,
      maxKm: parseFloat(p.get("maxKm") || "0") || 0,
      centre: (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null
    };

    const hk = new Request("https://escale.cache/hotellive/"
      + [q, checkIn, checkOut, opts.adults, opts.privateOnly ? 1 : 0,
         opts.minStars, opts.rating, opts.maxKm].join("-").replace(/\s+/g, "_"));
    try { const hit = await caches.default.match(hk);
          if (hit) return json({ ...(await hit.json()), cached: true, quota: st }); } catch (_) {}

    if (st.exhausted)
      return json({ configured: true, hotels: [], exhausted: true, quota: st,
        note: "quota live épuisé — utilise la recherche en cache, gratuite et illimitée" });

    const ledH = ledger(env), triedH = [];
    for (const prov of st.providers) {
      if (!prov.available) continue;
      try {
        const raw = prov.id === "serpapi" ? await callSerpHotels(env, opts)
                                          : await callSearchApiHotels(env, opts);
        const err = raw?.error || raw?.message;
        if (err) { triedH.push({ provider: prov.id, error: String(err) });
                   if (quotaError(err)) { await ledH.trip(prov.id); } continue; }
        await ledH.bump(prov.id);
        const out = { configured: true, kind: "hotel", q, checkIn, checkOut,
                      ...normalizeHotels(raw, prov.id, opts),
                      fetched_at: new Date().toISOString() };
        if (out.hotels.length) {
          const ttlH = parseInt(env.LIVE_TTL || "21600", 10);
          context.waitUntil(caches.default.put(hk, new Response(JSON.stringify(out), {
            headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlH}` }
          })));
        }
        return json({ ...out, tried: triedH, quota: await status(env, context) });
      } catch (e) { triedH.push({ provider: prov.id, error: String(e) }); }
    }
    return json({ configured: true, hotels: [], tried: triedH,
                  quota: await status(env, context),
                  error: "aucun fournisseur n'a pu répondre" }, 502);
  }

  // Aucun paramètre → simple état des quotas, aucun crédit consommé.
  if (!origin && !destination && !depart) return json(st);

  if (!st.configured) return json({ configured: false, reason: "aucune clé de prix live configurée" });
  if (!origin || !destination || !depart)
    return json({ ...st, error: "origin, destination et depart requis" }, 400);

  // --- cache résultat : même route + mêmes dates = 0 crédit pendant LIVE_TTL ---
  const ttl = parseInt(env.LIVE_TTL || "21600", 10);
  const ck = new Request(`https://escale.cache/live/${origin}-${destination}-${depart}-${ret || "ow"}`);
  if (p.get("nocache") !== "1") {
    try {
      const hit = await caches.default.match(ck);
      if (hit) return json({ ...(await hit.json()), cached: true, quota: st });
    } catch (_) {}
  }

  if (st.exhausted) {
    const led0 = ledger(env);

    // secours 1 : Sky Scrapper (3ᵉ fournisseur) s'il reste du budget — prix réel réservable.
    // Essayé AVANT scrape.do : scrape.do ne doit passer qu'APRÈS les trois fournisseurs.
    const skyNeed = ret ? 2 : 1;
    if (st.sky?.configured && st.sky.available && st.sky.left >= skyNeed) {
      try {
        const sky = await callSkyScrapper(env, origin, destination, depart, ret);
        if (sky.calls) await led0.bump("skyscrapper", sky.calls);
        if (sky.offers && sky.offers.length) {
          const b = [...sky.offers].sort((a, c) => a.price - c.price)[0];
          const out = { configured: true, origin, destination, depart, return: ret || null,
                        price: Math.round(b.price), stops: b.stops ?? null, duration: b.duration ?? null,
                        airlines: b.airlines || [], url: null, cheapest_source: "sky",
                        exhausted: true, quota: await status(env, context),
                        note: "quotas Google épuisés — prix via Sky Scrapper (réservable)" };
          context.waitUntil(caches.default.put(ck, new Response(JSON.stringify(out), {
            headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` }
          })));
          return json(out);
        }
      } catch (_) { /* Sky échoue → on tente scrape.do */ }
    }

    // secours 2 : Kayak en direct via scrape.do (crédits scrape.do) — prix estimé.
    // Souvent bloqué par l'anti-bot de Kayak → pas de prix, on bascule sur Aviasales.
    const ky = await kayakScrape(env, origin, destination, depart, ret);
    // décompte des crédits scrape.do (~5/appel render) dès qu'une requête part, puis
    // on recalcule le quota pour que l'app affiche le bon reste sur 1000.
    const st2 = ky.requested
      ? (await led0.bump("scrapedo", parseInt(env.SCRAPEDO_CREDITS_PER_CALL || env.SCAPEDO_CREDITS_PER_CALL || "5", 10)), await status(env, context))
      : await status(env, context);
    if (ky.price != null) {
      const out = { configured: true, price: ky.price, stops: null, duration: null,
                    url: ky.url, cheapest_source: "kayak", scraped: true, indicative: true,
                    live_price: null, tp_price: null, exhausted: true, quota: st2,
                    note: "quotas Google et Sky épuisés — prix Kayak récupéré en direct (estimation, à confirmer)" };
      context.waitUntil(caches.default.put(ck, new Response(JSON.stringify(out), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` }
      })));
      return json(out);
    }
    // secours 3 : Aviasales indicatif (cache gratuit) — dernier recours
    const tp = await tpPrice(env, origin, destination, depart, ret);
    if (tp && tp.price != null)
      return json({ configured: true, price: tp.price, stops: tp.transfers, duration: tp.duration,
                    url: tp.url, cheapest_source: "aviasales", indicative: true,
                    tp_price: tp.price, live_price: null,
                    exhausted: true, quota: st2,
                    note: "tous les fournisseurs épuisés — prix Aviasales indicatif (cache, à confirmer)" });
    return json({ configured: true, price: null, exhausted: true, quota: st2,
                  note: "quota live épuisé pour ce mois — les prix affichés restent ceux du cache Aviasales" });
  }

  const led = ledger(env);
  const tried = [];

  for (const prov of st.providers) {
    if (!prov.available) continue;
    try {
      let raw, rawPrice = null, credits = 1;
      if (prov.id === "serpapi") {
        raw = await callSerp(env, origin, destination, depart, ret);
        const err0 = raw?.error || raw?.message;
        // 2e requête "Prix" (sort_by=2), fusionnée dans normalize() pour que
        // cheapest/fastest reflètent le vrai onglet "Prix le moins cher" de Google —
        // pas seulement "Meilleurs vols" (découverte du 23/08 : ce sont 2 requêtes
        // distinctes côté Google, pas un re-tri de la même liste). Coûte 1 crédit
        // de plus ; sautée si le budget est trop juste ou si elle échoue (on garde
        // alors quand même "best" du 1er appel, sans amélioration de cheapest/fastest).
        if (!err0 && prov.left >= 2) {
          try {
            const rp = await callSerp(env, origin, destination, depart, ret, "2");
            if (!(rp?.error || rp?.message)) { rawPrice = rp; credits = 2; }
          } catch (_) {}
        }
      } else {
        raw = await callSearchApi(env, origin, destination, depart, ret);
      }

      const err = raw?.error || raw?.message;
      if (err) {
        tried.push({ provider: prov.id, error: String(err) });
        if (quotaError(err)) { await led.trip(prov.id); continue; }   // → fournisseur suivant
        continue;
      }

      await led.bump(prov.id, credits);                       // compteur interne (relais + secours)
      let out = { configured: true, origin, destination, depart, return: ret || null,
                    ...normalize(raw, prov.id, rawPrice), fetched_at: new Date().toISOString() };

      // croisement gratuit avec Aviasales : on garde le moins cher des deux
      const tp = await tpPrice(env, origin, destination, depart, ret);
      out = pickCheapest(out, tp);

      // croisement Sky Scrapper (en plus, pas en repli) : voir la doc plus haut.
      // N'affecte jamais le résultat principal en cas d'échec (try/catch dédié).
      const skyNeeds = ret ? 2 : 1;
      if (st.sky?.configured && st.sky.left >= skyNeeds && out.trio) {
        try {
          const sky = await callSkyScrapper(env, origin, destination, depart, ret);
          if (sky.calls) await led.bump("skyscrapper", sky.calls);
          out.sky_checked = true;
          if (sky.offers.length) mergeExternalOffer(out.trio, sky.offers, "sky");
          else if (sky.error) tried.push({ provider: "skyscrapper", error: sky.error });
        } catch (e) {
          tried.push({ provider: "skyscrapper", error: String(e) });
        }
      }

      if (out.price != null) {
        context.waitUntil(caches.default.put(ck, new Response(JSON.stringify(out), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` }
        })));
      }
      // état recalculé après consommation, pour que l'app affiche le bon reste
      return json({ ...out, tried, quota: await status(env, context) });

    } catch (e) {
      tried.push({ provider: prov.id, error: String(e) });
    }
  }

  return json({ configured: true, price: null, tried, quota: await status(env, context),
                error: "aucun fournisseur n'a pu répondre" }, 502);
}
