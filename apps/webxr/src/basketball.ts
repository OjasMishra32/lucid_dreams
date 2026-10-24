import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Dream } from "./dream";
import type { Experience } from "./experience";
import { basketballTextures, HOOP, type Props, shadowTexture, standaloneHoop } from "./props";

// A real size-7 ball in your own hands, to shoot at the hoop in a basketball dream. No gesture does anything: you hold
// it by putting your palms on it (one hand under it, or both on its sides), it follows your hands, and it leaves them
// the way a real ball does, when your hands stop pushing (they slow down after a push) or come off it. It flies with
// gravity and a little drag and spin, bounces off your floor, the glass and the ring, drops through the net, and a
// make counts when its centre goes down through the ring. Then it comes back to you, floating at your waist like a pass.

const R = 0.12; // size 7: 74.9 cm round
const G = 9.81;
const DRAG = 0.02; // 0.5 rho Cd A / m for a 620 g ball (Cd 0.47)
const ALPHA = 2 / 3; // a hollow ball's moment of inertia, as a fraction of m r^2
const MAX_SPEED = 12; // m/s off your hands
const BACKSPIN = 9; // rad/s, about 1.5 turns a second, the way a shot leaves the fingertips
const PALM_OUT = 0.015; // from the palm's bones out to its skin
const GRAB = R + 0.025; // a palm this close to the centre (and facing it) is on the ball
const REGRAB_S = 0.4; // after it leaves your hands it can't come straight back to them
const RESPAWN_S = 6;
const { RIM_R, RIM_TUBE, BOARD_GAP, BOARD_W, BOARD_H, BOARD_T, BOARD_BELOW_RIM, NET_LEN } = HOOP;
const FREE_THROW = 4.6; // from the board's face to the free-throw line

/** A basketball dream (a hoop or a ball in props.json, or the intent / name says so), or ?ball=1. ?ball=0: never. */
export function wantsBall(dream: Dream, experience: Experience | null, props: Props | null, golf: boolean, search = location.search): boolean {
  const q = new URLSearchParams(search).get("ball");
  if (q !== null) return q !== "0" && q !== "false";
  if (golf) return false;
  if (props?.hoopGroups.length) return true;
  const text = [dream.intent, dream.name, experience?.intent, experience?.title].join(" ");
  return /basketball|\bshot\b|jumper|dunk|lay-?up|free throw|\bhoop/i.test(text);
}

type Joints = Record<string, THREE.Object3D>;
const TIPS = ["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"];
const NEEDED = ["wrist", "middle-finger-metacarpal", "middle-finger-phalanx-proximal", ...TIPS];

/** One hand as something that holds a ball: where its palm is, which way it faces, its fingertips. */
class Palm {
  tracked = false;
  readonly pos = new THREE.Vector3(); // the palm's skin, middle of the hand
  readonly normal = new THREE.Vector3(); // out of the palm
  readonly quat = new THREE.Quaternion();
  readonly tips = TIPS.map(() => new THREE.Vector3());
  private a = new THREE.Vector3();

  read(hand: THREE.Object3D | undefined) {
    const j = (hand as unknown as { joints?: Joints } | undefined)?.joints ?? {};
    this.tracked = NEEDED.every((n) => j[n]?.visible);
    if (!this.tracked) return;
    j["middle-finger-metacarpal"].getWorldQuaternion(this.quat);
    this.normal.set(0, -1, 0).applyQuaternion(this.quat); // WebXR: -Y out of the palm
    j["middle-finger-metacarpal"].getWorldPosition(this.pos);
    j["middle-finger-phalanx-proximal"].getWorldPosition(this.a);
    this.pos.lerp(this.a, 0.5).addScaledVector(this.normal, PALM_OUT);
    TIPS.forEach((n, k) => j[n].getWorldPosition(this.tips[k]));
  }

