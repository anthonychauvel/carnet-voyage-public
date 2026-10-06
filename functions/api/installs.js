// Compteur anonyme d'installations de l'appli (aucune donnée personnelle).
//   POST /api/installs  {id, plat}   → enregistre une installation (une seule fois par appareil)
//   GET  /api/installs               → {total, ios, android, ordinateur, semaine}
//   GET  /api/installs?svg=1         → badge SVG, à afficher dans le README GitHub :
//        ![Installations](https://TON-ADRESSE/api/installs?svg=1)
// Stockage : base D1 du carnet (liaison DB), table « installs » créée automatiquement.
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const json = (o, s = 200) => new Response(JSON.stringify(o), {status:s, headers:{'Content-Type':'application/json', ...CORS}});
async function table(db){ await db.prepare('CREATE TABLE IF NOT EXISTS installs (id TEXT PRIMARY KEY, plat TEXT, created INTEGER)').run(); }
async function stats(db){
  const r = await db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN plat='ios' THEN 1 ELSE 0 END) AS ios, SUM(CASE WHEN plat='android' THEN 1 ELSE 0 END) AS android,
      SUM(CASE WHEN plat='desktop' THEN 1 ELSE 0 END) AS ordinateur, SUM(CASE WHEN created > ?1 THEN 1 ELSE 0 END) AS semaine FROM installs`).bind(Date.now() - 7*864e5).first();
  return {total:r.total||0, ios:r.ios||0, android:r.android||0, ordinateur:r.ordinateur||0, semaine:r.semaine||0};
}
function badge(n){
  const l = 'installations', v = String(n), lw = 86, vw = 10 + v.length * 7.5, w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${v}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<rect width="${w}" height="20" rx="3" fill="#555"/><rect x="${lw}" width="${vw}" height="20" rx="3" fill="#7c3aed"/><rect x="${lw}" width="4" height="20" fill="#7c3aed"/><rect width="${w}" height="20" rx="3" fill="url(#s)"/>
<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="${lw/2}" y="14">${l}</text><text x="${lw + vw/2}" y="14">${v}</text></g></svg>`;
}
export async function onRequest({request, env}){
  if(request.method === 'OPTIONS') return new Response(null, {headers:CORS});
  if(!env.DB) return json({error:'Base D1 non liée (DB)'}, 500);
  await table(env.DB);
  if(request.method === 'POST'){
    let b = {}; try { b = await request.json(); } catch(e){}
    const id = String(b.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 40), plat = ['ios','android','desktop'].includes(b.plat) ? b.plat : 'autre';
    if(id.length < 12) return json({error:'id'}, 400);
    await env.DB.prepare('INSERT OR IGNORE INTO installs (id, plat, created) VALUES (?1, ?2, ?3)').bind(id, plat, Date.now()).run();
    return json({ok:true});
  }
  const s = await stats(env.DB);
  if(new URL(request.url).searchParams.get('svg')) return new Response(badge(s.total), {headers:{'Content-Type':'image/svg+xml', 'Cache-Control':'max-age=300', ...CORS}});
  return json(s);
}
