import * as THREE from "three";
import { type Dream, dreamUrl } from "./dream";
import type { Guitar } from "./guitar";
import { type LaneClock, type LessonLike, RhythmJudge, type Strums, upcoming, type Verdict } from "./rhythm";

// The rhythm lane for a guitar lesson: a small strip just above the guitar's body, turned to your eyes, where the
// teacher's strums (strums.json) scroll in from the right as down and up arrows and cross a hit line as the clip plays
// them (slowed in the lesson, at full speed on your turn). Each of your strums gets On beat, Early or Late (within
// 80 ms), with a streak and this step's accuracy. Drawn at twice the headset's resolution and filtered for the angle
// it's seen at, so it stays sharp; the arrows move as meshes, so the text only redraws when it changes.

const W = 0.3; // m
const H = 0.072;
const HIT_X = -W / 2 + 0.045;
const END_X = W / 2 - 0.022;
const NOTE = 0.034;
const HORIZON = 2.2; // s of real time shown ahead
const PAST = 0.35;
const POOL = 20;
// in the guitar's own frame (+X along the neck, +Y toward the low E string, which is up as you hold it, +Z out of the
// top): above the upper bout and out in front of it, about 40 cm from your eyes and 50 degrees down, so it sits above
// your line of sight to the strings rather than over them
const SEAT = new THREE.Vector3(0.1, 0.26, 0.2);

/** strums.json for this dream, or null when it has none. */
export async function loadStrums(dream: Dream): Promise<Strums | null> {
  const file = (dream as Dream & { strums?: string | null }).strums;
  if (!file) return null;
  const r = await fetch(dreamUrl(dream.id, file), { cache: "no-cache" }).catch(() => null);
  if (!r?.ok) return null;
  const s = (await r.json().catch(() => null)) as Strums | null;
  if (!s || !Array.isArray(s.times) || !Array.isArray(s.down) || s.times.length !== s.down.length || !s.times.length) return null;
  return s;
}

function canvasTexture(w: number, h: number): { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { canvas, tex };
}

/** A clean arrow, white on clear (tinted by the material): down, or turned over for up. */
function arrowTexture(down: boolean): THREE.CanvasTexture {
  const { canvas, tex } = canvasTexture(256, 256);
  const c = canvas.getContext("2d")!;
  c.translate(128, 128);
  if (!down) c.rotate(Math.PI);
  c.strokeStyle = "#fff";
  c.lineCap = "round";
  c.lineJoin = "round";
  c.lineWidth = 30;
  c.beginPath();
  c.moveTo(0, -84);
  c.lineTo(0, 78);
  c.moveTo(-62, 18);
  c.lineTo(0, 82);
  c.lineTo(62, 18);
  c.stroke();
  return tex;
}

const COLOR = { ahead: 0xf5f5f7, on: 0x30d158, early: 0xffd60a, late: 0xffd60a, missed: 0x8e8e93, turn: 0x64d2ff };

export class StrumLane {
  readonly group = new THREE.Group();
  readonly judge: RhythmJudge;
  private notes: THREE.Mesh[] = [];
  private arrows: [THREE.CanvasTexture, THREE.CanvasTexture];
  private text = canvasTexture(2048, 256);
  private textMesh: THREE.Mesh;
  private shown = "";
  private active = false;
  private alpha = 0;
  private stepKey = "";
  private tick: AudioBuffer | null = null;
  private w = { p: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4(), up: new THREE.Vector3(), x: new THREE.Vector3(), z: new THREE.Vector3() };
  ticks = 0; // for checks

