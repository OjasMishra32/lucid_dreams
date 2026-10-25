import type * as THREE from "three";

// How sharp the headset draws: above the recommended resolution and no fixed foveation by default (Spark's own default
// renders at half resolution, and three's at full foveation, which blurs people, text and anything off-centre). Tunable
// from the URL on a slow device without a rebuild: ?res=0.8 (framebuffer scale), ?fov=0.3 (0 = none, 1 = most
// foveation). ?sharp=0 puts back the earlier, softer settings (res 1.0, Spark's 0.3 splat blur, anisotropy 8) to compare.
const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const num = (k: string, fallback: number, lo: number, hi: number) => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

export const SHARP = q.get("sharp") !== "0";

// 1.2: the browser clamps the scale to the headset's native maximum, so asking above it never fails the session start
export const XR_QUALITY = { res: num("res", SHARP ? 1.2 : 1.0, 0.4, 1.5), fov: num("fov", 0, 0, 1) };

/** SparkRenderer options: Spark's default 0.3 px² anti-alias blur softens faces at walk distance; 0.1 keeps edges crisp
 * without the sparkle of 0. */
export const SPLAT_QUALITY: { blurAmount?: number } = SHARP ? { blurAmount: 0.1 } : {};

/** Texture anisotropy: the GPU's maximum when sharp (16 on the Quest), else the earlier cap of 8. */
export function maxAniso(renderer?: THREE.WebGLRenderer): number {
  return Math.min(SHARP ? 16 : 8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
}

/** Text drawn into a canvas stays sharp when seen at an angle or from across the room. */
export function crisp(tex: THREE.Texture, renderer?: THREE.WebGLRenderer): THREE.Texture {
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  return tex;
}
