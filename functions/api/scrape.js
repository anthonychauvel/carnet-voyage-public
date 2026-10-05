// Cloudflare Pages Function — PROXY scrape.do (capacité de scraping supplémentaire).
// Emplacement : functions/api/scrape.js  →  /api/scrape?url=...
//
// Récupère le HTML (ou JSON/Markdown) d'une page cible via scrape.do. Le token vient de
// la variable d'environnement SCRAPEDO_TOKEN (à définir dans le dashboard Cloudflare Pages,
// exactement comme TP_TOKEN). AUCUN token n'est écrit en dur ici.
//
// ⚠️ Restreint à une LISTE BLANCHE de domaines : sans ça, l'endpoint serait un proxy
//    ouvert que n'importe qui pourrait utiliser pour brûler tes crédits ou scraper
//    n'importe quel site à travers ton domaine. Édite ALLOW ci-dessous selon tes besoins.
//
// Paramètres :
//   url      (obligatoire) — l'URL cible (sera encodée automatiquement)
//   render   = "true" pour un rendu navigateur JS (nécessaire pour Google Flights / Kayak /
//              Skyscanner…) — COÛTE PLUSIEURS CRÉDITS par appel, à utiliser avec parcimonie
//   output   = "markdown" (optionnel) pour recevoir du Markdown au lieu du HTML
//   geoCode  = "fr" (optionnel, plan Pro) pour sortir depuis une IP du pays
//
// Note honnête : scraper des comparateurs de vols est contraire à leurs CGU, exige souvent
// render=true, et casse quand leur HTML évolue. Cette brique est le tuyau ; l'extraction
// d'un prix précis dépend du site ciblé et devra être écrite au cas par cas.

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  const target = (p.get("url") || "").trim();

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  const token = env.SCRAPEDO_TOKEN || env.SCAPEDO_TOKEN;
  if (!token)  return json({ error: "token scrape.do absent — ajoute SCRAPEDO_TOKEN (ou SCAPEDO_TOKEN) dans Cloudflare Pages → Settings → Environment variables, puis redéploie" }, 500);
  if (!target) return json({ error: "paramètre url requis" }, 400);

  // Liste blanche de domaines autorisés — ajoute/retire selon les sites que tu veux scraper.
  const ALLOW = [
    "google.com", "google.fr",          // Google Flights / SERP
    "kayak.fr", "kayak.com",
    "skyscanner.fr", "skyscanner.net",
    "booking.com",
    "cdiscount.com",
    "aviasales.com",
    "liligo.fr", "liligo.com"
  ];
  let host = "";
  try { host = new URL(target).hostname.replace(/^www\./, "").toLowerCase(); }
  catch (_) { return json({ error: "url invalide" }, 400); }
  const allowed = ALLOW.some(d => host === d || host.endsWith("." + d));
  if (!allowed) return json({ error: "domaine non autorisé", host, allow: ALLOW }, 403);

  // Construit l'appel scrape.do (URLSearchParams encode automatiquement l'URL cible).
  const api = new URL("https://api.scrape.do/");
  api.searchParams.set("token", token);
  api.searchParams.set("url", target);
  if (p.get("render") === "true") api.searchParams.set("render", "true");
  const output = p.get("output");   if (output)  api.searchParams.set("output", output);
  const geoCode = p.get("geoCode"); if (geoCode) api.searchParams.set("geoCode", geoCode);

  try {
    const r = await fetch(api.toString(), { headers: { Accept: "*/*" } });
    const body = await r.text();
    const ctype = r.headers.get("content-type") || "text/html; charset=utf-8";
    // On renvoie le corps brut (HTML/JSON/Markdown) tel quel, avec le statut d'origine,
    // pour qu'un parseur côté client ou une autre fonction puisse en extraire le prix.
    return new Response(body, {
      status: r.status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": ctype,
        "Cache-Control": "public, max-age=1800"   // 30 min : évite de recracher des crédits
      }
    });
  } catch (e) {
    return json({ error: "échec appel scrape.do", detail: String(e) }, 502);
  }
}
