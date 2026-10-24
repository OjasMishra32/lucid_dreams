// sound.ts (P19 gain staging, P20, P31): the module is rendered in an OfflineAudioContext in headless Chrome (node has no
// Web Audio), driven at 1/72 s per call exactly as court.ts drives it, and every number is measured on the rendered
// samples: duck depth, ramp times, filter depth, what plays before the arrival, no clicks (the largest sample-to-sample
// jump against a steady render and against a deliberate click), and that the crowd is in the arena, not on the head.
//   node --experimental-transform-types --test apps/webxr/scripts/court/sound.test.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { stripTypeScriptTypes } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARRIVAL_FROM_DB, MIX_TRIM_DB, ROOM_DUCK_DB, RUSH_S, STOP_DUCK_DB, STOP_HUSH_HZ, STOP_OPEN_HZ, Sound, arrivalGain, stopDb, stopHz,
} from "../../src/court/sound.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOUND_TS = join(HERE, "../../src/court/sound.ts");
const SR = 48000;
const FRAME = 1 / 72;

// ---------------- pure pieces (node) ----------------

test("the curves hit the plan's numbers and never reach silence", () => {
  assert.equal(stopHz(0), STOP_OPEN_HZ);
  assert.equal(stopHz(1), STOP_HUSH_HZ);
  assert.equal(stopDb(0), 0);
  assert.equal(stopDb(1), STOP_DUCK_DB);
  assert.ok(Math.abs(STOP_DUCK_DB + 14) < 1e-9 && STOP_HUSH_HZ === 700 && STOP_OPEN_HZ === 18000);
  assert.ok(RUSH_S === 0.6 && ROOM_DUCK_DB === -18);
  assert.equal(arrivalGain(0), 0);
  assert.ok(Math.abs(arrivalGain(1) - 1) < 1e-12);
  assert.ok(Math.abs(20 * Math.log10(arrivalGain(0.5)) - ARRIVAL_FROM_DB / 2) < 0.01);
  let last = -1;
  for (let p = 0; p <= 1; p += 0.01) {
    assert.ok(arrivalGain(p) >= last);
    last = arrivalGain(p);
  }
});

test("before load and start every call is a no-op (court.ts calls them every frame)", () => {
  const sound = new Sound({ court: { audio: { bed: "b", lufs: -23, sources: [], oneShots: [], events: [] }, video: {} }, frames: [], base: "", file: (p) => p } as never);
  const head = { room: [0, 1, 0], court: [0, 1, 0], yaw: 0, quaternion: [0, 0, 0, 1] } as never;
  const clock = { frame: 0, segment: "pass1" } as never;
  sound.arrive(0.5);
  sound.timeStop(1);
  sound.room(1);
  sound.release();
  sound.oneShot("make");
  sound.event("squeak", [0, 0, 0]);
  sound.update(head, clock);
  assert.equal(sound.sources, 0);
  assert.equal(sound.graph().hrtf, false);
});

test("the module plays only the bundle's files: no voice, no speech, no microphone (P19)", () => {
  const src = readFileSync(SOUND_TS, "utf8");
  for (const word of ["speechSynthesis", "SpeechSynthesisUtterance", "SpeechRecognition", "getUserMedia", "MediaStreamAudioSource"])
    assert.ok(!src.includes(word), word);
});

// ---------------- the Chrome harness ----------------

/** playwright-core from apps/webxr's node_modules, $PLAYWRIGHT_CORE, or the npx cache; never downloaded (as e2e.mjs). */
function findPlaywright(): { chromium: { launch(o: object): Promise<Browser> } } {
  const require = createRequire(join(HERE, "../../package.json"));
  const tries: string[] = [];
  if (process.env.PLAYWRIGHT_CORE) tries.push(process.env.PLAYWRIGHT_CORE);
  try {
    tries.push(dirname(require.resolve("playwright-core/package.json")));
  } catch {
    // not a dependency of apps/webxr
  }
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx))
    readdirSync(npx)
      .map((d) => join(npx, d, "node_modules", "playwright-core"))
      .filter((d) => existsSync(join(d, "package.json")))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .forEach((d) => tries.push(d));
  for (const dir of tries) {
    try {
      return require(dir);
    } catch {
      // try the next one
    }
  }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE=<dir of playwright-core> (nothing is downloaded)");
}

