import * as THREE from "three";
import type { Golf } from "./club";
import type { BodyJoints } from "./follow";
import { measureTempo, SwingTracker, tempoAdvice, type Swing, type Tempo } from "./tempo";

// The tempo coach for a golf lesson. His tempo is measured once from the clip's joints (tempo.ts); yours from your hands
// on the club, swing by swing, shown beside his with what to work on and your last five. With "Tempo tones" on (palm
// menu), three soft tones play his rhythm (takeaway, top, impact) for you to swing to: once each time you settle at
// address with the club, never on their own. A faint arc shows the path his hands took to the top, laid on your body the
// way Follow along lays its targets (his head on yours, turned the way you face, scaled to your height), so at address
// you can see where your hands go.

const FULL_SPEED_DOWN = 0.27; // s: a full-speed downswing (tour players: 0.25-0.3 s); slowed footage plays at this pace
const TONES_AFTER = 0.6; // s still at address before the tones start
type Place = "facing" | "beside" | "ahead";

function toneBuffer(ctx: BaseAudioContext, hz: number): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.2);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.006) * Math.exp(-t / 0.055);
    d[i] = (Math.sin(2 * Math.PI * hz * t) + 0.18 * Math.sin(4 * Math.PI * hz * t)) * env * 0.8;
  }
  return b;
}

export class GolfCoach {
  readonly his: Tempo | null;
  readonly tracker = new SwingTracker();
  /** The tempo card: hang it where it can be read (the viewer puts it under the step card). */
  readonly panel: THREE.Mesh;
  readonly arc = new THREE.Group();
  tonesOn = false;
  onChange: () => void = () => {};
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private arcMats: THREE.MeshBasicMaterial[] = [];
  private arcAlpha = 0;
  private theirEye: number;
  private yourEye = 0;
  private torso = new THREE.Vector3(0, 0, -1);
  private ready = false;
  private tonesPlayed = false;
  private scheduled: AudioBufferSourceNode[] = [];
  private buffers: AudioBuffer[] = [];
  private v = { head: new THREE.Vector3(), fwd: new THREE.Vector3() };
  private now = 0;
  tonesFired = 0; // for checks

  constructor(
    scene: THREE.Scene,
    private golf: Golf,
    joints: BodyJoints,
    experience: unknown,
    private listener?: THREE.AudioListener,
  ) {
    const hint = (experience as { tempo?: { takeaway?: number } } | null)?.tempo ?? null;
    this.his = measureTempo(joints, hint);
    const head = joints.names.indexOf("head");
    this.theirEye = Math.max(...joints.frames.map((f) => f[head][1])) + 0.07;
    golf.onHit = () => this.tracker.hit(performance.now() / 1000);
    this.tracker.onSwing = () => this.draw();

    this.canvas.width = 2048;
    this.canvas.height = 768;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.1125), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.panel.renderOrder = 11;
    this.panel.visible = false;
    this.draw();

