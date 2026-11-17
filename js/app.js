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
const data = { meta: null, cinemas: new Map(), movies: {}, days: {}, progress: { h: {}, p: {} } };
const st = {
  tab: "films",
  day: null,
  q: "",
  f: Object.assign({ cinepass: false, version: "", near: false, fromHour: 0, formats: [], deps: [], leaving: false }, pref("filters", {})),
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
// Séances de nuit (avant 5 h) : elles terminent la soirée, on les range après 23 h ("00:30" → "24:30").
const tkey = (t) => (t < "05:00" ? String(Number(t.slice(0, 2)) + 24) + t.slice(2) : t);
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
// Notes : IMDb sur 10 (m.im = [note, votes]), AlloCiné spectateurs / presse sur 5 (m.us, m.pr = [note, nombre]).
const num1 = (x) => String(x).replace(".", ",");
const kVotes = (n) => (n >= 1000 ? `${num1(Math.round(n / 100) / 10)} k` : String(n));
// Petite pastille AlloCiné (dessinée ici : carré jaune, ticket avec un téléphone) devant les notes AlloCiné.
const AC_ICON = `<svg class="r-ac" viewBox="0 0 16 16" aria-label="AlloCiné"><rect width="16" height="16" rx="3.5" fill="#fecc00"/><path d="M3 4.6h10v2a1.4 1.4 0 0 0 0 2.8v2H3v-2a1.4 1.4 0 0 0 0-2.8z" fill="none" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.3 6.4c.3-.3.7-.3.9 0l.5.6c.2.2.2.5 0 .7l-.3.3c.3.6.8 1.1 1.4 1.4l.3-.3c.2-.2.5-.2.7 0l.6.5c.3.2.3.6 0 .9l-.4.4c-.4.4-1 .4-1.5.2a5.6 5.6 0 0 1-2.8-2.8c-.2-.5-.2-1.1.2-1.5z" fill="#111"/></svg>`;
function ratingsShort(m) {
  const out = [];
  if (m?.im) out.push(`<span class="r-imdb">IMDb</span> ${num1(m.im[0])}`);
  if (m?.us) out.push(`${AC_ICON} ★ ${num1(m.us[0])}`);
  else if (m?.pr) out.push(`${AC_ICON} Presse ${num1(m.pr[0])}`);
  return out.length ? `<div class="ratings">${out.join(" · ")}</div>` : "";
}
function ratingsFull(m) {
  const out = [];
  if (m?.im) out.push(`<span class="rate"><b class="r-imdb">IMDb</b> ${num1(m.im[0])}<small>/10</small></span>`);
  if (m?.us) out.push(`<span class="rate">${AC_ICON}<b>Spectateurs</b> ★ ${num1(m.us[0])}<small>/5</small></span>`);
  if (m?.pr) out.push(`<span class="rate">${AC_ICON}<b>Presse</b> ★ ${num1(m.pr[0])}<small>/5</small></span>`);
  return out.length ? `<div class="rates">${out.join("")}</div>` : "";
}
function runtime(m) { if (!m?.d) return ""; const h = Math.floor(m.d / 60), mn = m.d % 60; return h ? `${h} h ${String(mn).padStart(2, "0")}` : `${mn} min`; }
// Ressortie = film produit avant l'an dernier mais dont la « date de sortie » AlloCiné est récente (ex. Dune, 2021,
// ressorti le 11/11/2026). « Nouveau » seulement pour les vraies nouveautés de la semaine (v22).
function isRerelease(m) { return !!(m?.y && m.r && m.y < Number(today().slice(0, 4)) - 1 && Number(m.r.slice(0, 4)) - m.y >= 2); }
function sinceRelease(m) { return m?.r && m.r <= st.day ? (Date.parse(st.day) - Date.parse(m.r)) / 86400000 : Infinity; }
function isNew(m) { return sinceRelease(m) < 7 && !isRerelease(m); }
function releaseBadge(m) {
  if (isNew(m)) return `<span class="new">Nouveau</span>`;
  if (isRerelease(m) && sinceRelease(m) < 30) return `<span class="new rerelease">Ressortie</span>`;
  return "";
}
function poster(m, cls = "") {
  return m?.p ? `<img src="${esc(m.p)}" alt="" loading="lazy" decoding="async" class="${cls}" referrerpolicy="no-referrer">` : `<div class="ph">${esc(m?.t || "")}</div>`;
}
// ---- Dernière chance (v19) : calculée ICI, car elle dépend de ta position et de ton rayon (qui ne quittent pas
// le téléphone). Un film est en « dernière chance » s'il n'est plus programmé dans AUCUN cinéma de ta zone (rayon de
// Réglages autour de ta position ; sans position : toute l'Île-de-France) à partir de mercredi prochain (changement
// de programme), et seulement si tous les cinémas de ta zone qui le passent ont déjà publié ce mercredi.
// Données du robot : data/progress.json { h: {cinéma: fin de programmation publiée}, p: {cinéma: {film: [dernier jour, séances]}} }.
const addDays = (d, k) => new Date(Date.parse(d + "T12:00:00Z") + k * 86400000).toISOString().slice(0, 10);
const weekday = (d) => new Date(d + "T12:00:00Z").getUTCDay();
function nextWednesday() { const t = today(); for (let k = 1; k <= 7; k++) if (weekday(addDays(t, k)) === 3) return addDays(t, k); }
let lcCache = null;
function lastChanceInfo() {
  const key = [data.meta?.updatedAt, today(), st.pos?.lat, st.pos?.lng, st.radius, st.f.cinepass, st.f.deps.join()].join("|");
  if (lcCache?.key === key) return lcCache;
  const wed = nextWednesday(), t = today(), H = data.progress.h || {}, P = data.progress.p || {};
  // Zone = cinémas qui correspondent à tes filtres « où » : rayon (si position), CinéPass, départements (v21).
  const zone = [...data.cinemas.values()].filter((c) => P[c.id]
    && (!st.pos || (distOf(c) ?? 1e9) <= st.radius)
    && (!st.f.cinepass || c.cp)
    && (!st.f.deps.length || st.f.deps.includes(c.zip?.slice(0, 2)))).map((c) => c.id);
  const film = {};
  for (const cid of zone) {
    for (const [mid, [last, n]] of Object.entries(P[cid])) {
      const f = (film[mid] ||= { last: null, n: 0, unknown: false, continues: false });
      if (last >= wed) f.continues = true;
      else if ((H[cid] || "") < wed) f.unknown = true; // ce cinéma n'a pas encore publié mercredi : on ne sait pas
      if (last < wed && last >= t && (!f.last || last > f.last)) f.last = last;
      f.n += n;
    }
  }
  const films = new Map();
  // Seulement les films de l'ACTUALITÉ (produits cette année ou l'an dernier) : les ressorties, classiques,
  // rétrospectives et ciné-clubs ne « quittent pas l'affiche » au sens où on l'entend (v21). Sans année connue :
  // sortie il y a moins de 6 mois. Un film récent en fin de course (1 séance par jour) compte.
  const year = Number(t.slice(0, 4)), sixMonthsAgo = addDays(t, -183);
  for (const [mid, f] of Object.entries(film)) {
    const m = data.movies[mid] || {};
    const current = m.y ? m.y >= year - 1 : (m.r || "") >= sixMonthsAgo;
    if (current && !f.continues && !f.unknown && f.last) films.set(mid, f.last);
  }
  const published = zone.filter((id) => (H[id] || "") >= wed).length;
  return (lcCache = { key, wed, films, zone: zone.length, published });
}
function lastChance(mid) { return lastChanceInfo().films.get(mid) || null; }
// Dans un cinéma précis : le film n'y est plus programmé à partir de mercredi (cinéma qui a publié mercredi).
function leavingHere(cid, mid) {
  const e = data.progress.p?.[cid]?.[mid], wed = lastChanceInfo().wed;
  return e && (data.progress.h?.[cid] || "") >= wed && e[0] < wed && e[0] >= today() && e[1] >= 2 ? e[0] : null;
}
function zoneLabel() {
  const where = st.pos ? `à moins de ${st.radius} km` : st.f.deps.length ? `dans ${st.f.deps.length > 1 ? "tes départements" : DEPTS[st.f.deps[0]]}` : "en Île-de-France";
  return st.f.cinepass ? `dans les cinémas CinéPass ${where}` : where;
}
function lastChanceBanner() {
  if (!st.f.leaving) return "";
  const i = lastChanceInfo();
  const lbl = dayLabel(i.wed, true);
  const from = lbl === "Demain" ? "à partir de demain" : `à partir du ${lbl}`;
  const of = lbl === "Demain" ? "de demain" : `du ${lbl}`;
  if (!i.published) return `<p class="lc-banner">Programmes ${esc(of)} pas encore publiés (lundi ou mardi) : impossible de savoir quels films partiront.</p>`;
  if (i.published < i.zone) return `<p class="lc-banner">Plus à l'affiche ${esc(zoneLabel())} ${esc(from)} · ${i.published}/${i.zone} cinémas ont publié</p>`;
  return `<p class="lc-banner">Plus à l'affiche ${esc(zoneLabel())} ${esc(from)}</p>`;
}
function leavingTag(day, here = false) {
  if (!day) return "";
  const when = day === st.day ? (here ? "Dernier jour ici" : "Dernier jour") : `${here ? "Dernière séance ici" : "Dernière séance"} ${dayLabel(day).toLowerCase()}`;
  return `<span class="leaving">${esc(when)}</span>`;
}
function whenText(d) {
  const l = dayLabel(d, true);
  return l === "Aujourd'hui" ? "aujourd'hui" : l === "Demain" ? "demain" : `le ${l}`;
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
    if (f.leaving && !lastChance(mid)) continue;
    const c = data.cinemas.get(cid);
    if (!c) continue;
    if (f.cinepass && !c.cp) continue;
    if (f.deps.length && !f.deps.includes(c.zip?.slice(0, 2))) continue;
    if (f.version === "VF" && v !== "VF") continue;
    if (f.version === "VOST" && v === "VF") continue;
    if (f.formats.length && !f.formats.some((x) => fmts.includes(x))) continue;
    if (from && tkey(time) < from) continue;
    if (past && tkey(time) < past) continue;
    const d = distOf(c);
    if ((f.near || f.leaving) && st.pos && (d == null || d > st.radius)) continue; // « dernière chance » = dans ta zone
    const m = data.movies[mid];
    if (tokens.length) {
      const hay = norm(`${m?.t} ${c.name} ${c.city} ${c.zip}`);
      if (!tokens.every((t) => hay.includes(t))) continue;
    }
    out.push({ c, m, mid, time, v, fmts, url: frLink(url), d });
  }
  out.sort((a, b) => tkey(a.time).localeCompare(tkey(b.time)));
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
  // Un onglet déjà affiché n'est reconstruit que si ce qu'il montre a changé (jour, recherche, filtres,
  // position…) : changer d'onglet est alors instantané (v5).
  const sig = viewSignature(st.tab);
  const el = $(`#tab-${st.tab}`);
  if (st.tab !== "settings" && el.dataset.sig === sig) return;
  await views[st.tab]?.(el, token);
  if (token === renderToken && (st.tab === "films" || st.tab === "now")) el.insertAdjacentHTML("afterbegin", lastChanceBanner());
  if (token === renderToken) el.dataset.sig = sig;
}
function viewSignature(tab) {
  const base = [data.meta?.updatedAt, st.day, st.q, JSON.stringify(st.f), st.radius, st.pos ? `${st.pos.lat},${st.pos.lng}` : "", st.hidePast];
  if (tab === "now") base.push(st.nowLimit, Math.floor(Date.now() / 60000)); // séances passées : à la minute près
  if (tab === "films" && st.hidePast && st.day === today()) base.push(Math.floor(Date.now() / 600000));
  return base.join("|");
}

