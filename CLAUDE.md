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
- AlloCiné freine fort les serveurs GitHub (HTTP 429) : robot à 1 lecture à la fois, ≥ 1,2 s d'intervalle, doublé à
  chaque 429 (Retry-After respecté) ; passage complet ~1 h ; arrêt rapide si 5 échecs sans aucune réussite.
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
- Icône (v7) : « ticket » choisi par l'utilisateur, `tools/icon/gen_icon.py ticket` (même style verre que Sport/Budget), fichiers `*-v2.png`. Nouvelle icône → nouveau nom de fichier (`-v3.png`) : iOS garde l'ancienne en cache.
- CSP dans index.html : images autorisées seulement depuis `*.acsta.net` (affiches AlloCiné).
- `vendor/liquidglass.*` : copiés de l'app Sport (construits dans le dépôt Budget, `tools/web-vendor/build-liquidglass.mjs`).
- `js/shaders.js` : shaders « Mesh drift » / « Silk » repris de Sport. Fonds (`js/background.js`, Réglages) : Uni,
  Mesh drift, Silk, **Bordeaux** (défaut, v2 : même shader Silk, #0E0109/#580939/#9A005D en OKLab, réglages exacts du
  21st.dev Shader Builder fournis par l'utilisateur, effet « push » sous le doigt/la souris via u_space.zw/u_cursor.x).
  **v4 : fond FIXE par défaut (vitesse 0, batterie)** : une seule image dessinée, aucune boucle, pas d'effet au doigt ;
  passage unique forcé à 0 (localStorage `bg-fixed-v4`). Le curseur « Vitesse du fond » permet de le réanimer.
- Panneaux (fiche film/cinéma, filtres) : se ferment en glissant vers le bas (depuis la poignée, ou partout quand le
  contenu est en haut), animation 0,25 s ; la page derrière n'est redessinée que si le jour/les filtres ont changé
  (`sheet.dirty`) ; fond animé en pause tant qu'un panneau est ouvert (flou du panneau sinon recalculé à chaque image).
- **Fluidité (v5)** : PAS de backdrop-filter sur les cartes des listes (544 flous faisaient ramer l'iPhone) : flou
  seulement sur l'en-tête, la barre d'onglets et les panneaux. Un onglet n'est reconstruit que si sa signature
  (`viewSignature` : jour, recherche, filtres, position…) a changé ; `content-visibility:auto` sur les cartes.
- **v6** : `js/viewport.js` (script séparé, CSP) = correctif Sport de la hauteur d'écran en app installée (`--vvh`,
  `screen.height` si `navigator.standalone`) : plus de bande noire en bas quand la page est courte. Jour à l'ouverture
  (`pickDefaultDay`) : demain s'il ne reste plus de séance aujourd'hui ; écran vide avec bouton « Voir demain › ».
- Séances de nuit (< 5 h) rangées après 23 h (`tkey`), y compris pour « Après 18 h » et les séances passées.
- Tests Playwright : le Chromium du conteneur rend le WebGL en logiciel (~1 s/image) → passer `bg-style` à `plain`.
- Bouton « Itinéraire Waze » (fiche cinéma, v8) : lien universel `waze.com/ul?ll=…&navigate=yes` (demande de l'utilisateur : Waze plutôt que Plans).
- Liens de réservation Pathé (v9) : AlloCiné les donne en anglais (`s.pathe.fr/en/…`) → réécrits en `/fr/` dans l'app (`frLink`) et dans le robot. Non vérifiable depuis le conteneur (s.pathe.fr renvoie 403 aux robots) : à confirmer par l'utilisateur.
- **Notes des films (v10–v11)** : AlloCiné spectateurs (`us`, ≥ 20 votes) et presse (`pr`, ≥ 3 critiques) sur 5, depuis
  `movie.stats` ; IMDb sur 10 (`im` = [note, votes], ≥ 50 votes) : lien AlloCiné → IMDb via Wikidata (P1265 → P345,
  une seule requête POST, cache `data/imdb-ids.json` dans le cache Actions ; Wikidata limite parfois à 1 req/min →
  attente 65 s) + fichier public `datasets.imdbws.com/title.ratings.tsv.gz`. Jamais bloquant. ~36 des 40 films les plus
  programmés ont une note IMDb (manquent surtout les sorties très récentes). `--ratings-only` : ajoute IMDb à movies.json.
- **Derniers jours (v12)** : `markLastDays()` (aussi `--postprocess`, lancé à CHAQUE publication dans les 2 workflows).
  Fin de programmation publiée d'un cinéma = dernier jour avec ≥ 40 % de ses séances habituelles (sinon quelques
  avant-premières lointaines faussent tout). Un film « part » d'un cinéma si absent ≥ 2 jours avant cette fin, ou dès
  un mercredi (changement de programme), et seulement s'il était vraiment à l'affiche (≥ 4 séances sur ≥ 2 jours, ou
  dernière séance aujourd'hui d'un film ≥ 10 séances). `data/last.json` = {cinéma: {film: dernier jour}} ;
  `movies[id].ld` si le film part de TOUS ses cinémas (≥ 8 séances). App : badge orange « Derniers jours / Dernier
  jour » sur l'affiche, encart dans la fiche, « Dernière séance ici … » par cinéma, filtre « Derniers jours seulement ».
  Règles réglées le 17 nov. (1er test : 346 films marqués à tort, surtout ciné-clubs → resserré).
- **Fiche film (v13)** : résumé MASQUÉ par défaut (« Afficher le résumé », l'utilisateur trouve qu'il spoile) ;
  réalisation et 5 acteurs principaux en pastilles cliquables (`peopleBlock`). Robot : `dir`/`cast` = [nom, id AlloCiné]
  (anciennes données : simple nom, gérées par `person()`). Fiche personne (`showPerson`) : ses films à l'affiche cette
  semaine (nos données) + « Filmographie complète » → `allocine.fr/personne/fichepersonne-<id>/filmographie/`
  (sans id : recherche AlloCiné par nom).
- Rayon « Près de moi » : 2, 5, 10, 20, 30, 50 km (demande de l'utilisateur : plus que 20 km).
- `.github/workflows/apercu.yml` (lancement à la main) : republie le code de `main` avec les dernières séances du
  cache du robot ; la vieille copie de la branche `apercu-data` (16 nov.) ne sert que si le cache est vide.
- 1er passage réussi depuis GitHub (16 nov.) : 54 min, 24 847 séances, 703 films, 294 cinémas, 0 erreur, jamais
  freiné à 1,2 s d'intervalle. L'étape « Enregistrer la liste des cinémas » fait `pull --rebase` avant de pousser
  (des commits arrivent pendant l'heure de lecture) et ne bloque jamais la publication (`continue-on-error`).

## Confidentialité
- La position de l'utilisateur (géolocalisation ou ville choisie) reste en localStorage, jamais envoyée.
- Le dépôt est public : il ne contient que des données publiques (toute l'Île-de-France), rien de personnel.

## Utilisateur
- Pas développeur : expliquer simplement, pas à pas. Avis esthétiques précis : itérer vite.
- Vérifier visuellement (captures) avant de considérer fini.
