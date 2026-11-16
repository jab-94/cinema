// Ciné IDF — toutes les séances des cinémas d'Île-de-France.
// Données : data/ (mises à jour chaque nuit par le robot GitHub, voir scraper/update.mjs).
// Ta position ne sort jamais du téléphone : elle sert seulement à calculer les distances ici.
import { APP_VERSION } from "./version.js";
import { background, startBackground } from "./background.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const nb = (n, w, pl = w + "s") => `${n} ${n > 1 ? pl : w}`;
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const DEPTS = { 75: "Paris", 77: "Seine-et-Marne", 78: "Yvelines", 91: "Essonne", 92: "Hauts-de-Seine", 93: "Seine-Saint-Denis", 94: "Val-de-Marne", 95: "Val-d'Oise" };
const FORMATS = ["IMAX", "Dolby Cinema", "4DX", "ScreenX", "3D", "Dolby Atmos", "70 mm", "35 mm"];
const HOURS = [0, 12, 14, 18, 20];
const RADII = [2, 5, 10, 20, 30, 50];

// ------------------------------------------------------------ État
const data = { meta: null, cinemas: new Map(), movies: {}, days: {} };
const st = {
  tab: "films",
  day: null,
  q: "",
  f: Object.assign({ cinepass: false, version: "", near: false, fromHour: 0, formats: [], deps: [] }, pref("filters", {})),
  radius: pref("radius", 10),
  pos: pref("position", null), // { lat, lng, label } — gardé uniquement sur ce téléphone
  hidePast: pref("hide-past", true),
  nowLimit: 60,
};
const saveFilters = () => save("filters", st.f);

// ------------------------------------------------------------ Outils
function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function distOf(c) { return st.pos && c?.lat != null ? km(st.pos, c) : null; }
function fmtKm(d) { return d == null ? "" : d < 1 ? `${Math.round(d * 1000 / 50) * 50} m` : `${d < 10 ? d.toFixed(1).replace(".", ",") : Math.round(d)} km`; }
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date()); }
function nowHM() { return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date()); }
function dayLabel(d, long = false) {
  const t = today();
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() + 86400000));
  if (d === t) return "Aujourd'hui";
  if (d === tomorrow) return "Demain";
  const dt = new Date(d + "T12:00:00");
  return new Intl.DateTimeFormat("fr-FR", long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric" }).format(dt);
}
function runtime(m) { if (!m?.d) return ""; const h = Math.floor(m.d / 60), mn = m.d % 60; return h ? `${h} h ${String(mn).padStart(2, "0")}` : `${mn} min`; }
function isNew(m) { return m?.r && (Date.parse(st.day) - Date.parse(m.r)) / 86400000 < 7 && m.r <= st.day; }
function poster(m, cls = "") {
  return m?.p ? `<img src="${esc(m.p)}" alt="" loading="lazy" decoding="async" class="${cls}" referrerpolicy="no-referrer">` : `<div class="ph">${esc(m?.t || "")}</div>`;
}
function cpBadge(c) { return c?.cp ? `<span class="cp-badge" title="Carte CinéPass acceptée">CinéPass</span>` : ""; }
function cineSub(c) { return [c.city || DEPTS[c.zip?.slice(0, 2)], fmtKm(distOf(c))].filter(Boolean).join(" · "); }