interface Page {
  route(url: string, handler: (route: { fulfill(o: object): Promise<void> }) => unknown): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: string | ((arg: unknown) => unknown), arg?: unknown): Promise<T>;
  on(event: string, cb: (e: unknown) => void): void;
}
interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/** The page side: builds a Sound on an OfflineAudioContext, applies the calls between render quanta, returns the samples. */
const PAGE_JS = `
const b64 = (f32) => {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const bedBuffer = (ctx, kind, seconds) => {
  const n = Math.round(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 7;
  const tones = { sine50: [50], sine2500: [2500], tone3k: [3000], tones: [150, 3000, 9000], tone1k: [1000], tone2k: [2000] }[kind];
  for (let i = 0; i < n; i++) {
    if (tones) {
      let v = 0;
      for (const f of tones) v += Math.sin((2 * Math.PI * f * i) / ctx.sampleRate);
      d[i] = (0.1 * v) / tones.length ** 0.5;
    } else {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      d[i] = (seed / 2 ** 32) * 2 - 1;
    }
  }
  if (!tones) {
    let ss = 0;
    for (const v of d) ss += v * v;
    const k = 10 ** (-23 / 20) / Math.sqrt(ss / n);
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  return buf;
};
window.renderSound = async (spec) => {
  const { Sound } = await import("/sound.js");
  const off = new OfflineAudioContext(2, Math.round(spec.seconds * 48000), 48000);
  const bundle = {
    court: { audio: { bed: "bed", lufs: -23, sources: spec.sources.map((at, i) => ({ at, offsetS: i * 0.37 })), oneShots: spec.oneShots ?? [], events: spec.events ?? [] }, video: { makeSource: spec.makeSource } },
    frames: spec.frames ?? [{ src: 0 }],
    base: "",
    file: (p) => p,
  };
  const buffers = { bed: bedBuffer(off, spec.bed, 6.37), swell: bedBuffer(off, spec.swell ?? "tone1k", spec.swellSeconds ?? 0.3), sfx: bedBuffer(off, "tone3k", 0.2) };
  const sound = new Sound(bundle, { context: off, decode: async (path) => buffers[path] });
  await sound.load();
  sound.start();
  const errors = [];
  const apply = (c) => {
    try {
      sound[c.fn](...c.args);
    } catch (e) {
      errors.push(c.fn + ": " + e);
    }
  };
  const quantum = 128 / 48000;
  const at = new Map();
  for (const c of spec.calls) {
    const t = Math.round(c.t / quantum) * quantum;
    if (t >= spec.seconds - quantum) continue; // a suspend at or past the end of the render is refused
    if (!at.has(t)) at.set(t, []);
    at.get(t).push(c);
  }
  for (const [t, calls] of [...at].sort((a, b) => a[0] - b[0])) {
    if (t <= 0) calls.forEach(apply);
    else off.suspend(t).then(() => { calls.forEach(apply); off.resume(); });
  }
  const buf = await off.startRendering();
  return { errors, graph: sound.graph(), sources: sound.sources, l: b64(buf.getChannelData(0)), r: b64(buf.getChannelData(1)) };
};
window.renderControl = async (spec) => {
  // a deliberate click: a sine whose gain steps by 20% with no smoothing
  const off = new OfflineAudioContext(1, 48000, 48000);
  const src = off.createBufferSource();
  src.buffer = bedBuffer(off, spec.bed, 1);
  const g = off.createGain();
  src.connect(g).connect(off.destination);
  g.gain.setValueAtTime(1, 0);
  g.gain.setValueAtTime(0.8, 0.5 + 0.25 / 50); // at the sine's crest
  src.start();
  return { l: b64((await off.startRendering()).getChannelData(0)) };
};
window.renderGesture = async () => {
  const { Sound } = await import("/sound.js");
  const off = new OfflineAudioContext(2, 4800, 48000);
  let state = "suspended";
  let calls = 0;
  let flip = false;
  Object.defineProperty(off, "state", { get: () => state });
  off.resume = () => { calls++; if (flip) state = "running"; return Promise.resolve(); };
  const buf = off.createBuffer(1, 4800, 48000);
  const bundle = { court: { audio: { bed: "bed", lufs: -23, sources: [0, 1, 2, 3].map((i) => ({ at: [10, 1, i], offsetS: 0 })), oneShots: [], events: [] }, video: {} }, frames: [{ src: 0 }], base: "", file: (p) => p };
  const sound = new Sound(bundle, { context: off, decode: async () => buf });
  await sound.load();
  const out = { beforeStart: calls };
  sound.start();
  out.afterStart = calls;
  document.dispatchEvent(new Event("pointerdown"));
  out.afterGesture = calls; // still suspended: the first gesture resumes it
  document.dispatchEvent(new Event("pointerdown"));
  out.afterSecondGesture = calls; // the listener was one-shot
  const head = { room: [0, 1, 0], court: [0, 1, 0], yaw: 0, quaternion: [0, 0, 0, 1] };
  const clock = { frame: 0, segment: "pass1" };
  sound.update(head, clock);
  out.updateSoon = calls; // throttled
  await new Promise((r) => setTimeout(r, 600));
  sound.update(head, clock);
  out.updateLater = calls; // asked again while suspended
  flip = true;
  await new Promise((r) => setTimeout(r, 600));
  sound.update(head, clock);
  const running = calls;
  sound.update(head, clock);
  out.afterRunning = calls - running; // running: no more asks
  return out;
};
`;

