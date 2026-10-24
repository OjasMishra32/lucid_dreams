import * as THREE from "three";

// The table's sounds, made here with WebAudio (no files): a short wooden clack when a piece is set down, a soft
// click when a clock button goes down. Each plays from where it happened (THREE.PositionalAudio), so in the headset
// the clack comes from the square.

const VOICES = 6;

export class TableSounds {
  readonly listener = new THREE.AudioListener();
  private voices: THREE.PositionalAudio[] = [];
  private next = 0;
  private clackBufs: AudioBuffer[];
  private clickBuf: AudioBuffer;

  constructor(camera: THREE.Camera, scene: THREE.Scene) {
    camera.add(this.listener); // in the headset the camera carries the head's pose, so this is your ears
    const ctx = this.listener.context;
    this.clackBufs = [0.92, 1, 1.09].map((pitch, i) => clack(ctx, pitch, 17 + i * 31));
    this.clickBuf = click(ctx);
    for (let i = 0; i < VOICES; i++) {
      const v = new THREE.PositionalAudio(this.listener);
      v.setRefDistance(0.6);
      v.setRolloffFactor(1.2);
      scene.add(v);
      this.voices.push(v);
    }
    // browsers start audio suspended until the page is touched
    const wake = () => {
      if (ctx.state !== "running") void ctx.resume();
    };
    for (const e of ["pointerdown", "keydown", "touchstart"]) addEventListener(e, wake, { passive: true });
  }

  /** A piece set down at a world position; soft is a gentler placing (a piece put aside). */
  clack(at: THREE.Vector3, soft = false) {
    const buf = this.clackBufs[Math.floor(Math.random() * this.clackBufs.length)];
    this.play(buf, at, (soft ? 0.45 : 0.9) * (0.85 + Math.random() * 0.15), 0.96 + Math.random() * 0.08);
  }

  /** A clock button. */
  click(at: THREE.Vector3) {
    this.play(this.clickBuf, at, 0.55, 0.97 + Math.random() * 0.06);
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
    v.play();
  }
}

/** A tiny seeded noise source, so each variant is the same every time. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/**
 * A hard felt-padded piece meeting a wooden board: a sharp, bright transient, two short wooden modes, and a low knock
 * of the board itself, all gone in about 90 ms.
 */
function clack(ctx: BaseAudioContext, pitch: number, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.12);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const noise = rng(seed);
  const modes = [
    { f: 1750 * pitch, decay: 0.018, amp: 0.55 },
    { f: 2870 * pitch, decay: 0.011, amp: 0.32 },
    { f: 4230 * pitch, decay: 0.006, amp: 0.16 },
    { f: 380 * pitch, decay: 0.03, amp: 0.4 }, // the board
  ];
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const attack = Math.min(1, t / 0.0006);
    lp += 0.45 * (noise() - lp); // a little body in the transient
    let v = lp * Math.exp(-t / 0.0025) * 0.9;
    for (const m of modes) v += m.amp * Math.sin(2 * Math.PI * m.f * t) * Math.exp(-t / m.decay);
    d[i] = v * attack;
  }
  normalize(d, 0.85);
  return buf;
}

/** A clock button: a soft plastic tick, then the mechanism settling a moment later. */
function click(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.06);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const noise = rng(7);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tick = (tt: number, amp: number) => (tt < 0 ? 0 : amp * (noise() * Math.exp(-tt / 0.0012) + 0.6 * Math.sin(2 * Math.PI * 3100 * tt) * Math.exp(-tt / 0.004)));
    d[i] = tick(t, 1) + tick(t - 0.022, 0.35);
  }
  normalize(d, 0.6);
  return buf;
}

function normalize(d: Float32Array, peak: number) {
  let m = 0;
  for (const v of d) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
}
