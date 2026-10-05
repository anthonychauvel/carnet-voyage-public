# Mise à jour du 5 octobre 2026 — Radar, encoche, notes épinglées, partage, mentions

Ce ZIP **remplace** le précédent (carnet-escale-integre) : il contient tout.

## Dépôts du carnet (`carnet-voyage/` perso, `carnet-public/` public)
Même installation que la fois précédente (voir ci-dessous). Fichiers modifiés depuis :
`public/index.html` et `public/escale/index.html`.

| Dans le ZIP | Dans le dépôt |
|---|---|
| `public/index.html`, `public/sw.js`, vidéos `.mp4` | `public/` |
| `public/escale/` (8 fichiers) | `public/escale/` (créer avec `public/escale/.gitkeep`) |
| `functions/api/*.js` (21 fichiers d'Escale) | `functions/api/` (à côté de `sync.js` et `photo.js`) |
| `mentions-legales.html`, `privacy.html` (`public/`), `LICENSE` (racine) — **dans les deux dépôts** (textes différents : la perso n'est pas chiffrée de bout en bout) | |

Puis, côté Cloudflare, les variables/secrets et les KV d'Escale (voir l'ancien LISEZMOI, section 2).

## Dépôt Escale séparé (`Vol-main/`)
`Vol-main/index.html` et `Vol-main/sw.js` = l'Escale actuelle + les corrections du Radar + l'encoche
(sans le bouton Carnet). À transmettre à ton développeur s'il veut les mêmes corrections
sur l'appli Escale autonome.

## 📅 Rappels : ouverture directe de Calendrier (comme le menu de SimulHeures)
Outils → « 📅 Rappels dans mon calendrier » : on coche les types de rappels, puis « Ajouter à mon calendrier ».
Sur iPhone, l'appli ouvre une adresse `rappels.ics` fabriquée par le service worker (`public/sw.js`) :
Calendrier s'ouvre et propose « Ajouter tout » — plus de fichier à télécharger. Secours : « Envoyer le fichier ».
**Envoie bien `public/sw.js`** (nouveau numéro de cache), puis ouvre l'appli une fois avec du réseau.

## Escale intégrée : aucune clé à recopier
L'Escale du carnet appelle directement les API de ton projet Escale (`https://vol-bm4.pages.dev/api/…`).
Clés, quotas (KV) et cron du Radar restent **uniquement** dans le projet Escale : rien à configurer dans les
projets carnet. Les 21 fonctions d'Escale ont donc été retirées de `functions/api/` (il ne reste que
`sync.js` et `photo.js`) ; si tu les avais déjà poussées, tu peux les supprimer du dépôt (ou les laisser,
elles ne servent plus). Si l'adresse d'Escale change un jour, modifie `API_BASE` en haut de
`public/escale/index.html` et `seewhat` dans `public/index.html`.

## Dernières nouveautés
- ✈️ **Voyage en cours** (en tête du Programme) : jour J, prochain trajet/visite avec compte à rebours ; 3 jours avant : « Départ imminent » ; après : « Voyage terminé » + remboursements à faire.
- 💶 **Plafond de dépenses par jour** : barre « dépensé aujourd'hui / plafond », alerte de dépassement (Outils ou carte « Voyage en cours »).
- 🛒 **Liste de courses partagée** : ajout rapide (plusieurs éléments séparés par des virgules), cochable par chacun.
- 💸 **Remboursements** : bouton « 📤 Demander » à côté de « Régler » (message prêt à envoyer avec le montant) ; champ « Pour me rembourser » (Lydia, Wero, IBAN…) dans chaque profil.
- 🗳️ **Sondages** en tête des Envies : question + choix, vote avec son profil, résultats en direct, clôture.

