// Hauteur réelle de l'écran → --vvh (même correctif que l'app Sport, voir son <head>).
// En app installée sur l'écran d'accueil, l'iPhone sous-estime la hauteur visible d'exactement la hauteur
// de la barre d'état : sans ça, une bande noire reste en bas quand la page est courte.
// Fichier séparé (et non script en ligne) : la CSP n'autorise que les scripts du site.
(function () {
  function setVVH() {
    var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (window.navigator.standalone && window.screen) {
      var landscape = window.innerWidth > window.innerHeight;
      var physical = landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
      if (physical > h && physical - h < 150) h = physical;
    }
    if (h < 200) return; // mesure transitoire farfelue (verrouillage, rotation) : on garde la précédente
    document.documentElement.style.setProperty("--vvh", h * 0.01 + "px");
  }
  function again() { setVVH(); setTimeout(setVVH, 60); setTimeout(setVVH, 350); }
  setVVH();
  addEventListener("resize", setVVH);
  addEventListener("orientationchange", again);
  addEventListener("pageshow", again);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) again(); });
  if (window.visualViewport) visualViewport.addEventListener("resize", setVVH);
})();
