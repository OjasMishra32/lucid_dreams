import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Skeleton, SkinnedAvatar } from "../avatar";
import { SQUARE } from "./pieces";

// The opponent as a person at the table: seated on a chair, breathing, eyes on the board, moving their own pieces
// with their right hand. All of it is procedural on the avatar's SMPL-X rig (the motion file only lends the fingers
// their relaxed pose) and sized from the rest skeleton, so any avatar sits and reaches the same way.
//
// Spaces. "Table": the chess table group's local space (board centre at the origin, playing surface at y = 0, the
// player on +z, the opponent on -z). "Bundle": the avatar mesh's own space (+Y up, front faces -Z, see avatar.ts),
// where the rig is posed: G_j = G_parent L_j, joint j at P_parent + G_parent (rest_j - rest_parent). The mesh sits at
// the origin of a group on the floor, so the floor is y = 0 in bundle space too.

export const SEAT_HEIGHT = 0.46;
const BOARD_EDGE = SQUARE * 4 + 0.018; // the board's far edge, frame included
const HIPS_BEHIND_EDGE = 0.45;
/** How far behind the board's centre the opponent's hip joints are: where the chair goes. */
export const SEAT_DISTANCE = BOARD_EDGE + HIPS_BEHIND_EDGE;

/** One piece the hand moves: board-local base positions, as squareToLocal gives them. */
export interface Carry {
  obj: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  height: number;
  captured?: THREE.Object3D | null; // taken off the board when the hand arrives
  shadow?: THREE.Object3D | null; // the piece's contact shadow, kept on the board while it's in the air
}

// SMPL-X joint order (the motion.json contract)
const PELVIS = 0, SPINE1 = 3, SPINE2 = 6, SPINE3 = 9, NECK = 12, L_COLLAR = 13, R_COLLAR = 14, HEAD = 15;
const L_HIP = 1, R_HIP = 2, L_KNEE = 4, R_KNEE = 5, L_ANKLE = 7, R_ANKLE = 8, L_FOOT = 10, R_FOOT = 11;
const L_SHOULDER = 16, R_SHOULDER = 17, L_ELBOW = 18, R_ELBOW = 19, L_WRIST = 20, R_WRIST = 21;
const L_MIDDLE1 = 28, R_MIDDLE1 = 43, L_EYE = 23, R_EYE = 24;
// right-hand fingers and how far each joint flexes in a pinch (radians at curl = 1); flexion is +z for the right hand
const R_FINGERS: [number, number][] = [
  [40, 0.3], [41, 0.5], [42, 0.35], // index
  [43, 0.7], [44, 0.95], [45, 0.6], // middle
  [46, 0.95], [47, 1.0], [48, 0.6], // pinky
  [49, 0.85], [50, 1.0], [51, 0.6], // ring
];
const BODY = 22; // joints 0..21 are posed here; the rest (jaw, eyes, fingers) come from the motion

const BASE_LEAN = 0.2; // radians forward, pelvis + spine, at rest
const MAX_LEAN = 0.75; // what a far reach may add
const MAX_BEND = 2.6; // elbow / knee

// bundle-space directions of the seated body (it faces -Z)
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const FWD = new THREE.Vector3(0, 0, -1);
const BACK = new THREE.Vector3(0, 0, 1);
const LEFT = new THREE.Vector3(-1, 0, 0); // the person's left
const RIGHT = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const YAW = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI); // rest faces +Z; the turn to face -Z

const smooth = (u: number) => u * u * (3 - 2 * u);
const smoother = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
const clamp = THREE.MathUtils.clamp;
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _eq = new THREE.Quaternion();
/** A small rotation from angles about the rest axes (x = the person's left, y up, z forward): twist, then bend. */
const rot = (x: number, y: number, z: number) => _eq.setFromEuler(_e.set(x, y, z, "YXZ"));

interface Limb {
  a: number;
  b: number;
  c: number;
  v1: THREE.Vector3; // rest a -> b
  v2: THREE.Vector3; // rest b -> c
  hinge: THREE.Vector3; // b's bend axis in rest space (positive angle = flexion)
  sgn: number; // which side of the a -> c line b ends up on when bent
  dMin: number;
  dMax: number;
}

const _r = new THREE.Vector3();
const _rq = new THREE.Quaternion();
function reachAt(L: Limb, theta: number) {
  return _r.copy(L.v2).applyQuaternion(_rq.setFromAxisAngle(L.hinge, theta)).add(L.v1).length();
}