  /** On the ball: close to its centre and facing it. */
  on(c: THREE.Vector3, reach = GRAB, facing = 0.35): boolean {
    if (!this.tracked) return false;
    const d = this.a.subVectors(c, this.pos);
    const len = d.length();
    return len < reach && this.normal.dot(d) > facing * len;
  }

  /** Fingertips on the ball's skin: three or more is a hand wrapped round it, which can pull as well as push. */
  wraps(c: THREE.Vector3): boolean {
    return this.tips.filter((t) => t.distanceTo(c) < R + 0.03).length >= 3;
  }
}

type State = "floating" | "held" | "flying" | "away";
type Hit = "floor" | "board" | "rim" | "swish";

export class Basketball {
  readonly ball: THREE.Mesh;
  /** The hoop you shoot at: one from props.json (it rides with the person until you move it), or one of our own. */
  readonly hoop: THREE.Group | null;
  /** True once the hoop stands on its own in the room (a scene child): anchor it then (WorldLock). */
  hoopInRoom = false;
  private hoopHome: { parent: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion } | null = null;
  private rimTop = 3.05;
  private shadow: THREE.Mesh;
  private mat: THREE.MeshPhysicalMaterial;
  private palms = [new Palm(), new Palm()];
  private state: State = "away";
  private holders: number[] = []; // which hands hold it
  private rel = new THREE.Quaternion(); // the ball's turn relative to the holding hand
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private spin = new THREE.Vector3(); // angular velocity, rad/s
  private home = new THREE.Vector3(); // where it floats when it comes back to you
  private alpha = 0;
  private t = 0; // seconds, this ball's own clock
  private stateT = 0;
  private restT = 0;
  private lostT = 0;
  private hist: { t: number; p: THREE.Vector3 }[] = []; // where your hands had it, the last moments
  private vHist: { t: number; v: THREE.Vector3 }[] = [];
  private madeThisShot = false;
  private touchedThisShot = false;
  private makes = 0;
  private shots = 0;
  private counter: { mesh: THREE.Mesh; draw: () => void } | null = null;
  private sounds: THREE.PositionalAudio[] = [];
  private buffers: Partial<Record<Hit, AudioBuffer>> = {};
  private lastSound: Partial<Record<Hit, number>> = {};
  private hoopInv = new THREE.Matrix4();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private q1 = new THREE.Quaternion();
  private personAt = new THREE.Vector3();
  private personR = 0.35;
  private wasHidden = false;
  log: string[] = []; // dev: what happened, newest last

