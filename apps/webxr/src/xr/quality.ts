import type * as THREE from "three";

// How sharp the headset draws: full resolution and no fixed foveation by default (Spark's own default renders at half
// resolution, and three's at full foveation, which blurs people, text and anything off-centre). Tunable from the URL
// on a slow device without a rebuild: ?res=0.8 (framebuffer scale), ?fov=0.3 (0 = none, 1 = most foveation).
const q = new URLSearchParams(location.search);
const num = (k: string, fallback: number, lo: number, hi: number) => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

export const XR_QUALITY = { res: num("res", 1.0, 0.4, 1.5), fov: num("fov", 0, 0, 1) };

/** Text drawn into a canvas stays sharp when seen at an angle or from across the room. */
export function crisp(tex: THREE.Texture, renderer?: THREE.WebGLRenderer): THREE.Texture {
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  return tex;
}
