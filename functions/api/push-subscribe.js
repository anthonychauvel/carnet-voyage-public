// Cloudflare Pages Function — enregistre (ou supprime) un abonnement Web Push + la config
// à surveiller pour cet abonné, dans un namespace KV.
// Emplacement : functions/api/push-subscribe.js  →  POST /api/push-subscribe
//
// PRÉREQUIS Cloudflare Pages :
//  1. Créer un namespace KV (Workers & Pages → KV) et le lier au projet Pages sous le nom
//     de binding "PUSH_KV" (Settings → Functions → KV namespace bindings).
//  2. Variables d'environnement : VAPID_PUBLIC, VAPID_PRIVATE (générées côté serveur),
//     et VAPID_SUBJECT (ex. "mailto:toi@exemple.fr"). Puis redéployer.
//
// Corps attendu (JSON) :
//  { action?: "subscribe"|"unsubscribe", subscription: {endpoint, keys:{p256dh, auth}}, config?: {...} }
//  config = { zones:[{origins,months,oneway}], watch:[codes] } — ce que le cron scannera.

export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json({ error: "POST requis" }, 405, cors);
  if (!env.PUSH_KV) return json({ error: "binding KV 'PUSH_KV' non configuré sur le projet Pages" }, 500, cors);

  let data;
  try { data = await request.json(); } catch (_) { return json({ error: "JSON invalide" }, 400, cors); }
  const sub = data.subscription;
  if (!sub || !sub.endpoint) return json({ error: "subscription requise" }, 400, cors);

  const id = await sha256hex(sub.endpoint);

  if (data.action === "unsubscribe") {
    await env.PUSH_KV.delete("sub:" + id);
    return json({ ok: true, removed: true }, 200, cors);
  }

  // enregistrement : abonnement + config + dernier scan (vide au départ)
  const rec = { subscription: sub, config: data.config || {}, last: {}, ts: Date.now() };
  await env.PUSH_KV.put("sub:" + id, JSON.stringify(rec));
  return json({ ok: true, id }, 200, cors);
}

function json(o, status, cors) { return new Response(JSON.stringify(o), { status: status || 200, headers: cors }); }
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