  constructor(
    private scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private hands: THREE.Object3D[],
    listener: THREE.AudioListener | undefined,
    props: Props | null,
  ) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    const { map, bump } = basketballTextures(R);
    map.anisotropy = bump.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.mat = new THREE.MeshPhysicalMaterial({ map, bumpMap: bump, bumpScale: 1.6, roughness: 0.66, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.5, envMap: env, envMapIntensity: 0.9, transparent: true });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 40), this.mat);
    this.ball.quaternion.setFromEuler(new THREE.Euler(0.35, 0.6, 0.2));
    this.ball.visible = false;
    scene.add(this.ball);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = -1;
    this.shadow.visible = false;
    scene.add(this.shadow);

    const fromProps = props?.hoopGroups[0] ?? null;
    if (fromProps) {
      this.hoop = fromProps;
      this.rimTop = Number(fromProps.userData.rimTop) || 3.05;
      this.hoopHome = { parent: fromProps.parent!, pos: fromProps.position.clone(), quat: fromProps.quaternion.clone() };
    } else {
      this.hoop = standaloneHoop(renderer);
      this.hoop.visible = false;
      scene.add(this.hoop);
      this.hoopInRoom = true;
    }
    this.counter = scoreLabel(() => `${this.makes} / ${this.shots}`);
    const face = -(RIM_R + BOARD_GAP);
    this.counter.mesh.position.set(BOARD_W / 2 - 0.24, this.rimTop - BOARD_BELOW_RIM + 0.11, face + 0.004);
    this.counter.mesh.visible = false;
    this.hoop.add(this.counter.mesh);

    if (listener) {
      for (let k = 0; k < 4; k++) {
        const s = new THREE.PositionalAudio(listener);
        s.setRefDistance(1.6);
        scene.add(s);
        this.sounds.push(s);
      }
      const ctx = listener.context;
      this.buffers = { floor: tone(ctx, "floor"), board: tone(ctx, "board"), rim: tone(ctx, "rim"), swish: tone(ctx, "swish") };
    }
  }

  /** In your room or not. Leaving puts the hoop back where the dream had it. */
  setActive(on: boolean) {
    if (on) {
      if (this.hoop && !this.hoopHome) this.hoop.visible = true;
      return;
    }
    this.state = "away";
    this.ball.visible = this.shadow.visible = false;
    this.alpha = 0;
    if (this.hoop && this.hoopHome && this.hoopInRoom) {
      this.hoopHome.parent.add(this.hoop);
      this.hoop.position.copy(this.hoopHome.pos);
      this.hoop.quaternion.copy(this.hoopHome.quat);
      this.hoopInRoom = false;
    }
    if (this.hoop && !this.hoopHome) this.hoop.visible = false;
  }

  /** When the person is placed: the ball comes to you, and a hoop of our own goes up at the free-throw line. */
  place(head: THREE.Vector3, forward: THREE.Vector3, person: THREE.Object3D, personRadius: number) {
    person.getWorldPosition(this.personAt);
    this.personR = personRadius;
    if (this.hoop && !this.hoopHome && !this.placedHoop) {
      this.moveHoopHere(head, forward);
      this.placedHoop = true;
    }
    this.respawn(head, forward);
  }
  private placedHoop = false;

  /** The hoop at the free-throw line in front of you, facing you, standing in your room from now on. */
  moveHoopHere(head: THREE.Vector3, forward: THREE.Vector3) {
    if (!this.hoop) return;
    if (this.hoop.parent !== this.scene) this.scene.attach(this.hoop);
    const d = FREE_THROW - (RIM_R + BOARD_GAP); // the ring's centre, so the board's face is 4.6 m away
    this.hoop.position.set(head.x + forward.x * d, 0, head.z + forward.z * d);
    this.hoop.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    this.hoop.updateMatrixWorld(true);
    this.hoopInRoom = true;
    this.log.push("hoop moved");
  }

  /** Back to you: floating at your waist, a little in front, never inside the person. */
  respawn(head: THREE.Vector3, forward: THREE.Vector3) {
    const right = this.v1.set(-forward.z, 0, forward.x);
    const y = THREE.MathUtils.clamp(head.y - 0.58, 0.75, 1.25);
    const tries: [number, number][] = [[0.42, 0], [0.36, 0.3], [0.36, -0.3], [0.24, 0.32], [0.2, -0.32]];
    const clear = this.personR + R + 0.05;
    const away = (f: number, s: number) => Math.hypot(head.x + forward.x * f + right.x * s - this.personAt.x, head.z + forward.z * f + right.z * s - this.personAt.z);
    // the first spot in front of you that's clear of them; if they stand right there, at your side away from them
    const [f, s] = tries.find(([f, s]) => away(f, s) > clear) ?? ([[0, 0.45], [0, -0.45]] as [number, number][]).sort((a, b) => away(...b) - away(...a))[0];
    this.home.set(head.x + forward.x * f + right.x * s, y, head.z + forward.z * f + right.z * s);
    this.pos.copy(this.home);
    this.vel.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.state = "floating";
    this.stateT = 0;
    this.alpha = 0;
    this.holders = [];
  }

  /** Once a frame while presenting. menuOpen: the left palm is up, so the ball in your hands goes away for now. */
  update(dt: number, menuOpen: boolean, head: THREE.Vector3, forward: THREE.Vector3) {
    this.t += dt;
    this.stateT += dt;
    this.hoop?.updateWorldMatrix(true, false);
    if (this.hoop) this.hoopInv.copy(this.hoop.matrixWorld).invert();
    // the person mirrored (palm menu): the hoop that rides with them is too, but its score stays readable
    if (this.hoop && this.counter) this.counter.mesh.scale.x = this.hoop.matrixWorld.determinant() < 0 ? -1 : 1;
    this.palms.forEach((p, k) => p.read(this.hands[k]));
    if (this.state === "away") return;

    // the menu: a ball in your hands or waiting for you steps aside, and comes back once the palm turns down
    const hidden = menuOpen && (this.state === "held" || this.state === "floating");
    if (hidden && this.state === "held") {
      this.state = "floating";
      this.holders = [];
      this.respawn(head, forward);
    }
    if (this.wasHidden && !hidden && this.state === "floating") this.respawn(head, forward);
    this.wasHidden = hidden;

    if (this.state === "floating" && !hidden) {
      this.pos.copy(this.home);
      this.pos.y += Math.sin(this.t * 2.4) * 0.008; // a gentle bob, the way a pass hangs for a moment
      this.ball.rotateY(dt * 0.4);
      this.tryGrab();
    } else if (this.state === "held") this.hold(dt);
    else if (this.state === "flying") {
      if (this.stateT > REGRAB_S) this.tryGrab(); // catch a rebound
      if (this.state === "flying") this.fly(dt);
      const far = Math.hypot(this.pos.x - head.x, this.pos.z - head.z) > 30;
      if (this.restT > 1 || this.stateT > RESPAWN_S || far) this.respawn(head, forward);
    }

    const target = hidden ? 0 : 1;
    this.alpha = THREE.MathUtils.clamp(this.alpha + (target ? dt / 0.3 : -dt / 0.15), 0, 1);
    this.mat.opacity = this.alpha;
    this.ball.visible = this.alpha > 0.01;
    this.ball.position.copy(this.pos);
    const above = Math.max(0, this.pos.y - R);
    const m = this.shadow.material as THREE.MeshBasicMaterial;
    m.opacity = this.alpha * 0.7 * Math.max(0, 1 - above / 2.5);
    this.shadow.visible = m.opacity > 0.01;
    this.shadow.position.set(this.pos.x, 0.003, this.pos.z);
    this.shadow.scale.setScalar(R * 3.2 * (1 + above * 0.5));
  }

  // ---------------- in your hands

  private tryGrab() {
    const on = [0, 1].filter((k) => this.palms[k].on(this.pos));
    if (!on.length) return;
    this.state = "held";
    this.stateT = 0;
    this.holders = on;
    this.hist = [];
    this.vHist = [];
    this.spin.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.rel.copy(this.palms[on[0]].quat).invert().multiply(this.ball.quaternion);
    this.log.push(`grab ${on.length === 2 ? "two hands" : "one hand"}`);
  }

  /** Where the ball sits for these hands: on one palm, or between two. */
  private seat(ks: number[], out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    for (const k of ks) out.addScaledVector(this.v3.copy(this.palms[k].pos).addScaledVector(this.palms[k].normal, R + 0.004), 1 / ks.length);
    return out;
  }

  private hold(dt: number) {
    const tracked = this.holders.filter((k) => this.palms[k].tracked);
    this.lostT = tracked.length === this.holders.length ? 0 : this.lostT + dt;
    if (this.lostT > 0.12 && !tracked.length) return this.release(this.peak() ?? this.velNow(), "hands lost");

    // who still has it: both palms on its sides (where each would put it agrees), or one under it (or wrapped round it)
    let ks: number[] = [];
    if (tracked.length === 2) {
      const [a, b] = tracked.map((k) => this.palms[k]);
      const sa = this.seat([tracked[0]], new THREE.Vector3()), sb = this.seat([tracked[1]], new THREE.Vector3());
      const c = sa.clone().add(sb).multiplyScalar(0.5);
      const together = sa.distanceTo(sb) < 0.07 && a.on(c, R + 0.06, 0.12) && b.on(c, R + 0.06, 0.12);
      if (together) ks = tracked;
      else {
        // apart: the hand that still has it from underneath keeps it (the nearer one if both could)
        const keep = tracked.filter((k, i) => this.oneHandHolds(this.palms[k], i ? sb : sa));
        keep.sort((x, y) => (x === tracked[0] ? sa : sb).distanceTo(this.pos) - (y === tracked[0] ? sa : sb).distanceTo(this.pos));
        ks = keep.slice(0, 1);
      }
    } else if (tracked.length === 1) {
      const k = tracked[0];
      ks = this.oneHandHolds(this.palms[k], this.seat([k], new THREE.Vector3())) ? [k] : [];
      if (ks.length && this.holders.length === 1 && this.palms[1 - k].on(this.pos)) ks = [k, 1 - k]; // the other hand joins
    }
    if (!ks.length) {
      if (tracked.length) return this.release(this.velNow(), "hands came off");
      return; // both lost a moment: it stays where it was
    }
    if (ks.length !== this.holders.length || ks[0] !== this.holders[0]) this.rel.copy(this.palms[ks[0]].quat).invert().multiply(this.ball.quaternion);
    this.holders = ks;

    this.seat(ks, this.pos);
    if (this.pos.y < R) this.pos.y = R;
    this.ball.quaternion.copy(this.palms[ks[0]].quat).multiply(this.rel);
    this.hist.push({ t: this.t, p: this.pos.clone() });
    while (this.hist.length && this.hist[0].t < this.t - 0.3) this.hist.shift();
    const v = this.velNow();
    this.vHist.push({ t: this.t, v });
    while (this.vHist.length && this.vHist[0].t < this.t - 0.15) this.vHist.shift();

    // a ball leaves open hands when they stop pushing it: after a quick push, the moment they slow right down
    const peak = this.peak();
    if (peak && this.stateT > 0.1) {
      const wrapped = ks.length === 1 && this.palms[ks[0]].wraps(this.pos);
      const strong = ks.length === 2 ? 3 : 2.2;
      const frac = ks.length === 2 ? 0.45 : 0.55;
      const pushing = ks.length === 2 || peak.dot(this.palms[ks[0]].normal) > 0.4 * peak.length();
      if (!wrapped && pushing && peak.length() > strong && v.length() < frac * peak.length()) this.release(peak, "hands slowed");
    }
  }

  /** One open hand keeps it only from underneath (the palm facing up); a hand wrapped round it keeps it any way up. */
  private oneHandHolds(p: Palm, seat: THREE.Vector3): boolean {
    return p.normal.y > 0.25 || p.wraps(seat);
  }

  /** The held ball's velocity now: a straight-line fit over the last 90 ms of where your hands had it. */
  private velNow(): THREE.Vector3 {
    const out = new THREE.Vector3();
    const s = this.hist.filter((h) => h.t >= this.t - 0.09);
    if (s.length < 2) return out;
    const tm = s.reduce((a, h) => a + h.t, 0) / s.length;
    const pm = s.reduce((a, h) => a.add(h.p), new THREE.Vector3()).divideScalar(s.length);
    let den = 0;
    for (const h of s) {
      const dtm = h.t - tm;
      den += dtm * dtm;
      out.addScaledVector(this.v1.copy(h.p).sub(pm), dtm);
    }
    return den > 1e-9 ? out.divideScalar(den) : out.set(0, 0, 0);
  }

  /** What the push gave it: the fastest few of the last 150 ms of (smoothed) hand velocities, averaged, so one
   * jittery frame doesn't decide the shot. */
  private peak(): THREE.Vector3 | null {
    if (!this.vHist.length) return null;
    const top = [...this.vHist].sort((a, b) => b.v.lengthSq() - a.v.lengthSq()).slice(0, Math.max(1, Math.min(3, Math.floor(this.vHist.length / 2))));
    return top.reduce((a, h) => a.add(h.v), new THREE.Vector3()).divideScalar(top.length);
  }

  private release(v: THREE.Vector3, why: string) {
    if (v.length() > MAX_SPEED) v.setLength(MAX_SPEED);
    this.vel.copy(v);
    // backspin: the top of the ball turning back toward you
    const axis = this.v1.crossVectors(v, this.v2.set(0, 1, 0));
    this.spin.set(0, 0, 0);
    if (axis.lengthSq() > 1e-6) this.spin.copy(axis.normalize()).multiplyScalar(BACKSPIN * Math.min(1, v.length() / 4));
    this.state = "flying";
    this.stateT = 0;
    this.restT = 0;
    this.holders = [];
    this.madeThisShot = false;
    this.touchedThisShot = false;
    if (v.length() > 2) {
      this.shots++;
      this.counter?.draw();
      if (this.counter) this.counter.mesh.visible = true;
    }
    this.log.push(`release (${why}) ${v.length().toFixed(2)} m/s`);
  }

  // ---------------- in the air

  private fly(dt: number) {
    const n = THREE.MathUtils.clamp(Math.ceil((this.vel.length() * dt) / 0.02), 4, 40);
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(h);
    // at rest on the floor?
    const still = this.pos.y <= R + 0.002 && this.vel.length() < 0.05;
    this.restT = still ? this.restT + dt : 0;
    if (still) this.vel.set(0, 0, 0);
  }

  private step(h: number) {
    const p = this.pos, v = this.vel;
    const sp = v.length();
    v.y -= G * h;
    v.addScaledVector(v, -DRAG * sp * h);
    const before = this.hoop ? this.v3.copy(p).applyMatrix4(this.hoopInv).y : 0;
    p.addScaledVector(v, h);
    if (this.hoop) this.hoopContacts(h, before);
    // the floor
    if (p.y < R) {
      p.y = R;
      if (v.y < -0.35) this.bounce(this.v2.set(0, 1, 0), 0.75, 0.5, "floor");
      else {
        // rolling: friction turns sliding into rolling, then it slowly stops
        v.y = 0;
        this.friction(this.v2.set(0, 1, 0), 0.5 * G * h);
        const s = Math.hypot(v.x, v.z);
        const slow = 0.3 * h;
        if (s > slow) v.multiplyScalar((s - slow) / s);
        else v.set(0, 0, 0);
      }
    }
    // the ball turns with its spin
    const w = this.spin.length();
    if (w > 1e-4) {
      this.q1.setFromAxisAngle(this.v1.copy(this.spin).divideScalar(w), w * h);
      this.ball.quaternion.premultiply(this.q1);
    }
  }

  /** The ring (a torus), the glass (a box), the net (soft), and a make, in the hoop's own frame. */
  private hoopContacts(h: number, yBefore: number) {
    const hoop = this.hoop!;
    const pl = this.v3.copy(this.pos).applyMatrix4(this.hoopInv);
    const ringY = this.rimTop - RIM_TUBE;
    const radial = Math.hypot(pl.x, pl.z);
    // a make: the centre going down through the ring, inside it
    if (!this.madeThisShot && yBefore > ringY && pl.y <= ringY && radial < RIM_R) {
      this.madeThisShot = true;
      this.makes++;
      this.counter?.draw();
      this.sound("swish", this.touchedThisShot ? 0.35 : 0.9);
      this.log.push(this.touchedThisShot ? "make" : "make (swish)");
    }
    // the net: soft, it slows the ball and gathers it to the middle as it drops through
    if (pl.y < ringY && pl.y > ringY - NET_LEN - 0.06 && radial < RIM_R + 0.03) {
      const vl = this.v1.copy(this.vel).transformDirection(this.hoopInv).multiplyScalar(this.vel.length());
      vl.multiplyScalar(Math.exp(-2.2 * h));
      vl.x -= pl.x * 16 * h;
      vl.z -= pl.z * 16 * h;
      const len = vl.length();
      this.vel.copy(vl).transformDirection(hoop.matrixWorld).multiplyScalar(len);
    }
    // the ring: the ball against the nearest point of the tube's centre circle
    const ringR = RIM_R + RIM_TUBE;
    if (Math.abs(pl.y - ringY) < R + RIM_TUBE && Math.abs(radial - ringR) < R + RIM_TUBE) {
      const c = this.v1.set(pl.x, 0, pl.z);
      if (radial > 1e-6) c.multiplyScalar(ringR / radial);
      else c.set(ringR, 0, 0);
      c.y = ringY;
      const d = this.v2.subVectors(pl, c);
      const dist = d.length();
      if (dist < R + RIM_TUBE && dist > 1e-6) {
        d.divideScalar(dist);
        pl.copy(c).addScaledVector(d, R + RIM_TUBE);
        this.pos.copy(pl).applyMatrix4(hoop.matrixWorld);
        this.bounce(d.transformDirection(hoop.matrixWorld), 0.55, 0.35, "rim");
        return;
      }
    }
    // the glass: a sphere against a box
    const face = -(RIM_R + BOARD_GAP);
    const bottom = this.rimTop - BOARD_BELOW_RIM;
    const q = this.v1.set(
      THREE.MathUtils.clamp(pl.x, -BOARD_W / 2, BOARD_W / 2),
      THREE.MathUtils.clamp(pl.y, bottom, bottom + BOARD_H),
      THREE.MathUtils.clamp(pl.z, face - BOARD_T, face),
    );
    const d = this.v2.subVectors(pl, q);
    const dist = d.length();
    if (dist < R) {
      if (dist > 1e-6) d.divideScalar(dist);
      else d.set(0, 0, 1); // its centre got inside the glass: out the front
      pl.copy(q).addScaledVector(d, R);
      this.pos.copy(pl).applyMatrix4(hoop.matrixWorld);
      this.bounce(d.transformDirection(hoop.matrixWorld), 0.62, 0.3, "board");
    }
  }

  /** A bounce off a surface with normal n: restitution e, and friction that trades sliding for spin. */
  private bounce(n: THREE.Vector3, e: number, mu: number, what: Hit) {
    const vn = this.vel.dot(n);
    if (vn >= 0) return;
    this.vel.addScaledVector(n, -(1 + e) * vn);
    this.friction(n, mu * (1 + e) * -vn);
    if (what !== "floor") this.touchedThisShot = true;
    this.sound(what, THREE.MathUtils.clamp(-vn / (what === "floor" ? 5 : 4), 0.08, 1));
  }

  /** Friction at the contact point (a hollow ball): at most `limit` of velocity change, never past rolling. */
  private friction(n: THREE.Vector3, limit: number) {
    // the contact point's velocity: v + w x (-R n), without its normal part
    const slip = this.v1.crossVectors(this.spin, n).multiplyScalar(-R).add(this.vel);
    slip.addScaledVector(n, -slip.dot(n));
    const dv = slip.multiplyScalar(-ALPHA / (1 + ALPHA));
    if (dv.length() > limit) dv.setLength(limit);
    this.vel.add(dv);
    this.spin.addScaledVector(this.v2.crossVectors(n, dv), -1 / (ALPHA * R));
  }

  private sound(what: Hit, volume: number) {
    if (!this.sounds.length || volume < 0.05) return;
    const last = this.lastSound[what] ?? -1;
    if (this.t - last < 0.08) return;
    this.lastSound[what] = this.t;
    const buf = this.buffers[what];
    const s = this.sounds.find((x) => !x.isPlaying) ?? this.sounds[0];
    if (!buf || s.context.state !== "running") return;
    if (s.isPlaying) s.stop();
    s.position.copy(this.pos);
    s.setBuffer(buf);
    s.setVolume(volume);
    s.play();
  }

  /** Dev checks: put the ball somewhere with a velocity, as if it had just left your hands. */
  throwFrom(p: THREE.Vector3, v: THREE.Vector3) {
    this.pos.copy(p);
    this.release(v.clone(), "dev");
  }

  debug() {
    const r = (x: THREE.Vector3) => x.toArray().map((k) => +k.toFixed(3));
    const rim = this.hoop ? r(this.hoop.localToWorld(new THREE.Vector3(0, this.rimTop - RIM_TUBE, 0))) : null;
    return { state: this.state, holders: this.holders.length, pos: r(this.pos), vel: r(this.vel), speed: +this.vel.length().toFixed(2), makes: this.makes, shots: this.shots, rim, hoopInRoom: this.hoopInRoom, alpha: +this.alpha.toFixed(2), log: this.log.slice(-8) };
  }
}

