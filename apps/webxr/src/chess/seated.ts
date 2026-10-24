import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Skeleton, SkinnedAvatar } from "../avatar";
import { SQUARE } from "./pieces";
import { type Hesitation, type IdleKind, type Mode, type Position, type Style, Rng, hashSeed, holdSeconds, pickHesitation, pickIdle, pickStyle, thinkTime } from "./person";

// The opponent as a person at the table: seated on a chair, breathing, moving their own pieces with whichever hand is
// nearer, and doing what people do between moves (chin on a fist, hands clasped at the mouth, arms folded, sitting
// back), never the same way twice in a row. All of it is procedural on the avatar's SMPL-X rig (the motion file only
// lends the fingers their relaxed pose) and sized from the rest skeleton, so any avatar sits and reaches the same way.
// The habits themselves (think time, styles, which idle comes next) are in person.ts, drawn from a seeded random.
//
// Spaces. "Table": the chess table group's local space (board centre at the origin, playing surface at y = 0, the
// player on +z, the opponent on -z; the opponent's left is +x). "Bundle": the avatar mesh's own space (+Y up, front
// faces -Z, the person's right is +X, see avatar.ts), where the rig is posed: G_j = G_parent L_j, joint j at
// P_parent + G_parent (rest_j - rest_parent). The mesh sits at the origin of a group on the floor, so the floor is
// y = 0 in bundle space too. Hands are indexed 0 = left, 1 = right throughout.

export const SEAT_HEIGHT = 0.46;
const BOARD_EDGE = SQUARE * 4 + 0.018; // the board's far edge, frame included
const HIPS_BEHIND_EDGE = 0.45;
/** How far behind the board's centre the opponent's hip joints are: where the chair goes. */
export const SEAT_DISTANCE = BOARD_EDGE + HIPS_BEHIND_EDGE;

/** One piece a hand moves: board-local base positions, as squareToLocal gives them. */
export interface Carry {
  obj: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  height: number;
  role?: "victim" | "piece" | "rook"; // a taken piece going beside the board, the piece that moves, a castling rook
  captured?: THREE.Object3D | null; // taken off the board when the hand arrives
  shadow?: THREE.Object3D | null; // the piece's contact shadow, kept on the board while it's in the air
  onLand?: () => void; // the moment it's first set down
}

export interface PlayOptions {
  hardness?: number; // 0..1, from thinkTime: hard moves bring a careful hand and now and then a second thought
  decoys?: THREE.Vector3[]; // board-local bases of their other pieces near the one that moves (a hand may hover there first)
}

// SMPL-X joint order (the motion.json contract)
const PELVIS = 0, SPINE1 = 3, SPINE2 = 6, SPINE3 = 9, NECK = 12, L_COLLAR = 13, R_COLLAR = 14, HEAD = 15;
const L_HIP = 1, R_HIP = 2, L_KNEE = 4, R_KNEE = 5, L_ANKLE = 7, R_ANKLE = 8, L_FOOT = 10, R_FOOT = 11;
const L_SHOULDER = 16, R_SHOULDER = 17, L_ELBOW = 18, R_ELBOW = 19, L_WRIST = 20, R_WRIST = 21;
const L_MIDDLE1 = 28, R_MIDDLE1 = 43, L_EYE = 23, R_EYE = 24;
// right-hand fingers and how far each joint flexes in a pinch (radians at curl = 1); flexion is +z for the right hand,
// -z for the left (the same joints, 15 lower)
const R_FINGERS: [number, number][] = [
  [40, 0.3], [41, 0.5], [42, 0.35], // index
  [43, 0.7], [44, 0.95], [45, 0.6], // middle
  [46, 0.95], [47, 1.0], [48, 0.6], // pinky
  [49, 0.85], [50, 1.0], [51, 0.6], // ring
];
const L_FINGERS: [number, number][] = R_FINGERS.map(([j, a]) => [j - 15, a]);
const BODY = 22; // joints 0..21 are posed here; the rest (jaw, eyes, fingers) come from the motion

const BASE_LEAN = 0.2; // radians forward, pelvis + spine, at rest
const MAX_LEAN = 0.75; // what a far reach may add
const MAX_BEND = 2.6; // elbow / knee
const ELBOW_REST = 0.04; // the elbow joint above the table when that elbow rests on it (the arm's own thickness)

// bundle-space directions of the seated body (it faces -Z)
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const FWD = new THREE.Vector3(0, 0, -1);
const BACK = new THREE.Vector3(0, 0, 1);
const LEFT = new THREE.Vector3(-1, 0, 0); // the person's left
const RIGHT = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const YAW = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI); // rest faces +Z; the turn to face -Z
const OUT = [LEFT, RIGHT]; // each hand's outward side
const IN = [RIGHT, LEFT];

const smooth = (u: number) => u * u * (3 - 2 * u);
const smoother = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
/** Minimum-jerk easing with its speed peak moved earlier (k > 0) or later (k < 0): how real reaches go. */
const ease = (u: number, k = 0) => smoother(clamp(u + clamp(k, -0.6, 0.6) * u * (1 - u), 0, 1));
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
 * Analytic two-bone IK (shoulder-elbow-wrist, hip-knee-ankle). B stays a pure hinge between straight and MAX_BEND (it
 * never bends backwards): first the bend that makes |A -> C| the target distance (clamped to what the limb reaches),
 * then A's global rotation that points A -> C at the target with B bent toward `pole`. Writes A's global rotation
 * and B's local one.
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
  chinOff: THREE.Vector3; // head joint -> the chin, rest space
  mouthOff: THREE.Vector3; // head joint -> the mouth
  cheekOff: [THREE.Vector3, THREE.Vector3]; // head joint -> each cheek
  arms: [Limb, Limb]; // left, right
  legs: [Limb, Limb];
  forearm: [THREE.Vector3, THREE.Vector3]; // elbow -> wrist, rest space, unit
  hands: [HandRest, HandRest];
  grasp: [THREE.Vector3, THREE.Vector3]; // wrist -> the pinch point between thumb and index, rest space

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
    this.chinOff = this.eyeOff.clone().add(new THREE.Vector3(0, -0.105, 0));
    this.mouthOff = this.eyeOff.clone().add(new THREE.Vector3(0, -0.07, 0.004));
    this.cheekOff = [1, -1].map((s) => this.eyeOff.clone().add(new THREE.Vector3(s * 0.056, -0.07, -0.025))) as [THREE.Vector3, THREE.Vector3];
    const elbowHinge = (sh: number, el: number) => R[el].clone().sub(R[sh]).cross(Z).normalize(); // forearm swings forward
    const knee = new THREE.Vector3(1, 0, 0); // shin swings back
    this.arms = [makeLimb(R, L_SHOULDER, L_ELBOW, L_WRIST, elbowHinge(L_SHOULDER, L_ELBOW)), makeLimb(R, R_SHOULDER, R_ELBOW, R_WRIST, elbowHinge(R_SHOULDER, R_ELBOW))];
    this.legs = [makeLimb(R, L_HIP, L_KNEE, L_ANKLE, knee), makeLimb(R, R_HIP, R_KNEE, R_ANKLE, knee)];
    this.forearm = [this.arms[0].v2.clone().normalize(), this.arms[1].v2.clone().normalize()];
    const hand = (wrist: number, middle: number): HandRest => {
      const dir = R[middle].clone().sub(R[wrist]).normalize();
      return { dir, palm: DOWN.clone().addScaledVector(dir, -DOWN.dot(dir)).normalize() };
    };
    this.hands = [hand(L_WRIST, L_MIDDLE1), hand(R_WRIST, R_MIDDLE1)];
    const grasp = (side: 0 | 1, wrist: number, middle: number) =>
      this.hands[side].dir.clone().multiplyScalar(R[middle].distanceTo(R[wrist]) * 1.25).addScaledVector(this.hands[side].palm, 0.028);
    this.grasp = [grasp(0, L_WRIST, L_MIDDLE1), grasp(1, R_WRIST, R_MIDDLE1)];
  }
}

type Kind = "wait" | "reach" | "hover" | "descend" | "grip" | "carry" | "set" | "adjust" | "release" | "lift" | "press" | "return" | "tip" | "hold" | "shake";
interface Held {
  c: Carry;
  fromTL: THREE.Vector3; // table-local base positions
  toTL: THREE.Vector3;
  grip: number; // the pinch point's height above the piece's base
  offset: THREE.Vector3; // board-local: where the piece was vs. where the hand put it, shrinking to zero in the carry
  decay: number;
  landed: boolean; // set down at least once (its sound has played)
  setAt: THREE.Vector3 | null; // board-local: where it's first set down when the fingers then centre it
  yaw: number; // how far it's turned on that first set-down
  spin: number; // a small turn in the fingers on the way, gone by the time it lands
  yawNow: number;
}
/** A piece tipped over about the edge of its base (a king, resigning). Board-local. */
interface Tip {
  obj: THREE.Object3D;
  base: THREE.Vector3;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  grip: number;
  angle: number;
}
type Look = THREE.Vector3 | "viewer" | null;
/** One step of one hand. Its path runs from wherever the hand was when it began to end() (table-local pinch point). */
interface Seg {
  kind: Kind;
  dur: number; // seconds
  end: () => THREE.Vector3;
  k?: Held | null;
  tip?: Tip;
  w1: number; // reach weight at the end (0 = the idle pose has the hand, 1 = reaching or offered, with lean and twist)
  c1: number | "idle"; // finger curl at the end (-0.3 open, 0 relaxed, 1 pinch or fist), or the idle pose's own
  o1?: number; // 0 = fingers down at a piece, 1 = the hand held out to shake
  lift?: number; // meters the path rises in the middle
  bow?: number; // meters the path arcs sideways in the middle (signed: < 0 bows the other way)
  bowSide?: number; // table x the bow prefers (+1 the person's left, -1 their right)
  skew?: number; // easing skew
  over?: number; // meters a carry overshoots before settling onto the square
  drift?: number; // a hovering hand's unsteadiness, meters
  beta?: number; // finger angle below horizontal at a piece, radians
  roll?: number;
  hold?: boolean; // grip: false when the fingers only close on a piece without carrying it
  places?: boolean; // release: this puts its piece down for good
  settle?: boolean; // reach: before touching something, wait (briefly) until the hand is really there
  planned?: number; // its duration as planned, before any settling
  until?: () => boolean; // wait: ends (after `after` seconds) once this is true; dur is the cap
  after?: number;
  look?: () => Look; // what the eyes are on (table-local), or the player
  onBegin?: () => void;
  t0?: number;
  from?: THREE.Vector3;
  w0?: number;
  c0?: number;
  o0?: number;
  b0?: number;
  r0?: number;
}
/** The opponent's side of the clock: where to press (table-local, the top of the button), and what pressing does. */
export interface Tap {
  at: () => THREE.Vector3;
  onTap: () => void;
}

