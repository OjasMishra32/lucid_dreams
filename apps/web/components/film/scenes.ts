// The film's motion-graphics scenes (demo/video.md). Each is a fixed length, a 3D layer built from the website's own
// renderers (lib/three) driven by the scene clock instead of scroll, and a 2D layer of type and diagrams drawn for
// time t. Every number on screen is a measured one. 1920 x 1080.
import meta from "@/components/tech/overdraw.json";
import type { RigCamera } from "@/lib/three/story";
import type { CourtPlayer } from "@/lib/three/court";
import { lineup } from "./lineup";

export const W = 1920;
export const H = 1080;

export interface FilmData {
  frame: string | null; // the dancer, one SPZ frame
  reality: string | null; // the same frame with what no camera saw in blue
  seen: number | null; // her seen fraction
  count: number | null; // her Gaussians per frame
  cameras: unknown[]; // 4DAnyone's rig for her clip
  joints: number[][] | null; // GVHMR's 22 body joints for her frame
  clip: string; // her source video
  overdraw: string; // the frame-budget heat maps
  vishal: {
    avatar: string;
    frames: string[];
    env: number[];
    talk: { heard: number; wrote: number; spoke: number; total: number; n: number } | null;
    facts: { frames: number; gaussians: number; height: number; clipS: number };
  };
}

export interface Shared {
  data: FilmData;
  t: number; // the scene clock, seconds
  hud: { cams: number };
  images: HTMLImageElement[];
  video: HTMLVideoElement | null;
  heat: Uint8Array | null;
  // videos a scene plays at times of its own (a source card's original and its headset footage): `at` is the clip's
  // time at scene time t, or null while it's off screen (no seek)
  clips: { v: HTMLVideoElement; at: (t: number) => number | null }[];
}

export interface Scene {
  key: string;
  dur: number;
  gl?: { x: number; y: number; w: number; h: number }; // where the 3D layer sits on the stage
  mount?: (host: HTMLElement, s: Shared) => Promise<() => void>;
  prepare?: (s: Shared) => Promise<void>;
  preroll?: { t: number; seconds: number; waitMs: number }; // run the 3D layer this long (at scene time t) before frame 0
  draw: (g: CanvasRenderingContext2D, t: number, s: Shared) => void;
}

// ---------------------------------------------------------------------------------------------------------------- type

const FONT = '"SF Pro Display", system-ui, -apple-system, "Helvetica Neue", sans-serif';
const SERIF = '"New York", "Times New Roman", Georgia, serif';
const INK = "#f5f5f7";
const INK2 = "#a1a1a6";
const INK3 = "#86868b";
const BLUE = "#2997ff";

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x: number) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
/** 0 before a, 1 after b, eased between. */
export const ramp = (t: number, a: number, b: number) => ease((t - a) / (b - a));
/** In over [a, b], out over [c, d]. */
const span = (t: number, a: number, b: number, c: number, d: number) => Math.min(ramp(t, a, b), 1 - ramp(t, c, d));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

