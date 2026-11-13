import type * as THREE from "three";
import type { SparkRenderer } from "@sparkjsdev/spark";
import { META } from "../event";

// How sharp the headset draws, and how it stays at the headset's frame rate. Tunable from the URL on a slow device
// without a rebuild: ?res=0.8 (framebuffer scale), ?fov=0.3 (0 = none, 1 = most foveation), ?budget=150000
// (Gaussians per replay frame, 0 = all of them), ?std=2.4 (how far out each Gaussian is drawn), ?auto=0 (hold these).
// ?sharp=0 puts back the softer splat settings (Spark's 0.3 splat blur, anisotropy 8) to compare.
const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const num = (k: string, fallback: number, lo: number, hi: number) => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

/** A standalone headset (Quest): its GPU is a phone's, so replays are trimmed to a budget there. */
export const HEADSET = typeof navigator !== "undefined" && /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);

// 1.0 / 0 froze the Quest 3S at the chess board twice (no code error: the GPU fell behind); 0.8 with light
// foveation is the sharpest that keeps up so far. ?res=1&fov=0 still forces full resolution.
export const XR_QUALITY = {
  res: num("res", 0.8, 0.4, 1.5),
  // a replay is ~290k Gaussians drawn 100+ deep over the person (lebron-shot: ~140 Mpx of splats per eye at 1.8 m),
  // so on a headset it renders at 0.7: three in four of the pixels, where the splats' cost is
  resReplay: num("res", HEADSET ? 0.7 : 0.8, 0.4, 1.5),
  fov: num("fov", 0.3, 0, 1),
  // a replay frame of 290k Gaussians filling your view drew at 4 fps on a Quest 3S; 160k keeps the face and hands
  budget: Math.round(num("budget", HEADSET ? 160_000 : 0, 0, 5_000_000)),
  std: num("std", Math.sqrt(8), 1.2, 3.2),
  auto: q.get("auto") !== "0",
};

export const SHARP = q.get("sharp") !== "0";

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

/**
 * In the competition (event.ts) the headset runs at 72 Hz, the rate a Quest 3 / 3S holds with people this size in
 * view (its other rates, 80/90/120, read as dropped frames when they can't be held). The governor follows whatever
 * rate the session really has.
 */
export function settleFrameRate(session: XRSession | null) {
  if (!META || !session) return;
  try {
    const s = session as XRSession & { supportedFrameRates?: Float32Array; updateTargetFrameRate?: (rate: number) => Promise<void> };
    if (s.updateTargetFrameRate && s.supportedFrameRates && Array.from(s.supportedFrameRates).includes(72)) void s.updateTargetFrameRate(72).catch(() => {});
  } catch {
    // a browser without frame-rate control: it keeps its own
  }
}

// From sharpest to cheapest. Each step trims the fill rate the splats need: a Gaussian drawn out to 2.0 standard
// deviations instead of 2.83 covers half the pixels and loses only its faintest rim; the faintest Gaussians (minAlpha,
// culled before they're drawn: below 0.03 they are a fifth of a replay's splat area and ~1% of what you see) go
// next; foveation shades the edges of the view (where nobody looks through a headset's lenses) at lower rates.
const LEVELS = [
  { std: Math.sqrt(8), fov: 0.3, alpha: 0.5 / 255 },
  { std: 2.5, fov: 0.5, alpha: 0.01 },
  { std: 2.3, fov: 0.7, alpha: 0.018 },
  { std: 2.1, fov: 1.0, alpha: 0.025 },
  { std: 1.9, fov: 1.0, alpha: 0.03 }, // the shirt goes patchy past this (lebron-shot at 1.8, 0.045)
];

/**
 * Keeps a headset at its display rate the way games do: when frames run late (the smoothed rate under 85% of the
 * display's for 0.4 s) it steps the splat quality down a level; after 5 s with room to spare (over 95%) it tries a level
 * sharper. A step up that doesn't hold (late again within 3 s) doubles the wait before the next try, up to a minute,
 * so a scene that only just fits doesn't stutter every few seconds probing; a step up that holds for 10 s resets it.
 * Call `frame()` once per rendered frame.
 */