function makeLimb(rest: THREE.Vector3[], a: number, b: number, c: number, hinge: THREE.Vector3): Limb {
  const L: Limb = { a, b, c, v1: rest[b].clone().sub(rest[a]), v2: rest[c].clone().sub(rest[b]), hinge: hinge.clone().normalize(), sgn: 1, dMin: 0, dMax: 0 };
  L.dMax = reachAt(L, 0);
  L.dMin = reachAt(L, MAX_BEND);
  const w = L.v2.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(L.hinge, 1)).add(L.v1).normalize();
  const e = L.v1.clone().addScaledVector(w, -L.v1.dot(w));
  L.sgn = Math.sign(e.dot(L.hinge.clone().cross(w))) || 1;
  return L;
}

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _a = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _b = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
/** The rotation taking direction sp to dp, and (as nearly as orthogonality allows) ss to ds. */
function alignTwo(sp: THREE.Vector3, ss: THREE.Vector3, dp: THREE.Vector3, ds: THREE.Vector3, out: THREE.Quaternion) {
  const [a1, a2, a3] = _a;
  const [b1, b2, b3] = _b;
  a1.copy(sp).normalize();
  a2.copy(ss).addScaledVector(a1, -ss.dot(a1)).normalize();
  a3.crossVectors(a1, a2);
  b1.copy(dp).normalize();
  b2.copy(ds).addScaledVector(b1, -ds.dot(b1));
  if (b2.lengthSq() < 1e-10) {
    b2.set(b1.y, -b1.x, 0); // any perpendicular will do
    if (b2.lengthSq() < 1e-10) b2.set(0, b1.z, -b1.y);
  }
  b2.normalize();
  b3.crossVectors(b1, b2);
  _m1.makeBasis(a1, a2, a3).transpose();
  _m2.makeBasis(b1, b2, b3).multiply(_m1);
  return out.setFromRotationMatrix(_m2);
}

const _toT = new THREE.Vector3();
const _w = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _h = new THREE.Vector3();
/**
 * Analytic two-bone IK (shoulder-elbow-wrist, hip-knee-ankle). B stays a pure hinge: first the bend that makes
 * |A -> C| the target distance (clamped to what the limb reaches), then A's global rotation that points A -> C at the
 * target with B bent toward `pole`. Writes A's global rotation and B's local one.
 */
function solveLimb(L: Limb, pA: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3, outGA: THREE.Quaternion, outLB: THREE.Quaternion) {
  _toT.copy(target).sub(pA);
  const d = _toT.length();
  const dc = clamp(d, L.dMin + 1e-4, L.dMax - 1e-4);
  let lo = 0;
  let hi = MAX_BEND;
  for (let i = 0; i < 18; i++) {
    const m = (lo + hi) / 2;
    if (reachAt(L, m) > dc) lo = m;
    else hi = m;
  }
  outLB.setFromAxisAngle(L.hinge, (lo + hi) / 2);
  _w.copy(L.v2).applyQuaternion(outLB).add(L.v1);
  if (d < 1e-6) _toT.copy(_w);
  _toT.normalize();
  _pole.copy(pole).addScaledVector(_toT, -pole.dot(_toT));
  if (_pole.lengthSq() < 1e-10) _pole.copy(DOWN);
  _pole.normalize();
  _h.crossVectors(_toT, _pole).multiplyScalar(L.sgn);
  alignTwo(_w, L.hinge, _toT, _h, outGA);
}

const _sw = new THREE.Quaternion();
const ID = new THREE.Quaternion();
/** The shortest rotation from a to b (unit vectors), at most maxAngle of it. */
function swing(a: THREE.Vector3, b: THREE.Vector3, maxAngle: number, out = _sw) {
  out.setFromUnitVectors(a, b);
  const ang = 2 * Math.acos(clamp(Math.abs(out.w), -1, 1));
  if (ang > maxAngle) out.slerp(ID, 1 - maxAngle / ang); // (slerpQuaternions(ID, out) would overwrite out first)
  return out;
}

interface HandRest {
  dir: THREE.Vector3; // wrist -> middle knuckle, rest space
  palm: THREE.Vector3; // palm normal, rest space (SMPL-X rest palms face down)
}

/** Everything the poses need from one skeleton: rest joints, limbs, how high the hips ride above the seat. */
class Rig {
  rest: THREE.Vector3[];
  off: THREE.Vector3[]; // rest_j - rest_parent
  parents: number[];
  hipMid: THREE.Vector3;
  hipAbove: number; // hip joints above the seat surface
  ankleHeight: number; // ankle joints above the floor
  eyeOff: THREE.Vector3; // head joint -> between the eyes, rest space
  arms: [Limb, Limb]; // left, right
  legs: [Limb, Limb];
  hands: [HandRest, HandRest];
  grasp: THREE.Vector3; // right wrist -> the pinch point between thumb and index, rest space

