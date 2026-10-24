// The sound (2, 3.2, 3.3, 3.5): room tone (never dead silence), the crowd bed as >= 4 HRTF sources at the stands (each
// the bed from its own offset, placed in the arena, none head-locked: P31), the arrival's swell, the time stop (a
// low-pass 18 kHz -> 700 Hz and a ~14 dB duck to a hush, never silence, room tone kept: P20), the rush back on play
// (0.6 s), See my room's murmur (-18 dB, low-passed), the swell one-shot on the make (and softly at Step in), and
// events at 3D positions when Vishal approves CC0 sounds. No voices ever (P19): only the bundle's files are played.
// Stream F (`sound`) builds it. Pure Web Audio and type-only imports, so sound.test.ts renders it in an
// OfflineAudioContext (it takes the context and the file loader as options).
import type { ClockState } from "./clock";
import type { CourtBundle, Vec3 } from "./format";
import type { Head, WorldPose } from "./types";

/** True once stream F has built this module. */
export const BUILT = true;

/** The arrival (3.2): the crowd swells from this far below the steady mix (the plan's -30 -> -12 dB is 18 dB) to it. */
export const ARRIVAL_FROM_DB = -18;
/** The time stop (P20): the low-pass runs from open to this cutoff and the crowd ducks by this much (never silence). */
export const STOP_OPEN_HZ = 18000;
export const STOP_HUSH_HZ = 700;
export const STOP_DUCK_DB = -14;
/** The rush back on play (3.5): the filter opens and the crowd returns over this long. */
export const RUSH_S = 0.6;
/** See my room (3.6): the crowd is this far down, low-passed to this cutoff. */
export const ROOM_DUCK_DB = -18;
export const ROOM_HZ = 500;
/** Room tone, dBFS RMS: always there, so the hold before the arrival is never dead silence. */
export const ROOM_TONE_DB = -50;
/** On top of 1/sqrt(N) per source, so the summed bed sits at the file's own loudness (-23 LUFS) at the seat (HRTF and distance take the rest; sound.test.ts measures it). */
export const MIX_TRIM_DB = 5.5;

/** Seconds of smoothing on every per-frame parameter write (no zipper noise, no clicks). */
const SMOOTH_S = 0.03;
/** The swell one-shot is spread over the sources, each this much later than the last, so the sum doesn't add coherently. */
const STAGGER_S = 0.037;
/** More show frames than this between two updates is a jump (an ease start, a repeat), never a pass over a cue. */
const MAX_PASS_FRAMES = 12;
const RESUME_RETRY_MS = 500;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smootherstep = (u: number) => {
  const x = clamp01(u);
  return x * x * x * (x * (6 * x - 15) + 10);
};
const dbToGain = (db: number) => 10 ** (db / 20);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/** Interpolate a frequency in the log domain (equal steps per octave). */
const logLerp = (a: number, b: number, u: number) => a * (b / a) ** u;

/** The time stop's low-pass cutoff for p (0 = open, 1 = the hush). */
export const stopHz = (p: number) => logLerp(STOP_OPEN_HZ, STOP_HUSH_HZ, clamp01(p));
/** The time stop's duck in dB for p (0 = none, 1 = STOP_DUCK_DB). */
export const stopDb = (p: number) => lerp(0, STOP_DUCK_DB, clamp01(p));
/** The crowd's level relative to the steady mix during the arrival (p = 0 is silent, 1 is the steady mix). */
export const arrivalGain = (p: number) => dbToGain(lerp(ARRIVAL_FROM_DB, 0, smootherstep(p))) * Math.min(1, clamp01(p) / 0.06);

/** `v` rotated by the unit quaternion q = (x, y, z, w). */
function rotate(q: readonly [number, number, number, number], v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** A room-space direction in court space: the inverse of the world's rotation (seat.ts `toCourt`, without the offset). */
function toCourtDir(yaw: number, d: Vec3): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]];
}

/** What the module builds in: a live context, or an offline one for the tests' renders. */
export type Ctx = AudioContext | OfflineAudioContext;

export interface SoundOptions {
  /** The context to build in (default: a new AudioContext, created suspended until `start()`). */
  context?: Ctx;
  /** Fetch and decode one bundle path (default: `fetch(bundle.file(path))` and `decodeAudioData`). */
  decode?: (path: string, context: Ctx) => Promise<AudioBuffer>;
}