let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

before(async () => {
  const js = stripTypeScriptTypes(readFileSync(SOUND_TS, "utf8"), { mode: "transform" });
  const { chromium } = findPlaywright();
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.route("http://sound.test/**", (route) => {
    const url = (route as unknown as { request(): { url(): string } }).request().url();
    const body = url.endsWith("/sound.js") ? js : `<!doctype html><title>sound</title><script>${PAGE_JS}</script>`;
    return route.fulfill({ status: 200, contentType: url.endsWith("/sound.js") ? "text/javascript" : "text/html", body });
  });
  await page.goto("http://sound.test/");
});

after(async () => {
  await browser?.close();
});

// ---------------- driving and measuring ----------------

type Call = { t: number; fn: string; args: unknown[] };
type Vec3 = [number, number, number];
const yawQuat = (yaw: number): [number, number, number, number] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
/** The seated judge, 5 m from the pair, facing the stands (+X). */
const SEAT = { room: [0, 1.15, 0], court: [-5, 1.15, 0], yaw: -Math.PI / 2, quaternion: yawQuat(-Math.PI / 2) };
const STANDS: Vec3[] = [[16, 3, -8], [16, 4, -2], [16, 3, 4], [16, 4, 10], [0, 4, 9.5]];
const clockAt = (frame: number, segment = "pass1") => ({ frame, segment, ease: null, speed: 1, nextEase: null, nextJump: null, armed: false, pass: 0, segmentFrame: 0 });
/** After the arrival (0.5 + 2.5 s) has settled: the steady mix the other checks are measured against. */
// (the filters' depth is measured down to the room tone's own level, about -35 dB under a tone at this bed's level)
const REF: [number, number] = [3.4, 4.1];
const smootherstep = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
};

/** One call set per display frame at 72 Hz (court.ts steps once per XR frame), t from 0 to `seconds`. */
function perFrame(seconds: number, f: (t: number, i: number) => Call[]): Call[] {
  const calls: Call[] = [];
  for (let i = 0; i * FRAME <= seconds; i++) calls.push(...f(i * FRAME, i));
  return calls;
}
/** The head update court.ts makes each frame. */
const listen = (t: number, head: object = SEAT, clock: object = clockAt(0), world?: object): Call => ({ t, fn: "update", args: [head, clock, world] });

interface Spec {
  seconds: number;
  bed: string;
  calls: Call[];
  sources?: Vec3[];
  oneShots?: object[];
  events?: object[];
  makeSource?: number;
  frames?: object[];
  swell?: string;
  swellSeconds?: number;
}
interface Render {
  l: Float32Array;
  r: Float32Array;
  graph: { state: string; sources: Vec3[]; hrtf: boolean };
  sources: number;
}

