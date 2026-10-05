// Cloudflare Pages Function — CAP LIBRE (moteur de disponibilité inversé).
// Emplacement : functions/api/caplibre.js  →  /api/caplibre
//
// Principe : au lieu de « je veux aller à X, quand est-ce moins cher ? », on part
// de « voici quand je PEUX partir » et on trouve les destinations les moins chères
// qui rentrent dans ces fenêtres.
//
// Source de prix : le MÊME cache Travelpayouts grouped_prices que /api/calendar
// (limite 10 req/s, PAS de quota mensuel). Zéro appel SerpApi / Booking ici —
// ceux-là ne servent qu'à confirmer un prix une fois une fenêtre choisie, côté app.
//
// Jours fériés : API publique gratuite du gouvernement (calendrier.api.gouv.fr),
// sans clé, mise en cache 24 h.
//
// Appel : /api/caplibre?origins=BES,NTE&dests=OPO,BCN,MRS&month=2026-05&oneway=1&nights=3
//   origins : 1 à 5 aéroports de départ (séparés par virgule)
//   dests   : destinations à balayer (séparées par virgule) — fournies par l'app
//   month   : YYYY-MM
//   oneway  : 1 = aller simple, 0 = A/R
//   nights  : durée de séjour visée (pour l'estimation A/R), défaut 3
//   dowOut  : jours de départ acceptés, ex. "4,5" (0=lun…6=dim) — vide = tous
//   parOut  : all | even | odd — parité de semaine du DÉPART
//   dowRet  : jours de retour acceptés (ignoré si oneway) — même format que dowOut
//   parRet  : all | even | odd — parité de semaine du RETOUR
//   ponts   : 1 = ne garder que les fenêtres proches d'un jour férié

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=1800"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

