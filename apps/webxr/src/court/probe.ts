// The in-page half of the e2e harness (scripts/court/e2e.mjs), on only with `?probe`:
// - a fixed dt of 1 / displayHz per XR frame, so every rendered frame is one display frame of the show whatever the
//   host's rAF does (IWER runs at ~120 Hz; e2e never measures timing);
// - `?probe=capture`: every rendered frame read back in the page right after renderer.render (readPixels on IWER's
//   default framebuffer), logged as alpha min/mean, mean luma and a 16 x 9 luma thumbnail; full frames on request
//   (save(name) hands RGBA to window.__courtSave, which the runner writes as a PNG);
// - `?probe=capture` lockstep (scripts/court/capture/capture.mjs): the loop runs only the frames step() asks for, so
//   a slow read-back never costs a display frame; step(true) hands back that frame's raw pixels, and `&stamp` paints
//   the display frame, the clock's show frame and the frame on the video texture into the bottom-left corner as
//   black / white cells (STAMP), which the capture reads back out of the encoded video;
// - `?probe=timing`: no read-back; CPU ms per frame and GPU ms per renderer.render, per phase (stats.ts);
// - window.__court: the test API (state, seatHere, press, stepping);
// - every captured frame carries the view it was drawn from (court space), so the e2e can render the stand-in's true
//   scene from exactly there (scripts/court/standin.mjs truthAt) and measure in degrees (P8, P43).
// Integrator, T0.
import * as THREE from "three";
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
  /** The phase machine's clocks (court.ts): how long the head had been seated and still when the lights-up started (-1 before), the lights-up (-1 not started), seconds from F, See my room (0-1). */
  still: number;
  lightsUp: number;
  tF: number;
  roomP: number;
  /** The show frame court.ts handed the video and the proxies this frame (-1 none). */
  fed: number;
  /** The light field's last beat and its t (lightfield.ts `beat`, `t`). */
  lightBeat: string;
  lightT: number;
  /** The headset's rate this frame stepped at (the session's frameRate, else the show's) and the clock's output rate, Hz. */
  xrHz: number;
  clockHz: number;
  /** capture only: read-back alpha (0-255) min and mean, mean luma (0-255), 16 x 9 luma grid (row-major, top first). */
  alphaMin?: number;
  alphaMean?: number;
  luma?: number;
  thumb?: number[];
  /** capture only: the first view's camera in court space. */
  view?: ProbeView;
  /** timing only: CPU ms of the frame's work. */
  cpuMs?: number;
}

/**
 * The view a frame was drawn from, as a pinhole camera in court space: OpenCV axes (x right, y down, z forward), q the
 * world-from-camera rotation [x, y, z, w], pixels with (0, 0) the centre of the top-left pixel of the view's viewport
 * (the read-back frame's region `viewport`: x, y from its top-left, w, h). standin.mjs's truthAt() takes it as is.
 */
export interface ProbeView {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  centre: [number, number, number];
  q: [number, number, number, number];
  viewport: [number, number, number, number];
}

/** The stamp's cells: three rows (display frame, clock frame, frame on screen; bottom row first) of a white and a black
 * guard cell then 16 bits, most significant first, each STAMP.cell pixels square from the bottom-left corner. */
export const STAMP = { cell: 12, bits: 16, rows: 3 } as const;

/** A lockstep frame: its log, plus its pixels when asked (RGBA, bottom row first, base64). */
export interface ProbeGrab extends ProbeFrame {
  width: number;
  height: number;
  pixels?: string;
}

/** What court.ts gives the probe. */
export interface ProbeHooks {
  snapshot(): { phase: Phase; setup: boolean; clock: ClockState; onScreen: number; still: number; lightsUp: number; tF: number; roomP: number; fed: number; lightBeat: string; lightT: number; xrHz: number; clockHz: number; [k: string]: unknown };
  seatHere(): void;
  press(action: UiAction): void;
  modules: Record<string, boolean>;
  /** The frame log, once the bundle (and so the display rate) is known. */
  stats(): FrameStats | null;
  /** The first XR view of the frame just rendered (viewOf), null when not presenting. */
  view(): ProbeView | null;
}