// ------------------------------------------------------------ Données
async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} : ${res.status}`);
  return res.json();
}
async function loadDay(d) {
  if (!data.days[d]) data.days[d] = getJson(`data/days/${d}.json`).catch(() => []);
  return data.days[d];
}

// Séances filtrées pour le jour choisi : [{ c, m, mid, time, v, fmts, url }]
async function rowsFor(day, { ignoreQuery = false, movieId = null, cinemaId = null } = {}) {
  const raw = await loadDay(day);
  const f = st.f;
  const tokens = ignoreQuery ? [] : norm(st.q).split(/\s+/).filter(Boolean);
  const from = f.fromHour ? String(f.fromHour).padStart(2, "0") + ":00" : null;
  const past = st.hidePast && day === today() ? nowHM() : null;
  const out = [];
  for (const [cid, mid, time, v, fmts, url] of raw) {
    if (movieId && mid !== movieId) continue;
    if (cinemaId && cid !== cinemaId) continue;
    const c = data.cinemas.get(cid);
    if (!c) continue;
    if (f.cinepass && !c.cp) continue;
    if (f.deps.length && !f.deps.includes(c.zip?.slice(0, 2))) continue;
    if (f.version === "VF" && v !== "VF") continue;
    if (f.version === "VOST" && v === "VF") continue;
    if (f.formats.length && !f.formats.some((x) => fmts.includes(x))) continue;
    if (from && time < from) continue;
    if (past && time < past) continue;
    const d = distOf(c);
    if (f.near && st.pos && (d == null || d > st.radius)) continue;
    const m = data.movies[mid];
    if (tokens.length) {
      const hay = norm(`${m?.t} ${c.name} ${c.city} ${c.zip}`);
      if (!tokens.every((t) => hay.includes(t))) continue;
    }
    out.push({ c, m, mid, time, v, fmts, url, d });
  }
  return out;
}

// ------------------------------------------------------------ Rendu
const views = {};
let renderToken = 0;

async function render() {
  const token = ++renderToken;
  document.querySelectorAll("nav#tabs > button").forEach((b) => b.classList.toggle("active", b.dataset.tab === st.tab));
  glassTabs?.update({ value: st.tab });
  for (const t of ["films", "now", "cinemas", "settings"]) $(`#tab-${t}`).hidden = t !== st.tab;
  $("#page-title").textContent = { films: "Films", now: "Bientôt", cinemas: "Cinémas", settings: "Réglages" }[st.tab];
  $("#toolbar").hidden = st.tab === "settings";
  renderChips();
  await views[st.tab]?.($(`#tab-${st.tab}`), token);
}

function renderChips() {
  $("#days").innerHTML = (data.meta?.days || []).filter((d) => d >= today())
    .map((d) => `<button class="chip ${d === st.day ? "on" : ""}" data-day="${d}" type="button">${esc(dayLabel(d))}</button>`).join("");
  const f = st.f;
  const on = { cinepass: f.cinepass, vf: f.version === "VF", vost: f.version === "VOST", near: f.near, evening: f.fromHour === 18 };
  document.querySelectorAll("#quick .toggle").forEach((b) => b.classList.toggle("on", !!on[b.dataset.f]));
  const n = f.formats.length + f.deps.length + (f.fromHour && f.fromHour !== 18 ? 1 : 0);
  $("#filter-count").textContent = n || "";
}

function emptyState(text = "Aucune séance ne correspond.") {
  const tips = [];
  if (st.f.near) tips.push(`le rayon « Près de moi » est de ${st.radius} km`);
  if (st.f.cinepass) tips.push("seuls les cinémas CinéPass sont affichés");
  if (st.q) tips.push(`la recherche « ${esc(st.q)} » est active`);
  return `<div class="empty"><b>${text}</b>${tips.length ? "Remarque : " + tips.join(", ") + "." : "Essaie un autre jour ou retire un filtre."}</div>`;
}

views.films = async (el, token) => {
  const rows = await rowsFor(st.day);
  if (token !== renderToken) return;
  const byMovie = new Map();
  for (const r of rows) {
    let g = byMovie.get(r.mid);
    if (!g) byMovie.set(r.mid, (g = { mid: r.mid, m: r.m, n: 0, cines: new Set(), dmin: Infinity }));
    g.n++; g.cines.add(r.c.id); if (r.d != null) g.dmin = Math.min(g.dmin, r.d);
  }
  const list = [...byMovie.values()].sort((a, b) => b.cines.size - a.cines.size || b.n - a.n);
  if (!list.length) { el.innerHTML = emptyState("Aucun film ne correspond."); return; }
  el.innerHTML = `<p class="meta-line">${esc(dayLabel(st.day, true))} · ${nb(list.length, "film")} · ${nb(rows.length, "séance")}</p>
  <div class="grid">${list.map((g) => `
    <button class="movie" data-movie="${g.mid}" type="button">
      <div class="poster">${poster(g.m)}<span class="count">${nb(g.cines.size, "cinéma")}</span>${isNew(g.m) ? `<span class="new">Nouveau</span>` : ""}</div>
      <div class="mt">${esc(g.m?.t)}</div>
      <div class="ms">${esc([runtime(g.m), g.m?.g?.[0]].filter(Boolean).join(" · "))}${st.pos && g.dmin < Infinity ? ` · ${fmtKm(g.dmin)}` : ""}</div>
    </button>`).join("")}</div>`;
};