  constructor(s: Skeleton) {
    this.rest = s.rest.map((r) => new THREE.Vector3(r[0], r[1], r[2]));
    this.parents = s.parents;
    const R = this.rest;
    this.off = R.map((r, j) => (s.parents[j] < 0 ? r.clone() : r.clone().sub(R[s.parents[j]])));
    this.hipMid = R[L_HIP].clone().add(R[R_HIP]).multiplyScalar(0.5);
    const sole = Math.min(R[L_FOOT].y, R[R_FOOT].y) - 0.017; // the foot joints ride just above the sole
    const legLen = this.hipMid.y - sole;
    this.hipAbove = 0.095 * (legLen / 0.86);
    this.ankleHeight = (R[L_ANKLE].y + R[R_ANKLE].y) / 2 - sole;
    this.eyeOff = R[L_EYE].clone().add(R[R_EYE]).multiplyScalar(0.5).sub(R[HEAD]);
    const elbowHinge = (sh: number, el: number) => R[el].clone().sub(R[sh]).cross(Z).normalize(); // forearm swings forward
    const knee = new THREE.Vector3(1, 0, 0); // shin swings back
    this.arms = [makeLimb(R, L_SHOULDER, L_ELBOW, L_WRIST, elbowHinge(L_SHOULDER, L_ELBOW)), makeLimb(R, R_SHOULDER, R_ELBOW, R_WRIST, elbowHinge(R_SHOULDER, R_ELBOW))];
    this.legs = [makeLimb(R, L_HIP, L_KNEE, L_ANKLE, knee), makeLimb(R, R_HIP, R_KNEE, R_ANKLE, knee)];
    const hand = (wrist: number, middle: number): HandRest => {
      const dir = R[middle].clone().sub(R[wrist]).normalize();
      return { dir, palm: DOWN.clone().addScaledVector(dir, -DOWN.dot(dir)).normalize() };
    };
    this.hands = [hand(L_WRIST, L_MIDDLE1), hand(R_WRIST, R_MIDDLE1)];
    const handLen = R[R_MIDDLE1].distanceTo(R[R_WRIST]);
    this.grasp = this.hands[1].dir.clone().multiplyScalar(handLen * 1.25).addScaledVector(this.hands[1].palm, 0.028);
  }
}

type Kind = "reach" | "descend" | "grip" | "carry" | "release" | "return";
interface Held {
  c: Carry;
  fromTL: THREE.Vector3; // table-local base positions
  toTL: THREE.Vector3;
  grip: number; // the pinch point's height above the piece's base
  offset: THREE.Vector3; // board-local: where the piece was vs. where the hand put it, shrinking to zero in the carry
  decay: number;
}
interface Seg {
  kind: Kind;
  dur: number; // seconds
  end: () => THREE.Vector3; // table-local pinch point at the end
  k: Held | null;
  w1: number; // reach weight at the end (0 = resting pose, 1 = reaching hand, lean, gaze)
  c1: number; // finger curl at the end (-0.3 open, 0 relaxed, 1 pinch)
  lift: number;
  final?: boolean;
  t0?: number;
  from?: THREE.Vector3;
  w0?: number;
  c0?: number;
}

export class SeatedOpponent {
  readonly chair: THREE.Group;
  private rig!: Rig;
  private chairMats: THREE.MeshStandardMaterial[] = [];

  // per-frame state
  private now = 0;
  private last = 0;
  private thinking = false;
  private segs: Seg[] = [];
  private held: Held | null = null;
  private onPlaced: (() => void) | null = null;
  private w = 0;
  private curl = 0;
  private twist = 0;
  private protract = 0;
  private glanceFrom = 0;
  private glanceUntil = 0;
  private graspTL = new THREE.Vector3(); // where the pinch point is asked to be, table-local
  private restGraspTL = new THREE.Vector3();
  private gazeTL = new THREE.Vector3(0, 0.02, 0);
  private graspWorld = new THREE.Vector3(); // where the pinch point really is after posing
  /** Meters between where the hand was asked to be and where the arm got it (0 when the reach is exact). */
  reachError = 0;

  // spaces
  private toBundle = new THREE.Matrix4(); // table-local -> bundle
  private fromBundle = new THREE.Matrix4();
  private qToBundle = new THREE.Quaternion();

  // bundle-space targets for the pose
  private seat = new THREE.Vector3();
  private wrist: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  private hand: [THREE.Quaternion, THREE.Quaternion] = [new THREE.Quaternion(), new THREE.Quaternion()];
  private handRestR = new THREE.Quaternion();
  private graspB = new THREE.Vector3();
  private gazeB = new THREE.Vector3();

