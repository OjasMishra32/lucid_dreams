// The headset: a standalone mixed-reality visor in the Quest 3S form factor, built here from code (no model files, no
// downloaded textures) and lit like a studio product shot. Scroll turns it from a front three-quarter to the side to
// the inside, then the two eye frusta draw out of the lenses into the room. Client only.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Metres. The front faces +Z; the wearer's eyes are behind it, at -Z.
const W = 0.191;
const H = 0.102;
const D = 0.044; // the white shell; the facial interface behind it brings the front unit to about 65 mm
const HX = W / 2;
const HY = H / 2;
const HZ = D / 2;
const RC = 0.023; // corner radius seen from the front
const RB = 0.014; // roundover of the front and back edges
const BEND = 1.0; // the shell curves back toward the sides: z -= BEND x^2
const BULGE = 1.1; // and the front is gently domed top to bottom
const TAPER = 0.05; // and narrows toward the face
const FACE = 1.5; // the foam follows the face: deeper at the temples
const IPD = 0.063; // 3S lenses sit at 58, 63 or 68 mm
const LENS_Y = 0.004;
const LENS_R = 0.0195;
const ACCENT = 0x2997ff;
// each eye sees 96 x 90 degrees, canted outward like a real headset (wider on the outer side, below the eye)
const FOV = { out: 52, in: 44, up: 43, down: 47 };
const REACH = 0.5; // how far the frusta go into the room

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const rad = THREE.MathUtils.degToRad;

const _m = new THREE.Matrix3();
// The shell's bend and taper, applied to anything built in the flat box's coordinates (normals by the inverse transpose
// of its Jacobian), so the facial interface, the windows and the seam all sit exactly on the curved body.
function warp(p: V3, n?: V3): V3 {
  const k = TAPER / (2 * HZ);
  const s = 1 - k * (HZ - p.z);
  const f = clamp((p.z + HZ) / (2 * HZ), 0, 1); // the dome fades out toward the back
  const df = p.z > -HZ && p.z < HZ ? 1 / (2 * HZ) : 0;
  if (n) {
    _m.set(s, 0, k * p.x, 0, 1, 0, -2 * BEND * p.x, -2 * BULGE * p.y * f, 1 - BULGE * p.y * p.y * df).invert().transpose();
    n.applyMatrix3(_m).normalize();
  }
  return p.set(p.x * s, p.y, p.z - BEND * p.x * p.x - BULGE * p.y * p.y * f);
}

function roundRect(ax: number, ay: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-ax + r, -ay);
  s.lineTo(ax - r, -ay);
  s.absarc(ax - r, -ay + r, r, -Math.PI / 2, 0, false);
  s.lineTo(ax, ay - r);
  s.absarc(ax - r, ay - r, r, 0, Math.PI / 2, false);
  s.lineTo(-ax + r, ay);
  s.absarc(-ax + r, ay - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-ax, -ay + r);
  s.absarc(-ax + r, -ay + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

function capsule(a: number, b: number): THREE.Shape {
  const s = new THREE.Shape();
  if (b <= a) {
    s.absarc(0, 0, a, 0, Math.PI * 2, false);
    return s;
  }
  s.absarc(0, b - a, a, 0, Math.PI, false);
  s.absarc(0, -(b - a), a, Math.PI, Math.PI * 2, false);
  s.closePath();
  return s;
}

// Extrusions come with flat normals and their own UVs; weld them so bevels shade as one soft surface.
function welded(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute("uv");
  g.deleteAttribute("normal");
  const m = mergeVertices(g, 1e-7);
  g.dispose();
  m.computeVertexNormals();
  return m;
}

// The white shell: a dense box pushed out onto a rounded slab (corner radius RC from the front, roundover RB at the
// edges), then bent. Analytic normals, so the big soft highlights stay clean.
function shellGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(W, H, D, 112, 60, 28);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const nor = g.getAttribute("normal") as THREE.BufferAttribute;
  const ix = HX - RB;
  const iy = HY - RB;
  const iz = HZ - RB;
  const rho = RC - RB;
  const kx = ix - rho;
  const ky = iy - rho;
  const q = v3();
  const c = v3();
  const n = v3();
  for (let i = 0; i < pos.count; i++) {
    q.fromBufferAttribute(pos, i);
    let cx = clamp(q.x, -kx, kx);
    let cy = clamp(q.y, -ky, ky);
    const dx = q.x - cx;
    const dy = q.y - cy;
    const d = Math.hypot(dx, dy);
    if (d > rho) {
      cx += (dx / d) * rho;
      cy += (dy / d) * rho;
    } else {
      cx = q.x;
      cy = q.y;
    }
    c.set(cx, cy, clamp(q.z, -iz, iz));
    n.subVectors(q, c).normalize();
    q.copy(c).addScaledVector(n, RB);
    warp(q, n);
    pos.setXYZ(i, q.x, q.y, q.z);
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  // the face side (inside the facial interface) is dark
  for (const gr of g.groups) gr.materialIndex = gr.materialIndex === 5 ? 1 : 0;
  return g;
}

// The seam where the front cover meets the body: a hairline tube just under the surface, on the front roundover.
function seamGeometry(): THREE.BufferGeometry {
  const phi = rad(24);
  const inner = roundRect(HX - RB, HY - RB, RC - RB).getSpacedPoints(520);
  if (inner[0].distanceTo(inner[inner.length - 1]) < 1e-6) inner.pop();
  const pts: V3[] = [];
  const m = inner.length;
  for (let i = 0; i < m; i++) {
    const a = inner[(i + m - 1) % m];
    const b = inner[(i + 1) % m];
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = ty / tl;
    const ny = -tx / tl;
    const n = v3(nx * Math.cos(phi), ny * Math.cos(phi), Math.sin(phi));
    const p = v3(inner[i].x + n.x * RB, inner[i].y + n.y * RB, HZ - RB + n.z * RB);
    warp(p, n);
    pts.push(p.addScaledVector(n, -0.00016));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, "centripetal"), 1040, 0.00042, 6, true);
}

