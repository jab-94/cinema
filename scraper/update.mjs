// Récupère toutes les séances des cinémas d'Île-de-France (source : AlloCiné)
// et les range dans data/ pour l'app.
//
//   node scraper/update.mjs                 → séances des 7 prochains jours
//   node scraper/update.mjs --inventory     → refait aussi la liste des cinémas
//   node scraper/update.mjs --days 1 --limit 10   → essai rapide
//
// Aucune dépendance : Node 20+ (fetch intégré).

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
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
  const dir = (m.credits || []).filter((c) => /Direct/i.test(c.position?.name || "")).map((c) => personName(c.person)).filter(Boolean);
  return {
    t: m.title,
    d: parseRuntime(m.runtime),
    g: (m.genres || []).map((g) => g.translate || g.tag).filter(Boolean).slice(0, 3),
    p: posterUrl(m),
    r: rel,
    dir: dir.slice(0, 2),
    cast: (m.cast?.edges || m.cast?.nodes || []).map((e) => personName((e.node || e).actor || (e.node || e).person)).filter(Boolean).slice(0, 4),
    syn: m.synopsisFull ? decodeHtml(m.synopsisFull.replace(/<[^>]+>/g, "")).replace(/&nbsp;/g, " ").trim().slice(0, 600) : "",
  };
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

// ---------------------------------------------------------------- Principal

async function main() {
  const t0 = Date.now();
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
            const ticket = s.data?.ticketing?.find((t) => t.urls?.length)?.urls[0] || null;
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
    rows.sort((a, b) => a[2].localeCompare(b[2]));
    await writeJson(path.join(DATA, "days", `${day}.json`), rows);
  }
  // Supprime les jours passés
  for (const f of await readdir(path.join(DATA, "days"))) {
    if (f.endsWith(".json") && f.slice(0, 10) < days[0]) await unlink(path.join(DATA, "days", f));
  }
  for (const c of cinemas) c.on = active.has(c.id) ? 1 : 0;
  cinemas.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  await writeJson(path.join(DATA, "cinemas.json"), cinemas);
  await writeJson(path.join(DATA, "movies.json"), Object.fromEntries(movies));
  const total = Object.values(perDay).reduce((n, r) => n + r.length, 0);
  Object.assign(meta, { updatedAt: new Date().toISOString(), days, showtimes: total, movies: movies.size, cinemasActive: active.size, errors });
  await writeJson(path.join(DATA, "meta.json"), meta);
  console.log(`Fini en ${Math.round((Date.now() - t0) / 1000)} s : ${total} séances, ${movies.size} films, ${active.size} cinémas actifs, ${errors} erreurs.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