## Correctifs (zoom, PDF, cartes, paquets)
- **Zoom** : plus de zoom automatique sur les champs (règle 16 px, comme le module 7) ; plus de curseur placé tout seul dans les champs.
- **PDF** : fabriqué sur le téléphone (pdf-lib, `public/vendor/pdf-lib.min.js`), format A4 bien cadré ; bouton « Enregistrer / imprimer / envoyer » (menu Partager d'iOS : Fichiers, Imprimer, WhatsApp…). Carnet de route ET Journal.
- **Cartes « type Google Maps »** : fond de carte (OpenStreetMap) avec repères ; itinéraires du jour tracés **par les rues à pied** ; dans l'écran Itinéraire, dans la carte du voyage et dans le PDF.
- **Paquets** : fusion fiche par fiche avec mémoire du dernier échange ; conflits proposés (Fusionner / la mienne / la sienne).

## 🧰 Nouvel onglet « Outils » (Plus → 🧰 Outils)
- 📴 **Fiche du jour** : billets, horaires, adresses (Plans), téléphones, références d'aujourd'hui et demain.
- 🔔 **Rappels .ics** : échéances (veille), enregistrement des vols (24 h avant), vols, arrivées hôtel, visites → calendrier de l'iPhone.
- 💱 **Devises** : convertisseur (≈ 40 monnaies dont MAD, EGP, JPY) + ligne « 💱 → € » sous « Prix réel » dans chaque fiche. Taux gardés 12 h (hors ligne : derniers connus).
- 🌤️ **Météo des étapes** : prévisions ≤ 14 jours, sinon relevés de l'an dernier aux mêmes dates (Open-Meteo).
- 🧾 **Ticket / reçu** : photo, lecture automatique du montant (à vérifier), devise convertie, payé par / partagé entre → dépense « qui doit quoi ». Galerie des reçus.
- 🗺️ **Carte du voyage** : étapes reliées + distances ; ajoutée en tête du carnet de route PDF.
- 🧳 **Bagages** : liste selon durée, climat (auto), activités ; commune, pour un voyageur ou une par voyageur → Checklist.
- 🛂 **Documents** : passeports, CNI, visas, assurances… alerte si expiration avant le retour (passeport < 6 mois) ; bandeau dans le Programme.
- 📖 **Journal de voyage** : album imprimable / PDF (carte, jours, souvenirs, photos, bilan).
- 📦 **Paquets sans serveur** (Plus → Partage & profils) : fichier chiffré avec la phrase du groupe, envoyé par WhatsApp/Messages/AirDrop ; « Recevoir » fusionne (la fiche la plus récente gagne). Compatible avec la synchro serveur.

## Encoche d'Escale (dernier correctif)
Escale passe en plein écran (`viewport-fit=cover`) avec une **bande opaque** de la hauteur de
l'encoche : plus de dégradé gris ni de flou sous la barre d'état. Cache relevé en `escale-v121`
(envoie bien `public/escale/sw.js`).

## Correctifs du 5 octobre (après tes captures)
- **Pourquoi Escale n'avait pas changé chez toi** : son service worker garde la page en cache
  (« cache d'abord »). Son numéro de cache est relevé (`escale-v120…`) : la nouvelle version
  s'installe au prochain lancement. **Envoie bien `public/escale/sw.js`** (et `Vol-main/sw.js`
  pour l'Escale autonome). Si besoin, ferme et rouvre l'appli 2 fois.
- **Encoche dans Escale** : même réglage que le carnet et le module 7 — viewport sans
  `viewport-fit=cover` (la page ne passe plus sous la barre d'état), bande opaque en haut,
  et règle « 16 px » qui évite le zoom automatique sur les champs.
- **Boutons ☰ et 📒 Carnet** : rangés dans une barre en haut d'Escale, qui reste visible en
  défilant, au lieu de flotter par-dessus l'en-tête.
- **Radar** : les modèles rapides sont proposés en haut des réglages ⚙ même quand des zones
  existent ; toutes les options (Sur mesure, mois, jours, semaines, ponts, croisé…) restent.
- **Carnet (perso et public)** : un vrai **QR code** dans le décor de l'en-tête, à côté du compte
  à rebours, avec « 📤 Partager » ; il ouvre le grand QR code et l'envoi du lien.

## Nouveautés (dernière série)
- **Jusqu'à 50 compagnons** par carnet et par voyage (au-delà, un message bloque l'ajout).
  Chaque nouveau profil reçoit une couleur libre (16 couleurs, puis des teintes calculées).
  En-tête : 8 pastilles + « +N », et « Léo, Inès et 48 autres » au-delà de 3 voyageurs.
- **PDF (carnet de route)** : pour chaque jour où un itinéraire a été créé (⚡ Itinéraire ou
  « Organiser l'étape »), la **carte du tracé** : départ, visites numérotées comme dans la liste
  « À voir », arrivée ou retour à l'hôtel, échelle et distance à vol d'oiseau. Dessinée sur le
  téléphone, sans service extérieur : elle s'imprime même hors ligne.

## Nouveautés précédentes
**Radar (Escale)**
- Démarrage en 1 geste : 4 modèles prêts (Week-ends pas chers, Vacances d'été, 3 prochains mois,
  Ponts & fériés) depuis ton aéroport, + « Sur mesure ». Affichés tant que tu n'as aucune zone.
- Suppression fiable : bouton 🗑 directement sur chaque zone (plus besoin d'ouvrir « Modifier »),
  et la zone disparaît vraiment : historique de prix, résultats mémorisés et abonnement aux
  notifications du serveur sont effacés. Une zone supprimée ou éteinte ne réapparaît plus à la
  réouverture.
- Suivi automatique des recherches (ce qui recréait des « zones » sans le vouloir) : listé dans ⚙,
  retrait une par une avec ✕ (elle ne revient plus), bouton « Tout retirer », et interrupteur
  Activé / Désactivé.

**Escale** : bande opaque sous l'encoche iPhone (comme le carnet) ; en-tête décalé pour ne plus
passer sous le bouton 📒 Carnet ; lien « Mentions légales · Confidentialité » en pied de page (les deux versions).

**Carnet** (perso ET public) : notes épinglées repliables (« ▴ replier / ▾ déplier », mémorisé) ; pied de page « Mentions légales · Confidentialité » ; **partager l'appli à un ami** :
toucher le logo de l'en-tête (petit ▦) affiche le QR code de l'appli + « Envoyer le lien »
(aussi dans Mes voyages et Plus → Partage & profils). Le QR est généré sur le téléphone
(bibliothèque QRCode de Kazuhiko Arase, licence MIT), sans service extérieur.
