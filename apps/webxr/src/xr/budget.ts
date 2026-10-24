import type { PackedSplats } from "@sparkjsdev/spark";

// A replay frame trimmed to what a headset can draw. Spark draws every Gaussian as a full quad out to maxStdDev
// whatever its opacity, so a 290k-Gaussian person filling your view is mostly fill rate: the faintest Gaussians cost
// as much screen as the solid ones and add almost nothing to the picture. This keeps the ones that contribute most
// (opacity x the area they cover) up to a budget, in place, before the frame ever reaches the GPU.

const SCALE_ZERO_BYTE = 0;

/** Keep the `budget` Gaussians that add the most to the picture; returns how many were kept. */
export function trimSplats(ps: PackedSplats, budget: number): number {
  const n = ps.numSplats;
  const a = ps.packedArray;
  if (!a || budget <= 0 || n <= budget) return n;
  const lnMin = ps.splatEncoding?.lnScaleMin ?? -12;
  const lnStep = ((ps.splatEncoding?.lnScaleMax ?? 9) - lnMin) / 254;
  const lodOpacity = !!ps.splatEncoding?.lodOpacity;
  // ln(scale) for each byte value, so a Gaussian's score is two lookups and an exp
  const ln = new Float32Array(256);
  for (let u = 1; u < 256; u++) ln[u] = lnMin + (u - 1) * lnStep;
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w0 = a[i * 4];
    const w3 = a[i * 4 + 3];
    let op = (w0 >>> 24) / 255;
    if (lodOpacity) op *= 2;
    const sx = w3 & 255;
    const sy = (w3 >>> 8) & 255;
    const sz = (w3 >>> 16) & 255;
    if (op <= 0 || (sx === SCALE_ZERO_BYTE && sy === SCALE_ZERO_BYTE && sz === SCALE_ZERO_BYTE)) continue;
    // the two largest axes: the area it covers seen face on
    const lx = ln[sx];
    const ly = ln[sy];
    const lz = ln[sz];
    const small = Math.min(lx, ly, lz);
    score[i] = Math.min(op, 1) * Math.exp(lx + ly + lz - small);
  }
  // the budget-th largest score, by a histogram on log score (no full sort of 300k numbers)
  const BINS = 2048;
  const lo = -40;
  const hi = 2;
  const hist = new Uint32Array(BINS);
  const bin = (s: number) => (s <= 0 ? -1 : Math.max(0, Math.min(BINS - 1, Math.floor(((Math.log(s) - lo) / (hi - lo)) * BINS))));
  for (let i = 0; i < n; i++) {
    const b = bin(score[i]);
    if (b >= 0) hist[b]++;
  }
  let cut = BINS - 1;
  let total = 0;
  for (; cut >= 0; cut--) {
    if (total + hist[cut] > budget) break;
    total += hist[cut];
  }
  // everything above the cut bin, then from the cut bin itself until the budget is full
  let room = budget - total;
  const shArrays = (["sh1", "sh2", "sh3"] as const)
    .map((k) => ps.extra?.[k] as Uint32Array | undefined)
    .filter((x): x is Uint32Array => !!x && x.length > 0)
    .map((x) => ({ x, stride: x.length % ps.maxSplats === 0 ? x.length / ps.maxSplats : x.length / n }))
    .filter(({ stride }) => Number.isInteger(stride) && stride > 0);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const b = bin(score[i]);
    if (b < cut) continue;
    if (b === cut) {
      if (room <= 0) continue;
      room--;
    }
    if (k !== i) {
      a.copyWithin(k * 4, i * 4, i * 4 + 4);
      for (const { x, stride } of shArrays) x.copyWithin(k * stride, i * stride, i * stride + stride);
    }
    k++;
  }
  ps.numSplats = k;
  ps.needsUpdate = true;
  return k;
}