// Facial interface outlines (in the flat box's coordinates): the visor's outline inset with a nose cut-out, and the
// opening around the lenses with its nose bridge.
function outerPath(inset: number): THREE.Path {
  const ax = HX - inset;
  const ay = HY - inset;
  const r = RC - inset;
  const nw = 0.019;
  const nh = 0.02 - inset * 0.5;
  const ne = nw + 0.008;
  const s = new THREE.Path();
  s.moveTo(ne, -ay);
  s.lineTo(ax - r, -ay);
  s.absarc(ax - r, -ay + r, r, -Math.PI / 2, 0, false);
  s.lineTo(ax, ay - r);
  s.absarc(ax - r, ay - r, r, 0, Math.PI / 2, false);
  s.lineTo(-ax + r, ay);
  s.absarc(-ax + r, ay - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-ax, -ay + r);
  s.absarc(-ax + r, -ay + r, r, Math.PI, Math.PI * 1.5, false);
  s.lineTo(-ne, -ay);
  s.bezierCurveTo(-nw, -ay, -nw * 0.72, -ay + nh, 0, -ay + nh);
  s.bezierCurveTo(nw * 0.72, -ay + nh, nw, -ay, ne, -ay);
  return s;
}

function holePath(grow: number): THREE.Path {
  const hw = 0.0725 + grow;
  const top = LENS_Y + 0.0315 + grow;
  const bot = LENS_Y - 0.0305 - grow;
  const hr = 0.024 + grow;
  const nb = -0.012 + grow;
  const h = new THREE.Path();
  h.moveTo(-0.024, bot);
  h.bezierCurveTo(-0.012, bot, -0.011, nb, 0, nb);
  h.bezierCurveTo(0.011, nb, 0.012, bot, 0.024, bot);
  h.lineTo(hw - hr, bot);
  h.absarc(hw - hr, bot + hr, hr, -Math.PI / 2, 0, false);
  h.lineTo(hw, top - hr);
  h.absarc(hw - hr, top - hr, hr, 0, Math.PI / 2, false);
  h.lineTo(-hw + hr, top);
  h.absarc(-hw + hr, top - hr, hr, Math.PI / 2, Math.PI, false);
  h.lineTo(-hw, bot + hr);
  h.absarc(-hw + hr, bot + hr, hr, Math.PI, Math.PI * 1.5, false);
  h.lineTo(-0.024, bot);
  return h;
}

// A closed outline as a function of the angle seen from (cx, cy): both outlines are star-shaped from there.
function byAngle(path: THREE.Path, cx: number, cy: number): (a: number) => THREE.Vector2 {
  const pts = path.getSpacedPoints(2400).map((p) => ({ a: Math.atan2(p.y - cy, p.x - cx), p }));
  pts.sort((u, v) => u.a - v.a);
  const n = pts.length;
  return (a: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].a < a) lo = mid + 1;
      else hi = mid;
    }
    const b = pts[lo % n];
    const p = pts[(lo + n - 1) % n];
    let span = b.a - p.a;
    if (span <= 0) span += Math.PI * 2;
    let t = a - p.a;
    if (t < 0) t += Math.PI * 2;
    return p.p.clone().lerp(b.p, clamp(t / span, 0, 1));
  };
}