    if (this.his) this.buildArc(joints, this.his);
    this.arc.visible = false;
    scene.add(this.arc);
    if (listener) this.buffers = [659.25, 659.25, 880].map((hz) => toneBuffer(listener.context, hz));
  }

  /** The tones' rhythm: his backswing and downswing, at full speed when the clip is slowed. */
  get tones(): { back: number; down: number } | null {
    if (!this.his) return null;
    const down = this.his.slowMotion ? FULL_SPEED_DOWN : this.his.down;
    return { back: this.his.ratio * down, down };
  }

  setActive(on: boolean) {
    this.panel.visible = on;
    this.arc.visible = on;
    this.ready = false;
    if (!on) this.cancelTones();
  }

  setTones(on: boolean) {
    this.tonesOn = on;
    this.tonesPlayed = false;
    if (!on) this.cancelTones();
    this.draw();
    this.onChange();
  }

  /** Once a frame in your room, after golf.update. now: ms (performance.now); eye and headQ: your headset. */
  update(dt: number, nowMs: number, eye: THREE.Vector3, headQ: THREE.Quaternion, place: Place, mirrored: boolean) {
    this.now = nowMs / 1000;
    const g = this.golf;
    const hands = g.handsLive ? g.handsAt.toArray() as [number, number, number] : null;
    this.tracker.update({ t: this.now, hands, holding: g.holding, address: g.atAddress });
    // the tones: once per settled address, only with the club in your hands
    const st = this.tracker.state;
    if (st === "idle") this.tonesPlayed = false;
    if (this.tonesOn && !this.tonesPlayed && st === "address" && this.tracker.stillFor >= TONES_AFTER) {
      this.tonesPlayed = true;
      this.playTones();
    }
    if (!g.holding && this.scheduled.length) this.cancelTones();
    this.placeArc(dt, eye, headQ, place, mirrored, st === "idle");
  }

  private playTones() {
    const ctx = this.listener?.context;
    const r = this.tones;
    if (!r) return;
    this.tonesFired++;
    if (!ctx || ctx.state !== "running" || !this.buffers.length) return;
    this.cancelTones();
    const t0 = ctx.currentTime + 0.05;
    [t0, t0 + r.back, t0 + r.back + r.down].forEach((when, k) => {
      const src = ctx.createBufferSource();
      src.buffer = this.buffers[k];
      const gain = ctx.createGain();
      gain.gain.value = 0.16;
      src.connect(gain).connect(this.listener!.getInput());
      src.start(when);
      src.onended = () => (this.scheduled = this.scheduled.filter((s) => s !== src));
      this.scheduled.push(src);
    });
  }

  private cancelTones() {
    for (const s of this.scheduled)
      try {
        s.stop();
      } catch {
        // not started yet or already over
      }
    this.scheduled = [];
  }

  // ---------------- his hand path, on your body

  private buildArc(j: BodyJoints, his: Tempo) {
    const L = j.names.indexOf("left_wrist"), R = j.names.indexOf("right_wrist"), H = j.names.indexOf("head");
    const n = j.frames.length;
    const at = (f: number, k: number) => {
      const i = Math.max(0, Math.min(n - 1, f));
      const a = Math.floor(i), b = Math.min(n - 1, a + 1), u = i - a;
      const fa = j.frames[a], fb = j.frames[b];
      return new THREE.Vector3().fromArray(fa[k]).lerp(new THREE.Vector3().fromArray(fb[k]), u);
    };
    const start = Math.max(0, his.frames.takeaway);
    const head0 = at(start, H);
    const hand = (f: number) => at(f, L).add(at(f, R)).multiplyScalar(0.5).sub(head0); // relative to his head
    const path = (a: number, b: number, from?: THREE.Vector3) => {
      const pts: THREE.Vector3[] = from ? [from] : [];
      const steps = Math.max(2, Math.ceil(b - a));
      for (let k = 0; k <= steps; k++) pts.push(hand(a + ((b - a) * k) / steps));
      return new THREE.CatmullRomCurve3(pts);
    };
    // a clip that starts with the hands already on their way back: the arc starts where they meet the ball, which is
    // about where they were at address
    const address = his.takeawayFrom === "joints" ? undefined : hand(his.frames.impact);
    const mat = (opacity: number) => {
      const m = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      m.userData.full = opacity;
      this.arcMats.push(m);
      return m;
    };
    const back = new THREE.Mesh(new THREE.TubeGeometry(path(start, his.frames.top, address), 160, 0.005, 8), mat(0.42));
    const down = new THREE.Mesh(new THREE.TubeGeometry(path(his.frames.top, his.frames.impact), 80, 0.0035, 8), mat(0.16));
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.016, 20, 14), mat(0.7));
    top.position.copy(hand(his.frames.top));
    for (const m of [back, down, top]) {
      m.renderOrder = 6;
      this.arc.add(m);
    }
  }

  /** Laid on you: his head on yours, turned the way your body faces, scaled by your height over his; mirrored when he
   * faces you (you copy him like a mirror) or is drawn flipped. Held still while you're at address and swinging. */
  private placeArc(dt: number, eye: THREE.Vector3, headQ: THREE.Quaternion, place: Place, mirrored: boolean, free: boolean) {
    const want = this.golf.holding && this.his ? 1 : 0;
    this.arcAlpha = THREE.MathUtils.clamp(this.arcAlpha + (want ? dt / 0.3 : -dt / 0.3), 0, 1);
    for (const m of this.arcMats) m.opacity = this.arcAlpha * m.userData.full;
    this.arc.visible = this.arcAlpha > 0.01;
    this.yourEye = this.ready ? Math.max(eye.y, this.yourEye - dt * 0.01) : eye.y;
    if (free || !this.ready) {
      const { head, fwd } = this.v;
      fwd.set(0, 0, -1).applyQuaternion(headQ).setY(0);
      if (fwd.lengthSq() > 1e-4) {
        fwd.normalize();
        this.torso.copy(this.ready ? this.torso.lerp(fwd, 1 - Math.exp(-dt / 0.5)).normalize() : fwd);
      }
      head.set(0, -0.07, 0.06).applyQuaternion(headQ).add(eye); // your head joint, a little below and behind your eyes
      const s = THREE.MathUtils.clamp(this.yourEye / this.theirEye, 0.75, 1.3);
      const flip = (place === "facing") !== mirrored ? -1 : 1;
      this.arc.position.copy(head);
      this.arc.rotation.set(0, Math.atan2(-this.torso.x, -this.torso.z), 0); // his front (-Z) the way you face
      this.arc.scale.set(s * flip, s, s);
      this.ready = true;
    }
  }

  // ---------------- the card

  private draw() {
    const c = this.canvas.getContext("2d")!;
    const W = 2048, H = 768, P = 88;
    c.clearRect(0, 0, W, H);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(44,44,48,0.86)");
    g.addColorStop(1, "rgba(22,22,24,0.86)");
    c.fillStyle = g;
    c.beginPath();
    c.roundRect(6, 6, W - 12, H - 12, 72);
    c.fill();
    c.strokeStyle = "rgba(255,255,255,0.14)";
    c.lineWidth = 3;
    c.stroke();
    const font = (w: number, px: number) => `${w} ${px}px -apple-system, "SF Pro Text", "Inter", sans-serif`;
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.fillStyle = "#a1a1a6";
    c.font = font(600, 64);
    c.fillText("Tempo", P, 124);
    if (this.tonesOn) {
      c.textAlign = "right";
      c.fillStyle = "#409cff";
      c.fillText("Tones on", W - P, 124);
      c.textAlign = "left";
    }
    const his = this.his;
    const last = this.tracker.history[this.tracker.history.length - 1] ?? null;
    const ratio = (r: number) => `${r.toFixed(1)} : 1`;
    // his
    c.fillStyle = "#f5f5f7";
    c.font = font(700, 150);
    const hisText = his ? `His ${ratio(his.ratio)}` : "His tempo: not in this clip";
    c.fillText(hisText, P, 310);
    if (his) {
      const x = P + c.measureText(hisText).width + 48;
      c.fillStyle = "#a1a1a6";
      c.font = font(500, 64);
      c.fillText(`${his.back.toFixed(2)} s / ${his.down.toFixed(2)} s${his.slowMotion ? " · slowed clip" : ""}`, x, 304, W - P - x);
    }
    // yours
    c.font = font(700, 150);
    c.fillStyle = last ? "#f5f5f7" : "#8e8e93";
    const yoursText = last ? `Yours ${ratio(last.ratio)}` : "Yours: swing from address";
    c.fillText(yoursText, P, 500);
    if (last && his) {
      const x = P + c.measureText(yoursText).width + 48;
      const close = Math.abs(last.ratio - his.ratio) <= 0.3;
      c.fillStyle = close ? "#30d158" : "#ffd60a";
      c.font = font(600, 64);
      c.fillText(tempoAdvice(last.ratio, his.ratio), x, 494, W - P - x);
    }
    // your last five, oldest first, each against his
    const hist = this.tracker.history;
    if (hist.length) {
      c.font = font(600, 64);
      c.fillStyle = "#a1a1a6";
      c.fillText("Last 5", P, 668);
      let x = P + c.measureText("Last 5").width + 40;
      for (const s of hist) {
        const near = his ? Math.abs(s.ratio - his.ratio) <= 0.3 : false;
        const label = s.ratio.toFixed(1);
        c.font = font(700, 68);
        const w = c.measureText(label).width + 68;
        c.fillStyle = near ? "rgba(48,209,88,0.22)" : "rgba(255,255,255,0.12)";
        c.beginPath();
        c.roundRect(x, 600, w, 96, 48);
        c.fill();
        c.fillStyle = near ? "#30d158" : "#e5e5ea";
        c.fillText(label, x + 34, 672);
        x += w + 22;
      }
    }
    this.tex.needsUpdate = true;
  }

  /** For checks (dev). */
  debug() {
    const r = (x: number) => +x.toFixed(3);
    const h = this.his;
    return {
      his: h ? { ratio: r(h.ratio), back: r(h.back), down: r(h.down), takeaway: r(h.takeaway), top: r(h.top), impact: r(h.impact), from: h.takeawayFrom, slowMotion: h.slowMotion } : null,
      tones: this.tones && { back: r(this.tones.back), down: r(this.tones.down) },
      tonesOn: this.tonesOn,
      tonesFired: this.tonesFired,
      state: this.tracker.state,
      stillFor: r(this.tracker.stillFor),
      rejected: this.tracker.rejected,
      swings: this.tracker.history.map((s: Swing) => ({ ratio: r(s.ratio), back: r(s.back), down: r(s.down), hit: s.hit, topFromGap: s.topFromGap })),
      arc: { visible: this.arc.visible, alpha: r(this.arcAlpha), at: this.arc.position.toArray().map(r), scale: r(this.arc.scale.y) },
    };
  }
}
