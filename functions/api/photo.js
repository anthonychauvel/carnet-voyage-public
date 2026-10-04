// Photos du carnet : POST = envoyer une photo, GET ?id= = la récupérer.
// Stockage : Cloudflare R2 (binding « PHOTOS ») si relié, sinon la base D1 (binding « DB »).
// Les anciennes photos restées dans D1 sont toujours lues : rien n'est perdu au passage sur R2.
const MAX_PHOTO = 1_900_000;
// Garde-fous : D1 gratuit = 500 Mo par base → arrêt à 400 Mo. R2 gratuit = 10 Go → arrêt à 9 Go.
const MAX_TOTAL_D1 = 400_000_000;
const MAX_TOTAL_R2 = 9_000_000_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Carnet-Code, X-Photo-Id',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function spaceOf(request, env) {
  if (!env.DB) return json({ error: 'Base D1 non liée (binding « DB » manquant)' }, 500);
  const code = (request.headers.get('X-Carnet-Code') || '').trim();
  if (code.length < 8) return json({ error: 'Code du carnet manquant' }, 400);
  if (env.SPACE_CODES) {
    const allowed = String(env.SPACE_CODES).split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(code)) return json({ error: 'Code de carnet non autorisé sur ce serveur' }, 403);
  }
  return sha256('carnet-voyage:' + code);
}
const validId = id => typeof id === 'string' && /^[\w.\-]{1,120}$/.test(id);
const r2Key = (space, id) => space + '/' + id;

// Compteur de taille totale, rangé dans D1 (clé 'total' pour D1, 'r2' pour R2)
async function getTotal(env, k) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS photo_stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL)').run();
  const st = await env.DB.prepare('SELECT v FROM photo_stats WHERE k = ?1').bind(k).first();
  if (st) return st.v;
  let start = 0;
  if (k === 'total') {
    const s = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS t FROM photos').first();
    start = s ? s.t : 0;
  }
  await env.DB.prepare('INSERT OR IGNORE INTO photo_stats (k, v) VALUES (?1, ?2)').bind(k, start).run();
  return start;
}

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env }) {
  const space = await spaceOf(request, env);
  if (space instanceof Response) return space;
  const id = request.headers.get('X-Photo-Id') || '';
  if (!validId(id)) return json({ error: 'Identifiant de photo invalide' }, 400);
  const mime = (request.headers.get('Content-Type') || 'image/jpeg').split(';')[0];
  if (!/^image\//.test(mime)) return json({ error: 'Ce n’est pas une image' }, 415);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'Photo vide' }, 400);
  if (buf.byteLength > MAX_PHOTO) return json({ error: 'Photo trop lourde' }, 413);

  // ── R2 ──
  if (env.PHOTOS) {
    const key = r2Key(space, id);
    const total = await getTotal(env, 'r2');
    const old = await env.PHOTOS.head(key);          // photo renvoyée une 2e fois : on ne compte que la différence
    const delta = buf.byteLength - (old ? old.size : 0);
    if (total + delta > MAX_TOTAL_R2) return json({ error: 'Stockage des photos plein', total }, 507);
    await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: mime } });
    await env.DB.prepare("UPDATE photo_stats SET v = v + ?1 WHERE k = 'r2'").bind(delta).run();
    return json({ ok: true, id, size: buf.byteLength, store: 'r2' });
  }

  // ── D1 (si R2 n'est pas relié) ──
  const total = await getTotal(env, 'total');
  if (total + buf.byteLength > MAX_TOTAL_D1) return json({ error: 'Stockage des photos plein', total }, 507);
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO photos (space, id, mime, data, size, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(space, id, mime, buf, buf.byteLength, Date.now()),
    env.DB.prepare("UPDATE photo_stats SET v = v + ?1 WHERE k = 'total'").bind(buf.byteLength),
  ]);
  return json({ ok: true, id, size: buf.byteLength, store: 'd1' });
}

export async function onRequestGet({ request, env }) {
  const space = await spaceOf(request, env);
  if (space instanceof Response) return space;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!validId(id)) return json({ error: 'Identifiant de photo invalide' }, 400);
  const cache = 'private, max-age=31536000, immutable';

  if (env.PHOTOS) {
    const obj = await env.PHOTOS.get(r2Key(space, id));
    if (obj) return new Response(obj.body, { headers: { 'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg', 'Cache-Control': cache, ...CORS } });
  }
  // Anciennes photos (ou R2 non relié) : lecture dans D1
  let row = null;
  try { row = await env.DB.prepare('SELECT mime, data FROM photos WHERE space = ?1 AND id = ?2').bind(space, id).first(); } catch (e) {}
  if (!row) return json({ error: 'Photo introuvable' }, 404);
  const d = row.data;
  const body = d instanceof ArrayBuffer ? d : ArrayBuffer.isView(d) ? d : new Uint8Array(d);
  return new Response(body, { headers: { 'Content-Type': row.mime || 'image/jpeg', 'Cache-Control': cache, ...CORS } });
}