// One ring of the facial interface: a soft section (superellipse, exponent `e`) swept round between the outer outline
// and the opening, from `front` back `depth`, optionally bent to the face. Clean quads, so it shades as one surface.
function ring(inset: number, grow: number, front: number, depth: number, e: number, face: number, tile: number) {
  const cy = LENS_Y - 0.004;
  const outer = byAngle(outerPath(inset), 0, cy);
  const inner = byAngle(holePath(grow), 0, cy);
  const M = 480;
  const C = 40;
  const pos = new Float32Array(M * C * 3);
  const uv = new Float32Array(M * C * 2);
  const q = v3();
  let run = 0;
  let prev: THREE.Vector2 | null = null;
  for (let i = 0; i < M; i++) {
    const a = -Math.PI + (i / M) * Math.PI * 2;
    const o = outer(a);
    const n = inner(a);
    if (prev) run += prev.distanceTo(o);
    prev = o;
    const mx = (o.x + n.x) / 2;
    const my = (o.y + n.y) / 2;
    const hx = (o.x - n.x) / 2;
    const hy = (o.y - n.y) / 2;
    for (let j = 0; j < C; j++) {
      const th = (j / C) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const xr = Math.sign(c) * Math.abs(c) ** (2 / e);
      const zr = Math.sign(s) * Math.abs(s) ** (2 / e);
      q.set(mx + hx * xr, my + hy * xr, front - depth / 2 + (depth / 2) * zr);
      q.z -= face * q.x * q.x * clamp((front - q.z) / depth, 0, 1);
      warp(q);
      const k = i * C + j;
      pos[k * 3] = q.x;
      pos[k * 3 + 1] = q.y;
      pos[k * 3 + 2] = q.z;
      uv[k * 2] = run / tile;
      uv[k * 2 + 1] = (j / C) * (0.06 / tile);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < C; j++) {
      const a = i * C + j;
      const b = ((i + 1) % M) * C + j;
      const c = ((i + 1) % M) * C + ((j + 1) % C);
      const d = i * C + ((j + 1) % C);
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A strap band swept along a curve: a soft rounded-rectangle section, rounded ends.
function band(points: V3[], o: { h0: number; h1: number; t0: number; t1: number; cap0: number; cap1: number; segs: number; tile: number }) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const len = curve.getLength();
  const C = 40;
  const E = 5;
  const rings = o.segs + 1;
  const pos = new Float32Array(rings * C * 3);
  const uv = new Float32Array(rings * C * 2);
  const up = v3(0, 1, 0);
  const P = v3();
  const T = v3();
  const U = v3();
  const N = v3();
  const perim = (o.h0 + o.h1 + o.t0 + o.t1) * 1.0;
  const end = (d: number, cap: number) => (cap > 0 && d < cap ? Math.sqrt(Math.max(0, 1 - (1 - d / cap) ** 2)) : 1);
  for (let i = 0; i < rings; i++) {
    const f = i / o.segs;
    const d = f * len;
    curve.getPointAt(f, P);
    curve.getTangentAt(f, T);
    U.copy(up).addScaledVector(T, -up.dot(T)).normalize();
    N.crossVectors(T, U).normalize();
    const hh = ((o.h0 + (o.h1 - o.h0) * f) / 2) * Math.max(0.04, Math.min(end(d, o.cap0), end(len - d, o.cap1)));
    const tt0 = (o.t0 + (o.t1 - o.t0) * f) / 2;
    const tt = tt0 * Math.max(0.04, Math.min(end(d, o.cap0 ? tt0 * 1.4 : 0), end(len - d, o.cap1 ? tt0 * 1.4 : 0)));
    for (let j = 0; j < C; j++) {
      const th = -Math.PI / 2 + (j / C) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const x = Math.sign(c) * Math.abs(c) ** (2 / E) * tt;
      const y = Math.sign(s) * Math.abs(s) ** (2 / E) * hh;
      const k = i * C + j;
      pos[k * 3] = P.x + N.x * x + U.x * y;
      pos[k * 3 + 1] = P.y + N.y * x + U.y * y;
      pos[k * 3 + 2] = P.z + N.z * x + U.z * y;
      uv[k * 2] = d / o.tile;
      uv[k * 2 + 1] = ((j / C) * perim) / o.tile;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < o.segs; i++) {
    for (let j = 0; j < C; j++) {
      const a = i * C + j;
      const b = (i + 1) * C + j;
      const c = (i + 1) * C + ((j + 1) % C);
      const d = i * C + ((j + 1) % C);
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---- procedural textures (generated here, nothing fetched) ----

function dataTex(data: Uint8Array, n: number, color = false): THREE.DataTexture {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function normalsFrom(h: Float32Array, n: number, strength: number): Uint8Array {
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const l = h[y * n + ((x + n - 1) % n)];
      const r = h[y * n + ((x + 1) % n)];
      const d = h[((y + n - 1) % n) * n + x];
      const u = h[((y + 1) % n) * n + x];
      const nx = (l - r) * strength;
      const ny = (d - u) * strength;
      const len = Math.hypot(nx, ny, 1);
      const k = (y * n + x) * 4;
      out[k] = ((nx / len) * 0.5 + 0.5) * 255;
      out[k + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out[k + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out[k + 3] = 255;
    }
  }
  return out;
}

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// tileable value noise
function noise(n: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const g = new Float32Array(cells * cells).map(() => r());
  const out = new Float32Array(n * n);
  const f = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < n; y++) {
    const fy = (y / n) * cells;
    const iy = Math.floor(fy);
    const ty = f(fy - iy);
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * cells;
      const ix = Math.floor(fx);
      const tx = f(fx - ix);
      const a = g[iy * cells + ix];
      const b = g[iy * cells + ((ix + 1) % cells)];
      const c = g[((iy + 1) % cells) * cells + ix];
      const d = g[((iy + 1) % cells) * cells + ((ix + 1) % cells)];
      out[y * n + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

// A Fresnel lens: concentric grooves, each a long facet then a short steep draft. Encoded as a normal map.
function fresnelTexture(): THREE.DataTexture {
  const n = 512;
  const rings = 44;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          const x = ((i + (a + 0.5) / 3) / n) * 2 - 1;
          const y = ((j + (b + 0.5) / 3) / n) * 2 - 1;
          const r = Math.hypot(x, y);
          if (r < 0.07 || r > 1) continue;
          const ph = (r * rings) % 1;
          const slope = ph < 0.84 ? 0.5 * r : -2.4 * r;
          sx += (slope * x) / r;
          sy += (slope * y) / r;
        }
      }
      sx /= 9;
      sy /= 9;
      const len = Math.hypot(sx, sy, 1);
      const k = (j * n + i) * 4;
      data[k] = ((-sx / len) * 0.5 + 0.5) * 255;
      data[k + 1] = ((-sy / len) * 0.5 + 0.5) * 255;
      data[k + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      data[k + 3] = 255;
    }
  }
  const t = dataTex(data, n);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// Strap fabric: fine ribs running along the band over a heathered knit (soft noise at two scales), so it reads as
// textile up close and never as stripes from across the room.
function fabricTextures(): { normal: THREE.DataTexture; color: THREE.DataTexture } {
  const n = 256;
  const ribs = 20;
  const a = noise(n, 128, 11);
  const b = noise(n, 32, 13);
  const h = new Float32Array(n * n);
  const col = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    const rib = Math.sin((y / n) * ribs * Math.PI) ** 2;
    for (let x = 0; x < n; x++) {
      const k = y * n + x;
      h[k] = rib * 0.55 + a[k] * 0.45;
      const g = clamp((0.9 + (a[k] - 0.5) * 0.1 + (b[k] - 0.5) * 0.04 + rib * 0.04) * 236, 0, 255);
      col[k * 4] = g;
      col[k * 4 + 1] = g;
      col[k * 4 + 2] = clamp(g * 1.012, 0, 255);
      col[k * 4 + 3] = 255;
    }
  }
  return { normal: dataTex(normalsFrom(h, n, 1.6), n), color: dataTex(col, n, true) };
}

function foamTexture(): THREE.DataTexture {
  const n = 256;
  const a = noise(n, 64, 3);
  const b = noise(n, 128, 5);
  const h = a.map((x, i) => x * 0.6 + b[i] * 0.4);
  return dataTex(normalsFrom(h, n, 2.4), n);
}

function canvasTex(draw: (g: CanvasRenderingContext2D, n: number) => void, n = 256): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  draw(c.getContext("2d")!, n);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function mountHeadset(host: HTMLElement, hooks: { progress: () => number; failed: () => void }): Promise<() => void> {
  let ok = false;
  try {
    ok = !!document.createElement("canvas").getContext("webgl2");
  } catch {
    ok = false;
  }
  if (!ok) {
    hooks.failed();
    return () => {};
  }
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    hooks.failed();
    return () => {};
  }
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = "headset-gl";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 1, 0.01, 30);

  // studio light: the room's reflections plus a soft key and a cool rim that separates the dark parts from black
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.035).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.6;
  const aim = new THREE.Object3D();
  aim.position.set(0, -0.005, -0.1);
  scene.add(aim);
  // a big soft spot close in: its falloff puts a gentle gradient across the broad white faces
  const key = new THREE.SpotLight(0xfff5ea, 1.7, 0, rad(40), 1, 2);
  key.target = aim;
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.0012;
  key.shadow.camera.near = 0.3;
  key.shadow.camera.far = 1.4;
  const rim = new THREE.DirectionalLight(0xe4ecff, 2.2);
  rim.target = aim;
  scene.add(key, rim);

  const textures: THREE.Texture[] = [];
  const keep = <T extends THREE.Texture>(t: T) => (textures.push(t), t);
  const fresnel = keep(fresnelTexture());
  const weave = fabricTextures();
  keep(weave.normal);
  keep(weave.color);
  const foamN = keep(foamTexture());

  const plastic = new THREE.MeshPhysicalMaterial({
    color: 0xf1f1ef,
    roughness: 0.4,
    metalness: 0,
    clearcoat: 0.45,
    clearcoatRoughness: 0.26,
    sheen: 0.25,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0xffffff),
  });
  const inside = new THREE.MeshPhysicalMaterial({ color: 0x0d0e10, roughness: 0.78, metalness: 0 });
  const seamMat = new THREE.MeshStandardMaterial({ color: 0x3a3b3e, roughness: 0.85, metalness: 0 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x040506,
    roughness: 0.16,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    ior: 1.5,
  });
  const camRing = new THREE.MeshPhysicalMaterial({ color: 0x26282e, roughness: 0.32, metalness: 0.75 });
  const camLens = new THREE.MeshPhysicalMaterial({
    color: 0x030306,
    roughness: 0.08,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    iridescence: 0.9,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [200, 480],
  });
  const frameMat = new THREE.MeshPhysicalMaterial({ color: 0x242528, roughness: 0.58, metalness: 0, clearcoat: 0.15, clearcoatRoughness: 0.5 });
  const foamMat = new THREE.MeshPhysicalMaterial({
    color: 0x2e2f33,
    roughness: 0.94,
    metalness: 0,
    sheen: 0.8,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0x6e7076),
    normalMap: foamN,
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
  const housingMat = new THREE.MeshPhysicalMaterial({ color: 0x17181b, roughness: 0.4, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.25 });
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a0c10,
    roughness: 0.1,
    metalness: 0,
    normalMap: fresnel,
    normalScale: new THREE.Vector2(0.22, 0.22),
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    clearcoatNormalMap: fresnel,
    clearcoatNormalScale: new THREE.Vector2(0.1, 0.1),
    iridescence: 0.3,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [180, 420],
  });
  const fabric = new THREE.MeshPhysicalMaterial({
    color: 0xd4d5d7,
    map: weave.color,
    roughness: 0.96,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.75,
    sheenColor: new THREE.Color(0xffffff),
    normalMap: weave.normal,
    normalScale: new THREE.Vector2(0.5, 0.5),
  });

  const rig = new THREE.Group(); // idle float
  scene.add(rig);
  const model = new THREE.Group();
  rig.add(model);
  const add = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], shadows = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    model.add(mesh);
    return mesh;
  };

  // body, seam, facial interface
  add(shellGeometry(), [plastic, inside]);
  add(seamGeometry(), seamMat, false);
  add(ring(0.003, 0, -HZ + 0.006, 0.0165, 7, 0, 0.02), frameMat);
  add(ring(0.0052, 0.0024, -HZ - 0.0075, 0.0155, 3.2, FACE, 0.02), foamMat);

  // the sensor windows: on each side three dark glass pills in a triangle, each with a camera behind it
  const Z = v3(0, 0, 1);
  const place = (mesh: THREE.Object3D, x: number, y: number, lift: number) => {
    const n = v3(0, 0, 1);
    const p = warp(v3(x, y, HZ), n);
    mesh.position.copy(p).addScaledVector(n, lift);
    mesh.quaternion.setFromUnitVectors(Z, n);
  };
  const windows: [number, number, number, number, number][] = [
    // x, y, half width, half height, camera radius
    [0.067, 0.0178, 0.0058, 0.0096, 0.0027],
    [0.067, -0.0178, 0.0058, 0.0096, 0.0021],
    [0.0465, 0, 0.0052, 0.0052, 0.0016],
  ];
  for (const side of [1, -1]) {
    for (const [x, y, a, b, cr] of windows) {
      const g = welded(
        new THREE.ExtrudeGeometry(capsule(a, b), {
          depth: 0.0006,
          bevelEnabled: true,
          bevelThickness: 0.00025,
          bevelSize: 0.0004,
          bevelOffset: -0.0004,
          bevelSegments: 4,
          curveSegments: 40,
        }),
      );
      place(add(g, glass, false), side * x, y, -0.0006);
      const bezel = new THREE.Mesh(new THREE.TorusGeometry(cr, cr * 0.22, 10, 48), camRing);
      place(bezel, side * x, y, 0.00012);
      model.add(bezel);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(cr * 0.82, 40), camLens);
      place(lens, side * x, y, 0.00034);
      model.add(lens);
    }
  }

  // power button on the side
  {
    const g = welded(
      new THREE.ExtrudeGeometry(capsule(0.0017, 0.0064), {
        depth: 0.0004,
        bevelEnabled: true,
        bevelThickness: 0.0004,
        bevelSize: 0.0006,
        bevelOffset: -0.0006,
        bevelSegments: 4,
        curveSegments: 32,
      }),
    );
    const btn = add(g, plastic);
    const n = v3(1, 0, 0);
    const p = warp(v3(HX, -0.002, 0.0038), n);
    btn.position.copy(p).addScaledVector(n, -0.00025);
    btn.quaternion.setFromUnitVectors(Z, n);
  }

  // lenses: a dark barrel each, a coated Fresnel element inside, at the 63 mm position
  const eyes: V3[] = [];
  {
    const prof = [
      [LENS_R - 0.0006, 0.0046],
      [LENS_R + 0.0004, 0.0054],
      [LENS_R + 0.0016, 0.0053],
      [LENS_R + 0.0027, 0.0041],
      [LENS_R + 0.0035, 0.0016],
      [LENS_R + 0.0041, -0.0012],
    ].map(([r, h]) => new THREE.Vector2(r, h));
    for (const side of [1, -1]) {
      const x = (side * IPD) / 2;
      const base = warp(v3(x / (1 - TAPER), LENS_Y, -HZ)).z;
      const housing = new THREE.LatheGeometry(prof, 120);
      housing.rotateX(-Math.PI / 2);
      housing.translate(x, LENS_Y, base);
      add(housing, housingMat);
      const lg = new THREE.RingGeometry(0.00001, LENS_R - 0.0002, 120, 24);
      const lp = lg.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < lp.count; i++) {
        const r = Math.hypot(lp.getX(i), lp.getY(i)) / LENS_R;
        lp.setZ(i, 0.0024 * (1 - r * r));
      }
      lg.computeVertexNormals();
      lg.rotateY(Math.PI);
      lg.translate(x, LENS_Y, base - 0.0045);
      add(lg, lensMat, false);
      eyes.push(v3(x, LENS_Y, base - 0.0045 - 0.0024 - 0.02));
    }
  }

  // strap: rigid white arms from the visor's sides, then a soft fabric loop round the back of the head
  {
    const arm = (s: number) => {
      const a0 = warp(v3(s * (HX - 0.0045), 0.0015, -0.0035));
      return [a0, v3(s * 0.0962, 0.0004, -0.024), v3(s * 0.0972, -0.0022, -0.052), v3(s * 0.0958, -0.0056, -0.083), v3(s * 0.0926, -0.0092, -0.114)];
    };
    for (const s of [1, -1]) {
      add(band(arm(s), { h0: 0.0195, h1: 0.0142, t0: 0.0068, t1: 0.005, cap0: 0, cap1: 0.0075, segs: 90, tile: 0.03 }), plastic).userData.strap = true;
    }
    const right = [v3(0.1004, -0.0058, -0.08), v3(0.0988, -0.0105, -0.12), v3(0.0925, -0.016, -0.158), v3(0.0772, -0.0222, -0.194), v3(0.0472, -0.0272, -0.222)];
    const loop = [...right, v3(0, -0.029, -0.235), ...right.slice().reverse().map((p) => v3(-p.x, p.y, p.z))];
    add(band(loop, { h0: 0.026, h1: 0.026, t0: 0.0034, t1: 0.0034, cap0: 0.006, cap1: 0.006, segs: 260, tile: 0.036 }), fabric).userData.strap = true;
  }

  // ---- the eye frusta ----
  const corners = eyes.map((e, i) => {
    const side = i === 0 ? 1 : -1;
    const xo = e.x + side * Math.tan(rad(FOV.out)) * REACH;
    const xi = e.x - side * Math.tan(rad(FOV.in)) * REACH;
    const yt = e.y + Math.tan(rad(FOV.up)) * REACH;
    const yb = e.y - Math.tan(rad(FOV.down)) * REACH;
    const z = e.z + REACH;
    return [v3(xo, yt, z), v3(xi, yt, z), v3(xi, yb, z), v3(xo, yb, z)];
  });
  const frusta = new THREE.Group();
  model.add(frusta);
  const segCount = 16;
  const segs = new Float32Array(segCount * 6);
  const lineGeo = new LineSegmentsGeometry();
  lineGeo.setPositions(segs);
  const lineMat = (width: number, opacity: number, hidden: boolean) =>
    new LineMaterial({
      color: ACCENT,
      linewidth: width,
      transparent: true,
      opacity,
      depthWrite: false,
      depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
  // a bright core and a soft halo where the lines are in the open; a faint trace where they pass through the visor
  const lineMats = [lineMat(1.5, 0.62, false), lineMat(6, 0.09, false), lineMat(1.2, 0.16, true), lineMat(5, 0.03, true)];
  const lineBase = lineMats.map((m) => m.opacity);
  for (const m of lineMats) {
    const l = new LineSegments2(lineGeo, m);
    l.frustumCulled = false;
    l.renderOrder = 2;
    frusta.add(l);
  }
  // the per-eye image plane: a faint glass rectangle with a fine grid
  const planeTex = canvasTex((g, n) => {
    g.fillStyle = "rgba(255,255,255,0.22)";
    g.fillRect(0, 0, n, n);
    g.strokeStyle = "rgba(255,255,255,0.32)";
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const t = Math.round((i / 8) * n) + 0.5;
      g.beginPath();
      g.moveTo(t, 0);
      g.lineTo(t, n);
      g.moveTo(0, t);
      g.lineTo(n, t);
      g.stroke();
    }
    const r = g.createRadialGradient(n / 2, n / 2, n * 0.1, n / 2, n / 2, n * 0.72);
    r.addColorStop(0, "rgba(0,0,0,0.55)");
    r.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = r;
    g.fillRect(0, 0, n, n);
  }, 512);
  keep(planeTex);
  const planeMat = new THREE.MeshBasicMaterial({
    color: ACCENT,
    map: planeTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  for (const c of corners) {
    const g = new THREE.BufferGeometry().setFromPoints([c[3], c[2], c[1], c[0]]);
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    const m = new THREE.Mesh(g, planeMat);
    m.renderOrder = 1;
    frusta.add(m);
  }
  // a small glow at each eye point
  const glowTex = keep(
    canvasTex((g, n) => {
      const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      r.addColorStop(0, "rgba(255,255,255,1)");
      r.addColorStop(0.18, "rgba(150,200,255,0.75)");
      r.addColorStop(0.5, "rgba(41,151,255,0.18)");
      r.addColorStop(1, "rgba(41,151,255,0)");
      g.fillStyle = r;
      g.fillRect(0, 0, n, n);
    }, 128),
  );
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  for (const e of eyes) {
    const s = new THREE.Sprite(glowMat);
    s.position.copy(e);
    s.scale.setScalar(0.014);
    s.renderOrder = 3;
    frusta.add(s);
  }
  frusta.visible = false;

  const _a = v3();
  const _b = v3();
  const writeSegs = (p: number) => {
    let k = 0;
    const put = (a: V3, b: V3) => {
      segs[k++] = a.x;
      segs[k++] = a.y;
      segs[k++] = a.z;
      segs[k++] = b.x;
      segs[k++] = b.y;
      segs[k++] = b.z;
    };
    let shown = 0;
    eyes.forEach((e, i) => {
      const lag = i * 0.025;
      const g1 = smooth(0.61 + lag, 0.75 + lag, p);
      const g2 = smooth(0.71 + lag, 0.83 + lag, p);
      shown = Math.max(shown, g1);
      const c = corners[i];
      for (let j = 0; j < 4; j++) put(e, _a.copy(c[j]).sub(e).multiplyScalar(Math.max(g1, 1e-4)).add(e));
      for (let j = 0; j < 4; j++) {
        _b.copy(c[(j + 1) % 4]).sub(c[j]);
        put(c[j], _a.copy(c[j]).addScaledVector(_b, Math.max(g2, 1e-4)));
      }
    });
    const iab = lineGeo.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
    iab.data.array.set(segs);
    iab.data.needsUpdate = true;
    return shown;
  };

  // points to frame: the whole headset, the visor alone (for the inside view), and the headset with both frusta
  model.updateMatrixWorld(true);
  const headPts: V3[] = [];
  const visorPts: V3[] = [];
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.parent !== model) return;
    const p = o.geometry.getAttribute("position") as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(p.count / 160));
    for (let i = 0; i < p.count; i += step) {
      const q = v3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      headPts.push(q);
      if (!o.userData.strap) visorPts.push(q);
    }
  });
  const allPts = [...headPts, ...eyes, ...corners.flat()];

  // camera keyframes: [progress, azimuth from the front (deg), elevation (deg)]
  const KEYS: [number, number, number][] = [
    [0, 40, 18],
    [0.3, 48, 15],
    [0.43, 90, 4],
    [0.47, 94, 4],
    [0.6, 180, 24],
    [1, 199, 13],
  ];
  const view = (p: number): [number, number] => {
    let i = 0;
    while (i < KEYS.length - 2 && p > KEYS[i + 1][0]) i++;
    const [p0, a0, e0] = KEYS[i];
    const [p1, a1, e1] = KEYS[i + 1];
    const t = smooth(p0, p1, p);
    return [a0 + (a1 - a0) * t, e0 + (e1 - e0) * t];
  };

  // Place the camera for a fixed orientation so `pts` exactly fill fractions (fx, fy) of the frame: in the camera's
  // own axes each point gives a bound on how close the camera may be; the pan centres the tightest pair.
  const R = v3();
  const U = v3();
  const F = v3();
  const fit = (pts: V3[], kx: number, ky: number, out: V3) => {
    let ax = Infinity;
    let bx = Infinity;
    let ay = Infinity;
    let by = Infinity;
    for (const p of pts) {
      const px = p.dot(R);
      const py = p.dot(U);
      const pz = p.dot(F);
      ax = Math.min(ax, pz - px / kx);
      bx = Math.min(bx, pz + px / kx);
      ay = Math.min(ay, pz - py / ky);
      by = Math.min(by, pz + py / ky);
    }
    const cx = (kx * (bx - ax)) / 2;
    const cy = (ky * (by - ay)) / 2;
    const cz = Math.min((ax + bx) / 2, (ay + by) / 2);
    return out.set(0, 0, 0).addScaledVector(R, cx).addScaledVector(U, cy).addScaledVector(F, cz);
  };
  const camA = v3();
  const camV = v3();
  const camB = v3();
  const back = v3();
  const basis = new THREE.Matrix4();
  const lightDir = (x: number, y: number, z: number, out: V3) =>
    out.set(0, 0, 0).addScaledVector(R, x).addScaledVector(U, y).addScaledVector(back, z).normalize();

  let w = 0;
  let h = 0;
  let dirty = true; // reduced motion draws only when something changed
  const resize = () => {
    if (host.clientWidth === w && host.clientHeight === h) return;
    dirty = true;
    w = host.clientWidth;
    h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    for (const m of lineMats) m.resolution.set(w, h);
  };
  let onScreen = false;
  let snap = true;
  const io = new IntersectionObserver(
    ([e]) => {
      // coming back into view (from either side), start from where the scroll is, not where we left off
      if (e.isIntersecting && !onScreen) snap = true;
      onScreen = e.isIntersecting;
    },
    { rootMargin: "10% 0px" },
  );
  io.observe(host);

  let shown = 1;
  let last = performance.now();
  const t0 = last;
  const ld = v3();
  const frame = () => {
    resize();
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!onScreen || !w || !h || (still && !dirty)) return;
    dirty = false;
    // scroll is stepped; follow it with a short ease so nothing jumps
    const target = clamp(hooks.progress(), 0, 1);
    if (still) shown = 1;
    else if (snap) shown = target;
    else shown += (target - shown) * (1 - Math.exp(-dt * 6));
    snap = false;
    const p = shown;
    const time = (now - t0) / 1000;

    // reduced motion holds one rear three-quarter, lenses and frusta both in view
    const [az, el] = still ? [156, 17] : view(p);
    const a = rad(az);
    const e = rad(el);
    back.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
    F.copy(back).negate();
    R.crossVectors(F, THREE.Object3D.DEFAULT_UP).normalize();
    U.crossVectors(R, F);
    const tv = Math.tan(rad(camera.fov / 2));
    const th = tv * camera.aspect;
    const portrait = camera.aspect < 0.9;
    fit(headPts, th * (portrait ? 0.84 : 0.6), tv * (portrait ? 0.5 : 0.62), camA);
    fit(visorPts, th * (portrait ? 0.72 : 0.56), tv * (portrait ? 0.4 : 0.56), camV);
    fit(allPts, th * (portrait ? 0.94 : 0.86), tv * (portrait ? 0.62 : 0.8), camB);
    camA.lerp(camV, smooth(0.47, 0.6, p));
    camera.position.lerpVectors(camA, camB, smooth(0.6, 0.88, p));
    camera.quaternion.setFromRotationMatrix(basis.makeBasis(R, U, back));

    // the lights and reflections turn with the camera, like a turntable under fixed studio lights
    scene.environmentRotation.set(0, a + rad(150), 0);
    key.position.copy(aim.position).addScaledVector(lightDir(-0.42, 1, 0.42, ld), 0.75);
    rim.position.copy(aim.position).addScaledVector(lightDir(0.65, 0.55, -0.85, ld), 0.7);

    // the faintest float, so it reads as an object in the air rather than a picture
    rig.rotation.y = still ? 0 : Math.sin(time * 0.38) * 0.012;
    rig.position.y = still ? 0 : Math.sin(time * 0.62) * 0.0011;

    const g = writeSegs(p);
    frusta.visible = g > 0.001;
    if (frusta.visible) {
      const fade = Math.min(1, g * 5);
      lineMats.forEach((m, i) => (m.opacity = lineBase[i] * fade));
      planeMat.opacity = 0.3 * smooth(0.76, 0.9, p);
      glowMat.opacity = smooth(0.61, 0.68, p);
    }
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  return () => {
    renderer.setAnimationLoop(null);
    io.disconnect();
    const mats = new Set<THREE.Material>();
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.Material) => mats.add(m));
      }
    });
    lineGeo.dispose();
    for (const m of lineMats) m.dispose();
    for (const m of mats) m.dispose();
    for (const t of textures) t.dispose();
    env.dispose();
    key.shadow.map?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
}
