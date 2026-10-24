import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// Real-size Staunton-style pieces for a 5 cm square (a 40 cm board), turned on a lathe from simple profiles.
// Units: meters. Each geometry stands on y = 0.

export const SQUARE = 0.05;
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

const R = 0.0175; // base radius
const HEIGHT: Record<PieceType, number> = { p: 0.042, n: 0.052, b: 0.058, r: 0.047, q: 0.068, k: 0.076 };

// (radius as a fraction of R, height as a fraction of the piece's height), bottom to top
const PROFILES: Record<Exclude<PieceType, "n">, [number, number][]> = {
  p: [[0, 0], [1, 0], [1, 0.07], [0.82, 0.12], [0.74, 0.17], [0.46, 0.42], [0.36, 0.58], [0.62, 0.62], [0.36, 0.66],
    [0.56, 0.74], [0.6, 0.83], [0.52, 0.93], [0.28, 0.99], [0, 1]],
  b: [[0, 0], [1, 0], [1, 0.06], [0.8, 0.11], [0.72, 0.15], [0.42, 0.4], [0.32, 0.6], [0.6, 0.64], [0.32, 0.68],
    [0.5, 0.74], [0.56, 0.82], [0.46, 0.9], [0.2, 0.94], [0.16, 0.96], [0.2, 0.98], [0, 1]],
  r: [[0, 0], [1, 0], [1, 0.08], [0.82, 0.14], [0.74, 0.2], [0.6, 0.66], [0.66, 0.72], [0.82, 0.76], [0.82, 1], [0.6, 1],
    [0.6, 0.9], [0, 0.9]],
  q: [[0, 0], [1, 0], [1, 0.06], [0.8, 0.1], [0.72, 0.14], [0.4, 0.5], [0.32, 0.66], [0.6, 0.7], [0.32, 0.73], [0.5, 0.8],
    [0.7, 0.88], [0.5, 0.9], [0.22, 0.93], [0.26, 0.97], [0, 1]],
  k: [[0, 0], [1, 0], [1, 0.06], [0.8, 0.1], [0.72, 0.13], [0.42, 0.48], [0.34, 0.64], [0.62, 0.68], [0.34, 0.71], [0.5, 0.78],
    [0.62, 0.86], [0.42, 0.88], [0.2, 0.89], [0, 0.89]],
};

function lathe(type: Exclude<PieceType, "n">): THREE.BufferGeometry {
  const h = HEIGHT[type];
  const pts = PROFILES[type].map(([r, y]) => new THREE.Vector2(Math.max(r * R, 0.0001), y * h));
  const g = new THREE.LatheGeometry(pts, 40);
  if (type === "k") {
    // the cross on top
    const v = new THREE.BoxGeometry(0.0045, 0.014, 0.0045).translate(0, h * 0.89 + 0.007, 0);
    const bar = new THREE.BoxGeometry(0.011, 0.0042, 0.0045).translate(0, h * 0.89 + 0.0085, 0);
    return mergeAll([g, v, bar]);
  }
  if (type === "r") {
    // crenellations
    const parts: THREE.BufferGeometry[] = [g];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      parts.push(new THREE.BoxGeometry(0.0065, 0.006, 0.0065).translate(Math.cos(a) * R * 0.7, h + 0.002, Math.sin(a) * R * 0.7));
    }
    return mergeAll(parts);
  }
  return g;
}

function knight(): THREE.BufferGeometry {
  const h = HEIGHT.n;
  const base = new THREE.LatheGeometry(
    [[0, 0], [1, 0], [1, 0.07], [0.8, 0.12], [0.72, 0.18], [0.55, 0.32], [0, 0.32]].map(
      ([r, y]) => new THREE.Vector2(Math.max(r * R, 0.0001), y * h),
    ),
    40,
  );
  // a horse head in profile (x forward, y up), extruded sideways
  const s = new THREE.Shape();
  const P: [number, number][] = [[-0.55, 0], [0.5, 0], [0.42, 0.22], [0.7, 0.42], [0.82, 0.58], [0.66, 0.68], [0.32, 0.6],
    [0.2, 0.74], [0.02, 0.98], [-0.12, 1], [-0.34, 0.86], [-0.52, 0.58], [-0.6, 0.3]];
  P.forEach(([x, y], i) => (i ? s.lineTo(x * R * 1.1, y * h * 0.72) : s.moveTo(x * R * 1.1, y * h * 0.72)));
  const head = new THREE.ExtrudeGeometry(s, { depth: R * 0.9, bevelEnabled: true, bevelSize: 0.0016, bevelThickness: 0.0016, bevelSegments: 3 });
  head.translate(0, h * 0.28, -R * 0.45); // profile faces the player, so it reads as a horse at a glance
  return mergeAll([base, head]);
}