  // forward kinematics of the body joints, bundle space
  private G = Array.from({ length: BODY }, () => new THREE.Quaternion());
  private P = Array.from({ length: BODY }, () => new THREE.Vector3());

  constructor(
    private avatar: SkinnedAvatar,
    private table: THREE.Object3D,
    private boardGroup: THREE.Object3D,
  ) {
    avatar.pose(0, (_l, _t, s) => {
      this.rig = new Rig(s);
    });
    this.chair = this.buildChair();
  }

  /** True from the moment a move starts until the hand has let go of the last piece. */
  get busy() {
    return this.segs.some((s) => s.kind !== "return");
  }

  /**
   * Move pieces by hand, one after another (a castling king, then its rook). onPlaced runs when the hand lets go of
   * the last one: the move is on the board from then on, and the hand goes back to rest.
   */
  play(carries: Carry[], onPlaced: () => void) {
    this.drop();
    this.onPlaced = onPlaced;
    this.segs = [];
    let at = this.graspTL.clone();
    const up = (v: THREE.Vector3, h: number) => v.clone().setY(v.y + h);
    carries.forEach((c, i) => {
      const k: Held = { c, fromTL: this.boardToTable(c.from), toTL: this.boardToTable(c.to), grip: clamp(c.height * 0.8, 0.03, 0.075), offset: new THREE.Vector3(), decay: 1 };
      const above = up(k.fromTL, k.grip + 0.05);
      const pinch = up(k.fromTL, k.grip);
      const dest = up(k.toTL, k.grip);
      const d = Math.hypot(k.toTL.x - k.fromTL.x, k.toTL.z - k.fromTL.z);
      this.segs.push(
        { kind: "reach", dur: 0.24 + 0.42 * at.distanceTo(above), end: () => above, k, w1: 1, c1: -0.3, lift: 0.03 },
        { kind: "descend", dur: 0.15, end: () => pinch, k, w1: 1, c1: -0.3, lift: 0 },
        { kind: "grip", dur: 0.08, end: () => pinch, k, w1: 1, c1: 1, lift: 0 },
        { kind: "carry", dur: 0.32 + 0.6 * d, end: () => dest, k, w1: 1, c1: 1, lift: Math.min(0.075, 0.025 + 0.25 * d) },
        { kind: "release", dur: 0.07, end: () => dest, k, w1: 1, c1: -0.2, lift: 0, final: i === carries.length - 1 },
      );
      at = dest;
    });
    this.segs.push({ kind: "return", dur: 0.28 + 0.35 * at.distanceTo(this.restGraspTL), end: () => this.restGraspTL, k: null, w1: 0, c1: 0, lift: 0.04 });
  }

  /** Stop whatever the hand is doing (a new game, a new opponent) and bring it back to rest without a piece. */
  cancel() {
    this.drop();
    this.onPlaced = null;
    if (!this.segs.length || this.segs[0].kind === "return") return;
    this.segs = [{ kind: "return", dur: 0.45, end: () => this.restGraspTL, k: null, w1: 0, c1: 0, lift: 0.03 }];
  }

  setOpacity(o: number) {
    for (const m of this.chairMats) {
      if (m.transparent !== o < 1) {
        m.transparent = o < 1;
        m.needsUpdate = true;
      }
      m.opacity = o;
    }
  }

  dispose() {
    this.chair.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.chairMats.forEach((m) => m.dispose());
  }