  constructor(
    scene: THREE.Scene,
    private guitar: Guitar,
    strums: Strums,
    private listener?: THREE.AudioListener,
  ) {
    this.judge = new RhythmJudge(strums);
    // the strip: dark glass, a faint track, the hit line
    const bg = canvasTexture(2048, Math.round((2048 * H) / W));
    const c = bg.canvas.getContext("2d")!;
    const k = bg.canvas.width / W;
    c.fillStyle = "rgba(24,24,26,0.78)";
    c.beginPath();
    c.roundRect(4, 4, bg.canvas.width - 8, bg.canvas.height - 8, bg.canvas.height / 2 - 4);
    c.fill();
    c.strokeStyle = "rgba(255,255,255,0.12)";
    c.lineWidth = 3;
    c.stroke();
    c.fillStyle = "rgba(255,255,255,0.08)";
    c.fillRect((HIT_X + W / 2) * k, bg.canvas.height / 2 - 3, (END_X - HIT_X) * k, 6);
    c.fillStyle = "rgba(255,255,255,0.85)";
    c.beginPath();
    c.roundRect((HIT_X + W / 2) * k - 7, 26, 14, bg.canvas.height - 52, 7);
    c.fill();
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: bg.tex, transparent: true, depthWrite: false }));
    strip.renderOrder = 12;
    this.group.add(strip);
    this.arrows = [arrowTexture(true), arrowTexture(false)];
    for (let n = 0; n < POOL; n++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(NOTE, NOTE), new THREE.MeshBasicMaterial({ map: this.arrows[0], transparent: true, depthWrite: false }));
      m.position.z = 0.001;
      m.renderOrder = 13;
      m.visible = false;
      this.notes.push(m);
      this.group.add(m);
    }
    this.textMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, W / 8), new THREE.MeshBasicMaterial({ map: this.text.tex, transparent: true, depthWrite: false }));
    this.textMesh.position.y = H / 2 + W / 16 + 0.004;
    this.textMesh.renderOrder = 12;
    this.group.add(this.textMesh);
    this.group.visible = false;
    scene.add(this.group);
    if (listener) this.tick = tickBuffer(listener.context);
    this.drawText(performance.now() / 1000, "");
  }

  setActive(on: boolean) {
    this.active = on;
    if (!on) this.group.visible = false;
  }

  /** Your strum (guitar.ts). */
  strum(down: boolean, now: number): Verdict | null {
    if (!this.active || !this.group.visible) return null; // nothing to play along with: not counted
    return this.judge.strum(down, now);
  }

  /** Once a frame in your room, after guitar.update: your eyes, and where the clip and the lesson are. */
  update(dt: number, nowMs: number, eye: THREE.Vector3, lesson: LessonLike | null, t: number, speed: number, playing: boolean, duration: number, clock: LaneClock | null) {
    const now = nowMs / 1000;
    const want = this.active && this.guitar.group.visible ? 1 : 0;
    this.alpha = THREE.MathUtils.clamp(this.alpha + (want ? dt / 0.25 : -dt / 0.25), 0, 1);
    this.group.visible = this.alpha > 0.01;
    if (!this.group.visible) return;
    // a new step: its accuracy starts again
    const key = lesson ? String(lesson.i) : "free";
    if (key !== this.stepKey) {
      this.stepKey = key;
      this.judge.resetStep();
    }
    const { due } = this.judge.advance(clock, now);
    // your turn has no teacher to hear: a soft tick on each of its beats
    for (const d of due) if (d.turn) this.playTick();
    this.place(eye);
    const list = upcoming(this.judge.strums, lesson, t, speed, playing, nowMs, duration, HORIZON, PAST);
    this.notes.forEach((m, n) => {
      const u = list[n];
      m.visible = !!u;
      if (!u) return;
      const x = u.dt >= 0 ? HIT_X + (u.dt / HORIZON) * (END_X - HIT_X) : Math.max(-W / 2 + NOTE / 2, HIT_X + (u.dt / PAST) * (HIT_X + W / 2 - NOTE / 2));
      m.position.x = x;
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.map = this.arrows[u.down ? 0 : 1];
      const state = u.dt < 0.3 ? this.judge.stateOf(u.k, now) : null;
      mat.color.setHex(state ? COLOR[state] : u.turn ? COLOR.turn : COLOR.ahead);
      const fadeIn = THREE.MathUtils.clamp((END_X - x) / 0.03, 0, 1);
      const fadeOut = u.dt < 0 ? 1 + u.dt / PAST : 1;
      mat.opacity = this.alpha * fadeIn * fadeOut * (state === "missed" ? 0.5 : 1);
      const big = state === "on" ? 1.25 : 1;
      m.scale.setScalar(big);
    });
    this.drawText(now, lesson ? `Step ${lesson.i + 1}` : "");
    (this.textMesh.material as THREE.MeshBasicMaterial).opacity = this.alpha;
    for (const c of this.group.children) if (c !== this.textMesh && !this.notes.includes(c as THREE.Mesh)) ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = this.alpha;
  }

  /** Above the guitar's body, facing your eyes, upright. */
  private place(eye: THREE.Vector3) {
    const { p, m, up, x, z } = this.w;
    this.guitar.group.localToWorld(p.copy(SEAT));
    z.subVectors(eye, p).normalize();
    up.set(0, 1, 0);
    x.crossVectors(up, z).normalize();
    up.crossVectors(z, x);
    this.group.position.copy(p);
    this.group.quaternion.setFromRotationMatrix(m.makeBasis(x, up, z));
  }

  private playTick() {
    this.ticks++;
    const ctx = this.listener?.context;
    if (!ctx || !this.tick || ctx.state !== "running") return;
    const src = ctx.createBufferSource();
    src.buffer = this.tick;
    const g = ctx.createGain();
    g.gain.value = 0.1;
    src.connect(g).connect(this.listener!.getInput());
    src.start();
  }

  private drawText(now: number, step: string) {
    const j = this.judge;
    const v = j.last && now - j.lastAt < 1.2 ? j.last : null;
    const acc = j.accuracy();
    const verdict = v ? (v.kind === "on" ? "On beat" : `${v.kind === "early" ? "Early" : "Late"} ${Math.abs(v.ms)} ms`) : "";
    const right = [step, acc === null ? "" : `${Math.round(acc * 100)}%`].filter(Boolean).join(" · ");
    const text = `${verdict}|${j.streak}|${right}`;
    if (text === this.shown) return;
    this.shown = text;
    const c = this.text.canvas.getContext("2d")!;
    const cw = this.text.canvas.width, ch = this.text.canvas.height;
    c.clearRect(0, 0, cw, ch);
    c.textBaseline = "middle";
    const font = (w: number, px: number) => `${w} ${px}px -apple-system, "SF Pro Text", "Inter", sans-serif`;
    const pill = (x: number, w: number) => {
      c.fillStyle = "rgba(24,24,26,0.78)";
      c.beginPath();
      c.roundRect(x, 24, w, ch - 48, (ch - 48) / 2);
      c.fill();
    };
    if (verdict) {
      c.font = font(700, 120);
      const w = c.measureText(verdict).width + 96;
      pill(8, w);
      c.fillStyle = v!.kind === "on" ? "#30d158" : "#ffd60a";
      c.textAlign = "left";
      c.fillText(verdict, 56, ch / 2 + 4);
    }
    if (j.streak >= 2) {
      const s = `Streak ${j.streak}`;
      c.font = font(700, 104);
      const w = c.measureText(s).width + 88;
      pill(cw / 2 - w / 2 + 120, w);
      c.fillStyle = "#f5f5f7";
      c.textAlign = "center";
      c.fillText(s, cw / 2 + 120, ch / 2 + 4);
    }
    if (right) {
      c.font = font(600, 96);
      const w = c.measureText(right).width + 88;
      pill(cw - 8 - w, w);
      c.fillStyle = "#e5e5ea";
      c.textAlign = "right";
      c.fillText(right, cw - 52, ch / 2 + 4);
    }
    this.text.tex.needsUpdate = true;
  }

  /** For checks (dev). */
  debug() {
    const j = this.judge;
    return { visible: this.group.visible, at: this.group.position.toArray().map((x) => +x.toFixed(3)), stats: { ...j.stats }, streak: j.streak, best: j.best, accuracy: j.accuracy(), last: j.last, ticks: this.ticks, notes: this.notes.filter((m) => m.visible).length };
  }
}

/** A soft wooden tick for your turn's beats. */
function tickBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.06);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    d[i] = (Math.sin(2 * Math.PI * 1760 * t) * 0.6 + Math.sin(2 * Math.PI * 880 * t) * 0.4) * Math.exp(-t / 0.012);
  }
  return b;
}
