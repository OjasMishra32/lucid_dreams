import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BALL_R } from "./physics";

// A tennis racket built from code at real size: 68.5 cm long, a 100 sq in head (strung area 25.6 x 32 cm, an ellipse
// of 645 cm²), an open throat, an octagonal 4 3/8 grip with its wrap, and a 16 x 19 string bed. Its own frame: the
// butt cap at the origin, +Y up the shaft to the tip, the strings in the XY plane (their face looks along ±Z).
// No maker's marks or logos. Three draws: frame, grip, strings.

export const RACKET = {
  length: 0.685,
  a: 0.128, // strung area's half width
  b: 0.16, // and half length
  headC: 0.505, // the centre of the strings from the butt
  gripY: 0.085, // the hand's centre from the butt
};

function gripTexture(color: string, wrap: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, 64, 256);
  g.strokeStyle = wrap; // the overgrip's spiral overlap
  g.lineWidth = 3;
  for (let y = -64; y < 320; y += 22) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(64, y + 26);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function stringTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 320;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "rgba(236,236,228,0.92)";
  for (let i = 0; i < 16; i++) g.fillRect(((i + 0.5) / 16) * W - 1.6, 0, 3.2, H); // mains
  for (let i = 0; i < 19; i++) g.fillRect(0, ((i + 0.5) / 19) * H - 1.6, W, 3.2); // crosses
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export interface RacketColors {
  frame: number;
  grip: string;
  wrap: string;
}

/** The racket in its own frame (see above). */
export function buildRacket(colors: RacketColors, env?: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  const { a, b, headC } = RACKET;
  // the head: a deep, rounded beam around the strung ellipse
  const ring: THREE.Vector3[] = [];
  for (let i = 0; i < 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    ring.push(new THREE.Vector3(Math.cos(t) * (a + 0.008), headC + Math.sin(t) * (b + 0.008), 0));
  }
  const head = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ring, true), 96, 0.0085, 8, true);
  head.scale(1, 1, 1.35);
  const parts: THREE.BufferGeometry[] = [head];
  // the throat: two arms from the shaft out to the head
  const join = headC - b * 0.78;
  const joinX = (a + 0.008) * Math.sqrt(1 - 0.78 * 0.78);
  for (const s of [1, -1]) {
    const arm = new THREE.TubeGeometry(
      new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0.235, 0), new THREE.Vector3(s * 0.016, 0.31, 0), new THREE.Vector3(s * joinX, join, 0)),
      16, 0.0078, 8, false,
    );
    arm.scale(1, 1, 1.3);
    parts.push(arm);
  }
  const shaft = new THREE.CylinderGeometry(0.0108, 0.0128, 0.07, 10);
  shaft.translate(0, 0.205, 0);
  parts.push(shaft);
  const cap = new THREE.CylinderGeometry(0.0176, 0.0168, 0.012, 8);
  cap.translate(0, 0.006, 0);
  parts.push(cap);
  const frameGeo = mergeGeometries(parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p;
    q.deleteAttribute("uv");
    return q;
  }));
  const frameMat = new THREE.MeshStandardMaterial({ color: colors.frame, roughness: 0.38, metalness: 0.15, envMap: env ?? null, envMapIntensity: 0.6 });
  g.add(new THREE.Mesh(frameGeo, frameMat));

  // the grip: octagonal, 4 3/8 (about 11 cm round), wrapped
  const gripTex = gripTexture(colors.grip, colors.wrap);
  gripTex.repeat.set(2, 3);
  const grip = new THREE.CylinderGeometry(0.0158, 0.0154, 0.175, 8, 1);
  grip.translate(0, 0.012 + 0.0875, 0);
  g.add(new THREE.Mesh(grip, new THREE.MeshStandardMaterial({ map: gripTex, roughness: 0.9, metalness: 0 })));

  // the strings: a flat ellipse, the 16 x 19 pattern in its texture
  const shape = new THREE.Shape();
  shape.absellipse(0, headC, a, b, 0, Math.PI * 2, false, 0);
  const sg = new THREE.ShapeGeometry(shape, 48);
  const p = sg.attributes.position;
  const uv = sg.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + a) / (2 * a), (p.getY(i) - (headC - b)) / (2 * b));
  const strings = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: stringTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  strings.renderOrder = 6;
  g.add(strings);
  return g;
}

