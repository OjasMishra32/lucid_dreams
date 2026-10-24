// Page-wide motion helpers. No three.js here, so the page's first script stays small and the 3D loads after.

export function webgl2Available(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

type Tick = (dt: number, now: number) => void;
const ticks = new Set<Tick>();
let last = 0;
function loop(now: number) {
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
  last = now;
  for (const t of ticks) t(dt, now);
  requestAnimationFrame(loop);
}
let started = false;
/** One requestAnimationFrame loop for the whole page: scroll effects and every canvas. */
export function onTick(fn: Tick) {
  ticks.add(fn);
  if (!started) {
    started = true;
    requestAnimationFrame(loop);
  }
  return () => ticks.delete(fn);
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
export const damp = (a: number, b: number, rate: number, dt: number) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
