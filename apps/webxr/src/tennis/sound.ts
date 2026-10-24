import * as THREE from "three";

// The court's sounds, synthesised with WebAudio (no files): the pock of a ball off the strings, the soft thud of a
// bounce on grass, the rattle of the net, each from where it happened and arriving late by the distance (sound takes
// 70 ms to cross the court). The umpire's calls are the device's own text-to-speech voice, never a player's.

const VOICES = 8;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

function normalize(d: Float32Array, peak: number) {
  let m = 0;
  for (const v of d) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
}

/** A ball off tight strings: a sharp click, the strings' ring and the hollow ball's body, all in ~60 ms. */
function pock(ctx: BaseAudioContext, pitch: number, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.09);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  const noise = rng(seed);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    lp += 0.5 * (noise() - lp);
    d[i] =
      lp * Math.exp(-t / 0.0016) * 1.1 +
      0.55 * Math.sin(2 * Math.PI * 1150 * pitch * t) * Math.exp(-t / 0.007) +
      0.75 * Math.sin(2 * Math.PI * 520 * pitch * t) * Math.exp(-t / 0.012) +
      0.4 * Math.sin(2 * Math.PI * 255 * pitch * t) * Math.exp(-t / 0.02);
  }
  normalize(d, 0.9);
  return b;
}

/** A bounce on grass: dull and short. */
function thud(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.08);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  const noise = rng(seed);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    lp += 0.12 * (noise() - lp);
    d[i] = lp * 2.4 * Math.exp(-t / 0.008) + 0.6 * Math.sin(2 * Math.PI * 170 * t) * Math.exp(-t / 0.016) + 0.25 * Math.sin(2 * Math.PI * 410 * t) * Math.exp(-t / 0.006);
  }
  normalize(d, 0.7);
  return b;
}

/** Into the net: a soft, papery rattle that dies away. */
function rattle(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.3);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  const noise = rng(3);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    lp += 0.25 * (noise() - lp);
    d[i] = lp * Math.exp(-t / 0.07) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 38 * t));
  }
  normalize(d, 0.6);
  return b;
}

export class CourtSounds {
  readonly listener = new THREE.AudioListener();
  private voices: THREE.PositionalAudio[] = [];
  private next = 0;
  private hits: AudioBuffer[];
  private thuds: AudioBuffer[];
  private net: AudioBuffer;
  private ear = new THREE.Vector3();

  constructor(camera: THREE.Camera, scene: THREE.Scene) {
    camera.add(this.listener);
    const ctx = this.listener.context;
    this.hits = [0.94, 1, 1.07].map((p, i) => pock(ctx, p, 11 + i * 17));
    this.thuds = [0, 1].map((i) => thud(ctx, 5 + i * 9));
    this.net = rattle(ctx);
    for (let i = 0; i < VOICES; i++) {
      const v = new THREE.PositionalAudio(this.listener);
      v.setRefDistance(2.5);
      v.setRolloffFactor(0.9);
      v.setDistanceModel("inverse");
      scene.add(v);
      this.voices.push(v);
    }
    const wake = () => {
      if (ctx.state !== "running") void ctx.resume();
    };
    for (const e of ["pointerdown", "keydown", "touchstart"]) addEventListener(e, wake, { passive: true });
  }

  resume() {
    if (this.listener.context.state !== "running") void this.listener.context.resume();
  }

  /** A ball off a racket at a world point, at `speed` m/s. */
  hit(at: THREE.Vector3, speed: number) {
    this.play(this.hits[Math.floor(Math.random() * 3)], at, THREE.MathUtils.clamp(0.35 + speed / 40, 0.35, 1), 0.95 + Math.random() * 0.1);
  }

  bounce(at: THREE.Vector3, speed: number) {
    this.play(this.thuds[Math.floor(Math.random() * 2)], at, THREE.MathUtils.clamp(speed / 14, 0.12, 0.6), 0.93 + Math.random() * 0.12);
  }

  netCord(at: THREE.Vector3) {
    this.play(this.net, at, 0.55, 1);
  }

  private play(buf: AudioBuffer, at: THREE.Vector3, volume: number, rate: number) {
    if (this.listener.context.state !== "running") return;
    const v = this.voices[this.next++ % VOICES];
    if (v.isPlaying) v.stop();
    v.position.copy(at);
    v.updateMatrixWorld(true);
    v.setBuffer(buf);
    v.setVolume(volume);
    v.setPlaybackRate(rate);
    this.listener.getWorldPosition(this.ear);
    v.play(at.distanceTo(this.ear) / 343); // sound arrives late from across the court
  }
}

/** The umpire, in the device's own voice. */
export class Umpire {
  private voice: SpeechSynthesisVoice | null = null;
  muted = false;

  constructor() {
    if (!("speechSynthesis" in window)) return;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find((v) => /en-GB/i.test(v.lang)) ?? vs.find((v) => /^en/i.test(v.lang)) ?? null;
    };
    pick();
    speechSynthesis.addEventListener?.("voiceschanged", pick);
  }

  /** Say it now (cancelling anything still being said), or after what's being said. */
  call(text: string, interrupt = false) {
    if (this.muted || !("speechSynthesis" in window) || !text) return;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.0;
    u.pitch = 0.95;
    speechSynthesis.speak(u);
  }
}
