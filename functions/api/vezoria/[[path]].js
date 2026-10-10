/**
 * Vezoria « version test » dans le carnet : https://<le carnet>/vezoria/
 *
 * Cette page sert l'appli Vezoria (copie à jour de https://vezoria.pages.dev) à la MÊME adresse que le carnet.
 * Résultat : Vezoria lit directement les voyages et les photos déjà sur le téléphone (même stockage),
 * et synchronise avec le serveur du carnet (/api/sync et /api/photo : même base D1, même R2, mêmes codes).
 * Les gros fichiers (icônes, animations, vidéo) sont chargés directement depuis vezoria.pages.dev,
 * donc cette fonction ne tourne qu'une ou deux fois par ouverture.
 */
const SRC = 'https://vezoria.pages.dev/';

export async function onRequestGet({ request, params }) {
  const url = new URL(request.url);
  // /vezoria  →  /vezoria/  (sinon les liens relatifs de l'appli partiraient à la racine du carnet)
  if (url.pathname === '/vezoria') return Response.redirect(url.origin + '/vezoria/' + url.search, 301);
  const path = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  if (path.startsWith('api/')) return new Response('Not found', { status: 404 });
  const h = new Headers();
  const range = request.headers.get('Range'); if (range) h.set('Range', range);
  const r = await fetch(SRC + (path === 'index.html' ? '' : path), { headers: h, redirect: 'follow' });
  const out = new Response(r.body, r);
  out.headers.delete('Content-Security-Policy');
  out.headers.delete('Access-Control-Allow-Origin');
  // la page elle-même : toujours la dernière version ; le reste peut rester un peu en cache
  if (!path || path === 'index.html' || path.endsWith('.html')) out.headers.set('Cache-Control', 'no-cache');
  else if (r.ok && !out.headers.get('Cache-Control')?.includes('max-age')) out.headers.set('Cache-Control', 'public, max-age=3600');
  return out;
}