  /** Once per frame, after the opponent's group is placed. viewer: the player's head in world space. */
  update(timeMs: number, ctx: { thinking: boolean; viewer: THREE.Vector3 | null }) {
    const now = timeMs / 1000;
    const first = !this.last;
    const dt = first ? 0 : clamp(now - this.last, 0, 0.1);
    this.now = now;
    this.last = now;
    this.thinking = ctx.thinking;

    this.table.updateWorldMatrix(true, true);
    const mesh = this.avatar.mesh;
    mesh.updateWorldMatrix(true, false);
    this.toBundle.copy(mesh.matrixWorld).invert().multiply(this.table.matrixWorld);
    this.fromBundle.copy(this.toBundle).invert();
    this.qToBundle.setFromRotationMatrix(this.toBundle);

    // resting: hands on the table just behind the board's far edge, fingers in toward the middle
    const r = this.rig;
    this.seat.set(0, SEAT_HEIGHT + r.hipAbove, 0);
    for (const side of [0, 1]) {
      const s = side === 0 ? 1 : -1; // the person's left is table +x
      this.wrist[side].set(s * 0.15, 0.042, -BOARD_EDGE - 0.12).applyMatrix4(this.toBundle);
      const dir = new THREE.Vector3(-s * 0.55, -0.1, 0.75).applyQuaternion(this.qToBundle);
      this.handPose(r.hands[side], dir, DOWN, side === 1 ? 0.25 : -0.25, side === 1 ? this.handRestR : this.hand[0]);
    }
    this.restGraspTL.copy(r.grasp).applyQuaternion(this.handRestR).add(this.wrist[1]).applyMatrix4(this.fromBundle);
    if (first) this.graspTL.copy(this.restGraspTL);

    this.advance(now);

    // the right hand: resting, or reaching for the pinch point
    this.graspB.copy(this.graspTL).applyMatrix4(this.toBundle);
    const reachQ = new THREE.Quaternion();
    if (this.w > 0) {
      const f = this.graspB.clone().sub(this.seat).addScaledVector(RIGHT, -0.17).setY(0);
      if (f.lengthSq() < 1e-4) f.copy(FWD);
      f.normalize();
      const beta = 0.9; // fingers pointing down at the piece
      const dir = f.clone().multiplyScalar(Math.cos(beta)).addScaledVector(DOWN, Math.sin(beta));
      const palm = DOWN.clone().multiplyScalar(Math.cos(beta)).addScaledVector(f, -Math.sin(beta));
      this.handPose(r.hands[1], dir, palm, 0.35, reachQ);
      const az = Math.atan2(-this.graspB.x, -this.graspB.z); // + toward the person's left
      this.twist = this.w * clamp(0.1 + 0.45 * az, -0.12, 0.45);
    } else this.twist = 0;
    this.hand[1].slerpQuaternions(this.handRestR, reachQ, smooth(this.w));
    this.wrist[1].copy(r.grasp).applyQuaternion(this.hand[1]).negate().add(this.graspB);

    // gaze: the piece the hand is going for, the player now and then, otherwise somewhere on the board
    const seg = this.segs[0];
    const g = new THREE.Vector3();
    if (seg?.k) g.copy(seg.kind === "reach" || seg.kind === "descend" || seg.kind === "grip" ? seg.k.fromTL : seg.k.toTL).setY(0.02);
    else if (ctx.viewer && now > this.glanceFrom && now < this.glanceUntil) this.table.worldToLocal(g.copy(ctx.viewer));
    else {
      const f = this.thinking ? 2.2 : 1;
      const a = this.thinking ? 1.5 : 1;
      g.set(a * (0.07 * Math.sin(0.29 * f * now) + 0.035 * Math.sin(0.83 * f * now + 1.3)), 0.02, -0.03 + a * (0.05 * Math.sin(0.23 * f * now + 2.1) + 0.02 * Math.sin(0.67 * f * now)));
    }
    this.gazeTL.lerp(g, 1 - Math.exp(-dt / (seg?.k ? 0.09 : 0.22)));
    this.gazeB.copy(this.gazeTL).applyMatrix4(this.toBundle);

    this.avatar.pose(now, (local, rootT) => this.solve(local, rootT));

    // the piece in hand follows the pinch point
    mesh.localToWorld(this.graspWorld.copy(this.graspB));
    this.reachError = this.graspWorld.distanceTo(this.table.localToWorld(this.graspTL.clone()));
    const k = this.held;
    if (k) {
      const p = this.boardGroup.worldToLocal(this.graspWorld.clone());
      p.y -= k.grip;
      p.addScaledVector(k.offset, k.decay);
      k.c.obj.position.copy(p);
      this.keepShadow(k.c, p.y);
    }
  }

  // ---------------- the move, step by step ----------------

  private advance(now: number) {
    while (this.segs.length) {
      const s = this.segs[0];
      if (!s.from) this.begin(s, now);
      const u = (now - s.t0!) / s.dur;
      if (u < 1) return this.evaluate(s, u);
      this.evaluate(s, 1);
      this.segs.shift();
      if (this.segs[0]) this.segs[0].t0 = s.t0! + s.dur; // keep time exact across steps
    }
    this.graspTL.copy(this.restGraspTL);
    this.w = 0;
    this.curl = 0;
  }

