// The film's motion-graphics scenes (demo/video.md). Each is a fixed length, a 3D layer built from the website's own
// renderers (lib/three) driven by the scene clock instead of scroll, and a 2D layer of type and diagrams drawn for
// time t. Every number on screen is a measured one. 1920 x 1080.
import meta from "@/components/tech/overdraw.json";
import type { RigCamera } from "@/lib/three/story";

export const W = 1920;
export const H = 1080;

export interface FilmData {
  frame: string | null; // the dancer, one SPZ frame
  reality: string | null; // the same frame with what no camera saw in blue
  seen: number | null; // her seen fraction
  count: number | null; // her Gaussians per frame
  cameras: unknown[]; // 4DAnyone's rig for her clip
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

// ---------------------------------------------------------------------------------------------------------------- scenes

const title: Scene = {
  key: "title",
  dur: 3,
  draw(g, t) {
    rise(g, "Lucid Dreams", W / 2, 572, ramp(t, 0.25, 1.35), { size: 132, align: "center", track: -2.5 });
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
    text(g, "of 121", 120 + g.measureText(`${f}`).width * 1.9 + 24, 730, { size: 30, weight: 500, color: INK2, alpha: k });
    const n = (s.data.count ?? 289466) * ramp(t, 1.4, 9.4);
    text(g, "Gaussians in this frame", 520, 640, { size: 26, weight: 500, color: INK3, alpha: k });
    text(g, fmt(n), 520, 730, { size: 96, weight: 700, track: -3, alpha: k });
    rise(g, "7,000 Adam steps for the first frame, then 1,500 for each next one.", 120, 860, ramp(t, 2.4, 3.2), {
      size: 26,
      weight: 500,
      color: INK2,
    });
    rise(g, "L = 0.8 ‖Î − I‖₁ + 0.2 (1 − SSIM) + 0.1 ‖Â − A‖₁ + L_reg", 120, 950, ramp(t, 3.4, 4.2), {
      size: 34,
      weight: 400,
      color: INK,
      serif: true,
      italic: true,
    });
  },
};

const reality: Scene = {
  key: "reality",
  dur: 7,
  async mount(host, s) {
    if (!s.data.frame) return () => {};
    const { mountStory } = await import("@/lib/three/story");
    return mountStory(host, { frame: s.data.frame, reality: s.data.reality, cameras: s.data.cameras as RigCamera[] }, {
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
    rise(g, "Lucid Dreams", W / 2, 470, ramp(t, 0.3, 1.3), { size: 124, align: "center", track: -2.5 });
    rise(g, "Anyone from any video, standing in your room.", W / 2, 548, ramp(t, 1.0, 2.0), {
      size: 42,
      weight: 500,
      color: INK2,
      align: "center",
    });
    rise(g, "getluciddreams.vercel.app", W / 2, 650, ramp(t, 1.7, 2.7), { size: 36, weight: 600, color: BLUE, align: "center" });
    const k = ramp(t, 2.4, 3.4);
    text(g, "Ojasva · Vishal · Ian · Atina · Raami", W / 2, 900, { size: 30, weight: 500, color: INK3, align: "center", alpha: k });
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

export const SCENES: Scene[] = [title, cameras, fit, reality, avatar, headset, talk, numbers, end];
