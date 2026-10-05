// Cloudflare Pages Function — scan périodique + envoi des notifications push.
// Emplacement : functions/api/cron.js  →  GET /api/cron?key=SECRET
//
// À DÉCLENCHER périodiquement (Pages n'a pas de Cron intégré). Deux options gratuites :
//  - un cron externe (cron-job.org) qui appelle https://ton-site/api/cron?key=XXX toutes les
//    2–6 h ;
//  - un petit Worker compagnon avec un Cron Trigger qui fait le même fetch.
//
// PRÉREQUIS : binding KV "PUSH_KV" + variables VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT
// + CRON_SECRET (le "key" attendu ci-dessous). Redéployer après config.
//
// ⚠️ La crypto Web Push (chiffrement aes128gcm RFC 8291 + JWT VAPID RFC 8292) est écrite à la
// main avec WebCrypto — elle N'A PAS pu être testée hors ligne. À vérifier sur un vrai appareil.

export async function onRequest(context) {
  const { request, env } = context;
  const p = new URL(request.url).searchParams;
  if (!env.CRON_SECRET || p.get("key") !== env.CRON_SECRET) return new Response("forbidden", { status: 403 });
  if (!env.PUSH_KV) return new Response("KV 'PUSH_KV' non configuré", { status: 500 });
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return new Response("clés VAPID non configurées", { status: 500 });

  const base = new URL(request.url).origin;
  const testMode = p.get("test") === "1";   // envoie une notif de test immédiate (validation crypto)
  const DROP_PCT = 0.90;   // baisse d'au moins 10 %
  const DROP_ABS = 15;     // et d'au moins 15 €
  let checked = 0, sent = 0, removed = 0, errors = 0;

  const list = await env.PUSH_KV.list({ prefix: "sub:" });
  for (const k of list.keys) {
    const raw = await env.PUSH_KV.get(k.name);
    if (!raw) continue;
    let rec; try { rec = JSON.parse(raw); } catch (_) { continue; }
    if (!rec || !rec.subscription) continue;
    checked++;

    if (testMode) {
      const payload = JSON.stringify({ title: "🔔 Test Escale", body: "Si tu vois ça, les notifications marchent 🎉", url: "./" });
      try {
        const status = await sendPush(rec.subscription, payload, {
          vapidPublic: env.VAPID_PUBLIC, vapidPrivate: env.VAPID_PRIVATE,
          subject: env.VAPID_SUBJECT || "mailto:admin@example.com"
        });
        if (status === 201 || status === 200) sent++;
        else if (status === 404 || status === 410) { await env.PUSH_KV.delete(k.name); removed++; }
        else errors++;
      } catch (_) { errors++; }
      continue;
    }

    const cfg = rec.config || {}, last = rec.last || {}, zones = cfg.zones || [];
    const watch = (cfg.watch && cfg.watch.length) ? new Set(cfg.watch) : null;
    const drops = [];

    for (const z of zones) {
      const origins = (z.origins || []).slice(0, 5).filter(Boolean);
      const months = (z.months || []).slice(0, 2);
      for (const o of origins) {
        for (const m of months) {
          let results = [];
          try {
            const r = await fetch(base + "/api/anywhere?origin=" + encodeURIComponent(o) + "&oneway=" + (z.oneway ? 1 : 0) + "&month=" + encodeURIComponent(m));
            const j = await r.json();
            results = j.results || [];
          } catch (_) { errors++; }
          for (const it of results) {
            if (it.price == null || !it.destination) continue;
            if (watch && !watch.has(it.destination)) continue;
            const key = o + "|" + it.destination + "|" + m;
            const prev = last[key];
            last[key] = it.price;
            if (prev != null && it.price <= prev * DROP_PCT && (prev - it.price) >= DROP_ABS) {
              drops.push({ dest: it.destination, from: o, price: it.price, was: prev });
            }
          }
        }
      }
    }

    rec.last = last;
    await env.PUSH_KV.put(k.name, JSON.stringify(rec));

    if (drops.length) {
      drops.sort((a, b) => a.price - b.price);
      const d = drops[0];
      const extra = drops.length > 1 ? " · +" + (drops.length - 1) + " autre" + (drops.length > 2 ? "s" : "") : "";
      const payload = JSON.stringify({
        title: "✈️ Baisse repérée",
        body: d.dest + " depuis " + d.from + " : " + d.price + " € (était " + d.was + " €)" + extra,
        url: "./"
      });
      try {
        const status = await sendPush(rec.subscription, payload, {
          vapidPublic: env.VAPID_PUBLIC, vapidPrivate: env.VAPID_PRIVATE,
          subject: env.VAPID_SUBJECT || "mailto:admin@example.com"
        });
        if (status === 201 || status === 200) sent++;
        else if (status === 404 || status === 410) { await env.PUSH_KV.delete(k.name); removed++; }
        else errors++;
      } catch (_) { errors++; }
    }
  }

  return new Response(JSON.stringify({ ok: true, build: "cron-testmode-1", checked, sent, removed, errors }), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

/* ---------- Web Push : VAPID (RFC 8292) + chiffrement aes128gcm (RFC 8291) ---------- */

const b64uToBytes = s => {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
};
const bytesToB64u = b => {
  const a = new Uint8Array(b); let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const concat = (...arrs) => {
  let len = 0; arrs.forEach(a => len += a.length);
  const out = new Uint8Array(len); let o = 0;
  arrs.forEach(a => { out.set(a, o); o += a.length; });
  return out;
};
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}
async function vapidJWT(audience, subject, vapidPublic, vapidPrivate) {
  const enc = o => bytesToB64u(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const signingInput = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud: audience, exp: now + 12 * 3600, sub: subject });
  const pub = b64uToBytes(vapidPublic); // 65 bytes 0x04||x||y
  const jwk = { kty: "EC", crv: "P-256", d: vapidPrivate, x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return signingInput + "." + bytesToB64u(new Uint8Array(sig));
}
async function encryptPayload(payload, p256dhB64u, authB64u) {
  const ua_public = b64uToBytes(p256dhB64u), auth = b64uToBytes(authB64u);
  const server = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const as_public = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua_public, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, server.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(new TextEncoder().encode("WebPush: info\0"), ua_public, as_public), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const pt = concat(new TextEncoder().encode(payload), new Uint8Array([2])); // délimiteur dernier enregistrement
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, pt));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([as_public.length]), as_public, ct);
}
async function sendPush(subscription, payload, opts) {
  const url = new URL(subscription.endpoint);
  const jwt = await vapidJWT(url.origin, opts.subject, opts.vapidPublic, opts.vapidPrivate);
  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "TTL": "2419200",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "Authorization": "vapid t=" + jwt + ", k=" + opts.vapidPublic
    },
    body
  });
  return res.status;
}