  private begin(s: Seg, now: number) {
    if (s.t0 === undefined) s.t0 = now;
    s.from = this.graspTL.clone();
    s.w0 = this.w;
    s.c0 = this.curl;
    const k = s.k;
    if (s.kind === "grip" && k) {
      // take hold: the piece moves with the hand from here, any gap between them closing during the carry
      const hand = this.boardGroup.worldToLocal(this.graspWorld.clone());
      hand.y -= k.grip;
      k.offset.copy(k.c.obj.position).sub(hand);
      if (k.offset.length() > 0.05) k.offset.set(0, 0, 0); // a hand far off (it couldn't reach): just take it
      k.decay = 1;
      this.held = k;
    }
    if (s.kind === "release" && k) {
      k.c.obj.position.copy(k.c.to);
      this.keepShadow(k.c, 0);
      if (k.c.captured) k.c.captured.visible = false;
      this.held = null;
      if (s.final) {
        const done = this.onPlaced;
        this.onPlaced = null;
        if (Math.random() < 0.6) {
          this.glanceFrom = now + 0.35; // a look up at the player once the move is made
          this.glanceUntil = now + 1.6;
        }
        done?.();
      }
    }
  }

  private evaluate(s: Seg, u: number) {
    const a = s.from!;
    const b = s.end();
    const p = this.graspTL;
    const e = smoother(u);
    if (s.kind === "carry") {
      // lift first, travel, and come down softly: height 6.75 u (1 - u)^2 peaks a third of the way
      p.lerpVectors(a, b, e);
      p.y = a.y + (b.y - a.y) * e + s.lift * 6.75 * u * (1 - u) * (1 - u);
      if (s.k) {
        s.k.decay = 1 - e;
        const cap = s.k.c.captured;
        if (cap) {
          const sc = 1 - clamp((u - 0.45) / 0.2, 0, 1); // the taken piece leaves as the hand arrives
          cap.scale.setScalar(Math.max(sc, 1e-3));
          cap.visible = sc > 0;
        }
      }
    } else if (s.kind === "descend") p.lerpVectors(a, b, smooth(u));
    else if (s.kind === "grip" || s.kind === "release") p.copy(b);
    else {
      p.lerpVectors(a, b, e);
      p.y += s.lift * Math.sin(Math.PI * u);
    }
    this.w = s.w0! + (s.w1 - s.w0!) * smooth(u);
    this.curl = s.c0! + (s.c1 - s.c0!) * smooth(u);
  }

  private drop() {
    if (this.held) {
      this.keepShadow(this.held.c, 0);
      this.held = null;
    }
  }

  private keepShadow(c: Carry, y: number) {
    const sh = c.shadow as THREE.Mesh | null | undefined;
    if (!sh) return;
    sh.position.y = 0.0009 - y;
    const m = sh.material as THREE.MeshBasicMaterial;
    if (m) m.opacity = clamp(1 - y / 0.1, 0.3, 1);
  }

  private boardToTable(v: THREE.Vector3) {
    this.table.updateWorldMatrix(true, true);
    return this.table.worldToLocal(this.boardGroup.localToWorld(v.clone()));
  }

  // ---------------- posing ----------------

  private handPose(h: HandRest, dir: THREE.Vector3, palm: THREE.Vector3, roll: number, out: THREE.Quaternion) {
    const d = dir.clone().normalize();
    const p = palm.clone().addScaledVector(d, -palm.dot(d)).normalize();
    if (roll) p.applyAxisAngle(d, roll); // + lifts the right thumb, - the left
    return alignTwo(h.dir, h.palm, d, p, out);
  }

  private fk(local: THREE.Quaternion[], rootT: THREE.Vector3, j: number) {
    const p = this.rig.parents[j];
    if (p < 0) {
      this.G[j].copy(local[j]);
      this.P[j].copy(this.rig.rest[j]).add(rootT);
    } else {
      this.G[j].multiplyQuaternions(this.G[p], local[j]);
      this.P[j].copy(this.rig.off[j]).applyQuaternion(this.G[p]).add(this.P[p]);
    }
  }

  /** Pelvis, spine, collars, neck and head for a forward lean (radians beyond the resting one); hips on the seat. */
  private torso(local: THREE.Quaternion[], rootT: THREE.Vector3, lean: number) {
    const t = this.now;
    const r = this.rig;
    const br = Math.sin((t * 2 * Math.PI) / 4.6); // breathing
    const L = BASE_LEAN + (this.thinking ? 0.05 : 0) + lean;
    const tw = this.twist;
    this.protract = 0.1 * this.w + 0.3 * (lean / MAX_LEAN);
    local[PELVIS].copy(YAW).multiply(rot(L * 0.34, tw * 0.15, 0.012 * Math.sin(t * 0.37)));
    local[SPINE1].copy(rot(L * 0.26 - br * 0.008, tw * 0.3, 0));
    local[SPINE2].copy(rot(L * 0.22 - br * 0.012, tw * 0.3, 0));
    local[SPINE3].copy(rot(L * 0.18 - br * 0.01, tw * 0.25, 0));
    local[L_COLLAR].copy(rot(0, 0, br * 0.012)); // shoulders rise a touch on the in-breath
    local[R_COLLAR].copy(rot(0, this.protract, -br * 0.012));
    local[NECK].copy(rot(0.12, 0, 0));
    local[HEAD].copy(rot(0.1, 0, 0.015 * Math.sin(t * 0.53)));
    // root_t from the rest skeleton: the hip joints land on the seat point, whatever the body's size
    rootT.copy(this.seat).sub(r.rest[PELVIS]).sub(_r.copy(r.hipMid).sub(r.rest[PELVIS]).applyQuaternion(local[PELVIS]));
    for (const j of [PELVIS, L_HIP, R_HIP, SPINE1, SPINE2, SPINE3, NECK, L_COLLAR, R_COLLAR, HEAD, L_SHOULDER, R_SHOULDER]) this.fk(local, rootT, j);
  }