interface TextOpts {
  size: number;
  weight?: number;
  color?: string;
  align?: CanvasTextAlign;
  alpha?: number;
  track?: number;
  serif?: boolean;
  italic?: boolean;
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, o: TextOpts) {
  if ((o.alpha ?? 1) <= 0.001) return;
  g.save();
  g.globalAlpha = o.alpha ?? 1;
  g.font = `${o.italic ? "italic " : ""}${o.weight ?? 600} ${o.size}px ${o.serif ? SERIF : FONT}`;
  g.fillStyle = o.color ?? INK;
  g.textAlign = o.align ?? "left";
  g.textBaseline = "alphabetic";
  (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${o.track ?? 0}px`;
  g.fillText(s, x, y);
  g.restore();
}

/** Apple's line entrance: up 18 px out of a soft blur, and the reverse on the way out. */
function rise(g: CanvasRenderingContext2D, s: string, x: number, y: number, k: number, o: TextOpts) {
  if (k <= 0.001) return;
  g.save();
  g.filter = k < 0.999 ? `blur(${((1 - k) * 10).toFixed(2)}px)` : "none";
  text(g, s, x, y + (1 - k) * 18, { ...o, alpha: (o.alpha ?? 1) * k });
  g.restore();
}

function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

type Run = { s: string; italic?: boolean; sub?: boolean; sup?: boolean; serif?: boolean };
/** A line of math set by hand: italic letters in a serif, operators in SF, sub- and superscripts small. */
function formula(g: CanvasRenderingContext2D, runs: Run[], x0: number, y: number, k: number, size = 36, align: "left" | "center" = "left") {
  if (k <= 0.001) return;
  g.save();
  g.globalAlpha = k;
  g.filter = k < 0.999 ? `blur(${((1 - k) * 10).toFixed(2)}px)` : "none";
  g.fillStyle = INK;
  g.textBaseline = "alphabetic";
  const fontOf = (r: Run) => `${r.italic ? "italic " : ""}400 ${r.sub || r.sup ? size * 0.62 : size}px ${r.serif ? SERIF : FONT}`;
  let width = 0;
  for (const r of runs) {
    g.font = fontOf(r);
    width += g.measureText(r.s).width + (r.sub || r.sup ? 2 : 0);
  }
  let x = align === "center" ? x0 - width / 2 : x0;
  const dy = (1 - k) * 18;
  for (const r of runs) {
    g.font = fontOf(r);
    g.fillText(r.s, x, y + dy + (r.sub ? size * 0.22 : r.sup ? -size * 0.42 : 0));
    x += g.measureText(r.s).width + (r.sub || r.sup ? 2 : 0);
  }
  g.restore();
}

/** The fit's loss, typeset by hand: italic letters in a serif, norms as bars, subscripts small and low. */
function math(g: CanvasRenderingContext2D, x0: number, y: number, k: number) {
  if (k <= 0.001) return;
  const size = 36;
  type Run = { s: string; italic?: boolean; sub?: boolean; serif?: boolean; gap?: number };
  const runs: Run[] = [
    { s: "L", italic: true, serif: true }, { s: " = 0.8 " }, { s: "‖" }, { s: "Î", italic: true, serif: true }, { s: " − " },
    { s: "I", italic: true, serif: true }, { s: "‖" }, { s: "1", sub: true }, { s: " + 0.2 (1 − SSIM) + 0.1 " }, { s: "‖" },
    { s: "Â", italic: true, serif: true }, { s: " − " }, { s: "A", italic: true, serif: true }, { s: "‖" }, { s: "1", sub: true },
    { s: " + " }, { s: "L", italic: true, serif: true }, { s: "reg", sub: true },
  ];
  g.save();
  g.globalAlpha = k;
  g.filter = k < 0.999 ? `blur(${((1 - k) * 10).toFixed(2)}px)` : "none";
  g.fillStyle = INK;
  g.textBaseline = "alphabetic";
  let x = x0;
  const dy = (1 - k) * 18;
  for (const r of runs) {
    const sz = r.sub ? size * 0.62 : size;
    g.font = `${r.italic ? "italic " : ""}400 ${sz}px ${r.serif ? SERIF : FONT}`;
    g.fillText(r.s, x, y + dy + (r.sub ? size * 0.22 : 0));
    x += g.measureText(r.s).width + (r.sub ? 2 : 0);
  }
  g.restore();
}

// ---------------------------------------------------------------------------------------------------------------- scenes

/**
 * The wordmark, keynote style: SF Pro Display Bold in a white-to-ice gradient, revealed left to right behind a soft
 * edge, a band of light passing across the letters as it settles, and a faint glow behind it. Drawn on its own canvas
 * so the light only touches the letters.
 */
const markCanvas = typeof document === "undefined" ? null : document.createElement("canvas");
function wordmark(g: CanvasRenderingContext2D, t: number, cx: number, cy: number, size: number, t0: number) {
  if (!markCanvas) return;
  const k = ramp(t, t0, t0 + 1.1);
  if (k <= 0.001) return;
  const c = markCanvas;
  c.width = 1600;
  c.height = 360;
  const m = c.getContext("2d")!;
  m.clearRect(0, 0, c.width, c.height);
  m.font = `700 ${size}px ${FONT}`;
  m.textAlign = "center";
  m.textBaseline = "middle";
  (m as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${-size * 0.022}px`;
  const tw = m.measureText("Lucid Dreams").width;
  const x0 = c.width / 2 - tw / 2;
  const fill = m.createLinearGradient(x0, 0, x0 + tw, 0);
  fill.addColorStop(0, "#ffffff");
  fill.addColorStop(0.55, "#f2f6ff");
  fill.addColorStop(1, "#a9cfff");
  m.fillStyle = fill;
  m.fillText("Lucid Dreams", c.width / 2, c.height / 2);
  // the light: a narrow bright band crossing the letters once
  const sweep = clamp((t - t0 - 0.5) / 1.3);
  if (sweep > 0 && sweep < 1) {
    m.globalCompositeOperation = "source-atop";
    const sx = x0 - 200 + sweep * (tw + 400);
    const band = m.createLinearGradient(sx - 120, 0, sx + 120, 0);
    band.addColorStop(0, "rgba(255,255,255,0)");
    band.addColorStop(0.5, "rgba(255,255,255,0.95)");
    band.addColorStop(1, "rgba(255,255,255,0)");
    m.fillStyle = band;
    m.fillRect(0, 0, c.width, c.height);
    m.globalCompositeOperation = "source-over";
  }
  // the reveal: left to right behind a soft edge
  m.globalCompositeOperation = "destination-in";
  const edge = x0 - 160 + smooth(k) * (tw + 320);
  const mask = m.createLinearGradient(edge - 160, 0, edge, 0);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  m.fillStyle = mask;
  m.fillRect(0, 0, c.width, c.height);
  m.globalCompositeOperation = "source-over";
  // a faint glow behind, then the letters, settling from a touch larger
  g.save();
  const glow = g.createRadialGradient(cx, cy, 10, cx, cy, size * 3.4);
  glow.addColorStop(0, `rgba(80,140,255,${0.16 * k})`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = glow;
  g.fillRect(cx - size * 4, cy - size * 3, size * 8, size * 6);
  const z = lerp(1.035, 1, smooth((t - t0) / 2.2));
  g.translate(cx, cy);
  g.scale(z, z);
  g.drawImage(c, -c.width / 2, -c.height / 2);
  g.restore();
}

const title: Scene = {
  key: "title",
  dur: 3,
  draw(g, t) {
    wordmark(g, t, W / 2, 540, 150, 0.15);
  },
};

const cameras: Scene = {
  key: "cameras",
  dur: 10,
  async prepare(s) {
    const v = document.createElement("video");
    v.src = s.data.clip;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    await new Promise<void>((r) => {
      v.onloadeddata = () => r();
      v.onerror = () => r();
      v.load();
    });
    s.video = v;
  },
  async mount(host, s) {
    if (!s.data.frame) return () => {};
    const { mountStory } = await import("@/lib/three/story");
    // the story's own beats: 0.46 her whole and the camera rising, the rig flying in by 0.6, home by 0.62
    return mountStory(host, { frame: s.data.frame, reality: null, cameras: s.data.cameras as RigCamera[] }, {
      progress: () => lerp(0.46, 0.625, ramp(s.t, 0.4, 8.6)),
      loading: () => {},
      ready: () => {},
      failed: () => {},
      hud: (h) => (s.hud.cams = h.cams),
    });
  },
  preroll: { t: 0, seconds: 3, waitMs: 400 },
  draw(g, t, s) {
    // the phone video it starts from
    const pip = span(t, 0.1, 0.7, 3.2, 3.9);
    if (pip > 0.001 && s.video && s.video.readyState >= 2) {
      g.save();
      g.globalAlpha = pip;
      const w = 250;
      const h = (w * s.video.videoHeight) / Math.max(1, s.video.videoWidth);
      const x = 1550;
      const y = 120 + (1 - pip) * 20;
      round(g, x, y, w, h, 22);
      g.clip();
      g.drawImage(s.video, x, y, w, h);
      g.restore();
      text(g, "the phone video", x + w / 2, y + h + 40, { size: 24, weight: 500, color: INK3, align: "center", alpha: pip });
    }
    rise(g, "One video.", 120, 200, span(t, 0.3, 1.1, 3.0, 3.6), { size: 80, track: -1.5 });
    // the cameras as they land
    const k = ramp(t, 3.4, 4.2);
    rise(g, `${Math.round(clamp(s.hud.cams, 0, 48))}`, 120, 290, k, { size: 190, weight: 700, track: -6 });
    rise(g, "views around her, generated", 128, 352, k, { size: 36, weight: 500, color: INK2 });
    rise(g, "4DAnyone · Ant Research · public August 2026", 120, 990, ramp(t, 4.4, 5.2), { size: 28, weight: 500, color: INK3 });
  },
};

const fit: Scene = {
  key: "fit",
  dur: 12,
  gl: { x: 760, y: 0, w: 1160, h: 1080 },
  async mount(host, s) {
    if (!s.data.frame) return () => {};
    const { mountForming } = await import("@/lib/three/forming");
    return mountForming(host, s.data.frame, { amount: () => ramp(s.t, 1.4, 9.4), active: () => true, failed: () => {} });
  },
  preroll: { t: 0, seconds: 1, waitMs: 400 },
  draw(g, t, s) {
    rise(g, "Twelve GPUs. One person.", 120, 200, ramp(t, 0.2, 1.0), { size: 62, track: -1.2 });
    // 12 B200s working their chunks of frames in parallel
    const cols = 4;
    const tw = 136;
    const th = 88;
    const gap = 16;
    const x0 = 120;
    const y0 = 270;
    const shown = ramp(t, 0.6, 1.4);
    for (let i = 0; i < 12; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = x0 + c * (tw + gap);
      const y = y0 + r * (th + gap);
      const p = clamp((t - 1.4 - i * 0.07) / 8.0);
      g.save();
      g.globalAlpha = shown;
      round(g, x, y, tw, th, 14);
      g.fillStyle = "#151517";
      g.fill();
      if (p > 0) {
        g.shadowColor = "rgba(41,151,255,0.55)";
        g.shadowBlur = 18 * (p < 1 ? 1 : 0.4);
        round(g, x, y + th - 10, tw * p, 10, 5);
        g.fillStyle = BLUE;
        g.fill();
        g.shadowBlur = 0;
      }
      g.restore();
      text(g, "B200", x + 16, y + 34, { size: 22, weight: 600, color: p > 0 ? INK : INK3, alpha: shown });
      text(g, `GPU ${i + 1}`, x + 16, y + 60, { size: 17, weight: 500, color: INK3, alpha: shown });
    }
    // frames done across all of them, and the Gaussians in the one on the right
    const f = Math.floor(121 * clamp((t - 1.4) / 8.0));
    const k = ramp(t, 1.2, 1.8);
    text(g, "frames", 120, 640, { size: 26, weight: 500, color: INK3, alpha: k });
    text(g, `${f}`, 120, 730, { size: 96, weight: 700, track: -3, alpha: k });
    g.font = `700 96px ${FONT}`;
    text(g, "of 121", 120 + g.measureText(`${f}`).width - 3 * `${f}`.length + 16, 730, { size: 30, weight: 500, color: INK2, alpha: k });
    const n = (s.data.count ?? 289466) * ramp(t, 1.4, 9.4);
    text(g, "Gaussians in this frame", 520, 640, { size: 26, weight: 500, color: INK3, alpha: k });
    text(g, fmt(n), 520, 730, { size: 96, weight: 700, track: -3, alpha: k });
    rise(g, "7,000 Adam steps for the first frame, then 1,500 for each next one.", 120, 860, ramp(t, 2.4, 3.2), {
      size: 26,
      weight: 500,
      color: INK2,
    });
    math(g, 120, 950, ramp(t, 3.4, 4.2));
  },
};

const reality: Scene = {
  key: "reality",
  dur: 7,
  async mount(host, s) {
    if (!s.data.frame) return () => {};
    const { mountStory } = await import("@/lib/three/story");
    // no camera rig here: blue means unseen by the one real camera, and 48 generated cameras around her would blur that
    return mountStory(host, { frame: s.data.frame, reality: s.data.reality, cameras: [] }, {
      // the story's Reality check: to the front view by 0.7, swept to blue by 0.76, turned to her back by 0.78
      progress: () => (s.t < 0 ? 0.6 : lerp(0.66, 0.795, ramp(s.t, 0.3, 5.6))),
      loading: () => {},
      ready: () => {},
      failed: () => {},
      hud: () => {},
    });
  },
  preroll: { t: -1, seconds: 3, waitMs: 2500 },
  draw(g, t, s) {
    rise(g, "Seen, and imagined.", 120, 200, ramp(t, 0.3, 1.1), { size: 80, track: -1.5 });
    const k = ramp(t, 2.2, 2.9);
    g.save();
    g.globalAlpha = k;
    g.fillStyle = BLUE;
    g.beginPath();
    g.arc(132, 282, 11, 0, Math.PI * 2);
    g.fill();
    g.restore();
    text(g, "never seen by the real camera", 158, 292, { size: 32, weight: 500, color: INK2, alpha: k });
    const seen = Math.round((s.data.seen ?? 0.489) * 100);
    const k2 = ramp(t, 4.2, 5.0);
    rise(g, `${seen}%`, 120, 920, k2, { size: 170, weight: 700, track: -6 });
    rise(g, "of her was really seen", 128, 980, k2, { size: 34, weight: 500, color: INK2 });
  },
};

const avatar: Scene = {
  key: "avatar",
  dur: 12,
  gl: { x: 760, y: 0, w: 1160, h: 1080 },
  async prepare(s) {
    s.images = await Promise.all(
      s.data.vishal.frames.map(
        (src) =>
          new Promise<HTMLImageElement>((r) => {
            const im = new Image();
            im.onload = () => r(im);
            im.onerror = () => r(im);
            im.src = src;
          }),
      ),
    );
  },
  async mount(host, s) {
    const { mountForming } = await import("@/lib/three/forming");
    return mountForming(host, s.data.vishal.avatar, { amount: () => ramp(s.t, 3.6, 9.8), active: () => true, failed: () => {} });
  },
  preroll: { t: 0, seconds: 1, waitMs: 400 },
  draw(g, t, s) {
    // his 14 frames, then pulled into the body
    const n = s.images.length;
    const fw = 132;
    const fh = (fw * 16) / 9;
    const gap = 12;
    const cols = 7;
    const gw = cols * fw + (cols - 1) * gap;
    const gx = (W - gw) / 2;
    const gy = 300;
    const pull = ramp(t, 2.6, 3.8);
    for (let i = 0; i < n; i++) {
      const im = s.images[i];
      if (!im?.naturalWidth) continue;
      const c = i % cols;
      const r = Math.floor(i / cols);
      const a = ramp(t, 0.2 + i * 0.06, 0.6 + i * 0.06) * (1 - pull);
      if (a <= 0.001) continue;
      const x = lerp(gx + c * (fw + gap), 1340 - fw / 2, pull);
      const y = lerp(gy + r * (fh + gap), 540 - fh / 2, pull);
      const sc = lerp(1, 0.3, pull);
      g.save();
      g.globalAlpha = a;
      round(g, x, y, fw * sc, fh * sc, 10 * sc);
      g.clip();
      const ir = im.naturalWidth / im.naturalHeight;
      const cr = fw / fh;
      const sw = ir > cr ? im.naturalHeight * cr : im.naturalWidth;
      const sh = ir > cr ? im.naturalHeight : im.naturalWidth / cr;
      g.drawImage(im, (im.naturalWidth - sw) / 2, (im.naturalHeight - sh) / 2, sw, sh, x, y, fw * sc, fh * sc);
      g.restore();
    }
    rise(g, "14 frames from a 16-second video.", 120, 200, span(t, 0.3, 1.1, 3.0, 3.6), { size: 62, track: -1.2 });
    rise(g, "LHM++ builds a rigged body.", 120, 200, span(t, 3.9, 4.7, 7.4, 8.0), { size: 62, track: -1.2 });
    rise(g, "UIKA gives it his face.", 120, 200, ramp(t, 8.2, 9.0), { size: 62, track: -1.2 });
    const f = s.data.vishal.facts;
    const k = ramp(t, 5.0, 5.8);
    const rows: [string, string][] = [
      [fmt(f.gaussians), "Gaussians"],
      ["55", "joints, SMPL-X rig"],
      [`${f.height.toFixed(2)} m`, "tall, his real height"],
    ];
    rows.forEach(([v, l], i) => {
      const kk = ramp(t, 5.0 + i * 0.25, 5.8 + i * 0.25);
      rise(g, v, 120, 520 + i * 150, kk * k, { size: 84, weight: 700, track: -3 });
      rise(g, l, 124, 562 + i * 150, kk * k, { size: 28, weight: 500, color: INK2 });
    });
  },
};

// she comes apart into her Gaussians and back together (the home page's own exploded view)
const apart: Scene = {
  key: "apart",
  dur: 6.5,
  gl: { x: 760, y: 0, w: 1160, h: 1080 },
  async mount(host, s) {
    if (!s.data.frame) return () => {};
    const { mountForming } = await import("@/lib/three/forming");
    // whole, burst into her Gaussians, whole again
    return mountForming(host, s.data.frame, {
      amount: () => (s.t < 3 ? 1 - ramp(s.t, 0.5, 2.3) : ramp(s.t, 3.6, 5.8)),
      active: () => true,
      failed: () => {},
    });
  },
  preroll: { t: 0, seconds: 2, waitMs: 400 },
  draw(g, t, s) {
    const n = s.data.count ?? 289466;
    rise(g, fmt(n), 120, 520, span(t, 1.2, 2.0, 5.4, 6.1), { size: 150, weight: 700, track: -5 });
    rise(g, "3D Gaussians, in one frame of her", 126, 580, span(t, 1.5, 2.3, 5.4, 6.1), { size: 34, weight: 500, color: INK2 });
  },
};

// what she's made of: splats, each Gaussian as its true ellipse, only the centres, and the skeleton inside
const anatomy: Scene = {
  key: "anatomy",
  dur: 13,
  gl: { x: 860, y: 0, w: 1060, h: 1080 },
  async mount(host, s) {
    if (!s.data.frame) return () => {};
    const { mountAnatomy } = await import("@/lib/three/anatomy");
    const modeAt = (t: number) => (t < 2.2 ? "splats" : t < 6.0 ? "ellipsoids" : t < 8.8 ? "centres" : "skeleton");
    return mountAnatomy(host, { frame: s.data.frame, reality: s.data.reality, cameras: [], joints: s.data.joints }, {
      mode: () => modeAt(s.t),
      loading: () => {},
      ready: () => {},
      failed: () => {},
    });
  },
  preroll: { t: 0, seconds: 2, waitMs: 1500 },
  draw(g, t) {
    rise(g, "What she's made of.", 120, 190, span(t, 0.2, 1.0, 1.9, 2.4), { size: 72, track: -1.5 });
    rise(g, "Every Gaussian, drawn to one σ.", 120, 190, span(t, 2.5, 3.3, 5.6, 6.1), { size: 62, track: -1.2 });
    formula(g, [
      { s: "G", italic: true, serif: true }, { s: "(" }, { s: "x", italic: true, serif: true }, { s: ") = exp(−½ (" },
      { s: "x", italic: true, serif: true }, { s: " − " }, { s: "μ", italic: true, serif: true }, { s: ")" },
      { s: "⊤", sup: true }, { s: " Σ", serif: true }, { s: "−1", sup: true }, { s: " (" }, { s: "x", italic: true, serif: true },
      { s: " − " }, { s: "μ", italic: true, serif: true }, { s: "))" },
    ], 120, 270, span(t, 3.0, 3.8, 5.6, 6.1), 38);
    formula(g, [
      { s: "Σ = " }, { s: "R S S", italic: true, serif: true }, { s: "⊤", sup: true }, { s: " R", italic: true, serif: true }, { s: "⊤", sup: true },
      { s: "   position, rotation, scale, opacity, color" },
    ], 120, 330, span(t, 3.6, 4.4, 5.6, 6.1), 30);
    rise(g, "Only their centres.", 120, 190, span(t, 6.3, 7.1, 8.4, 8.9), { size: 62, track: -1.2 });
    rise(g, "The body inside: 22 joints, from the same video.", 120, 190, ramp(t, 9.1, 9.9), { size: 56, track: -1.0 });
    rise(g, "GVHMR body fit · SMPL-X", 124, 246, ramp(t, 9.6, 10.4), { size: 28, weight: 500, color: INK3 });
  },
};

// a chess legend, full frame: the body LHM++ built from public photos pulling together out of its own Gaussians
function legend(key: string, file: string, name: string, from: string[], count: string): Scene {
  return {
    key,
    dur: 9,
    gl: { x: 760, y: 0, w: 1160, h: 1080 },
    async mount(host, s) {
      const { mountForming } = await import("@/lib/three/forming");
      return mountForming(host, file, { amount: () => ramp(s.t, 0.6, 6.2), active: () => true, failed: () => {} });
    },
    preroll: { t: 0, seconds: 1, waitMs: 1200 },
    draw(g, t) {
      rise(g, name, 120, 300, ramp(t, 0.3, 1.1), { size: 84, track: -2 });
      from.forEach((l, i) => rise(g, l, 124, 372 + i * 48, ramp(t, 0.9 + i * 0.25, 1.7 + i * 0.25), { size: 34, weight: 500, color: INK2 }));
      rise(g, "LHM++ builds his body.", 120, 600, ramp(t, 3.0, 3.8), { size: 44 });
      rise(g, "UIKA rebuilds his face.", 120, 668, ramp(t, 4.6, 5.4), { size: 44 });
      rise(g, count, 120, 780, ramp(t, 6.0, 6.8), { size: 30, weight: 600, color: INK3 });
      text(g, `Stockfish at ${name}'s peak rating. Not affiliated.`, 120, 990, { size: 26, weight: 500, color: INK3, alpha: ramp(t, 0.3, 1.1) });
    },
  };
}
const bobby = legend("bobby", "/dreams/bobby-fischer-uika/avatar/avatar.ply", "Bobby Fischer",
  ["from 6 photos,", "1966 and 1972, colorized"], "217,331 Gaussians · 55 joints");
const magnus = legend("magnus", "/dreams/magnus-carlsen-uika-360/avatar/avatar.ply", "Magnus Carlsen",
  ["from 14 public photos,", "2015 to 2017"], "197,285 Gaussians · 55 joints");

// Court Side (Vishal's ?mode=court): the bundle's two freeze.ply files, copied to public/media/court/ (from the
// broadcast, so never in git), in the court's own space; yaw 0 is the broadcast camera's side
const COURT_PLAYERS: CourtPlayer[] = [
  { splats: "/media/court/luka.ply", shadow: { image: "/media/court/luka-shadow.png", rect: [4.244, 0.868, 6.432, 2.838] } },
  { splats: "/media/court/gobert.ply", shadow: { image: "/media/court/gobert-shadow.png", rect: [6.298, -0.189, 8.764, 2.039] } },
];
const BROADCAST: [number, number, number] = [-16.5605, 0.7575, 2.7798];
const COURT_LABEL = "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players.";

const court: Scene = {
  key: "court",
  dur: 9,
  async mount(host, s) {
    const { mountCourt } = await import("@/lib/three/court");
    return mountCourt(host, COURT_PLAYERS, BROADCAST, {
      reveal: () => ramp(s.t, 0.5, 2.8),
      yaw: () => lerp(-0.35, 0.65, s.t / 9),
      shift: 0.17, // full frame, so their floor fades into the black instead of stopping at a box's edge
      failed: () => {},
    });
  },
  preroll: { t: 0, seconds: 1, waitMs: 1500 },
  draw(g, t) {
    rise(g, "Court Side", 120, 300, ramp(t, 0.3, 1.1), { size: 84, track: -2 });
    ["One real NBA play,", "rebuilt at real size."].forEach((l, i) =>
      rise(g, l, 124, 372 + i * 48, ramp(t, 0.9 + i * 0.25, 1.7 + i * 0.25), { size: 34, weight: 500, color: INK2 }));
    rise(g, "Freeze it mid-air.", 120, 600, ramp(t, 3.0, 3.8), { size: 44 });
    rise(g, "Walk around it.", 120, 668, ramp(t, 4.6, 5.4), { size: 44 });
    rise(g, "425,000 Gaussians · 2 players", 120, 780, ramp(t, 6.0, 6.8), { size: 30, weight: 600, color: INK3 });
    text(g, COURT_LABEL, 120, 990, { size: 26, weight: 500, color: INK3, alpha: ramp(t, 0.3, 1.1) });
  },
};

// ------------------------------------------------------------------------------------------------------ source cards
// Where each person came from, before they're in the room: the original (a clip, or the photos) on black with one
// plain line, then it glides into a small card in the corner while the headset footage comes up behind it, holds
// with its credit, and goes. Clips and photos come from ~/Downloads/lucid-video through the dev-only media route.

const media = (p: string) => `/api/film/media?p=${encodeURIComponent(p)}`;

interface Shot {
  src: string; // a polished select (demo/film/steady.py), under ~/Downloads/lucid-video
  in?: number;
  dur: number;
}
interface SourceSpec {
  key: string;
  video?: { src: string; in: number }; // the original clip, from `in`
  photos?: string[]; // or the photos the person was made from, the first one in front
  line: string; // under the original: "One video."
  credit: string; // who made it, small
  shots: Shot[]; // the headset footage it becomes, hard cuts between
  label?: string; // a public figure: who they are not, over the headset footage
}

const INTRO = 1.8; // the original on its own
const GLIDE = 1.0; // into the corner, the headset footage coming up behind
const HOLD = 2.4; // the corner card's stay
const smooth = (x: number) => {
  const t = clamp(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

function videoEl(src: string): Promise<HTMLVideoElement> {
  return new Promise((ok, no) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.onloadeddata = () => ok(v);
    v.onerror = () => no(new Error(`no video: ${src}`));
    v.src = media(src);
    v.load();
  });
}
function imageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => no(new Error(`no image: ${src}`));
    i.src = media(src);
  });
}

