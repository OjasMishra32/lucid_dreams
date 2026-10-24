import * as THREE from "three";
import { type Dream, dreamUrl } from "./dream";
import { type BodyJoints, jointAt } from "./follow";

// The beat of the clip (beats.json, from pipeline/lucid/beats.py: the music's beat, or the body's when the clip is
// silent), shown as a quiet ring of light on the floor around them that swells and fades on each beat, on the clip's
// own clock (slowed with it in a lesson). On your turn the clip stands still, so the ring keeps the beat going at full
// speed instead: a second's count-in before the move (a soft tick on each, as a teacher counts you in), then the step's
// own beats as you dance it.

/** On your turn the move starts this long after the turn does, on the beat grid carried on from the step (the count-in),
 * which leaves half a second of the turn's 1.5 s breath after the move for anyone a little behind. */
export const COUNT_IN = 1.0;

export interface Beats {
  bpm: number;
  times: number[]; // seconds in the bundle's clip time
  source?: "audio" | "motion";
  confidence?: number;
}

export async function loadBeats(dream: Dream): Promise<Beats | null> {
  if (!dream.beats) return null;
  const r = await fetch(dreamUrl(dream.id, dream.beats), { cache: "no-cache" }).catch(() => null);
  if (!r?.ok) return null;
  const b = (await r.json().catch(() => null)) as Beats | null;
  if (!b || !Array.isArray(b.times) || b.times.length < 2 || !(b.bpm > 0)) return null;
  b.times = b.times.filter(Number.isFinite).sort((x, y) => x - y);
  return b;
}

/** The beats in (from, to] of clip time: the bundle's own, carried on at the tempo before the first and after the last. */
export function beatsBetween(b: Beats, from: number, to: number): number[] {
  const period = 60 / b.bpm;
  const first = b.times[0], last = b.times[b.times.length - 1];
  const out: number[] = [];
  if (from < first)
    for (let k = Math.floor((first - from) / period); k >= 1; k--) {
      const x = first - k * period;
      if (x > from && x <= to) out.push(x);
    }
  for (const x of b.times) if (x > from && x <= to) out.push(x);
  if (to > last)
    for (let k = Math.max(1, Math.floor((from - last) / period)); last + k * period <= to; k++) {
      const x = last + k * period;
      if (x > from) out.push(x);
    }
  return out;
}

/** The count of the beat nearest clip time t within a step that starts at `start` (1-based, in eights). */
export function countAt(b: Beats, start: number, t: number): number {
  const grid = beatsBetween(b, start - 30 / b.bpm, t + 30 / b.bpm);
  if (!grid.length) return 1;
  let k = 0;
  for (let i = 1; i < grid.length; i++) if (Math.abs(grid[i] - t) < Math.abs(grid[k] - t)) k = i;
  return (k % 8) + 1;
}

function ringTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(256, 256, 180, 256, 256, 255);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.62, "rgba(255,255,255,0.08)");
  g.addColorStop(0.8, "rgba(255,255,255,0.9)");
  g.addColorStop(0.9, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8; // seen flat on the floor, at a steep angle
  return tex;
}

const PULSE_S = 0.5; // how long a pulse lasts, in your time (the same at any speed)

export class BeatRing {
  /** On the floor in the person's own space: add it to the person. */
  readonly group = new THREE.Group();
  /** Pulses so far (for checks). */
  pulses = 0;
  private rings: THREE.Mesh[] = [];
  private age: number[] = [];
  private strength: number[] = [];
  private next = 0;
  private last: number | null = null;
  private idx: Record<string, number> | null;
  private centre = new THREE.Vector3();
  private tick: AudioBuffer | null = null;
  /** The pulses, newest last (for checks): the beat's clip time, the clock when it showed, and whether it counted in. */
  readonly log: { t: number; at: number; strong: boolean }[] = [];

  constructor(
    private beats: Beats,
    private radius: number,
    private joints: BodyJoints | null,
    private listener?: THREE.AudioListener,
  ) {
    const tex = ringTexture();
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: tex, color: 0xd6e8ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.004;
      m.renderOrder = 1;
      m.visible = false;
      this.rings.push(m);
      this.age.push(Infinity);
      this.strength.push(0);
      this.group.add(m);
    }
    this.idx = joints ? Object.fromEntries(joints.names.map((n, i) => [n, i])) : null;
    if (listener) this.tick = tickBuffer(listener.context);
  }

  /**
   * Once a frame. t: the clip time the beat follows (on your turn, the count-in clock: see the viewer); at: the clip
   * time of their pose, which the ring centres on (they're frozen on your turn); countIn: before the move starts on
   * your turn (a soft tick out loud, and a little stronger).
   */
  update(dt: number, t: number, at: number, countIn = false) {
    // a beat crossed since the last frame; a jump (a new step, a repeat, scrubbing) starts the count afresh
    if (this.last !== null && t > this.last && t - this.last < 0.3)
      for (const b of beatsBetween(this.beats, this.last, t)) this.pulse(b, t, countIn);
    this.last = t;
    if (this.idx && this.joints) {
      jointAt(this.joints, this.idx, "pelvis", at, this.centre);
      this.group.position.set(this.centre.x, 0, this.centre.z);
    }
    for (let i = 0; i < this.rings.length; i++) {
      this.age[i] += dt;
      const m = this.rings[i];
      const k = this.age[i] / PULSE_S;
      m.visible = k < 1;
      if (!m.visible) continue;
      const ease = 1 - (1 - k) ** 3;
      m.scale.setScalar(this.radius * (0.92 + 0.3 * ease));
      // a quick swell, then a long fade
      (m.material as THREE.MeshBasicMaterial).opacity = this.strength[i] * Math.min(1, k / 0.12) * (1 - k) ** 1.6;
    }
  }

  private pulse(t: number, at: number, strong: boolean) {
    const i = this.next;
    this.next = (this.next + 1) % this.rings.length;
    this.age[i] = 0;
    this.strength[i] = strong ? 0.75 : 0.45;
    this.pulses++;
    this.log.push({ t: +t.toFixed(3), at: +at.toFixed(3), strong });
    if (this.log.length > 64) this.log.shift();
    if (strong) this.click();
  }

  /** Back to quiet: no ring showing (leaving the room, a lesson jump). */
  reset() {
    this.last = null;
    this.age.fill(Infinity);
    for (const m of this.rings) m.visible = false;
  }

  private click() {
    const ctx = this.listener?.context;
    if (!ctx || !this.tick || ctx.state !== "running") return;
    const src = ctx.createBufferSource();
    src.buffer = this.tick;
    const g = ctx.createGain();
    g.gain.value = 0.1;
    src.connect(g).connect(this.listener!.getInput());
    src.start();
  }
}

/** A soft wooden tick: a short burst of a high, damped tone and a little noise. */
function tickBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.06);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    seed = (seed * 16807) % 2147483647;
    const noise = (seed / 2147483647) * 2 - 1;
    const env = Math.min(1, t / 0.001) * Math.exp(-t / 0.012);
    d[i] = (Math.sin(2 * Math.PI * 1760 * t) * 0.6 + Math.sin(2 * Math.PI * 2640 * t) * 0.25 + noise * 0.15) * env;
  }
  return b;
}