function renderChips() {
  $("#days").innerHTML = (data.meta?.days || []).filter((d) => d >= today())
    .map((d) => `<button class="chip ${d === st.day ? "on" : ""}" data-day="${d}" type="button">${esc(dayLabel(d))}</button>`).join("");
  const f = st.f;
  const on = { cinepass: f.cinepass, leaving: f.leaving, vf: f.version === "VF", vost: f.version === "VOST", near: f.near, evening: f.fromHour === 18 };
  document.querySelectorAll("#quick .toggle").forEach((b) => b.classList.toggle("on", !!on[b.dataset.f]));
  const n = f.formats.length + f.deps.length + (f.fromHour && f.fromHour !== 18 ? 1 : 0);
  $("#filter-count").textContent = n || "";
}

// next : premier jour où il y a VRAIMENT une séance avec les filtres actuels (voir nextDayWith) ; null = aucun.
function emptyState(text = "Aucune séance ne correspond.", next = null, inSheet = false) {
  const tips = [];
  if (st.f.near) tips.push(`le rayon « Près de moi » est de ${st.radius} km`);
  if (st.f.cinepass) tips.push("seuls les cinémas CinéPass sont affichés");
  if (st.f.leaving) tips.push("seuls les films en dernière chance sont affichés");
  if (st.q) tips.push(`la recherche « ${esc(st.q)} » est active`);
  const late = !inSheet && st.day === today() && next && !tips.length; // « c'est fini pour aujourd'hui » : pages principales seulement
  const btn = next
    ? `<p><button class="btn" data-day="${next}" type="button">Prochaine séance : ${esc(dayLabel(next).toLowerCase())} ›</button></p>`
    : `<p class="small">Aucune autre séance cette semaine${tips.length ? " avec ces filtres" : ""}.</p>`;
  const msg = late ? "Toutes les séances de la journée sont passées." : tips.length ? "Remarque : " + tips.join(", ") + "." : "";
  return `<div class="empty"><b>${late && !tips.length ? "C'est fini pour aujourd'hui" : text}</b>${msg}${btn}</div>`;
}

