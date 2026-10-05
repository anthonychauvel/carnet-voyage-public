// Cloudflare Pages Function — base des noms de villes/aéroports IATA (français).
// Emplacement : functions/api/cities.js  →  /api/cities
//
// Charge les fichiers publics d'Aviasales (pas de token nécessaire) et renvoie
// une table compacte { CODE_IATA : "Nom de ville" } pour afficher toutes les
// destinations en clair dans le mode « n'importe où ».

export async function onRequest(context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=604800"   // 7 jours : ces noms ne bougent quasi jamais
  };
  if (context.request.method === "OPTIONS") return new Response(null, { headers: cors });

  const names = {};
  try {
    // Villes (couvre la plupart des codes renvoyés par l'API prix)
    const cRes = await fetch("https://api.travelpayouts.com/data/fr/cities.json", { headers: { "Accept": "application/json" } });
    const cities = await cRes.json();
    for (const c of cities) if (c && c.code && c.name) names[c.code] = c.name;
  } catch (_) {}
  try {
    // Aéroports : comble les codes de niveau aéroport non présents en villes
    const aRes = await fetch("https://api.travelpayouts.com/data/fr/airports.json", { headers: { "Accept": "application/json" } });
    const airports = await aRes.json();
    for (const a of airports) {
      if (!a || !a.code) continue;
      if (!names[a.code]) names[a.code] = (a.city_code && names[a.city_code]) || a.name || a.code;
    }
  } catch (_) {}

  return new Response(JSON.stringify({ count: Object.keys(names).length, names }), { headers: cors });
}