/** What the e2e's graph check reads (P31). */
export interface SoundGraph {
  state: AudioContextState;
  /** Court-space positions of the bed's HRTF sources. */
  sources: Vec3[];
  /** Every bed source is an HRTF panner placed in the court (none head-locked). */
  hrtf: boolean;
}

export class Sound {
  /** HRTF sources in the graph (P31 reads it). */
  sources = 0;
  private readonly bundle: CourtBundle;
  private readonly options: SoundOptions;
  private ctx!: Ctx;
  private buffers = new Map<string, AudioBuffer>();
  private panners: PannerNode[] = [];
  private bedNodes: AudioBufferSourceNode[] = [];
  private toneNode!: AudioBufferSourceNode;
  private crowd!: GainNode;
  private stopLP!: BiquadFilterNode;
  private stopGain!: GainNode;
  private roomLP!: BiquadFilterNode;
  private roomGain!: GainNode;
  private master!: GainNode;
  private loaded = false;
  private wantStart = false;
  private started = false;
  /** arrive() has been called with p > 0: until then only room tone plays. */
  private arrived = false;
  private arrivalP = -1;
  private stopP = 0;
  private roomP = 0;
  /** The audio time the rush's curve ends; the stop's parameters are not touched before it. */
  private rushEnd = 0;
  private rushed = false;
  private lastFrame: number | null = null;
  private lastSrc = 0;
  private lastTry = -Infinity;

  constructor(bundle: CourtBundle, options: SoundOptions = {}) {
    this.bundle = bundle;
    this.options = options;
  }

  /** Fetch and decode the bed and one-shots and build the graph (an AudioContext may be created suspended). */
  async load(): Promise<void> {
    if (this.loaded) return;
    const audio = this.bundle.court.audio;
    this.ctx = this.options.context ?? new AudioContext({ latencyHint: "interactive" });
    const decode = this.options.decode ?? ((path: string, ctx: Ctx) => this.decodeFile(path, ctx));
    const paths = [audio.bed, ...audio.oneShots.map((s) => s.file), ...audio.events.map((e) => e.file)];
    await Promise.all(
      [...new Set(paths)].map(async (path) => {
        this.buffers.set(path, await decode(path, this.ctx));
      }),
    );
    this.build();
    this.loaded = true;
    if (this.wantStart) this.start();
  }

  /** Inside the Enter tap (a user gesture): resume the context, start room tone and the bed, silent until the arrival. */
  start(): void {
    this.wantStart = true;
    if (!this.loaded || this.started) return;
    this.started = true;
    const bed = this.buffers.get(this.bundle.court.audio.bed)!;
    this.bedNodes.forEach((node, i) => {
      node.buffer = bed;
      node.loop = true;
      node.start(0, (this.bundle.court.audio.sources[i].offsetS % bed.duration + bed.duration) % bed.duration);
    });
    this.toneNode.start(0);
    this.resume();
  }

  /** The arrival: 0 = room tone only, 1 = the crowd at its steady mix (it swells 18 dB up to it). */
  arrive(p: number): void {
    if (!this.loaded || Math.abs(p - this.arrivalP) < 1e-4) return;
    this.arrivalP = p;
    if (p > 0) this.arrived = true;
    this.to(this.crowd.gain, dbToGain(MIX_TRIM_DB) / Math.sqrt(this.bedNodes.length) * arrivalGain(p));
  }

  /** The time stop: 0 = the crowd open, 1 = low-passed to ~700 Hz and 14 dB down (a hush, not silence). */
  timeStop(p: number): void {
    if (!this.loaded || this.ctx.currentTime < this.rushEnd || Math.abs(p - this.stopP) < 1e-4) return;
    this.stopP = p;
    this.to(this.stopLP.frequency, stopHz(p));
    this.to(this.stopGain.gain, dbToGain(stopDb(p)));
  }