/** window.__court */
export interface CourtTestApi {
  ready: boolean;
  error: string | null;
  mode: "capture" | "timing" | "realtime";
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
  /** Read back the next rendered frame in full and hand it to window.__courtSave(name, w, h, base64 RGBA, top row first); resolves with that frame's log (null when timing: a no-op). */
  save(name: string): Promise<ProbeFrame | null>;
  /** The timing pass's per-phase summary (timing mode). */
  timing(): ReturnType<FrameStats["report"]> | null;
  /** Step every XR frame by 1 / hz s instead of one display frame of the show (a 90 Hz headset playing the 72 Hz bake), or back with null. */
  setRate(hz: number | null): void;
  /** Lockstep on: the frame loop runs only the frames step() asks for (capture only); off: every XR frame again. */
  lockstep(on: boolean): void;
  /** Lockstep: run one frame; resolves with its log, and its pixels when `grab`. */
  step(grab: boolean): Promise<ProbeGrab>;
}

declare global {
  interface Window {
    __court?: CourtTestApi;
    __courtSave?: (name: string, width: number, height: number, rgbaBase64: string) => Promise<string>;
  }
}

export class Probe {
  readonly mode: "capture" | "timing" | "realtime";
  readonly api: CourtTestApi;
  private n = 0;
  private rate: number | null = null;
  private waiters: ((f: ProbeFrame) => void)[] = [];
  private saves: { name: string; done: (f: ProbeFrame) => void }[] = [];
  private buf: Uint8Array | null = null;
  private readonly hooks: ProbeHooks;
  private locked = false;
  private granted = 0;
  private steps: { grab: boolean; done: (f: ProbeGrab) => void }[] = [];
  private readonly stamp = new URLSearchParams(location.search).has("stamp");