function timeChip(r) {
  const tags = [r.v, ...r.fmts.filter((x) => x !== "Dolby Atmos")].join(" · ");
  const past = r.time < nowHM() && st.day === today();
  const inner = `${r.time}<small>${esc(tags)}</small>`;
  return r.url
    ? `<a class="time ${past ? "past" : ""}" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<span class="time ${past ? "past" : ""}">${inner}</span>`;
}

function groupByCinema(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.c.id)) map.set(r.c.id, { c: r.c, d: r.d, rows: [] });
    map.get(r.c.id).rows.push(r);
  }
  return [...map.values()].sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9) || a.c.name.localeCompare(b.c.name, "fr"));
}

views.now = async (el, token) => {
  const rows = await rowsFor(st.day);
  if (token !== renderToken) return;
  rows.sort((a, b) => a.time.localeCompare(b.time) || (a.d ?? 1e9) - (b.d ?? 1e9));
  if (!rows.length) { el.innerHTML = emptyState(); return; }
  const shown = rows.slice(0, st.nowLimit);
  const hint = !st.pos ? `<p class="meta-line">Astuce : ajoute ta position dans Réglages puis active « Près de moi » pour ne voir que les séances proches.</p>` : "";
  el.innerHTML = `${hint}<p class="meta-line">${esc(dayLabel(st.day, true))} · ${nb(rows.length, "séance")}, par heure</p>
  <div class="list">${shown.map((r) => `
    <div class="glass now-item">
      <a class="clock" ${r.url ? `href="${esc(r.url)}" target="_blank" rel="noopener noreferrer"` : ""}>${r.time}</a>
      <button class="thumb" data-movie="${r.mid}" type="button">${poster(r.m)}</button>
      <div class="info">
        <button class="ft" data-movie="${r.mid}" type="button">${esc(r.m?.t)}</button>
        <div class="fs">${esc(r.c.name)}${r.d != null ? " · " + fmtKm(r.d) : ""}</div>
        <div class="tag">${esc([r.v, ...r.fmts].join(" · "))}${r.c.cp ? " · CinéPass" : ""}</div>
      </div>
    </div>`).join("")}</div>
  ${rows.length > shown.length ? `<button class="more-btn" data-more type="button">Afficher plus (${rows.length - shown.length} restantes)</button>` : ""}`;
};

views.cinemas = async (el, token) => {
  const rows = await rowsFor(st.day, { ignoreQuery: true });
  if (token !== renderToken) return;
  const counts = new Map();
  for (const r of rows) { const s = counts.get(r.c.id) || new Set(); s.add(r.mid); counts.set(r.c.id, s); }
  const tokens = norm(st.q).split(/\s+/).filter(Boolean);
  let list = [...data.cinemas.values()].filter((c) => counts.has(c.id));
  if (tokens.length) {
    // la recherche porte sur le cinéma OU sur un film qu'il passe
    list = list.filter((c) => {
      const titles = [...counts.get(c.id)].map((mid) => data.movies[mid]?.t).join(" ");
      const hay = norm(`${c.name} ${c.city} ${c.zip} ${titles}`);
      return tokens.every((t) => hay.includes(t));
    });
  }
  list.sort((a, b) => (distOf(a) ?? 1e9) - (distOf(b) ?? 1e9) || a.name.localeCompare(b.name, "fr"));
  if (!list.length) { el.innerHTML = emptyState("Aucun cinéma ne correspond."); return; }
  el.innerHTML = `<p class="meta-line">${esc(dayLabel(st.day, true))} · ${nb(list.length, "cinéma")}</p>
  <div class="list">${list.map((c) => `
    <button class="glass card card-head" data-cinema="${c.id}" type="button">
      <div><div class="name">${esc(c.name)}${cpBadge(c)}</div><div class="sub">${esc(cineSub(c))}</div></div>
      <div class="right">${nb(counts.get(c.id).size, "film")} ›</div>
    </button>`).join("")}</div>`;
};