/** Where one hand is when the idle pose has it: its pinch point (table-local), turn (bundle), fingers, elbow. */
interface HandIdle {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  curl: number;
  pole: THREE.Vector3; // which way the elbow points (bundle)
  elbow: number; // 1 when the elbow rests on the table
  head: number; // 1 when the hand holds the head up (the head then turns less: the eyes do more of the looking)
}
/** An idle pose, evaluated: both hands, and how the body carries itself. */
interface Idle {
  hands: [HandIdle, HandIdle];
  lean: number; // radians beyond BASE_LEAN (< 0 sits back)
  twist: number; // + turns toward the person's left
  roll: number; // + leans toward the person's right
  neck: number; // extra neck flexion
  headRoll: number; // + tilts toward the person's right
  feet: number; // meters the feet sit further forward
}
interface IdleInst {
  kind: IdleKind;
  side: 0 | 1; // chin / cheek: the hand doing it; ready: the hand that moves
  r: number[]; // this instance's own small differences
}
const newHandIdle = (): HandIdle => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), curl: 0, pole: new THREE.Vector3(0, -1, 0), elbow: 0, head: 0 });
const newIdle = (): Idle => ({ hands: [newHandIdle(), newHandIdle()], lean: 0, twist: 0, roll: 0, neck: 0, headRoll: 0, feet: 0 });
function copyIdle(d: Idle, s: Idle) {
  for (const i of [0, 1]) {
    const a = d.hands[i];
    const b = s.hands[i];
    a.p.copy(b.p);
    a.q.copy(b.q);
    a.curl = b.curl;
    a.pole.copy(b.pole);
    a.elbow = b.elbow;
    a.head = b.head;
  }
  d.lean = s.lean;
  d.twist = s.twist;
  d.roll = s.roll;
  d.neck = s.neck;
  d.headRoll = s.headRoll;
  d.feet = s.feet;
  return d;
}

/** One hand's state: its queue of steps and where it is asked to be. */
class Hand {
  segs: Seg[] = [];
  p = new THREE.Vector3(); // the pinch point asked for, table-local
  w = 0;
  curl = 0;
  o = 0;
  beta = 0.9;
  roll = 0.35;
  held: Held | null = null;
  graspB = new THREE.Vector3(); // bundle: the pinch target before posing, where it really is after
  world = new THREE.Vector3(); // where the pinch point really is, world
  wrist = new THREE.Vector3(); // wrist target, bundle
  q = new THREE.Quaternion(); // hand turn target, bundle
  pole = new THREE.Vector3();
  lean = 0; // the lean this hand's reach asks of the body
  twist = 0; // the torso turn it asks
  err = 0; // meters between where the pinch point was asked to be and where the arm got it, last frame
  constructor(readonly side: 0 | 1) {}
}

const OFFER = new THREE.Vector3(-0.05, 0.2, 0.06); // a handshake over the board, table-local
const up = (v: THREE.Vector3, h: number) => v.clone().setY(v.y + h);

export class SeatedOpponent {
  readonly chair: THREE.Group;
  private rig!: Rig;
  private chairMats: THREE.MeshStandardMaterial[] = [];
  private hands: [Hand, Hand] = [new Hand(0), new Hand(1)];

  // time and what's going on
  private now = 0;
  private last = 0;
  private thinking = false;
  private moving = false; // from play() until both hands are back
  private over = false;
  private mode: Mode = "wait";
  private onPlaced: (() => void) | null = null;
  private pending = 0; // pieces still to be put down for good in this move
  private mainSide: 0 | 1 = 1;
  private nodAt = -1;

  // habits (person.ts), seeded per game
  private seed = 0;
  private idleRng = new Rng(1);
  private gazeRng = new Rng(2);
  private moveCount = 0;
  private lastStyle: Style["id"] | null = null;
  private lastHes: Hesitation | null = null;
  private styleLean = 0;
  private phase = 0;