  private solve(local: THREE.Quaternion[], rootT: THREE.Vector3) {
    const r = this.rig;
    const G = this.G;
    const P = this.P;
    // lean in as far as the reach needs (and a little whenever reaching): bisect on the right shoulder's distance
    const armR = r.arms[1];
    const need = (lean: number) => {
      this.torso(local, rootT, lean);
      return P[R_SHOULDER].distanceTo(this.wrist[1]) - 0.97 * armR.dMax;
    };
    let lean = 0;
    if (this.w > 0 && need(0) > 0) {
      if (need(MAX_LEAN) > 0) lean = MAX_LEAN;
      else {
        let lo = 0;
        let hi = MAX_LEAN;
        for (let i = 0; i < 14; i++) {
          const m = (lo + hi) / 2;
          if (need(m) > 0) lo = m;
          else hi = m;
        }
        lean = hi;
      }
    }
    this.torso(local, rootT, Math.max(lean, 0.06 * smooth(this.w)));

    // head and neck turn toward what the eyes are on
    const eye = (j: number) => this.P[j].clone().add(r.eyeOff.clone().applyQuaternion(G[j]));
    const want = this.gazeB.clone().sub(eye(HEAD)).normalize();
    const qn = swing(Z.clone().applyQuaternion(G[HEAD]), want, 1.1).clone().slerp(ID, 0.6); // the neck takes 40%
    G[NECK].premultiply(qn);
    local[NECK].copy(G[SPINE3]).invert().multiply(G[NECK]);
    this.fk(local, rootT, HEAD);
    want.copy(this.gazeB).sub(eye(HEAD)).normalize();
    G[HEAD].premultiply(swing(Z.clone().applyQuaternion(G[HEAD]), want, 0.9));
    local[HEAD].copy(G[NECK]).invert().multiply(G[HEAD]);

    const gA = new THREE.Quaternion();
    const lB = new THREE.Quaternion();
    const inv = new THREE.Quaternion();

    // legs: feet flat on the floor a little ahead of the knees, knees forward and slightly apart
    for (const side of [0, 1]) {
      const s = side === 0 ? 1 : -1;
      const L = r.legs[side];
      const target = P[L.a].clone().addScaledVector(FWD, 0.53 * (L.v1.length() + L.v2.length())).addScaledVector(LEFT, s * 0.04);
      target.y = r.ankleHeight;
      const pole = FWD.clone().addScaledVector(UP, 0.4).addScaledVector(LEFT, s * 0.15);
      solveLimb(L, P[L.a], target, pole, gA, lB);
      local[L.a].copy(inv.copy(G[PELVIS]).invert().multiply(gA));
      local[L.b].copy(lB);
      const knee = gA.clone().multiply(lB);
      P[L.b].copy(L.v1).applyQuaternion(gA).add(P[L.a]);
      P[L.c].copy(L.v2).applyQuaternion(knee).add(P[L.b]);
      local[L.c].copy(knee.invert().multiply(YAW).multiply(rot(0, s * 0.14, 0))); // toes out a little
      local[side === 0 ? L_FOOT : R_FOOT].identity();
    }

    // arms: two-bone IK to the wrist targets, elbows down and out, hands as asked (within what a wrist bends)
    for (const side of [0, 1]) {
      const L = r.arms[side];
      const out = side === 0 ? LEFT : RIGHT;
      const pole = DOWN.clone().addScaledVector(out, 0.75).addScaledVector(BACK, 0.3);
      const collar = side === 0 ? L_COLLAR : R_COLLAR;
      const axis = L.v2.clone().normalize(); // the forearm's own axis, elbow-local
      for (let pass = 0; ; pass++) {
        solveLimb(L, P[L.a], this.wrist[side], pole, gA, lB);
        G[L.b].multiplyQuaternions(gA, lB);
        // most of the hand's turn about the forearm is the forearm's (pronation): the elbow joint carries it in
        // SMPL-X, and turning about the forearm's own axis leaves the wrist where the IK put it
        const rel = inv.copy(G[L.b]).invert().multiply(this.hand[side]);
        lB.multiply(twistAbout(rel, axis).slerp(ID, 0.35));
        G[L.b].multiplyQuaternions(gA, lB);
        const wristRel = inv.copy(G[L.b]).invert().multiply(this.hand[side]);
        if (angleOf(wristRel) <= WRIST_MAX || side === 0 || pass === 2) break;
        // a hand turned further than a wrist bends: take the nearest turn it can, and move the wrist so the
        // fingers still land on the piece
        this.hand[side].copy(G[L.b]).multiply(swingLimit(wristRel, WRIST_MAX));
        this.wrist[side].copy(r.grasp).applyQuaternion(this.hand[side]).negate().add(this.graspB);
      }
      local[L.a].copy(inv.copy(G[collar]).invert().multiply(gA));
      local[L.b].copy(lB);
      P[L.b].copy(L.v1).applyQuaternion(gA).add(P[L.a]);
      P[L.c].copy(L.v2).applyQuaternion(G[L.b]).add(P[L.b]);
      const rel = inv.copy(G[L.b]).invert().multiply(this.hand[side]);
      local[L.c].copy(swingLimit(rel, WRIST_MAX));
      G[L.c].multiplyQuaternions(G[L.b], local[L.c]);
    }
    this.graspB.copy(r.grasp).applyQuaternion(G[R_WRIST]).add(P[R_WRIST]);

    // fingers: open on the way in, pinch while holding
    const c = this.curl;
    for (const [j, amt] of R_FINGERS) if (local[j]) local[j].multiply(rot(0, 0, c * amt));
  }