// ---------------------------------------------------------------- your racket, in your right hand

type Joints = Record<string, THREE.Object3D>;
const NEEDED = ["wrist", "middle-finger-metacarpal", "index-finger-phalanx-proximal", "middle-finger-phalanx-proximal", "pinky-finger-phalanx-proximal"];
const GRIP_ANGLE = THREE.MathUtils.degToRad(38); // the shaft leaves the hand between thumb and index, this far off the hand's line

/**
 * Your racket follows the stable joints of your right hand (the wrist and the knuckles, never the fingertips), the way an
 * eastern forehand grip holds it: the strings parallel to your palm, the handle across it from the heel of the hand
 * out past the index knuckle. No fist is needed: whenever the hand is tracked, the racket is in it. Its turn is
 * smoothed a little (less the faster it turns, so a swing never lags); its position never is.
 */
export class HandRacket {
  readonly obj: THREE.Group;
  tracked = false;
  private shown = 0;
  private lost = 0;
  private hasPose = false;
  private p: Record<string, THREE.Vector3> = Object.fromEntries(NEEDED.map((n) => [n, new THREE.Vector3()]));
  private f = new THREE.Vector3();
  private a = new THREE.Vector3();
  private n = new THREE.Vector3();
  private u = new THREE.Vector3();
  private x = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private jq = new THREE.Quaternion();
  private m = new THREE.Matrix4();
  private mats: THREE.Material[] = [];

  constructor(scene: THREE.Object3D, env?: THREE.Texture) {
    this.obj = buildRacket({ frame: 0x283447, grip: "#f1f1ec", wrap: "#cfd2d0" }, env);
    this.obj.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) {
        m.transparent = true;
        this.mats.push(m);
      }
    });
    this.obj.visible = false;
    scene.add(this.obj);
  }

  /** Once a frame while presenting: follow the right hand (world space). False when it isn't tracked. */
  update(hand: THREE.Object3D | undefined, dt: number): boolean {
    // three hides a hand that tracking lost but leaves its joints as they were: a frozen hand is no hand
    const joints = hand?.visible ? ((hand as unknown as { joints?: Joints }).joints ?? {}) : {};
    this.tracked = NEEDED.every((k) => joints[k]?.visible);
    if (this.tracked) {
      for (const k of NEEDED) joints[k].getWorldPosition(this.p[k]);
      const W = this.p.wrist;
      const M = this.p["middle-finger-phalanx-proximal"];
      this.f.subVectors(M, W).normalize(); // wrist to knuckles
      this.a.subVectors(this.p["index-finger-phalanx-proximal"], this.p["pinky-finger-phalanx-proximal"]); // toward the thumb side
      this.a.addScaledVector(this.f, -this.a.dot(this.f)).normalize();
      this.n.crossVectors(this.a, this.f); // out of a right palm
      joints["middle-finger-metacarpal"].getWorldQuaternion(this.jq);
      if (this.n.dot(this.x.set(0, -1, 0).applyQuaternion(this.jq)) < 0) this.n.negate(); // WebXR: -Y points out of the palm
      this.u.copy(this.f).multiplyScalar(Math.cos(GRIP_ANGLE)).addScaledVector(this.a, Math.sin(GRIP_ANGLE)).normalize();
      this.x.crossVectors(this.u, this.n);
      this.q.setFromRotationMatrix(this.m.makeBasis(this.x, this.u, this.n));
      if (!this.hasPose || this.shown < 0.05 || !Number.isFinite(this.obj.quaternion.w)) this.obj.quaternion.copy(this.q);
      else {
        const angle = this.obj.quaternion.angleTo(this.q);
        this.obj.quaternion.slerp(this.q, 1 - Math.exp(-dt * (30 + 800 * angle)));
      }
      // the handle sits in the palm, the hand's centre about 8.5 cm from the butt
      const centre = this.x.copy(W).lerp(M, 0.5).addScaledVector(this.n, 0.024);
      const u = this.u.set(0, 1, 0).applyQuaternion(this.obj.quaternion);
      this.obj.position.copy(centre).addScaledVector(u, -RACKET.gripY);
      this.hasPose = true;
      this.lost = 0;
    } else this.lost += dt;
    // a fast swing can lose tracking for a few frames: the racket holds its last pose, then fades
    const want = this.tracked || this.lost < 0.35 ? 1 : 0;
    this.shown = THREE.MathUtils.clamp(this.shown + (want ? dt / 0.1 : -dt / 0.25), 0, 1);
    for (const m of this.mats) (m as THREE.MeshBasicMaterial).opacity = this.shown;
    this.obj.visible = this.shown > 0.01 && this.hasPose;
    return this.tracked;
  }

  /** It can hit only while it's really in your hand (tracked now, or just a moment ago). */
  get live() {
    return this.hasPose && this.shown > 0.6 && this.lost < 0.12;
  }

  hide() {
    this.shown = 0;
    this.hasPose = false;
    this.obj.visible = false;
  }
}