/** The quiet "2 / 5" on the glass, bottom right, facing you. */
function scoreLabel(text: () => string) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.1125), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  const draw = () => {
    const x = c.getContext("2d")!;
    x.clearRect(0, 0, 256, 96);
    x.fillStyle = "rgba(29,29,31,0.55)";
    x.beginPath();
    x.roundRect(4, 4, 248, 88, 44);
    x.fill();
    x.fillStyle = "rgba(245,245,247,0.92)";
    x.font = '600 54px -apple-system, "SF Pro Display", "Inter", sans-serif';
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(text(), 128, 52, 220);
    tex.needsUpdate = true;
  };
  draw();
  return { mesh, draw };
}

/** Short sounds made from scratch: the ball on the floor, on the glass, on the ring, and through the net. */
function tone(ctx: BaseAudioContext, what: Hit): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = { floor: 0.18, board: 0.2, rim: 0.6, swish: 0.35 }[what];
  const n = Math.floor(sr * len);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  let lp = 0, hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const noise = Math.random() * 2 - 1;
    let s = 0;
    if (what === "floor") {
      // the hollow "pung" of a ball on hardwood
      lp += (noise - lp) * 0.05;
      s = Math.sin(2 * Math.PI * (118 - 30 * t) * t) * Math.exp(-t / 0.05) + Math.sin(2 * Math.PI * 342 * t) * Math.exp(-t / 0.03) * 0.35 + lp * 2 * Math.exp(-t / 0.006);
    } else if (what === "board") {
      // a dull thud on the glass and its frame
      lp += (noise - lp) * 0.15;
      s = Math.sin(2 * Math.PI * 205 * t) * Math.exp(-t / 0.04) * 0.8 + Math.sin(2 * Math.PI * 610 * t) * Math.exp(-t / 0.025) * 0.3 + lp * 1.6 * Math.exp(-t / 0.012);
    } else if (what === "rim") {
      // the ring's clang: a few inharmonic partials of a steel hoop
      const parts: [number, number, number][] = [[392, 0.45, 0.5], [1013, 0.3, 0.35], [1688, 0.18, 0.25], [2531, 0.1, 0.15]];
      for (const [f, a, tau] of parts) s += Math.sin(2 * Math.PI * f * t) * a * Math.exp(-t / tau);
      s += noise * 0.5 * Math.exp(-t / 0.004);
    } else {
      // the net: a soft high rush of air and cord
      hp = 0.9 * (hp + noise - prev);
      prev = noise;
      const env = Math.min(1, t / 0.03) * Math.exp(-Math.max(0, t - 0.03) / 0.11);
      s = hp * env * 0.55;
    }
    d[i] = s * 0.7;
  }
  return b;
}