  constructor(param: string | null, hooks: ProbeHooks) {
    this.mode = param === "timing" ? "timing" : param === "realtime" ? "realtime" : "capture";
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
      save: (name) => (this.mode === "timing" ? Promise.resolve(null) : new Promise((done) => this.saves.push({ name, done }))),
      timing: () => hooks.stats()?.report() ?? null,
      setRate: (hz) => {
        this.rate = hz && hz > 0 ? hz : null;
      },
      lockstep: (on) => {
        this.locked = on && this.mode === "capture";
      },
      step: (grab) => {
        this.granted++;
        return new Promise((done) => this.steps.push({ grab, done }));
      },
    };
    this.api = api;
    window.__court = api;
  }

  /** The dt every probed frame advances by: one period of the headset's rate (or 1 / the rate setRate chose). */
  dt(xrHz: number): number | null {
    // realtime: the wall clock drives the show, as on a headset (court.ts's own dt); the API still presses and reads
    return this.mode === "realtime" ? null : 1 / (this.rate ?? xrHz);
  }

  /** Whether this XR frame runs (court.ts asks at the top of every frame): always, unless lockstep holds it. */
  run(): boolean {
    if (!this.locked) return true;
    if (!this.granted) return false;
    this.granted--;
    return true;
  }

  /** Right after renderer.render, inside the XR frame: read back (capture), log, wake the waiters. */
  afterRender(gl: WebGL2RenderingContext, cpuMs: number): void {
    const s = this.hooks.snapshot();
    const f: ProbeFrame = {
      n: this.n++, phase: s.phase, setup: s.setup, frame: s.clock.frame, segment: s.clock.segment, speed: s.clock.speed, onScreen: s.onScreen,
      still: s.still, lightsUp: s.lightsUp, tF: s.tF, roomP: s.roomP, fed: s.fed, lightBeat: s.lightBeat, lightT: s.lightT,
      xrHz: s.xrHz, clockHz: s.clockHz,
    };
    if (this.mode === "timing" || (this.mode === "realtime" && !this.saves.length && !this.steps.length)) f.cpuMs = Number(cpuMs.toFixed(3));
    else {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      if (!this.buf || this.buf.length !== w * h * 4) this.buf = new Uint8Array(w * h * 4);
      const px = this.buf;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (this.stamp) paintStamp(gl, [this.n - 1, s.clock.frame, s.onScreen]);
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
      const view = this.hooks.view();
      if (view) f.view = view;
      if (this.saves.length) this.flushSaves(px, w, h, f);
      const step = this.steps.shift();
      if (step) step.done({ ...f, width: w, height: h, ...(step.grab ? { pixels: toBase64(px) } : {}) });
    }
    this.waiters.splice(0).forEach((resolve) => resolve(f));
  }

  private flushSaves(px: Uint8Array, w: number, h: number, f: ProbeFrame): void {
    const flipped = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) flipped.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    const b64 = toBase64(flipped);
    for (const s of this.saves.splice(0)) {
      const send = window.__courtSave;
      const done = () => s.done(f);
      if (send) void send(s.name, w, h, b64).then(done, done);
      else {
        this.api.errors.push(`save(${s.name}): no window.__courtSave (run under scripts/court/e2e.mjs)`);
        done();
      }
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The stamp (STAMP) on the bound framebuffer: one row per value, -1 as all ones; the GL state it touches is put back. */
function paintStamp(gl: WebGL2RenderingContext, values: number[]): void {
  const scissor = gl.isEnabled(gl.SCISSOR_TEST);
  const box = gl.getParameter(gl.SCISSOR_BOX) as Int32Array;
  const clear = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
  const mask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
  gl.enable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  const c = STAMP.cell;
  values.forEach((value, row) => {
    const v = value & 0xffff;
    for (let k = 0; k < STAMP.bits + 2; k++) {
      const on = k === 0 || (k > 1 && (v >> (STAMP.bits - 1 - (k - 2))) & 1);
      gl.scissor(k * c, row * c, c, c);
      gl.clearColor(on ? 1 : 0, on ? 1 : 0, on ? 1 : 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  });
  if (!scissor) gl.disable(gl.SCISSOR_TEST);
  gl.scissor(box[0], box[1], box[2], box[3]);
  gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
  gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
}

// three's camera looks down -z with y up; OpenCV's looks down +z with y down: a half turn about x
const TO_OPENCV = new THREE.Quaternion(1, 0, 0, 0);
const courtFromEye = new THREE.Matrix4();
const centre = new THREE.Vector3();
const turn = new THREE.Quaternion();
const scale = new THREE.Vector3();

/**
 * `eye` (an XR view's camera, matrices as last rendered) as a pinhole camera in the court space of `world` (the world
 * group). The canvas is `bufferHeight` tall (readPixels rows run bottom up; the viewport is given top-down).
 */
export function viewOf(eye: THREE.Camera, world: THREE.Object3D, bufferWidth: number, bufferHeight: number): ProbeView {
  courtFromEye.copy(world.matrixWorld).invert().multiply(eye.matrixWorld);
  courtFromEye.decompose(centre, turn, scale);
  turn.multiply(TO_OPENCV);
  const vp = eye.viewport ?? new THREE.Vector4(0, 0, bufferWidth, bufferHeight);
  const [w, h] = [vp.z, vp.w];
  const e = eye.projectionMatrix.elements; // column-major: e[8], e[9] are the off-centre terms
  return {
    width: w,
    height: h,
    fx: (e[0] * w) / 2,
    fy: (e[5] * h) / 2,
    cx: (w / 2) * (1 - e[8]) - 0.5,
    cy: (h / 2) * (1 + e[9]) - 0.5,
    centre: [centre.x, centre.y, centre.z],
    q: [turn.x, turn.y, turn.z, turn.w],
    viewport: [vp.x, bufferHeight - vp.y - vp.w, w, h],
  };
}