// Premier jour après celui affiché où il reste au moins une séance (filtres actuels ; opts = film ou cinéma précis).
async function nextDayWith(opts = {}) {
  for (const d of (data.meta?.days || []).filter((x) => x > st.day && x >= today())) {
    if ((await rowsFor(d, opts)).length) return d;
  }
  return null;
}
function nextDay(d) {
  const days = (data.meta?.days || []).filter((x) => x >= today());
  return days[days.indexOf(d) + 1] || null;
}
// Jour affiché à l'ouverture : aujourd'hui, sauf s'il n'y reste plus aucune séance à venir
// (ex. ouverture à 23 h 30) → demain directement.
async function pickDefaultDay() {
  const days = (data.meta?.days || []).filter((d) => d >= today());
  st.day = days[0] || data.meta?.days?.[0];
  if (days[1] && st.hidePast && !(await rowsFor(days[0], { ignoreQuery: true })).length) st.day = days[1];
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
  // Recherche : les films qui correspondent mais n'ont pas de séance ce jour-là (avec les filtres actuels)
  // sont montrés quand même, avec un bouton vers leur prochaine séance.
  const off = st.q ? await offDayMatches(new Set(byMovie.keys())) : [];
  if (token !== renderToken) return;
  if (!list.length && !off.length) {
    el.innerHTML = st.q
      ? `<div class="empty"><b>Aucun film ne correspond</b>Rien à l'affiche cette semaine en Île-de-France pour « ${esc(st.q)} »${st.f.cinepass || st.f.near || st.f.version || st.f.formats.length || st.f.deps.length || st.f.fromHour || st.f.leaving ? " avec tes filtres" : ""}.</div>`
      : emptyState("Aucun film ne correspond.", await nextDayWith());
    return;
  }
  const offHtml = off.length ? `
  <div class="section-title">Pas de séance ${esc(dayLabel(st.day).toLowerCase())}</div>
  <div class="glass card off-day">${off.map((o) => `
    <div class="film-row">
      <button class="thumb" data-movie="${o.mid}" type="button">${poster(o.m)}</button>
      <div class="info"><button class="ft" data-movie="${o.mid}" type="button">${esc(o.m.t)}</button>
        <div class="off-note">Aucune séance ${esc(dayLabel(st.day).toLowerCase())}${st.f.cinepass || st.f.near || st.f.version || st.f.formats.length || st.f.deps.length || st.f.fromHour || st.f.leaving ? " (avec tes filtres)" : ""}</div>
        ${o.next ? `<button class="next-btn" data-day="${o.next}" data-open-movie="${o.mid}" type="button">Prochaine séance : ${esc(dayLabel(o.next).toLowerCase())} ›</button>` : `<div class="off-note">Pas d'autre séance prévue cette semaine</div>`}
      </div>
    </div>`).join("")}</div>` : "";
  if (st.q) { // recherche : liste compacte, pour voir d'un coup les films à l'affiche ce jour-là et les autres
    el.innerHTML = (list.length ? `<p class="meta-line">${esc(dayLabel(st.day, true))} · ${nb(list.length, "film")}</p>
    <div class="glass card off-day">${list.map((g) => `
      <div class="film-row">
        <button class="thumb" data-movie="${g.mid}" type="button">${poster(g.m)}</button>
        <div class="info"><button class="ft" data-movie="${g.mid}" type="button">${esc(g.m?.t)}</button>
          <div class="off-note">${esc([runtime(g.m), g.m?.g?.[0]].filter(Boolean).join(" · "))}</div>
          ${ratingsShort(g.m)}
          <button class="next-btn" data-movie="${g.mid}" type="button">${nb(g.cines.size, "cinéma")} · ${nb(g.n, "séance")} ›</button>
        </div>
      </div>`).join("")}</div>` : "") + offHtml;
    return;
  }
  el.innerHTML = (list.length ? `<p class="meta-line">${esc(dayLabel(st.day, true))} · ${nb(list.length, "film")} · ${nb(rows.length, "séance")}</p>
  <div class="grid">${list.map((g) => `
    <button class="movie" data-movie="${g.mid}" type="button">
      <div class="poster">${poster(g.m)}<span class="count">${nb(g.cines.size, "cinéma")}</span>${lastChance(g.mid) ? "" : releaseBadge(g.m)}${lastChance(g.mid) ? `<span class="last-days">${lastChance(g.mid) === st.day ? "Dernier jour" : "Dernière chance"}</span>` : ""}</div>
      <div class="mt">${esc(g.m?.t)}</div>
      <div class="ms">${esc([runtime(g.m), g.m?.g?.[0]].filter(Boolean).join(" · "))}${st.pos && g.dmin < Infinity ? ` · ${fmtKm(g.dmin)}` : ""}</div>
      ${ratingsShort(g.m)}
    </button>`).join("")}</div>` : "") + offHtml;
};