views.settings = async (el) => {
  const m = data.meta;
  const upd = m?.updatedAt ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(m.updatedAt)) : "—";
  const cities = [...new Set([...data.cinemas.values()].filter((c) => c.on && c.lat != null && c.city).map((c) => c.city))].sort((a, b) => a.localeCompare(b, "fr"));
  const glass = Math.round(pref("glass-transparency", 0.5) * 100);
  el.innerHTML = `
  <div class="section-title">Ma position</div>
  <div class="glass set-group">
    <div class="set-row"><div class="lbl">${st.pos ? esc(st.pos.label) : "Non définie"}<small>Sert à trier par distance et pour « Près de moi ». Reste sur ce téléphone, n'est jamais envoyée.</small></div></div>
    <div class="set-row"><button class="btn" data-geo type="button">Utiliser ma position</button>${st.pos ? `<button class="btn ghost" data-geo-clear type="button">Effacer</button>` : ""}</div>
    <div class="set-row"><div class="lbl">Ou une ville</div>
      <select id="city-pick"><option value="">—</option>${cities.map((c) => `<option ${st.pos?.label === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
    <div class="set-row"><div class="lbl">Rayon</div>
      <div class="seg full" id="radius">${RADII.map((r) => `<button class="${r === st.radius ? "on" : ""}" data-r="${r}" type="button">${r} km</button>`).join("")}</div></div>
  </div>

  <div class="section-title">Séances</div>
  <div class="glass set-group">
    <div class="set-row"><div class="lbl">Masquer les séances passées<small>Pour aujourd'hui seulement.</small></div><button class="switch ${st.hidePast ? "on" : ""}" data-hide-past type="button" aria-label="Masquer les séances passées"></button></div>
  </div>

  <div class="section-title">Apparence</div>
  <div class="glass set-group">
    <div class="set-row"><div class="lbl">Fond d'écran</div>
      <div class="seg" id="bg-style">${background.styles.map(([k, l]) => `<button class="${k === background.style ? "on" : ""}" data-bg="${k}" type="button">${esc(l)}</button>`).join("")}</div></div>
    <div class="set-row"><div class="lbl">Vitesse du fond<input id="bg-speed" type="range" min="0" max="100" value="${background.speed}"></div></div>
    <div class="set-row"><div class="lbl">Transparence du verre<input id="glass" type="range" min="0" max="100" value="${glass}"></div></div>
  </div>

  <div class="section-title">Données</div>
  <div class="glass set-group">
    <div class="set-row"><div class="lbl">Dernière mise à jour<small>${esc(upd)}</small></div></div>
    <div class="set-row"><div class="lbl">${m ? `${nb(m.cinemasActive, "cinéma")} · ${nb(m.movies, "film")} · ${nb(m.showtimes, "séance")} sur 7 jours` : ""}
      <small>Horaires : AlloCiné, relus chaque nuit. Vérifie sur le site du cinéma avant d'y aller. Cinémas CinéPass : liste officielle Pathé (réseau CinéPass), Île-de-France.</small></div></div>
    <div class="set-row"><div class="lbl small">Version ${esc(APP_VERSION)}</div></div>
  </div>`;
};

// ------------------------------------------------------------ Feuilles (fiche film, cinéma, filtres)
const sheet = { el: null, kind: null, id: null };
function openSheet(html, kind, id) {
  sheet.kind = kind; sheet.id = id;
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("#sheet").hidden = true; sheet.kind = null;
  document.body.style.overflow = "";
}
function dayChipsInSheet() {
  return `<div class="chips sheet-days">${(data.meta?.days || []).filter((d) => d >= today())
    .map((d) => `<button class="chip ${d === st.day ? "on" : ""}" data-day="${d}" type="button">${esc(dayLabel(d))}</button>`).join("")}</div>`;
}
function activeFiltersLine() {
  const f = st.f, parts = [];
  if (f.cinepass) parts.push("CinéPass");
  if (f.version) parts.push(f.version);
  if (f.near && st.pos) parts.push(`≤ ${st.radius} km`);
  if (f.fromHour) parts.push(`après ${f.fromHour} h`);
  parts.push(...f.formats, ...f.deps.map((d) => DEPTS[d]));
  return parts.length ? `<p class="small">Filtres : ${esc(parts.join(", "))}</p>` : "";
}

async function showMovie(mid) {
  const m = data.movies[mid];
  const rows = await rowsFor(st.day, { ignoreQuery: true, movieId: mid });
  const groups = groupByCinema(rows);
  const syn = m?.syn ? `<p class="syn clamp" data-expand>${esc(m.syn)}</p>` : "";
  openSheet(`
    <div class="film-hero"><div class="poster">${poster(m)}</div>
      <div><h2>${esc(m?.t)}</h2>
        <div class="fs">${esc([runtime(m), (m?.g || []).join(", ")].filter(Boolean).join(" · "))}</div>
        ${m?.dir?.length ? `<div class="fs">De ${esc(m.dir.join(", "))}</div>` : ""}
        ${m?.cast?.length ? `<div class="fs">Avec ${esc(m.cast.join(", "))}</div>` : ""}
        ${m?.r ? `<div class="fs">Sortie : ${esc(new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(m.r + "T12:00:00")))}</div>` : ""}
      </div></div>
    ${syn}
    ${dayChipsInSheet()}
    ${activeFiltersLine()}
    <p class="meta-line">${nb(groups.length, "cinéma")} · ${nb(rows.length, "séance")}${st.pos ? " · du plus proche au plus loin" : ""}</p>
    <div class="list">${groups.map((g) => `
      <div class="glass card">
        <button class="card-head" data-cinema="${g.c.id}" type="button"><div><div class="name">${esc(g.c.name)}${cpBadge(g.c)}</div><div class="sub">${esc(cineSub(g.c))}</div></div><div class="right">›</div></button>
        <div class="times">${g.rows.map(timeChip).join("")}</div>
      </div>`).join("") || emptyState()}</div>`, "movie", mid);
}

async function showCinema(cid) {
  const c = data.cinemas.get(cid);
  const rows = await rowsFor(st.day, { ignoreQuery: true, cinemaId: cid });
  const byMovie = new Map();
  for (const r of rows) { if (!byMovie.has(r.mid)) byMovie.set(r.mid, []); byMovie.get(r.mid).push(r); }
  const list = [...byMovie.entries()].sort((a, b) => a[1][0].time.localeCompare(b[1][0].time));
  const maps = c.lat != null ? `https://maps.apple.com/?q=${encodeURIComponent(c.name)}&ll=${c.lat},${c.lng}` : `https://maps.apple.com/?q=${encodeURIComponent(c.name + " " + c.address + " " + c.zip)}`;
  openSheet(`
    <h3>${esc(c.name)}${cpBadge(c)}</h3>
    <p class="small cine-addr">${esc([c.address, `${c.zip} ${c.city}`].filter(Boolean).join(", "))}${distOf(c) != null ? " · " + fmtKm(distOf(c)) : ""}</p>
    <p class="btn-row"><a class="btn ghost" href="${esc(maps)}" target="_blank" rel="noopener noreferrer">Itinéraire</a>
      <a class="btn ghost" href="https://www.allocine.fr/seance/salle_gen_csalle=${esc(c.id)}.html" target="_blank" rel="noopener noreferrer">Page AlloCiné</a></p>
    ${dayChipsInSheet()}
    ${activeFiltersLine()}
    <div class="glass card">${list.map(([mid, rs]) => `
      <div class="film-row">
        <button class="thumb" data-movie="${mid}" type="button">${poster(data.movies[mid])}</button>
        <div class="info"><button class="ft" data-movie="${mid}" type="button">${esc(data.movies[mid]?.t)}</button>
          <div class="fs">${esc(runtime(data.movies[mid]))}</div>
          <div class="times">${rs.map(timeChip).join("")}</div></div>
      </div>`).join("") || emptyState()}</div>`, "cinema", cid);
}

