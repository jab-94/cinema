// Fond d'écran animé (même code que l'app Sport) : shaders WebGL1 « Mesh drift » et « Silk » (+ « Bordeaux »,
// le même shader Silk avec d'autres réglages et l'effet « push » sous le doigt / la souris).
// Réglages gardés sur ce téléphone : localStorage « bg-style » et « bg-speed ».
import { MESH_DRIFT, SILK } from "./shaders.js";

const STYLES = {
  plain: { label: "Uni" },
  mesh: { label: "Mesh drift", frag: MESH_DRIFT, timeScale: 0.73, colorCount: 4,
    colors: [0.063,0.000,0.169, 0.498,0.000,1.000, 0.200,0.682,0.725, 0.035,0.125,0.957],
    shape: [1.10, 0.34, 0.50, 0.00], surface: [2.40, 0.96, -0.10, 0.96], finish: [0.00, 0.36, 0.026, 0.07],
    transform: [1453.0, 0.00, 0.00, 0.0], space: [0.00, 0.00, 0.0, 0.0], cursor: [0.0, 2.0, 0.65, 0.46] },
  silk: { label: "Silk", frag: SILK, timeScale: 0.76, colorCount: 4,
    colors: [0.008,0.004,0.039, 0.016,0.020,0.180, 0.239,0.173,0.553, 0.569,0.420,0.749],
    shape: [1.26, 0.28, 0.50, 0.00], surface: [2.40, 1.11, 0.00, 1.00], finish: [0.00, 0.00, 0.000, 0.05],
    transform: [1581.0, 0.00, 0.00, 0.0], space: [0.00, 0.00, 0.0, 0.0], cursor: [0.0, 2.0, 0.65, 0.46] },
  // « Silk » bordeaux (21st.dev Shader Builder, même shader) : #0E0109 → #580939 → #9A005D mélangés en OKLab ;
  // vitesse 7, zoom 44, intensité 43, warp 3, contraste 40, luminosité 41, saturation 52, teinte 0°,
  // vignette 28, grain 10 ; curseur « push » force 30, rayon 50 (suit le doigt / la souris).
  bordeaux: { label: "Bordeaux", frag: SILK, timeScale: 0.23, colorCount: 3, pointer: true,
    colors: [0.055,0.004,0.035, 0.345,0.035,0.224, 0.604,0.000,0.365],
    shape: [1.38, 0.43, 0.80, 0.02], surface: [1.57, 0.96, -0.09, 1.04], finish: [0.00, 0.28, 0.021, 0.03],
    transform: [5293.0, 5.25, 0.01, 1.0], space: [0.08, -0.07, 0.0, 0.0], cursor: [0.0, 0.0, 0.30, 0.46] },
};
const DEFAULT_STYLE = "bordeaux", DEFAULT_SPEED = 50;

const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };

let styleKey = STYLES[pref("bg-style", DEFAULT_STYLE)] ? pref("bg-style", DEFAULT_STYLE) : DEFAULT_STYLE;
let speed = Math.max(0, Math.min(100, Number(pref("bg-speed", DEFAULT_SPEED)) || 0));

export const background = {
  styles: Object.entries(STYLES).map(([k, s]) => [k, s.label]),
  get style() { return styleKey; },
  get speed() { return speed; },
  setStyle() {}, setSpeed() {}, pause() {}, resume() {},
};

export function startBackground() {
  const canvas = document.getElementById("bg-shader");
  const gl = canvas?.getContext("webgl", { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "low-power" });
  if (!gl) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const compile = (type, src) => {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn("Fond animé :", gl.getShaderInfoLog(sh)); return null; }
    return sh;
  };
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const programs = {};
  const programFor = (key) => {
    if (key in programs) return programs[key];
    const vs = compile(gl.VERTEX_SHADER, "attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }");
    const fs = compile(gl.FRAGMENT_SHADER, STYLES[key].frag);
    let prog = null;
    if (vs && fs) {
      prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) prog = null;
    }
    return (programs[key] = prog);
  };
  let cur = null, uScene = null, uSpace = null, uCursor = null, simT = 0, last = 0, raf = 0;
  // Pointeur normalisé -1..1 (y vers le haut, comme gl_FragCoord) ; présence lissée 0 → 1.
  const ptr = { x: 0, y: 0, tx: 0, ty: 0, on: 0, presence: 0 };
  const onMove = (e) => {
    ptr.tx = (e.clientX / innerWidth) * 2 - 1; ptr.ty = 1 - (e.clientY / innerHeight) * 2; ptr.on = 1;
    if (!raf) draw();
  };
  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("pointerdown", onMove, { passive: true });
  addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") ptr.on = 0; }, { passive: true });
  document.addEventListener("pointerleave", () => { ptr.on = 0; });
  addEventListener("blur", () => { ptr.on = 0; });
  const rate = () => (cur?.frag ? cur.timeScale * (speed / DEFAULT_SPEED) : 0);
  function apply() {
    cur = STYLES[styleKey];
    if (!cur.frag) { stop(); canvas.classList.remove("on"); return; }
    const prog = programFor(styleKey);
    if (!prog) { canvas.classList.remove("on"); return; }
    gl.useProgram(prog);
    const aPos = gl.getAttribLocation(prog, "a_pos"); gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const colors = new Float32Array(24); colors.set(cur.colors);
    gl.uniform3fv(U("u_colors[0]") || U("u_colors"), colors);
    for (const k of ["shape", "surface", "finish", "transform", "space", "cursor"]) gl.uniform4fv(U("u_" + k), cur[k]);
    uScene = U("u_scene"); uSpace = U("u_space"); uCursor = U("u_cursor");
    draw(); start();
  }
  function draw() {
    if (!cur?.frag || !uScene) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform4f(uScene, canvas.width, canvas.height, simT, cur.colorCount);
    if (cur.pointer) {
      // suivi doux du doigt, présence qui apparaît / s'efface en ~0,3 s
      ptr.x += (ptr.tx - ptr.x) * 0.12; ptr.y += (ptr.ty - ptr.y) * 0.12;
      ptr.presence += ((still ? 0 : ptr.on) - ptr.presence) * 0.08;
      gl.uniform4f(uSpace, cur.space[0], cur.space[1], ptr.x, ptr.y);
      gl.uniform4f(uCursor, ptr.presence, cur.cursor[1], cur.cursor[2], cur.cursor[3]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.classList.add("on");
  }
  function frame(now) {
    simT += Math.min((now - last) / 1000, 0.1) * rate(); last = now;
    draw(); raf = requestAnimationFrame(frame);
  }
  let paused = false;
  function start() { if (!raf && !paused && !still && rate() > 0 && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  background.setStyle = (k) => { if (!STYLES[k]) return; styleKey = k; save("bg-style", k); stop(); apply(); };
  // Pause pendant qu'un panneau couvre l'écran : sinon l'iPhone recalcule le flou du panneau à chaque image.
  background.pause = () => { paused = true; stop(); };
  background.resume = () => { paused = false; start(); };
  background.setSpeed = (v) => { speed = Math.max(0, Math.min(100, Number(v) || 0)); save("bg-speed", speed); rate() > 0 ? start() : stop(); };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  addEventListener("resize", () => { if (!raf) draw(); });
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); canvas.classList.remove("on"); });
  apply();
}
