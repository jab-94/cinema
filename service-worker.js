// Augmenter à chaque publication (avec APP_VERSION dans js/version.js), sinon les téléphones gardent l'ancienne version.
const CACHE_VERSION = "cine-v6";
const CORE = [
  "./", "index.html", "css/app.css", "manifest.json",
  "js/app.js", "js/version.js", "js/viewport.js", "js/background.js", "js/shaders.js",
  "vendor/liquidglass.js", "vendor/liquidglass.css",
  "icons/icon-192-v1.png", "icons/icon-512-v1.png", "icons/apple-touch-icon-v1.png",
];
const POSTERS = "posters-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== POSTERS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Affiches (AlloCiné) : cache d'abord, gardées hors ligne
  if (url.hostname.endsWith(".acsta.net")) {
    e.respondWith(caches.open(POSTERS).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === "opaque") c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // Vendor et icônes : cache d'abord. Code et données : réseau d'abord (sinon versions désynchronisées).
  const cacheFirst = url.pathname.includes("/vendor/") || url.pathname.includes("/icons/");
  if (cacheFirst) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
    return;
  }
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