async function render(spec: Spec): Promise<Render> {
  const out = await page.evaluate<{ errors: string[]; graph: Render["graph"]; sources: number; l: string; r: string }>(
    (s) => (window as unknown as { renderSound(s: unknown): Promise<never> }).renderSound(s),
    { sources: STANDS, ...spec },
  );
  assert.deepEqual(out.errors, []);
  assert.deepEqual(pageErrors.splice(0), []);
  const f32 = (b64: string) => new Float32Array(new Uint8Array(Buffer.from(b64, "base64")).buffer);
  return { l: f32(out.l), r: f32(out.r), graph: out.graph, sources: out.sources };
}

/** RBJ biquad (Q = 1/sqrt 2) over a whole signal. */
function biquad(x: Float32Array, kind: "lp" | "hp", hz: number): Float32Array {
  const w = (2 * Math.PI * hz) / SR;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const [b0, b1, b2] = kind === "lp" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + alpha;
  const a1 = (-2 * c) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}
/** Band-pass around a tone: two high-passes and two low-passes (24 dB/oct each side). */
const around = (x: Float32Array, hz: number) => biquad(biquad(biquad(biquad(x, "hp", hz * 0.8), "hp", hz * 0.8), "lp", hz * 1.25), "lp", hz * 1.25);

