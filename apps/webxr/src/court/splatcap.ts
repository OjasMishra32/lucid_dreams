// `?splats=<n>` (dev only: court.ts loads this only under import.meta.env.DEV): draw at most n splats per body, to find
// the headset's frame budget live without rebuilding a bundle. The PLYs' order says nothing about importance, so each
// body's splats are ranked by opacity times footprint (the two largest scales), and the n most important are moved to
// the front of the packed array, with their spherical-harmonic words, and the rest are left undrawn. A body's freeze
// and reality splats share opacity and scales, so both keep the same splats. Run once, after the loads and before the
// first frame (Spark builds its textures from the arrays then). DOM-free (splatcap.test.ts). Stream C (`core`).

interface V3 {
  x: number;
  y: number;
  z: number;
}

/** The parts of Spark's PackedSplats this uses (4 words per splat; extra.sh1/sh2/sh3 hold 2, 4 and 6). */
export interface PackedLike {
  numSplats: number;
  packedArray: Uint32Array | null;
  extra: Record<string, unknown>;
  needsUpdate: boolean;
  forEachSplat(cb: (index: number, center: V3, scales: V3, quaternion: unknown, opacity: number, color: unknown) => void): void;
}

/** Words per splat in each spherical-harmonic band's array. */
const SH_WORDS: Record<string, number> = { sh1: 2, sh2: 4, sh3: 6 };

/** Each splat's importance: opacity times the area of its two largest axes. */
export function importanceOf(p: PackedLike): Float32Array {
  const out = new Float32Array(p.numSplats);
  p.forEachSplat((i, _c, s, _q, opacity) => {
    const a = Math.abs(s.x);
    const b = Math.abs(s.y);
    const c = Math.abs(s.z);
    const lo = Math.min(a, b, c);
    out[i] = opacity * ((a * b * c) / (lo || 1e-12)); // the product of the two largest
  });
  return out;
}

/** The indices of the n most important splats, most important first (ties keep their file order). */
export function topOrder(importance: Float32Array, n: number): Uint32Array {
  const all = Array.from({ length: importance.length }, (_, i) => i);
  all.sort((a, b) => importance[b] - importance[a] || a - b);
  return Uint32Array.from(all.slice(0, Math.max(0, Math.min(n, all.length))));
}

/** Keep the n most important splats at the front (their SH words too) and draw only those; returns the splats drawn. */
export function capPacked(p: PackedLike, n: number, importance: Float32Array): number {
  if (!p.packedArray || p.numSplats <= n) return p.numSplats;
  const order = topOrder(importance, n);
  const move = (words: Uint32Array, stride: number) => {
    const src = words.slice(0, p.numSplats * stride);
    for (let k = 0; k < order.length; k++) words.set(src.subarray(order[k] * stride, order[k] * stride + stride), k * stride);
  };
  move(p.packedArray, 4);
  for (const [band, stride] of Object.entries(SH_WORDS)) {
    const words = p.extra[band];
    if (words instanceof Uint32Array) move(words, stride);
  }
  p.numSplats = order.length;
  p.needsUpdate = true;
  return p.numSplats;
}

/** Cap every splat mesh under `root` (anything with a packedSplats) at n; what was drawn before and after. */
export function capSplats(root: { traverse(fn: (o: unknown) => void): void }, n: number): { meshes: number; before: number; after: number } {
  if (!Number.isInteger(n) || n < 1) throw new Error(`?splats= needs a whole number of splats, got ${n}`);
  const out = { meshes: 0, before: 0, after: 0 };
  root.traverse((o) => {
    const p = (o as { packedSplats?: PackedLike }).packedSplats;
    if (!p || typeof p.numSplats !== "number") return;
    out.meshes++;
    out.before += p.numSplats;
    out.after += capPacked(p, n, importanceOf(p));
  });
  return out;
}
