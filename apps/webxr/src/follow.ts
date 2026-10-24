import * as THREE from "three";
import { type Dream, dreamUrl } from "./dream";
import { liveJoints } from "./xr/hands";
import { handIndex } from "./xr/menu";

// Follow along: in a lesson, soft glowing targets show where YOUR head and wrists should be right now, taken from the
// person's own joints (joints.json, from the clip) at the moment of the clip you're watching. They're set on your body:
// their pose relative to their hips, turned the way your body faces, scaled to your height (your eye height against
// theirs), and, when they face you, mirrored, so you copy them like a mirror (the hand on your left follows the hand you
// see on your left). A match score (0-100) says how close your tracked head and wrists are; on your turn, holding the
// pose within about 10 cm for half a second gives a quiet chime. The targets never sit over the person, and they fade
// when you've walked away from where you were following.

export interface BodyJoints {
  fps: number;
  names: string[];
  frames: number[][][]; // per bundle frame, per name: [x, y, z] in bundle space (+X their right, front -Z)
}

type Part = "head" | "left_wrist" | "right_wrist";
const PARTS: Part[] = ["head", "left_wrist", "right_wrist"];
const WEIGHT: Record<Part, number> = { head: 0.2, left_wrist: 0.4, right_wrist: 0.4 };
const SWAP: Record<Part, Part> = { head: "head", left_wrist: "right_wrist", right_wrist: "left_wrist" };
type Place = "facing" | "beside" | "ahead";