class Signal {
  constructor(readonly render: Render) {}
  private cache = new Map<number, [Float32Array, Float32Array]>();
  private band(hz: number | null): [Float32Array, Float32Array] {
    const key = hz ?? 0;
    if (!this.cache.has(key)) this.cache.set(key, hz === null ? [this.render.l, this.render.r] : [around(this.render.l, hz), around(this.render.r, hz)]);
    return this.cache.get(key)!;
  }
  /** Mean power of both ears over [t0, t1) in dB (dBFS), in the band around `hz` (null: all). */
  db(t0: number, t1: number, hz: number | null = null): number {
    const [l, r] = this.band(hz);
    const a = Math.round(t0 * SR);
    const b = Math.round(t1 * SR);
    let s = 0;
    for (let i = a; i < b; i++) s += l[i] * l[i] + r[i] * r[i];
    return 10 * Math.log10(s / (2 * (b - a)) + 1e-30);
  }
  /** Ear powers separately, dB. */
  ears(t0: number, t1: number, hz: number | null = null): [number, number] {
    const [l, r] = this.band(hz);
    const p = (x: Float32Array) => {
      let s = 0;
      const a = Math.round(t0 * SR);
      const b = Math.round(t1 * SR);
      for (let i = a; i < b; i++) s += x[i] * x[i];
      return 10 * Math.log10(s / (b - a) + 1e-30);
    };
    return [p(l), p(r)];
  }
  /** The largest |x[n] - x[n-1]| over [t0, t1) in either ear. */
  maxJump(t0: number, t1: number): number {
    let m = 0;
    for (const x of [this.render.l, this.render.r]) for (let i = Math.round(t0 * SR) + 1; i < Math.round(t1 * SR); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
    return m;
  }
  /** First time after `from` the band level crosses `db` going up (or down when `down`), 20 ms windows; null if never. */
  cross(hz: number | null, db: number, from: number, to: number, down = false): number | null {
    for (let t = from; t < to; t += 0.01) {
      const v = this.db(t, t + 0.02, hz);
      if (down ? v <= db : v >= db) return t;
    }
    return null;
  }
}

/** A bed that arrives at 0.5 s over 2.5 s and then sits at the steady mix. */
const arrival = (t0 = 0.5, dur = 2.5): Call[] =>
  perFrame(t0 + dur, (t) => (t >= t0 ? [{ t, fn: "arrive", args: [Math.min(1, (t - t0) / dur)] }] : []));

// ---------------- the checks ----------------

test("P19 gain staging: the steady crowd mix sits at the bed's own loudness (-23), within 1.5 dB", async () => {
  const calls = [...perFrame(7, (t) => [listen(t)]), ...arrival()];
  const s = new Signal(await render({ seconds: 7, bed: "noise", calls }));
  const steady = s.db(3.5, 6.9);
  assert.ok(Math.abs(steady - -23) < 1.5, `steady ${steady.toFixed(2)} dBFS vs -23 (MIX_TRIM_DB = ${MIX_TRIM_DB})`);
});

test("nothing plays before the arrival but room tone: no crowd, no one-shots, no events", async () => {
  const frames = Array.from({ length: 120 }, (_, i) => ({ src: i }));
  const calls: Call[] = [
    ...perFrame(3, (t, i) => [listen(t, SEAT, clockAt(Math.min(i, 119)))]),
    { t: 1.0, fn: "oneShot", args: ["stepIn"] },
    { t: 1.1, fn: "oneShot", args: ["make"] },
    { t: 1.2, fn: "event", args: ["squeak", [0, 0, 0]] },
  ];
  const oneShots = [{ file: "swell", at: "make", gainDb: 0 }, { file: "swell", at: "stepIn", gainDb: -12 }];
  const events = [{ frame: 40, kind: "squeak", at: [0, 0, 0], file: "sfx" }];
  const s = new Signal(await render({ seconds: 3, bed: "noise", calls, oneShots, events, frames, makeSource: 60 }));
  const level = s.db(0.3, 3);
  assert.ok(level > -62, `room tone is there, never dead silence (${level.toFixed(1)} dBFS)`);
  assert.ok(level < -44, `only room tone plays (${level.toFixed(1)} dBFS)`);
  assert.equal(s.render.sources, 5);
});

test("the arrival swells the crowd 18 dB up to the steady mix, smoothly and monotonically", async () => {
  const calls = [...perFrame(5, (t) => [listen(t)]), ...arrival()];
  const s = new Signal(await render({ seconds: 5, bed: "noise", calls }));
  const steady = s.db(3.6, 4.9);
  assert.ok(s.db(0.1, 0.45) < steady - 24, "silent crowd before the lights");
  assert.ok(s.db(0.55, 0.75) < steady - 16, `the swell starts 18 dB down (${(s.db(0.55, 0.75) - steady).toFixed(1)})`);
  let last = -Infinity;
  for (let t = 0.5; t < 3.4; t += 0.25) {
    const v = s.db(t, t + 0.25);
    assert.ok(v >= last - 0.5, `monotonic at ${t.toFixed(2)} s`);
    last = v;
  }
  assert.ok(Math.abs(s.db(3.2, 3.5) - steady) < 1, "at the steady mix when the lights are up");
});

/** The ease at `t0`: p follows the clock's curve (1 - speed / 0.6, speed = 0.6 (1 - smootherstep)); then holds. */
const ease = (t0: number, seconds: number, extra: (t: number) => Call[] = () => []): Call[] =>
  perFrame(t0 + seconds + 1.5, (t) => [listen(t), ...(t >= t0 ? [{ t, fn: "timeStop", args: [smootherstep((t - t0) / seconds)] }] : []), ...extra(t)]);

test("P20 the time stop: low-pass and about -14 dB over the 1.2 s ease, a hush and not silence", async () => {
  const T0 = 4.4;
  const s = new Signal(await render({ seconds: 7.3, bed: "tones", calls: [...arrival(), ...ease(T0, 1.2)] }));
  const low = (a: number, b: number) => s.db(a, b, 150) - s.db(...REF, 150);
  const high = (a: number, b: number) => s.db(a, b, 9000) - s.db(...REF, 9000);
  const mid = (a: number, b: number) => s.db(a, b, 3000) - s.db(...REF, 3000);
  assert.ok(Math.abs(low(T0 - 0.1, T0)) < 0.3, "nothing moves before the ease starts");
  assert.ok(Math.abs(low(T0 + 0.55, T0 + 0.65) - STOP_DUCK_DB / 2) < 2.2, `half-way ${low(T0 + 0.55, T0 + 0.65).toFixed(1)} dB`);
  assert.ok(Math.abs(low(T0 + 1.4, T0 + 2.6) - STOP_DUCK_DB) < 1, `duck ${low(T0 + 1.4, T0 + 2.6).toFixed(1)} dB vs -14`);
  assert.ok(high(T0 + 1.4, T0 + 2.6) < -30, `9 kHz is ${high(T0 + 1.4, T0 + 2.6).toFixed(0)} dB down`);
  assert.ok(mid(T0 + 1.4, T0 + 2.6) < -25 && mid(T0 + 1.4, T0 + 2.6) > -60, `3 kHz is ${mid(T0 + 1.4, T0 + 2.6).toFixed(0)} dB down`);
  assert.ok(s.db(T0 + 1.4, T0 + 2.6, 150) > s.db(...REF, 150) - 16, "the crowd is still audible under the hush");
  assert.ok(s.db(T0 + 1.4, T0 + 2.6, 150) > -80, "never silence");
  // ramp timing: 90% of the way (-12.6 dB) lands about 0.73 of the ease in (smootherstep), a few tens of ms late
  const t90 = s.cross(150, s.db(...REF, 150) + 0.9 * STOP_DUCK_DB, T0, T0 + 2.5, true)!;
  assert.ok(t90 - T0 > 0.75 && t90 - T0 < 1.1, `90% down ${(t90 - T0).toFixed(2)} s into the ease`);
});

test("P20 the rush back on play: the filter opens and the crowd returns over 0.6 s", async () => {
  const T0 = 4.4;
  const T1 = T0 + 1.2 + 1.0;
  const calls = [...arrival(), ...ease(T0, 1.2, (t) => (t >= T1 ? [listen(t, SEAT, clockAt(10, "resume"))] : []))];
  const s = new Signal(await render({ seconds: T1 + 2, bed: "tones", calls }));
  const ref = s.db(...REF, 150);
  const low = (a: number, b: number) => s.db(a, b, 150) - ref;
  assert.ok(Math.abs(low(T1 - 0.3, T1) - STOP_DUCK_DB) < 1, "held in the hush until play");
  assert.ok(low(T1 + 0.05, T1 + 0.12) < STOP_DUCK_DB + 2.5, "the rush starts slowly (C2), not with a jump");
  const t90 = s.cross(150, ref + 0.1 * STOP_DUCK_DB, T1, T1 + 1.5)!;
  assert.ok(t90 - T1 > 0.35 && t90 - T1 < 0.65, `90% back ${(t90 - T1).toFixed(2)} s after play`);
  assert.ok(Math.abs(low(T1 + 0.75, T1 + 1.9)) < 0.5, "fully back at the steady mix");
  assert.ok(Math.abs(s.db(T1 + 0.75, T1 + 1.9, 9000) - s.db(...REF, 9000)) < 1, "9 kHz is open again");
});

test("See my room: the crowd goes to a -18 dB low-passed murmur in 0.6 s and comes back in 0.8 s; room tone stays", async () => {
  const OUT = 4.4;
  const BACK = 6.7;
  const calls = [
    ...arrival(),
    ...perFrame(9, (t) => [
      listen(t),
      { t, fn: "room", args: [t < OUT ? 0 : t < BACK ? Math.min(1, (t - OUT) / 0.6) : Math.max(0, 1 - (t - BACK) / 0.8)] },
    ]),
  ];
  const s = new Signal(await render({ seconds: 9, bed: "tones", calls }));
  const ref = (hz: number) => s.db(...REF, hz);
  const d = (a: number, b: number, hz: number) => s.db(a, b, hz) - ref(hz);
  assert.ok(Math.abs(d(OUT + 0.8, BACK - 0.2, 150) - ROOM_DUCK_DB) < 1, `murmur ${d(OUT + 0.8, BACK - 0.2, 150).toFixed(1)} dB`);
  assert.ok(d(OUT + 0.8, BACK - 0.2, 9000) < -30 && d(OUT + 0.8, BACK - 0.2, 3000) < -25, `low-passed: 9 kHz ${d(OUT + 0.8, BACK - 0.2, 9000).toFixed(1)}, 3 kHz ${d(OUT + 0.8, BACK - 0.2, 3000).toFixed(1)} dB`);
  const t90 = s.cross(150, ref(150) + 0.9 * ROOM_DUCK_DB, OUT, BACK, true)!;
  assert.ok(t90 - OUT > 0.3 && t90 - OUT < 0.7, `out: 90% at ${(t90 - OUT).toFixed(2)} s`);
  const back90 = s.cross(150, ref(150) + 0.1 * ROOM_DUCK_DB, BACK, 9)!;
  assert.ok(back90 - BACK > 0.4 && back90 - BACK < 0.85, `back: 90% at ${(back90 - BACK).toFixed(2)} s`);
  assert.ok(Math.abs(d(BACK + 1.2, 8.9, 150)) < 0.5, "the arena is back");
});

for (const bed of ["sine50", "sine2500"]) {
  test(`P20 no clicks (${bed}): the largest sample jump through arrival, hush, rush and See my room never exceeds a steady render's`, async () => {
    const T0 = 4.4;
    const T1 = T0 + 2.2;
    const steady = new Signal(await render({ seconds: 5, bed, calls: [...perFrame(5, (t) => [listen(t)]), { t: 0, fn: "arrive", args: [1] }] }));
    const baseline = steady.maxJump(2, 5);
    const calls = [
      ...arrival(),
      ...ease(T0, 1.2, (t) => [
        ...(t >= T1 ? [listen(t, SEAT, clockAt(10, "resume"))] : []),
        { t, fn: "room", args: [t < T1 + 1 ? 0 : Math.min(1, (t - T1 - 1) / 0.6)] },
      ]),
    ];
    const s = new Signal(await render({ seconds: T1 + 3, bed, calls }));
    const worst = s.maxJump(0.1, T1 + 3);
    assert.ok(worst <= baseline * 1.05, `max jump ${worst.toExponential(3)} vs steady ${baseline.toExponential(3)}`);
    // the detector does see a click: a 20% unsmoothed gain step on the same tone (only a slow tone shows a small step)
    if (bed !== "sine50") return;
    const control = await page.evaluate<{ l: string }>((a) => (window as unknown as { renderControl(a: unknown): Promise<never> }).renderControl(a), { bed });
    const x = new Float32Array(new Uint8Array(Buffer.from(control.l, "base64")).buffer);
    let c = 0;
    for (let i = 24000; i < 24600; i++) c = Math.max(c, Math.abs(x[i] - x[i - 1]));
    let c0 = 0;
    for (let i = 2000; i < 20000; i++) c0 = Math.max(c0, Math.abs(x[i] - x[i - 1]));
    assert.ok(c > c0 * 1.05, `control click ${c.toExponential(2)} vs ${c0.toExponential(2)}`);
  });
}

test("P31 the crowd is around you: >= 4 HRTF sources at the stands, none head-locked", async () => {
  const left: Vec3[] = [[-10, 2, -3], [-10, 2, -1], [-10, 2, 1], [-10, 2, 3], [-10, 4, 0]];
  const calls = (head: object, world?: object): Call[] => [{ t: 0, fn: "arrive", args: [1] }, ...perFrame(2, (t) => [listen(t, head, clockAt(0), world)])];
  const facingMinusZ = { room: [0, 1.15, 0], court: [0, 1.15, 0], yaw: 0, quaternion: yawQuat(0) };
  const turnedAround = { ...facingMinusZ, yaw: Math.PI, quaternion: yawQuat(Math.PI) };
  const a = await render({ seconds: 2, bed: "tone3k", sources: left, calls: calls(facingMinusZ) });
  const b = await render({ seconds: 2, bed: "tone3k", sources: left, calls: calls(turnedAround) });
  const c = await render({ seconds: 2, bed: "tone3k", sources: left, calls: calls(facingMinusZ, { yaw: Math.PI }) });
  assert.ok(a.sources >= 4 && a.graph.hrtf, "HRTF panners");
  assert.deepEqual(a.graph.sources, left);
  const [al, ar] = new Signal(a).ears(0.5, 1.9, 3000);
  const [bl, br] = new Signal(b).ears(0.5, 1.9, 3000);
  const [cl, cr] = new Signal(c).ears(0.5, 1.9, 3000);
  assert.ok(al - ar > 4, `facing -Z the crowd on -X is on the left (${(al - ar).toFixed(1)} dB)`);
  assert.ok(br - bl > 4, `turning round moves it to the right (${(br - bl).toFixed(1)} dB): it is not on the head`);
  assert.ok(cr - cl > 4, `the court turned half a circle in the room moves it too (${(cr - cl).toFixed(1)} dB)`);
});

test("the swell fires once each time the show passes the make; the step-in swell is 12 dB softer; events fire at their frame", async () => {
  const frames = Array.from({ length: 101 }, (_, i) => ({ src: i }));
  const oneShots = [{ file: "swell", at: "make", gainDb: 0 }, { file: "swell", at: "stepIn", gainDb: -12 }];
  const events = [{ frame: 30, kind: "squeak", at: [2, 0, 1], file: "sfx" }];
  const sweep = (from: number, to: number, t0: number): Call[] =>
    perFrame(((to - from) / 72), (t, i) => [listen(t0 + t, SEAT, clockAt(from + i))]).map((c) => ({ ...c, t: c.t }));
  // pass A: 0..100 once, then 0..40 again (a jump back that doesn't reach the make at 60)
  const passes: Call[] = [{ t: 0, fn: "arrive", args: [1] }, ...sweep(0, 100, 0.2), ...sweep(0, 40, 2.0), { t: 3.2, fn: "oneShot", args: ["stepIn"] }];
  const s = new Signal(await render({ seconds: 4.2, bed: "sine50", calls: passes, oneShots, events, frames, makeSource: 60, swellSeconds: 0.3 }));
  const onsets = (hz: number, lo: number, from = 0, to = 4.2) => {
    const out: number[] = [];
    let was = false;
    for (let t = from; t < to; t += 0.01) {
      const on = s.db(t, t + 0.02, hz) > lo;
      if (on && !was) out.push(t);
      was = on;
    }
    return out;
  };
  const floor = s.db(0.05, 0.15, 1000);
  const swell = onsets(1000, floor + 25, 0, 3.1);
  assert.equal(swell.length, 1, `one swell for one pass over the make: ${swell}`);
  assert.ok(Math.abs(swell[0] - (0.2 + 60 / 72)) < 0.1, `on the make frame (${swell[0].toFixed(2)} s vs ${(0.2 + 60 / 72).toFixed(2)})`);
  const squeaks = onsets(3000, s.db(0.05, 0.15, 3000) + 25);
  assert.equal(squeaks.length, 2, `the event fires on each pass over its frame: ${squeaks}`);
  assert.ok(Math.abs(squeaks[0] - (0.2 + 30 / 72)) < 0.1);
  const peak = (a: number, b: number) => Math.max(...Array.from({ length: Math.round((b - a) / 0.01) }, (_, i) => s.db(a + i * 0.01, a + i * 0.01 + 0.03, 1000)));
  const make = peak(swell[0], swell[0] + 0.5);
  const stepIn = peak(3.2, 3.8);
  assert.ok(Math.abs(make - stepIn - 12) < 1.5, `step-in is ${(make - stepIn).toFixed(1)} dB under the make`);
  // a second full pass fires again
  const again: Call[] = [{ t: 0, fn: "arrive", args: [1] }, ...sweep(0, 100, 0.2), ...sweep(0, 100, 1.9)];
  const s2 = new Signal(await render({ seconds: 3.6, bed: "sine50", calls: again, oneShots, events, frames, makeSource: 60, swellSeconds: 0.3 }));
  let n = 0;
  let was = false;
  for (let t = 0; t < 3.5; t += 0.01) {
    const on = s2.db(t, t + 0.02, 1000) > floor + 25;
    if (on && !was) n++;
    was = on;
  }
  assert.equal(n, 2, "each pass over the make fires the swell once");
});

test("AudioContext: start() resumes inside the tap, the first gesture resumes it if the browser held it back, update() asks again while suspended", async () => {
  const r = await page.evaluate<Record<string, number>>(() => (window as unknown as { renderGesture(): Promise<never> }).renderGesture());
  assert.equal(r.beforeStart, 0);
  assert.equal(r.afterStart, 1, "start() resumes");
  assert.equal(r.afterGesture, 2, "the first gesture resumes it");
  assert.equal(r.afterSecondGesture, 3, "and every gesture asks again while it is still held back");
  assert.equal(r.updateSoon, 3, "update() doesn't ask on every frame");
  assert.equal(r.updateLater, 4, "it asks again after the throttle while it is still suspended");
  assert.equal(r.afterRunning, 0, "running: no more asks");
});
