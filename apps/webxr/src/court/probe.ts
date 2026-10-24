// The in-page half of the e2e harness (scripts/court/e2e.mjs), on only with `?probe`:
// - a fixed dt of 1 / displayHz per XR frame, so every rendered frame is one display frame of the show whatever the
//   host's rAF does (IWER runs at ~120 Hz; e2e never measures timing);
// - `?probe=capture`: every rendered frame read back in the page right after renderer.render (readPixels on IWER's
//   default framebuffer), logged as alpha min/mean, mean luma and a 16 x 9 luma thumbnail; full frames on request
//   (save(name) hands RGBA to window.__courtSave, which the runner writes as a PNG);
// - `?probe=timing`: no read-back; CPU ms per frame and GPU ms per renderer.render, per phase (stats.ts);
// - window.__court: the test API (state, seatHere, press, stepping).
// Integrator, T0.
import type { ClockState } from "./clock";
import type { FrameStats } from "./stats";
import type { Phase } from "./types";
import type { UiAction } from "./ui";

/** One rendered frame, as the e2e reads it. */
export interface ProbeFrame {
  /** Rendered XR frames since the session started. */
  n: number;
  phase: Phase;
  setup: boolean;
  /** The clock's show frame, segment and speed. */
  frame: number;
  segment: string;
  speed: number;
  /** The show frame actually on the video texture (-1 none). */
  onScreen: number;
  /** capture only: read-back alpha (0-255) min and mean, mean luma (0-255), 16 x 9 luma grid (row-major, top first). */
  alphaMin?: number;
  alphaMean?: number;
  luma?: number;
  thumb?: number[];
  /** timing only: CPU ms of the frame's work. */
  cpuMs?: number;
}

/** What court.ts gives the probe. */
export interface ProbeHooks {
  snapshot(): { phase: Phase; setup: boolean; clock: ClockState; onScreen: number; [k: string]: unknown };
  seatHere(): void;
  press(action: UiAction): void;
  modules: Record<string, boolean>;
  /** The frame log, once the bundle (and so the display rate) is known. */
  stats(): FrameStats | null;
}

/** window.__court */
export interface CourtTestApi {
  ready: boolean;
  error: string | null;
  mode: "capture" | "timing";
  modules: Record<string, boolean>;
  errors: string[];
  snapshot(): ReturnType<ProbeHooks["snapshot"]>;
  seatHere(): void;
  press(action: UiAction): void;
  /** Resolves with the next rendered frame's log. */
  nextFrame(): Promise<ProbeFrame>;
  /** Steps n rendered frames; their logs. */
  frames(n: number): Promise<ProbeFrame[]>;
  /** Steps until the phase is `phase` (or `max` frames); the logs on the way, the last one in that phase. */
  until(phase: Phase, max: number): Promise<ProbeFrame[]>;
  /** Read back the next rendered frame in full and hand it to window.__courtSave(name, w, h, base64 RGBA, top row first); a no-op when timing. */
  save(name: string): Promise<void>;
  /** The timing pass's per-phase summary (timing mode). */
  timing(): ReturnType<FrameStats["report"]> | null;
}

declare global {
  interface Window {
    __court?: CourtTestApi;
    __courtSave?: (name: string, width: number, height: number, rgbaBase64: string) => Promise<string>;
  }
}

export class Probe {
  readonly mode: "capture" | "timing";
  readonly api: CourtTestApi;
  private n = 0;
  private waiters: ((f: ProbeFrame) => void)[] = [];
  private saves: { name: string; done: () => void }[] = [];
  private buf: Uint8Array | null = null;
  private readonly hooks: ProbeHooks;

  constructor(param: string | null, hooks: ProbeHooks) {
    this.mode = param === "timing" ? "timing" : "capture";
    this.hooks = hooks;
    const api: CourtTestApi = {
      ready: false,
      error: null,
      mode: this.mode,
      modules: hooks.modules,
      errors: [],
      snapshot: () => hooks.snapshot(),
      seatHere: () => hooks.seatHere(),
      press: (action) => hooks.press(action),
      nextFrame: () => new Promise((resolve) => this.waiters.push(resolve)),
      frames: async (count) => {
        const out: ProbeFrame[] = [];
        for (let i = 0; i < count; i++) out.push(await api.nextFrame());
        return out;
      },
      until: async (phase, max) => {
        const out: ProbeFrame[] = [];
        for (let i = 0; i < max; i++) {
          const f = await api.nextFrame();
          out.push(f);
          if (f.phase === phase) break;
        }
        return out;
      },
      // timing mode never reads back, so a save there is a no-op (it would never resolve)
      save: (name) => (this.mode === "timing" ? Promise.resolve() : new Promise((done) => this.saves.push({ name, done }))),
      timing: () => hooks.stats()?.report() ?? null,
    };
    this.api = api;
    window.__court = api;
  }

  /** The dt every probed frame advances by: one display frame. */
  dt(displayHz: number): number {
    return 1 / displayHz;
  }

  /** Right after renderer.render, inside the XR frame: read back (capture), log, wake the waiters. */
  afterRender(gl: WebGL2RenderingContext, cpuMs: number): void {
    const s = this.hooks.snapshot();
    const f: ProbeFrame = { n: this.n++, phase: s.phase, setup: s.setup, frame: s.clock.frame, segment: s.clock.segment, speed: s.clock.speed, onScreen: s.onScreen };
    if (this.mode === "timing") f.cpuMs = Number(cpuMs.toFixed(3));
    else {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      if (!this.buf || this.buf.length !== w * h * 4) this.buf = new Uint8Array(w * h * 4);
      const px = this.buf;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let aMin = 255;
      let aSum = 0;
      let lSum = 0;
      const thumb = new Array<number>(16 * 9).fill(0);
      const count = new Array<number>(16 * 9).fill(0);
      for (let y = 0; y < h; y++) {
        const ty = 8 - Math.min(8, Math.floor((y * 9) / h)); // readPixels rows run bottom up
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const a = px[o + 3];
          if (a < aMin) aMin = a;
          aSum += a;
          const l = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
          lSum += l;
          const k = ty * 16 + Math.min(15, Math.floor((x * 16) / w));
          thumb[k] += l;
          count[k]++;
        }
      }
      f.alphaMin = aMin;
      f.alphaMean = Number((aSum / (w * h)).toFixed(2));
      f.luma = Number((lSum / (w * h)).toFixed(2));
      f.thumb = thumb.map((v, k) => Math.round(v / Math.max(1, count[k])));
      if (this.saves.length) this.flushSaves(px, w, h);
    }
    this.waiters.splice(0).forEach((resolve) => resolve(f));
  }

  private flushSaves(px: Uint8Array, w: number, h: number): void {
    const flipped = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) flipped.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    let bin = "";
    for (let i = 0; i < flipped.length; i += 0x8000) bin += String.fromCharCode(...flipped.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    for (const s of this.saves.splice(0)) {
      const send = window.__courtSave;
      if (send) void send(s.name, w, h, b64).then(s.done, s.done);
      else {
        this.api.errors.push(`save(${s.name}): no window.__courtSave (run under scripts/court/e2e.mjs)`);
        s.done();
      }
    }
  }
}