function showFilters() {
  const f = st.f;
  openSheet(`
    <h3>Filtres</h3>
    <div class="f-block"><h4>Carte</h4><div class="chips"><button class="chip ${f.cinepass ? "on" : ""}" data-ff="cinepass" type="button">CinéPass acceptée</button></div></div>
    <div class="f-block"><h4>Version</h4><div class="chips">${[["", "Toutes"], ["VF", "VF"], ["VOST", "VO / VOST"]].map(([v, l]) => `<button class="chip ${f.version === v ? "on" : ""}" data-fv="${v}" type="button">${l}</button>`).join("")}</div></div>
    <div class="f-block"><h4>À partir de</h4><div class="chips">${HOURS.map((h) => `<button class="chip ${f.fromHour === h ? "on" : ""}" data-fh="${h}" type="button">${h ? h + " h" : "Toute la journée"}</button>`).join("")}</div></div>
    <div class="f-block"><h4>Format</h4><div class="chips">${FORMATS.map((x) => `<button class="chip ${f.formats.includes(x) ? "on" : ""}" data-fx="${esc(x)}" type="button">${esc(x)}</button>`).join("")}</div></div>
    <div class="f-block"><h4>Département</h4><div class="chips">${Object.entries(DEPTS).map(([k, l]) => `<button class="chip ${f.deps.includes(k) ? "on" : ""}" data-fd="${k}" type="button">${esc(l)} <span class="sub">${k}</span></button>`).join("")}</div></div>
    <div class="f-block"><h4>Près de moi</h4><div class="chips">${st.pos
      ? `<button class="chip ${f.near ? "on" : ""}" data-ff="near" type="button">À moins de ${st.radius} km</button>`
      : `<span class="small">Ajoute ta position dans Réglages pour utiliser ce filtre.</span>`}</div></div>
    <p class="btn-row"><button class="btn ghost" data-reset type="button">Tout effacer</button><button class="btn" data-close type="button">Voir les résultats</button></p>`, "filters");
}