/** joints.json for this dream, or null when it has none. */
export async function loadJoints(dream: Dream): Promise<BodyJoints | null> {
  if (!dream.joints) return null;
  const r = await fetch(dreamUrl(dream.id, dream.joints), { cache: "no-cache" }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as BodyJoints | null;
  if (!j || !Array.isArray(j.frames) || !j.frames.length || !Array.isArray(j.names)) return null;
  for (const p of [...PARTS, "pelvis"]) if (!j.names.includes(p)) return null;
  return j;
}

function ringTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 18, 64, 64, 62);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.55, "rgba(255,255,255,0.15)");
  g.addColorStop(0.78, "rgba(255,255,255,0.95)");
  g.addColorStop(0.9, "rgba(255,255,255,0.3)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class FollowAlong {
  readonly group = new THREE.Group();
  /** A small "Match 72 · Best 85" for the step card. */
  readonly label: THREE.Mesh;
  enabled = true;
  score = 0; // smoothed, 0-100
  best = 0; // this step's best
  private idx: Record<string, number>;
  private sprites = {} as Record<Part, THREE.Sprite>;
  private theirEye: number;
  private yourEye = 0;
  private root = new THREE.Vector3();
  private torso = new THREE.Vector3(0, 0, -1);
  private ready = false;
  private held = 0; // seconds the pose has been held within 10 cm on your turn
  // where each of yours was last seen, and for how long it hasn't been: a moment's dropout keeps the last place; a
  // longer one pauses the score (it neither drops nor, counted from the head alone, jumps up)
  private last = { head: new THREE.Vector3(), left_wrist: new THREE.Vector3(), right_wrist: new THREE.Vector3() } as Record<Part, THREE.Vector3>;
  private lost = { head: Infinity, left_wrist: Infinity, right_wrist: Infinity } as Record<Part, number>;
  private chimed = false;
  private wasTurn = false;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private shown = "";
  private chime: AudioBuffer | null = null;
  private v = Array.from({ length: 11 }, () => new THREE.Vector3());

  constructor(
    scene: THREE.Scene,
    private joints: BodyJoints,
    private hands: THREE.Object3D[],
    private sideOf: (i: number) => XRHandedness | null,
    private listener?: THREE.AudioListener,
  ) {
    this.idx = Object.fromEntries(joints.names.map((n, i) => [n, i]));
    const head = this.idx.head;
    this.theirEye = Math.max(...joints.frames.map((f) => f[head][1])) + 0.07; // standing, as tall as they get in the clip
    const tex = ringTexture();
    for (const p of PARTS) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x9fd0ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.scale.setScalar(p === "head" ? 0.15 : 0.1);
      s.renderOrder = 5;
      this.sprites[p] = s;
      this.group.add(s);
    }
    this.group.visible = false;
    scene.add(this.group);
    this.canvas.width = 512;
    this.canvas.height = 96;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.049), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.label.renderOrder = 11;
    this.label.visible = false;
    if (listener) this.chime = chimeBuffer(listener.context);
  }

  setActive(on: boolean) {
    this.group.visible = on && this.enabled;
    this.label.visible = on && this.enabled;
    this.ready = false;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.group.visible = this.label.visible = on;
  }

  /** A new step of the lesson: its best starts again. */
  resetStep() {
    this.best = 0;
    this.chimed = false;
    this.held = 0;
  }

  /** Their joint at clip time t (bundle space), between frames. */
  private joint(name: string, t: number, out: THREE.Vector3): THREE.Vector3 {
    const fr = this.joints.frames;
    const f = THREE.MathUtils.clamp(t * this.joints.fps, 0, fr.length - 1);
    const i = Math.floor(f), k = f - i, j = this.idx[name];
    const a = fr[i][j], b = fr[Math.min(i + 1, fr.length - 1)][j];
    return out.set(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
  }

  /**
   * Once a frame in your room. t: the clip time shown; eye and headQ: your headset; place: where they stand (facing you
   * mirrors); mirrored: they're drawn flipped (the palm menu's Mirror); person: their centre (targets keep clear of it);
   * turn: it's your turn in the lesson (the chime).
   */
  update(dt: number, t: number, eye: THREE.Vector3, headQ: THREE.Quaternion, place: Place, mirrored: boolean, person: THREE.Vector3, turn: boolean) {
    if (!this.enabled || dt <= 0) return;
    const [pivot, fwd, right, up, P, J, target, mine, floorUnder, toT, toP] = this.v;
    // your body: the head turns about the top of the spine; the body faces where the head has been facing (slowly)
    pivot.set(0, -0.1, 0.09).applyQuaternion(headQ).add(eye);
    const hf = fwd.set(0, 0, -1).applyQuaternion(headQ).setY(0);
    if (hf.lengthSq() > 1e-4) {
      hf.normalize();
      this.torso.copy(this.ready ? this.torso.lerp(hf, 1 - Math.exp(-dt / 0.5)).normalize() : hf);
    }
    fwd.copy(this.torso);
    right.set(-fwd.z, 0, fwd.x);
    up.set(0, 1, 0);
    if (!this.ready) this.root.set(pivot.x, 0, pivot.z);
    const away = Math.hypot(pivot.x - this.root.x, pivot.z - this.root.z);
    this.root.lerp(floorUnder.set(pivot.x, 0, pivot.z), 1 - Math.exp(-dt / 1.0)); // you can step about; it follows
    this.yourEye = this.ready ? Math.max(eye.y, this.yourEye - dt * 0.01) : eye.y;
    this.ready = true;
    const s = THREE.MathUtils.clamp(this.yourEye / this.theirEye, 0.75, 1.3);

    // their pose about their own hips on the floor, in their frame (+X their right, -Z their front)
    this.joint("pelvis", t, P);
    const mirrorMap = place === "facing";
    let total = 0, weight = 0, worst = 0, complete = true;
    const fade = THREE.MathUtils.clamp(1 - (away - 0.6) / 0.4, 0, 1); // walked off: the targets fade
    for (const part of PARTS) {
      // what's drawn: flipped if they're mirrored (their sides swap); copied like a mirror when they face you
      const drawn: Part = mirrored ? SWAP[part] : part;
      const src: Part = mirrorMap ? SWAP[drawn] : drawn;
      this.joint(src, t, J);
      let lat = (J.x - P.x) * (mirrored ? -1 : 1);
      if (mirrorMap) lat = -lat;
      const fwdOff = -(J.z - P.z);
      target.copy(this.root).addScaledVector(right, lat * s).addScaledVector(fwd, fwdOff * s).addScaledVector(up, J.y * s);
      const sprite = this.sprites[part];
      sprite.position.copy(target);
      // where yours is: your head joint (a little below and behind your eyes), or your wrist
      let have = part === "head" ? this.yourHead(eye, headQ, mine) : this.yourWrist(part === "left_wrist" ? "left" : "right", mine);
      if (have) {
        this.lost[part] = 0;
        this.last[part].copy(mine);
      } else if ((this.lost[part] += dt) < 0.5) {
        mine.copy(this.last[part]);
        have = true;
      } else complete = false;
      const d = have ? mine.distanceTo(target) : Infinity;
      if (have) {
        total += WEIGHT[part] * THREE.MathUtils.clamp(1 - (d - 0.06) / 0.34, 0, 1);
        weight += WEIGHT[part];
        worst = Math.max(worst, d);
      }
      // never over the person: a target in front of them, as you look, steps back
      toT.subVectors(target, eye);
      toP.subVectors(person, eye);
      const blocking = toT.angleTo(toP) < THREE.MathUtils.degToRad(14) && toT.length() < toP.length();
      const close = have && d < 0.1;
      const m = sprite.material as THREE.SpriteMaterial;
      m.color.setHex(close ? 0x9dffb0 : 0x9fd0ff);
      const want = fade * (blocking ? 0.12 : close ? 0.85 : 0.55);
      m.opacity += (want - m.opacity) * (1 - Math.exp(-dt / 0.15));
    }
    if (complete) {
      const raw = weight > 0 ? (100 * total) / weight : 0;
      this.score += (raw - this.score) * (1 - Math.exp(-dt / 0.3));
      this.best = Math.max(this.best, this.score);
    }
    // your turn: hold their pose (everything tracked within 10 cm) for half a second, a quiet chime, once a turn
    if (turn !== this.wasTurn) {
      this.wasTurn = turn;
      this.held = 0;
      this.chimed = false;
    }
    this.held = turn && complete && worst < 0.1 ? this.held + dt : 0;
    if (turn && !this.chimed && this.held >= 0.5) {
      this.chimed = true;
      this.ding();
    }
    this.drawLabel();
  }

  private yourHead(eye: THREE.Vector3, headQ: THREE.Quaternion, out: THREE.Vector3): boolean {
    out.set(0, -0.07, 0.06).applyQuaternion(headQ).add(eye);
    return true;
  }

  private yourWrist(side: "left" | "right", out: THREE.Vector3): boolean {
    const w = liveJoints(this.hands[handIndex(this.sideOf, side)]).wrist;
    if (!w?.visible) return false;
    w.getWorldPosition(out);
    return true;
  }

  private drawLabel() {
    const text = `Match ${Math.round(this.score)}  ·  Best ${Math.round(this.best)}`;
    if (text === this.shown) return;
    this.shown = text;
    const x = this.canvas.getContext("2d")!;
    x.clearRect(0, 0, 512, 96);
    x.fillStyle = "rgba(29,29,31,0.72)";
    x.beginPath();
    x.roundRect(4, 4, 504, 88, 44);
    x.fill();
    x.fillStyle = "#f5f5f7";
    x.font = '600 44px -apple-system, "SF Pro Text", "Inter", sans-serif';
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(text, 256, 50, 470);
    this.tex.needsUpdate = true;
  }

  private ding() {
    const ctx = this.listener?.context;
    if (!ctx || !this.chime || ctx.state !== "running") return;
    const src = ctx.createBufferSource();
    src.buffer = this.chime;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(g).connect(this.listener!.getInput());
    src.start();
  }

  /** For checks (dev). */
  debug() {
    const r = (v: THREE.Vector3) => v.toArray().map((n) => +n.toFixed(3));
    return { score: Math.round(this.score), best: Math.round(this.best), targets: Object.fromEntries(PARTS.map((p) => [p, r(this.sprites[p].position)])), chimed: this.chimed, yourEye: +this.yourEye.toFixed(2), theirEye: +this.theirEye.toFixed(2) };
  }
}

/** A quiet two-note chime (C6 and G6), soft attack, ringing out. */
function chimeBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.7);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.006) * Math.exp(-t / 0.22);
    const late = t > 0.07 ? Math.min(1, (t - 0.07) / 0.006) * Math.exp(-(t - 0.07) / 0.25) : 0;
    d[i] = Math.sin(2 * Math.PI * 1046.5 * t) * env * 0.5 + Math.sin(2 * Math.PI * 1568 * t) * late * 0.45;
  }
  return b;
}