  /** Play: the filter opens and the crowd rushes back over `seconds` (0.6), from wherever the stop is. */
  release(seconds = RUSH_S): void {
    if (!this.loaded || this.stopP <= 0) return;
    const now = this.ctx.currentTime;
    const n = 48;
    const shape = Array.from({ length: n }, (_, i) => smootherstep(i / (n - 1)));
    const hz = Float32Array.from(shape, (s) => logLerp(stopHz(this.stopP), STOP_OPEN_HZ, s));
    const gain = Float32Array.from(shape, (s) => dbToGain(lerp(stopDb(this.stopP), 0, s)));
    // the parameter holds its value for a millisecond, then the curve runs from that same value to the open one
    for (const [param, curve] of [[this.stopLP.frequency, hz], [this.stopGain.gain, gain]] as const) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(curve[0], now);
      param.setValueCurveAtTime(curve, now + 0.001, seconds);
    }
    this.rushEnd = now + 0.001 + seconds;
    this.stopP = 0;
  }

  /** See my room: 0 = the arena, 1 = the room's murmur (the crowd 18 dB down and low-passed). */
  room(p: number): void {
    if (!this.loaded || Math.abs(p - this.roomP) < 1e-4) return;
    this.roomP = p;
    const e = smootherstep(p);
    this.to(this.roomLP.frequency, logLerp(STOP_OPEN_HZ, ROOM_HZ, e));
    this.to(this.roomGain.gain, dbToGain(lerp(0, ROOM_DUCK_DB, e)));
  }

  /** A one-shot from court.json audio.oneShots by its cue: the swell, spread over the stand sources. */
  oneShot(id: "make" | "stepIn"): void {
    if (!this.started || !this.arrived) return;
    for (const shot of this.bundle.court.audio.oneShots) {
      if (shot.at !== id) continue;
      const buffer = this.buffers.get(shot.file)!;
      this.panners.forEach((panner, i) => {
        const node = this.ctx.createBufferSource();
        const gain = this.ctx.createGain();
        node.buffer = buffer;
        gain.gain.value = dbToGain(shot.gainDb);
        node.connect(gain).connect(panner);
        node.start(this.ctx.currentTime + i * STAGGER_S);
        node.onended = () => gain.disconnect();
      });
    }
  }

  /** A sound at a court-space position: the audio.events entry of this kind at `at` (else the first of the kind). */
  event(kind: string, at: Vec3): void {
    const same = this.bundle.court.audio.events.filter((e) => e.kind === kind);
    const found = same.find((e) => e.at.every((v, i) => v === at[i])) ?? same[0];
    if (found) this.play(found, at);
  }

  /** One audio.events entry, with its own file, through its own panner and the crowd's gain (the arrival, the stop). */
  private play(entry: CourtBundle["court"]["audio"]["events"][number], at: Vec3): void {
    if (!this.started || !this.arrived) return;
    const node = this.ctx.createBufferSource();
    const panner = this.panner(at);
    node.buffer = this.buffers.get(entry.file)!;
    node.connect(panner);
    node.onended = () => panner.disconnect();
    node.start();
  }

  /**
   * Once a frame: the listener follows the head (court space; `world` turns the head's room-space direction into the
   * court's), the make and events fire as the show passes their source frames, and play lets the hush go.
   */
  update(head: Head, clock: ClockState, world?: Pick<WorldPose, "yaw">): void {
    if (!this.started) return;
    this.keepRunning();
    this.listen(head, world?.yaw ?? 0);
    if (clock.segment === "resume") {
      if (!this.rushed) this.release();
      this.rushed = true;
    } else this.rushed = false;
    this.cues(clock);
  }

  /** What the e2e's graph check reads. */
  graph(): SoundGraph {
    return {
      state: this.ctx?.state ?? "suspended",
      sources: this.bundle.court.audio.sources.map((s) => [...s.at] as Vec3),
      hrtf: this.panners.length >= 4 && this.panners.every((p) => p.panningModel === "HRTF"),
    };
  }

  // ---------------- the graph ----------------

  private build(): void {
    const ctx = this.ctx;
    const audio = this.bundle.court.audio;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    // crowd -> time stop -> room murmur -> master
    this.crowd = ctx.createGain();
    this.crowd.gain.value = 0;
    this.stopLP = this.lowpass(STOP_OPEN_HZ);
    this.stopGain = ctx.createGain();
    this.roomLP = this.lowpass(STOP_OPEN_HZ);
    this.roomGain = ctx.createGain();
    this.crowd.connect(this.stopLP).connect(this.stopGain).connect(this.roomLP).connect(this.roomGain).connect(this.master);
    // the bed, one HRTF source per stand position, each from its own offset
    this.panners = audio.sources.map((s) => this.panner(s.at));
    this.bedNodes = this.panners.map((p) => {
      const node = ctx.createBufferSource();
      node.connect(p);
      return node;
    });
    this.sources = this.panners.length;
    this.roomTone();
  }

  private lowpass(hz: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = hz;
    f.Q.value = -3.0103; // dB: Butterworth, flat to the corner (no resonance bump to ring a sweep)
    return f;
  }

  /** An HRTF panner at a court-space point, into the crowd bus. */
  private panner(at: Vec3): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = 12;
    p.rolloffFactor = 0.4;
    p.positionX.value = at[0];
    p.positionY.value = at[1];
    p.positionZ.value = at[2];
    p.connect(this.crowd);
    return p;
  }

  /** Looped brown-ish noise at ROOM_TONE_DB with a crossfaded seam: the floor under everything. */
  private roomTone(): void {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const length = Math.round(4 * rate);
    const fade = Math.round(0.25 * rate);
    const raw = new Float32Array(length + fade);
    let seed = 12345;
    let y = 0;
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      y = 0.97 * y + 0.03 * ((seed / 2 ** 32) * 2 - 1);
      raw[i] = y;
    }
    const loop = raw.slice(0, length);
    for (let i = 0; i < fade; i++) {
      const u = (i + 0.5) / fade;
      loop[i] = raw[i] * Math.sin((u * Math.PI) / 2) + raw[length + i] * Math.cos((u * Math.PI) / 2);
    }
    let sum = 0;
    for (const v of loop) sum += v * v;
    const scale = dbToGain(ROOM_TONE_DB) / Math.sqrt(sum / length);
    const buffer = ctx.createBuffer(1, length, rate);
    buffer.copyToChannel(loop.map((v) => v * scale), 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(this.master);
    this.toneNode = node;
  }

  // ---------------- per frame ----------------

  private to(param: AudioParam, value: number): void {
    param.setTargetAtTime(value, this.ctx.currentTime, SMOOTH_S);
  }

  private listen(head: Head, yaw: number): void {
    const l = this.ctx.listener;
    const forward = toCourtDir(yaw, rotate(head.quaternion, [0, 0, -1]));
    const up = toCourtDir(yaw, rotate(head.quaternion, [0, 1, 0]));
    l.positionX.value = head.court[0];
    l.positionY.value = head.court[1];
    l.positionZ.value = head.court[2];
    l.forwardX.value = forward[0];
    l.forwardY.value = forward[1];
    l.forwardZ.value = forward[2];
    l.upX.value = up[0];
    l.upY.value = up[1];
    l.upZ.value = up[2];
  }

  /** The make and the events fire when the show's source frame passes theirs (forward, in a contiguous step). */
  private cues(clock: ClockState): void {
    const frame = clock.frame;
    const src = this.bundle.frames[frame]?.src;
    if (src === undefined) return;
    const last = this.lastFrame;
    const lastSrc = this.lastSrc;
    this.lastFrame = frame;
    this.lastSrc = src;
    if (last === null || frame <= last || frame - last > MAX_PASS_FRAMES) return;
    const passed = (at: number) => lastSrc < at && src >= at;
    const make = this.bundle.court.video.makeSource;
    if (make !== undefined && passed(make)) this.oneShot("make");
    for (const e of this.bundle.court.audio.events) if (passed(e.frame)) this.play(e, e.at);
  }

  // ---------------- the context ----------------

  /** Resume now, and again from the first gesture if the browser still holds it back. */
  private resume(): void {
    this.lastTry = performance.now();
    if (this.ctx.state === "running") return;
    this.ctx.resume().catch(() => {}); // an offline context can't resume before it renders
    if (typeof document === "undefined") return;
    const again = () => {
      for (const type of GESTURES) document.removeEventListener(type, again, true);
      this.resume();
    };
    for (const type of GESTURES) document.addEventListener(type, again, true);
  }

  /** The context can be suspended again (a tab switch, the XR session starting): ask every half second. */
  private keepRunning(): void {
    if (this.ctx.state === "running" || performance.now() - this.lastTry < RESUME_RETRY_MS) return;
    this.lastTry = performance.now();
    this.ctx.resume().catch(() => {});
  }

  private async decodeFile(path: string, ctx: Ctx): Promise<AudioBuffer> {
    const url = this.bundle.file(path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`audio ${path}: ${res.status} for ${url}`);
    return ctx.decodeAudioData(await res.arrayBuffer());
  }
}

const GESTURES = ["pointerdown", "keydown", "touchend", "click"];