/** A picture in a rounded card: a soft shadow under it over footage, and a hairline edge. */
function card(g: CanvasRenderingContext2D, img: CanvasImageSource, x: number, y: number, w: number, h: number, r: number, alpha: number, lift: number) {
  if (alpha <= 0.001) return;
  g.save();
  g.globalAlpha = alpha;
  if (lift > 0) {
    g.shadowColor = `rgba(0,0,0,${0.5 * lift})`;
    g.shadowBlur = 40 * lift;
    g.shadowOffsetY = 10 * lift;
  }
  round(g, x, y, w, h, r);
  g.fillStyle = "#000";
  g.fill();
  g.shadowColor = "transparent";
  g.save();
  round(g, x, y, w, h, r);
  g.clip();
  g.drawImage(img, x, y, w, h);
  g.restore();
  round(g, x + 0.5, y + 0.5, w - 1, h - 1, r);
  g.strokeStyle = `rgba(255,255,255,${0.16 + 0.08 * lift})`;
  g.lineWidth = 1.5;
  g.stroke();
  g.restore();
}

/** Small type over footage: a soft shadow so it reads on anything. */
function overText(g: CanvasRenderingContext2D, s: string, x: number, y: number, o: TextOpts) {
  g.save();
  g.shadowColor = "rgba(0,0,0,0.55)";
  g.shadowBlur = 14;
  g.shadowOffsetY = 1;
  text(g, s, x, y, o);
  g.restore();
}

