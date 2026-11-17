// Récupère toutes les séances des cinémas d'Île-de-France (source : AlloCiné)
// et les range dans data/ pour l'app.
//
//   node scraper/update.mjs                 → séances des 7 prochains jours
//   node scraper/update.mjs --inventory     → refait aussi la liste des cinémas
//   node scraper/update.mjs --days 1 --limit 10   → essai rapide
//
// Aucune dépendance : Node 20+ (fetch intégré).

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UA = "Mozilla/5.0 (compatible; cinema-idf/1.0)";
const IDF = ["75", "77", "78", "91", "92", "93", "94", "95"];
const DEPT_PAGES = {
  75: "ville-115755", 77: "departement-83166", 78: "departement-83167", 91: "departement-83168",
  92: "departement-83169", 93: "departement-83170", 94: "departement-83171", 95: "departement-83172",
};

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i < 0 ? def : (args[i + 1] ?? true); };
const DAYS = Number(opt("--days", 7));
const LIMIT = Number(opt("--limit", 0));
const FORCE_INVENTORY = args.includes("--inventory");
const RATINGS_ONLY = args.includes("--ratings-only"); // ajoute seulement les notes IMDb aux films déjà lus
const POSTPROCESS_ONLY = args.includes("--postprocess"); // recalcule seulement les « derniers jours »
// Rythme prudent : AlloCiné freine vite les serveurs de GitHub (HTTP 429 « trop de demandes »).
// Une lecture à la fois, au moins MIN_INTERVAL_MS entre deux ; l'intervalle double à chaque 429
// (jusqu'à 30 s) puis redescend doucement quand ça repasse.
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 1200);
const PAUSE_MS = 0;
let interval = MIN_INTERVAL_MS, nextSlot = 0, throttled = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTurn() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + interval;
  if (at > now) await sleep(at - now);
}

async function get(url, { json = true, tries = 6 } = {}) {
  for (let t = 1; ; t++) {
    await waitTurn();
    let status = 0;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/html", "Accept-Language": "fr-FR,fr;q=0.9" } });
      status = res.status;
      if (res.status === 429 || res.status === 503) {
        throttled++;
        interval = Math.min(30000, interval * 2);
        const ra = Number(res.headers.get("retry-after"));
        const wait = ra > 0 ? Math.min(ra * 1000, 120000) : 15000 * t;
        nextSlot = Math.max(nextSlot, Date.now() + wait);
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = json ? await res.json() : await res.text();
      interval = Math.max(MIN_INTERVAL_MS, Math.round(interval * 0.9));
      return out;
    } catch (e) {
      if (t >= tries) throw new Error(`${url} : ${e.message}`);
      if (status !== 429 && status !== 503) await sleep(1500 * t);
    }
  }
}

async function readJson(file, def) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return def; }
}
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value) + "\n");
}

// Date du jour à Paris, au format AAAA-MM-JJ
function parisDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(d);
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      await sleep(PAUSE_MS);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- Cinémas

async function autocomplete(q) {
  const d = await get(`https://www.allocine.fr/_/autocomplete/mobile/theater/${encodeURIComponent(q)}`);
  return (d.results || []).filter((r) => r.entity_type === "theater");
}

function fromAutocomplete(r) {
  const d = r.data || {};
  return { id: r.entity_id, name: r.label, address: d.address || "", zip: d.zip || "", city: d.city || "" };
}