export class QualityGovernor {
  level = 0;
  fps = 72;
  private last = 0;
  private slow = 0; // seconds running late
  private fast = 0; // seconds with room to spare
  private hold = 0; // seconds before the next step up
  private holdDown = 0; // seconds before the next step down (short after a step up, so a try that fails is undone fast)
  private upWait = 5; // seconds with room to spare before trying a sharper level (doubles when a try fails)
  private sinceUp = Infinity; // seconds since the last step up
  private probing = false; // a step up that hasn't yet proved it holds
  /** The display rate the headset asked for (72, 90 or 120). */
  target = 72;
  onChange: ((level: number) => void) | null = null;

  /** `start`: the level a session begins at (a heavy replay starts a step down: 2.5 deviations look the same). */
  constructor(private renderer: THREE.WebGLRenderer, private spark: SparkRenderer | null = null, private start = 0) {
    // a URL ?std= starts there and, with ?auto=0, stays
    if (q.has("std")) this.start = Math.max(0, LEVELS.findIndex((l) => l.std <= XR_QUALITY.std + 1e-6));
    this.level = this.start;
    this.apply(false);
  }

  /** For a scene whose SparkRenderer arrives with its first person. */
  attach(spark: SparkRenderer) {
    this.spark = spark;
    this.apply(false);
  }

  /** Back to the sharpest when a session starts (each scene earns its own level). */
  reset() {
    this.level = this.start;
    this.slow = this.fast = 0;
    this.upWait = 5;
    this.sinceUp = Infinity;
    this.probing = false;
    this.hold = this.holdDown = 1.5; // the first frames of a session are always slow
    this.last = 0;
    this.apply(false);
  }

  frame(now: number) {
    if (!this.renderer.xr.isPresenting) {
      this.last = 0;
      return;
    }
    if (!this.last) {
      this.last = now;
      return;
    }
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    if (dt <= 0) return;
    this.fps += (1 / dt - this.fps) * 0.1;
    // the display rate the headset asked for (72, 90 or 120); late frames come in at half of it
    const rate = (this.renderer.xr.getSession() as (XRSession & { frameRate?: number }) | null)?.frameRate;
    if (rate && rate > 30) this.target = rate;
    if (!XR_QUALITY.auto) return;
    this.hold = Math.max(0, this.hold - dt);
    this.holdDown = Math.max(0, this.holdDown - dt);
    this.sinceUp += dt;
    if (this.probing && this.sinceUp > 10) {
      this.probing = false; // the last step up held: the next try comes at the usual pace
      this.upWait = 5;
    }
    if (this.fps < this.target * 0.85) {
      this.slow += dt;
      this.fast = 0;
    } else if (this.fps > this.target * 0.95) {
      this.fast += dt;
      this.slow = 0;
    } else {
      this.slow = Math.max(0, this.slow - dt);
      this.fast = 0;
    }
    if (this.slow > 0.4 && this.holdDown <= 0 && this.level < LEVELS.length - 1) {
      if (this.probing) this.upWait = Math.min(60, this.upWait * 2); // that sharper level didn't hold
      this.probing = false;
      this.level++;
      this.changed(0.8, 0.8);
    } else if (this.fast > this.upWait && this.hold <= 0 && this.level > 0) {
      this.level--;
      this.sinceUp = 0;
      this.probing = true;
      this.changed(3, 0.2);
    }
  }

  private changed(hold: number, holdDown: number) {
    this.slow = this.fast = 0;
    this.hold = hold;
    this.holdDown = holdDown;
    this.apply(true);
    this.onChange?.(this.level);
  }

  private apply(live: boolean) {
    const l = LEVELS[this.level];
    if (this.spark) {
      this.spark.maxStdDev = q.has("std") && this.level === this.start ? XR_QUALITY.std : l.std;
      this.spark.minAlpha = l.alpha;
    }
    const fov = Math.max(XR_QUALITY.fov, l.fov);
    if (live || this.renderer.xr.isPresenting) this.renderer.xr.setFoveation(fov);
  }
}