function sourceCard(spec: SourceSpec): Scene {
  const total = spec.shots.reduce((a, b) => a + b.dur, 0);
  const hold = Math.min(HOLD, Math.max(0.8, total - GLIDE - 0.6));
  const out0 = INTRO + GLIDE + hold; // the corner card starts to go
  let src: HTMLVideoElement | null = null;
  let photos: HTMLImageElement[] = [];
  const shots: { v: HTMLVideoElement; t0: number; in: number; dur: number }[] = [];
  return {
    key: spec.key,
    dur: INTRO + total,
    async prepare(s) {
      if (spec.video) {
        src = await videoEl(spec.video.src);
        const v0 = spec.video.in;
        s.clips.push({ v: src, at: (t) => (t <= out0 + 0.6 ? v0 + t : null) });
      }
      if (spec.photos) photos = await Promise.all(spec.photos.map(imageEl));
      let t0 = INTRO;
      for (const sh of spec.shots) {
        const v = await videoEl(sh.src);
        const k = { v, t0, in: sh.in ?? 0, dur: sh.dur };
        shots.push(k);
        // the first shot is under the glide already, from its own first frame
        s.clips.push({ v, at: (t) => (t >= k.t0 - (k.t0 === INTRO ? GLIDE : 0) - 0.05 && t < k.t0 + k.dur ? k.in + Math.max(0, t - k.t0) : null) });
        t0 += sh.dur;
      }
    },
    draw(g, t) {
      const glide = smooth((t - INTRO) / GLIDE);
      const outK = 1 - ramp(t, out0, out0 + 0.5);

      // the headset footage: up from black under the glide, a touch of push-in settling
      const shot = shots.find((k) => t < k.t0 + k.dur) ?? shots[shots.length - 1];
      if (shot && t >= INTRO - 0.02) {
        const up = ramp(t, INTRO, INTRO + 0.7);
        const z = lerp(1.035, 1, smooth((t - INTRO) / 1.6));
        g.save();
        g.globalAlpha = up;
        g.drawImage(shot.v, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
        g.restore();
      }

      // the original: its picture and shape (the front photo for a set of photos)
      const front: CanvasImageSource | null = src ?? photos[0] ?? null;
      if (!front) return;
      const fw = src ? src.videoWidth : photos[0].naturalWidth;
      const fh = src ? src.videoHeight : photos[0].naturalHeight;
      const a = fw / Math.max(1, fh);
      // big: as large as fits above its line; small: the corner card
      const bh = a >= 1 ? Math.min(760, 1360 / a) : 780;
      const bw = bh * a;
      const bx = (W - bw) / 2;
      const by = 110 + (780 - bh) / 2;
      const sh = a >= 1 ? 380 / a : 300;
      const sw = sh * a;
      const sx = 64;
      const sy = H - 64 - 36 - sh;
      const x = lerp(bx, sx, glide);
      const y = lerp(by, sy, glide);
      const w = lerp(bw, sw, glide);
      const h = lerp(bh, sh, glide);
      const inK = ramp(t, 0.05, 0.6);
      const zIn = lerp(0.965, 1, smooth(t / 0.7));

      if (photos.length > 1) {
        // the rest of the photos fanned behind the front one, dealt in from below; they fold away as it glides
        const n = photos.length;
        const fold = ramp(t, INTRO - 0.1, INTRO + 0.35);
        for (let i = n - 1; i >= 1; i--) {
          const d = ramp(t, 0.08 + i * 0.09, 0.5 + i * 0.09);
          if (d <= 0.001) continue;
          const p = photos[i];
          const ph = bh * 0.86;
          const pw = ph * (p.naturalWidth / Math.max(1, p.naturalHeight));
          const k = (i - 1) / Math.max(1, n - 2) - 0.5; // -0.5..0.5 across the fan
          const ang = k * 0.42 * (1 - fold);
          const cx = W / 2 + k * Math.min(980, 190 * (n - 1)) * (1 - fold);
          const cy = by + bh / 2 + 24 + Math.abs(k) * 40 * (1 - fold) + (1 - d) * 260;
          g.save();
          g.translate(cx, cy);
          g.rotate(ang);
          card(g, p, -pw / 2, -ph / 2, pw, ph, 22, d * (1 - fold) * inK, 1);
          g.restore();
        }
      }
      g.save();
      if (glide < 0.001) {
        g.translate(W / 2, by + bh / 2);
        g.scale(zIn, zIn);
        g.translate(-W / 2, -(by + bh / 2));
      }
      card(g, front, x, y, w, h, lerp(26, 16, glide), inK * outK, glide);
      g.restore();

      // the line under the original, and its credit; then the credit under the corner card
      const lineK = inK * (1 - ramp(t, INTRO - 0.05, INTRO + 0.3));
      rise(g, spec.line, W / 2, by + bh + 92, ramp(t, 0.35, 1.0) * lineK, { size: 50, align: "center", track: -0.8 });
      text(g, spec.credit, W / 2, by + bh + 140, { size: 26, weight: 500, color: INK3, align: "center", alpha: ramp(t, 0.6, 1.2) * lineK });
      const capK = ramp(t, INTRO + GLIDE - 0.2, INTRO + GLIDE + 0.3) * outK;
      if (capK > 0.001) overText(g, spec.credit, sx + 2, sy + sh + 30, { size: 21, weight: 500, color: "rgba(245,245,247,0.86)", alpha: capK });
      if (spec.label)
        overText(g, spec.label, W - 64, H - 64 - 6, { size: 21, weight: 500, color: "rgba(245,245,247,0.8)", align: "right", alpha: ramp(t, INTRO + 0.4, INTRO + 1.0) });
    },
  };
}

// The warp: the original (a clip, or a fan of photos) plays in its card with one line; then the card rushes forward to
// fill the frame, the original blurring and swelling past you as your headset view takes its place inside the same
// shape, the corners opening out. Like opening an app, into the room.
const W_INTRO = 1.35; // the original on its own (photos: dealt in first)
const W_MORPH = 0.95; // the rush
function warpCard(spec: SourceSpec): Scene {
  const intro = spec.photos ? W_INTRO + 0.35 : W_INTRO;
  const total = spec.shots.reduce((a, b) => a + b.dur, 0);
  let src: HTMLVideoElement | null = null;
  let photos: HTMLImageElement[] = [];
  const shots: { v: HTMLVideoElement; t0: number; in: number; dur: number }[] = [];
  return {
    key: spec.key,
    dur: intro + total,
    async prepare(s) {
      if (spec.video) {
        src = await videoEl(spec.video.src);
        const v0 = spec.video.in;
        s.clips.push({ v: src, at: (t) => (t <= intro + W_MORPH + 0.1 ? v0 + t : null) });
      }
      if (spec.photos) photos = await Promise.all(spec.photos.map(imageEl));
      let t0 = intro;
      for (const sh of spec.shots) {
        const v = await videoEl(sh.src);
        const k = { v, t0, in: sh.in ?? 0, dur: sh.dur };
        shots.push(k);
        // the first shot is already playing inside the card as it rushes in
        s.clips.push({ v, at: (t) => (t >= k.t0 - (k.t0 === intro ? W_MORPH : 0) - 0.05 && t < k.t0 + k.dur ? k.in + Math.max(0, t - k.t0) : null) });
        t0 += sh.dur;
      }
    },
    draw(g, t) {
      const front: CanvasImageSource | null = src ?? photos[0] ?? null;
      if (!front) return;
      const fw = src ? src.videoWidth : photos[0].naturalWidth;
      const fh = src ? src.videoHeight : photos[0].naturalHeight;
      const a = fw / Math.max(1, fh);
      const bh = a >= 1 ? Math.min(700, 1240 / a) : 760;
      const bw = bh * a;
      const bx = (W - bw) / 2;
      const by = 120 + (760 - bh) / 2;
      const m = smooth((t - (intro - W_MORPH * 0.15)) / W_MORPH); // the rush, 0 -> 1
      const inK = ramp(t, 0.05, 0.55);

      // after the rush: the headset view, full frame, settling from a touch of overshoot
      const shot = shots.find((k) => t < k.t0 + k.dur) ?? shots[shots.length - 1];
      if (m >= 0.999) {
        const z = lerp(1.04, 1, smooth((t - intro - W_MORPH * 0.85) / 1.2));
        g.drawImage(shot.v, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
      } else {
        // the photos fanned behind the front one, folding away as the rush starts
        if (photos.length > 1) {
          const n = photos.length;
          const fold = ramp(t, intro - 0.45, intro - 0.05);
          for (let i = n - 1; i >= 1; i--) {
            const d = ramp(t, 0.08 + i * 0.08, 0.45 + i * 0.08);
            if (d <= 0.001) continue;
            const p = photos[i];
            const ph = bh * 0.86;
            const pw = ph * (p.naturalWidth / Math.max(1, p.naturalHeight));
            const k = (i - 1) / Math.max(1, n - 2) - 0.5;
            g.save();
            g.translate(W / 2 + k * Math.min(980, 190 * (n - 1)) * (1 - fold), by + bh / 2 + 24 + Math.abs(k) * 40 * (1 - fold) + (1 - d) * 260);
            g.rotate(k * 0.42 * (1 - fold));
            card(g, p, -pw / 2, -ph / 2, pw, ph, 22, d * (1 - fold) * inK, 1);
            g.restore();
          }
        }
        // the card growing to the frame: the original swelling and blurring away, the headset view clearing in
        const x = lerp(bx, 0, m);
        const y = lerp(by, 0, m);
        const w = lerp(bw, W, m);
        const h = lerp(bh, H, m);
        const r = lerp(26, 0, m);
        g.save();
        g.globalAlpha = inK;
        round(g, x, y, w, h, r);
        g.clip();
        g.fillStyle = "#000";
        g.fillRect(x, y, w, h);
        if (m > 0.001 && shot) {
          // the view inside: cover-fit to the growing shape
          const s2 = Math.max(w / W, h / H);
          g.globalAlpha = inK * smooth(m * 1.15);
          g.drawImage(shot.v, x + (w - W * s2) / 2, y + (h - H * s2) / 2, W * s2, H * s2);
        }
        const zo = 1 + 0.35 * m * m; // the original rushes past, a little faster than the frame grows
        g.globalAlpha = inK * (1 - smooth(m * 1.25));
        g.filter = m > 0.01 ? `blur(${(m * 14).toFixed(1)}px)` : "none";
        g.drawImage(front, x + (w - w * zo) / 2, y + (h - h * zo) / 2, w * zo, h * zo);
        g.filter = "none";
        g.restore();
        if (m < 0.02) {
          round(g, bx + 0.5, by + 0.5, bw - 1, bh - 1, 26);
          g.strokeStyle = `rgba(255,255,255,${0.16 * inK})`;
          g.lineWidth = 1.5;
          g.stroke();
        }
      }
      // the line and credit under the original, gone as the rush starts
      const lineK = inK * (1 - ramp(t, intro - W_MORPH * 0.25, intro));
      rise(g, spec.line, W / 2, by + bh + 84, ramp(t, 0.25, 0.85) * lineK, { size: 48, align: "center", track: -0.8 });
      text(g, spec.credit, W / 2, by + bh + 130, { size: 25, weight: 500, color: INK3, align: "center", alpha: ramp(t, 0.45, 1.0) * lineK });
      if (spec.label)
        overText(g, spec.label, W - 64, H - 64 - 6, { size: 21, weight: 500, color: "rgba(245,245,247,0.8)", align: "right", alpha: ramp(t, intro + 0.3, intro + 0.9) });
    },
  };
}

const WARPS: Scene[] = [
  warpCard({ key: "warp-guitar", video: { src: "sources/guitar-01.mp4", in: 6.0 }, line: "One video.", credit: "Khanh Hoang Minh 2 · Pexels",
    shots: [{ src: "selects/guitar-appear.mp4", dur: 2.0 }, { src: "selects/guitar-follow.mp4", dur: 3.9 }] }),
  warpCard({ key: "warp-golf", video: { src: "sources/golf-01.mp4", in: 3.0 }, line: "One video.", credit: "Be The Observer · Pexels",
    shots: [{ src: "selects/golf-swing.mp4", dur: 1.7 }, { src: "selects/golf-you.mp4", dur: 2.6 }] }),
  warpCard({ key: "warp-lebron", video: { src: "sources/lebron-shot.mp4", in: 3.0 }, line: "One video.", credit: "His training footage · demo use only",
    shots: [{ src: "selects/lebron2-drill.mp4", in: 0.1, dur: 1.6 }],
    label: "His likeness, from his footage. Not affiliated." }),
  warpCard({ key: "warp-federer", photos: ["rf-wimbledon09-js-02", "rf-wimbledon09-js-03", "rf-wimbledon09-js-05", "rf-wimbledon09-js-06",
      "rf-wimbledon09-js-07", "rf-wimbledon09-sk", "rf-wimbledon09-sk-2", "rf-wimbledon09-js-10"].map((f) => `sources/photos/roger-federer-src/${f}.jpg`),
    line: "14 photos.", credit: "Wimbledon 2009 · Wikimedia Commons",
    shots: [{ src: "selects/tennis-shake.mp4", dur: 3.0 }, { src: "selects/tennis-face.mp4", dur: 1.7 }],
    label: "Roger Federer's likeness. AI opponent, not affiliated." }),
  warpCard({ key: "warp-magnus", photos: ["n3s-2299", "x-tata2017-standing", "n3s-2307", "x-berlin2015-prize", "n3s-2314", "x-olympiad2016", "n3s-2320",
      "x-tata2017-profile"].map((f) => `sources/photos/magnus-carlsen-360/${f}.jpg`),
    line: "14 photos.", credit: "2015 to 2017 · Wikimedia Commons",
    shots: [{ src: "selects/magnus-wide.mp4", dur: 2.0 }, { src: "selects/magnus-look.mp4", dur: 2.0 }],
    label: "Stockfish at Carlsen's peak rating. Not affiliated." }),
  warpCard({ key: "warp-vishal", video: { src: "sources/vishal.mp4", in: 0 }, line: "One phone video.", credit: "Vishal, turning around once",
    shots: [{ src: "selects/vishal-appear.mp4", in: 0.5, dur: 3.0 }] }),
];

// Gemma writing the lesson (Atina's planner, demo/gemma-plans/guitar-01.json on her branch): the sentence, the eight
// frames it reads from the clip, then its plan as it wrote it. Its real output, word for word.
const GEMMA_PLAN = {
  intent: "teach me this strum pattern",
  title: "Basic Strumming Technique",
  steps: [
    { at: "0.0 – 1.0 s", title: "Positioning the instrument", how: "½ speed · twice" },
    { at: "1.0 – 2.5 s", title: "The initial strumming motion", how: "½ speed · twice" },
    { at: "2.5 – 4.8 s", title: "Sustain the rhythm", how: "½ speed · twice" },
  ],
  chips: ["Beside you", "Guitar"],
};

const gemma: Scene = (() => {
  const frames: HTMLCanvasElement[] = [];
  return {
    key: "gemma",
    dur: 6,
    async prepare() {
      const v = await videoEl("sources/guitar-01.mp4");
      for (let k = 0; k < 8; k++) {
        await new Promise<void>((r) => {
          v.onseeked = () => r();
          v.currentTime = 6.0 + k * 0.6;
        });
        const c = document.createElement("canvas");
        c.width = 320;
        c.height = 180;
        c.getContext("2d")!.drawImage(v, 0, 0, 320, 180);
        frames.push(c);
      }
    },
    draw(g, t) {
      // the sentence, typed
      const typed = GEMMA_PLAN.intent.slice(0, Math.round(clamp((t - 0.2) / 0.9) * GEMMA_PLAN.intent.length));
      const caret = t < 1.4 && Math.floor(t * 2.4) % 2 === 0 ? "|" : "";
      text(g, `“${typed}${typed.length === GEMMA_PLAN.intent.length ? "”" : ""}${caret}`, W / 2, 230, { size: 52, align: "center", track: -0.6, alpha: ramp(t, 0.05, 0.3) });

      // the eight frames it reads, and the read passing over them
      const fw = 150;
      const fh = 84;
      const gap = 10;
      const x0 = (W - (8 * fw + 7 * gap)) / 2;
      const scan = clamp((t - 1.7) / 0.8);
      frames.forEach((f, k) => {
        const a = ramp(t, 1.0 + k * 0.06, 1.35 + k * 0.06);
        const x = x0 + k * (fw + gap);
        g.save();
        g.globalAlpha = a * (scan > 0 && scan < 1 && Math.abs(scan * 8 - (k + 0.5)) < 0.7 ? 1 : 0.82);
        round(g, x, 300 + (1 - a) * 14, fw, fh, 10);
        g.clip();
        g.drawImage(f, x, 300 + (1 - a) * 14, fw, fh);
        g.restore();
      });
      if (scan > 0 && scan < 1) {
        const sx = x0 + scan * (8 * fw + 7 * gap);
        const grad = g.createLinearGradient(sx - 60, 0, sx + 2, 0);
        grad.addColorStop(0, "rgba(41,151,255,0)");
        grad.addColorStop(1, "rgba(41,151,255,0.55)");
        g.fillStyle = grad;
        g.fillRect(sx - 60, 296, 62, fh + 8);
      }
      text(g, "Gemma 4 reads eight frames of the clip, on a laptop", W / 2, 432, { size: 24, weight: 500, color: INK3, align: "center", alpha: ramp(t, 1.6, 2.1) });

      // its plan
      const k0 = ramp(t, 2.5, 3.0);
      if (k0 > 0.001) {
        const cw = 980;
        const cx = (W - cw) / 2;
        const cy = 500 + (1 - k0) * 16;
        g.save();
        g.globalAlpha = k0;
        round(g, cx, cy, cw, 400, 28);
        g.fillStyle = "#151517";
        g.fill();
        g.strokeStyle = "rgba(255,255,255,0.1)";
        g.lineWidth = 1.5;
        g.stroke();
        g.restore();
        text(g, "LESSON", cx + 48, cy + 62, { size: 18, weight: 600, color: "#2997ff", track: 2, alpha: k0 });
        text(g, GEMMA_PLAN.title, cx + 48, cy + 112, { size: 40, track: -0.5, alpha: k0 });
        GEMMA_PLAN.steps.forEach((st, i) => {
          const a = ramp(t, 3.1 + i * 0.35, 3.5 + i * 0.35);
          const y = cy + 182 + i * 62;
          text(g, st.at, cx + 48, y, { size: 22, weight: 500, color: INK3, alpha: a });
          text(g, st.title, cx + 230, y, { size: 28, weight: 500, alpha: a });
          text(g, st.how, cx + cw - 48, y, { size: 22, weight: 500, color: INK2, align: "right", alpha: a });
        });
        GEMMA_PLAN.chips.forEach((c, i) => {
          const a = ramp(t, 4.3 + i * 0.15, 4.7 + i * 0.15);
          const x = cx + 48 + i * 170;
          const y = cy + 352;
          g.save();
          g.globalAlpha = a;
          round(g, x, y - 26, 150, 40, 20);
          g.fillStyle = "rgba(41,151,255,0.16)";
          g.fill();
          g.restore();
          text(g, c, x + 75, y + 1, { size: 20, weight: 600, color: "#2997ff", align: "center", alpha: a });
        });
      }
    },
  };
})();

const SOURCES: Scene[] = [
  sourceCard({
    key: "source-guitar",
    video: { src: "sources/guitar-01.mp4", in: 6.0 },
    line: "One video.",
    credit: "Khanh Hoang Minh 2 · Pexels",
    shots: [{ src: "selects/guitar-appear.mp4", dur: 2.0 }, { src: "selects/guitar-follow.mp4", dur: 3.6 }],
  }),
  sourceCard({
    key: "source-vishal",
    video: { src: "sources/vishal.mp4", in: 0 },
    line: "One phone video.",
    credit: "Vishal, turning around once",
    shots: [{ src: "selects/vishal-appear.mp4", in: 0.5, dur: 3.0 }, { src: "selects/vishal-around.mp4", dur: 3.3 }],
  }),
  sourceCard({
    key: "source-federer",
    photos: ["rf-wimbledon09-js-02", "rf-wimbledon09-js-03", "rf-wimbledon09-js-05", "rf-wimbledon09-js-06", "rf-wimbledon09-js-07",
      "rf-wimbledon09-sk", "rf-wimbledon09-sk-2", "rf-wimbledon09-js-10"].map((f) => `sources/photos/roger-federer-src/${f}.jpg`),
    line: "14 photos.",
    credit: "Wimbledon 2009 · Wikimedia Commons",
    shots: [{ src: "selects/tennis-walkup.mp4", dur: 0.75 }, { src: "selects/tennis-shake.mp4", dur: 3.0 }, { src: "selects/tennis-face.mp4", dur: 1.7 }],
    label: "Roger Federer's likeness. AI opponent, not affiliated.",
  }),
  sourceCard({
    key: "source-bobby",
    photos: ["01-1966-portrait", "02-1972-verhoeff", "06-hilton-925-3515", "07-hilton-925-3516", "08-hilton-925-3513", "09-fischer-euwe-amsterdam"]
      .map((f) => `sources/photos/bobby-fischer-suit/${f}.jpg`),
    line: "6 photos.",
    credit: "1966 and 1972 · AP, Nationaal Archief · colorized",
    shots: [{ src: "selects/bobby-face.mp4", dur: 3.3 }],
    label: "Stockfish at Fischer's peak rating. Not affiliated.",
  }),
  sourceCard({
    key: "source-magnus",
    photos: ["n3s-2299", "x-tata2017-standing", "n3s-2307", "x-berlin2015-prize", "n3s-2314", "x-olympiad2016", "n3s-2320", "x-tata2017-profile"]
      .map((f) => `sources/photos/magnus-carlsen-360/${f}.jpg`),
    line: "14 photos.",
    credit: "2015 to 2017 · Wikimedia Commons",
    shots: [{ src: "selects/magnus-wide.mp4", dur: 2.0 }, { src: "selects/magnus-look.mp4", dur: 2.0 }],
    label: "Stockfish at Carlsen's peak rating. Not affiliated.",
  }),
  sourceCard({
    key: "source-golf",
    video: { src: "sources/golf-01.mp4", in: 3.0 },
    line: "One video.",
    credit: "Be The Observer · Pexels",
    shots: [{ src: "selects/golf-swing.mp4", dur: 1.7 }, { src: "selects/golf-you.mp4", dur: 2.6 }, { src: "selects/golf-match.mp4", dur: 2.2 }],
  }),
  sourceCard({
    key: "source-lebron",
    video: { src: "sources/lebron-shot.mp4", in: 3.0 },
    line: "One video.",
    credit: "His training footage · demo use only",
    shots: [{ src: "selects/lebron-dribble.mp4", dur: 3.1 }, { src: "selects/lebron-make.mp4", dur: 2.8 }],
    label: "His likeness, from his footage. Not affiliated.",
  }),
  sourceCard({
    key: "source-grandma",
    video: { src: "sources/ian-grandma.mp4", in: 0 },
    line: "One family video.",
    credit: "Ian's grandmother",
    shots: [{ src: "selects/grandma-appear.mp4", dur: 2.6 }],
  }),
];

// "Fresh off the frontier" (the hackathon's theme), answered: the last twelve months as a line drawing itself across the
// frame, the models at the core landing on it at their release, and us at the end. Dates from AGENTS.md (the new tech).
const FRONTIER = [
  { at: 4.5, name: "LHM++", what: "a body from photos", when: "Mar 2026" },
  { at: 7.5, name: "UIKA", what: "a face from photos", when: "Jun 2026" },
  { at: 9.5, name: "4DAnyone", what: "one video, every angle", when: "Aug 2026" },
  { at: 11.6, name: "Lucid Dreams", what: "", when: "Oct 2026", us: true },
];
const frontier: Scene = {
  key: "frontier",
  dur: 6,
  draw(g, t) {
    rise(g, "Fresh off the frontier.", W / 2, 250, ramp(t, 0.1, 0.8), { size: 76, align: "center", track: -1.5 });
    rise(g, "Every model at its core came out in the last twelve months.", W / 2, 318, ramp(t, 0.5, 1.2), {
      size: 30, weight: 500, color: INK2, align: "center" });
    // the year: Nov 2025 -> Oct 2026, drawn left to right with a soft glow at its head
    const x0 = 200, x1 = W - 200, y = 620;
    const k = smooth((t - 0.6) / 2.6);
    const xm = (m: number) => x0 + (m / 12) * (x1 - x0); // m: months from Nov 2025
    g.save();
    g.strokeStyle = "rgba(255,255,255,0.22)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(lerp(x0, x1, k), y);
    g.stroke();
    if (k > 0 && k < 1) {
      const hx = lerp(x0, x1, k);
      const glow = g.createRadialGradient(hx, y, 0, hx, y, 60);
      glow.addColorStop(0, "rgba(120,180,255,0.9)");
      glow.addColorStop(1, "rgba(120,180,255,0)");
      g.fillStyle = glow;
      g.fillRect(hx - 60, y - 60, 120, 120);
    }
    g.restore();
    ["Nov 2025", "Feb", "May", "Aug", "Oct 2026"].forEach((lb, i) => {
      const m = [0, 3, 6, 9, 11.6][i];
      text(g, lb, xm(m), y + 54, { size: 20, weight: 500, color: INK3, align: "center", alpha: ramp(t, 0.6 + (m / 12) * 2.6, 1.0 + (m / 12) * 2.6) });
    });
    // each model lands when the line reaches it: a dot that springs in, its name above, what it does and when below
    FRONTIER.forEach((f, i) => {
      const reach = 0.6 + (f.at / 12) * 2.6;
      const a = ramp(t, reach, reach + 0.35);
      if (a <= 0.001) return;
      const x = xm(f.at);
      const pop = 1 + 0.6 * Math.sin(Math.min(1, (t - reach) / 0.35) * Math.PI) * (1 - Math.min(1, (t - reach) / 0.7));
      g.save();
      g.globalAlpha = a;
      g.beginPath();
      g.arc(x, y, (f.us ? 11 : 8) * pop, 0, Math.PI * 2);
      g.fillStyle = f.us ? BLUE : "#f5f5f7";
      g.fill();
      if (f.us) {
        g.beginPath();
        g.arc(x, y, 22 * pop, 0, Math.PI * 2);
        g.strokeStyle = "rgba(41,151,255,0.5)";
        g.lineWidth = 2;
        g.stroke();
      }
      g.restore();
      const up = i % 2 === 0;
      rise(g, f.name, x, up ? y - 70 : y - 70, ramp(t, reach + 0.05, reach + 0.6), { size: f.us ? 40 : 36, align: "center", color: f.us ? BLUE : INK, track: -0.5 });
      if (f.what) text(g, f.what, x, y - 34, { size: 22, weight: 500, color: INK2, align: "center", alpha: ramp(t, reach + 0.2, reach + 0.7) });
      text(g, f.when, x, y + 96, { size: 22, weight: 600, color: f.us ? BLUE : INK2, align: "center", alpha: ramp(t, reach + 0.2, reach + 0.7) });
    });
  },
};

/** The same freeze full frame, turning slowly with no type: an insert for the cut, and the website card's still. */
const courtOrbit: Scene = {
  key: "court-orbit",
  dur: 8,
  async mount(host, s) {
    const { mountCourt } = await import("@/lib/three/court");
    return mountCourt(host, COURT_PLAYERS, BROADCAST, { reveal: () => 1, yaw: () => lerp(-1.1, 1.1, s.t / 8), failed: () => {} });
  },
  preroll: { t: 0, seconds: 1, waitMs: 1500 },
  draw() {},
};

// the frame-budget heat map: black, deep blue, the site's blue, light blue, white
const STOPS: [number, [number, number, number]][] = [
  [0, [6, 8, 14]],
  [0.18, [10, 28, 74]],
  [0.42, [20, 82, 184]],
  [0.64, [41, 151, 255]],
  [0.84, [140, 200, 255]],
  [1, [255, 255, 255]],
];
function ramp3(v: number): [number, number, number] {
  const t = v / 255;
  let k = 1;
  while (k < STOPS.length - 1 && STOPS[k][0] < t) k++;
  const [t0, c0] = STOPS[k - 1];
  const [t1, c1] = STOPS[k];
  const f = clamp((t - t0) / Math.max(1e-6, t1 - t0));
  return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
}
const heatCache = new Map<number, HTMLCanvasElement>();
function heatImage(s: Shared, state: number): HTMLCanvasElement | null {
  if (!s.heat) return null;
  if (heatCache.has(state)) return heatCache.get(state)!;
  const p = meta.people.jump;
  const st = p.states[state];
  const c = document.createElement("canvas");
  c.width = p.w;
  c.height = p.h;
  const cg = c.getContext("2d")!;
  const img = cg.createImageData(p.w, p.h);
  for (let i = 0; i < p.w * p.h; i++) {
    const [r, gg, b] = ramp3(s.heat[st.offset + i]);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  cg.putImageData(img, 0, 0);
  heatCache.set(state, c);
  return c;
}

const headset: Scene = {
  key: "headset",
  dur: 14,
  async prepare(s) {
    try {
      s.heat = new Uint8Array(await (await fetch(s.data.overdraw)).arrayBuffer());
    } catch {
      s.heat = null;
    }
  },
  async mount(host, s) {
    const { mountHeadset } = await import("@/lib/three/headset");
    return mountHeadset(host, { progress: () => clamp(s.t / 8.8), failed: () => {}, person: s.data.frame });
  },
  preroll: { t: 0, seconds: 1, waitMs: 1500 },
  draw(g, t, s) {
    text(g, "Meta Quest 3S", 120, 120, { size: 28, weight: 600, color: INK3, alpha: span(t, 0.4, 1.2, 8.0, 8.6) });
    // then the cost of one person, as a picture
    const dark = ramp(t, 8.4, 9.2);
    if (dark <= 0.001) return;
    g.save();
    g.globalAlpha = dark;
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    g.restore();
    const p = meta.people.jump;
    const stateAt = (tt: number) => (tt < 10.9 ? 0 : tt < 12.4 ? 1 : 2);
    const st = stateAt(t);
    const blend = st === 0 ? 0 : ramp(t, st === 1 ? 10.9 : 12.4, st === 1 ? 11.3 : 12.8);
    const scale = 3.9;
    const hw = p.w * scale;
    const hh = p.h * scale;
    const hx = 330;
    const hy = (H - hh) / 2 + 10;
    const k = ramp(t, 9.0, 9.8);
    g.save();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    const prev = heatImage(s, Math.max(0, st - 1));
    const cur = heatImage(s, st);
    if (cur) {
      if (st > 0 && prev && blend < 1) {
        g.globalAlpha = k;
        g.drawImage(prev, hx, hy, hw, hh);
        g.globalAlpha = k * blend;
        g.drawImage(cur, hx, hy, hw, hh);
      } else {
        g.globalAlpha = k;
        g.drawImage(cur, hx, hy, hw, hh);
      }
    }
    g.restore();
    const vals = p.states.map((x) => x.pixels / 1e6);
    const shownM = st === 0 ? vals[0] : lerp(vals[st - 1], vals[st], blend);
    rise(g, `${Math.round(shownM)}M`, 1000, 520, k, { size: 190, weight: 700, track: -7 });
    rise(g, "pixels shaded per eye, every frame", 1008, 584, k, { size: 34, weight: 500, color: INK2 });
    const labels = ["Every Gaussian, as drawn by default", "The 160,000 that matter most", "When frames run late"];
    labels.forEach((l, i) => {
      const on = st === i ? 1 : 0.35;
      text(g, l, 1008, 690 + i * 52, { size: 30, weight: st === i ? 600 : 500, color: st === i ? INK : INK3, alpha: k * on });
    });
    text(g, "layers on each point of him, face on from 1.8 m", hx, hy + hh + 52, { size: 24, weight: 500, color: INK3, alpha: k });
  },
};

const talk: Scene = {
  key: "talk",
  dur: 9,
  draw(g, t, s) {
    const tk = s.data.vishal.talk ?? { heard: 1.5, wrote: 1.0, spoke: 0.5, total: 3.1, n: 11 };
    rise(g, "Ask him anything.", W / 2, 230, ramp(t, 0.2, 1.0), { size: 72, align: "center", track: -1.5 });
    // your question, as sound
    const env = s.data.vishal.env.length ? s.data.vishal.env : Array.from({ length: 120 }, () => 0.4);
    const x0 = 360;
    const x1 = 1560;
    const bw = (x1 - x0) / env.length;
    const shownBars = env.length * ramp(t, 0.6, 2.6);
    for (let i = 0; i < env.length; i++) {
      const on = i < shownBars;
      const h = 8 + env[i] * 170;
      g.fillStyle = on ? BLUE : "#232326";
      g.fillRect(x0 + i * bw + 1.5, 450 - h / 2, Math.max(1, bw - 3), h);
    }
    // what happens before he answers
    const segs = [
      { v: tk.heard, top: "Hears you", sub: "Whisper", c: BLUE },
      { v: tk.wrote, top: "Answers as him", sub: "a language model", c: "#8cc8ff" },
      { v: tk.spoke, top: "In his voice", sub: "ElevenLabs", c: INK },
    ];
    const total = tk.total;
    const y = 640;
    const k = ramp(t, 2.6, 3.2);
    g.save();
    g.globalAlpha = k;
    round(g, x0, y, x1 - x0, 22, 11);
    g.fillStyle = "#1d1d1f";
    g.fill();
    g.restore();
    let x = x0;
    let start = 3.0;
    for (const sg of segs) {
      const w = ((x1 - x0) * sg.v) / total;
      const dur = 0.4 + sg.v * 0.9;
      const p = ramp(t, start, start + dur);
      if (p > 0) {
        g.save();
        round(g, x, y, Math.max(2, w * p - 4), 22, 11);
        g.fillStyle = sg.c;
        g.fill();
        g.restore();
      }
      const lk = ramp(t, start + 0.1, start + 0.6);
      rise(g, sg.top, x, y + 82, lk, { size: 30, weight: 600 });
      rise(g, `${sg.v.toFixed(1)} s · ${sg.sub}`, x, y + 122, lk, { size: 26, weight: 500, color: INK2 });
      x += w;
      start += dur + 0.15;
    }
    const kt = ramp(t, start + 0.2, start + 0.9);
    rise(g, `${total.toFixed(1)} s`, W / 2, 960, kt, { size: 120, weight: 700, align: "center", track: -4 });
    rise(g, `question to answer, median of ${tk.n} real tries`, W / 2, 1010, kt, { size: 28, weight: 500, color: INK2, align: "center" });
  },
};

const STATS: [string, string][] = [
  ["Aug 2026", "4DAnyone goes public"],
  ["48", "views from one phone video"],
  ["290,000", "Gaussians in every frame"],
  ["26–32 dB", "PSNR against the views it learned"],
  ["3.1 s", "from your question to their answer"],
];
const numbers: Scene = {
  key: "numbers",
  dur: 7.5,
  draw(g, t) {
    const each = 7.5 / STATS.length;
    STATS.forEach(([v, l], i) => {
      const a = i * each;
      const k = span(t, a + 0.05, a + 0.45, a + each - 0.25, a + each + (i === STATS.length - 1 ? 9 : 0.1));
      rise(g, v, W / 2, 560, k, { size: 190, weight: 700, align: "center", track: -6 });
      rise(g, l, W / 2, 640, k, { size: 40, weight: 500, color: INK2, align: "center" });
    });
  },
};

const end: Scene = {
  key: "end",
  dur: 7,
  draw(g, t) {
    wordmark(g, t, W / 2, 428, 124, 0.3);
    rise(g, "Anyone from any video, standing in your room.", W / 2, 548, ramp(t, 1.0, 2.0), {
      size: 42,
      weight: 500,
      color: INK2,
      align: "center",
    });
    rise(g, "getluciddreams.vercel.app", W / 2, 650, ramp(t, 1.7, 2.7), { size: 36, weight: 600, color: BLUE, align: "center" });
    const k = ramp(t, 2.4, 3.4);
    text(g, "Ojasva · Vishal · Ian · Atina", W / 2, 900, { size: 30, weight: 500, color: INK3, align: "center", alpha: k });
    text(g, "Gator Hack V · University of Florida", W / 2, 944, { size: 24, weight: 500, color: INK3, align: "center", alpha: k });
    text(g, "AI voices are labeled. Public figures are likenesses, not affiliated.", W / 2, 1000, {
      size: 22,
      weight: 500,
      color: "#6e6e73",
      align: "center",
      alpha: k,
    });
  },
};

export const SCENES: Scene[] = [title, cameras, fit, reality, avatar, bobby, magnus, headset, talk, numbers, end, apart, anatomy, court, courtOrbit, gemma, ...SOURCES,
  lineup("lineup", 7.6, "Anyone.", "Each from one video, or a few photos."), frontier, ...WARPS];