async function buildInventory(previous) {
  const found = new Map();
  const add = (c) => { if (IDF.includes((c.zip || "").slice(0, 2))) found.set(c.id, { ...found.get(c.id), ...c }); };

  // 1) Recherche par préfixe de code postal (10 résultats max → on affine)
  async function walk(prefix) {
    const res = await autocomplete(prefix);
    await sleep(150);
    res.forEach((r) => add(fromAutocomplete(r)));
    if (res.length >= 10 && prefix.length < 5) for (const d of "0123456789") await walk(prefix + d);
  }
  for (const dep of IDF) for (const d of "0123456789") await walk(dep + d);
  console.log(`  recherche par code postal : ${found.size} lieux`);

  // 2) Pages par département (rattrape les codes postaux qui ont plus de 10 cinémas, ex. 75005)
  const extra = new Map();
  for (const [dep, slug] of Object.entries(DEPT_PAGES)) {
    for (let p = 1; p < 20; p++) {
      let html;
      try { html = await get(`https://www.allocine.fr/salle/cinema/${slug}/${p > 1 ? `?page=${p}` : ""}`, { json: false }); }
      catch { break; }
      const ids = [...html.matchAll(/href="\/seance\/salle_gen_csalle=([A-Z0-9]+)\.html"[^>]*>\s*([^<]+?)\s*</g)];
      if (!ids.length) break;
      for (const [, id, name] of ids) if (!found.has(id)) extra.set(id, { id, name: decodeHtml(name), dep });
      await sleep(200);
    }
  }
  for (const c of extra.values()) {
    // l'adresse vient de la recherche par nom
    const res = await autocomplete(c.name).catch(() => []);
    const hit = res.find((r) => r.entity_id === c.id);
    add(hit ? fromAutocomplete(hit) : { id: c.id, name: c.name, zip: c.dep, address: "", city: "" });
    await sleep(150);
  }
  console.log(`  + pages départements : ${found.size} lieux`);

  // Garde les coordonnées déjà connues
  const prevById = new Map((previous || []).map((c) => [c.id, c]));
  return [...found.values()].map((c) => {
    const p = prevById.get(c.id);
    return p && p.lat && p.address === c.address ? { ...c, lat: p.lat, lng: p.lng } : c;
  });
}

