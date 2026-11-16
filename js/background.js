// Fond d'écran animé (même code que l'app Sport) : shaders WebGL1 « Mesh drift » et « Silk ».
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
};
const DEFAULT_STYLE = "silk", DEFAULT_SPEED = 50;

const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };

let styleKey = STYLES[pref("bg-style", DEFAULT_STYLE)] ? pref("bg-style", DEFAULT_STYLE) : DEFAULT_STYLE;
let speed = Math.max(0, Math.min(100, Number(pref("bg-speed", DEFAULT_SPEED)) || 0));

export const background = {
  styles: Object.entries(STYLES).map(([k, s]) => [k, s.label]),
  get style() { return styleKey; },
  get speed() { return speed; },
  setStyle() {}, setSpeed() {},
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
  let cur = null, uScene = null, simT = 0, last = 0, raf = 0;
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
    uScene = U("u_scene");
    draw(); start();
  }
  function draw() {
    if (!cur?.frag || !uScene) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform4f(uScene, canvas.width, canvas.height, simT, cur.colorCount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.classList.add("on");
  }
  function frame(now) {
    simT += Math.min((now - last) / 1000, 0.1) * rate(); last = now;
    draw(); raf = requestAnimationFrame(frame);
  }
  function start() { if (!raf && !still && rate() > 0 && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  background.setStyle = (k) => { if (!STYLES[k]) return; styleKey = k; save("bg-style", k); stop(); apply(); };
  background.setSpeed = (v) => { speed = Math.max(0, Math.min(100, Number(v) || 0)); save("bg-speed", speed); rate() > 0 ? start() : stop(); };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  addEventListener("resize", () => { if (!raf) draw(); });
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); canvas.classList.remove("on"); });
  apply();
}