function mergeAll(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // keep it dependency-free: concatenate non-indexed position/normal attributes
  const parts = geoms.map((g) => {
    if (!g.attributes.normal) g.computeVertexNormals(); // keep the lathe's smooth normals
    return g.index ? g.toNonIndexed() : g;
  });
  const count = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return out;
}

export function pieceGeometries(): Record<PieceType, THREE.BufferGeometry> {
  return { p: lathe("p"), b: lathe("b"), r: lathe("r"), q: lathe("q"), k: lathe("k"), n: knight() };
}

export function pieceMaterials() {
  return {
    w: new THREE.MeshPhysicalMaterial({ color: 0xf2f1ee, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.2, sheen: 0.3, side: THREE.DoubleSide }),
    b: new THREE.MeshPhysicalMaterial({ color: 0x2a2a2d, roughness: 0.32, clearcoat: 0.85, clearcoatRoughness: 0.15, side: THREE.DoubleSide }),
  };
}

export function pieceHeight(t: PieceType) {
  return HEIGHT[t] + (t === "k" ? 0.014 : 0);
}

/** The board: a dark rounded slab with a warm-grey checker and quiet coordinates. Square a1 is at local (-x, +z). */
export function board(): THREE.Group {
  const g = new THREE.Group();
  const slab = new THREE.Mesh(
    new RoundedBoxGeometry(SQUARE * 8 + 0.036, 0.012, SQUARE * 8 + 0.036, 4, 0.006),
    new THREE.MeshPhysicalMaterial({ color: 0x1c1c1e, roughness: 0.4, clearcoat: 0.5 }),
  );
  slab.position.y = -0.006;
  g.add(slab);
  const c = document.createElement("canvas");
  c.width = c.height = 1024;
  const ctx = c.getContext("2d")!;
  const sq = 1024 / 8;
  for (let f = 0; f < 8; f++)
    for (let r = 0; r < 8; r++) {
      ctx.fillStyle = (f + r) % 2 === 0 ? "#8d8b87" : "#e8e6e1"; // a1 is dark
      ctx.fillRect(f * sq, (7 - r) * sq, sq, sq);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const top = new THREE.Mesh(
    new THREE.PlaneGeometry(SQUARE * 8, SQUARE * 8),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.0005;
  g.add(top);
  // file letters and rank numbers on the frame
  const label = (text: string, x: number, z: number) => {
    const lc = document.createElement("canvas");
    lc.width = lc.height = 64;
    const l = lc.getContext("2d")!;
    l.fillStyle = "#8e8e93";
    l.font = '600 40px -apple-system, "SF Pro Text", "Inter", sans-serif';
    l.textAlign = "center";
    l.textBaseline = "middle";
    l.fillText(text, 32, 34);
    const lt = new THREE.CanvasTexture(lc);
    lt.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.012), new THREE.MeshBasicMaterial({ map: lt, transparent: true }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.0008, z);
    g.add(m);
  };
  const half = SQUARE * 4;
  for (let i = 0; i < 8; i++) {
    label("abcdefgh"[i], -half + SQUARE * (i + 0.5), half + 0.009);
    label(String(i + 1), -half - 0.009, half - SQUARE * (i + 0.5));
  }
  return g;
}

export function squareToLocal(sq: string, y = 0): THREE.Vector3 {
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]) - 1;
  return new THREE.Vector3(-SQUARE * 3.5 + f * SQUARE, y, SQUARE * 3.5 - r * SQUARE);
}

export function localToSquare(v: THREE.Vector3): string | null {
  const f = Math.round((v.x + SQUARE * 3.5) / SQUARE);
  const r = Math.round((SQUARE * 3.5 - v.z) / SQUARE);
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return "abcdefgh"[f] + String(r + 1);
}