function decodeHtml(s) {
  return s.replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

// Coordonnées GPS par l'adresse (service public IGN), pour trier par distance
async function geocode(cinemas) {
  const todo = cinemas.filter((c) => c.lat == null);
  for (const c of todo) {
    // adresse complète d'abord ; sinon nom du lieu (ex. « Grand Palais »), sinon la ville
    const queries = [[c.address, c.zip, c.city], [c.name.replace(/^(mk2|ugc|pathé|gaumont|cgr)\s+/i, ""), c.zip, c.city], [c.zip, c.city]]
      .map((q) => q.filter(Boolean).join(" ")).filter((q) => q.length > 4);
    for (const q of queries) {
      try {
        const d = await get(`https://data.geopf.fr/geocodage/search?limit=1&q=${encodeURIComponent(q)}`);
        const f = d.features?.[0];
        if (f && f.properties.score > 0.4) { [c.lng, c.lat] = f.geometry.coordinates.map((x) => Math.round(x * 1e5) / 1e5); break; }
      } catch (e) { console.warn("  géocodage impossible :", c.name, e.message); }
      await sleep(120);
    }
  }
  if (todo.length) console.log(`  géocodage : ${todo.filter((c) => c.lat != null).length}/${todo.length}`);
}

// ---------------------------------------------------------------- Séances

const VERSION = { DUBBED: "VF", LOCAL: "VF", ORIGINAL: "VOST" };
// Formats affichés (le reste — numérique, 2D… — n'est pas utile)
const FORMAT_LABELS = {
  IMAX: "IMAX", "3D": "3D", "4DX": "4DX", SCREENX: "ScreenX", DOLBY_CINEMA: "Dolby Cinema",
  DOLBY_ATMOS: "Dolby Atmos", ICE: "ICE", ONYX: "Onyx", "70MM": "70 mm", "35MM": "35 mm", FILM: "Pellicule",
};

function formatsOf(s) {
  const raw = [s.projection, s.experience, s.picture, s.sound, s.comfort].flat().filter(Boolean);
  const out = new Set();
  for (const r of raw) {
    const k = String(r).toUpperCase();
    if (FORMAT_LABELS[k]) out.add(FORMAT_LABELS[k]);
  }
  for (const t of s.tags || []) {
    if (/Imax/i.test(t)) out.add("IMAX");
    if (/4DX/i.test(t)) out.add("4DX");
    if (/ScreenX/i.test(t)) out.add("ScreenX");
    if (/DolbyCinema/i.test(t)) out.add("Dolby Cinema");
    if (/Projection\.3D/i.test(t)) out.add("3D");
  }
  return [...out];
}

function versionOf(key, s) {
  if (key === "original_st" || key === "original_sme") return "VOST";
  if (key === "original") return "VO";
  return VERSION[s.diffusionVersion] || "VF";
}

function posterUrl(m) {
  const u = m.poster?.url;
  if (!u) return null;
  // vignette légère (AlloCiné redimensionne à la volée)
  return u.replace(/\.net\/(pictures|img)\//, ".net/c_310_420/$1/");
}

function movieInfo(m) {
  const rel = m.releases?.find((r) => r.releaseDate?.date)?.releaseDate?.date || null;
  // Personnes : [nom, identifiant AlloCiné] (l'identifiant sert au lien « Filmographie complète »)
  const who = (p) => (personName(p) ? [personName(p), p.internalId || null] : null);
  const dir = (m.credits || []).filter((c) => /Direct/i.test(c.position?.name || "")).map((c) => who(c.person)).filter(Boolean);
  return {
    t: m.title,
    d: parseRuntime(m.runtime),
    g: (m.genres || []).map((g) => g.translate || g.tag).filter(Boolean).slice(0, 3),
    p: posterUrl(m),
    r: rel,
    dir: dir.slice(0, 2),
    cast: (m.cast?.edges || m.cast?.nodes || []).map((e) => who((e.node || e).actor || (e.node || e).person)).filter(Boolean).slice(0, 5),
    syn: m.synopsisFull ? decodeHtml(m.synopsisFull.replace(/<[^>]+>/g, "")).replace(/&nbsp;/g, " ").trim().slice(0, 600) : "",
    // Notes AlloCiné sur 5 : [note, nombre] (spectateurs = au moins 20 votes, presse = au moins 3 critiques)
    us: rating(m.stats?.userRating, 20),
    pr: rating(m.stats?.pressReview, 3),
    ot: m.originalTitle && m.originalTitle !== m.title ? m.originalTitle : undefined,
    y: m.data?.productionYear || undefined,
  };
}
function rating(r, min) {
  return r?.score && r.count >= min ? [Math.round(r.score * 10) / 10, r.count] : undefined;
}
function personName(p) { return p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : null; }
function parseRuntime(r) {
  if (typeof r === "number") return Math.round(r / 60);
  const m = /(\d+)h\s*(\d+)?/.exec(r || "");
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null;
}

async function fetchShowtimes(cinemaId, date) {
  const out = [];
  for (let p = 1; p < 15; p++) {
    const d = await get(`https://www.allocine.fr/_/showtimes/theater-${cinemaId}/d-${date}/p-${p}/`);
    for (const r of d.results || []) if (r.movie) out.push(r);
    const total = Number(d.pagination?.totalPages || 0);
    if (p >= total) break;
    await sleep(PAUSE_MS);
  }
  return out;
}

// ---------------------------------------------------------------- Notes IMDb
// Lien film AlloCiné → film IMDb : Wikidata (propriété P1265 « identifiant AlloCiné film » → P345 « IMDb »),
// gardé dans data/imdb-ids.json pour ne redemander que les nouveaux films. Notes : fichier public quotidien
// d'IMDb (title.ratings.tsv.gz, ~8 Mo). Gratuit, sans clé. Jamais bloquant : en cas d'échec, pas de note.
async function addImdbRatings(movies) {
  const t0 = Date.now();
  const mapFile = path.join(DATA, "imdb-ids.json");
  const map = await readJson(mapFile, {});
  const todo = Object.keys(movies).filter((id) => !(id in map));
  if (todo.length) {
    const query = `SELECT ?a ?imdb WHERE { VALUES ?a { ${todo.map((x) => `"${x}"`).join(" ")} } ?f wdt:P1265 ?a . ?f wdt:P345 ?imdb . }`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch("https://query.wikidata.org/sparql", {
          method: "POST",
          headers: { "User-Agent": "cinema-idf-bot/1.0", Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ query }),
        });
        if (res.status === 429) { await sleep(65000); continue; } // Wikidata limite parfois à 1 requête / minute
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        for (const b of d.results.bindings) map[b.a.value] = b.imdb.value;
        // films sans lien : redemandés au prochain passage (Wikidata se complète au fil des jours)
        break;
      } catch (e) { console.warn("  Wikidata :", e.message); if (attempt < 3) await sleep(5000); }
    }
    await writeJson(mapFile, map);
  }
  let ratings;
  try {
    const res = await fetch("https://datasets.imdbws.com/title.ratings.tsv.gz", { headers: { "User-Agent": "cinema-idf-bot/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wanted = new Set(Object.values(map));
    ratings = new Map();
    for (const line of gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8").split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0 || !wanted.has(line.slice(0, tab))) continue;
      const [tc, avg, votes] = line.split("\t");
      ratings.set(tc, [Number(avg), Number(votes)]);
    }
  } catch (e) { console.warn("  notes IMDb indisponibles :", e.message); return; }
  let n = 0;
  for (const [id, m] of Object.entries(movies)) {
    const r = ratings.get(map[id]);
    if (r && r[1] >= 50) { m.im = r; m.imdb = map[id]; n++; }
  }
  console.log(`  notes IMDb : ${n}/${Object.keys(movies).length} films (${Math.round((Date.now() - t0) / 1000)} s)`);
}

// ---------------------------------------------------------------- Dernière chance (données pour l'app)
// Le calcul « dernière chance » se fait DANS LE TÉLÉPHONE (il dépend de la position et du rayon choisis, qui ne
// quittent jamais l'appareil). Le robot fournit data/progress.json :
//   h : { idCinéma: dernier jour de programmation PUBLIÉE } — dernier jour avec ≥ 40 % des séances habituelles
//       du cinéma (quelques avant-premières lointaines ne comptent pas comme « semaine publiée ») ;
//   p : { idCinéma: { idFilm: [dernier jour programmé, nombre de séances sur la période] } }.
async function markLastDays() {
  const files = (await readdir(path.join(DATA, "days"))).filter((f) => f.endsWith(".json")).sort();
  const perDay = {}, p = {};
  for (const f of files) {
    const day = f.slice(0, 10);
    for (const [cid, mid] of await readJson(path.join(DATA, "days", f), [])) {
      (perDay[cid] ||= {})[day] = (perDay[cid][day] || 0) + 1;
      const e = ((p[cid] ||= {})[mid] ||= [day, 0]);
      e[0] = day; e[1]++;
    }
  }
  const h = {};
  for (const [cid, counts] of Object.entries(perDay)) {
    const max = Math.max(...Object.values(counts));
    h[cid] = Object.keys(counts).filter((d) => counts[d] >= 0.4 * max).sort().pop();
  }
  await writeJson(path.join(DATA, "progress.json"), { h, p });
  // anciens formats (v12–v18), plus utilisés
  const movies = await readJson(path.join(DATA, "movies.json"), {});
  let cleaned = false;
  for (const m of Object.values(movies)) if ("ld" in m) { delete m.ld; cleaned = true; }
  if (cleaned) await writeJson(path.join(DATA, "movies.json"), movies);
  await unlink(path.join(DATA, "last.json")).catch(() => {});
  console.log(`Dernière chance : programmation publiée de ${Object.keys(h).length} cinémas.`);
}

// ---------------------------------------------------------------- Principal

async function main() {
  const t0 = Date.now();
  if (POSTPROCESS_ONLY) { await markLastDays(); return; }
  if (RATINGS_ONLY) {
    const movies = await readJson(path.join(DATA, "movies.json"), {});
    await addImdbRatings(movies);
    await writeJson(path.join(DATA, "movies.json"), movies);
    return;
  }
  console.log("Cinémas…");
  let cinemas = await readJson(path.join(DATA, "cinemas.json"), null);
  const meta = await readJson(path.join(DATA, "meta.json"), {});
  // Sans date connue (cache vide), la liste enregistrée dans le dépôt suffit : on ne la refait pas.
  const inventoryAge = meta.inventoryAt ? (Date.now() - Date.parse(meta.inventoryAt)) / 86400000 : (cinemas ? 0 : Infinity);
  if (cinemas && !meta.inventoryAt) meta.inventoryAt = new Date().toISOString();
  if (!cinemas || FORCE_INVENTORY || inventoryAge > 7) {
    cinemas = await buildInventory(cinemas);
    meta.inventoryAt = new Date().toISOString();
  }
  await geocode(cinemas);

  // Carte CinéPass (liste Pathé, rattachée à la main aux identifiants AlloCiné)
  const pathe = await readJson(path.join(ROOT, "scraper", "idf_pathe.json"), []);
  const cinepass = new Set(pathe.filter((p) => p.cinepass).map((p) => p.allocine));
  for (const c of cinemas) c.cp = cinepass.has(c.id) ? 1 : 0;

  const days = Array.from({ length: DAYS }, (_, i) => parisDate(i));
  const list = LIMIT ? cinemas.slice(0, LIMIT) : cinemas;
  console.log(`Séances : ${list.length} cinémas × ${days.length} jours…`);

  const movies = new Map();
  const perDay = Object.fromEntries(days.map((d) => [d, []]));
  const active = new Set();
  let errors = 0, done = 0, okCount = 0;

  await pool(list, CONCURRENCY, async (c) => {
    for (const day of days) {
      let results;
      try { results = await fetchShowtimes(c.id, day); }
      catch (e) {
        errors++; console.warn("  !", c.name, day, e.message);
        // AlloCiné refuse tout dès le début → inutile d'insister pendant des heures
        if (errors >= 5 && okCount === 0) { console.error("AlloCiné refuse les lectures depuis ce serveur. Arrêt."); process.exit(2); }
        continue;
      }
      okCount++;
      for (const r of results) {
        const m = r.movie;
        const mid = String(m.internalId);
        if (!movies.has(mid)) movies.set(mid, movieInfo(m));
        for (const [key, shows] of Object.entries(r.showtimes || {})) {
          for (const s of shows || []) {
            if (!s.startsAt?.startsWith(day)) continue;
            let ticket = s.data?.ticketing?.find((t) => t.urls?.length)?.urls[0] || null;
            if (ticket) ticket = ticket.replace(/^https:\/\/s\.pathe\.fr\/en\//, "https://s.pathe.fr/fr/"); // Pathé en français
            perDay[day].push([c.id, mid, s.startsAt.slice(11, 16), versionOf(key, s), formatsOf(s), ticket]);
            active.add(c.id);
          }
        }
      }
      await sleep(PAUSE_MS);
    }
    if (++done % 25 === 0) console.log(`  ${done}/${list.length} (${Math.round((Date.now() - t0) / 1000)} s, ${errors} erreurs, freiné ${throttled} fois, rythme ${(interval / 1000).toFixed(1)} s)`);
  });

  if (errors > list.length * days.length * 0.2) { console.error(`Trop d'erreurs (${errors}), on garde les anciennes données.`); process.exit(1); }

  // Écriture
  await mkdir(path.join(DATA, "days"), { recursive: true });
  for (const [day, rows] of Object.entries(perDay)) {
    const tk = (t) => (t < "05:00" ? String(Number(t.slice(0, 2)) + 24) + t.slice(2) : t); // nuit après 23 h
    rows.sort((a, b) => tk(a[2]).localeCompare(tk(b[2])));
    await writeJson(path.join(DATA, "days", `${day}.json`), rows);
  }
  // Supprime les jours passés
  for (const f of await readdir(path.join(DATA, "days"))) {
    if (f.endsWith(".json") && f.slice(0, 10) < days[0]) await unlink(path.join(DATA, "days", f));
  }
  for (const c of cinemas) c.on = active.has(c.id) ? 1 : 0;
  cinemas.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  await writeJson(path.join(DATA, "cinemas.json"), cinemas);
  const moviesObj = Object.fromEntries(movies);
  console.log("Notes IMDb…");
  await addImdbRatings(moviesObj).catch((e) => console.warn("  notes IMDb :", e.message));
  await writeJson(path.join(DATA, "movies.json"), moviesObj);
  const total = Object.values(perDay).reduce((n, r) => n + r.length, 0);
  Object.assign(meta, { updatedAt: new Date().toISOString(), days, showtimes: total, movies: movies.size, cinemasActive: active.size, errors });
  await writeJson(path.join(DATA, "meta.json"), meta);
  await markLastDays().catch((e) => console.warn("  derniers jours :", e.message));
  console.log(`Fini en ${Math.round((Date.now() - t0) / 1000)} s : ${total} séances, ${movies.size} films, ${active.size} cinémas actifs, ${errors} erreurs.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