  // ---------------- the chair ----------------

  private buildChair(): THREE.Group {
    // dark, minimal: a lacquered seat, four slim legs, two back posts and a curved-feeling rail. Front faces -Z.
    const g = new THREE.Group();
    const mat = new THREE.MeshPhysicalMaterial({ color: 0x232325, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4 });
    this.chairMats.push(mat);
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      g.add(m);
    };
    const seatFront = -0.3;
    const seatBack = 0.12;
    const zc = (seatFront + seatBack) / 2;
    add(new RoundedBoxGeometry(0.44, 0.03, seatBack - seatFront, 3, 0.01), 0, SEAT_HEIGHT - 0.015, zc);
    const legH = SEAT_HEIGHT - 0.03;
    const leg = new THREE.CylinderGeometry(0.012, 0.009, legH, 14);
    for (const x of [-0.19, 0.19]) {
      add(leg, x, legH / 2, seatFront + 0.025);
      add(leg, x, legH / 2, seatBack - 0.025);
    }
    const postH = 0.42;
    const tilt = 0.08; // the back leans back a little
    const post = new THREE.CylinderGeometry(0.011, 0.011, postH, 14);
    for (const x of [-0.19, 0.19]) add(post, x, SEAT_HEIGHT + postH / 2 - 0.01, seatBack - 0.02 + Math.sin(tilt) * postH / 2, tilt);
    add(new RoundedBoxGeometry(0.42, 0.12, 0.02, 3, 0.008), 0, SEAT_HEIGHT + postH - 0.08, seatBack - 0.01 + Math.sin(tilt) * (postH - 0.07), tilt);
    return g;
  }
}

const WRIST_MAX = 1.2; // radians a wrist turns, beyond the forearm's own twist

/** The part of q that turns about axis (unit), as a new quaternion. */
function twistAbout(q: THREE.Quaternion, axis: THREE.Vector3) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const t = new THREE.Quaternion(axis.x * d, axis.y * d, axis.z * d, q.w);
  return t.lengthSq() < 1e-12 ? t.identity() : t.normalize();
}

function angleOf(q: THREE.Quaternion) {
  return 2 * Math.acos(clamp(Math.abs(q.w), 0, 1));
}

const _lim = new THREE.Quaternion();
/** q with its rotation angle capped (a wrist bends only so far). */
function swingLimit(q: THREE.Quaternion, maxAngle: number) {
  _lim.copy(q);
  if (_lim.w < 0) _lim.set(-_lim.x, -_lim.y, -_lim.z, -_lim.w);
  const ang = 2 * Math.acos(clamp(_lim.w, -1, 1));
  if (ang > maxAngle) _lim.slerp(ID, 1 - maxAngle / ang);
  return _lim;
}