// ---- jours fériés France (gratuit, sans clé, cache 24 h) ----
async function joursFeries(year) {
  const cache = caches.default;
  const ck = new Request(`https://escale.cache/feries/${year}`);
  try { const hit = await cache.match(ck); if (hit) return await hit.json(); } catch (_) {}
  try {
    const r = await fetch(`https://calendrier.api.gouv.fr/jours-feries/metropole/${year}.json`,
      { headers: { Accept: "application/json" } });
    const j = await r.json(); // { "2026-05-01": "Fête du Travail", ... }
    const set = j && typeof j === "object" ? Object.keys(j) : [];
    const out = { dates: set, names: j || {} };
    context_waitUntil(cache, ck, out);
    return out;
  } catch (_) { return { dates: [], names: {} }; }
}
function context_waitUntil(cache, ck, out) {
  try {
    cache.put(ck, new Response(JSON.stringify(out),
      { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" } }));
  } catch (_) {}
}

// ---- un mois de prix par jour pour une route (même endpoint que /api/calendar) ----
async function monthPrices(env, origin, destination, month, oneway) {
  const cache = caches.default;
  const ck = new Request(`https://escale.cache/cl/${origin}-${destination}-${month}-${oneway ? "ow" : "rt"}`);
  try { const hit = await cache.match(ck); if (hit) return await hit.json(); } catch (_) {}

  const api = new URL("https://api.travelpayouts.com/aviasales/v3/grouped_prices");
  api.searchParams.set("origin", origin);
  api.searchParams.set("destination", destination);
  api.searchParams.set("group_by", "departure_at");
  api.searchParams.set("departure_at", month);
  api.searchParams.set("one_way", oneway ? "true" : "false");
  api.searchParams.set("direct", "false");
  api.searchParams.set("currency", "eur");
  api.searchParams.set("token", env.TP_TOKEN);

  const days = {};
  try {
    const r = await fetch(api.toString(), { headers: { Accept: "application/json" } });
    const j = await r.json();
    if (j && j.data && typeof j.data === "object") {
      for (const d of Object.keys(j.data)) {
        const o = j.data[d];
        if (!o || typeof o.price !== "number") continue;
        days[d] = {
          price: o.price,
          transfers: o.transfers ?? null,
          duration: o.duration ?? null,
          airline: o.airline || null,
          return_at: o.return_at || null,
          link: o.link ? "https://www.aviasales.com" + o.link : null
        };
      }
    }
  } catch (_) {}
  try {
    cache.put(ck, new Response(JSON.stringify(days),
      { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" } }));
  } catch (_) {}
  return days;
}

function iso(d) { return d.toISOString().slice(0, 10); }
function dowOf(dateStr) { return (new Date(dateStr + "T00:00:00Z").getUTCDay() + 6) % 7; } // lundi=0 … dimanche=6
function weekParity(dateStr) {
  // n° ISO de semaine → paire / impaire (utilisé pour "semaines impaires sans garde")
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;              // lundi=0
  d.setUTCDate(d.getUTCDate() - day + 3);           // jeudi de la semaine ISO
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return { week, parity: week % 2 === 0 ? "paire" : "impaire" };
}
// parse "0,3,4" → Set([0,3,4]) ; vide/absent → null (= pas de contrainte)
function parseDowSet(v) {
  if (!v) return null;
  const s = new Set(v.split(",").map(x => parseInt(x, 10)).filter(n => n >= 0 && n <= 6));
  return s.size ? s : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!env.TP_TOKEN) return json({ error: "TP_TOKEN non configuré" }, 500);

  const origins = (p.get("origins") || "").toUpperCase().split(",").map(s => s.trim()).filter(Boolean).slice(0, 5);
  const dests   = (p.get("dests")   || "").toUpperCase().split(",").map(s => s.trim()).filter(Boolean).slice(0, 40);
  const month   = p.get("month") || "";
  const oneway  = p.get("oneway") === "1";
  const dowOut  = parseDowSet(p.get("dowOut"));     // jours de départ acceptés, ou null = tous
  const parOut  = p.get("parOut")  || "all";        // all | even | odd
  const dowRet  = parseDowSet(p.get("dowRet"));      // jours de retour acceptés (ignoré si oneway)
  const parRet  = p.get("parRet")  || "all";
  const sameWeek = p.get("sameWeek") === "1";       // retour dans la MÊME semaine ISO que le départ
  const needPonts = p.get("ponts") === "1";
  if (!origins.length || !dests.length || !/^\d{4}-\d{2}$/.test(month))
    return json({ error: "origins, dests et month (YYYY-MM) requis" }, 400);

  const year = +month.slice(0, 4);
  // fériés de l'année ET de l'année suivante (mois de décembre → ponts de janvier)
  const [f1, f2] = await Promise.all([joursFeries(year), joursFeries(year + 1)]);
  const feries = new Set([...f1.dates, ...f2.dates]);
  const ferieNames = { ...f1.names, ...f2.names };

  // balayage : pour chaque (origine × destination), le mois de prix par jour.
  // On borne à ~5 origines × 40 dests = 200 requêtes max, réparties, mais en
  // pratique l'app envoie une short-list de dests déjà filtrée par durée/budget.
  const jobs = [];
  for (const o of origins) for (const d of dests) jobs.push({ o, d });

  // limite de concurrence pour respecter 10 req/s de Travelpayouts
  const results = {};
  const CHUNK = 8;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const slice = jobs.slice(i, i + CHUNK);
    const got = await Promise.all(slice.map(j => monthPrices(env, j.o, j.d, month, oneway)));
    slice.forEach((j, k) => { results[j.o + "|" + j.d] = got[k]; });
  }

  // Pour chaque JOUR du mois, le meilleur (dest, origine, prix) toutes combinaisons.
  // On ne garde qu'une poignée de dests par jour (les moins chères).
  const byDay = {};   // "YYYY-MM-DD" -> [{dest,from,price,transfers,duration,link}]
  for (const key of Object.keys(results)) {
    const [o, d] = key.split("|");
    const days = results[key];
    for (const date of Object.keys(days)) {
      const x = days[date];
      (byDay[date] = byDay[date] || []).push({
        dest: d, from: o, price: x.price, transfers: x.transfers,
        duration: x.duration, link: x.link, return_at: x.return_at, airline: x.airline
      });
    }
  }

  // Détection des "fenêtres". Une fenêtre = un jour de départ intéressant, qualifié :
  //  - pont : férié à ±1 jour, ou week-end prolongé par un férié
  //  - we    : vendredi ou samedi (week-end long naturel)
  //  - impair/pair : parité de semaine ISO
  // On calcule un "score repos/congé" simple : nb de jours off obtenus vs congés à poser.
  const windows = [];
  for (const date of Object.keys(byDay)) {
    const dt = new Date(date + "T00:00:00Z");
    const dow = dowOf(date);
    const { week, parity } = weekParity(date);

    // contrainte jour de départ
    if (dowOut && !dowOut.has(dow)) continue;
    // contrainte semaine de départ
    if (parOut === "even" && parity !== "paire") continue;
    if (parOut === "odd"  && parity !== "impaire") continue;

    // fériés autour (fenêtre -1 / +3 jours pour repérer les ponts)
    let ferieHit = null, bridge = false;
    for (let off = -1; off <= 3; off++) {
      const nd = new Date(dt); nd.setUTCDate(nd.getUTCDate() + off);
      const s = iso(nd);
      if (feries.has(s)) { ferieHit = { date: s, name: ferieNames[s] || "férié", off }; break; }
    }
    // "pont" = un férié à proximité qui, combiné au week-end, fait un long congé
    if (ferieHit) {
      const fd = new Date(ferieHit.date + "T00:00:00Z");
      const fdow = (fd.getUTCDay() + 6) % 7;
      bridge = (fdow === 1 || fdow === 4 || fdow === 3 || fdow === 0 || fdow === 5); // lun/jeu/mer/dim/ven → pont plausible
    }
    if (needPonts && !bridge && !ferieHit) continue;

    const tags = [];
    if (bridge) tags.push("pont");
    else if (ferieHit) tags.push("ferie");
    if (dow === 4 || dow === 5) tags.push("we"); // départ ven/sam
    tags.push(parity === "impaire" ? "impair" : "pair");

    // contrainte jour/semaine de RETOUR : appliquée par destination (chaque tarif a
    // sa propre date de retour la moins chère), pas au niveau du jour de départ.
    let list = byDay[date];
    if (!oneway && (dowRet || parRet !== "all" || sameWeek)) {
      list = list.filter(x => {
        if (!x.return_at) return false;
        const rd = x.return_at.slice(0, 10);
        if (sameWeek && weekParity(rd).week !== week) return false;   // même semaine ISO que le départ
        if (dowRet && !dowRet.has(dowOf(rd))) return false;
        if (parRet !== "all") {
          const rp = weekParity(rd).parity;
          if (parRet === "even" && rp !== "paire") return false;
          if (parRet === "odd"  && rp !== "impaire") return false;
        }
        return true;
      });
    }
    list = list.sort((a, b) => a.price - b.price).slice(0, 4);
    if (!list.length) continue;

    // score : plus il y a de repos "gratuit" (pont/we) et un prix bas, mieux c'est
    let score = 0;
    if (bridge) score += 50;
    else if (ferieHit) score += 25;
    if (dow === 4 || dow === 5) score += 15;
    score += Math.max(0, 40 - Math.round(list[0].price / 3)); // prix bas = bonus
    // départ le même jour possible depuis TOUS les aéroports = bonus "groupe"
    const origSet = new Set(list.map(x => x.from));
    if (origins.length > 1 && origSet.size === origins.length) score += 10;

    windows.push({
      date, dow, week, parity,
      tags,
      ferie: ferieHit,
      bridge,
      best: list,
      minPrice: list[0].price,
      score
    });
  }

  windows.sort((a, b) => b.score - a.score || a.minPrice - b.minPrice);

  return json({
    month, oneway,
    origins, dests,
    feriesCount: feries.size,
    windows: windows.slice(0, 12),
    note: windows.length ? null : "Aucune fenêtre ne correspond à ces contraintes dans le cache ce mois-ci. Essaie un autre mois, ou élargis les jours/semaines."
  });
}