  // idle poses: the current one (live), blended in from a snapshot of where the body was
  private idleInst: IdleInst = { kind: "rest", side: 1, r: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] };
  private lastFamily: IdleKind | null = "rest";
  private idleLive = newIdle();
  private idleOut = newIdle();
  private idleFrom: Idle | null = null;
  private idleT0 = 0;
  private idleDur = 1;
  private idleDelay = [0, 0];
  private switchAt = 0;
  private elbowAdj = 0; // extra lean that puts a resting elbow on the table, whatever the table's height
  private elbowW = 0;
  private breathPhase = 0;
  private breath = 0; // 0 breathed out .. 1 in
  private dt = 0;
  private leanS = 0; // the reach lean the body actually has: it follows what the hands ask, with a body's inertia
  private leanV = 0;

  // gaze
  private gazeTL = new THREE.Vector3(0, 0.02, 0);
  private gazeB = new THREE.Vector3();
  private fix = new THREE.Vector3(0, 0.02, 0);
  private fixViewer = false;
  private fixUntil = 0;
  private lookFrom = 0;
  private lookUntil = 0;
  private notice = new THREE.Vector3();
  private noticeUntil = 0;
  private candidates: THREE.Vector3[] = []; // squares the search is weighing, table-local
  /** Meters between where a hand was asked to be and where the arm got it (0 when every reach is exact). */
  reachError = 0;

  // spaces
  private toBundle = new THREE.Matrix4(); // table-local -> bundle
  private fromBundle = new THREE.Matrix4();
  private qToBundle = new THREE.Quaternion();
  private seat = new THREE.Vector3();

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
    this.reseed(hashSeed("opponent"));
  }

  /** A new game: its own seed, so its moves and moods are its own but the same every time for that seed. */
  reseed(seed: number) {
    this.seed = seed >>> 0;
    this.idleRng = new Rng(hashSeed(this.seed, "idle"));
    this.gazeRng = new Rng(hashSeed(this.seed, "gaze"));
    this.moveCount = 0;
    this.lastStyle = null;
    this.lastHes = null;
    this.phase = new Rng(hashSeed(this.seed, "phase")).range(0, 2 * Math.PI);
  }

  /** True from the moment a move starts until a hand has let go of the last piece. */
  get busy() {
    return this.hands.some((h) => h.segs.some((s) => !!s.k));
  }

  /** The hand is held out for a handshake. */
  get offering() {
    return this.hands[1].segs[0]?.kind === "hold";
  }

  /** The pinch point of the right hand, world space: where a handshake meets. */
  get handWorld() {
    return this.hands[1].world;
  }

  /** How long they sit with this position (ms), and how hard it is for them (0..1, for play()). */
  thinkTime(p: Position) {
    return thinkTime(new Rng(hashSeed(this.seed, "think", p.ply)), p);
  }

  /** A move the search is weighing (board-local squares): their eyes go back to it while they think. */
  consider(from: THREE.Vector3, to: THREE.Vector3) {
    for (const v of [from, to]) {
      const t = this.boardToTable(v).setY(0.02);
      if (this.candidates.some((c) => c.distanceTo(t) < 0.01)) continue;
      this.candidates.push(t);
      if (this.candidates.length > 6) this.candidates.shift();
    }
  }

  /** You moved (board-local destination): their eyes go to it, and sometimes up to you after. */
  saw(at: THREE.Vector3) {
    const r = this.gazeRng;
    this.notice.copy(this.boardToTable(at)).setY(0.02);
    this.noticeUntil = this.now + r.range(0.5, 0.9);
    this.lookUntil = 0;
    if (r.chance(0.3)) this.lookAtPlayer(r.range(0.8, 1.1), r.range(0.5, 0.9));
  }

  /**
   * Move pieces by hand: a captured piece goes beside the board first, then the piece (and a castling rook). onPlaced
   * runs when the last one is put down for good: the move is on the board from then on. Then, if given, the same
   * hand presses their side of the clock, they look up at you, and the hand goes back.
   */
  play(carries: Carry[], onPlaced: () => void, tap?: Tap, opts: PlayOptions = {}) {
    this.drop();
    this.onPlaced = onPlaced;
    this.pending = carries.length;
    this.moving = true;
    this.over = false;
    const rng = new Rng(hashSeed(this.seed, "move", this.moveCount++));
    const hard = clamp(opts.hardness ?? 0.3, 0, 1);
    const st = pickStyle(rng, this.lastStyle, hard);
    this.lastStyle = st.id;
    this.styleLean = st.lean;
    const victim = carries.find((c) => c.role === "victim") ?? null;
    const main = carries.find((c) => c !== victim) ?? carries[0];
    const others = carries.filter((c) => c !== victim && c !== main);
    const side = this.chooseHand(rng, this.boardToTable(main.from), this.boardToTable(main.to));
    this.mainSide = side;
    this.enterMove(rng, side);
    const hes = pickHesitation(rng, this.lastHes, hard, !!opts.decoys?.length);
    if (hes) this.lastHes = hes;
    const adjust = rng.chance(0.08 + 0.3 * hard + st.adjust);
    const plan: [Seg[], Seg[]] = [[], []];
    const at = [this.hands[0].p.clone(), this.hands[1].p.clone()];
    if (victim) {
      if (side === 1) this.carrySegs(plan[1], 1, at, victim, rng, st, { quick: true });
      else {
        // taken pieces go to their right: the right hand takes it off while the left goes for its own piece
        let lifted = false;
        this.carrySegs(plan[1], 1, at, victim, rng, st, { quick: true, onLift: () => (lifted = true) });
        plan[1].push(this.returnSeg(1, at[1], rng));
        plan[0].push({ kind: "wait", dur: 6, end: () => this.idleOut.hands[0].p, w1: 0, c1: "idle", until: () => lifted, after: rng.range(0.05, 0.3) });
      }
    }
    this.carrySegs(plan[side], side, at, main, rng, st, { hes, decoys: opts.decoys, adjust });
    for (const c of others) this.carrySegs(plan[side], side, at, c, rng, st, { quick: true });
    if (tap) this.tapSegs(plan[side], side, at, tap, rng, st);
    plan[side].push(this.returnSeg(side, at[side], rng));
    for (const s of [0, 1] as const) if (plan[s].length) this.hands[s].segs = plan[s];
  }

  /**
   * The game is over: tip the king over first if they lost (board-local base, the way it falls, its height), then
   * hold the right hand out over the board for a handshake. onTipped runs when the king lands.
   */
  endGame(tip?: { obj: THREE.Object3D; base: THREE.Vector3; fall: THREE.Vector3; height: number; shadow?: THREE.Object3D | null; onTipped?: () => void }) {
    this.drop();
    this.onPlaced = null;
    this.pending = 0;
    this.moving = false;
    this.over = true;
    this.mainSide = 1;
    const rng = new Rng(hashSeed(this.seed, "end", this.moveCount));
    const right: Seg[] = [];
    if (tip) {
      const fall = tip.fall.clone().setY(0).normalize();
      const t: Tip = { obj: tip.obj, base: tip.base.clone(), pivot: tip.base.clone().addScaledVector(fall, 0.0175), axis: new THREE.Vector3(0, 1, 0).cross(fall).normalize(), grip: tip.height * 0.85, angle: 0 };
      const top = () => this.tipGrip(t);
      const look = () => up(this.boardToTable(t.base), 0.03);
      if (tip.shadow) tip.shadow.visible = false;
      let tipped = false;
      const segs: Seg[] = [
        { kind: "reach", dur: rng.range(0.55, 0.8), end: () => up(top(), 0.04), w1: 1, c1: -0.3, lift: 0.03, beta: 0.9, roll: 0.35, look },
        { kind: "descend", dur: 0.18, end: top, w1: 1, c1: -0.3, skew: -0.2, look },
        { kind: "grip", dur: 0.12, end: top, w1: 1, c1: 0.8, hold: false, look },
        { kind: "tip", dur: rng.range(0.65, 0.9), end: top, tip: t, w1: 1, c1: 0.8, look },
        { kind: "release", dur: 0.2, end: top, w1: 1, c1: -0.1, look, onBegin: () => ((tipped = true), tip.onTipped?.()) },
      ];
      // a king on their left goes over under the left hand; the right one still offers the handshake
      if (this.boardToTable(t.base).x > 0.1) {
        this.hands[0].segs = [...segs, this.returnSeg(0, top())];
        right.push({ kind: "wait", dur: 8, end: () => this.idleOut.hands[1].p, w1: 0, c1: "idle", until: () => tipped, after: rng.range(0.2, 0.5) });
      } else right.push(...segs);
    }
    const offer = () => OFFER;
    right.push(
      { kind: "reach", dur: rng.range(0.85, 1.1), end: offer, w1: 1, o1: 1, c1: 0.15, lift: 0.04, skew: 0.15, look: () => "viewer" },
      { kind: "hold", dur: 14, end: offer, w1: 1, o1: 1, c1: 0.15, look: () => "viewer" },
      this.returnSeg(1, OFFER),
    );
    this.hands[1].segs = right;
  }

  /** Their hand met the player's: a few small shakes, then back to rest. */
  shake() {
    if (!this.offering) return;
    this.hands[1].segs = [
      { kind: "shake", dur: 1.15, end: () => OFFER, w1: 1, o1: 1, c1: 0.45, look: () => "viewer" },
      { kind: "grip", dur: 0.25, end: () => OFFER, w1: 1, o1: 1, c1: 0.1, hold: false, look: () => "viewer" },
      this.returnSeg(1, OFFER),
    ];
  }

  /** Look up at the player for a moment. */
  glance(delay = 0.15, dur = 1.1) {
    this.lookAtPlayer(delay, dur);
  }

  /** A small, slow nod: that was a good move. */
  nod() {
    if (this.now - this.nodAt > 1.6) this.nodAt = this.now;
  }

  /** Stop whatever the hands are doing (a new game, an undo, a new opponent) and bring them back without a piece. */
  cancel() {
    this.drop();
    this.onPlaced = null;
    this.pending = 0;
    this.moving = false;
    this.over = false;
    for (const h of this.hands) {
      if (!h.segs.length || (h.segs.length === 1 && h.segs[0].kind === "return")) continue;
      h.segs = [this.returnSeg(h.side, h.p, undefined, 0.45)];
    }
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

  /**
   * Once per frame, after the opponent's group is placed. viewer: the player's head in world space. watch: a piece
   * the player is holding, world space (their eyes follow it).
   */
  update(timeMs: number, ctx: { thinking: boolean; viewer: THREE.Vector3 | null; watch?: THREE.Vector3 | null }) {
    const now = timeMs / 1000;
    const first = !this.last;
    const dt = first ? 0 : clamp(now - this.last, 0, 0.1);
    this.now = now;
    this.last = now;
    this.thinking = ctx.thinking;

    this.table.updateWorldMatrix(true, true);
    this.avatar.mesh.updateWorldMatrix(true, false);
    this.toBundle.copy(this.avatar.mesh.matrixWorld).invert().multiply(this.table.matrixWorld);
    this.fromBundle.copy(this.toBundle).invert();
    this.qToBundle.setFromRotationMatrix(this.toBundle);
    this.seat.set(0, SEAT_HEIGHT + this.rig.hipAbove, 0);

    if (first) {
      this.switchAt = now + this.idleRng.range(1.5, 3.5);
      this.step(0, ctx, true); // puts the body somewhere first: poses that follow it (a chin, a chest) need it
    }
    this.step(dt, ctx, false);
  }

  private step(dt: number, ctx: { viewer: THREE.Vector3 | null; watch?: THREE.Vector3 | null }, first: boolean) {
    const now = this.now;
    this.dt = dt;
    this.updateMode(now);
    this.scheduleIdle(now);
    this.evalIdle(this.idleInst, this.idleLive);
    this.blendIdle(now);
    for (const h of this.hands) {
      if (first) h.p.copy(this.idleOut.hands[h.side].p);
      this.advance(h, now);
      this.aimHand(h);
    }
    this.updateGaze(now, dt, ctx);
    this.breathe(dt);

    this.avatar.pose(now, (local, rootT) => this.solve(local, rootT));

    // a piece in hand follows the pinch point
    const mesh = this.avatar.mesh;
    let err = 0;
    for (const h of this.hands) {
      mesh.localToWorld(h.world.copy(h.graspB));
      h.err = h.world.distanceTo(this.table.localToWorld(h.p.clone()));
      if (h.w > 0.5) err = Math.max(err, h.err);
      const k = h.held;
      if (!k) continue;
      const p = this.boardGroup.worldToLocal(h.world.clone());
      p.y -= k.grip;
      p.addScaledVector(k.offset, k.decay);
      k.c.obj.position.copy(p);
      k.c.obj.rotation.y = k.yawNow;
      this.keepShadow(k.c, p.y);
    }
    this.reachError = err;
    this.elbowControl(dt);
  }

  // ---------------- what they're doing: moving, thinking, waiting for you, done ----------------

  private updateMode(now: number) {
    if (this.moving && !this.hands[0].segs.length && !this.hands[1].segs.length) {
      this.moving = false;
      this.switchAt = now + this.idleRng.range(0.5, 1.6); // back from the move: settle, then the next pose
    }
    const mode: Mode = this.over ? "over" : this.moving ? "move" : this.thinking ? "think" : "wait";
    if (mode === this.mode) return;
    const r = this.idleRng;
    if (mode === "think") {
      this.switchAt = Math.min(this.switchAt, now + r.range(0.15, 0.8)); // down to it
      this.candidates.length = 0;
      this.fixUntil = 0;
    } else if (mode === "over") this.switchAt = now + r.range(2.5, 4);
    else if (mode === "wait" && this.mode !== "move") this.switchAt = Math.min(this.switchAt, now + r.range(0.4, 1.4));
    this.mode = mode;
  }

  private chooseHand(rng: Rng, from: THREE.Vector3, to: THREE.Vector3): 0 | 1 {
    // the hand nearer the piece's file, most of the time (right-handed: the middle files go to the right); +x is their left
    const x = 0.75 * from.x + 0.25 * to.x;
    let pLeft = 0.12 + 0.76 / (1 + Math.exp(-(x - 0.04) / 0.03));
    const k = this.idleInst;
    if ((k.kind === "chin" || k.kind === "cheek") && !this.idleFrom) pLeft += k.side === 1 ? 0.2 : -0.2; // the hand under the chin tends to stay
    return rng.chance(clamp(pLeft, 0.05, 0.92)) ? 0 : 1;
  }

  /** A move starts: the free hand finds somewhere to be (or stays under the chin, if it was there). */
  private enterMove(rng: Rng, side: 0 | 1) {
    const cur = this.idleInst;
    if ((cur.kind === "chin" || cur.kind === "cheek") && cur.side !== side && rng.chance(0.6)) return;
    const inst = this.newInst("ready", rng, side);
    inst.r[0] = this.lastFamily === "leanBack" && rng.chance(0.5) ? 0 : 1; // 0: the free hand stays on the thigh
    this.startIdle(inst, this.now);
  }

  private scheduleIdle(now: number) {
    if (this.mode === "move" || now < this.switchAt) return;
    const r = this.idleRng;
    this.startIdle(this.newInst(pickIdle(r, this.mode, this.lastFamily), r), now);
    this.switchAt = now + this.idleDur + holdSeconds(r, this.mode);
  }

  private newInst(kind: IdleKind, rng: Rng, side?: 0 | 1): IdleInst {
    return { kind, side: side ?? (rng.chance(0.5) ? 0 : 1), r: Array.from({ length: 6 }, () => rng.next()) };
  }

  private startIdle(inst: IdleInst, now: number) {
    const r = this.idleRng;
    this.idleFrom = copyIdle(newIdle(), this.idleOut);
    this.idleInst = inst;
    this.evalIdle(inst, this.idleLive);
    const dist = Math.max(this.idleFrom.hands[0].p.distanceTo(this.idleLive.hands[0].p), this.idleFrom.hands[1].p.distanceTo(this.idleLive.hands[1].p));
    this.idleDur = clamp(0.65 + 1.5 * dist, 0.8, 1.9) * r.range(0.9, 1.15);
    this.idleT0 = now;
    const lag = r.range(0.04, 0.22); // the hands don't move in step
    this.idleDelay = r.chance(0.5) ? [0, lag] : [lag, 0];
    if (inst.kind !== "ready") this.lastFamily = inst.kind;
  }

  /** From the snapshot to the live pose: hands lift a little on the way, one a beat behind the other. */
  private blendIdle(now: number) {
    const out = this.idleOut;
    const live = this.idleLive;
    const from = this.idleFrom;
    if (!from) {
      copyIdle(out, live);
      return;
    }
    const b = (now - this.idleT0) / this.idleDur;
    if (b >= 1) {
      this.idleFrom = null;
      copyIdle(out, live);
      return;
    }
    const e = smoother(clamp(b, 0, 1));
    out.lean = lerp(from.lean, live.lean, e);
    out.twist = lerp(from.twist, live.twist, e);
    out.roll = lerp(from.roll, live.roll, e);
    out.neck = lerp(from.neck, live.neck, e);
    out.headRoll = lerp(from.headRoll, live.headRoll, e);
    out.feet = lerp(from.feet, live.feet, e);
    for (const s of [0, 1]) {
      const eh = smoother(clamp((b - this.idleDelay[s]) / 0.78, 0, 1));
      const A = from.hands[s];
      const B = live.hands[s];
      const O = out.hands[s];
      const arc = Math.min(0.06, 0.3 * A.p.distanceTo(B.p)) * Math.sin(Math.PI * eh);
      O.p.lerpVectors(A.p, B.p, eh);
      O.p.y += arc * 0.75;
      O.p.z -= arc * 0.4; // up, and in toward the body
      O.q.slerpQuaternions(A.q, B.q, eh);
      O.curl = lerp(A.curl, B.curl, eh);
      O.pole.lerpVectors(A.pole, B.pole, eh).normalize();
      O.elbow = lerp(A.elbow, B.elbow, eh);
      O.head = lerp(A.head, B.head, eh);
    }
  }

  // ---------------- idle poses ----------------

  private evalIdle(inst: IdleInst, out: Idle) {
    const r = inst.r;
    const j = (i: number, a: number) => (r[i] - 0.5) * 2 * a; // +-a
    out.lean = 0;
    out.twist = j(4, 0.03);
    out.roll = j(5, 0.02);
    out.neck = 0;
    out.headRoll = j(3, 0.03);
    out.feet = 0;
    const s = inst.side;
    const o = (1 - s) as 0 | 1;
    const sg = s === 1 ? 1 : -1; // + toward the person's right
    switch (inst.kind) {
      case "rest":
        this.restHand(0, out.hands[0], r[0], r[1]);
        this.restHand(1, out.hands[1], r[1], r[2]);
        out.lean = j(0, 0.05);
        break;
      case "chin":
        this.chinHand(s, out.hands[s], r[0]);
        this.restHand(o, out.hands[o], r[1], r[2], 0.03);
        out.lean = 0.3;
        out.twist += sg * 0.05;
        out.headRoll = sg * 0.05 + j(3, 0.02);
        out.neck = 0.12;
        out.feet = -0.02;
        break;
      case "cheek":
        this.cheekHand(s, out.hands[s], r[0]);
        this.restHand(o, out.hands[o], r[1], r[2], 0.03);
        out.lean = 0.26;
        out.twist += sg * 0.04;
        out.headRoll = sg * 0.13 + j(3, 0.02);
        out.neck = 0.06;
        out.feet = -0.02;
        break;
      case "clasped":
        this.claspedHands(out, r[0]);
        out.lean = 0.3;
        out.neck = 0.04;
        out.feet = -0.03;
        break;
      case "forearms":
        this.forearmHands(out, r[0], r[1]);
        out.lean = 0.26;
        out.neck = 0.06;
        out.feet = -0.02;
        break;
      case "armsFolded":
        this.foldedArms(out, r[0], r[1]);
        out.lean = -0.12 + j(0, 0.03);
        out.neck = 0.1;
        out.feet = 0.04;
        break;
      case "leanBack": {
        const onTable = r[1] < 0.35 ? (r[2] < 0.5 ? 0 : 1) : -1; // now and then one hand stays on the table
        for (const h of [0, 1] as const) {
          if (h === onTable) this.restHand(h, out.hands[h], r[2], r[3]);
          else this.thighHand(h, out.hands[h], r[h * 2]);
        }
        out.lean = -0.3 + j(0, 0.04);
        out.neck = 0.12;
        out.feet = 0.08;
        break;
      }
      case "ready":
        this.restHand(s, out.hands[s], 0.5, 0.5);
        if (r[0] === 0) this.thighHand(o, out.hands[o], r[1]);
        else this.restHand(o, out.hands[o], r[1], r[2]);
        out.lean = 0.04;
        break;
    }
  }

  /** Bundle space, from last frame's pose: a point fixed to joint j (rest-space offset). */
  private bodyPoint(j: number, off: THREE.Vector3) {
    return off.clone().applyQuaternion(this.G[j]).add(this.P[j]);
  }

  /** A hand pose given by its wrist (bundle) and turn: its pinch point, table-local. */
  private fromWrist(side: 0 | 1, wristB: THREE.Vector3, out: HandIdle) {
    out.p.copy(this.rig.grasp[side]).applyQuaternion(out.q).add(wristB).applyMatrix4(this.fromBundle);
  }

  private defaultPole(side: 0 | 1, out: THREE.Vector3) {
    return out.copy(DOWN).addScaledVector(OUT[side], 0.75).addScaledVector(BACK, 0.3).normalize();
  }

  /** Resting on the table just behind the board's far edge, fingers in toward the middle. inward: meters nearer it. */
  private restHand(side: 0 | 1, out: HandIdle, a: number, b: number, inward = 0) {
    const s = side === 0 ? 1 : -1; // the person's left is table +x
    const wrist = new THREE.Vector3(s * (0.15 - inward + (a - 0.5) * 0.06), 0.042, -BOARD_EDGE - 0.12 + (b - 0.5) * 0.05).applyMatrix4(this.toBundle);
    const dir = new THREE.Vector3(-s * 0.55, -0.1, 0.75).applyQuaternion(this.qToBundle);
    this.handPose(this.rig.hands[side], dir, DOWN, (side === 1 ? 0.25 : -0.25) + (a - 0.5) * 0.15, out.q);
    this.fromWrist(side, wrist, out);
    out.curl = 0.12 + 0.2 * b;
    this.defaultPole(side, out.pole);
    out.elbow = 0;
    out.head = 0;
  }

  /** A loose fist under the chin, that elbow down on the table. */
  private chinHand(side: 0 | 1, out: HandIdle, a: number) {
    const g = this.bodyPoint(HEAD, this.rig.chinOff).addScaledVector(DOWN, 0.03).addScaledVector(FWD, 0.01).addScaledVector(IN[side], (a - 0.5) * 0.02);
    this.handPose(this.rig.hands[side], UP.clone().multiplyScalar(0.9).addScaledVector(BACK, 0.4).addScaledVector(IN[side], 0.12), BACK, 0, out.q);
    out.p.copy(g).applyMatrix4(this.fromBundle);
    out.curl = 0.85 + 0.1 * a;
    out.pole.copy(DOWN).addScaledVector(FWD, 0.6).addScaledVector(OUT[side], 0.25).normalize();
    out.elbow = 1;
    out.head = 1;
  }

  /** The side of the face resting in an open palm, fingers up along the temple, elbow on the table. */
  private cheekHand(side: 0 | 1, out: HandIdle, a: number) {
    const dir = UP.clone().multiplyScalar(0.85).addScaledVector(BACK, 0.25).addScaledVector(IN[side], 0.12).normalize();
    this.handPose(this.rig.hands[side], dir, IN[side], 0, out.q);
    // the heel of the hand under the jaw, the palm along the cheek
    const wrist = this.bodyPoint(HEAD, this.rig.cheekOff[side]).addScaledVector(dir, -0.06).addScaledVector(OUT[side], 0.022).addScaledVector(FWD, 0.005 + 0.01 * a);
    this.fromWrist(side, wrist, out);
    out.curl = 0.15 + 0.15 * a;
    out.pole.copy(DOWN).addScaledVector(FWD, 0.1).addScaledVector(OUT[side], 0.3).normalize(); // the elbow straight down, never out over the board
    out.elbow = 1;
    out.head = 1;
  }

  /** Both elbows on the table, hands clasped in front of the mouth. */
  private claspedHands(out: Idle, a: number) {
    const c = this.bodyPoint(HEAD, this.rig.mouthOff).addScaledVector(FWD, 0.07 + 0.015 * a).addScaledVector(DOWN, 0.025);
    for (const side of [0, 1] as const) {
      const h = out.hands[side];
      const wrist = c.clone().addScaledVector(DOWN, 0.085).addScaledVector(OUT[side], 0.032).addScaledVector(BACK, 0.012);
      this.handPose(this.rig.hands[side], c.clone().sub(wrist), IN[side], 0, h.q);
      this.fromWrist(side, wrist, h);
      h.curl = 0.62;
      h.pole.copy(DOWN).addScaledVector(FWD, 0.55).addScaledVector(OUT[side], 0.35).normalize();
      h.elbow = 1;
      h.head = 0.5;
    }
  }

  /** Forearms folded on the table's edge, one in front of the other, each hand by the other elbow. */
  private forearmHands(out: Idle, a: number, b: number) {
    const zE = -BOARD_EDGE - 0.15 + (a - 0.5) * 0.03;
    const rightInFront = b < 0.5;
    for (const side of [0, 1] as const) {
      const h = out.hands[side];
      const s = side === 0 ? 1 : -1;
      const front = (side === 1) === rightInFront;
      const wrist = new THREE.Vector3(-s * 0.07, 0.036, zE + (front ? 0.025 : -0.03)).applyMatrix4(this.toBundle);
      const dir = new THREE.Vector3(-s, -0.05, front ? -0.1 : -0.14).applyQuaternion(this.qToBundle);
      this.handPose(this.rig.hands[side], dir, DOWN, 0, h.q);
      this.fromWrist(side, wrist, h);
      h.curl = front ? 0.35 : 0.45;
      h.pole.copy(OUT[side]).addScaledVector(DOWN, 0.6).addScaledVector(BACK, 0.25).normalize();
      h.elbow = 1;
      h.head = 0;
    }
  }

  /** Arms folded across the chest: one forearm over the other, the hands tucked against the other arm. */
  private foldedArms(out: Idle, a: number, b: number) {
    const g = this.G[SPINE3];
    const lb = new THREE.Vector3(1, 0, 0).applyQuaternion(g); // the person's left, as the chest is turned
    const ub = new THREE.Vector3(0, 1, 0).applyQuaternion(g);
    const fb = new THREE.Vector3(0, 0, 1).applyQuaternion(g);
    // the forearms cross well clear of the chest (its front is ~0.13 ahead of spine3), elbows out at the sides
    const c = this.P[SPINE3].clone().addScaledVector(ub, -0.08).addScaledVector(fb, 0.2 + 0.01 * a);
    const rightOnTop = b < 0.6;
    for (const side of [0, 1] as const) {
      const h = out.hands[side];
      const across = side === 0 ? lb.clone().negate() : lb.clone(); // the left hand goes to the right side
      const top = (side === 1) === rightOnTop;
      const wrist = c.clone().addScaledVector(across, 0.035).addScaledVector(ub, top ? 0.015 : -0.03).addScaledVector(fb, top ? 0.012 : -0.01);
      const dir = across.clone().multiplyScalar(0.8).addScaledVector(fb, -0.45).addScaledVector(ub, top ? 0.05 : -0.1);
      const palm = top ? fb.clone().negate().addScaledVector(ub, -1) : fb.clone().negate();
      this.handPose(this.rig.hands[side], dir, palm, 0, h.q);
      this.fromWrist(side, wrist, h);
      h.curl = top ? 0.4 : 0.55;
      h.pole.copy(ub).negate().addScaledVector(OUT[side], 0.9).addScaledVector(fb, 0.25).normalize();
      h.elbow = 0;
      h.head = 0;
    }
  }

  /** A hand resting on the thigh, fingers toward the knee. */
  private thighHand(side: 0 | 1, out: HandIdle, a: number) {
    const hip = this.P[side === 0 ? L_HIP : R_HIP];
    const knee = this.P[side === 0 ? L_KNEE : R_KNEE];
    const along = knee.clone().sub(hip).normalize();
    const wrist = hip.clone().lerp(knee, 0.4 + 0.15 * a).addScaledVector(UP, 0.095).addScaledVector(IN[side], 0.012);
    const dir = along.addScaledVector(DOWN, 0.3).addScaledVector(IN[side], 0.12);
    this.handPose(this.rig.hands[side], dir, DOWN, side === 1 ? 0.1 : -0.1, out.q);
    this.fromWrist(side, wrist, out);
    out.curl = 0.3;
    out.pole.copy(DOWN).addScaledVector(OUT[side], 0.45).addScaledVector(BACK, 0.45).normalize();
    out.elbow = 0;
    out.head = 0;
  }

  /** An elbow pose rests that elbow on the table: lean in or sit up until it's there, at any table height. */
  private elbowControl(dt: number) {
    let err = 0;
    let n = 0;
    let W = 0;
    for (const h of this.hands) {
      const wt = this.idleOut.hands[h.side].elbow * (1 - smooth(h.w));
      if (wt <= 0.01) continue;
      const y = this.P[h.side === 0 ? L_ELBOW : R_ELBOW].clone().applyMatrix4(this.fromBundle).y;
      err += wt * (y - ELBOW_REST);
      n += wt;
      W = Math.max(W, wt);
    }
    this.elbowW = W;
    if (n > 0) this.elbowAdj = clamp(this.elbowAdj + clamp(3 * (err / n) * W * W, -0.4, 0.4) * dt, -0.3, 0.45);
    else this.elbowAdj *= Math.exp(-dt / 0.6);
  }

  // ---------------- a move, step by step ----------------

  private carrySegs(list: Seg[], side: 0 | 1, at: THREE.Vector3[], c: Carry, rng: Rng, st: Style, opt: { quick?: boolean; hes?: Hesitation | null; decoys?: THREE.Vector3[]; adjust?: boolean; onLift?: () => void }) {
    const sp = st.speed * rng.range(0.9, 1.1) * (opt.quick ? 1.1 : 1);
    const k: Held = { c, fromTL: this.boardToTable(c.from), toTL: this.boardToTable(c.to), grip: clamp(c.height * rng.range(0.74, 0.88), 0.03, 0.075), offset: new THREE.Vector3(), decay: 1, landed: false, setAt: null, yaw: 0, spin: rng.range(-0.12, 0.12), yawNow: 0 };
    const hover = st.hover * rng.range(0.85, 1.25);
    const pinch = up(k.fromTL, k.grip);
    let above = up(k.fromTL, k.grip + hover);
    const bowSide = side === 0 ? 1 : -1;
    const aim = { beta: st.beta + rng.range(-0.08, 0.08), roll: st.roll + rng.range(-0.08, 0.08) };
    const open = st.open + rng.range(-0.06, 0.06);
    const lookFrom = () => up(k.fromTL, 0.02);
    const lookTo = () => up(k.toTL, 0.02);
    const reachDur = (a: THREE.Vector3, b: THREE.Vector3) => ((0.28 + 0.5 * a.distanceTo(b) + this.farTime(side, b)) / sp) * rng.range(0.92, 1.1);
    const bow = (a: THREE.Vector3, b: THREE.Vector3) => clamp(rng.range(0.06, 0.13) * st.bow * Math.hypot(b.x - a.x, b.z - a.z), 0, 0.05) * (rng.chance(0.2) ? -0.6 : 1);
    const reach = (to: THREE.Vector3, from: THREE.Vector3, look: () => Look, dur = reachDur(from, to), w1 = 1): Seg => ({
      kind: "reach", dur, end: () => to, k, w1, c1: open, lift: rng.range(0.015, 0.04), bow: bow(from, to), bowSide, skew: st.skew + rng.range(-0.08, 0.08), ...aim, look,
    });
    let cur = at[side].clone();
    if (opt.hes === "decoy" && opt.decoys?.length) {
      // the hand drifts over another piece first, then thinks better of it
      const d = this.boardToTable(rng.pick(opt.decoys));
      const over = up(d, rng.range(0.085, 0.11));
      const look = () => up(d, 0.02);
      list.push(reach(over, cur, look), { kind: "hover", dur: rng.range(0.45, 0.9), end: () => over, k, w1: 1, c1: open + 0.15, drift: 0.006, look });
      cur = over;
    } else if (opt.hes === "retract") {
      // most of the way there, a pause, then the hand draws back and waits before going again
      const mid = cur.clone().lerp(above, rng.range(0.5, 0.7));
      mid.y = Math.max(mid.y, above.y) + 0.03;
      const back = () => this.idleOut.hands[side].p.clone().lerp(mid, 0.4);
      list.push(
        reach(mid, cur, lookFrom, reachDur(cur, mid) * 1.15),
        { kind: "hover", dur: rng.range(0.2, 0.45), end: () => mid, k, w1: 1, c1: open, drift: 0.004, look: lookFrom },
        { kind: "reach", dur: rng.range(0.4, 0.6), end: back, k, w1: 0.45, c1: 0.3, lift: 0.01, skew: 0.1, look: lookFrom },
        { kind: "hover", dur: rng.range(0.5, 1.1), end: back, k, w1: 0.45, c1: 0.35, drift: 0.005, look: lookFrom },
      );
      cur = back();
    }
    if (opt.hes === "hover") above = up(k.fromTL, k.grip + hover + rng.range(0.03, 0.05));
    list.push({ ...reach(above, cur, lookFrom), settle: true });
    if (opt.hes === "hover") list.push({ kind: "hover", dur: rng.range(0.5, 1.2), end: () => above, k, w1: 1, c1: open, drift: 0.007, look: lookFrom });
    list.push(
      { kind: "descend", dur: ((0.1 + 1.6 * (above.y - pinch.y)) / sp) * rng.range(0.9, 1.1), end: () => pinch, k, w1: 1, c1: open, skew: -0.2, look: lookFrom },
      { kind: "grip", dur: rng.range(0.06, 0.1), end: () => pinch, k, w1: 1, c1: 1, look: lookFrom },
    );
    // the carry: lifted (a knight hops higher), carried on a slight arc, set down softly
    const d = Math.hypot(k.toTL.x - k.fromTL.x, k.toTL.z - k.fromTL.z);
    const knight = c.obj.userData?.type === "n";
    const lift = (knight ? Math.max(0.05, 0.03 + 0.2 * d) : Math.min(0.07, 0.018 + 0.22 * d)) * st.lift * rng.range(0.85, 1.15);
    let dest = up(k.toTL, k.grip);
    if (opt.adjust) {
      // set down a few millimetres off and a little turned, then straightened with the fingertips
      const a = rng.range(0, 2 * Math.PI);
      const off = rng.range(0.003, 0.006);
      k.setAt = c.to.clone().add(new THREE.Vector3(Math.cos(a) * off, 0, Math.sin(a) * off));
      k.yaw = rng.range(0.06, 0.14) * rng.sign();
      dest = up(this.boardToTable(k.setAt), k.grip);
    }
    list.push({
      kind: "carry", dur: ((0.26 + 0.6 * d) / sp) * rng.range(0.9, 1.12), end: () => dest, k, w1: 1, c1: 1, lift,
      bow: clamp(rng.range(0.03, 0.08) * d * st.bow, 0, 0.025) * (rng.chance(0.3) ? -1 : 1), bowSide,
      skew: st.skew * 0.6 + rng.range(-0.05, 0.05), over: st.overshoot * rng.range(0.6, 1.2), look: lookTo, onBegin: opt.onLift,
    });
    const final = up(k.toTL, k.grip);
    if (opt.adjust)
      list.push(
        { kind: "set", dur: rng.range(0.06, 0.09), end: () => dest, k, w1: 1, c1: -0.1, look: lookTo },
        { kind: "hover", dur: rng.range(0.12, 0.3), end: () => dest, k, w1: 1, c1: -0.05, look: lookTo },
        { kind: "grip", dur: 0.08, end: () => dest, k, w1: 1, c1: 0.85, hold: false, look: lookTo },
        { kind: "adjust", dur: rng.range(0.22, 0.38), end: () => final, k, w1: 1, c1: 0.85, look: lookTo },
      );
    list.push({ kind: "release", dur: rng.range(0.05, 0.09), end: () => final, k, w1: 1, c1: -0.2, places: true, look: lookTo });
    const off = up(k.toTL, k.grip + rng.range(0.025, 0.045));
    off.z -= rng.range(0.005, 0.02);
    list.push({ kind: "lift", dur: st.settle * rng.range(0.8, 1.25), end: () => off, w1: 1, c1: -0.1, skew: 0.1, look: lookTo });
    at[side] = off;
  }

  /** The clock, with the hand that moved: over to the button, a press, and a look up at the player. */
  private tapSegs(list: Seg[], side: 0 | 1, at: THREE.Vector3[], tap: Tap, rng: Rng, st: Style) {
    const sp = st.speed * rng.range(0.92, 1.15);
    const hov = rng.range(0.025, 0.045);
    const above = () => up(tap.at(), hov);
    const pressed = () => up(tap.at(), -0.007);
    const look = rng.chance(0.55) ? () => up(tap.at(), 0) : undefined; // otherwise their eyes stay on the move
    const c1 = rng.range(0.25, 0.5);
    const start = at[side];
    const d = start.distanceTo(tap.at());
    list.push(
      { kind: "reach", settle: true, dur: ((0.28 + 0.45 * d + this.farTime(side, tap.at())) / sp) * rng.range(0.9, 1.1), end: above, w1: 1, c1, lift: rng.range(0.02, 0.04), bow: clamp(rng.range(0.04, 0.1) * st.bow * d, 0, 0.04), bowSide: side === 0 ? 1 : -1, skew: st.skew, beta: rng.range(0.55, 0.8), roll: st.roll * 0.6, look },
      { kind: "press", dur: rng.range(0.06, 0.1) / sp, end: pressed, w1: 1, c1, skew: 0.3, look },
      {
        kind: "press", dur: rng.range(0.09, 0.14), end: above, w1: 1, c1,
        onBegin: () => {
          tap.onTap();
          this.lookAtPlayer(rng.range(0.1, 0.35), rng.range(0.9, 1.8));
        },
      },
    );
    at[side] = up(tap.at(), hov);
  }

  /** Extra seconds for a target past the arm's easy reach (table-local): the lean takes time. */
  private farTime(side: 0 | 1, at: THREE.Vector3) {
    const d = Math.hypot(at.x - (side === 0 ? 0.17 : -0.17), at.z + SEAT_DISTANCE - 0.1); // from roughly that shoulder
    return 1.4 * Math.max(0, d - 0.5);
  }

  private returnSeg(side: 0 | 1, from: THREE.Vector3, rng?: Rng, dur?: number): Seg {
    const d = from.distanceTo(this.idleOut.hands[side].p);
    return { kind: "return", dur: dur ?? (0.32 + 0.4 * d + 0.6 * this.farTime(side, from)) * (rng ? rng.range(0.9, 1.15) : 1), end: () => this.idleOut.hands[side].p, w1: 0, c1: "idle", o1: 0, lift: 0.03, skew: 0.1 };
  }

  private advance(h: Hand, now: number) {
    for (let guard = 0; guard < 64 && h.segs.length; guard++) {
      const s = h.segs[0];
      if (!s.from) {
        this.begin(h, s, now);
        if (h.segs[0] !== s) continue; // its start handed the hand something new (a game over, say)
      }
      // about to touch a piece or the clock while the trunk is still leaning in: hold on until the hand is there
      if (s.settle && now - s.t0! >= s.dur && h.err > 0.008 && now - s.t0! - (s.planned ??= s.dur) < 0.5) s.dur = now - s.t0! + 0.02;
      const u = (now - s.t0!) / s.dur;
      if (u < 1) return this.evaluate(h, s, u);
      this.evaluate(h, s, 1);
      if (h.segs[0] === s) {
        h.segs.shift();
        if (h.segs[0] && !h.segs[0].from) h.segs[0].t0 = s.t0! + s.dur; // keep time exact across steps
      }
    }
    // nothing to do: the idle pose has the hand
    const idle = this.idleOut.hands[h.side];
    h.p.copy(idle.p);
    h.w = 0;
    h.o = 0;
    h.curl = idle.curl;
  }

  private begin(h: Hand, s: Seg, now: number) {
    if (s.t0 === undefined) s.t0 = now;
    s.from = h.p.clone();
    s.w0 = h.w;
    s.c0 = h.curl;
    s.o0 = h.o;
    s.b0 = h.beta;
    s.r0 = h.roll;
    const k = s.k;
    if (s.kind === "grip" && k && s.hold !== false) {
      // take hold: the piece moves with the hand from here, any gap between them closing during the carry
      const hand = this.boardGroup.worldToLocal(h.world.clone());
      hand.y -= k.grip;
      k.offset.copy(k.c.obj.position).sub(hand);
      if (k.offset.length() > 0.05) k.offset.set(0, 0, 0); // a hand far off (it couldn't reach): just take it
      k.decay = 1;
      h.held = k;
    }
    if ((s.kind === "set" || s.kind === "release") && k) {
      const set = s.kind === "set" && k.setAt;
      k.c.obj.position.copy(set ? k.setAt! : k.c.to);
      k.c.obj.rotation.y = set ? k.yaw : 0;
      this.keepShadow(k.c, 0);
      if (k.c.captured) k.c.captured.visible = false;
      for (const o of this.hands) if (o.held === k) o.held = null;
      if (!k.landed) {
        k.landed = true;
        k.c.onLand?.();
      }
      if (s.places) {
        this.pending--;
        if (k.c.role !== "victim") {
          this.notice.copy(k.toTL).setY(0.02); // eyes stay on the move a moment
          this.noticeUntil = now + 0.8;
        }
        if (this.pending <= 0) {
          const done = this.onPlaced;
          this.onPlaced = null;
          done?.();
        }
      }
    }
    s.onBegin?.();
  }

  private evaluate(h: Hand, s: Seg, u: number) {
    const a = s.from!;
    const b = s.end();
    const p = h.p;
    const e = ease(u, s.skew ?? 0);
    switch (s.kind) {
      case "wait": {
        // the hand stays with the idle pose until it's wanted
        if (s.until?.()) {
          s.until = undefined;
          s.dur = Math.min(s.dur, this.now - s.t0! + (s.after ?? 0));
        }
        const kk = smooth(clamp((this.now - s.t0!) / 0.5, 0, 1));
        const idle = this.idleOut.hands[h.side];
        p.lerpVectors(a, idle.p, kk);
        h.w = s.w0! * (1 - kk);
        h.curl = s.c0! + (idle.curl - s.c0!) * kk;
        h.o = s.o0! * (1 - kk);
        return;
      }
      case "carry": {
        // lift first, travel, and come down softly: height 6.75 u (1 - u)^2 peaks a third of the way
        p.lerpVectors(a, b, e);
        p.y = a.y + (b.y - a.y) * e + (s.lift ?? 0) * 6.75 * u * (1 - u) * (1 - u);
        this.bow(p, a, b, s, e);
        if (s.over) {
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const L = Math.hypot(dx, dz);
          const o = L > 0.01 ? s.over * Math.sin(Math.PI * clamp((e - 0.55) / 0.45, 0, 1)) : 0;
          p.x += (dx / (L || 1)) * o;
          p.z += (dz / (L || 1)) * o;
        }
        if (s.k) {
          s.k.decay = 1 - e;
          s.k.yawNow = s.k.setAt ? s.k.yaw * e : s.k.spin * Math.sin(Math.PI * e);
          const cap = s.k.c.captured;
          if (cap) {
            const sc = 1 - clamp((u - 0.45) / 0.2, 0, 1); // the taken piece leaves as the hand arrives
            cap.scale.setScalar(Math.max(sc, 1e-3));
            cap.visible = sc > 0;
          }
        }
        break;
      }
      case "descend":
      case "press":
        p.lerpVectors(a, b, e);
        break;
      case "grip":
      case "set":
      case "release":
        p.copy(b);
        break;
      case "hover": {
        p.copy(b);
        const d = (s.drift ?? 0) * Math.sin(Math.PI * u);
        const t = this.now;
        p.x += d * Math.sin(t * 5.3 + 0.7);
        p.y += d * 0.6 * Math.sin(t * 4.1 + 2.1);
        p.z += d * Math.sin(t * 6.7 + 1.3);
        break;
      }
      case "adjust": {
        // the fingertips slide the piece onto the centre of its square and straighten it
        const k = s.k!;
        const m = smoother(u);
        k.c.obj.position.lerpVectors(k.setAt ?? k.c.to, k.c.to, m);
        k.c.obj.rotation.y = k.yaw * (1 - m);
        p.copy(this.boardToTable(k.c.obj.position));
        p.y += k.grip;
        break;
      }
      case "tip": {
        // over it goes, about the edge of its base, the fingers riding its head down
        const t = s.tip!;
        t.angle = (Math.PI / 2 + 0.08) * (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
        const q = new THREE.Quaternion().setFromAxisAngle(t.axis, t.angle);
        t.obj.quaternion.copy(q);
        t.obj.position.copy(t.base).sub(t.pivot).applyQuaternion(q).add(t.pivot);
        p.copy(this.tipGrip(t));
        break;
      }
      case "hold":
        p.copy(b);
        p.y += 0.004 * Math.sin(this.now * 2.1); // a held-out hand is never quite still
        break;
      case "shake":
        p.copy(b);
        p.y += 0.028 * Math.sin(2 * Math.PI * 3 * u) * Math.sin(Math.PI * u);
        break;
      default: // reach, lift, return: an eased path that rises and bows a little, never a straight line
        p.lerpVectors(a, b, e);
        this.bow(p, a, b, s, e);
        p.y += (s.lift ?? 0) * Math.sin(Math.PI * e);
    }
    const m = smooth(u);
    h.w = s.w0! + (s.w1 - s.w0!) * m;
    const c1 = s.c1 === "idle" ? this.idleOut.hands[h.side].curl : s.c1;
    h.curl = s.c0! + (c1 - s.c0!) * m;
    h.o = s.o0! + ((s.o1 ?? 0) - s.o0!) * m;
    if (s.beta !== undefined) h.beta = s.b0! + (s.beta - s.b0!) * m;
    if (s.roll !== undefined) h.roll = s.r0! + (s.roll - s.r0!) * m;
  }

  /** The sideways arc of a path: perpendicular to its run, toward the hand's own side (or toward the body). */
  private bow(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, s: Seg, e: number) {
    if (!s.bow) return;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    if (L < 0.01) return;
    let nx = -dz / L;
    let nz = dx / L;
    if (nx * (s.bowSide ?? 0) - 0.3 * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const amt = s.bow * 4 * e * (1 - e);
    p.x += nx * amt;
    p.z += nz * amt;
  }

  /** Table-local: where the fingers hold a tipping piece (just under its head). */
  private tipGrip(t: Tip) {
    const q = new THREE.Quaternion().setFromAxisAngle(t.axis, t.angle);
    const g = t.base.clone().setY(t.base.y + t.grip).sub(t.pivot).applyQuaternion(q).add(t.pivot);
    return this.boardToTable(g);
  }

  private drop() {
    for (const h of this.hands) {
      if (!h.held) continue;
      this.keepShadow(h.held.c, 0);
      h.held = null;
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

  // ---------------- eyes ----------------

  private lookAtPlayer(delay: number, dur: number) {
    this.lookFrom = this.now + delay;
    this.lookUntil = this.lookFrom + dur;
  }

  /** What a hand is doing draws the eyes: the moving hand first. */
  private segLook(): Look {
    for (const i of this.mainSide === 0 ? [0, 1] : [1, 0]) {
      const l = this.hands[i].segs[0]?.look?.();
      if (l) return l;
    }
    return null;
  }

  private updateGaze(now: number, dt: number, ctx: { viewer: THREE.Vector3 | null; watch?: THREE.Vector3 | null }) {
    const g = new THREE.Vector3();
    let viewer = false;
    const look = this.segLook();
    if (look === "viewer") viewer = true;
    else if (look) g.copy(look);
    else if (now >= this.lookFrom && now < this.lookUntil) viewer = true;
    else if (now < this.noticeUntil) g.copy(this.notice);
    else if (ctx.watch && this.mode === "wait") this.table.worldToLocal(g.copy(ctx.watch)); // your hand, with a piece
    else {
      if (now >= this.fixUntil) this.nextFixation(now);
      if (this.fixViewer) viewer = true;
      else g.copy(this.fix);
    }
    if (viewer) {
      if (ctx.viewer) this.table.worldToLocal(g.copy(ctx.viewer));
      else g.set(0, 0.45, 0.6);
    } else {
      // eyes are never perfectly still on a point
      g.x += 0.004 * Math.sin(now * 2.3 + this.phase);
      g.z += 0.004 * Math.sin(now * 1.7 + 2 * this.phase);
    }
    this.gazeTL.lerp(g, 1 - Math.exp(-dt / (look ? 0.09 : 0.12)));
    this.gazeB.copy(this.gazeTL).applyMatrix4(this.toBundle);
  }

  /** Where the eyes rest next, and for how long: candidate squares while thinking, the board and you while waiting. */
  private nextFixation(now: number) {
    const r = this.gazeRng;
    let dur: number;
    if (this.mode === "over") {
      this.fixViewer = !this.fixViewer && r.chance(0.6);
      if (!this.fixViewer) this.randomSquare(r, 0, this.fix);
      dur = r.range(1, 2.5);
    } else if (this.mode === "think") {
      this.fixViewer = !this.fixViewer && r.chance(0.04);
      if (!this.fixViewer) {
        if (this.candidates.length && r.chance(0.7)) this.fix.copy(r.pick(this.candidates));
        else this.randomSquare(r, 0, this.fix);
      }
      dur = this.fixViewer ? r.range(0.35, 0.6) : r.range(0.35, 1.1);
    } else {
      // your move: the board, and every few seconds a look at you
      this.fixViewer = this.mode === "wait" && !this.fixViewer && r.chance(0.28);
      if (!this.fixViewer) this.randomSquare(r, this.mode === "wait" ? 0.6 : 0, this.fix);
      dur = this.fixViewer ? r.range(0.7, 1.5) : r.range(0.6, 2.0);
    }
    this.fixUntil = now + dur;
  }

  /** A square near the middle of the board, table-local; bias > 0 leans toward the player's side. */
  private randomSquare(r: Rng, bias: number, out: THREE.Vector3) {
    const x = SQUARE * 4 * (r.next() + r.next() - 1);
    const z = SQUARE * (4 * (r.next() + r.next() - 1) + 2 * bias);
    return out.set(clamp(x, -0.18, 0.18), 0.02, clamp(z, -0.18, 0.18));
  }

  private breathe(dt: number) {
    // about 13 breaths a minute (a little slower while thinking), in faster than out
    this.breathPhase += dt * ((2 * Math.PI) / (this.thinking ? 5.2 : 4.5)) * (1 + 0.08 * Math.sin(this.now * 0.13 + this.phase));
    const x = (this.breathPhase / (2 * Math.PI)) % 1;
    this.breath = x < 0.4 ? smooth(x / 0.4) : 1 - smooth((x - 0.4) / 0.6);
  }

  // ---------------- posing ----------------

  /** A hand's target turn and wrist for this frame: the idle pose's, a reach's (fingers down at a piece), or a handshake. */
  private aimHand(h: Hand) {
    const r = this.rig;
    const side = h.side;
    const idle = this.idleOut.hands[side];
    h.graspB.copy(h.p).applyMatrix4(this.toBundle);
    const reachQ = new THREE.Quaternion();
    if (h.w > 0) {
      const f = h.graspB.clone().sub(this.seat).addScaledVector(OUT[side], -0.17).setY(0);
      if (f.lengthSq() < 1e-4) f.copy(FWD);
      f.normalize();
      const dir = f.clone().multiplyScalar(Math.cos(h.beta)).addScaledVector(DOWN, Math.sin(h.beta));
      const palm = DOWN.clone().multiplyScalar(Math.cos(h.beta)).addScaledVector(f, -Math.sin(h.beta));
      this.handPose(r.hands[side], dir, palm, side === 1 ? h.roll : -h.roll, reachQ);
      if (side === 1 && h.o > 0) {
        // palm sideways, thumb up, fingers toward the player
        const offerQ = this.handPose(r.hands[1], FWD.clone().addScaledVector(DOWN, 0.15), LEFT, 0, new THREE.Quaternion());
        reachQ.slerp(offerQ, smooth(h.o));
      }
    }
    const m = smooth(h.w);
    h.q.slerpQuaternions(idle.q, reachQ, m);
    h.wrist.copy(r.grasp[side]).applyQuaternion(h.q).negate().add(h.graspB);
    h.pole.copy(idle.pole).lerp(this.defaultPole(side, new THREE.Vector3()), m).normalize();
    // the reaching shoulder comes forward: the torso turns a little toward the target, more for the far side
    const az = Math.atan2(-h.graspB.x, -h.graspB.z); // + toward the person's left
    h.twist = m * (side === 1 ? clamp(0.1 + 0.45 * az, -0.12, 0.45) : -clamp(0.1 - 0.45 * az, -0.12, 0.45));
  }

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

  /** Pelvis, spine, collars, neck and head: the idle pose's carriage, a reach's lean, breathing, a slow sway. */
  private torso(local: THREE.Quaternion[], rootT: THREE.Vector3, reach: number) {
    const t = this.now;
    const r = this.rig;
    const I = this.idleOut;
    const br = this.breath;
    const L = clamp(BASE_LEAN + I.lean + this.elbowAdj * this.elbowW + reach, -0.2, 1.1);
    const [hl, hr] = this.hands;
    const tw = I.twist + hl.twist + hr.twist;
    const sway = I.roll + 0.012 * Math.sin(t * 0.37 + this.phase) + 0.006 * Math.sin(t * 0.83 + 2 * this.phase); // weight shifting
    const pl = 0.1 * smooth(hl.w) + 0.3 * (Math.min(hl.lean, reach) / MAX_LEAN); // a reaching shoulder comes forward
    const pr = 0.1 * smooth(hr.w) + 0.3 * (Math.min(hr.lean, reach) / MAX_LEAN);
    local[PELVIS].copy(YAW).multiply(rot(L * 0.34, tw * 0.15, sway * 0.6));
    local[SPINE1].copy(rot(L * 0.26, tw * 0.3, sway * 0.25));
    // breathing in: the chest lifts (spine2-3 extend) and the shoulders rise about 2.5 mm; the neck keeps the head still
    local[SPINE2].copy(rot(L * 0.22 - br * 0.01, tw * 0.3, sway * 0.15));
    local[SPINE3].copy(rot(L * 0.18 - br * 0.02, tw * 0.25, 0));
    local[L_COLLAR].copy(rot(0, -pl, br * 0.02));
    local[R_COLLAR].copy(rot(0, pr, -br * 0.02));
    local[NECK].copy(rot(0.12 + I.neck + br * 0.025, 0, -sway * 0.7));
    local[HEAD].copy(rot(0.1, 0, I.headRoll + 0.015 * Math.sin(t * 0.53 + this.phase)));
    // root_t from the rest skeleton: the hip joints land on the seat point, whatever the body's size
    rootT.copy(this.seat).sub(r.rest[PELVIS]).sub(_r.copy(r.hipMid).sub(r.rest[PELVIS]).applyQuaternion(local[PELVIS]));
    for (const j of [PELVIS, L_HIP, R_HIP, SPINE1, SPINE2, SPINE3, NECK, L_COLLAR, R_COLLAR, HEAD, L_SHOULDER, R_SHOULDER]) this.fk(local, rootT, j);
  }

  private solve(local: THREE.Quaternion[], rootT: THREE.Vector3) {
    const r = this.rig;
    const G = this.G;
    const P = this.P;
    // lean in as far as each reaching hand needs (bisect on its shoulder's distance to its wrist target), and on
    // far squares a little more than the arm strictly needs, from the hips and the shoulders
    let reach = 0;
    let wmax = 0;
    for (const h of this.hands) {
      const m = smooth(h.w);
      wmax = Math.max(wmax, m);
      const wr = smooth(clamp(h.w * 1.25, 0, 1));
      if (wr <= 0) {
        h.lean = 0;
        continue;
      }
      const sh = h.side === 0 ? L_SHOULDER : R_SHOULDER;
      const most = 0.9 * r.arms[h.side].dMax;
      const need = (lean: number) => {
        this.torso(local, rootT, lean);
        return P[sh].distanceTo(h.wrist) - most;
      };
      let lean = 0;
      if (need(0) > 0) {
        if (need(MAX_LEAN) > 0) lean = MAX_LEAN;
        else {
          let lo = 0;
          let hi = MAX_LEAN;
          for (let i = 0; i < 14; i++) {
            const mid = (lo + hi) / 2;
            if (need(mid) > 0) lo = mid;
            else hi = mid;
          }
          lean = hi;
        }
      }
      const ahead = clamp((-h.graspB.z - 0.45) / 0.35, 0, 1); // 0 at the board's near edge, 1 at its far edge
      h.lean = wr * lean + m * this.styleLean * ahead;
      reach = Math.max(reach, h.lean);
    }
    // the trunk is heavy: it follows the lean the hands ask for on a critically damped spring, never faster than
    // about 1.6 rad/s (the reaches are timed so it keeps up)
    const asked = Math.max(reach, 0.06 * wmax);
    const steps = Math.ceil(this.dt / 0.02);
    for (let i = 0; i < steps; i++) {
      const h = this.dt / steps;
      const om = 11;
      this.leanV = clamp(this.leanV + (om * om * (asked - this.leanS) - 2 * om * this.leanV) * h, -1.6, 1.6);
      this.leanS += this.leanV * h;
    }
    this.torso(local, rootT, this.leanS);

    // head and neck turn toward what the eyes are on; a head resting on a hand turns less (the eyes do the rest)
    let held = 0;
    for (const h of this.hands) held = Math.max(held, this.idleOut.hands[h.side].head * (1 - smooth(h.w)));
    const turn = 1 - 0.6 * held;
    const eye = (j: number) => this.P[j].clone().add(r.eyeOff.clone().applyQuaternion(G[j]));
    const want = this.gazeB.clone().sub(eye(HEAD)).normalize();
    const qn = swing(Z.clone().applyQuaternion(G[HEAD]), want, 1.1 * turn).clone().slerp(ID, 0.6); // the neck takes 40%
    G[NECK].premultiply(qn);
    local[NECK].copy(G[SPINE3]).invert().multiply(G[NECK]);
    this.fk(local, rootT, HEAD);
    want.copy(this.gazeB).sub(eye(HEAD)).normalize();
    G[HEAD].premultiply(swing(Z.clone().applyQuaternion(G[HEAD]), want, 0.9 * turn));
    local[HEAD].copy(G[NECK]).invert().multiply(G[HEAD]);
    const nod = (this.now - this.nodAt) / 1.5; // a small, slow nod: down, and back up
    if (nod >= 0 && nod < 1) {
      local[HEAD].multiply(rot(0.15 * (1 - Math.cos(2 * Math.PI * nod)) / 2, 0, 0));
      G[HEAD].multiplyQuaternions(G[NECK], local[HEAD]);
    }

    const gA = new THREE.Quaternion();
    const lB = new THREE.Quaternion();
    const inv = new THREE.Quaternion();
    const wl = new THREE.Quaternion();

    // legs: feet flat on the floor a little ahead of the knees (further out when sitting back), knees slightly apart
    for (const side of [0, 1]) {
      const s = side === 0 ? 1 : -1;
      const L = r.legs[side];
      const target = P[L.a].clone().addScaledVector(FWD, 0.53 * (L.v1.length() + L.v2.length()) + this.idleOut.feet).addScaledVector(LEFT, s * 0.04);
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

    // arms: two-bone IK to the wrist targets, elbows where each pose points them, hands as asked within what a
    // forearm turns and a wrist bends
    for (const h of this.hands) {
      const side = h.side;
      const L = r.arms[side];
      const hr = r.hands[side];
      const collar = side === 0 ? L_COLLAR : R_COLLAR;
      for (let pass = 0; ; pass++) {
        solveLimb(L, P[L.a], h.wrist, h.pole, gA, lB);
        G[L.b].multiplyQuaternions(gA, lB);
        // most of the hand's turn about the forearm is the forearm's (pronation, supination): the elbow joint carries
        // it in SMPL-X, and turning about the forearm's own axis leaves the wrist where the IK put it
        inv.copy(G[L.b]).invert().multiply(h.q);
        lB.multiply(forearmTwist(inv, r.forearm[side], side));
        G[L.b].multiplyQuaternions(gA, lB);
        inv.copy(G[L.b]).invert().multiply(h.q);
        if (!limitWrist(inv, hr.dir, hr.palm, wl) || pass === 2) break;
        // a hand turned further than a wrist bends: take the nearest turn it can, and move the wrist so the
        // fingers still land where they were going
        h.q.copy(G[L.b]).multiply(wl);
        h.wrist.copy(r.grasp[side]).applyQuaternion(h.q).negate().add(h.graspB);
      }
      local[L.a].copy(inv.copy(G[collar]).invert().multiply(gA));
      local[L.b].copy(lB);
      P[L.b].copy(L.v1).applyQuaternion(gA).add(P[L.a]);
      P[L.c].copy(L.v2).applyQuaternion(G[L.b]).add(P[L.b]);
      local[L.c].copy(wl);
      G[L.c].multiplyQuaternions(G[L.b], local[L.c]);
      h.graspB.copy(r.grasp[side]).applyQuaternion(G[L.c]).add(P[L.c]);
    }

    // fingers: open on the way in, pinch while holding, curled in a fist, loose at rest
    for (const h of this.hands) {
      const sg = h.side === 1 ? 1 : -1;
      for (const [j, amt] of h.side === 1 ? R_FINGERS : L_FINGERS) if (local[j]) local[j].multiply(rot(0, 0, sg * h.curl * amt));
    }
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

/** The part of q that turns about axis (unit), as a new quaternion. */
function twistAbout(q: THREE.Quaternion, axis: THREE.Vector3) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const t = new THREE.Quaternion(axis.x * d, axis.y * d, axis.z * d, q.w);
  return t.lengthSq() < 1e-12 ? t.identity() : t.normalize();
}

/** The signed angle of a rotation about axis (unit), in (-pi, pi]. */
function angleAbout(q: THREE.Quaternion, axis: THREE.Vector3) {
  let a = 2 * Math.atan2(q.x * axis.x + q.y * axis.y + q.z * axis.z, q.w);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * The forearm's share (65%) of a hand's turn about it, within what a forearm turns: + about the right forearm's axis
 * turns the palm up (supination, up to about 150 degrees from the rest pose's palm-down), - about the left's; the
 * rest pose is already near the end of pronation.
 */
function forearmTwist(rel: THREE.Quaternion, axis: THREE.Vector3, side: 0 | 1) {
  const t = twistAbout(rel, axis).slerp(ID, 0.35);
  const [lo, hi] = side === 1 ? [-0.4, 2.6] : [-2.6, 0.4];
  return t.setFromAxisAngle(axis, clamp(angleAbout(t, axis), lo, hi));
}

const _tw = new THREE.Quaternion();
const _swg = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _fl = new THREE.Vector3();
const _dv = new THREE.Vector3();
/**
 * A wrist's turn relative to its forearm (q), within what a wrist does: flexion toward the palm up to 1.2 rad,
 * extension 1.0, side to side 0.5 (an ellipse between them), and 0.5 of twist left over from the forearm. dir and
 * palm: the hand's rest direction and palm normal. Writes the allowed turn to out; true when it had to limit.
 */
function limitWrist(q: THREE.Quaternion, dir: THREE.Vector3, palm: THREE.Vector3, out: THREE.Quaternion): boolean {
  out.copy(q);
  if (out.w < 0) out.set(-out.x, -out.y, -out.z, -out.w);
  const tw = twistAbout(out, dir);
  const ta = angleAbout(tw, dir);
  _swg.copy(out).multiply(_tw.copy(tw).invert()); // q = swing * twist
  if (_swg.w < 0) _swg.set(-_swg.x, -_swg.y, -_swg.z, -_swg.w);
  const sa = 2 * Math.acos(clamp(_swg.w, -1, 1));
  const sn = Math.sqrt(Math.max(0, 1 - _swg.w * _swg.w));
  let flex = 0;
  let dev = 0;
  if (sn > 1e-6) {
    _ax.set(_swg.x / sn, _swg.y / sn, _swg.z / sn);
    _fl.crossVectors(dir, palm).normalize(); // + about it curls the hand toward the palm
    _dv.crossVectors(_fl, dir).normalize();
    flex = sa * _ax.dot(_fl);
    dev = sa * _ax.dot(_dv);
  }
  const k = (flex / (flex > 0 ? 1.2 : 1.0)) ** 2 + (dev / 0.5) ** 2;
  if (k <= 1 && Math.abs(ta) <= 0.5) return false;
  if (sn > 1e-6) _swg.setFromAxisAngle(_ax, k > 1 ? sa / Math.sqrt(k) : sa);
  else _swg.identity();
  out.copy(_swg).multiply(_tw.setFromAxisAngle(dir, clamp(ta, -0.5, 0.5)));
  return true;
}