// ---------------------------------------------------------------- contact

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

export interface Pose {
  p: THREE.Vector3;
  q: THREE.Quaternion;
}

export interface Contact {
  local: THREE.Vector3; // where on the head (racket frame)
  side: number; // which face it met (+1: the +Z face)
  frac: number; // when in the step, 0..1
  offCentre: number; // 0 at the centre of the strings, 1 at their edge
}

/** The racket's pose part way between two poses. */
export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  out.p.lerpVectors(a.p, b.p, t);
  out.q.slerpQuaternions(a.q, b.q, t);
  return out;
}

/**
 * Did the string bed sweep through the ball in this step? The ball (court space) went from b0 to b1 while the racket
 * went from pose r0 to r1: in the racket's own frame that is one path, and a hit is that path crossing the string
 * plane inside a generous zone round the strings (about 21 x 24 cm half-axes, more than the strung area, as hand
 * tracking is never exact).
 */
export function sweep(b0: THREE.Vector3, b1: THREE.Vector3, r0: Pose, r1: Pose, zone = { x: 0.21, y: 0.24 }): Contact | null {
  _inv.compose(r0.p, r0.q, _s).invert();
  _p0.copy(b0).applyMatrix4(_inv);
  _inv.compose(r1.p, r1.q, _s).invert();
  _p1.copy(b1).applyMatrix4(_inv);
  const z0 = _p0.z;
  const z1 = _p1.z;
  let frac: number;
  if (z0 === 0 || Math.sign(z0) !== Math.sign(z1)) frac = z0 / (z0 - z1 || 1e-9);
  else if (Math.abs(z1) < BALL_R && Math.abs(z1) < Math.abs(z0)) frac = 1; // it reached the strings this step
  else return null;
  const local = new THREE.Vector3().lerpVectors(_p0, _p1, frac);
  const dx = local.x / zone.x;
  const dy = (local.y - RACKET.headC) / zone.y;
  if (dx * dx + dy * dy > 1) return null;
  const offCentre = Math.sqrt((local.x / RACKET.a) ** 2 + ((local.y - RACKET.headC) / RACKET.b) ** 2);
  return { local, side: Math.sign(z0) || 1, frac, offCentre };
}

/** The point on the racket at `local`, in court space, at a pose. */
export function racketPoint(pose: Pose, local: THREE.Vector3, out = new THREE.Vector3()) {
  _m.compose(pose.p, pose.q, _s);
  return out.copy(local).applyMatrix4(_m);
}