async function refreshSheet() {
  if (sheet.kind === "movie") await showMovie(sheet.id);
  else if (sheet.kind === "cinema") await showCinema(sheet.id);
  else if (sheet.kind === "filters") { const y = $(".sheet-panel").scrollTop; showFilters(); $(".sheet-panel").scrollTop = y; }
}

// ------------------------------------------------------------ Position
function useGeolocation() {
  if (!navigator.geolocation) { alert("La localisation n'est pas disponible sur cet appareil."); return; }
  navigator.geolocation.getCurrentPosition(
    (p) => { setPosition({ lat: p.coords.latitude, lng: p.coords.longitude, label: "Ma position actuelle" }); },
    (e) => alert(e.code === 1 ? "Localisation refusée. Tu peux l'autoriser dans Réglages › Confidentialité › Service de localisation, ou choisir une ville." : "Position introuvable pour l'instant."),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
}
function setPosition(p) {
  st.pos = p; save("position", p);
  if (p && !st.f.near) { st.f.near = true; saveFilters(); }
  if (!p) { st.f.near = false; saveFilters(); }
  render();
}
function cityPosition(city) {
  const cs = [...data.cinemas.values()].filter((c) => c.city === city && c.lat != null);
  if (!cs.length) return null;
  return { lat: cs.reduce((s, c) => s + c.lat, 0) / cs.length, lng: cs.reduce((s, c) => s + c.lng, 0) / cs.length, label: city };
}

// ------------------------------------------------------------ Événements
function toggleIn(arr, v) { const i = arr.indexOf(v); i < 0 ? arr.push(v) : arr.splice(i, 1); }

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  const d = t.dataset;
  if (e.target.closest("[data-close]") && (d.close !== undefined)) { closeSheet(); render(); return; }
  if (d.tab) { st.tab = d.tab; st.nowLimit = 60; scrollTo(0, 0); render(); return; }
  if (d.day) { st.day = d.day; st.nowLimit = 60; await render(); if (sheet.kind) refreshSheet(); return; }
  if (d.movie) { e.preventDefault(); showMovie(d.movie); return; }
  if (d.cinema) { showCinema(d.cinema); return; }
  if (d.more !== undefined) { st.nowLimit += 100; render(); return; }
  if (t.id === "more-filters") { showFilters(); return; }
  if (t.closest("#quick") && d.f) {
    const f = st.f;
    if (d.f === "cinepass") f.cinepass = !f.cinepass;
    if (d.f === "vf") f.version = f.version === "VF" ? "" : "VF";
    if (d.f === "vost") f.version = f.version === "VOST" ? "" : "VOST";
    if (d.f === "evening") f.fromHour = f.fromHour === 18 ? 0 : 18;
    if (d.f === "near") {
      if (!st.pos) { st.tab = "settings"; render(); setTimeout(() => alert("Ajoute d'abord ta position (ou choisis une ville) ici, puis reviens."), 50); return; }
      f.near = !f.near;
    }
    saveFilters(); render(); return;
  }
  // feuille des filtres
  if (d.ff) { st.f[d.ff] = !st.f[d.ff]; }
  else if (d.fv !== undefined) st.f.version = d.fv;
  else if (d.fh !== undefined) st.f.fromHour = Number(d.fh);
  else if (d.fx) toggleIn(st.f.formats, d.fx);
  else if (d.fd) toggleIn(st.f.deps, d.fd);
  else if (d.reset !== undefined) Object.assign(st.f, { cinepass: false, version: "", near: false, fromHour: 0, formats: [], deps: [] });
  if (d.ff || d.fv !== undefined || d.fh !== undefined || d.fx || d.fd || d.reset !== undefined) { saveFilters(); renderChips(); refreshSheet(); return; }
  // réglages
  if (d.geo !== undefined) useGeolocation();
  if (d.geoClear !== undefined) setPosition(null);
  if (d.r) { st.radius = Number(d.r); save("radius", st.radius); render(); }
  if (d.hidePast !== undefined) { st.hidePast = !st.hidePast; save("hide-past", st.hidePast); render(); }
  if (d.bg) { background.setStyle(d.bg); render(); }
});
document.addEventListener("click", (e) => { const p = e.target.closest("[data-expand]"); if (p) p.classList.toggle("clamp"); });
$("#sheet").addEventListener("click", (e) => { if (e.target.matches(".sheet-backdrop, .sheet-grab, .sheet-close")) { closeSheet(); render(); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheet.kind) { closeSheet(); render(); } });
document.addEventListener("change", (e) => {
  if (e.target.id === "city-pick" && e.target.value) setPosition(cityPosition(e.target.value));
});
document.addEventListener("input", (e) => {
  if (e.target.id === "bg-speed") background.setSpeed(e.target.value);
  if (e.target.id === "glass") setGlass(Number(e.target.value), true);
});
let qTimer = 0;
$("#q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = e.target.value.trim(); st.nowLimit = 60; render(); }, 150); });
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });

