/**
 * Carnet de voyage — synchronisation (Cloudflare Pages Function + D1)
 *
 * POST /api/sync
 *   En-tête  X-Carnet-Code : code secret du carnet (partagé entre voyageurs)
 *   Corps    { since: <rev>, changes: [fiche, …] }
 *   Réponse  { now: <rev>, records: [fiches modifiées depuis since] }
 *
 * Règle de fusion : par fiche, la modification la plus récente gagne (updatedAt).
 * Variable optionnelle SPACE_CODES = "code1,code2" : n'accepte que ces codes.
 */
const MAX_CHANGES = 1000;
const MAX_RECORD = 100_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Carnet-Code',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'Base D1 non liée (binding « DB » manquant)' }, 500);

  const code = (request.headers.get('X-Carnet-Code') || '').trim();
  if (code.length < 8) return json({ error: 'Code du carnet trop court (8 caractères minimum)' }, 400);
  if (env.SPACE_CODES) {
    const allowed = String(env.SPACE_CODES).split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(code)) return json({ error: 'Code de carnet non autorisé sur ce serveur' }, 403);
  }
  const space = await sha256('carnet-voyage:' + code);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Requête illisible' }, 400); }
  const since = Math.max(0, Number(body.since) || 0);
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
  const now = Date.now();

  if (changes.length) {
    const stmt = env.DB.prepare(
      `INSERT INTO records (space, id, data, updated_at, rev) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (space, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, rev = excluded.rev
       WHERE excluded.updated_at >= records.updated_at`
    );
    const batch = [];
    for (const r of changes) {
      if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 120) continue;
      const data = JSON.stringify(r);
      if (data.length > MAX_RECORD) continue;
      batch.push(stmt.bind(space, r.id, data, Number(r.updatedAt) || 0, now));
    }
    if (batch.length) await env.DB.batch(batch);
  }

  const { results } = await env.DB
    .prepare('SELECT data FROM records WHERE space = ?1 AND rev >= ?2')
    .bind(space, since)
    .all();
  return json({ now, records: results.map(r => JSON.parse(r.data)) });
}

export const onRequestGet = () => json({ ok: true, service: 'carnet-voyage' });
