# Ciné IDF — contexte du projet pour Claude Code

PWA qui montre **toutes les séances de tous les cinémas d'Île-de-France** (indépendants compris),
avec un filtre « CinéPass » (carte d'abonnement Pathé). Hébergée sur GitHub Pages, même style que
les apps Sport et Budget (sombre, barre d'onglets en verre, fond animé).

## Fonctionnement
- `scraper/update.mjs` (Node 22, aucune dépendance) : lit AlloCiné (points d'accès JSON du site,
  non officiels) → `data/`.
  - Inventaire des cinémas (tous les 7 jours ou `--inventory`) : recherche AlloCiné par préfixe de code
    postal (`/_/autocomplete/mobile/theater/<préfixe>`, 10 résultats max → on affine jusqu'à 5 chiffres)
    + pages département (rattrapent les codes postaux à plus de 10 salles, ex. 75005/75006).
    Coordonnées GPS par l'adresse : géocodage public IGN (`data.geopf.fr`), gardées d'une fois sur l'autre.
  - Séances : `/_/showtimes/theater-<id>/d-<AAAA-MM-JJ>/p-<page>/`, 7 jours. Les cinémas publient la
    semaine suivante (mercredi → mardi) vers lundi/mardi : d'où le 2e passage de fin d'après-midi.
  - Sortie : `data/cinemas.json` (enregistré dans le dépôt), `data/movies.json`, `data/meta.json`,
    `data/days/<jour>.json` = lignes `[idCinéma, idFilm, "HH:MM", "VF"|"VOST"|"VO", [formats], lienRéservation]`.
    Ces trois derniers NE SONT PAS dans le dépôt (il grossirait chaque jour) : cache GitHub Actions + publication directe.
- `.github/workflows/update.yml` : robot (3 h 17 et 15 h 47 UTC + à chaque push) → relit, publie sur Pages
  (source Pages = « GitHub Actions »). Un push de code republie avec les dernières séances en cache.
- Essai local : `node scraper/update.mjs --days 1 --limit 10` puis `python3 -m http.server`.
  Dans une session Claude Code cloud : `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`.

## CinéPass
- `scraper/idf_pathe.json` : liste officielle Pathé (PDF `media.pathe.fr/files/conditions/ReseauCinePassCineCartes.pdf`,
  lignes « PARIS - ILE DE France ») rattachée À LA MAIN aux identifiants AlloCiné (69 cinémas : 25 Pathé +
  44 indépendants). Champ `cinecartes` gardé (25, Pathé seulement) au cas où. Si Pathé met le PDF à jour :
  relire, rattacher les nouveaux noms, vérifier un par un.
- L'utilisateur a choisi le filtre CinéPass (pas CinéCartes).

## Livraison
- Augmenter `CACHE_VERSION` (service-worker.js, `cine-vN`) ET `APP_VERSION` (js/version.js, `vN`) à chaque publication.
- Service worker : réseau d'abord pour le code et les données ; cache d'abord pour vendor/, icônes et affiches.
- Nouvelle icône → nouveau nom de fichier (`-v2.png`) : iOS garde l'ancienne en cache.
- CSP dans index.html : images autorisées seulement depuis `*.acsta.net` (affiches AlloCiné).
- `vendor/liquidglass.*` : copiés de l'app Sport (construits dans le dépôt Budget, `tools/web-vendor/build-liquidglass.mjs`).
- `js/shaders.js` : shaders « Mesh drift » / « Silk » repris de Sport.

## Confidentialité
- La position de l'utilisateur (géolocalisation ou ville choisie) reste en localStorage, jamais envoyée.
- Le dépôt est public : il ne contient que des données publiques (toute l'Île-de-France), rien de personnel.

## Utilisateur
- Pas développeur : expliquer simplement, pas à pas. Avis esthétiques précis : itérer vite.
- Vérifier visuellement (captures) avant de considérer fini.
