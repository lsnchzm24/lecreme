/* LeCreme 3D cake: the same design object as cake.js, built as a lit WebGL scene.
 *
 *   const v = LCake3D.create(container, menu, {autoRotate, interactive})
 *   v.update(design, {view: "outside" | "inside", highlight: tierIndex})
 *   LCake3D.snapshot(design, menu, width, height)  -> Promise<dataURL>   (one shared renderer)
 *
 * Units are inches, so sizes, tier heights and decorations are true to scale.
 * Realism comes from: studio lighting (image-based reflections, a soft key light with
 * shadows), rounded buttercream edges from lathe profiles, procedural normal maps for
 * spatula strokes and sponge crumb, real ridges for combed sides, glossy drips with
 * clearcoat, piped star-tip borders, and shaded fruit, roses and macarons.
 * Every piece is a group keyed like cake.js; new keys scale in, color changes glide.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ParametricGeometry } from "three/addons/geometries/ParametricGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const TAU = Math.PI * 2;
const TIER_H = { 1: 4.6, 2: 4.2, 3: 4.0 };
const SHEET = { quarter: [13, 9], half: [18, 12], full: [24, 18] };
const CUT_AT = Math.PI * 0.22, CUT_W = 1.25;            // wedge removed in the inside view
const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ helpers
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const byId = (list, id) => (list || []).find(o => o.id === id) || {};

// value noise for canvas textures
function makeNoise(seed) {
  const r = rng("noise" + seed), p = new Uint8Array(512), g = new Float32Array(256);
  for (let i = 0; i < 256; i++) { p[i] = i; g[i] = r(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  const s = t => t * t * (3 - 2 * t);
  return (x, y, wrap) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const X = n => ((n % wrap) + wrap) % wrap;
    const v = (a, b) => g[p[p[X(a) & 255] + (b & 255)]];
    const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
    const u = s(xf), w = s(yf);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
}
function fbm(n, x, y, oct, wrap) {
  let v = 0, a = .5, f = 1;
  for (let i = 0; i < oct; i++) { v += a * n(x * f, y * f, wrap * f); a *= .5; f *= 2; }
  return v;
}
function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

// height field -> tangent-space normal map
function normalMap(w, h, height, strength) {
  const c = canvas(w, h), ctx = c.getContext("2d"), img = ctx.createImageData(w, h);
  const H = (x, y) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
    img.data[i] = (-dx / l * .5 + .5) * 255; img.data[i + 1] = (dy / l * .5 + .5) * 255; img.data[i + 2] = (1 / l * .5 + .5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function tex(c, repeatX, repeatY, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX || 1, repeatY || 1);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const CACHE = new Map();
function cached(key, make) { if (!CACHE.has(key)) CACHE.set(key, make()); return CACHE.get(key); }

// buttercream: long horizontal spatula strokes plus a fine grain
function creamNormal() {
  return cached("creamN", () => {
    const w = 512, h = 256, n = makeNoise(1), n2 = makeNoise(2), hf = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      hf[y * w + x] = fbm(n, x / w * 3, y / h * 26, 3, 3) * .9 + fbm(n2, x / w * 40, y / h * 20, 2, 40) * .12;
    return tex(normalMap(w, h, hf, 2.2), 2, 1);
  });
}
function fondantNormal() {
  return cached("fondN", () => {
    const w = 256, h = 256, n = makeNoise(3), hf = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hf[y * w + x] = fbm(n, x / w * 4, y / h * 4, 2, 4);
    return tex(normalMap(w, h, hf, .9), 2, 1);
  });
}
// sponge crumb: pores as a grayscale multiplier plus matching normals
function crumb() {
  return cached("crumb", () => {
    const w = 512, h = 512, n = makeNoise(4), n2 = makeNoise(5), hf = new Float32Array(w * h);
    const c = canvas(w, h), ctx = c.getContext("2d"), img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = fbm(n, x / w * 48, y / h * 48, 2, 48), v2 = fbm(n2, x / w * 9, y / h * 9, 2, 9);
      const pore = Math.max(0, (v - .58) * 5);
      hf[y * w + x] = -pore + v2 * .3;
      const k = Math.max(.55, 1 - pore * .55 + (v2 - .5) * .12), i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = k * 255; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { map: tex(c, 3, 1, true), normal: tex(normalMap(w, h, hf, 3), 3, 1) };
  });
}
// sides of a naked / semi-naked tier, and the cut face: real stripes in the chosen colors
function layersCanvas(sponge, fill, frost, mode, w, h) {
  const c = canvas(w, h), ctx = c.getContext("2d");
  const layers = [["s", .3], ["f", .07], ["s", .3], ["f", .07], ["s", .26]];
  const shell = mode === "cut" ? .045 : 0;
  let y = h;
  ctx.fillStyle = sponge; ctx.fillRect(0, 0, w, h);
  const r = rng("layers" + sponge + fill);
  layers.forEach(([k, frac]) => {
    const hh = h * (1 - shell) * frac;
    if (k === "f") {
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += w / 24) ctx.lineTo(x, y - hh - (r() - .5) * h * .012);
      ctx.lineTo(w, y); ctx.closePath(); ctx.fill();
    } else {
      const g = ctx.createLinearGradient(0, y - hh, 0, y);
      g.addColorStop(0, "rgba(90,45,20,.18)"); g.addColorStop(.12, "rgba(90,45,20,0)"); g.addColorStop(.9, "rgba(90,45,20,0)"); g.addColorStop(1, "rgba(90,45,20,.12)");
      ctx.fillStyle = g; ctx.fillRect(0, y - hh, w, hh);
    }
    y -= hh;
  });
  if (mode === "semi") {
    // a scraped veil: frosting everywhere, thinner in horizontal streaks
    const n = makeNoise(7);
    const img = ctx.getImageData(0, 0, w, h), fr = new THREE.Color(frost);
    const R = fr.r * 255, G = fr.g * 255, B = fr.b * 255;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const a = Math.min(1, Math.max(0, .55 + (fbm(n, xx / w * 5, yy / h * 30, 3, 5) - .5) * 2.4));
      const i = (yy * w + xx) * 4;
      img.data[i] += (R - img.data[i]) * a; img.data[i + 1] += (G - img.data[i + 1]) * a; img.data[i + 2] += (B - img.data[i + 2]) * a;
    }
    ctx.putImageData(img, 0, 0);
  }
  if (mode === "cut") {
    ctx.fillStyle = frost; ctx.fillRect(w * .955, 0, w * .045, h); ctx.fillRect(0, 0, w, h * shell);
  }
  return c;
}
function textCanvas(text, font, w, h, fill) {
  const c = canvas(w, h), ctx = c.getContext("2d");
  let size = h * .8;
  ctx.font = `${font.replace("SIZE", size)}`;
  while (ctx.measureText(text).width > w * .94 && size > 10) { size -= 4; ctx.font = font.replace("SIZE", size); }
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = fill || "#fff";
  ctx.fillText(text, w / 2, h * .56);
  return c;
}
function glowTexture() {
  return cached("glow", () => {
    const c = canvas(128, 128), ctx = c.getContext("2d"), g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,220,140,.95)"); g.addColorStop(.25, "rgba(255,170,70,.45)"); g.addColorStop(1, "rgba(255,150,40,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  });
}
function seedTexture() {
  return cached("seeds", () => {
    const w = 256, h = 256, c = canvas(w, h), ctx = c.getContext("2d"), hf = new Float32Array(w * h);
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#E3263F"); g.addColorStop(.7, "#C8152E"); g.addColorStop(1, "#F2E6B8");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    for (let row = 0; row < 12; row++) for (let k = 0; k < 14; k++) {
      const x = (k + (row % 2) * .5) / 14 * w, y = (row + .5) / 12 * h * .85;
      ctx.fillStyle = "#F7D774"; ctx.beginPath(); ctx.ellipse(x, y, 2.6, 3.6, 0, 0, TAU); ctx.fill();
      for (let yy = -6; yy <= 6; yy++) for (let xx = -6; xx <= 6; xx++) {
        const d = Math.hypot(xx, yy); if (d < 6) { const X = Math.round(x + xx), Y = Math.round(y + yy); if (X >= 0 && X < w && Y >= 0 && Y < h) hf[Y * w + X] = -(1 - d / 6); }
      }
    }
    return { map: tex(c, 1, 1, true), normal: tex(normalMap(w, h, hf, 2.5), 1, 1) };
  });
}
function stripeTexture(hex) {
  return cached("stripe" + hex, () => {
    const c = canvas(64, 256), ctx = c.getContext("2d");
    ctx.fillStyle = hex; ctx.fillRect(0, 0, 64, 256);
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 9;
    for (let y = -64; y < 320; y += 36) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(64, y + 32); ctx.stroke(); }
    return tex(c, 1, 1, true);
  });
}

// ------------------------------------------------------------------ geometry
function tierLathe(R, H, mode) {
  // side: bottom -> up the wall (ridged when combed); top: rounded crown -> center
  const c = Math.min(.32, R * .08), side = [], top = [];
  side.push(new THREE.Vector2(R - .04, 0));
  const steps = mode === "combed" ? 90 : 12;
  for (let i = 0; i <= steps; i++) {
    const y = .02 + (H - c - .02) * i / steps;
    const ridge = mode === "combed" ? .075 * Math.max(0, Math.sin(y / .36 * TAU)) ** .7 : 0;
    side.push(new THREE.Vector2(R + ridge, y));
  }
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI / 2;
    top.push(new THREE.Vector2(R - c + Math.cos(a) * c, H - c + Math.sin(a) * c));
  }
  top.push(new THREE.Vector2(R * .5, H - .01), new THREE.Vector2(0, H - .02));
  return { side: new THREE.LatheGeometry(side, 128), top: new THREE.LatheGeometry(top, 128) };
}
function cutLathe(geo) {
  // remove the wedge facing the viewer (for the inside view) by dropping its triangles
  const pos = geo.attributes.position, idx = geo.index ? geo.index.array : null;
  if (!idx) return geo;
  const keep = [];
  const ang = i => Math.atan2(pos.getX(i), pos.getZ(i));
  const inCut = a => { let d = Math.atan2(Math.sin(a - CUT_AT), Math.cos(a - CUT_AT)); return Math.abs(d) < CUT_W / 2 - .001; };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    if (Math.hypot(cx, cz) < .05 || !inCut(Math.atan2(cx, cz))) keep.push(a, b, c);
  }
  void ang;
  geo.setIndex(keep);
  return geo;
}
// a piped star-tip kiss: wide base, swelling body, twisted ridges, pointed tip
function kissGeometry(R, Hh, twist, ridges) {
  return new ParametricGeometry((u, v, target) => {
    const t = u, a = v * TAU;
    const body = R * Math.pow(1 - t, .62) * (1 + .3 * Math.sin(Math.PI * Math.min(t * 1.25, 1)));
    const r = body * (1 + .13 * Math.cos(ridges * (a + twist * t)));
    target.set(Math.cos(a) * r, Hh * t, Math.sin(a) * r);
  }, 40, 14);
}
function placed(geo, m) { const g = geo.clone(); g.applyMatrix4(m); return g; }
const M4 = () => new THREE.Matrix4();
function compose(pos, quat, scale) { return M4().compose(pos, quat, scale || new THREE.Vector3(1, 1, 1)); }
function quatY(a) { return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a); }

// points around a tier's edge with an outward normal; skips the cut wedge in the inside view
function perimeter(t, count, cut, inset) {
  const out = [];
  inset = inset || 0;
  if (!t.sq) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      if (cut && Math.abs(Math.atan2(Math.sin(a - CUT_AT), Math.cos(a - CUT_AT))) < CUT_W / 2 + .08) continue;
      out.push({ x: Math.sin(a) * (t.R - inset), z: Math.cos(a) * (t.R - inset), a });
    }
    return out;
  }
  const hw = t.W / 2 - inset, hd = t.D / 2 - inset, per = 2 * (t.W + t.D);
  for (let i = 0; i < count; i++) {
    let s = (i / count) * per, p;
    if (s < t.W) p = { x: -hw + s / t.W * 2 * hw, z: hd, a: 0 };
    else if ((s -= t.W) < t.D) p = { x: hw, z: hd - s / t.D * 2 * hd, a: Math.PI / 2 };
    else if ((s -= t.D) < t.W) p = { x: hw - s / t.W * 2 * hw, z: -hd, a: Math.PI };
    else { s -= t.W; p = { x: -hw, z: -hd + s / t.D * 2 * hd, a: -Math.PI / 2 }; }
    if (cut && p.a === 0 && p.x > 0) continue;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- materials
function frostMat(color, finish) {
  const m = new THREE.MeshPhysicalMaterial({ color, roughness: finish === "fondant" ? .42 : .6, sheen: .35, sheenRoughness: .7, sheenColor: new THREE.Color("#ffffff") });
  if (finish === "fondant") { m.normalMap = fondantNormal(); m.normalScale.set(.25, .25); m.clearcoat = .18; m.clearcoatRoughness = .5; }
  else { m.normalMap = creamNormal(); m.normalScale.set(.55, .55); }
  return m;
}
const DRIPS = {
  chocolate: { color: "#3A1A10", roughness: .16, clearcoat: 1 },
  caramel: { color: "#A8571A", roughness: .08, clearcoat: 1, transmission: .25, thickness: .4 },
  white: { color: "#F6EBD6", roughness: .22, clearcoat: .8 },
  pink: { color: "#E06B86", roughness: .18, clearcoat: 1 },
  gold: { color: "#D9AE4E", roughness: .26, metalness: 1, clearcoat: .4 },
};
const GOLD = () => new THREE.MeshPhysicalMaterial({ color: "#E2B858", metalness: 1, roughness: .24, clearcoat: .5 });
const PEARL = () => new THREE.MeshPhysicalMaterial({ color: "#F8F2EF", roughness: .22, clearcoat: 1, iridescence: .7, iridescenceIOR: 1.6, sheen: .4 });

// ------------------------------------------------------------------- the scene
let SHARED = null;      // one renderer for snapshots
const viewers = new Set();

function makeRenderer(canvasEl, alpha) {
  const r = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha, preserveDrawingBuffer: !canvasEl });
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  r.setClearColor(0x000000, 0);
  return r;
}
function makeScene(renderer) {
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
  scene.environmentIntensity = .62;
  const key = new THREE.DirectionalLight("#fff4ea", 2.3);
  key.position.set(-14, 26, 18);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -20; key.shadow.camera.right = key.shadow.camera.top = 20;
  key.shadow.camera.near = 1; key.shadow.camera.far = 80;
  key.shadow.radius = 6; key.shadow.bias = -.0004; key.shadow.normalBias = .02;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#ffd9e2", .9); rim.position.set(16, 14, -18); scene.add(rim);
  scene.add(new THREE.HemisphereLight("#fff6f2", "#5e0f25", .35));
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: .22 }));
  catcher.rotation.x = -Math.PI / 2; catcher.position.y = -4.02; catcher.receiveShadow = true;
  scene.add(catcher); scene.userData.catcher = catcher;
  return scene;
}

function layout(d) {
  if (d.shape === "sheet") {
    const [W, D] = SHEET[d.size] || SHEET.quarter;
    return [{ i: 0, sq: true, sheet: true, W, D, R: Math.max(W, D) / 2, H: 3, y: 0 }];
  }
  const n = d.tiers || 1, bottom = parseInt(d.size, 10) || 8, H = TIER_H[n];
  return Array.from({ length: n }, (_, i) => {
    const size = bottom - 2 * i;
    return { i, sq: d.shape === "square", W: size, D: size, R: size / 2, H, y: i * H };
  });
}

// ------------------------------------------------------------------ builders
function buildCake(d, m, opts, track) {
  const view = opts.view || "outside", cut = view === "inside";
  const root = new THREE.Group();
  const pieces = new Map();
  const add = (key, obj) => { obj.userData.key = key; obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); root.add(obj); pieces.set(key, obj); return obj; };
  const T = (geo) => { track.geo.push(geo); return geo; };
  const Mt = (mat) => { track.mat.push(mat); return mat; };
  const mesh = (geo, mat) => new THREE.Mesh(T(geo), Mt(mat));

  const frostHex = d.color === "custom" && d.custom_hex ? d.custom_hex : (byId(m.colors, d.color).hex || "#FBF3E4");
  const frost = new THREE.Color(frostHex);
  const tiers = layout(d);
  const naked = d.finish === "naked", semi = d.finish === "seminaked";
  const pipeColor = naked ? new THREE.Color("#FFF8EE") : frost.clone().lerp(new THREE.Color("#ffffff"), .08);

  // ---- stand or board
  const base = tiers[0];
  if (base.sheet) {
    add("board-sheet-" + base.W, board(base.W + 2, base.D + 2, true, T, Mt));
  } else {
    const R = base.R + 1.6;
    const prof = [[0, -4], [3.4, -4], [3.6, -3.85], [3.2, -3.6], [1.1, -3.2], [.9, -1.4], [1.2, -.9], [R - .4, -.62], [R, -.42], [R + .05, -.3], [R - .05, -.2], [0, -.18]]
      .map(([x, y]) => new THREE.Vector2(x, y));
    const stand = mesh(new THREE.LatheGeometry(prof, 128), new THREE.MeshPhysicalMaterial({ color: "#FBF8F8", roughness: .18, clearcoat: .8, clearcoatRoughness: .15 }));
    const g = new THREE.Group(); g.add(stand);
    g.add(board(base.R + .55, null, false, T, Mt));
    add("stand-" + base.W, g);
  }

  // ---- tiers
  tiers.forEach((t, i) => {
    const fl = byId(m.flavors, d.flavors[i]), fi = byId(m.fillings, d.fillings[i]);
    const k = `tier-${i}-${d.shape}-${t.W}`;
    const g = new THREE.Group(); g.position.y = t.y;
    let sideMat, topMat;
    if (naked || semi) {
      const lc = layersCanvas(fl.color || "#F3DDA8", fi.color || "#FFF4DD", frostHex, semi ? "semi" : "naked", 512, 512);
      const cr = crumb();
      sideMat = Mt(new THREE.MeshPhysicalMaterial({ map: track.tex(tex(lc, t.sq ? 1 : 3, 1, true)), normalMap: cr.normal, normalScale: new THREE.Vector2(semi ? .4 : .9, semi ? .4 : .9), roughness: semi ? .7 : .88, sheen: .2 }));
      sideMat.map.repeat.set(t.sq ? 1 : 3, 1);
      topMat = naked ? Mt(new THREE.MeshPhysicalMaterial({ color: new THREE.Color(fl.color || "#F3DDA8").lerp(new THREE.Color("#fff"), .08), map: cr.map, normalMap: cr.normal, roughness: .9 }))
        : Mt(frostMat(frost, "smooth"));
    } else {
      sideMat = topMat = Mt(frostMat(frost, d.finish));
      track.frost.push(sideMat);
    }
    if (t.sq) {
      const box = mesh(new RoundedBoxGeometry(t.W, t.H, t.D, 4, Math.min(.35, t.H * .1)), sideMat);
      box.position.y = t.H / 2;
      if (d.finish === "textured") ridgeBox(box.geometry, t);
      g.add(box);
      if (cut) g.add(cutFaceSquare(t, fl, fi, frostHex, naked, T, Mt, track));
    } else {
      const L = tierLathe(t.R, t.H, d.finish === "textured" ? "combed" : "smooth");
      if (cut) { cutLathe(L.side); cutLathe(L.top); }
      g.add(new THREE.Mesh(T(L.side), sideMat), new THREE.Mesh(T(L.top), topMat));
      if (cut) g.add(cutFacesRound(t, fl, fi, frostHex, naked, T, Mt, track));
    }
    if (opts.highlight === i && cut) {
      const ring = mesh(new THREE.TorusGeometry(t.R + .35, .05, 8, 96), new THREE.MeshBasicMaterial({ color: "#C9A24A" }));
      ring.rotation.x = Math.PI / 2; ring.position.y = .05; g.add(ring);
    }
    add(k, g);

    if (d.drip !== "none") add(`drip-${d.drip}-${k}-${cut}`, drip(t, d.drip, cut, T, Mt));
    if (d.border !== "none") add(`border-${d.border}-${k}-${cut}`, borders(t, d.border, pipeColor, cut, T, Mt, track, i === tiers.length - 1));
    ["goldleaf", "pearls", "sprinkles"].forEach(x => { if (d.decor.includes(x)) add(`${x}-${k}-${cut}`, sideDecor(t, x, cut, T, Mt)); });
    if (i === 0 && d.decor.includes("bow")) add(`bow-${k}-${cut}`, bow(t, cut, T, Mt));
    if (i === 0 && d.message && !cut) add(`msg-${d.message}-${k}`, pipedMessage(t, d.message, frost, T, Mt, track));
    if (i < tiers.length - 1) {
      const ledge = d.decor.filter(x => ["flowers", "berries", "macarons"].includes(x)).slice(0, 2);
      if (ledge.length) add(`ledge-${ledge.join("")}-${k}-${cut}`, ledgeCluster(t, tiers[i + 1], ledge, cut, T, Mt));
    }
  });

  const top = tiers[tiers.length - 1];
  const tk = `top-${tiers.length}-${d.shape}-${top.W}-${cut}`;
  const ty = top.y + top.H + (d.drip !== "none" ? .1 : 0);
  if (d.decor.includes("sprinkles")) add(`sprtop-${tk}`, sprinkleTop(top, ty, cut, T, Mt));
  if (d.decor.includes("goldleaf")) add(`goldtop-${tk}`, goldTop(top, ty, cut, T, Mt));
  ["shards", "macarons", "berries", "flowers", "candles"].filter(x => d.decor.includes(x))
    .forEach(x => add(`${x}-${tk}`, topCluster(x, top, ty, cut, T, Mt, track)));
  if (d.topper === "script" && d.topper_text) add(`topper-s-${d.topper_text}-${tk}`, scriptTopper(top, ty, d.topper_text, T, Mt, track));
  if (d.topper === "number" && d.number) add(`topper-n-${d.number}-${tk}`, numberTopper(top, ty, d.number, T, Mt, track));
  return { root, pieces, tiers, top: ty };
}

function board(Wd, Dd, rect, T, Mt) {
  // gold scalloped cake board, like the ones under real bakery cakes
  const shape = new THREE.Shape();
  if (rect) {
    const w = Wd / 2, h = Dd / 2, s = .55;
    shape.moveTo(-w, -h);
    const edge = (x0, y0, x1, y1) => { const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.round(L / s)); for (let k = 1; k <= n; k++) { const mx = x0 + (x1 - x0) * (k - .5) / n, my = y0 + (y1 - y0) * (k - .5) / n; const nx = (y1 - y0) / L, ny = -(x1 - x0) / L; shape.quadraticCurveTo(mx + nx * .18, my + ny * .18, x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n); } };
    edge(-w, -h, w, -h); edge(w, -h, w, h); edge(w, h, -w, h); edge(-w, h, -w, -h);
  } else {
    const R = Wd, n = Math.round(TAU * R / .55);
    shape.moveTo(R, 0);
    for (let k = 0; k < n; k++) {
      const a0 = k / n * TAU, a1 = (k + 1) / n * TAU, am = (a0 + a1) / 2;
      shape.quadraticCurveTo(Math.cos(am) * (R + .34), Math.sin(am) * (R + .34), Math.cos(a1) * R, Math.sin(a1) * R);
    }
  }
  const geo = T(new THREE.ExtrudeGeometry(shape, { depth: .08, bevelEnabled: true, bevelThickness: .02, bevelSize: .02, bevelSegments: 1, curveSegments: 4 }));
  geo.rotateX(-Math.PI / 2); geo.translate(0, rect ? -.1 : -.16, 0);
  const n = makeNoise(9), hf = new Float32Array(128 * 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) hf[y * 128 + x] = fbm(n, x / 128 * 10, y / 128 * 10, 3, 10);
  const nm = cached("foilN", () => tex(normalMap(128, 128, hf, 3), 6, 6));
  const mesh = new THREE.Mesh(geo, Mt(new THREE.MeshPhysicalMaterial({ color: "#E8C15A", metalness: 1, roughness: .3, normalMap: nm, normalScale: new THREE.Vector2(.5, .5) })));
  return mesh;
}

function ridgeBox(geo, t) {
  const p = geo.attributes.position, nrm = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(nrm.getY(i)) > .5) continue;
    const y = p.getY(i) + t.H / 2;
    if (y < .05 || y > t.H - .3) continue;
    const r = .07 * Math.max(0, Math.sin(y / .36 * TAU)) ** .7;
    p.setXYZ(i, p.getX(i) + nrm.getX(i) * r, p.getY(i), p.getZ(i) + nrm.getZ(i) * r);
  }
  p.needsUpdate = true; geo.computeVertexNormals();
}

function cutFacesRound(t, fl, fi, frostHex, naked, T, Mt, track) {
  const c = layersCanvas(fl.color || "#F3DDA8", fi.color || "#FFF4DD", naked ? (fl.color || "#F3DDA8") : frostHex, "cut", 512, 512);
  const cr = crumb();
  const mat = Mt(new THREE.MeshPhysicalMaterial({ map: track.tex(tex(c, 1, 1, true)), normalMap: cr.normal, normalScale: new THREE.Vector2(.8, .8), roughness: .85, side: THREE.DoubleSide }));
  mat.map.repeat.set(1, 1);
  const g = new THREE.Group();
  [CUT_AT - CUT_W / 2, CUT_AT + CUT_W / 2].forEach((a, k) => {
    const geo = T(new THREE.PlaneGeometry(t.R, t.H - .02));
    geo.translate(t.R / 2, (t.H - .02) / 2, 0);
    const pl = new THREE.Mesh(geo, mat);
    pl.rotation.y = a - Math.PI / 2;
    if (k === 1) pl.scale.z = -1;
    g.add(pl);
  });
  return g;
}
function cutFaceSquare(t, fl, fi, frostHex, naked, T, Mt, track) {
  const c = layersCanvas(fl.color || "#F3DDA8", fi.color || "#FFF4DD", naked ? (fl.color || "#F3DDA8") : frostHex, "cut", 512, 512);
  const ctx = c.getContext("2d"); ctx.fillStyle = naked ? fl.color : frostHex; ctx.fillRect(0, 0, 512 * .045, 512);
  const cr = crumb();
  const mat = Mt(new THREE.MeshPhysicalMaterial({ map: track.tex(tex(c, 1, 1, true)), normalMap: cr.normal, roughness: .85 }));
  const pl = new THREE.Mesh(T(new THREE.PlaneGeometry(t.W - .1, t.H - .1)), mat);
  pl.position.set(0, t.H / 2, t.D / 2 + .03);
  return pl;
}

function drip(t, kind, cut, T, Mt) {
  const spec = DRIPS[kind] || DRIPS.chocolate;
  const r = rng("drip" + t.W + t.i + kind);
  const parts = [];
  const per = t.sq ? 2 * (t.W + t.D) : TAU * t.R;
  perimeter(t, Math.round(per / .5), cut).forEach(p => {
    const long = r() > .3, L = long ? .45 + Math.pow(r(), 1.4) * t.H * .48 : .06 + r() * .25, w = .3 + r() * .2;
    const g = new THREE.CapsuleGeometry(w / 2, L, 6, 14);
    const gp = g.attributes.position;
    for (let v = 0; v < gp.count; v++) {                       // swell into a bead near the bottom
      const yy = gp.getY(v), k = 1 + .32 * Math.exp(-Math.pow((yy + L / 2 - .02) / (w * .55), 2));
      gp.setX(v, gp.getX(v) * k); gp.setZ(v, gp.getZ(v) * k);
    }
    g.computeVertexNormals();
    g.translate(0, -L / 2 + .06, 0); g.scale(1, 1, .5);
    const out = t.sq ? new THREE.Vector3(Math.sin(p.a), 0, Math.cos(p.a)) : new THREE.Vector3(p.x, 0, p.z).normalize();
    const pos = new THREE.Vector3(p.x, t.y + t.H - .1, p.z).addScaledVector(out, .07);
    parts.push(placed(g, compose(pos, quatY(Math.atan2(out.x, out.z)))));
    g.dispose();
  });
  // the pool on top, with a soft rounded lip that spills over the edge
  let pool;
  if (t.sq) {
    pool = new RoundedBoxGeometry(t.W + .16, .3, t.D + .16, 4, .13); pool.translate(0, t.y + t.H - .03, 0);
  } else {
    const R = t.R + .06, prof = [new THREE.Vector2(R - .02, -.18), new THREE.Vector2(R + .03, -.1), new THREE.Vector2(R + .02, .02), new THREE.Vector2(R - .12, .1), new THREE.Vector2(R * .6, .12), new THREE.Vector2(0, .12)];
    pool = new THREE.LatheGeometry(prof, 128); pool.translate(0, t.y + t.H, 0);
    if (cut) cutLathe(pool);
  }
  parts.push(pool.index ? pool.toNonIndexed() : pool);
  const geo = T(mergeGeometries(parts.map(p => (p.index ? p.toNonIndexed() : p)), false));
  parts.forEach(p => p.dispose());
  return new THREE.Mesh(geo, Mt(new THREE.MeshPhysicalMaterial(Object.assign({ clearcoatRoughness: .08 }, spec, { color: new THREE.Color(spec.color) }))));
}

function borders(t, kind, color, cut, T, Mt, track, isTop) {
  const g = new THREE.Group();
  const mat = Mt(new THREE.MeshPhysicalMaterial({ color, roughness: .55, sheen: .3, normalMap: creamNormal(), normalScale: new THREE.Vector2(.3, .3) }));
  track.frost.push(mat);
  const per = t.sq ? 2 * (t.W + t.D) : TAU * t.R;
  if (kind === "pearls") {
    const pts = perimeter(t, Math.round(per / .36), cut);
    const im = new THREE.InstancedMesh(T(new THREE.SphereGeometry(.17, 20, 14)), Mt(PEARL()), pts.length);
    pts.forEach((p, i) => im.setMatrixAt(i, compose(new THREE.Vector3(p.x, t.y + .15, p.z).multiplyScalar(1).add(t.sq ? new THREE.Vector3(Math.sin(p.a) * .1, 0, Math.cos(p.a) * .1) : new THREE.Vector3(p.x, 0, p.z).normalize().multiplyScalar(.08)), new THREE.Quaternion())));
    g.add(im);
    return g;
  }
  const kiss = kind === "rosettes" ? kissGeometry(.42, .5, 3.2, 7) : kissGeometry(.3, .52, .5, 8);
  const parts = [];
  const place = (pts, y, scale, tilt) => pts.forEach(p => {
    const out = t.sq ? new THREE.Vector3(Math.sin(p.a), 0, Math.cos(p.a)) : new THREE.Vector3(p.x, 0, p.z).normalize();
    const q = quatY(Math.atan2(out.x, out.z));
    if (tilt) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt));
    parts.push(placed(kiss, compose(new THREE.Vector3(p.x, y, p.z), q, new THREE.Vector3(scale, scale, scale))));
  });
  if (kind === "shells") {
    place(perimeter(t, Math.round(per / .42), cut, -.12), t.y + .1, 1, 1.15);
  } else {
    // rosettes: a crown of star kisses around the top edge (like a classic piped top) and a small base row
    place(perimeter(t, Math.round(per / .82), cut, .42), t.y + t.H - .04, 1, 0);
    place(perimeter(t, Math.round(per / .6), cut, -.1), t.y + .08, .62, 1.1);
  }
  kiss.dispose();
  if (parts.length) g.add(new THREE.Mesh(T(mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p))), mat));
  parts.forEach(p => p.dispose());
  void isTop;
  return g;
}

function sideDecor(t, kind, cut, T, Mt) {
  const r = rng(kind + t.W + t.i), g = new THREE.Group();
  const onSide = (yLo, yHi) => {
    const a = r() * TAU;
    if (cut && Math.abs(Math.atan2(Math.sin(a - CUT_AT), Math.cos(a - CUT_AT))) < CUT_W / 2 + .1) return null;
    if (t.sq) { const face = Math.floor(r() * 4), s = (r() - .5) * .9; const fa = face * Math.PI / 2; const n = new THREE.Vector3(Math.sin(fa), 0, Math.cos(fa)); const tan = new THREE.Vector3(n.z, 0, -n.x); return { pos: n.clone().multiplyScalar(t.W / 2 + .02).addScaledVector(tan, s * t.W).setY(t.y + yLo + r() * (yHi - yLo)), n }; }
    const n = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    return { pos: n.clone().multiplyScalar(t.R + .02).setY(t.y + yLo + r() * (yHi - yLo)), n };
  };
  if (kind === "pearls") {
    const count = Math.round((t.sq ? t.W * 4 : TAU * t.R) * 3.2), mats = [];
    const im = new THREE.InstancedMesh(T(new THREE.SphereGeometry(.07, 12, 8)), Mt(PEARL()), count);
    let k = 0;
    for (let i = 0; i < count; i++) { const s = onSide(.3, t.H - .3); if (!s) continue; const sc = .6 + r() * .8; im.setMatrixAt(k++, compose(s.pos, new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc))); }
    im.count = k; g.add(im); void mats;
  } else if (kind === "sprinkles") {
    const cols = ["#E9548A", "#4FB0E2", "#F4C94A", "#86CC82", "#ffffff", "#B47EDB"];
    const count = Math.round((t.sq ? t.W * 4 : TAU * t.R) * 5);
    const im = new THREE.InstancedMesh(T(new THREE.CapsuleGeometry(.028, .13, 3, 6)), Mt(new THREE.MeshPhysicalMaterial({ roughness: .35, clearcoat: .6 })), count);
    let k = 0;
    for (let i = 0; i < count; i++) {
      const s = onSide(t.H * .45, t.H - .2); if (!s) continue;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(r() - .5, r() - .5, r() - .5).normalize());
      im.setMatrixAt(k, compose(s.pos, q)); im.setColorAt(k++, new THREE.Color(cols[i % cols.length]));
    }
    im.count = k; g.add(im);
  } else if (kind === "goldleaf") {
    const mat = Mt(GOLD()); mat.side = THREE.DoubleSide;
    for (let i = 0; i < Math.round((t.sq ? t.W * 4 : TAU * t.R) / 2.2); i++) {
      const s = onSide(.5, t.H - .5); if (!s) continue;
      const geo = T(new THREE.PlaneGeometry(.35 + r() * .5, .3 + r() * .4, 4, 4));
      const p = geo.attributes.position;
      for (let v = 0; v < p.count; v++) p.setZ(v, (r() - .5) * .05);
      geo.computeVertexNormals();
      const leaf = new THREE.Mesh(geo, mat);
      leaf.position.copy(s.pos).addScaledVector(s.n, .01);
      leaf.lookAt(s.pos.clone().addScaledVector(s.n, 2)); leaf.rotateZ(r() * TAU);
      g.add(leaf);
    }
  }
  return g;
}

function bow(t, cut, T, Mt) {
  const g = new THREE.Group();
  const satin = Mt(new THREE.MeshPhysicalMaterial({ color: "#7A1A35", roughness: .32, sheen: 1, sheenColor: new THREE.Color("#E58AA3"), sheenRoughness: .35, clearcoat: .3 }));
  if (t.sq) {
    const band = new THREE.Mesh(T(new RoundedBoxGeometry(t.W + .08, .7, t.D + .08, 2, .05)), satin); band.position.y = .55; g.add(band);
  } else {
    const geo = T(new THREE.CylinderGeometry(t.R + .03, t.R + .03, .7, 128, 1, true));
    if (cut) cutLathe(geo);
    const band = new THREE.Mesh(geo, satin); band.position.y = .55; g.add(band);
  }
  const front = new THREE.Group(); front.position.set(0, .7, (t.sq ? t.D / 2 : t.R) + .15);
  [-1, 1].forEach(s => {
    const loop = new THREE.Mesh(T(new THREE.TorusGeometry(.48, .16, 14, 40)), satin);
    loop.scale.set(1, .6, .45); loop.position.x = s * .5; loop.rotation.z = s * .25; front.add(loop);
    const tail = new THREE.Mesh(T(new THREE.BoxGeometry(.3, 1, .05)), satin);
    tail.position.set(s * .22, -.55, 0); tail.rotation.z = s * .35; front.add(tail);
  });
  const knot = new THREE.Mesh(T(new THREE.SphereGeometry(.2, 20, 14)), satin); knot.scale.set(1, 1.15, .7); front.add(knot);
  g.add(front);
  g.position.y = t.y;
  return g;
}

function pipedMessage(t, text, frost, T, Mt, track) {
  const ink = frost.getHSL({ h: 0, s: 0, l: 0 }).l > .55 ? "#5E0F25" : "#FFF7F8";
  const c = textCanvas(text, "SIZEpx Pinyon, 'Pinyon Script', cursive", 1024, 200, ink);
  const hc = canvas(256, 50), hctx = hc.getContext("2d"); hctx.filter = "blur(1.5px)"; hctx.drawImage(c, 0, 0, 256, 50);
  const data = hctx.getImageData(0, 0, 256, 50).data, hf = new Float32Array(256 * 50);
  for (let i = 0; i < hf.length; i++) hf[i] = data[i * 4 + 3] / 255;
  const mat = Mt(new THREE.MeshPhysicalMaterial({ map: track.tex(tex(c, 1, 1, true)), transparent: true, alphaTest: .25, roughness: .5, normalMap: track.tex(tex(normalMap(256, 50, hf, 3), 1, 1)), normalScale: new THREE.Vector2(1.2, 1.2) }));
  mat.map.repeat.set(1, 1); mat.normalMap.repeat.set(1, 1); mat.map.wrapS = mat.map.wrapT = THREE.ClampToEdgeWrapping;
  const hgt = Math.min(1.1, t.H * .26);
  let geo;
  if (t.sq) { geo = T(new THREE.PlaneGeometry(t.W * .8, hgt)); geo.translate(0, 0, t.D / 2 + .02); }
  else { const span = Math.min(2.2, (t.W * .82) / t.R); geo = T(new THREE.CylinderGeometry(t.R + .02, t.R + .02, hgt, 64, 1, true, -span / 2, span)); }
  const msh = new THREE.Mesh(geo, mat);
  msh.position.y = t.y + t.H * .5;
  msh.castShadow = false;
  return msh;
}

// ---------------------------------------------------------------- toppings
function strawberry(T, Mt) {
  return cached("strawGeo", () => {
    const geo = new THREE.SphereGeometry(.5, 32, 24);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / .5, k = .48 + .52 * Math.pow((y + 1) / 2, .55);
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * 1.2 - (y > .8 ? (y - .8) * .25 : 0), p.getZ(i) * k);
    }
    geo.computeVertexNormals();
    return geo;
  });
}
function addStrawberry(g, pos, s, rot, Mt) {
  const st = seedTexture();
  const mat = cached("strawMat", () => new THREE.MeshPhysicalMaterial({ map: st.map, normalMap: st.normal, roughness: .3, clearcoat: .7, clearcoatRoughness: .2, sheen: .3 }));
  const leafMat = cached("leafMat", () => new THREE.MeshPhysicalMaterial({ color: "#5C8A3E", roughness: .55, side: THREE.DoubleSide }));
  const b = new THREE.Group();
  b.add(new THREE.Mesh(strawberry(), mat));
  const calyx = cached("calyxGeo", () => { const parts = []; for (let k = 0; k < 6; k++) { const c = new THREE.ConeGeometry(.08, .42, 4); c.rotateZ(Math.PI / 2); c.scale(1, .3, 1); c.translate(.2, .58, 0); c.rotateY(k / 6 * TAU); parts.push(c.toNonIndexed()); } return mergeGeometries(parts); });
  b.add(new THREE.Mesh(calyx, leafMat));
  b.position.copy(pos); b.scale.setScalar(s); b.rotation.set(rot * .3 - .5, rot * 5, rot * .2);
  g.add(b);
}
function addBlueberry(g, pos, s) {
  const geo = cached("blueGeo", () => new THREE.SphereGeometry(.24, 24, 18));
  const mat = cached("blueMat", () => new THREE.MeshPhysicalMaterial({ color: "#232B66", roughness: .55, sheen: 1, sheenColor: new THREE.Color("#9FAAD8"), sheenRoughness: .45 }));
  const crown = cached("crownGeo", () => new THREE.TorusGeometry(.06, .025, 6, 10));
  const b = new THREE.Group(); b.add(new THREE.Mesh(geo, mat));
  const c = new THREE.Mesh(crown, cached("crownMat", () => new THREE.MeshStandardMaterial({ color: "#151a3a", roughness: .8 }))); c.rotation.x = Math.PI / 2; c.position.y = .23; b.add(c);
  b.position.copy(pos).setY(pos.y + .2 * s); b.scale.setScalar(s); g.add(b);
}
function addRaspberry(g, pos, s) {
  const geo = cached("raspGeo", () => {
    const parts = [], d = new THREE.SphereGeometry(.085, 10, 8);
    for (let row = 0; row < 6; row++) {
      const yy = row * .085, rad = .26 * Math.sin(Math.PI * (row + 1) / 7) + .04, n = Math.max(3, Math.round(rad * 30));
      for (let k = 0; k < n; k++) { const a = k / n * TAU + row * .4; parts.push(placed(d, compose(new THREE.Vector3(Math.cos(a) * rad, yy, Math.sin(a) * rad), new THREE.Quaternion())).toNonIndexed()); }
    }
    d.dispose();
    return mergeGeometries(parts);
  });
  const mat = cached("raspMat", () => new THREE.MeshPhysicalMaterial({ color: "#B3123A", roughness: .3, clearcoat: .8, sheen: .6, sheenColor: new THREE.Color("#FF8FA8") }));
  const m = new THREE.Mesh(geo, mat); m.position.copy(pos); m.scale.setScalar(s); m.rotation.x = -.25; g.add(m);
}
const ROSE_PAL = { blush: ["#B8526B", "#F2B4C2"], white: ["#E8D9DA", "#FFFFFF"], wine: ["#3E0614", "#9A2A4A"], peach: ["#D27A48", "#FAD1B4"] };
function roseGeo(pal) {
  return cached("rose-" + pal, () => {
    const [c0, c1] = ROSE_PAL[pal].map(h => new THREE.Color(h));
    const parts = [];
    const N = 34;
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1), w = .2 + f * .5, h = .26 + f * .36;
      const geo = new THREE.PlaneGeometry(w, h, 8, 8);
      const p = geo.attributes.position, colors = [];
      for (let v = 0; v < p.count; v++) {
        const x = p.getX(v) / w, y = p.getY(v) / h + .5;
        const width = Math.sin(Math.PI * Math.min(1, .25 + y * .8)) ** .7;          // narrow base, round top
        const xx = x * width * w;
        const z = -(x * x) * w * (1.1 - f * .5) * width + y * y * h * (.15 + f * .55);  // cupped, lip rolls out
        p.setXYZ(v, xx, p.getY(v), z);
        const k = Math.min(1, y * .8 + .2) * (.75 + f * .25); const cc = c0.clone().lerp(c1, k); colors.push(cc.r, cc.g, cc.b);
      }
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geo.translate(0, h / 2, 0);
      geo.rotateX(-(.08 + Math.pow(f, 1.3) * 1.25));
      geo.translate(0, 0, .015 + f * .16);
      geo.rotateY(i * 2.39996);
      geo.computeVertexNormals();
      parts.push(geo.toNonIndexed());
      geo.dispose();
    }
    return mergeGeometries(parts);
  });
}
function addRose(g, pos, s, pal, rot) {
  const mat = cached("roseMat", () => new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: .5, sheen: .8, sheenColor: new THREE.Color("#ffffff"), sheenRoughness: .5, side: THREE.DoubleSide }));
  const leafGeo = cached("leafGeo", () => { const lg = new THREE.PlaneGeometry(.32, .7, 4, 8); const p = lg.attributes.position; for (let v = 0; v < p.count; v++) { const x = p.getX(v), y = p.getY(v); p.setX(v, x * (1 - Math.abs(y) / .5)); p.setZ(v, -x * x * 1.5 + y * y * .3); } lg.translate(0, .35, 0); lg.rotateX(-1.2); lg.computeVertexNormals(); return lg; });
  const leafMat = cached("leafMat2", () => new THREE.MeshPhysicalMaterial({ color: "#4F7A3A", roughness: .4, clearcoat: .4, side: THREE.DoubleSide }));
  const r = new THREE.Group();
  r.add(new THREE.Mesh(roseGeo(pal), mat));
  [0, 2.3].forEach(a => { const l = new THREE.Mesh(leafGeo, leafMat); l.rotation.y = a + rot; l.position.y = .02; r.add(l); });
  r.position.copy(pos); r.scale.setScalar(s); r.rotation.y = rot * 6; r.rotation.x = (rot - .5) * .3;
  g.add(r);
}
const MACS = ["#F2B6C3", "#BFD8A8", "#CDB8EA", "#F6DC8A", "#B5D3EE"];
function addMacaron(g, pos, s, idx, face) {
  const shell = cached("macShell", () => { const sg = new THREE.SphereGeometry(.42, 36, 12, 0, TAU, 0, Math.PI / 2); sg.scale(1, .42, 1); return sg; });
  const foot = cached("macFoot", () => { const tg = new THREE.TorusGeometry(.38, .06, 6, 48); const p = tg.attributes.position, r = rng("foot"); for (let v = 0; v < p.count; v++) p.setXYZ(v, p.getX(v) * (1 + (r() - .5) * .05), p.getY(v) * (1 + (r() - .5) * .3), p.getZ(v) * (1 + (r() - .5) * .3)); tg.rotateX(Math.PI / 2); tg.computeVertexNormals(); return tg; });
  const fill = cached("macFill", () => new THREE.CylinderGeometry(.36, .36, .13, 36));
  const c = MACS[idx % MACS.length];
  const shellMat = cached("macMat" + c, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: .5, sheen: .5, sheenColor: new THREE.Color("#ffffff") }));
  const footMat = cached("macFootMat" + c, () => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c).lerp(new THREE.Color("#fff"), .3), roughness: .95 }));
  const fillMat = cached("macFillMat", () => new THREE.MeshPhysicalMaterial({ color: "#FFF3E2", roughness: .6, sheen: .3 }));
  const m = new THREE.Group();
  const bot = new THREE.Mesh(shell, shellMat); bot.rotation.x = Math.PI; bot.position.y = .18; m.add(bot);
  const f1 = new THREE.Mesh(foot, footMat); f1.position.y = .2; m.add(f1);
  const fl = new THREE.Mesh(fill, fillMat); fl.position.y = .3; m.add(fl);
  const f2 = new THREE.Mesh(foot, footMat); f2.position.y = .4; m.add(f2);
  const top = new THREE.Mesh(shell, shellMat); top.position.y = .42; m.add(top);
  // stand them on edge, facing out
  const holder = new THREE.Group(); holder.add(m); m.rotation.x = .55; m.position.y = .12;
  holder.position.copy(pos); holder.rotation.y = face; holder.scale.setScalar(s);
  g.add(holder);
}
function addShard(g, pos, r) {
  const shape = new THREE.Shape(); const h = 1 + r() * .9;
  shape.moveTo(-.25, 0); shape.lineTo(-.2 + r() * .1, h * .6); shape.lineTo(r() * .2 - .1, h); shape.lineTo(.3, h * (.5 + r() * .3)); shape.lineTo(.22, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: .05, bevelEnabled: true, bevelThickness: .01, bevelSize: .01, bevelSegments: 1 });
  const mat = cached("chocMat", () => new THREE.MeshPhysicalMaterial({ color: "#2A120A", roughness: .22, clearcoat: 1, clearcoatRoughness: .1 }));
  const m = new THREE.Mesh(geo, mat); m.position.copy(pos).setY(pos.y - .15); m.rotation.set((r() - .5) * .5, r() * TAU, (r() - .5) * .6);
  g.add(m); return geo;
}
function addCandle(g, pos, i, track, flameOnly) {
  const c = ["#F4C7CF", "#BFD9EE", "#F8E3A0", "#D3C2EA", "#C9DDB5"][i % 5];
  const body = new THREE.Mesh(cached("candleGeo", () => new THREE.CylinderGeometry(.09, .09, 1.9, 16)), cached("candleMat" + c, () => new THREE.MeshPhysicalMaterial({ map: stripeTexture(c), roughness: .45, clearcoat: .3 })));
  body.position.copy(pos).setY(pos.y + .95);
  const wick = new THREE.Mesh(cached("wickGeo", () => new THREE.CylinderGeometry(.012, .012, .18, 6)), cached("wickMat", () => new THREE.MeshBasicMaterial({ color: "#222" })));
  wick.position.copy(pos).setY(pos.y + 1.98);
  const flame = new THREE.Mesh(cached("flameGeo", () => { const fg = new THREE.SphereGeometry(.07, 16, 12); fg.scale(1, 2.6, 1); fg.translate(0, .16, 0); return fg; }), cached("flameMat", () => new THREE.MeshBasicMaterial({ color: "#FFD27A" })));
  flame.position.copy(pos).setY(pos.y + 2.0);
  const glow = new THREE.Sprite(cached("glowMat", () => new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
  glow.scale.set(.9, 1.1, 1); glow.position.copy(pos).setY(pos.y + 2.2);
  flame.userData.flicker = Math.random() * 10; glow.userData.flicker = flame.userData.flicker;
  track.flames.push(flame, glow);
  if (flameOnly) g.add(wick, flame, glow); else g.add(body, wick, flame, glow);
}

function topSpot(t, ty, rad, a) {
  if (t.sq) return new THREE.Vector3(Math.sin(a) * Math.min(1, rad) * t.W * .42, ty, Math.cos(a) * Math.min(1, rad) * t.D * .42);
  return new THREE.Vector3(Math.sin(a) * rad * t.R, ty, Math.cos(a) * rad * t.R);
}
const inCut = a => Math.abs(Math.atan2(Math.sin(a - CUT_AT), Math.cos(a - CUT_AT))) < CUT_W / 2 + .2;

function topCluster(kind, t, ty, cut, T, Mt, track) {
  const g = new THREE.Group(), r = rng(kind + t.W + t.i);
  const sc = Math.min(1.25, Math.max(.8, t.R / 4));
  if (kind === "berries" || kind === "flowers") {
    // a crescent along the back-left of the top, the way bakers arrange fruit and blooms
    const n = kind === "berries" ? 14 : 5;
    for (let i = 0; i < n; i++) {
      const a = -2.5 + (i / (n - 1)) * 1.9 + (r() - .5) * .3, rad = .55 + r() * .28;
      if (cut && inCut(a)) continue;
      const p = topSpot(t, ty, rad, a);
      if (kind === "flowers") addRose(g, p, sc * (1.35 + r() * .45), ["blush", "white", "wine", "peach", "blush", "white"][i % 6], r());
      else { const k = i % 4; if (k === 0 || k === 3) addStrawberry(g, p.setY(ty + .25 * sc), sc * (.85 + r() * .3), r(), Mt); else if (k === 1) addBlueberry(g, p, sc); else addRaspberry(g, p, sc); }
    }
  } else if (kind === "macarons") {
    const n = Math.max(5, Math.round(t.R * 1.1));
    for (let i = 0; i < n; i++) { const a = i / n * TAU + .3; if (cut && inCut(a)) continue; addMacaron(g, topSpot(t, ty, .7, a), sc * 1.45, i, a); }
  } else if (kind === "shards") {
    for (let i = 0; i < 7; i++) { const a = Math.PI + (r() - .5) * 2.4; if (cut && inCut(a)) continue; track.geo.push(addShard(g, topSpot(t, ty, .2 + r() * .45, a), r)); }
  } else if (kind === "candles") {
    for (let i = 0; i < 5; i++) { const a = -.9 + i * .45, p = topSpot(t, ty, .38 + (i % 2) * .12, a + Math.PI); if (cut && inCut(a + Math.PI)) continue; addCandle(g, p, i, track); }
  }
  return g;
}
function ledgeCluster(t, upper, kinds, cut, T, Mt) {
  const g = new THREE.Group(), r = rng("ledge" + t.i), ty = t.y + t.H + .02;
  const mid = (t.R + upper.R) / 2 / t.R;
  for (let i = 0; i < 7; i++) {
    const a = -.95 + (r() - .5) * .9, kind = kinds[i % kinds.length];
    if (cut && inCut(a)) continue;
    const p = topSpot(t, ty, mid + (r() - .5) * .08, a);
    if (kind === "flowers") addRose(g, p, 1.15 + r() * .3, ["blush", "white", "wine"][i % 3], r());
    else if (kind === "macarons") addMacaron(g, p, 1.2, i, a);
    else { const k = i % 3; if (k === 0) addStrawberry(g, p.setY(ty + .22), .85, r(), Mt); else if (k === 1) addBlueberry(g, p, 1); else addRaspberry(g, p, 1); }
  }
  return g;
}
function sprinkleTop(t, ty, cut, T, Mt) {
  const r = rng("spt" + t.W), cols = ["#E9548A", "#4FB0E2", "#F4C94A", "#86CC82", "#ffffff", "#B47EDB"];
  const n = Math.round(t.R * t.R * 22);
  const im = new THREE.InstancedMesh(T(new THREE.CapsuleGeometry(.028, .13, 3, 6)), Mt(new THREE.MeshPhysicalMaterial({ roughness: .35, clearcoat: .6 })), n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, rad = Math.sqrt(r()) * .9; if (cut && inCut(a)) continue;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * TAU).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2 + (r() - .5) * .4));
    im.setMatrixAt(k, compose(topSpot(t, ty + .03, rad, a), q)); im.setColorAt(k++, new THREE.Color(cols[i % cols.length]));
  }
  im.count = k;
  const g = new THREE.Group(); g.add(im); return g;
}
function goldTop(t, ty, cut, T, Mt) {
  const g = new THREE.Group(), r = rng("gt" + t.W), mat = Mt(GOLD()); mat.side = THREE.DoubleSide;
  for (let i = 0; i < 9; i++) {
    const a = r() * TAU; if (cut && inCut(a)) continue;
    const geo = T(new THREE.PlaneGeometry(.4 + r() * .5, .35 + r() * .4, 4, 4)), p = geo.attributes.position;
    for (let v = 0; v < p.count; v++) p.setZ(v, (r() - .5) * .06);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat); m.position.copy(topSpot(t, ty + .02, r() * .8, a)); m.rotation.set(-Math.PI / 2, 0, r() * TAU); g.add(m);
  }
  return g;
}
function plaque(text, font, hgt, T, Mt, track, layers) {
  const c = textCanvas(text, font, 1024, 256, "#fff");
  const alpha = track.tex(tex(c, 1, 1)); alpha.wrapS = alpha.wrapT = THREE.ClampToEdgeWrapping;
  const w = hgt * 4;
  const g = new THREE.Group();
  for (let k = 0; k < layers; k++) {
    const mat = Mt(new THREE.MeshPhysicalMaterial({ color: k === 0 ? "#E5BC5E" : "#9C7428", metalness: 1, roughness: k === 0 ? .2 : .4, alphaMap: alpha, alphaTest: .4, side: THREE.DoubleSide }));
    const pl = new THREE.Mesh(T(new THREE.PlaneGeometry(w, hgt)), mat); pl.position.z = -k * .025; g.add(pl);
  }
  return g;
}
function scriptTopper(t, ty, text, T, Mt, track) {
  const g = new THREE.Group();
  const width = Math.min((t.sq ? t.W : 2 * t.R) * .92, 8.5), hgt = width / 4;
  const p = plaque(text, "SIZEpx Pinyon, 'Pinyon Script', cursive", hgt, T, Mt, track, 4);
  p.position.y = ty + 1.9 + hgt / 2; g.add(p);
  const gold = Mt(GOLD());
  [-.22, .22].forEach(x => { const s = new THREE.Mesh(T(new THREE.CylinderGeometry(.03, .03, 2.4, 8)), gold); s.position.set(x * width, ty + 1.0, -.05); g.add(s); });
  g.position.z = t.sq ? -t.D * .12 : -t.R * .18;
  return g;
}
function numberTopper(t, ty, num, T, Mt, track) {
  const g = new THREE.Group();
  const p = plaque(num, "800 SIZEpx Bricolage, sans-serif", 2.4, T, Mt, track, 5);
  p.scale.x = .55 * Math.max(1, num.length * .7); p.position.y = ty + 1.15; g.add(p);
  const flameIdx = [];
  for (let i = 0; i < num.length; i++) flameIdx.push((i - (num.length - 1) / 2) * .9);
  flameIdx.forEach(x => addCandle(g, new THREE.Vector3(x, ty + .32, -.03), 0, track, true));
  g.position.z = t.sq ? -t.D * .1 : -t.R * .12;
  return g;
}

// -------------------------------------------------------------------- viewer
function easeOutBack(x) { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }

function frame(camera, root, topY, w, h, fitR, knownBox) {
  const box = knownBox || new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.z) / 2, height = size.y;
  const aspect = w / h, vfov = camera.fov * Math.PI / 180, hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const need = Math.max((height * .62) / Math.tan(vfov / 2), (radius * 1.12) / Math.tan(hfov / 2)) * (fitR || 1);
  const elev = 0.44;
  return { dist: need + radius * .5, target: new THREE.Vector3(0, center.y - height * .04, 0), elev };
  void topY;
}

function shapeChanged(last, d) { return last != null && last.split("|")[0] !== d.shape; }

class Viewer {
  constructor(container, menu, opts) {
    this.menu = menu; this.opts = Object.assign({ autoRotate: false, interactive: true }, opts || {});
    this.el = container;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cake3d-canvas";
    container.appendChild(this.canvas);
    this.renderer = makeRenderer(this.canvas, true);
    this.scene = makeScene(this.renderer);
    this.camera = new THREE.PerspectiveCamera(26, 1, .1, 400);
    this.yaw = -.35; this.yawVel = 0; this.yawTarget = null;
    this.cur = null; this.track = null; this.anim = []; this.camDist = null; this.camTarget = new THREE.Vector3();
    this.size();
    this.ro = new ResizeObserver(() => this.size()); this.ro.observe(container);
    if (this.opts.interactive) this.bindDrag();
    this.visible = true;
    this.io = new IntersectionObserver(es => { this.visible = es[0].isIntersecting; }); this.io.observe(container);
    this.loop = this.loop.bind(this); this.last = performance.now(); requestAnimationFrame(this.loop);
    viewers.add(this);
  }
  size() {
    const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.w = w; this.h = h; this.dirty = true;
    if (this.cur) this.fit(true);
  }
  bindDrag() {
    let down = false, lx = 0, lt = 0;
    const c = this.canvas;
    c.addEventListener("pointerdown", e => { down = true; lx = e.clientX; lt = performance.now(); this.yawVel = 0; this.yawTarget = null; c.setPointerCapture(e.pointerId); this.el.classList.add("is-dragging"); });
    c.addEventListener("pointermove", e => {
      if (!down) return;
      const dx = e.clientX - lx, now = performance.now();
      this.yaw += dx * .011; this.yawVel = dx * .011 / Math.max(1, now - lt) * 16;
      lx = e.clientX; lt = now; this.dirty = true;
      this.el.dispatchEvent(new CustomEvent("cake:spun"));
    });
    const up = () => { down = false; this.el.classList.remove("is-dragging"); };
    c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
  }
  update(design, opts) {
    opts = opts || {};
    const d = window.LCake.normalize(design);
    const prevKeys = this.cur ? new Set(this.cur.pieces.keys()) : null;
    const prevFrost = this.frostNow ? this.frostNow.clone() : null;
    const track = { geo: [], mat: [], texs: [], frost: [], flames: [], tex: t => { track.texs.push(t); return t; } };
    const built = buildCake(d, this.menu, opts, track);
    // swap
    if (this.cur) { this.scene.remove(this.cur.root); disposeTrack(this.track); }
    this.scene.add(built.root); this.cur = built; this.track = track;
    this.scene.userData.catcher.position.y = d.shape === "sheet" ? -.21 : -4.02;
    // colors glide from the old frosting color
    const target = new THREE.Color(d.color === "custom" && d.custom_hex ? d.custom_hex : (byId(this.menu.colors, d.color).hex || "#FBF3E4"));
    if (prevFrost && !prevFrost.equals(target) && !REDUCED) {
      track.frost.forEach(m => { m.userData.to = m.color.clone(); m.color.copy(prevFrost); });
      this.anim.push({ t0: performance.now(), dur: 380, step: k => track.frost.forEach(m => m.color.lerpColors(prevFrost, m.userData.to, k)) });
    }
    this.frostNow = target;
    // frame the camera on the finished cake, before new pieces shrink down to grow in
    built.root.rotation.y = this.yaw;
    built.root.updateMatrixWorld(true);
    this.box = new THREE.Box3().setFromObject(built.root);   // full size, measured once per design
    this.fit(!prevKeys || shapeChanged(this.lastShape, d));
    this.lastShape = d.shape + "|" + d.tiers + "|" + d.size;
    // new pieces settle in
    if (prevKeys && !REDUCED) {
      let delay = 0;
      built.pieces.forEach((obj, key) => {
        if (prevKeys.has(key)) return;
        const s0 = obj.scale.clone(), y0 = obj.position.y;
        obj.scale.setScalar(.001);
        const t0 = performance.now() + delay; delay += 40;
        this.anim.push({ t0, dur: 520, step: k => { const e = easeOutBack(k); obj.scale.set(s0.x * Math.max(.001, e), s0.y * Math.max(.001, e), s0.z * Math.max(.001, e)); obj.position.y = y0 + (1 - Math.min(1, k * 1.4)) * .8; } });
      });
    }
    if (opts.view === "inside" && this.lastView !== "inside") this.yawTarget = -CUT_AT + .35;
    this.lastView = opts.view;
    this.dirty = true;
  }
  fit(snap) {
    const f = frame(this.camera, this.cur.root, this.cur.top, this.w, this.h, this.opts.fit, this.box);
    this.goal = f;
    if (snap || this.camDist == null) { this.camDist = f.dist; this.camTarget.copy(f.target); }
  }
  loop(now) {
    requestAnimationFrame(this.loop);
    const dt = Math.min(64, now - this.last); this.last = now;
    if (!this.cur || !this.visible || document.hidden) return;
    let active = this.dirty;
    this.anim = this.anim.filter(a => { const k = Math.min(1, Math.max(0, (now - a.t0) / a.dur)); if (now >= a.t0) a.step(k); active = true; return k < 1; });
    if (this.goal) {
      const dd = this.goal.dist - this.camDist, tt = this.goal.target.clone().sub(this.camTarget);
      if (Math.abs(dd) > .01 || tt.length() > .01) { this.camDist += dd * Math.min(1, dt / 180); this.camTarget.addScaledVector(tt, Math.min(1, dt / 180)); active = true; }
    }
    if (this.yawTarget != null) { const d = Math.atan2(Math.sin(this.yawTarget - this.yaw), Math.cos(this.yawTarget - this.yaw)); this.yaw += d * Math.min(1, dt / 220); if (Math.abs(d) < .002) this.yawTarget = null; active = true; }
    if (Math.abs(this.yawVel) > .0002) { this.yaw += this.yawVel * dt / 16; this.yawVel *= Math.pow(.92, dt / 16); active = true; }
    if (this.opts.autoRotate && !REDUCED) { this.yaw += dt * .00018; active = true; }
    if (this.track && this.track.flames.length) {
      this.track.flames.forEach(f => { const s = 1 + Math.sin(now / 90 + f.userData.flicker) * .06 + Math.sin(now / 37 + f.userData.flicker) * .04; if (f.isSprite) f.scale.set(.9 * s, 1.1 * s, 1); else f.scale.set(1, s, 1); });
      active = true;
    }
    if (!active) return;
    this.cur.root.rotation.y = this.yaw;
    const e = this.goal ? this.goal.elev : .36;
    this.camera.position.set(0, this.camTarget.y + Math.sin(e) * this.camDist, Math.cos(e) * this.camDist);
    this.camera.lookAt(this.camTarget);
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }
  dispose() { this.ro.disconnect(); this.io.disconnect(); disposeTrack(this.track); this.renderer.dispose(); this.canvas.remove(); viewers.delete(this); }
}
function disposeTrack(tr) {
  if (!tr) return;
  tr.geo.forEach(g => g.dispose()); tr.mat.forEach(m => m.dispose()); tr.texs.forEach(t => t.dispose());
}

// one hidden renderer makes still images for signature cards and admin thumbnails
const queue = [];
let busy = false;
function snapshot(design, menu, w, h) {
  return new Promise(res => { queue.push({ design, menu, w, h, res }); pump(); });
}
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  if (!SHARED) {
    const c = canvas(10, 10);
    SHARED = { renderer: makeRenderer(c, true), canvas: c };
    SHARED.scene = makeScene(SHARED.renderer);
    SHARED.camera = new THREE.PerspectiveCamera(26, 1, .1, 400);
  }
  const { renderer, scene, camera } = SHARED;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(job.w, job.h, false);
  camera.aspect = job.w / job.h; camera.updateProjectionMatrix();
  const track = { geo: [], mat: [], texs: [], frost: [], flames: [], tex: t => { track.texs.push(t); return t; } };
  const b = buildCake(window.LCake.normalize(job.design), job.menu, {}, track);
  b.root.rotation.y = -.35;
  scene.add(b.root);
  scene.userData.catcher.position.y = job.design.shape === "sheet" ? -.21 : -4.02;
  const f = frame(camera, b.root, b.top, job.w, job.h);
  camera.position.set(0, f.target.y + Math.sin(f.elev) * f.dist, Math.cos(f.elev) * f.dist); camera.lookAt(f.target);
  renderer.render(scene, camera);
  const url = SHARED.canvas.toDataURL("image/webp", .9);
  scene.remove(b.root); disposeTrack(track);
  job.res(url);
  busy = false;
  setTimeout(pump, 0);
}

function supported() {
  try { const c = document.createElement("canvas"); return !!(window.WebGL2RenderingContext && c.getContext("webgl2")); } catch (e) { return false; }
}

// fonts used inside textures must be loaded before the first text texture is drawn
const fontsReady = Promise.all([
  document.fonts ? document.fonts.load("64px Pinyon") : Promise.resolve(),
  document.fonts ? document.fonts.load("800 64px Bricolage") : Promise.resolve(),
]).catch(() => {});

if (supported()) {
  fontsReady.then(() => {
    window.LCake3D = { create: (el, menu, opts) => new Viewer(el, menu, opts), snapshot };
    window.dispatchEvent(new Event("lcake3d:ready"));
  });
}