// Films dont le titre correspond à la recherche mais absents du jour choisi : prochain jour avec séance.
async function offDayMatches(shown) {
  const tokens = norm(st.q).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const hits = Object.entries(data.movies).filter(([mid, m]) => !shown.has(mid) && tokens.every((t) => norm(`${m.t} ${m.ot || ""}`).includes(t)));
  if (!hits.length || hits.length > 30) return [];
  const days = (data.meta?.days || []).filter((d) => d >= today() && d > st.day);
  const out = [];
  for (const [mid, m] of hits) {
    let next = null;
    for (const d of days) { if ((await rowsFor(d, { ignoreQuery: true, movieId: mid })).length) { next = d; break; } }
    out.push({ mid, m, next });
  }
  return out.sort((a, b) => (a.next || "9").localeCompare(b.next || "9"));
}

// AlloCiné donne pour Pathé des liens en anglais (s.pathe.fr/en/…) : l'app Pathé s'ouvrait en anglais.
const frLink = (u) => (u ? u.replace(/^https:\/\/s\.pathe\.fr\/en\//, "https://s.pathe.fr/fr/") : u);

function timeChip(r) {
  const tags = [r.v, ...r.fmts.filter((x) => x !== "Dolby Atmos")].join(" · ");
  const past = tkey(r.time) < nowHM() && st.day === today();
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
  rows.sort((a, b) => tkey(a.time).localeCompare(tkey(b.time)) || (a.d ?? 1e9) - (b.d ?? 1e9));
  if (!rows.length) { el.innerHTML = emptyState(undefined, await nextDayWith()); return; }
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
  if (!list.length) { el.innerHTML = emptyState("Aucun cinéma ne correspond.", await nextDayWith({ ignoreQuery: true })); return; }
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
    <div class="set-row"><div class="lbl">Vitesse du fond<small>Tout à gauche = fond fixe (économise la batterie).</small><input id="bg-speed" type="range" min="0" max="100" value="${background.speed}"></div></div>
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
// Fermeture : le panneau glisse vers le bas (0,25 s). La page derrière n'est redessinée que si
// quelque chose a changé pendant que le panneau était ouvert (jour, filtres) : sinon rien à refaire.
const sheet = { kind: null, id: null, dirty: false, closing: false };
const $sheet = $("#sheet"), $panel = $(".sheet-panel"), $backdrop = $(".sheet-backdrop");
function openSheet(html, kind, id) {
  const reopen = !$sheet.hidden && !sheet.closing;
  sheet.kind = kind; sheet.id = id; sheet.closing = false;
  $("#sheet-body").innerHTML = html;
  $sheet.classList.remove("closing");
  $panel.style.transform = ""; $backdrop.style.opacity = "";
  if (!reopen) { $sheet.hidden = false; $panel.scrollTop = 0; }
  else $panel.scrollTop = 0;
  document.body.classList.add("sheet-open");
  background.pause();
}
function closeSheet() {
  if ($sheet.hidden || sheet.closing) return;
  sheet.closing = true; sheet.kind = null;
  $sheet.classList.add("closing");
  $panel.style.transform = ""; $backdrop.style.opacity = "";
  const done = () => {
    if (!sheet.closing) return;
    sheet.closing = false;
    $sheet.hidden = true; $sheet.classList.remove("closing");
    document.body.classList.remove("sheet-open");
    background.resume();
    if (sheet.dirty) { sheet.dirty = false; render(); }
  };
  setTimeout(done, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240);
}

// Glisser le panneau vers le bas pour le fermer (depuis la poignée, ou n'importe où quand le contenu est en haut).
(() => {
  let y0 = 0, t0 = 0, dy = 0, dragging = false, armed = false;
  $panel.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || sheet.closing) return;
    armed = $panel.scrollTop <= 0 || !!e.target.closest(".sheet-grab");
    dragging = false; dy = 0; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  $panel.addEventListener("touchmove", (e) => {
    if (!armed) return;
    const d = e.touches[0].clientY - y0;
    if (!dragging) {
      if (d > 6 && $panel.scrollTop <= 0) { dragging = true; $panel.classList.add("dragging"); }
      else if (d < -6) { armed = false; return; }
      else return;
    }
    e.preventDefault(); // le panneau suit le doigt au lieu de faire défiler
    dy = Math.max(0, d);
    $panel.style.transform = `translateY(${dy}px)`;
    $backdrop.style.opacity = String(Math.max(0, 1 - dy / ($panel.offsetHeight || 600)));
  }, { passive: false });
  const end = () => {
    if (!dragging) { armed = false; return; }
    dragging = armed = false;
    $panel.classList.remove("dragging");
    const speed = dy / Math.max(1, Date.now() - t0); // px/ms
    if (dy > 110 || (dy > 30 && speed > 0.5)) {
      // part depuis la position du doigt
      $panel.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => closeSheet());
    } else { $panel.style.transform = ""; $backdrop.style.opacity = ""; }
  };
  $panel.addEventListener("touchend", end);
  $panel.addEventListener("touchcancel", end);
})();
// withCinepass : pastille CinéPass en tête (fiche film), pour changer le filtre sans revenir à l'accueil.
function dayChipsInSheet(withCinepass = false) {
  const cp = withCinepass
    ? `<button class="chip toggle cp-chip ${st.f.cinepass ? "on" : ""}" data-sheet-cp type="button"><span class="cp-dot"></span>CinéPass</button><span class="chip-sep"></span>`
    : "";
  return `<div class="chips sheet-days">${cp}${(data.meta?.days || []).filter((d) => d >= today())
    .map((d) => `<button class="chip ${d === st.day ? "on" : ""}" data-day="${d}" type="button">${esc(dayLabel(d))}</button>`).join("")}</div>`;
}
function activeFiltersLine(skipCinepass = false) {
  const f = st.f, parts = [];
  if (f.cinepass && !skipCinepass) parts.push("CinéPass");
  if (f.version) parts.push(f.version);
  if (f.near && st.pos) parts.push(`≤ ${st.radius} km`);
  if (f.fromHour) parts.push(`après ${f.fromHour} h`);
  if (f.leaving) parts.push("dernière chance");
  parts.push(...f.formats, ...f.deps.map((d) => DEPTS[d]));
  return parts.length ? `<p class="small">Filtres : ${esc(parts.join(", "))}</p>` : "";
}

// Personnes : [nom, id AlloCiné] (anciennes données : simple nom)
const person = (x) => (Array.isArray(x) ? x : [x, null]);
function peopleBlock(label, list) {
  if (!list?.length) return "";
  return `<div class="people"><span class="people-lbl">${label}</span>${list.map((x) => {
    const [name, id] = person(x);
    return `<button class="person" data-person="${esc(name)}" data-pid="${esc(id || "")}" type="button">${esc(name)}</button>`;
  }).join("")}</div>`;
}

// Fiche d'une personne : ses films à l'affiche (dans nos données) + lien vers sa filmographie complète.
async function showPerson(name, pid) {
  const raw = await loadDay(st.day);
  const today = new Map();
  for (const [cid, mid] of raw) { if (!today.has(mid)) today.set(mid, new Set()); today.get(mid).add(cid); }
  const same = (x) => { const [n, id] = person(x); return (pid && id) ? String(id) === String(pid) : norm(n) === norm(name); };
  const films = [];
  for (const [mid, m] of Object.entries(data.movies)) {
    const roles = [];
    if (m.dir?.some(same)) roles.push("Réalisation");
    if (m.cast?.some(same)) roles.push("Interprétation");
    if (roles.length) films.push({ mid, m, roles, n: today.get(mid)?.size || 0 });
  }
  films.sort((a, b) => b.n - a.n || (b.m.r || "").localeCompare(a.m.r || ""));
  const link = pid ? `https://www.allocine.fr/personne/fichepersonne-${encodeURIComponent(pid)}/filmographie/`
    : `https://www.allocine.fr/rechercher/?q=${encodeURIComponent(name)}`;
  openSheet(`
    <h3>${esc(name)}</h3>
    <p class="btn-row"><a class="btn ghost" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Filmographie complète ›</a></p>
    <div class="section-title">À l'affiche cette semaine</div>
    <div class="glass card">${films.map((f) => `
      <div class="film-row">
        <button class="thumb" data-movie="${f.mid}" type="button">${poster(f.m)}</button>
        <div class="info"><button class="ft" data-movie="${f.mid}" type="button">${esc(f.m.t)}</button>
          <div class="fs">${esc([f.roles.join(", "), f.m.y || (f.m.r || "").slice(0, 4)].filter(Boolean).join(" · "))}</div>
          ${ratingsShort(f.m)}
          <div class="fs">${f.n ? `${nb(f.n, "cinéma")} ${esc(dayLabel(st.day).toLowerCase())}` : `Pas de séance ${esc(dayLabel(st.day).toLowerCase())}`}</div>
        </div>
      </div>`).join("") || `<p class="small">Aucun autre film à l'affiche.</p>`}</div>`, "person", name);
  sheet.pid = pid;
}

async function showMovie(mid) {
  const m = data.movies[mid];
  const rows = await rowsFor(st.day, { ignoreQuery: true, movieId: mid });
  const groups = groupByCinema(rows);
  // Résumé masqué par défaut (il en dit souvent trop) ; réalisateur et acteurs en avant, cliquables.
  const syn = m?.syn ? `<button class="syn-toggle" data-syn type="button">Afficher le résumé ›</button><p class="syn" hidden>${esc(m.syn)}</p>` : "";
  openSheet(`
    <div class="film-hero"><div class="poster">${poster(m)}</div>
      <div><h2>${esc(m?.t)}</h2>
        <div class="fs">${esc([runtime(m), (m?.g || []).join(", ")].filter(Boolean).join(" · "))}</div>
        ${m?.r ? `<div class="fs">${isRerelease(m) ? `Ressortie (film de ${m.y})` : "Sortie"} : ${esc(new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(m.r + "T12:00:00")))}</div>` : ""}
      </div></div>
    ${peopleBlock("Réal.", m?.dir)}
    ${peopleBlock("Avec", m?.cast)}
    ${ratingsFull(m)}
    ${syn}
    ${lastChance(mid) ? `<p class="leaving-note">⏳ Dernière chance ${esc(zoneLabel())} : dernière séance ${esc(whenText(lastChance(mid)))}, plus programmé à partir de mercredi.</p>` : ""}
    ${dayChipsInSheet(true)}
    ${activeFiltersLine(true)}
    <p class="meta-line">${nb(groups.length, "cinéma")} · ${nb(rows.length, "séance")}${st.pos ? " · du plus proche au plus loin" : ""}</p>
    <div class="list">${groups.map((g) => `
      <div class="glass card">
        <button class="card-head" data-cinema="${g.c.id}" type="button"><div><div class="name">${esc(g.c.name)}${cpBadge(g.c)}</div><div class="sub">${esc(cineSub(g.c))}</div>${leavingTag(leavingHere(g.c.id, mid), true)}</div><div class="right">›</div></button>
        <div class="times">${g.rows.map(timeChip).join("")}</div>
      </div>`).join("") || emptyState(`Pas de séance ${dayLabel(st.day).toLowerCase()}`, await nextDayWith({ ignoreQuery: true, movieId: mid }), true)}</div>`, "movie", mid);
}

async function showCinema(cid) {
  const c = data.cinemas.get(cid);
  const rows = await rowsFor(st.day, { ignoreQuery: true, cinemaId: cid });
  const byMovie = new Map();
  for (const r of rows) { if (!byMovie.has(r.mid)) byMovie.set(r.mid, []); byMovie.get(r.mid).push(r); }
  const list = [...byMovie.entries()].sort((a, b) => tkey(a[1][0].time).localeCompare(tkey(b[1][0].time)));
  // Itinéraire dans Waze (lien universel : ouvre l'app Waze si elle est installée, sinon le site Waze).
  const maps = c.lat != null
    ? `https://waze.com/ul?ll=${c.lat},${c.lng}&navigate=yes`
    : `https://waze.com/ul?q=${encodeURIComponent([c.address, c.zip, c.city].filter(Boolean).join(" "))}&navigate=yes`;
  openSheet(`
    <h3>${esc(c.name)}${cpBadge(c)}</h3>
    <p class="small cine-addr">${esc([c.address, `${c.zip} ${c.city}`].filter(Boolean).join(", "))}${distOf(c) != null ? " · " + fmtKm(distOf(c)) : ""}</p>
    <p class="btn-row"><a class="btn ghost" href="${esc(maps)}" target="_blank" rel="noopener noreferrer">Itinéraire Waze</a>
      <a class="btn ghost" href="https://www.allocine.fr/seance/salle_gen_csalle=${esc(c.id)}.html" target="_blank" rel="noopener noreferrer">Page AlloCiné</a></p>
    ${dayChipsInSheet()}
    ${activeFiltersLine()}
    <div class="glass card">${list.map(([mid, rs]) => `
      <div class="film-row">
        <button class="thumb" data-movie="${mid}" type="button">${poster(data.movies[mid])}</button>
        <div class="info"><button class="ft" data-movie="${mid}" type="button">${esc(data.movies[mid]?.t)}</button>
          <div class="fs">${esc(runtime(data.movies[mid]))}</div>${leavingTag(leavingHere(cid, mid), true)}
          <div class="times">${rs.map(timeChip).join("")}</div></div>
      </div>`).join("") || emptyState(`Pas de séance ${dayLabel(st.day).toLowerCase()}`, await nextDayWith({ ignoreQuery: true, cinemaId: cid }), true)}</div>`, "cinema", cid);
}

function showFilters() {
  const f = st.f;
  openSheet(`
    <h3>Filtres</h3>
    <div class="f-block"><h4>Carte</h4><div class="chips"><button class="chip ${f.cinepass ? "on" : ""}" data-ff="cinepass" type="button">CinéPass acceptée</button></div></div>
    <div class="f-block"><h4>Version</h4><div class="chips">${[["", "Toutes"], ["VF", "VF"], ["VOST", "VO / VOST"]].map(([v, l]) => `<button class="chip ${f.version === v ? "on" : ""}" data-fv="${v}" type="button">${l}</button>`).join("")}</div></div>
    <div class="f-block"><h4>À partir de</h4><div class="chips">${HOURS.map((h) => `<button class="chip ${f.fromHour === h ? "on" : ""}" data-fh="${h}" type="button">${h ? h + " h" : "Toute la journée"}</button>`).join("")}</div></div>
    <div class="f-block"><h4>À l'affiche</h4><div class="chips"><button class="chip ${f.leaving ? "on" : ""}" data-ff="leaving" type="button">Dernière chance (plus à l'affiche près de moi mercredi prochain)</button></div></div>
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
  else if (sheet.kind === "person") await showPerson(sheet.id, sheet.pid);
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
  if (e.target.closest("[data-close]")) { closeSheet(); return; } // ✕, poignée, fond grisé, « Voir les résultats »
  const t = e.target.closest("button, a");
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { st.tab = d.tab; st.nowLimit = 60; scrollTo(0, 0); render(); return; }
  if (d.day) {
    st.day = d.day; st.nowLimit = 60;
    if (sheet.kind) { sheet.dirty = true; renderChips(); refreshSheet(); } else await render();
    if (d.openMovie) showMovie(d.openMovie); // « Prochaine séance » : on ouvre directement la fiche du film ce jour-là
    return;
  }
  if (d.movie) { e.preventDefault(); showMovie(d.movie); return; }
  if (d.sheetCp !== undefined) { st.f.cinepass = !st.f.cinepass; saveFilters(); renderChips(); sheet.dirty = true; refreshSheet(); return; }
  if (d.person) { showPerson(d.person, d.pid || null); return; }
  if (d.syn !== undefined) { const p = t.nextElementSibling; p.hidden = !p.hidden; t.textContent = p.hidden ? "Afficher le résumé ›" : "Masquer le résumé ‹"; return; }
  if (d.cinema) { showCinema(d.cinema); return; }
  if (d.more !== undefined) { st.nowLimit += 100; render(); return; }
  if (t.id === "more-filters") { showFilters(); return; }
  if (t.closest("#quick") && d.f) {
    const f = st.f;
    if (d.f === "cinepass") f.cinepass = !f.cinepass;
    if (d.f === "leaving") f.leaving = !f.leaving;
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
  else if (d.reset !== undefined) Object.assign(st.f, { cinepass: false, version: "", near: false, fromHour: 0, formats: [], deps: [], leaving: false });
  if (d.ff || d.fv !== undefined || d.fh !== undefined || d.fx || d.fd || d.reset !== undefined) { saveFilters(); renderChips(); sheet.dirty = true; refreshSheet(); return; }
  // réglages
  if (d.geo !== undefined) useGeolocation();
  if (d.geoClear !== undefined) setPosition(null);
  if (d.r) { st.radius = Number(d.r); save("radius", st.radius); render(); }
  if (d.hidePast !== undefined) { st.hidePast = !st.hidePast; save("hide-past", st.hidePast); render(); }
  if (d.bg) { background.setStyle(d.bg); render(); }
});
document.addEventListener("click", (e) => { const p = e.target.closest("[data-expand]"); if (p) p.classList.toggle("clamp"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheet.kind) closeSheet(); });
document.addEventListener("change", (e) => {
  if (e.target.id === "city-pick" && e.target.value) setPosition(cityPosition(e.target.value));
});
document.addEventListener("input", (e) => {
  if (e.target.id === "bg-speed") background.setSpeed(e.target.value);
  if (e.target.id === "glass") setGlass(Number(e.target.value), true);
});
let qTimer = 0;
$("#q").addEventListener("input", (e) => {
  $("#q-clear").hidden = !e.target.value;
  clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = e.target.value.trim(); st.nowLimit = 60; render(); }, 150);
});
$("#q-clear").addEventListener("click", () => {
  const q = $("#q"); q.value = ""; $("#q-clear").hidden = true; st.q = ""; st.nowLimit = 60; render(); q.focus();
});
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
    data.progress = await getJson("data/progress.json").catch(() => ({ h: {}, p: {} })); // pour « dernière chance »
    for (const c of cinemas) data.cinemas.set(c.id, c);
  } catch (e) {
    $("#tab-films").innerHTML = `<div class="empty"><b>Données indisponibles</b>Vérifie ta connexion puis rouvre l'app.</div>`;
    return;
  }
  await pickDefaultDay();
  // App rouverte le lendemain (restée en mémoire) : on repart du bon jour.
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !data.meta || st.day >= today()) return;
    await pickDefaultDay(); render();
  });
  if (!st.pos) st.f.near = false;
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
}
boot();