// ------------------------------------------------------------ Barre d'onglets en verre (téléphone)
let glassTabs = null;
function setGlass(v, persist) {
  document.documentElement.style.setProperty("--glass-t", String(v / 100));
  $("nav#tabs .lg-host")?.style.setProperty("--lg-transparency", String(v / 100));
  if (persist) save("glass-transparency", v / 100);
}
function loadGlassTabs() {
  const nav = $("nav#tabs");
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = "vendor/liquidglass.css";
  document.head.insertBefore(link, document.head.firstChild);
  import("../vendor/liquidglass.js").then((lg) => {
    const h = lg.h;
    const items = [...nav.querySelectorAll("button[data-tab]")].map((b) => ({
      value: b.dataset.tab, label: b.textContent.trim(),
      icon: h("svg", { viewBox: "0 0 24 24", width: 26, height: 26, fill: "none", stroke: "currentColor", strokeWidth: 1.8,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, dangerouslySetInnerHTML: { __html: b.querySelector("svg").innerHTML } }),
    }));
    const host = document.createElement("div");
    host.className = "lg-host"; host.setAttribute("data-theme", "dark");
    nav.appendChild(host);
    setGlass(Math.round(pref("glass-transparency", 0.5) * 100), false);
    glassTabs = lg.mountTabBar(host, { items, value: st.tab, onValueChange: (v) => { st.tab = v; scrollTo(0, 0); render(); } });
    nav.classList.add("lg-on");
  }).catch((err) => console.warn("Barre en verre indisponible :", err));
}

// ------------------------------------------------------------ Démarrage
async function boot() {
  $("#version").textContent = APP_VERSION;
  setGlass(Math.round(pref("glass-transparency", 0.5) * 100), false);
  startBackground();
  if (matchMedia("(max-width: 860px)").matches) loadGlassTabs();
  try {
    const [meta, cinemas, movies] = await Promise.all([getJson("data/meta.json"), getJson("data/cinemas.json"), getJson("data/movies.json")]);
    data.meta = meta; data.movies = movies;
    for (const c of cinemas) data.cinemas.set(c.id, c);
  } catch (e) {
    $("#tab-films").innerHTML = `<div class="empty"><b>Données indisponibles</b>Vérifie ta connexion puis rouvre l'app.</div>`;
    return;
  }
  const days = (data.meta.days || []).filter((d) => d >= today());
  st.day = days[0] || data.meta.days?.[0];
  if (!st.pos) st.f.near = false;
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
}
boot();
