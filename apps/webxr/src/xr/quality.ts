import type * as THREE from "three";

// How sharp the headset draws. Full resolution with no foveation (1.0 / 0) stalled the Quest 3S on 300k-splat people
// (the frame froze and stuck to your head), and Spark's own half resolution blurs them; 0.7 with some fixed foveation
// keeps the centre of your view sharp and the frame rate up. Tunable from the URL without a rebuild:
// ?res=0.9 (framebuffer scale), ?fov=0 (0 = none, 1 = most foveation).
const q = new URLSearchParams(location.search);
const num = (k: string, fallback: number, lo: number, hi: number) => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

export const XR_QUALITY = { res: num("res", 0.7, 0.4, 1.5), fov: num("fov", 0.6, 0, 1) };

/** Text drawn into a canvas stays sharp when seen at an angle or from across the room. */
export function crisp(tex: THREE.Texture, renderer?: THREE.WebGLRenderer): THREE.Texture {
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  return tex;
}
