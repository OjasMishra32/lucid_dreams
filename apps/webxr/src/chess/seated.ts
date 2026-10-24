import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Skeleton, SkinnedAvatar } from "../avatar";
import { type PieceType, SQUARE, pieceRadius } from "./pieces";
import { BodyShape } from "./body";
import { FIST, PINCH, POINT, fingerQuat } from "./fingers";
import { liveJoints, openness } from "../xr/hands";
import { type Hesitation, type IdleKind, type Mode, type Position, type Style, Rng, SIDED, hashSeed, holdSeconds, pickHesitation, pickIdle, pickStyle, thinkTime } from "./person";

// The opponent as a person at the table: seated on a chair, breathing, moving their own pieces with whichever hand is
// nearer, and doing what people do between moves (chin on a fist, hands clasped at the mouth, arms folded, sitting
// back), never the same way twice in a row. All of it is procedural on the avatar's SMPL-X rig (the motion file only
// lends the fingers their relaxed pose) and sized from the rest skeleton, so any avatar sits and reaches the same way.
// The habits themselves (think time, styles, which idle comes next) are in person.ts, drawn from a seeded random.
//
// Nothing of theirs goes through anything (scripts/check_chess_poses.ts measures it on the real avatars): hands rest on
// the table between the board and its edge, never over the pieces; every path goes up, over and down, high enough for
// the hand (its own shape: balls along each finger, from the rig and the avatar's Gaussians) and the piece in it to
// clear what's under them; a piece is taken by its head between thumb and index, the pinch fitted to its real profile
// (pieces.ts), the other three fingers curled out of the way; the clock is pressed with the index; arms swivel up off
// the table and the pieces; a far reach leans in, then slides and half rises rather than put the chest into the table;
// and the joints stay where the skin renders well (twist in the forearm, not the wrist; the shoulder blade lifting with
// a raised arm; the head never thrown back).
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
/**
 * The table the board is set into (built with the chair: buildTable), table-local. Its top is 1 mm under the board's
 * surface (the board is inlaid, so the clock and the captured pieces, which stand at the board's height, stand on it),
 * 3 cm thick, 96 cm across. On their side it ends 18 cm past the board, a hand's width in front of their belly; on
 * yours 7 cm past it, about where your hands come to rest, so its edge never cuts through your forearms. Nothing of
 * theirs goes through it: hands rest on it, forearms lie on it, elbows over it stay above it.
 */
export const TABLE_TOP = -0.001;
export const TABLE_EDGE = BOARD_EDGE + 0.18;
export const TABLE_NEAR = BOARD_EDGE + 0.07;
export const TABLE_HALF_X = 0.48;
export const TABLE_THICK = 0.03;
const BOARD_TOP = 0.0005;
const GAP = 0.008; // meters every hand, arm and carried piece keeps above anything it passes over

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
  pressure?: number; // 0..1: a short clock; everything a little quicker
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
const CURL = R_FINGERS.map(([, a]) => a); // by finger joint 0..11 of a hand (the thumb, 12..14, never curls)
/** How far a piece's head reaches from its axis where it's held (pieces.ts profiles, at 75-90% of its height). */
const HEAD_R: Record<string, number> = { p: 0.0105, b: 0.0098, n: 0.011, r: 0.0144, q: 0.0122, k: 0.011 };
const PIECE_R = 0.0175; // a piece's base
/** pieceRadius (pieces.ts) tabulated every half millimetre: the pinch is fitted against it many times over. */
const PROFILE = new Map<string, Float32Array>();
function profileR(type: PieceType, y: number, dx = 1, dz = 0) {
  if (type === "n") return pieceRadius(type, y, dx, dz); // (a knight's head isn't round)
  let t = PROFILE.get(type);
  if (!t) {
    t = new Float32Array(200);
    for (let i = 0; i < 200; i++) t[i] = pieceRadius(type, i * 0.0005);
    PROFILE.set(type, t);
  }
  const i = Math.round(y / 0.0005);
  return i < 0 || i >= 200 ? 0 : t[i];
}
const BODY = 22; // joints 0..21 are posed here; the rest (jaw, eyes, fingers) come from the motion

const BASE_LEAN = 0.2; // radians forward, pelvis + spine, at rest
const MAX_LEAN = 0.75; // what a far reach may add
const MAX_SLIDE = 0.1; // meters forward on the seat for a reach further than that
const MAX_RISE = 0.2; // meters up off the seat, half standing, for a reach the chest would otherwise take into the table
const MAX_BEND = 2.6; // elbow / knee
const ELBOW_REST = 0.04; // the elbow joint above the table when that elbow rests on it (the arm's own thickness)
const CLEAR = 0.04; // meters every hand and forearm keeps from the body (the face and torso), past its own thickness
const REST_CLEAR = 0.012; // the same for an arm resting on the table
const REST_CURL = 0.08; // fingers resting: barely more than the avatar's own relaxed hand

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
/** 0 outside 0..1, a soft hump inside. */
const bump = (x: number) => (x > 0 && x < 1 ? Math.sin(Math.PI * x) ** 2 : 0);
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
  relaxed: [THREE.Quaternion[], THREE.Quaternion[]] = [[], []]; // each hand's 15 finger joints as the motion holds them

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
  }
}

type Kind = "wait" | "reach" | "hover" | "descend" | "grip" | "carry" | "set" | "adjust" | "release" | "lift" | "press" | "return" | "tip" | "hold" | "shake" | "offer" | "grasp";

/**
 * Your hand as the handshake reads it, world space: where its palm is, which way the palm faces, and whether it's
 * held out to shake (palm sideways, fingers straight and together, thumb and index apart: never a pinch or a grab).
 */
export interface PlayerHand {
  palm: THREE.Vector3;
  normal: THREE.Vector3;
  ok: boolean;
}
interface Held {
  c: Carry;
  fromTL: THREE.Vector3; // table-local base positions
  toTL: THREE.Vector3;
  grip: number; // the pinch point's height above the piece's base (raise included)
  raise?: number; // how much higher on it the hand ended up taking it (easePinch), already in grip
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
  back?: THREE.Vector3; // where on its head the finger is, from its axis (board-local, upright)
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
  c1: number | "idle"; // finger curl at the end (-0.3 open, 0 relaxed, 1 fist), or the idle pose's own
  pin1?: number; // pinch pose at the end (0 the avatar's own relaxed hand, 1 thumb tip on index tip, < 0 spread)
  tuck1?: number; // the other three fingers curled in, at the end (0..1)
  fist1?: number; // the hand closed round another, at the end (0..1)
  pt1?: number; // pointing pose at the end (the index straight, the rest curled: it presses the clock)
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
  prep?: () => void; // runs first when the step begins (plans heights from where everything is by then)
  clear?: boolean; // its lift is raised, when it begins, until the hand (and a piece in it) clears what it passes over
  until?: () => boolean; // wait: ends (after `after` seconds) once this is true; dur is the cap
  after?: number;
  look?: () => Look; // what the eyes are on (table-local), or the player
  onBegin?: () => void;
  t0?: number;
  from?: THREE.Vector3;
  w0?: number;
  c0?: number;
  pin0?: number;
  pt0?: number;
  tuck0?: number;
  fist0?: number;
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
  shrug: number; // shoulders raised, radians at the collars
  retract: number; // shoulders drawn back
  headPitch: number; // + tips the head forward
  look: number; // how much the head turns to what the eyes are on (1 = fully, less while the neck rolls)
}
interface IdleInst {
  kind: IdleKind;
  side: 0 | 1; // chin / cheek: the hand doing it; ready: the hand that moves
  r: number[]; // this instance's own small differences
}
const newHandIdle = (): HandIdle => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), curl: 0, pole: new THREE.Vector3(0, -1, 0), elbow: 0, head: 0 });
const newIdle = (): Idle => ({ hands: [newHandIdle(), newHandIdle()], lean: 0, twist: 0, roll: 0, neck: 0, headRoll: 0, feet: 0, shrug: 0, retract: 0, headPitch: 0, look: 1 });
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
  d.shrug = s.shrug;
  d.retract = s.retract;
  d.headPitch = s.headPitch;
  d.look = s.look;
  d.lean = s.lean;
  d.twist = s.twist;
  d.roll = s.roll;
  d.neck = s.neck;
  d.headRoll = s.headRoll;
  d.feet = s.feet;
  return d;
}

/** How a hand's fingers are held: the pinch pose's weight, the pointing pose's, and the old curl (a fist, at the face). */
interface FingerState {
  pin: number; // the pinch pose's weight for thumb and index (< 0 spreads them wider than the relaxed hand)
  pt: number;
  curl: number;
  tuck?: number; // the pinch pose's weight for the other three fingers: curled out of the way while it takes a piece
  thumb?: number; // the pinch pose's weight for the thumb alone, when it isn't pin's
  fist?: number; // the fist pose's weight: a hand closing round another
}
/** A hand in some finger state, in its wrist's rest frame (the wrist at the origin, turned as in the rest pose). */
interface HandShape {
  pts: THREE.Vector3[]; // balls along the palm and every finger, centres
  r: number[]; // and radii (measured from the avatar: body.ts)
  contact: THREE.Vector3; // between the thumb and index tips (what a pinch holds), or the index tip (pointing)
  gap: number; // thumb tip to index tip, centres
  thumb: THREE.Vector3;
  index: THREE.Vector3;
}
/** Something on the table a hand, an arm or a carried piece stays above: a piece (round), the clock (boxes). Table-local. */
interface Thing {
  obj: THREE.Object3D | null;
  x: number;
  z: number;
  hx: number; // half extents (round: its radius)
  hz: number;
  round: boolean;
  top: number;
}
const FAR_BUTTON = new THREE.Object3D(); // their clock button, among the things: a press may touch it
const HEAD_BACK = 0.3; // radians the head may tip back past the chest's forward
const HEAD_TURN = 1.0; // radians the head may turn from the chest, all told
const TIP_LET_GO = 0.55; // radians a resigning king is tipped by hand before it's let go to fall the rest of the way
const _fq = new THREE.Quaternion();
const _tl = new THREE.Vector3();
const _bq = new THREE.Quaternion();

/** One hand's state: its queue of steps and where it is asked to be. */
class Hand {
  segs: Seg[] = [];
  p = new THREE.Vector3(); // the pinch point asked for, table-local
  w = 0;
  curl = 0;
  pin = 0; // pinch pose weight
  pt = 0; // pointing pose weight
  tuck = 0; // middle, ring and pinky curled in
  fist = 0; // closed round your hand
  ease = 0; // how much wider than its step asks the pinch is held (easePinch), let go of slowly: no flicker
  contact = new THREE.Vector3(); // the hand's contact point in its wrist's rest frame, this frame (shape().contact)
  o = 0;
  beta = 0.9;
  roll = 0.35;
  held: Held | null = null;
  graspB = new THREE.Vector3(); // bundle: the contact point's target before posing, where it really is after
  world = new THREE.Vector3(); // where the pinch point really is, world
  wrist = new THREE.Vector3(); // wrist target, bundle
  q = new THREE.Quaternion(); // hand turn target, bundle
  pole = new THREE.Vector3();
  lean = 0; // the lean this hand's reach asks of the body
  twist = 0; // the torso turn it asks
  scapula = 0; // radians the collar lifts with the arm raised past level (the shoulder blade turning up with it)
  err = 0; // meters between where the pinch point was asked to be and where the arm got it, last frame
  constructor(readonly side: 0 | 1) {}
}

const OFFER = new THREE.Vector3(-0.05, 0.2, 0.06); // a handshake over the board, table-local
// the handshake at the start of a game: their hand held out across the table to yours, how long they wait, how close
// yours has to come, how far they rise off the seat for it
const GREET_AT = new THREE.Vector3(-0.03, 0.21, 0.07);
const GREET_WAIT = 4;
const MEET = 0.12;
const GREET_RISE = 0.05;

/** A soft sound as hands meet: a short, low, muffled tap (no file, synthesized). */
let audio: AudioContext | null = null;
function softTap() {
  try {
    const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AC) return;
    audio ??= new AC();
    if (audio.state !== "running") void audio.resume();
    const t = audio.currentTime;
    const len = Math.floor(audio.sampleRate * 0.09);
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.18));
    const src = audio.createBufferSource();
    src.buffer = buf;
    const lp = audio.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.18, t);
    src.connect(lp).connect(gain).connect(audio.destination);
    src.start(t);
  } catch {
    // (no audio: no sound)
  }
}
const up = (v: THREE.Vector3, h: number) => v.clone().setY(v.y + h);

export class SeatedOpponent {
  readonly chair: THREE.Group;
  /** The table, in the board's table group (it moves with the board, its handle and its anchor); legs to the floor. */
  readonly desk: THREE.Group;
  private legs: THREE.Mesh[] = [];
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
  // the handshake at the start of a game: waiting to offer, offered, shaking, or sitting back down after it
  private greet = {
    phase: "none" as "none" | "wait" | "offer" | "shake" | "back",
    delay: 0,
    at: NaN,
    lift: 0, // meters they rise off the seat to reach across
    target: new THREE.Vector3(), // table-local: where their hand goes, on yours
    lost: 0, // seconds your hand has been out of reach while they hold it
    deferred: null as null | { carries: Carry[]; onPlaced: () => void; tap?: Tap; opts: PlayOptions },
  };
  private xrHands: THREE.Object3D[] | null = null;
  private riseS = 0; // meters the hips are up off the seat (the same spring as the lean)
  private riseV = 0;
  private slideS = 0; // meters the hips have slid forward on the seat
  private slideV = 0;

  // gaze
  private gazeTL = new THREE.Vector3(0, 0.02, 0);
  private gazeB = new THREE.Vector3();
  private fix = new THREE.Vector3(0, 0.02, 0);
  private fixViewer = false;
  private fixUntil = 0;
  private lookFrom = 0;
  private lookUntil = 0;
  private notice = new THREE.Vector3();
  private noticeFrom = 0;
  private noticeUntil = 0;
  private candidates: THREE.Vector3[] = []; // squares the search is weighing, table-local
  private sweep = { x: 0, z: 0, dx: 0, dz: 0, n: 0 }; // scanning: the line of squares the eyes walk along
  private clockAt: (() => THREE.Vector3) | null = null; // their side of the clock, table-local
  private shakeAt = -1;
  private lastHead: "nod" | "shake" | null = null;

  // their real bulk (body.ts), and the poses it allows: "kind" or "kind:side", checked on this avatar at the start
  private body: BodyShape;
  private seatBack = 0;
  private pressure = 0; // 0..1: how short their clock is
  private ok = new Set<string>();
  private verified = false;
  private guardPush = 0; // this frame: how far the guard moved a hand to keep it clear of the body
  private guardResid = 0; // and how deep any hand or forearm still is inside it (0: clear)

  // the hands' own shape (finger poses), and what's on the table under them, this frame
  private shapes = new Map<string, HandShape>();
  private pinGap: [number[], number[]] = [[], []]; // thumb-to-index gap at pinch 0, 0.05, .. 1
  private things: Thing[] = [];
  private restMemo = new Map<string, { wristT: THREE.Vector3; q: THREE.Quaternion }>();
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
    avatar.pose(0, (l, _t, s) => {
      this.rig = new Rig(s);
      for (const side of [0, 1] as const) this.rig.relaxed[side] = Array.from({ length: 15 }, (_, i) => l[(side === 0 ? 25 : 40) + i]?.clone() ?? new THREE.Quaternion());
    });
    this.body = BodyShape.measure(avatar.mesh, this.rig.rest);
    // a bulkier body (a jacket, a fuller belly) sits back by the extra depth, so there's room in front of it
    this.seatBack = clamp(this.body.front - 0.167, 0, 0.12);
    this.chair = this.buildChair();
    this.desk = this.buildTable();
    table.add(this.desk);
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
    this.greetPlayer(); // a new game: it starts with a handshake
  }

  /**
   * The start of a game: once they've settled, they rise a little and hold their right hand out across the table to
   * yours. Hold yours out to it (palm sideways, fingers together) and they take it, shake two or three times while
   * looking at you, let go and sit back; leave them hanging and after 4 s they take it back with a small nod. A move
   * of theirs waits for it (play() holds it till then); a move of yours ends it. With no tracked hand (a laptop, a
   * headset without hand tracking) there's no offer: a short nod, and the game goes on at once.
   */
  greetPlayer(delay = 1.6) {
    const g = this.greet;
    g.phase = "wait";
    g.delay = delay;
    g.at = NaN; // (counted from the next frame)
    g.lift = 0;
    g.deferred = null;
  }

  /** True while the handshake at the start of a game is on (waiting, offered, shaking, or sitting back after it). */
  get greeting() {
    return this.greet.phase !== "none";
  }
  /** How far behind the board's centre this opponent's hip joints are (SEAT_DISTANCE, or more for a bulkier body). */
  get seatDistance() {
    return SEAT_DISTANCE + this.seatBack;
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
    if (this.greet.phase === "wait" || this.greet.phase === "offer") this.withdraw(); // you've started: no handshake
    const r = this.gazeRng;
    // a beat, then the eyes go to the piece you moved
    this.notice.copy(this.boardToTable(at)).setY(0.02);
    this.noticeFrom = this.now + r.range(0.25, 0.6);
    this.noticeUntil = this.noticeFrom + r.range(0.6, 1.1);
    this.lookUntil = 0;
    if (r.chance(0.3)) this.lookAtPlayer(r.range(0.8, 1.1), r.range(0.5, 0.9));
    // now and then a slow nod (fair enough) or a slight shake of the head (hm), never the same one twice running
    if (r.chance(0.35)) {
      const g: "nod" | "shake" = this.lastHead === "nod" ? "shake" : this.lastHead === "shake" ? "nod" : r.chance(0.5) ? "nod" : "shake";
      this.lastHead = g;
      if (g === "nod") this.nodAt = this.now + r.range(0.6, 1.0);
      else this.shakeAt = this.now + r.range(0.6, 1.0);
    }
  }

  /** Where their side of the clock is (table-local), for their eyes to go to it now and then. */
  setClock(at: () => THREE.Vector3) {
    this.clockAt = at;
  }

  /**
   * Move pieces by hand: a captured piece goes beside the board first, then the piece (and a castling rook). onPlaced
   * runs when the last one is put down for good: the move is on the board from then on. Then, if given, the same
   * hand presses their side of the clock, they look up at you, and the hand goes back.
   */
  play(carries: Carry[], onPlaced: () => void, tap?: Tap, opts: PlayOptions = {}) {
    if (this.greeting) {
      this.greet.deferred = { carries, onPlaced, tap, opts }; // after the handshake
      return;
    }
    this.drop();
    this.onPlaced = onPlaced;
    this.pending = carries.length;
    this.moving = true;
    this.over = false;
    const rng = new Rng(hashSeed(this.seed, "move", this.moveCount++));
    const hard = clamp(opts.hardness ?? 0.3, 0, 1);
    const picked = pickStyle(rng, this.lastStyle, hard);
    const st = { ...picked, speed: picked.speed * (1 + 0.35 * clamp(opts.pressure ?? this.pressure, 0, 1)) }; // a short clock hurries the hand
    this.lastStyle = st.id;
    this.styleLean = st.lean;
    const victim = carries.find((c) => c.role === "victim") ?? null;
    const main = carries.find((c) => c !== victim) ?? carries[0];
    const others = carries.filter((c) => c !== victim && c !== main);
    const side = this.chooseHand(rng, this.boardToTable(main.from), this.boardToTable(main.to));
    this.mainSide = side;
    this.enterMove(rng, side);
    const hes = pickHesitation(rng, this.lastHes, hard);
    this.lastHes = hes;
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
    this.carrySegs(plan[side], side, at, main, rng, st, { hes, adjust });
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
    this.greet.phase = "none";
    this.greet.lift = 0;
    this.greet.deferred = null;
    this.onPlaced = null;
    this.pending = 0;
    this.moving = false;
    this.over = true;
    this.mainSide = 1;
    const rng = new Rng(hashSeed(this.seed, "end", this.moveCount));
    const right: Seg[] = [];
    if (tip) {
      // a king on their left goes over under the left hand; the right one still offers the handshake
      const ts: 0 | 1 = this.boardToTable(tip.base).x > 0.1 ? 0 : 1;
      // over it goes the way asked if there's room for it there, else whichever way there is: never onto a piece
      const fall = this.roomyFall(tip.base, tip.fall, tip.height, tip.obj);
      const fr = this.body.finger[ts];
      // they push it over with the index fingertip on the far side of its head, and it falls away from the finger
      const t: Tip = { obj: tip.obj, base: tip.base.clone(), pivot: tip.base.clone().addScaledVector(fall, 0.0175), axis: new THREE.Vector3(0, 1, 0).cross(fall).normalize(), grip: (tip.height - 0.014) * 0.9, angle: 0, back: fall.clone().multiplyScalar(-(HEAD_R.k + fr + 0.006)) };
      const top = () => this.tipGrip(t);
      const look = () => up(this.boardToTable(t.base), 0.03);
      if (tip.shadow) tip.shadow.visible = false;
      let tipped = false;
      const pointSt: FingerState = { pin: 0, pt: 1, curl: 0 };
      const above = new THREE.Vector3();
      const prep = () => {
        const g = top();
        above.copy(g).setY(Math.max(g.y + 0.03, this.floor(ts, pointSt, this.reachTurnT(ts, g, 1.0, 0.2), g.x, g.z, new Set([tip.obj]))));
      };
      const segs: Seg[] = [
        { kind: "reach", dur: rng.range(0.6, 0.85), end: () => above, w1: 1, c1: 0, pt1: 1, lift: 0.03, beta: 1.0, roll: 0.2, look, prep, clear: true, settle: true },
        { kind: "descend", dur: 0.22, end: top, w1: 1, c1: 0, pt1: 1, skew: -0.2, look },
        { kind: "grip", dur: 0.12, end: top, w1: 1, c1: 0, pt1: 1, hold: false, look },
        { kind: "tip", dur: rng.range(0.65, 0.9), end: top, tip: t, w1: 1, c1: 0, pt1: 1, look },
        { kind: "release", dur: 0.2, end: () => this.letGo(t), w1: 1, c1: 0, pt1: 1, look, onBegin: () => ((tipped = true), tip.onTipped?.()) },
        { kind: "lift", dur: 0.3, end: () => up(this.letGo(t), 0.02), w1: 1, c1: 0, pt1: 0.6, skew: 0.1, look },
      ];
      if (ts === 0) {
        this.hands[0].segs = [...segs, this.returnSeg(0, this.letGo(t))];
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

  /** Which way a tipped piece falls (board-local, unit): the way asked if there's room, else the first of the others with room. */
  private roomyFall(base: THREE.Vector3, want: THREE.Vector3, height: number, obj: THREE.Object3D) {
    const f = want.clone().setY(0).normalize();
    const a = this.boardToTable(base);
    for (const d of [f, f.clone().negate(), new THREE.Vector3(-f.z, 0, f.x), new THREE.Vector3(f.z, 0, -f.x)]) {
      const b = this.boardToTable(base.clone().addScaledVector(d, height + 0.012));
      const free = this.things.every((t) => {
        if (t.obj === obj || !t.round) return true;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const u = clamp(((t.x - a.x) * dx + (t.z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
        return Math.hypot(t.x - a.x - u * dx, t.z - a.z - u * dz) > t.hx + PIECE_R + 0.003;
      });
      if (free) return d;
    }
    return f;
  }

  /** Their hand met the player's: a few small shakes, then back to rest. */
  /** A slight shake of the head (hm, no), on top of whatever they're doing. */
  headShake() {
    this.shakeAt = this.now;
  }

  /**
   * Their hand met yours at the end of a game (they were offering it): a few small shakes, then back to rest. When
   * they aren't offering their hand, a slight shake of the head instead (as headShake()).
   */
  shake() {
    if (!this.offering) return this.headShake();
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
    this.greet.phase = "none";
    this.greet.lift = 0;
    this.greet.deferred = null;
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
    this.desk.removeFromParent();
    for (const g of [this.chair, this.desk]) g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.chairMats.forEach((m) => m.dispose());
    (this.chairMats.find((m) => m.map)?.map as THREE.Texture | undefined)?.dispose();
  }

  /**
   * Once per frame, after the opponent's group is placed. viewer: the player's head in world space. watch: a piece
   * the player is holding, world space (their eyes follow it).
   */
  /** ctx.hand: your hand for the handshake (world space); leave it out and it's read from the headset's tracked hands. */
  update(timeMs: number, ctx: { thinking: boolean; viewer: THREE.Vector3 | null; watch?: THREE.Vector3 | null; pressure?: number; hand?: PlayerHand | null }) {
    const now = timeMs / 1000;
    const first = !this.last;
    const dt = first ? 0 : clamp(now - this.last, 0, 0.1);
    this.now = now;
    this.last = now;
    this.thinking = ctx.thinking;
    this.pressure = clamp(ctx.pressure ?? 0, 0, 1);

    this.table.updateWorldMatrix(true, true);
    // the table's legs reach the floor wherever the board is (on the floor, y = 0 in world)
    const under = this.table.localToWorld(_tl.set(0, TABLE_TOP - TABLE_THICK, 0)).y;
    for (const leg of this.legs) leg.scale.y = Math.max(0.01, under);
    this.avatar.mesh.updateWorldMatrix(true, false);
    this.toBundle.copy(this.avatar.mesh.matrixWorld).invert().multiply(this.table.matrixWorld);
    this.fromBundle.copy(this.toBundle).invert();
    this.qToBundle.setFromRotationMatrix(this.toBundle);
    this.seat.set(0, SEAT_HEIGHT + this.rig.hipAbove, 0);

    if (first) {
      if (!this.verified) this.verifyPoses();
      this.switchAt = now + this.idleRng.range(1.5, 3.5);
      this.step(0, ctx, true); // puts the body somewhere first: poses that follow it (a chin, a chest) need it
    }
    this.step(dt, ctx, false);
  }

  private step(dt: number, ctx: { viewer: THREE.Vector3 | null; watch?: THREE.Vector3 | null; hand?: PlayerHand | null }, first: boolean) {
    const now = this.now;
    this.dt = dt;
    this.gather();
    this.greetStep(ctx);
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
    // (only near the middle does the other hand come into it: nobody reaches across their body to a far corner)
    const x = 0.75 * from.x + 0.25 * to.x;
    let pLeft = 0.03 + 0.94 / (1 + Math.exp(-(x - 0.04) / 0.035));
    const k = this.idleInst;
    if ((k.kind === "chin" || k.kind === "cheek") && !this.idleFrom) pLeft += k.side === 1 ? 0.2 : -0.2; // the hand under the chin tends to stay
    if (x < -0.09) return 1; // the outer files on their right: always the right hand
    if (x > 0.13) return 0;
    return rng.chance(clamp(pLeft, 0.05, 0.95)) ? 0 : 1;
  }

  /** A move starts: the free hand stays where it rests (or under the chin, if it was there). */
  private enterMove(rng: Rng, side: 0 | 1) {
    const cur = this.idleInst;
    if ((cur.kind === "chin" || cur.kind === "cheek") && cur.side !== side && rng.chance(0.6)) return;
    this.startIdle(this.newInst("ready", rng, side), this.now);
  }

  private scheduleIdle(now: number) {
    if (this.mode === "move" || now < this.switchAt) return;
    const r = this.idleRng;
    const kind = pickIdle(r, this.mode, this.lastFamily, (k) => this.allows(k));
    this.startIdle(this.newInst(kind, r), now);
    this.switchAt = now + this.idleDur + holdSeconds(r, this.mode, kind, this.pressure);
  }

  /** Whether this avatar's body allows a pose (on either side, or that side). */
  private allows(kind: IdleKind, side?: 0 | 1) {
    if (!SIDED.includes(kind)) return this.ok.has(kind);
    return side === undefined ? this.ok.has(`${kind}:0`) || this.ok.has(`${kind}:1`) : this.ok.has(`${kind}:${side}`);
  }

  private newInst(kind: IdleKind, rng: Rng, side?: 0 | 1): IdleInst {
    let s: 0 | 1 = side ?? (rng.chance(0.5) ? 0 : 1);
    if (side === undefined && SIDED.includes(kind) && this.verified && !this.allows(kind, s)) s = (1 - s) as 0 | 1;
    return { kind, side: s, r: Array.from({ length: 6 }, () => rng.next()) };
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
    out.shrug = lerp(from.shrug, live.shrug, e);
    out.retract = lerp(from.retract, live.retract, e);
    out.headPitch = lerp(from.headPitch, live.headPitch, e);
    out.look = lerp(from.look, live.look, e);
    for (const s of [0, 1]) {
      const eh = smoother(clamp((b - this.idleDelay[s]) / 0.78, 0, 1));
      const A = from.hands[s];
      const B = live.hands[s];
      const O = out.hands[s];
      const arc = Math.min(0.06, 0.3 * A.p.distanceTo(B.p)) * Math.sin(Math.PI * eh);
      O.p.lerpVectors(A.p, B.p, eh);
      O.p.y += arc * 0.75;
      O.p.x += (s === 0 ? 1 : -1) * arc * 0.35; // up, and out to that hand's side: never in toward the body
      O.q.slerpQuaternions(A.q, B.q, eh);
      O.curl = lerp(A.curl, B.curl, eh);
      O.pole.lerpVectors(A.pole, B.pole, eh).normalize();
      O.elbow = lerp(A.elbow, B.elbow, eh);
      O.head = lerp(A.head, B.head, eh);
    }
  }

  // ---------------- idle poses ----------------

  private evalIdle(inst: IdleInst, out: Idle, tp = this.now - this.idleT0) {
    const r = inst.r;
    const j = (i: number, a: number) => (r[i] - 0.5) * 2 * a; // +-a
    out.lean = 0;
    out.twist = j(4, 0.03);
    out.roll = j(5, 0.02);
    out.neck = 0;
    out.headRoll = j(3, 0.03);
    out.feet = 0;
    out.shrug = 0;
    out.retract = 0;
    out.headPitch = 0;
    out.look = 1;
    const s = inst.side;
    const o = (1 - s) as 0 | 1;
    const sg = s === 1 ? 1 : -1; // + toward the person's right
    const still = () => {
      this.lowHand(0, out.hands[0]);
      this.lowHand(1, out.hands[1]);
    };
    switch (inst.kind) {
      case "still": // concentration: breathing and the eyes; the head steady
        still();
        out.lean = 0.06 + j(0, 0.03);
        out.neck = 0.08;
        out.look = 0.55;
        break;
      case "rest":
        still();
        out.lean = j(0, 0.05);
        break;
      case "scan": // leaning in a little; the eyes walk the board (nextFixation)
        still();
        out.lean = 0.1 + j(0, 0.04);
        out.neck = 0.06;
        out.look = 0.9;
        break;
      case "leanIn":
        still();
        out.lean = 0.18 + 0.1 * r[0];
        out.neck = 0.1;
        out.look = 0.8;
        break;
      case "leanBack":
        still();
        out.lean = -0.22 + j(0, 0.05);
        out.neck = 0.12;
        out.feet = 0.06;
        break;
      case "shift": {
        // weight onto one hip; the shoulders rise and come down a touch lower than before
        still();
        out.roll = sg * (0.03 + 0.03 * r[0]);
        out.twist = -sg * (0.015 + 0.02 * r[1]);
        out.headRoll = -sg * 0.02;
        out.shrug = (0.04 + 0.04 * r[2]) * bump((tp - 0.2) / 1.2) - 0.012 * smooth(clamp((tp - 1.4) / 0.6, 0, 1));
        out.lean = j(0, 0.04);
        break;
      }
      case "breath": {
        // a deeper breath: sitting up a little as the shoulders rise, then letting go
        still();
        const k = bump((tp - 0.1) / (2 + 0.6 * r[0]));
        out.shrug = (0.035 + 0.025 * r[1]) * k - 0.01 * smooth(clamp((tp - 1.6) / 0.8, 0, 1));
        out.lean = j(0, 0.03) - 0.05 * k;
        out.headPitch = -0.03 * k;
        break;
      }
      case "neckRoll": {
        // one slow, small circle of the head; the eyes let go meanwhile
        still();
        const k = smoother(clamp((tp - 0.3) / 2.6, 0, 1));
        const ph = 2 * Math.PI * k;
        const a = 0.08 + 0.05 * r[0];
        out.headRoll = sg * a * Math.sin(ph);
        out.headPitch = a * 0.6 * (1 - Math.cos(ph));
        out.look = 1 - 0.8 * Math.sin(Math.PI * k);
        break;
      }
      case "shoulderRoll": {
        // the shoulders go up, back and down, once or twice
        still();
        const k = clamp((tp - 0.25) / 1.6, 0, 1);
        const ph = 2 * Math.PI * (r[0] < 0.5 ? 1 : 2) * k;
        out.shrug = (0.04 + 0.025 * r[1]) * (1 - Math.cos(ph)) / 2;
        out.retract = 0.05 * Math.sin(ph) * Math.sin(Math.PI * k);
        break;
      }
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
      case "ready":
        still();
        out.lean = 0.04;
        break;
    }
  }

  /** Bundle space, from last frame's pose: a point fixed to joint j (rest-space offset). */
  private bodyPoint(j: number, off: THREE.Vector3) {
    return off.clone().applyQuaternion(this.G[j]).add(this.P[j]);
  }

  /** A hand pose given by its wrist (bundle), turn and curl: its contact point, table-local. */
  private fromWrist(side: 0 | 1, wristB: THREE.Vector3, out: HandIdle) {
    out.p.copy(this.shape(side, { pin: 0, pt: 0, curl: out.curl }).contact).applyQuaternion(out.q).add(wristB).applyMatrix4(this.fromBundle);
  }

  private defaultPole(side: 0 | 1, out: THREE.Vector3) {
    return out.copy(DOWN).addScaledVector(OUT[side], 0.95).addScaledVector(BACK, 0.3).normalize();
  }

  /** Resting on the table in front of them, a little differently each time (a, b: 0..1). inward: meters nearer the middle. */
  private restHand(side: 0 | 1, out: HandIdle, a: number, b: number, inward = 0) {
    this.tableHand(side, out, REST_CURL + 0.05 * b, 0.72 + (a - 0.5) * 0.2, 0.05 + 0.03 * (1 - a) - inward * 0.5, 0.02 + 0.02 * b);
    this.restPole(side, out.pole);
    out.elbow = 0;
    out.head = 0;
  }

  /**
   * Where the hands rest whatever the body is doing: on the table between the board and its edge, either side,
   * fingers in toward the middle, never over the pieces. The same place in every idle pose, so leaning in or back moves
   * the body, not the hands.
   */
  private lowHand(side: 0 | 1, out: HandIdle) {
    // leaning far in for a piece, the chest comes over the table: the hands slide out to the sides, out of its way
    this.tableHand(side, out, REST_CURL, 0.72, 0.05, 0.02, 0.17 * smooth(clamp((this.leanS - 0.2) / 0.45, 0, 1)));
    this.restPole(side, out.pole);
    out.elbow = 0;
    out.head = 0;
  }

  /** A resting arm's elbow: out from the body and back, past the table's edge, where it hangs at the side. */
  private restPole(side: 0 | 1, out: THREE.Vector3) {
    return out.copy(OUT[side]).multiplyScalar(1.1).addScaledVector(DOWN, 0.5).addScaledVector(BACK, 0.5).normalize();
  }

  /** A loose fist under the chin, that elbow down on the table. */
  private chinHand(side: 0 | 1, out: HandIdle, a: number) {
    // under the chin, not in it: a head built from photos (hair, a fuller jaw) sits further out than SMPL-X's
    const g = this.bodyPoint(HEAD, this.rig.chinOff).addScaledVector(DOWN, 0.05).addScaledVector(FWD, 0.045).addScaledVector(IN[side], (a - 0.5) * 0.02);
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
    const wrist = this.bodyPoint(HEAD, this.rig.cheekOff[side]).addScaledVector(dir, -0.07).addScaledVector(OUT[side], 0.05).addScaledVector(FWD, 0.03 + 0.01 * a);
    out.curl = 0.15 + 0.15 * a;
    this.fromWrist(side, wrist, out);
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
      h.curl = 0.62;
      this.fromWrist(side, wrist, h);
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
      h.curl = front ? 0.35 : 0.45;
      this.fromWrist(side, wrist, h);
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
      h.curl = top ? 0.4 : 0.55;
      this.fromWrist(side, wrist, h);
      h.pole.copy(ub).negate().addScaledVector(OUT[side], 0.9).addScaledVector(fb, 0.25).normalize();
      h.elbow = 0;
      h.head = 0;
    }
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

  private carrySegs(list: Seg[], side: 0 | 1, at: THREE.Vector3[], c: Carry, rng: Rng, st: Style, opt: { quick?: boolean; hes?: Hesitation | null; adjust?: boolean; onLift?: () => void }) {
    const sp = st.speed * rng.range(0.9, 1.1) * (opt.quick ? 1.1 : 1);
    // taken by the top of its head (fingers lower down on it would curl over its top and into it)
    const k: Held = { c, fromTL: this.boardToTable(c.from), toTL: this.boardToTable(c.to), grip: clamp(c.height * rng.range(0.86, 0.92), 0.034, 0.08), offset: new THREE.Vector3(), decay: 1, landed: false, setAt: null, yaw: 0, spin: rng.range(-0.12, 0.12), yawNow: 0 };
    const hover = st.hover * rng.range(0.85, 1.25) + (opt.hes === "hover" ? rng.range(0.012, 0.025) : 0);
    const bowSide = side === 0 ? 1 : -1;
    const aim = { beta: st.beta + rng.range(-0.08, 0.08), roll: st.roll + rng.range(-0.08, 0.08) };
    // thumb and index take the piece by its head from either side, a little wider open on the way in and out; the
    // other three fingers curl out of the way
    const type = ((c.obj.userData?.type as string) ?? "p") as PieceType;
    const head = HEAD_R[type] ?? 0.011;
    const fr = this.body.finger[side];
    // to start with: by its head's width; once the hand's turn is known, fitted to the piece's real shape (pinchFit)
    let pinHold = this.pinFor(side, 2 * (head + fr));
    let pinOpen = this.pinFor(side, 2 * (head + fr) + 0.024);
    const holdSt: FingerState = { pin: pinHold, pt: 0, curl: 0, tuck: 1 };
    const openSt: FingerState = { pin: pinOpen, pt: 0, curl: 0, tuck: 1 };
    const fit = (q: THREE.Quaternion) => {
      const f = this.pinchFit(side, type, c.height, q, k.grip);
      if (!f) return;
      k.grip = f.grip;
      pinHold = holdSt.pin = f.pin;
      pinOpen = openSt.pin = this.pinFor(side, this.shape(side, holdSt).gap + 0.024);
      for (const s of segs) {
        if (s.pin1 === undefined || s.pt1) continue;
        s.pin1 = s.kind === "grip" || s.kind === "carry" ? pinHold : s.kind === "adjust" ? pinHold - 0.08 : s.kind === "set" || (s.kind === "hover" && s !== segs[1]) ? (pinHold + pinOpen) / 2 : s.kind === "lift" ? pinOpen * 0.6 : pinOpen;
      }
    };
    const lookFrom = () => up(k.fromTL, 0.02);
    const lookTo = () => up(k.toTL, 0.02);
    const offUp = rng.range(0.01, 0.025);
    const offBack = rng.range(0.005, 0.02);
    if (opt.adjust) {
      // set down a few millimetres off and a little turned, then straightened with the fingertips
      const a = rng.range(0, 2 * Math.PI);
      const off = rng.range(0.003, 0.006);
      k.setAt = c.to.clone().add(new THREE.Vector3(Math.cos(a) * off, 0, Math.sin(a) * off));
      k.yaw = rng.range(0.06, 0.14) * rng.sign();
    }
    // the heights, worked out when the hand sets off (by then an earlier piece of the same move is where it went):
    // as high on the piece as the hand needs to keep off the pieces beside it, here and where it goes (past that, the
    // fingers come down more steeply); above it high enough that the open hand clears its head and its neighbours, so it
    // comes straight down onto it; and, once it's let go, straight up until the hand clears it again
    const P = { above: new THREE.Vector3(), pinch: new THREE.Vector3(), dest: new THREE.Vector3(), final: new THREE.Vector3(), off: new THREE.Vector3(), ok: false };
    const segs: Seg[] = [];
    // turn: the hand's real turn once it's there (a wrist only turns so far), else the one it's asked for
    const heights = (turn: THREE.Quaternion | null) => {
      const from = k.fromTL;
      const to = k.toTL;
      const destTL = k.setAt ? this.boardToTable(k.setAt) : to;
      const skip = new Set<THREE.Object3D | null>([c.obj]);
      const q = (p: THREE.Vector3) => turn ?? this.reachTurnT(side, p, aim.beta, aim.roll);
      if (turn) {
        fit(turn);
        let need = -Infinity;
        for (const fs of [holdSt, openSt]) need = Math.max(need, this.floor(side, fs, turn, from.x, from.z, skip, 0.004) - from.y);
        // and the forearm, coming down with the hand (all of it at the wrist, none at the elbow), off the pieces
        const drop = P.above.y - (from.y + k.grip);
        const [el, wr] = side === 0 ? [L_ELBOW, L_WRIST] : [R_ELBOW, R_WRIST];
        const e = this.P[el].clone().applyMatrix4(this.fromBundle);
        const w = this.P[wr].clone().applyMatrix4(this.fromBundle);
        const pt = new THREE.Vector3();
        for (const u of [0.6, 0.75, 0.9, 1]) {
          const r = lerp(this.body.arm[side], this.body.cuff[side], u);
          pt.lerpVectors(e, w, u);
          const under = this.ground(pt.x, pt.z, r, skip) + r + 0.004 - (pt.y - drop * u);
          if (under > 0) need = Math.max(need, k.grip + under / u);
        }
        if (need > k.grip) k.grip = Math.min(need, c.height * 0.95);
      }
      P.pinch.copy(up(from, k.grip));
      if (!turn) P.above.copy(up(from, Math.max(k.grip + hover, this.floor(side, openSt, q(P.pinch), from.x, from.z) - from.y)));
      P.dest.copy(up(destTL, k.grip));
      P.final.copy(up(to, k.grip));
      const placed: Thing = { obj: null, x: to.x, z: to.z, hx: PIECE_R, hz: 0, round: true, top: to.y + c.height };
      const offY = Math.max(k.grip + offUp, this.floor(side, openSt, q(P.final), to.x, to.z, skip, GAP, [placed]) - to.y);
      P.off.copy(up(to, offY));
      P.off.z -= offBack;
    };
    const plan = () => {
      if (P.ok) return P;
      P.ok = true;
      const from = k.fromTL;
      const to = k.toTL;
      const destTL = k.setAt ? this.boardToTable(k.setAt) : to;
      const skip = new Set<THREE.Object3D | null>([c.obj]);
      const rollJitter = rng.range(-0.04, 0.04);
      fit(this.reachTurnT(side, up(from, k.grip), aim.beta, aim.roll)); // (once here; again once the hand is there)
      for (let i = 0; i < 6; i++) {
        aim.roll = this.levelRoll(side, holdSt, up(from, k.grip), aim.beta, aim.roll) + rollJitter;
        let need = -Infinity;
        for (const p of [from, destTL])
          for (const fs of [holdSt, openSt]) need = Math.max(need, this.floor(side, fs, this.reachTurnT(side, up(p, k.grip), aim.beta, aim.roll), p.x, p.z, skip, 0.004) - p.y);
        if (need <= k.grip) break;
        if (need <= c.height * 0.92) {
          k.grip = need;
          break;
        }
        k.grip = c.height * 0.92;
        aim.beta = Math.min(1.35, aim.beta + 0.12);
      }
      heights(null);
      for (const s of segs) {
        if (s.beta !== undefined) s.beta = aim.beta;
        if (s.roll !== undefined) s.roll = aim.roll;
        if (s.kind === "descend") s.dur = ((0.1 + 1.6 * (P.above.y - P.pinch.y)) / sp) * rng.range(0.9, 1.1);
      }
      return P;
    };
    const reachDur = (a: THREE.Vector3, b: THREE.Vector3) => ((0.28 + 0.5 * a.distanceTo(b) + this.farTime(side, b)) / sp) * rng.range(0.92, 1.1);
    const bow = (a: THREE.Vector3, b: THREE.Vector3) => clamp(rng.range(0.06, 0.13) * st.bow * Math.hypot(b.x - a.x, b.z - a.z), 0, 0.05) * (rng.chance(0.2) ? -0.6 : 1);
    const cur = at[side].clone();
    const roughAbove = up(k.fromTL, k.grip + hover);
    segs.push({
      kind: "reach", dur: reachDur(cur, roughAbove), end: () => plan().above, k, w1: 1, c1: 0, pin1: pinOpen, tuck1: 1, lift: rng.range(0.015, 0.04), bow: bow(cur, roughAbove), bowSide,
      skew: st.skew + rng.range(-0.08, 0.08), ...aim, look: lookFrom, settle: true, prep: plan, clear: true,
    });
    // a second thought: the hand stops a moment just above the piece before coming down
    if (opt.hes === "hover") segs.push({ kind: "hover", dur: rng.range(0.35, 0.7), end: () => P.above, k, w1: 1, c1: 0, pin1: pinOpen, tuck1: 1, drift: 0.003, look: lookFrom });
    segs.push(
      { kind: "descend", dur: (0.1 + 1.6 * hover) / sp, end: () => up(P.pinch, k.raise ?? 0), k, w1: 1, c1: 0, pin1: pinOpen, tuck1: 1, skew: -0.2, look: lookFrom, prep: () => heights(this.hands[side].q), settle: true },
      { kind: "grip", dur: rng.range(0.07, 0.11), end: () => up(P.pinch, k.raise ?? 0), k, w1: 1, c1: 0, pin1: pinHold, tuck1: 1, look: lookFrom },
    );
    // the carry: lifted (a knight hops higher), carried on a slight arc, set down softly; never lower than it takes
    // to clear what's on the way (begin() raises it)
    const d = Math.hypot(k.toTL.x - k.fromTL.x, k.toTL.z - k.fromTL.z);
    const knight = c.obj.userData?.type === "n";
    const lift = (knight ? Math.max(0.05, 0.03 + 0.2 * d) : Math.min(0.07, 0.018 + 0.22 * d)) * st.lift * rng.range(0.85, 1.15);
    segs.push({
      kind: "carry", dur: ((0.26 + 0.6 * d) / sp) * rng.range(0.9, 1.12), end: () => up(P.dest, k.raise ?? 0), k, w1: 1, c1: 0, pin1: pinHold, tuck1: 1, lift,
      bow: clamp(rng.range(0.03, 0.08) * d * st.bow, 0, 0.025) * (rng.chance(0.3) ? -1 : 1), bowSide,
      skew: st.skew * 0.6 + rng.range(-0.05, 0.05), over: st.overshoot * rng.range(0.6, 1.2), look: lookTo, onBegin: opt.onLift, clear: true,
      settle: true, // (it's set down where the hand really is: so the hand has to be there)
    });
    if (opt.adjust)
      segs.push(
        { kind: "set", dur: rng.range(0.07, 0.1), end: () => up(P.dest, (k.raise ?? 0) + 0.008), k, w1: 1, c1: 0, pin1: (pinHold + pinOpen) / 2, tuck1: 1, look: lookTo },
        { kind: "hover", dur: rng.range(0.12, 0.3), end: () => up(P.dest, (k.raise ?? 0) + 0.008), k, w1: 1, c1: 0, pin1: (pinHold + pinOpen) / 2, tuck1: 1, look: lookTo },
        { kind: "grip", dur: 0.08, end: () => up(P.dest, k.raise ?? 0), k, w1: 1, c1: 0, pin1: pinHold, tuck1: 1, hold: false, look: lookTo },
        { kind: "adjust", dur: rng.range(0.22, 0.38), end: () => up(P.final, k.raise ?? 0), k, w1: 1, c1: 0, pin1: pinHold - 0.08, tuck1: 1, look: lookTo },
      );
    segs.push(
      // the fingers open as the hand lifts off it a little: opening alone would sweep the index tip through its head
      { kind: "release", dur: rng.range(0.07, 0.11), end: () => up(P.final, (k.raise ?? 0) + 0.01), k, w1: 1, c1: 0, pin1: pinOpen, tuck1: 1, places: true, look: lookTo },
      // straight up off it, the fingers opening, until the hand is clear of it
      {
        kind: "lift", dur: st.settle * rng.range(0.8, 1.25) + 0.08, end: () => P.off, w1: 1, c1: 0, pin1: pinOpen * 0.6, tuck1: 1, skew: 0.1, look: lookTo,
        prep: () => P.off.setY(Math.max(P.off.y, this.floor(side, openSt, this.hands[side].q, k.toTL.x, k.toTL.z))),
      },
    );
    list.push(...segs);
    at[side] = up(k.toTL, k.grip + 0.04); // roughly where it ends (the next step starts from wherever it really is)
  }

  /** The clock, with the hand that moved: over to the button, a press with the index finger, and a look up at the player. */
  private tapSegs(list: Seg[], side: 0 | 1, at: THREE.Vector3[], tap: Tap, rng: Rng, st: Style) {
    const sp = st.speed * rng.range(0.92, 1.15);
    const hov = rng.range(0.018, 0.032);
    const look = rng.chance(0.55) ? () => up(tap.at(), 0) : undefined; // otherwise their eyes stay on the move
    const pressSt: FingerState = { pin: 0, pt: 1, curl: 0 };
    const fr = this.body.finger[side];
    const aim = { beta: rng.range(0.55, 0.8), roll: st.roll * 0.6 };
    // the index pad pushes the button down most of its travel (6.5 mm); the rest of the hand stays off the clock (the
    // fingers come down more steeply if they'd touch it), and it comes down onto the button from straight above
    const P = { above: new THREE.Vector3(), pressed: new THREE.Vector3(), ok: false };
    const segs: Seg[] = [];
    const plan = () => {
      if (P.ok) return P;
      P.ok = true;
      const b = tap.at();
      P.pressed.copy(b).setY(b.y - 0.0055 + fr);
      const skip = new Set<THREE.Object3D | null>([FAR_BUTTON]);
      for (let i = 0; i < 5; i++) {
        if (this.floor(side, pressSt, this.reachTurnT(side, P.pressed, aim.beta, aim.roll), b.x, b.z, skip, 0.006) <= P.pressed.y) break;
        aim.beta = Math.min(1.3, aim.beta + 0.12);
      }
      P.above.copy(b).setY(Math.max(b.y + fr + hov, this.floor(side, pressSt, this.reachTurnT(side, P.pressed, aim.beta, aim.roll), b.x, b.z)));
      for (const s of segs) if (s.beta !== undefined) s.beta = aim.beta;
      return P;
    };
    const start = at[side];
    const d = start.distanceTo(tap.at());
    segs.push(
      { kind: "reach", settle: true, dur: ((0.28 + 0.45 * d + this.farTime(side, tap.at())) / sp) * rng.range(0.9, 1.1), end: () => plan().above, w1: 1, c1: 0, pin1: 0, pt1: 1, lift: rng.range(0.02, 0.04), bow: clamp(rng.range(0.04, 0.1) * st.bow * d, 0, 0.04), bowSide: side === 0 ? 1 : -1, skew: st.skew, beta: aim.beta, roll: aim.roll, look, prep: plan, clear: true },
      { kind: "press", dur: (rng.range(0.07, 0.11) + 1.2 * hov) / sp, end: () => P.pressed, w1: 1, c1: 0, pt1: 1, skew: 0.3, look },
      {
        kind: "press", dur: rng.range(0.1, 0.15), end: () => P.above, w1: 1, c1: 0, pt1: 1,
        onBegin: () => {
          tap.onTap();
          this.lookAtPlayer(rng.range(0.1, 0.35), rng.range(0.9, 1.8));
        },
      },
    );
    list.push(...segs);
    at[side] = up(tap.at(), hov + fr);
  }

  /** Extra seconds for a target past the arm's easy reach (table-local): the lean takes time. */
  private farTime(side: 0 | 1, at: THREE.Vector3) {
    const d = Math.hypot(at.x - (side === 0 ? 0.17 : -0.17), at.z + this.seatDistance - 0.1); // from roughly that shoulder
    return 1.4 * Math.max(0, d - 0.5);
  }

  private returnSeg(side: 0 | 1, from: THREE.Vector3, rng?: Rng, dur?: number): Seg {
    const d = from.distanceTo(this.idleOut.hands[side].p);
    return { kind: "return", dur: dur ?? (0.32 + 0.4 * d + 0.6 * this.farTime(side, from)) * (rng ? rng.range(0.9, 1.15) : 1), end: () => this.idleOut.hands[side].p, w1: 0, c1: "idle", o1: 0, lift: 0.03, skew: 0.1, clear: true };
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
    h.pin = 0;
    h.pt = 0;
    h.tuck = 0;
    h.fist = 0;
  }

  private begin(h: Hand, s: Seg, now: number) {
    if (s.t0 === undefined) s.t0 = now;
    s.prep?.();
    s.from = h.p.clone();
    s.w0 = h.w;
    s.c0 = h.curl;
    s.pin0 = h.pin;
    s.pt0 = h.pt;
    s.tuck0 = h.tuck;
    s.fist0 = h.fist;
    s.o0 = h.o;
    s.b0 = h.beta;
    s.r0 = h.roll;
    if (s.clear) s.lift = Math.max(s.lift ?? 0, this.pathLift(h, s));
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
          this.noticeFrom = now;
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
        h.pin = s.pin0! * (1 - kk);
        h.pt = s.pt0! * (1 - kk);
        h.tuck = s.tuck0! * (1 - kk);
        h.fist = s.fist0! * (1 - kk);
        h.o = s.o0! * (1 - kk);
        return;
      }
      case "carry": {
        // lift first, travel, and come down softly: height 6.75 u (1 - u)^2 peaks a third of the way
        this.pathAt(s, a, b, u, p);
        p.y += (s.lift ?? 0) * this.hump(s, u);
        if (s.k) {
          s.k.decay = 0; // (it went into the fingers as they closed)
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
        // closing on it: if the hand is a little off, the fingers draw the piece in, so it's in them for the carry
        if (s.k && h.held === s.k) s.k.decay = 1 - smooth(u);
        p.copy(b);
        break;
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
        // over it goes, about the edge of its base: the fingers ride its head down most of the way, then let it go and
        // it falls the rest by itself (fingers pressed onto a piece lying on the board would be in it, or in the board)
        const t = s.tip!;
        t.angle = (Math.PI / 2 + 0.08) * (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
        const q = new THREE.Quaternion().setFromAxisAngle(t.axis, t.angle);
        t.obj.quaternion.copy(q);
        t.obj.position.copy(t.base).sub(t.pivot).applyQuaternion(q).add(t.pivot);
        p.copy(this.letGo(t)).y -= 0.035 * (1 - smooth(clamp((t.angle - TIP_LET_GO) / 0.6, 0, 1)));
        break;
      }
      case "hold":
      case "offer":
        p.copy(b);
        p.y += 0.004 * Math.sin(this.now * 2.1); // a held-out hand is never quite still
        break;
      case "grasp":
        // holding your hand: it goes where yours goes, two or three small shakes of its own on top
        p.copy(this.greet.target);
        p.y += 0.016 * Math.sin(2 * Math.PI * 2.5 * u) * Math.sin(Math.PI * clamp(u * 1.15, 0, 1));
        break;
      case "shake":
        p.copy(b);
        p.y += 0.028 * Math.sin(2 * Math.PI * 3 * u) * Math.sin(Math.PI * u);
        break;
      default: // reach, lift, return: an eased path that bows a little, never a straight line, and rises early and
        // comes down late (in time, not distance), so it goes up, over and down onto what it's going to
        this.pathAt(s, a, b, u, p);
        p.y += (s.lift ?? 0) * this.hump(s, u);
    }
    const m = smooth(u);
    h.w = s.w0! + (s.w1 - s.w0!) * m;
    const c1 = s.c1 === "idle" ? this.idleOut.hands[h.side].curl : s.c1;
    h.curl = s.c0! + (c1 - s.c0!) * m;
    h.pin = s.pin0! + ((s.pin1 ?? 0) - s.pin0!) * m;
    h.pt = s.pt0! + ((s.pt1 ?? 0) - s.pt0!) * m;
    h.tuck = s.tuck0! + ((s.tuck1 ?? 0) - s.tuck0!) * m;
    h.fist = s.fist0! + ((s.fist1 ?? 0) - s.fist0!) * m;
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

  /** Table-local: where the fingers let a tipping piece go, and a little above it (where they rise to as it falls). */
  private letGo(t: Tip) {
    const a = t.angle;
    t.angle = Math.min(a, TIP_LET_GO);
    const g = this.tipGrip(t);
    t.angle = a;
    return up(g, 0.035);
  }

  /** Table-local: where the fingers hold a tipping piece (just under its head). */
  private tipGrip(t: Tip) {
    const q = new THREE.Quaternion().setFromAxisAngle(t.axis, t.angle);
    const g = t.base.clone().setY(t.base.y + t.grip).add(t.back ?? _r.set(0, 0, 0)).sub(t.pivot).applyQuaternion(q).add(t.pivot);
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

  // ---------------- the handshake at the start of a game ----------------

  private greetStep(ctx: { hand?: PlayerHand | null }) {
    const g = this.greet;
    const h = this.hands[1];
    if (g.phase === "none") return;
    if (g.phase === "wait") {
      if (Number.isNaN(g.at)) g.at = this.now + g.delay;
      // no tracked hand to shake with (a laptop, or a headset without hand tracking): a short nod at the time, and
      // on with the game (a first move of theirs that's waiting goes at once)
      const you = ctx.hand !== undefined ? ctx.hand : this.playerHand();
      if (!you && (this.now >= g.at || g.deferred)) {
        this.nodAt = this.now;
        g.phase = "back";
        g.lift = 0;
        return;
      }
      if (this.now < g.at || h.segs.length || this.hands[0].segs.length) return;
      g.phase = "offer";
      g.lift = GREET_RISE;
      const r = new Rng(hashSeed(this.seed, "greet"));
      const at = () => GREET_AT;
      h.segs = [
        { kind: "reach", dur: r.range(1.0, 1.25), end: at, w1: 1, o1: 1, c1: 0, pin1: -0.2, fist1: 0, lift: 0.04, skew: 0.15, look: () => "viewer", clear: true },
        { kind: "offer", dur: GREET_WAIT, end: at, w1: 1, o1: 1, c1: 0, pin1: -0.2, look: () => "viewer" },
        // left hanging: they take it back, with a small nod
        { ...this.returnSeg(1, GREET_AT, r), onBegin: () => this.sitBack(true) },
      ];
      return;
    }
    if (g.phase === "offer") {
      if (h.segs[0]?.kind !== "offer") return;
      const you = ctx.hand !== undefined ? ctx.hand : this.playerHand();
      if (!you?.ok || you.palm.distanceTo(h.world) > MEET) return;
      // they take your hand
      g.phase = "shake";
      g.lost = 0;
      this.followHand(you, true);
      softTap();
      h.segs = [
        { kind: "grasp", dur: 1.35, end: () => g.target, w1: 1, o1: 1, c1: 0, pin1: 0, fist1: 0.5, look: () => "viewer" },
        { kind: "offer", dur: 0.22, end: () => g.target, w1: 1, o1: 1, c1: 0, pin1: -0.2, fist1: 0, look: () => "viewer" }, // letting go
        { ...this.returnSeg(1, GREET_AT), onBegin: () => this.sitBack(false) },
      ];
      return;
    }
    if (g.phase === "shake") {
      const you = ctx.hand !== undefined ? ctx.hand : this.playerHand();
      if (you && you.palm.distanceTo(h.world) < 0.25) {
        g.lost = 0;
        this.followHand(you, false);
      } else if ((g.lost += this.dt) > 0.25 && h.segs[0]?.kind === "grasp") h.segs[0].dur = Math.min(h.segs[0].dur, this.now - h.segs[0].t0!); // you let go
      return;
    }
    // sitting back: when the hand's home, the game goes on (a move of theirs waiting for this goes now)
    if (!h.segs.length) {
      g.phase = "none";
      const d = g.deferred;
      g.deferred = null;
      if (d) this.play(d.carries, d.onPlaced, d.tap, d.opts);
    }
  }

  /** Where their hand goes on yours: against your palm, from the side it faces theirs (smoothed, and within reach). */
  private followHand(you: PlayerHand, snap: boolean) {
    const g = this.greet;
    const palm = this.table.worldToLocal(you.palm.clone());
    const n = this.table.worldToLocal(you.palm.clone().add(you.normal)).sub(palm).normalize();
    const mine = this.table.worldToLocal(this.hands[1].world.clone());
    if (n.dot(mine.clone().sub(palm)) < 0) n.negate();
    const want = palm.addScaledVector(n, 0.03);
    want.y = clamp(want.y, 0.16, 0.34); // (never down among the pieces, wherever your hand goes)
    want.z = clamp(want.z, -0.2, 0.2);
    want.x = clamp(want.x, -0.25, 0.15);
    if (snap) g.target.copy(want);
    else g.target.lerp(want, 1 - Math.exp(-this.dt / 0.06));
  }

  /** The handshake's over (shaken, or left hanging): they sit back down; a small nod either way. */
  private sitBack(hanging: boolean) {
    this.greet.phase = "back";
    this.greet.lift = 0;
    this.nodAt = this.now + (hanging ? 0.1 : 0.35);
  }

  /** You started before the handshake: they take their hand back (if it was out) and the game goes on. */
  private withdraw() {
    const g = this.greet;
    const h = this.hands[1];
    if (g.phase === "offer") h.segs = [{ ...this.returnSeg(1, h.p), onBegin: () => this.sitBack(true) }];
    else {
      g.phase = "back";
      g.lift = 0;
    }
  }

  /**
   * Your hand as the headset tracks it (the XR hand spaces game.ts puts in the scene), read for a handshake: the one
   * nearest their hand. null when no hand is tracked.
   */
  private playerHand(): PlayerHand | null {
    if (!this.xrHands) {
      let root: THREE.Object3D = this.table;
      while (root.parent) root = root.parent;
      this.xrHands = root.children.filter((o) => (o as unknown as { joints?: unknown }).joints !== undefined);
    }
    const mine = this.hands[1].world;
    let best: PlayerHand | null = null;
    let bestD = Infinity;
    for (const hand of this.xrHands) {
      const j = liveJoints(hand);
      const at = (n: string) => (j[n] && j[n].visible !== false ? j[n].getWorldPosition(new THREE.Vector3()) : null);
      const [w, im, mm, pm, tt, it, pt] = ["wrist", "index-finger-metacarpal", "middle-finger-metacarpal", "pinky-finger-metacarpal", "thumb-tip", "index-finger-tip", "pinky-finger-tip"].map(at);
      if (!w || !im || !mm || !pm || !tt || !it || !pt) continue;
      const palm = mm.clone().lerp(w, 0.25);
      const normal = im.clone().sub(w).cross(pm.clone().sub(w)).normalize();
      // palm sideways (its normal near level), fingers straight and together, thumb and index apart
      const ok = Math.abs(normal.y) < 0.6 && (openness(j) ?? 0) > 0.72 && it.distanceTo(pt) < 0.065 && tt.distanceTo(it) > 0.035;
      const d = palm.distanceTo(mine);
      if (d < bestD) [best, bestD] = [{ palm, normal, ok }, d];
    }
    return best;
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
    else if (now >= this.noticeFrom && now < this.noticeUntil) g.copy(this.notice);
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
    const scanning = this.idleInst.kind === "scan" && (this.mode === "think" || this.mode === "wait");
    if (scanning) {
      // walking the board: square by square along a rank, a file or a diagonal, then another line
      const sw = this.sweep;
      if (sw.n <= 0) {
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
        const [dx, dz] = r.pick(dirs);
        sw.dx = dx;
        sw.dz = dz;
        sw.n = 4 + Math.floor(r.next() * 4);
        sw.x = Math.floor(r.next() * 8) - 3.5;
        sw.z = Math.floor(r.next() * 8) - 3.5;
      }
      sw.x = clamp(sw.x + sw.dx, -3.5, 3.5);
      sw.z = clamp(sw.z + sw.dz, -3.5, 3.5);
      sw.n--;
      this.fixViewer = false;
      this.fix.set(sw.x * SQUARE, 0.02, sw.z * SQUARE);
      this.fixUntil = now + r.range(0.18, 0.34);
      return;
    }
    this.sweep.n = 0;
    if ((this.mode === "think" || this.mode === "wait") && this.clockAt && !this.fixViewer && r.chance(0.06 + 0.14 * this.pressure)) {
      // a glance at the clock
      this.fix.copy(this.clockAt());
      this.fixViewer = false;
      this.fixUntil = now + r.range(0.45, 0.8);
      return;
    }
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
    this.fixUntil = now + dur * (1 - 0.4 * this.pressure); // a short clock: quicker eyes
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

  // ---------------- the hand's own shape, and what's under it ----------------

  /** One finger joint's turn (i: 0..14 of that hand) in a finger state, from the turn the motion gives it (q, changed). */
  private fingerTurn(side: 0 | 1, i: number, st: FingerState, q: THREE.Quaternion) {
    const w = i >= 3 && i < 12 ? Math.max(st.pin, st.tuck ?? 0) : i >= 12 ? (st.thumb ?? st.pin) : st.pin;
    if (Math.abs(w) > 1e-4) q.slerp(fingerQuat(PINCH, side, i, _fq), clamp(w, -0.6, 1));
    if (st.pt > 1e-4) q.slerp(fingerQuat(POINT, side, i, _fq), clamp(st.pt, 0, 1));
    if ((st.fist ?? 0) > 1e-4) q.slerp(fingerQuat(FIST, side, i, _fq), clamp(st.fist!, 0, 1));
    if (st.curl && i < 12) q.multiply(rot(0, 0, (side === 1 ? 1 : -1) * st.curl * CURL[i]));
    return q;
  }

  /**
   * The hand in a finger state: balls along its palm and every finger, from the rest skeleton turned the way the
   * fingers are (forward kinematics from the wrist), sized from the avatar's own Gaussians; and its contact point.
   */
  private shape(side: 0 | 1, st: FingerState): HandShape {
    const key = `${side}|${st.pin.toFixed(3)}|${st.pt.toFixed(3)}|${st.curl.toFixed(3)}|${(st.tuck ?? 0).toFixed(3)}|${st.thumb?.toFixed(3)}|${(st.fist ?? 0).toFixed(3)}`;
    const memo = this.shapes.get(key);
    if (memo) return memo;
    const R = this.rig.rest;
    const B = this.body;
    const wr = side === 0 ? L_WRIST : R_WRIST;
    const base = side === 0 ? 25 : 40;
    const fr = B.finger[side] + 0.0015; // (a little more than the measured radius: a Gaussian finger is soft at its edge)
    const pr = B.palm[side];
    const pts: THREE.Vector3[] = [new THREE.Vector3()];
    const r: number[] = [Math.max(pr * 1.2, B.cuff[side] * 0.8)]; // the heel of the hand, where the forearm meets it
    const tips: THREE.Vector3[] = [];
    for (let f = 0; f < 5; f++) {
      const i = 3 * f;
      const [j1, j2, j3] = [base + i, base + i + 1, base + i + 2];
      const q1 = this.fingerTurn(side, i, st, this.rig.relaxed[side][i].clone());
      const q2 = q1.clone().multiply(this.fingerTurn(side, i + 1, st, this.rig.relaxed[side][i + 1].clone()));
      const q3 = q2.clone().multiply(this.fingerTurn(side, i + 2, st, this.rig.relaxed[side][i + 2].clone()));
      const p1 = R[j1].clone().sub(R[wr]);
      const p2 = R[j2].clone().sub(R[j1]).applyQuaternion(q1).add(p1);
      const p3 = R[j3].clone().sub(R[j2]).applyQuaternion(q2).add(p2);
      const rf = f === 4 ? fr * 1.15 : fr;
      const tip = R[j3].clone().sub(R[j2]).normalize().multiplyScalar(Math.max(B.tip[side] - rf, 0.004)).applyQuaternion(q3).add(p3);
      pts.push(p1, p1.clone().multiplyScalar(0.5));
      r.push(pr, pr);
      pts.push(p1.clone().lerp(p2, 0.5), p2, p2.clone().lerp(p3, 0.5), p3, p3.clone().lerp(tip, 0.5), tip);
      r.push(rf, rf, rf, rf, rf, rf);
      tips.push(tip);
    }
    const index = tips[0];
    const thumb = tips[4];
    const out: HandShape = { pts, r, contact: index.clone().add(thumb).multiplyScalar(0.5).lerp(index, clamp(st.pt, 0, 1)), gap: index.distanceTo(thumb), thumb, index };
    if (this.shapes.size > 600) this.shapes.clear();
    this.shapes.set(key, out);
    return out;
  }

  /** The pinch weight that leaves `gap` meters between the thumb and index tips (centres): from spread (-0.6) to 1. */
  private pinFor(side: 0 | 1, gap: number) {
    const g = this.pinGap[side];
    const w = (i: number) => -0.6 + i / 20;
    if (!g.length) for (let i = 0; i <= 32; i++) g.push(this.shape(side, { pin: w(i), pt: 0, curl: 0, tuck: 1 }).gap);
    if (gap >= g[0]) return w(0);
    for (let i = 1; i <= 32; i++) if (g[i] <= gap) return w(i - 1) + (g[i - 1] - gap) / Math.max(g[i - 1] - g[i], 1e-6) / 20;
    return 1;
  }

  /** A hand's balls, table-local and relative to its contact point, when it's turned by q (bundle). */
  private balls(side: 0 | 1, st: FingerState, q: THREE.Quaternion) {
    const sh = this.shape(side, st);
    const t = _bq.copy(this.qToBundle).invert().multiply(q);
    return { o: sh.pts.map((p) => p.clone().sub(sh.contact).applyQuaternion(t)), r: sh.r };
  }

  /** What's on the table this frame (table-local): every piece standing or lying there but the ones in a hand, the clock. */
  private gather() {
    this.things.length = 0;
    const held = new Set(this.hands.map((h) => h.held?.c.obj));
    const p = new THREE.Vector3();
    this.boardGroup.updateWorldMatrix(true, true);
    this.boardGroup.traverseVisible((o) => {
      const h = o.userData?.height;
      if (typeof h !== "number" || held.has(o)) return;
      if (Math.abs(o.quaternion.x) + Math.abs(o.quaternion.z) > 0.03) {
        // tipped over (a resigning king): about its length, wherever it lies
        this.table.worldToLocal(o.localToWorld(p.set(0, h * 0.5, 0)));
        this.things.push({ obj: o, x: p.x, z: p.z, hx: h * 0.5 + PIECE_R, hz: 0, round: true, top: p.y + PIECE_R });
        return;
      }
      this.table.worldToLocal(o.getWorldPosition(p));
      this.things.push({ obj: o, x: p.x, z: p.z, hx: PIECE_R * o.scale.x, hz: 0, round: true, top: p.y + h * o.scale.y });
    });
    if (this.clockAt) {
      // clock.ts: a 0.095 x 0.034 x 0.18 body, their button 3.1 cm off its middle and 4.5 cm toward them, yours opposite
      const b = this.clockAt();
      this.things.push({ obj: null, x: b.x - 0.031, z: b.z + 0.045, hx: 0.048, hz: 0.091, round: false, top: b.y - 0.0145 });
      this.things.push({ obj: FAR_BUTTON, x: b.x, z: b.z, hx: 0.015, hz: 0.026, round: false, top: b.y });
      this.things.push({ obj: null, x: b.x, z: b.z + 0.09, hx: 0.015, hz: 0.026, round: false, top: b.y });
    }
  }

  /**
   * The top of whatever is under a ball of radius rad at table-local (x, z): table, board, piece, clock; -Infinity off
   * the table. fixed: only what never moves (the table, the board, the clock), not the pieces.
   */
  private ground(x: number, z: number, rad: number, skip?: Set<THREE.Object3D | null>, extra?: Thing[], fixed = false) {
    let y = Math.abs(x) < TABLE_HALF_X + rad && z > -TABLE_EDGE - rad && z < TABLE_NEAR + rad ? TABLE_TOP : -Infinity;
    if (Math.abs(x) < BOARD_EDGE + rad && Math.abs(z) < BOARD_EDGE + rad) y = Math.max(y, BOARD_TOP);
    for (const list of extra ? [this.things, extra] : [this.things])
      for (const t of list) {
        if (t.top <= y || (t.obj && skip?.has(t.obj)) || (fixed && t.round)) continue;
        const dx = Math.abs(x - t.x);
        const dz = Math.abs(z - t.z);
        if (t.round ? dx * dx + dz * dz < (t.hx + rad) ** 2 : dx < t.hx + rad && dz < t.hz + rad) y = t.top;
      }
    return y;
  }

  /**
   * The lowest a hand's contact point may be at table-local (x, z), turned by q (bundle), in finger state st: every
   * part of the hand `gap` above what's under it. skip: what it may touch; extra: things not on the table yet.
   */
  private floor(side: 0 | 1, st: FingerState, q: THREE.Quaternion, x: number, z: number, skip?: Set<THREE.Object3D | null>, gap = GAP, extra?: Thing[]) {
    const { o, r } = this.balls(side, st, q);
    let need = -Infinity;
    for (let i = 0; i < o.length; i++) need = Math.max(need, this.ground(x + o[i].x, z + o[i].z, r[i], skip, extra) + r[i] + gap - o[i].y);
    return need;
  }

  /** How a hand is turned reaching for something at graspB (bundle): fingers down at it by beta, the thumb side up by roll. */
  private reachTurn(side: 0 | 1, graspB: THREE.Vector3, beta: number, roll: number, out = new THREE.Quaternion()) {
    const f = graspB.clone().sub(this.seat).addScaledVector(OUT[side], -0.17).setY(0);
    if (f.lengthSq() < 1e-4) f.copy(FWD);
    f.normalize();
    const dir = f.clone().multiplyScalar(Math.cos(beta)).addScaledVector(DOWN, Math.sin(beta));
    const palm = DOWN.clone().multiplyScalar(Math.cos(beta)).addScaledVector(f, -Math.sin(beta));
    return this.handPose(this.rig.hands[side], dir, palm, side === 1 ? roll : -roll, out);
  }

  /**
   * The roll (as reachTurn takes it) nearest `near` that holds the thumb and index tips level with each other, so a
   * pinch takes a piece's head from its two sides rather than over its top and under its collar.
   */
  private levelRoll(side: 0 | 1, st: FingerState, atT: THREE.Vector3, beta: number, near: number) {
    const sh = this.shape(side, st);
    const v = new THREE.Vector3();
    const tilt = (roll: number) => {
      v.copy(sh.index).sub(sh.thumb).applyQuaternion(this.reachTurnT(side, atT, beta, roll));
      return v.y / Math.max(v.length(), 1e-6);
    };
    let best = near;
    let bestD = Infinity;
    let flat = near;
    let flatT = Infinity;
    let prev = tilt(near - 1.2);
    for (let i = 1; i <= 48; i++) {
      const a = near - 1.2 + (i - 1) * 0.05;
      const b = a + 0.05;
      const cur = tilt(b);
      if (Math.abs(cur) < flatT) [flat, flatT] = [b, Math.abs(cur)];
      if (Math.sign(cur) !== Math.sign(prev)) {
        let lo = a;
        let hi = b;
        for (let j = 0; j < 12; j++) {
          const mid = (lo + hi) / 2;
          if (Math.sign(tilt(mid)) === Math.sign(tilt(lo))) lo = mid;
          else hi = mid;
        }
        const root = (lo + hi) / 2;
        if (Math.abs(root - near) < bestD) [best, bestD] = [root, Math.abs(root - near)];
      }
      prev = cur;
    }
    return Number.isFinite(bestD) ? best : flat; // (no roll levels them: the one that comes nearest)
  }

  /**
   * How to take a piece by its head with the hand turned by q (bundle): the pinch (as tight as fits) and the height
   * on the piece (near `grip`) where the thumb and index tips rest on its sides and no other part of the hand is in it,
   * by its real lathe profile (pieces.ts). null if nothing fits.
   */
  private pinchFit(side: 0 | 1, type: PieceType, height: number, q: THREE.Quaternion, grip: number) {
    const t = this.qToBundle.clone().invert().multiply(q);
    const v = new THREE.Vector3();
    const inPiece = (pin: number, at: number) => {
      const sh = this.shape(side, { pin, pt: 0, curl: 0, tuck: 1 });
      let worst = -Infinity;
      for (let i = 0; i < sh.pts.length; i++) {
        v.copy(sh.pts[i]).sub(sh.contact).applyQuaternion(t);
        const d = Math.hypot(v.x, v.z);
        const r = sh.r[i];
        if (d > r + PIECE_R) continue;
        for (let k = -2; k <= 2; k++) {
          const dy = (k / 2) * r * 0.9;
          const pr = profileR(type, at + v.y + dy, v.x, v.z);
          if (pr > 0) worst = Math.max(worst, pr + Math.sqrt(r * r - dy * dy) - d);
        }
      }
      return worst;
    };
    let best: { pin: number; grip: number } | null = null;
    for (const f of [0, 0.04, -0.04, 0.08, -0.08, 0.13]) {
      const at = clamp(grip / height + f, 0.62, 0.98) * height;
      // from the firmest pinch down in steps of 0.1, then back up in 0.025s: the firmest that fits
      for (let pin = 1; pin >= -0.6 - 1e-6; pin -= 0.1)
        if (inPiece(pin, at) <= 0.0015) {
          let p = pin;
          for (let q = pin + 0.025; q < pin + 0.1 - 1e-6 && q <= 1; q += 0.025) if (inPiece(q, at) <= 0.0015) p = q;
          if (!best || p > best.pin + 0.12) best = { pin: p, grip: at };
          break;
        }
      if (best && best.pin > 0.3) break; // a good firm hold near where it was asked: take it
    }
    return best;
  }

  /**
   * A hand holding a piece: if, turned as it is now, its fingers would be in the piece, the pinch opens until they
   * aren't (the turn drifts a little on the way, and the piece is held by its sides, not through them).
   */
  private easePinch(h: Hand, k: Held) {
    const type = k.c.obj.userData?.type as PieceType | undefined;
    if (!type) return;
    const t = this.qToBundle.clone().invert().multiply(h.q);
    const v = new THREE.Vector3();
    // where the hand really is against the piece (coming down onto it, or short of it on a far reach)
    // (across: where it really was last frame, short of its target on a far reach; up and down: where it's going this
    // frame, so a hand coming down is judged where it's coming down to)
    const piece = this.table.worldToLocal(k.c.obj.getWorldPosition(new THREE.Vector3()));
    const at = this.table.worldToLocal(h.world.clone()).sub(piece);
    at.y = h.p.y - piece.y;
    if (h.held === k) at.set(0, k.grip, 0);
    for (let n = 0; n < 20; n++) {
      const sh = this.shape(h.side, { pin: h.pin, pt: h.pt, curl: h.curl, tuck: h.tuck, fist: h.fist });
      let worst = -Infinity;
      for (let i = 0; i < sh.pts.length; i++) {
        v.copy(sh.pts[i]).sub(sh.contact).applyQuaternion(t).add(at);
        const d = Math.hypot(v.x, v.z);
        const r = sh.r[i];
        if (d > r + PIECE_R) continue;
        for (let j = -2; j <= 2; j++) {
          const dy = (j / 2) * r * 0.9;
          const pr = profileR(type, v.y + dy, v.x, v.z);
          if (pr > 0) worst = Math.max(worst, pr + Math.sqrt(r * r - dy * dy) - d);
        }
      }
      if (worst <= 0.0015) return;
      if (h.pin <= -0.6) {
        // as wide as the fingers go and still in it: the hand takes it a little higher on its head instead
        if ((k.raise ?? 0) < 0.025) {
          const r = Math.min(0.004, 0.025 - (k.raise ?? 0));
          k.raise = (k.raise ?? 0) + r;
          k.grip += r;
          at.y += r;
          continue;
        }
        return;
      }
      h.pin = Math.max(-0.6, h.pin - 0.04);
    }
  }

  /** reachTurn for a table-local point. */
  private reachTurnT(side: 0 | 1, atT: THREE.Vector3, beta: number, roll: number) {
    return this.reachTurn(side, atT.clone().applyMatrix4(this.toBundle), beta, roll);
  }

  /** The shape of a step's path over its time fraction u: how much of its lift it has risen. */
  private hump(s: Seg, u: number) {
    // a carry lifts the piece first, carries it level and sets it down last: flat-topped, so clearing a row of pieces
    // late on the way doesn't take a tall arc (a piece taken off goes over the whole back rank to beside the board)
    return s.kind === "carry" ? smooth(clamp(u / 0.3, 0, 1)) * smooth(clamp((1 - u) / 0.25, 0, 1)) : Math.sin(Math.PI * u);
  }

  /** Where a step's path is at time fraction u, from a to b, before its lift (what evaluate() moves along). */
  private pathAt(s: Seg, a: THREE.Vector3, b: THREE.Vector3, u: number, out: THREE.Vector3) {
    const e = ease(u, s.skew ?? 0);
    out.lerpVectors(a, b, e);
    this.bow(out, a, b, s, e);
    if (s.kind === "carry" && s.over) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const L = Math.hypot(dx, dz);
      const o = L > 0.01 ? s.over * Math.sin(Math.PI * clamp((e - 0.55) / 0.45, 0, 1)) : 0;
      out.x += (dx / (L || 1)) * o;
      out.z += (dz / (L || 1)) * o;
    }
    return out;
  }

  /**
   * How high a step's path must rise in the middle (its lift) for the hand, and a piece in it, to clear everything
   * they pass over. Sampled along the way with the hand as it will be there (turned toward where it is, its fingers
   * part-way between how they start and end); the ends are what they are (planned with the piece they go to), so the
   * path only has to be no worse than them in between.
   */
  private pathLift(h: Hand, s: Seg) {
    const a = s.from!;
    const b = s.end();
    const side = h.side;
    const k = s.kind === "carry" ? (s.k ?? h.held) : null;
    const skip = new Set<THREE.Object3D | null>(k ? [k.c.obj] : []);
    const idle = this.idleOut.hands[side];
    const c1 = s.c1 === "idle" ? idle.curl : s.c1;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const deficit = (u: number, at: THREE.Vector3, gap: number) => {
      const m = smooth(u);
      const w = clamp(s.w0! + (s.w1 - s.w0!) * m, 0, 1);
      const st: FingerState = { pin: lerp(h.pin, s.pin1 ?? 0, m), pt: lerp(h.pt, s.pt1 ?? 0, m), curl: lerp(h.curl, c1, m), tuck: lerp(h.tuck, s.tuck1 ?? 0, m), fist: lerp(h.fist, s.fist1 ?? 0, m) };
      const beta = s.beta !== undefined ? lerp(s.b0!, s.beta, m) : h.beta;
      const roll = s.roll !== undefined ? lerp(s.r0!, s.roll, m) : h.roll;
      q.copy(idle.q).slerp(this.reachTurnT(side, at, beta, roll), smooth(w));
      const { o, r } = this.balls(side, st, q);
      let need = -Infinity;
      for (let j = 0; j < o.length; j++) need = Math.max(need, this.ground(at.x + o[j].x, at.z + o[j].z, r[j], skip) + r[j] + gap - o[j].y);
      if (k) need = Math.max(need, this.ground(at.x, at.z, PIECE_R, skip) + gap + k.grip);
      return need - at.y;
    };
    const d0 = Math.max(0, deficit(0, a, 0));
    const d1 = Math.max(0, deficit(1, b, 0));
    let lift = 0;
    for (let i = 1; i < 32; i++) {
      const u = i / 32;
      const hm = this.hump(s, u);
      if (hm < 0.05) continue;
      this.pathAt(s, a, b, u, p);
      const allowed = lerp(d0, d1, ease(u, s.skew ?? 0));
      const d = deficit(u, p, GAP * Math.min(1, hm / 0.5)) - allowed;
      lift = Math.max(lift, d / hm);
    }
    return Math.min(lift, 0.3);
  }

  /**
   * Turns an arm about its shoulder-wrist line (the wrist stays where it is) until the elbow and the forearm are clear
   * of what's under them: lying on the table is fine, going into it, the board or a piece isn't. The smallest turn
   * that does it, raising the elbow the outward way round.
   */
  private liftArm(h: Hand, gA: THREE.Quaternion, lB: THREE.Quaternion) {
    const L = this.rig.arms[h.side];
    const A = this.P[L.a];
    const B = this.body;
    const side = h.side;
    const skip = new Set<THREE.Object3D | null>(h.held ? [h.held.c.obj] : []);
    const e = new THREE.Vector3();
    const w = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const t = new THREE.Vector3();
    const deficit = (g: THREE.Quaternion) => {
      e.copy(L.v1).applyQuaternion(g).add(A);
      w.copy(L.v2).applyQuaternion(q.copy(g).multiply(lB)).add(e);
      let worst = -Infinity;
      for (const u of [0.55, 0.8, 1]) {
        t.lerpVectors(A, e, u).applyMatrix4(this.fromBundle);
        worst = Math.max(worst, this.ground(t.x, t.z, B.upper[side], skip) + B.upper[side] - t.y);
      }
      for (const u of [0.2, 0.45, 0.7, 0.85]) {
        const r = lerp(B.arm[side], B.cuff[side], u);
        t.lerpVectors(e, w, u).applyMatrix4(this.fromBundle);
        worst = Math.max(worst, this.ground(t.x, t.z, r, skip) + r - t.y);
      }
      return worst;
    };
    const d0 = deficit(gA);
    if (d0 <= 0.001) return;
    const axis = w.clone().sub(A).normalize();
    e.copy(L.v1).applyQuaternion(gA);
    const turn = axis.clone().cross(e);
    const sgn = Math.abs(turn.y) > 0.02 * e.length() ? Math.sign(turn.y) : Math.sign(turn.dot(OUT[side])) || 1;
    const rq = new THREE.Quaternion();
    const at = (phi: number) => q.setFromAxisAngle(axis, phi).multiply(gA).clone();
    let lo = 0;
    let hi = 0;
    let best = 0;
    let bestD = d0;
    for (let i = 1; i <= 16; i++) {
      const phi = sgn * 0.1 * i;
      const d = deficit(at(phi));
      if (d < bestD) [best, bestD] = [phi, d];
      if (d <= 0.001) {
        [lo, hi] = [sgn * 0.1 * (i - 1), phi];
        break;
      }
    }
    if (hi !== 0) {
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if (deficit(at(mid)) <= 0.001) hi = mid;
        else lo = mid;
      }
      best = hi;
    }
    gA.premultiply(rq.setFromAxisAngle(axis, best));
  }

  /**
   * A hand resting on the table between the board and the table's edge: the forearm lying on the table, the wrist on
   * its cuff, the hand tipped down from it until it rests too; fingers turned in toward the middle (yaw: + toward the
   * board), its front edge `back` behind the board's frame and its inner edge `inX` from the middle.
   */
  private tableHand(side: 0 | 1, out: HandIdle, curl = REST_CURL, yaw = 0.72, inX = 0.05, back = 0.02, slide = 0) {
    const key = `${side}|${curl.toFixed(3)}|${yaw.toFixed(3)}|${inX.toFixed(3)}|${back.toFixed(3)}|${this.qToBundle.toArray().map((v) => v.toFixed(3))}`;
    let m = this.restMemo.get(key);
    if (!m) {
      const s = side === 0 ? 1 : -1;
      const sh = this.shape(side, { pin: 0, pt: 0, curl });
      const toT = this.qToBundle.clone().invert();
      const dirT = new THREE.Vector3(-s * Math.cos(yaw), 0, Math.sin(yaw));
      const turn = (pitch: number) => {
        const d = dirT.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(DOWN, Math.sin(pitch)).applyQuaternion(this.qToBundle);
        return this.handPose(this.rig.hands[side], d, DOWN, side === 1 ? 0.2 : -0.2, new THREE.Quaternion());
      };
      const offs = (q: THREE.Quaternion) => sh.pts.map((p) => p.clone().applyQuaternion(_bq.copy(toT).multiply(q)));
      const low = (q: THREE.Quaternion) => Math.min(...offs(q).map((v, i) => v.y - sh.r[i]));
      const want = TABLE_TOP + 0.0015 - (TABLE_TOP + this.body.cuff[side] + 0.002); // lowest ball below the wrist
      let lo = -0.5;
      let hi = 0.6;
      if (low(turn(lo)) <= want) hi = lo;
      else
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (low(turn(mid)) > want) lo = mid;
          else hi = mid;
        }
      const q = turn(hi);
      const o = offs(q);
      const y = TABLE_TOP + 0.0015 - Math.min(...o.map((v, i) => v.y - sh.r[i]));
      const z = -BOARD_EDGE - back - Math.max(...o.map((v, i) => v.z + sh.r[i]));
      const x = side === 0 ? inX - Math.min(...o.map((v, i) => v.x - sh.r[i])) : -inX - Math.max(...o.map((v, i) => v.x + sh.r[i]));
      m = { wristT: new THREE.Vector3(x, y, z), q };
      if (this.restMemo.size > 200) this.restMemo.clear();
      this.restMemo.set(key, m);
    }
    out.q.copy(m.q);
    out.curl = curl;
    this.fromWrist(side, m.wristT.clone().add(new THREE.Vector3((side === 0 ? 1 : -1) * slide, 0, -0.3 * slide)).applyMatrix4(this.toBundle), out);
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
      this.reachTurn(side, h.graspB, h.beta, h.roll, reachQ);
      if (side === 1 && h.o > 0) {
        // palm sideways, thumb up, fingers toward the player
        const offerQ = this.handPose(r.hands[1], FWD.clone().addScaledVector(DOWN, 0.15), LEFT, 0, new THREE.Quaternion());
        reachQ.slerp(offerQ, smooth(h.o));
      }
    }
    const m = smooth(h.w);
    h.q.slerpQuaternions(idle.q, reachQ, m);
    const sk = h.segs[0]?.k && ["descend", "grip", "carry", "set", "hover", "adjust", "release"].includes(h.segs[0].kind) ? h.segs[0].k : null;
    if (h.held || sk) {
      // wider than asked if the piece needs it, and kept that wide a while: re-deciding every frame would flicker
      h.ease = Math.max(0, h.ease - this.dt * 0.6);
      const asked = h.pin;
      h.pin = Math.max(-0.6, asked - h.ease);
      this.easePinch(h, h.held ?? sk!);
      h.ease = Math.max(h.ease, asked - h.pin);
    } else h.ease = 0;
    h.contact.copy(this.shape(side, { pin: h.pin, pt: h.pt, curl: h.curl, tuck: h.tuck, fist: h.fist }).contact);
    h.wrist.copy(h.contact).applyQuaternion(h.q).negate().add(h.graspB);
    h.pole.copy(idle.pole).lerp(this.defaultPole(side, new THREE.Vector3()), m).normalize();
    // the reaching shoulder comes forward: the torso turns a little toward the target, more for the far side
    const az = Math.atan2(-h.graspB.x, -h.graspB.z); // + toward the person's left
    h.twist = m * (side === 1 ? clamp(0.1 + 0.55 * az, -0.12, 0.62) : -clamp(0.1 - 0.55 * az, -0.12, 0.62)); // (across the body: a good deal)
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
  private torso(local: THREE.Quaternion[], rootT: THREE.Vector3, reach: number, rise = this.riseS, slide = this.slideS) {
    const t = this.now;
    const r = this.rig;
    const I = this.idleOut;
    const br = this.breath;
    const L = clamp(BASE_LEAN + I.lean + this.elbowAdj * this.elbowW + reach, -0.2, 1.1);
    const [hl, hr] = this.hands;
    const tw = I.twist + hl.twist + hr.twist;
    const sway = I.roll + 0.012 * Math.sin(t * 0.37 + this.phase) + 0.006 * Math.sin(t * 0.83 + 2 * this.phase); // weight shifting
    const pl = 0.1 * smooth(hl.w) + 0.25 * (Math.min(hl.lean, reach) / MAX_LEAN); // a reaching shoulder comes forward
    const pr = 0.1 * smooth(hr.w) + 0.25 * (Math.min(hr.lean, reach) / MAX_LEAN);
    local[PELVIS].copy(YAW).multiply(rot(L * 0.34, tw * 0.15, sway * 0.6));
    local[SPINE1].copy(rot(L * 0.26, tw * 0.3, sway * 0.25));
    // breathing in: the chest lifts (spine2-3 extend) and the shoulders rise about 2.5 mm; the neck keeps the head still
    local[SPINE2].copy(rot(L * 0.22 - br * 0.01, tw * 0.3, sway * 0.15));
    local[SPINE3].copy(rot(L * 0.18 - br * 0.02, tw * 0.25, 0));
    local[L_COLLAR].copy(rot(0, -pl + I.retract, br * 0.02 + I.shrug + hl.scapula));
    local[R_COLLAR].copy(rot(0, pr - I.retract, -br * 0.02 - I.shrug - hr.scapula));
    local[NECK].copy(rot(0.12 + I.neck + br * 0.025, 0, -sway * 0.7));
    local[HEAD].copy(rot(0.1 + I.headPitch, 0, I.headRoll + 0.015 * Math.sin(t * 0.53 + this.phase)));
    // root_t from the rest skeleton: the hip joints land on the seat point, whatever the body's size
    rootT.copy(this.seat).sub(r.rest[PELVIS]).sub(_r.copy(r.hipMid).sub(r.rest[PELVIS]).applyQuaternion(local[PELVIS]));
    rootT.y += rise; // half rising off the seat, for a reach the chest would otherwise take into the table
    rootT.z -= slide; // and forward on it (bundle -z is their front)
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
    let slide = 0;
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
        if (need(MAX_LEAN) > 0) {
          lean = MAX_LEAN;
          // further than leaning reaches: they slide forward on the seat for it (feet where they are)
          const far = (sl: number) => {
            this.torso(local, rootT, MAX_LEAN, this.riseS, sl);
            return P[sh].distanceTo(h.wrist) - most;
          };
          let lo = 0;
          let hi = MAX_SLIDE;
          if (far(hi) > 0) lo = hi;
          else
            for (let i = 0; i < 10; i++) {
              const mid = (lo + hi) / 2;
              if (far(mid) > 0) lo = mid;
              else hi = mid;
            }
          slide = Math.max(slide, wr * hi);
        } else {
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
    // leaning that far in, a bulky chest would go over the table's edge and into it: they rise a little off the seat
    // instead (up to 20 cm: half standing), and if even that isn't enough, lean no further
    let rise = 0;
    let lean = asked;
    // (and up off the seat a little while they hold their hand out across the table at the start)
    if (asked > 0.25 && this.chestInTable(local, rootT, asked, 0, slide) > 0) {
      if (this.chestInTable(local, rootT, asked, MAX_RISE, slide) > 0) {
        rise = MAX_RISE;
        let lo = 0;
        let hi = asked;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) / 2;
          if (this.chestInTable(local, rootT, mid, rise, slide) > 0) hi = mid;
          else lo = mid;
        }
        lean = lo;
      } else {
        let lo = 0;
        let hi = MAX_RISE;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) / 2;
          if (this.chestInTable(local, rootT, asked, mid, slide) > 0) lo = mid;
          else hi = mid;
        }
        rise = hi;
      }
    }
    rise = Math.max(rise, this.greet.lift);
    const steps = Math.ceil(this.dt / 0.02);
    for (let i = 0; i < steps; i++) {
      const h = this.dt / steps;
      const om = 11;
      this.leanV = clamp(this.leanV + (om * om * (lean - this.leanS) - 2 * om * this.leanV) * h, -1.6, 1.6);
      this.leanS += this.leanV * h;
      this.riseV = clamp(this.riseV + (om * om * (rise - this.riseS) - 2 * om * this.riseV) * h, -0.3, 0.3);
      this.riseS += this.riseV * h;
      this.slideV = clamp(this.slideV + (om * om * (slide - this.slideS) - 2 * om * this.slideV) * h, -0.4, 0.4);
      this.slideS += this.slideV * h;
    }
    // and never less than the body as it is right now needs (the springs don't keep perfect step with each other)
    if (this.leanS > 0.25 && this.chestInTable(local, rootT, this.leanS, this.riseS, this.slideS) > 0) {
      let lo = this.riseS;
      let hi = MAX_RISE;
      if (this.chestInTable(local, rootT, this.leanS, hi, this.slideS) > 0) lo = hi;
      else
        for (let i = 0; i < 9; i++) {
          const mid = (lo + hi) / 2;
          if (this.chestInTable(local, rootT, this.leanS, mid, this.slideS) > 0) lo = mid;
          else hi = mid;
        }
      this.riseS = hi;
      this.riseV = Math.max(this.riseV, 0);
    }
    this.torso(local, rootT, this.leanS);

    // head and neck turn toward what the eyes are on; a head resting on a hand turns less (the eyes do the rest)
    let held = 0;
    for (const h of this.hands) held = Math.max(held, this.idleOut.hands[h.side].head * (1 - smooth(h.w)));
    const turn = (1 - 0.6 * held) * this.idleOut.look;
    const eye = (j: number) => this.P[j].clone().add(r.eyeOff.clone().applyQuaternion(G[j]));
    const want = this.gazeB.clone().sub(eye(HEAD)).normalize();
    const qn = swing(Z.clone().applyQuaternion(G[HEAD]), want, 1.0 * turn).clone().slerp(ID, 0.6); // the neck takes 40%
    G[NECK].premultiply(qn);
    local[NECK].copy(G[SPINE3]).invert().multiply(G[NECK]);
    this.fk(local, rootT, HEAD);
    want.copy(this.gazeB).sub(eye(HEAD)).normalize();
    G[HEAD].premultiply(swing(Z.clone().applyQuaternion(G[HEAD]), want, 0.85 * turn));
    local[HEAD].copy(G[NECK]).invert().multiply(G[HEAD]);
    const nod = (this.now - this.nodAt) / 1.5; // a small, slow nod: down, and back up
    if (nod >= 0 && nod < 1) {
      local[HEAD].multiply(rot(0.15 * (1 - Math.cos(2 * Math.PI * nod)) / 2, 0, 0));
      G[HEAD].multiplyQuaternions(G[NECK], local[HEAD]);
    }
    const shake = (this.now - this.shakeAt) / 1.4; // a slight shake of the head: hm, no
    if (shake >= 0 && shake < 1) {
      local[HEAD].multiply(rot(0, 0.07 * Math.sin(2 * Math.PI * 1.5 * shake) * Math.sin(Math.PI * shake), 0));
      G[HEAD].multiplyQuaternions(G[NECK], local[HEAD]);
    }
    // nor turns more than about 57 degrees from the chest all told: past that the neck's skin twists
    const rel = _bq.copy(G[SPINE3]).invert().multiply(G[HEAD]);
    const ang = 2 * Math.acos(clamp(Math.abs(rel.w), 0, 1));
    if (ang > HEAD_TURN) {
      G[HEAD].copy(G[SPINE3]).multiply(rel.slerp(ID, 1 - HEAD_TURN / ang));
      local[HEAD].copy(G[NECK]).invert().multiply(G[HEAD]);
    }
    // the head never tips back more than about 17 degrees past the chest's forward (looking up from a lean is the
    // eyes' job): further back the neck's skin stretches and, from behind, the face shows over the head
    const fc = Z.clone().applyQuaternion(G[HEAD]).applyQuaternion(_bq.copy(G[SPINE3]).invert());
    const back = Math.atan2(fc.y, Math.hypot(fc.x, fc.z)) - HEAD_BACK;
    if (back > 0) {
      local[NECK].multiply(rot(back * 0.5, 0, 0));
      G[NECK].multiplyQuaternions(G[SPINE3], local[NECK]);
      this.fk(local, rootT, HEAD);
      local[HEAD].premultiply(rot(back * 0.5, 0, 0));
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
      const target = P[L.a].clone().addScaledVector(FWD, 0.53 * (L.v1.length() + L.v2.length()) + this.idleOut.feet - this.slideS).addScaledVector(LEFT, s * 0.04);
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
    // forearm turns and a wrist bends; then the guard: if the forearm or the hand would be in the body (or nearer it
    // than CLEAR), move the hand out (or, for a hand at a piece, the elbow) and solve again
    this.guardPush = 0;
    this.guardResid = 0;
    const way = new THREE.Vector3();
    for (const h of this.hands) {
      const side = h.side;
      const L = r.arms[side];
      const collar = side === 0 ? L_COLLAR : R_COLLAR;
      const contact = this.idleOut.hands[side].head * (1 - smooth(h.w)) > 0.5; // resting on the face on purpose
      let pushed = 0;
      for (let fix = 0; ; fix++) {
        this.armIK(h, gA, lB, inv, wl);
        if (fix === 4) break;
        // a moving arm keeps well clear (it sweeps past the body); one resting on the table only off it
        const need = this.clearance(side, contact, lerp(REST_CLEAR, CLEAR, smooth(h.w)), way);
        if (need.d < 0.002) break;
        if (need.elbow || h.w > 0.5) {
          // the elbow is in the body, or the hand is at a piece: the elbow goes out instead
          h.pole.addScaledVector(way, 1.2).normalize();
          if (h.w > 0.5 && !need.elbow) continue;
        }
        if (h.w < 0.5 && !this.idleOut.hands[side].head) {
          // a hand on the table slides along it, out of the way: never up off it or down into it
          way.y = 0;
          if (way.lengthSq() < 0.04) break;
          way.normalize();
        }
        const m = Math.min(need.d, 0.06);
        h.wrist.addScaledVector(way, m);
        h.graspB.addScaledVector(way, m);
        pushed += m;
      }
      // a hand on the table rests on it, whatever its turn ended up as (a wrist turns only so far) and however the
      // body moves above it; and no hand ever goes into the table or the board (nor, resting, into a piece)
      for (let n = 0; n < 3; n++) {
        const settle = this.settle(h, contact);
        if (!settle) break;
        h.wrist.y += settle;
        h.graspB.y += settle;
        this.armIK(h, gA, lB, inv, wl);
      }
      this.guardPush = Math.max(this.guardPush, pushed);
      this.guardResid = Math.max(this.guardResid, this.clearance(side, contact, 0, way, true).d);
      local[L.a].copy(inv.copy(G[collar]).invert().multiply(gA));
      local[L.b].copy(lB);
      local[L.c].copy(wl);
      G[L.c].multiplyQuaternions(G[L.b], local[L.c]);
      h.graspB.copy(h.contact).applyQuaternion(G[L.c]).add(P[L.c]);
    }

    // an arm raised past level takes its shoulder blade with it (a third of the way past level, as a body's does), so
    // the shoulder joint itself never turns so far that the skin over it folds; next frame's collars carry it
    for (const h of this.hands) {
      const [sh, el] = h.side === 0 ? [L_SHOULDER, L_ELBOW] : [R_SHOULDER, R_ELBOW];
      const down = _r.set(0, -1, 0).applyQuaternion(G[h.side === 0 ? L_COLLAR : R_COLLAR]);
      const raise = Math.acos(clamp(P[el].clone().sub(P[sh]).normalize().dot(down), -1, 1)) + (h.scapula || 0);
      const want = clamp(0.55 * (raise - 1.35), 0, 0.5);
      h.scapula += (want - h.scapula) * (1 - Math.exp(-this.dt / 0.08));
    }

    // fingers: the avatar's own relaxed hand at rest; thumb and index open around a piece's head on the way in and
    // closing on it to hold it, the other three curled out of the way; the index alone for the clock
    for (const h of this.hands) {
      const base = h.side === 0 ? 25 : 40;
      const st: FingerState = { pin: h.pin, pt: h.pt, curl: h.curl, tuck: h.tuck, fist: h.fist };
      for (let i = 0; i < 15; i++) if (local[base + i]) this.fingerTurn(h.side, i, st, local[base + i]);
    }
  }

  /**
   * How far (meters, + up) a posed hand has to move for every part of it to be just on what's under it: resting on
   * the table (or a little higher, never lower), or, when it's reaching, at least not in the table, the board, the
   * clock or a piece it isn't taking (the plan keeps it off them; this is for what a wrist's limits change).
   */
  private settle(h: Hand, contact: boolean) {
    const side = h.side;
    const idle = this.idleOut.hands[side];
    if (contact || idle.head > 0 || idle.elbow > 0) return 0;
    const wrist = side === 0 ? L_WRIST : R_WRIST;
    const sh = this.shape(side, { pin: h.pin, pt: h.pt, curl: h.curl, tuck: h.tuck, fist: h.fist });
    const resting = 1 - smooth(clamp(h.w * 2, 0, 1)); // 1: the idle pose has it on the table
    const seg = h.segs[0];
    // the piece it's taking it may touch from the moment it comes down onto it (on the way there it goes over it)
    const taking = seg?.k && seg.kind !== "reach" ? seg.k.c.obj : null;
    const skip = new Set<THREE.Object3D | null>([h.held?.c.obj ?? null, taking, seg?.tip?.obj ?? null, FAR_BUTTON]);
    const p = new THREE.Vector3();
    let gap = Infinity;
    for (let i = 0; i < sh.pts.length; i++) {
      p.copy(sh.pts[i]).applyQuaternion(this.G[wrist]).add(this.P[wrist]).applyMatrix4(this.fromBundle);
      const g = this.ground(p.x, p.z, sh.r[i], skip);
      gap = Math.min(gap, p.y - sh.r[i] - g);
    }
    if (!Number.isFinite(gap)) return 0;
    const want = resting > 0.5 ? 0.0015 : 0.003;
    if (gap < want - 0.0005) return want - gap; // in it: up
    if (resting > 0 && gap > want + 0.0005) return -(gap - want) * resting; // above it while resting: down onto it
    return 0;
  }

  /**
   * How far (meters) the front of the trunk would be in the table (or the board) at this reach lean and rise: the front
   * faces of the measured torso blocks (body.ts), where they're over the table. 0 when clear.
   */
  private chestInTable(local: THREE.Quaternion[], rootT: THREE.Vector3, lean: number, rise: number, slide: number) {
    this.torso(local, rootT, lean, rise, slide);
    const p = new THREE.Vector3();
    let worst = 0;
    const test = () => {
      p.applyMatrix4(this.fromBundle);
      const top = Math.abs(p.x) < BOARD_EDGE && Math.abs(p.z) < BOARD_EDGE ? BOARD_TOP : Math.abs(p.x) < TABLE_HALF_X && p.z > -TABLE_EDGE && p.z < TABLE_NEAR ? TABLE_TOP : -Infinity;
      worst = Math.max(worst, top + 0.012 - p.y);
    };
    // the front of the trunk as the avatar's own Gaussians have it, and the measured blocks' front faces
    for (const f of this.body.frontPts) {
      p.copy(f.o).applyQuaternion(this.G[f.j]).add(this.P[f.j]);
      test();
    }
    for (const b of this.body.boxes) {
      if (b.head) continue;
      for (const [fx, fy] of [[0, -0.9], [0, 0], [0, 0.9], [-0.6, -0.9], [0.6, -0.9], [-0.6, 0], [0.6, 0]]) {
        p.set(b.c.x + fx * b.r.x, b.c.y + fy * b.r.y, b.c.z + 0.92 * b.r.z).applyQuaternion(this.G[b.j]).add(this.P[b.j]);
        test();
      }
    }
    return worst;
  }

  /** One arm's two-bone IK to its wrist target, with the forearm's twist and the wrist's limits (writes G, P, lB, wl). */
  private armIK(h: Hand, gA: THREE.Quaternion, lB: THREE.Quaternion, inv: THREE.Quaternion, wl: THREE.Quaternion) {
    const r = this.rig;
    const G = this.G;
    const P = this.P;
    const side = h.side;
    const L = r.arms[side];
    const hr = r.hands[side];
    for (let pass = 0; ; pass++) {
      solveLimb(L, P[L.a], h.wrist, h.pole, gA, lB);
      this.liftArm(h, gA, lB);
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
      h.wrist.copy(h.contact).applyQuaternion(h.q).negate().add(h.graspB);
    }
    P[L.b].copy(L.v1).applyQuaternion(gA).add(P[L.a]);
    P[L.c].copy(L.v2).applyQuaternion(G[L.b]).add(P[L.b]);
    G[L.c].multiplyQuaternions(G[L.b], wl);
  }

  /**
   * How far one arm's hand must move (d, meters, along `way`) to keep its forearm and hand `clear` meters outside the
   * measured body (and its own thickness beyond that). elbow: the elbow itself is in the body. bare: measure what is
   * really inside (no clearance) instead. A hand resting on the face on purpose (contact) may touch the head, not enter it.
   */
  private clearance(side: 0 | 1, contact: boolean, clear: number, way: THREE.Vector3, bare = false) {
    const B = this.body;
    const P = this.P;
    const G = this.G;
    const el = P[side === 0 ? L_ELBOW : R_ELBOW];
    const wr = P[side === 0 ? L_WRIST : R_WRIST];
    const pt = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let best = 0;
    let elbow = false;
    // lever: a point part-way along the forearm moves less than the hand does
    const test = (growTorso: number, growHead: number, lever: number, isElbow = false) => {
      for (const [grow, which] of [[growTorso, "torso"], [growHead, "head"]] as const) {
        const d = B.depth(pt, grow, G, P, dir, which) / lever;
        if (d <= best) continue;
        best = d;
        way.copy(dir);
        elbow = isElbow;
      }
    };
    const arm = B.arm[side];
    // the forearm from a third of the way out (nearer the elbow it's an arm at his side, against the body as anyone's
    // is), the full clearance from halfway
    for (const t of [0.35, 0.55, 0.75, 1]) {
      pt.lerpVectors(el, wr, t);
      const c = bare ? 0 : clear * clamp((t - 0.35) / 0.2, 0, 1);
      test(arm + c, arm + c, Math.max(t, 0.5));
    }
    // the elbow itself: at his side is fine, inside his front is not (that elbow goes out)
    pt.copy(el);
    const de = B.depth(pt, 0, G, P, dir, "torso");
    if (!bare && de > 0.03 && de > best) {
      best = de;
      way.copy(dir);
      elbow = true;
    }
    // the hand, every ball of it (palm, fingers, thumb) as its fingers are now
    const h = this.hands[side];
    const sh = this.shape(side, { pin: h.pin, pt: h.pt, curl: h.curl, tuck: h.tuck, fist: h.fist });
    const gw = G[side === 0 ? L_WRIST : R_WRIST];
    const c = bare ? 0 : clear;
    for (let i = 0; i < sh.pts.length; i++) {
      pt.copy(sh.pts[i]).applyQuaternion(gw).add(wr);
      const r = sh.r[i];
      test(r + c, contact ? r * (bare ? 0.2 : 0.35) : r + c, 1);
    }
    return { d: best, elbow };
  }

  // ---------------- what this body allows ----------------

  /**
   * Runs every idle pose on this avatar's measured body for a few seconds (the eyes going between the board and the
   * player) and keeps those the guard can hold clear without changing what they are: no hand or forearm left inside
   * the body, a hand moved at most a few centimetres (a hand resting on the face, under 1.5 cm). The rest are never
   * chosen for this avatar. Runs once, on the first frame, before anything is shown.
   */
  private verifyPoses() {
    this.verified = true;
    const kinds: IdleKind[] = ["still", "rest", "scan", "leanIn", "leanBack", "shift", "breath", "neckRoll", "shoulderRoll", "chin", "cheek", "clasped", "forearms", "armsFolded"];
    const local0 = Array.from({ length: 55 }, () => new THREE.Quaternion());
    const rootT = new THREE.Vector3();
    const t0 = this.now;
    const board = new THREE.Vector3(0, 0.02, 0).applyMatrix4(this.toBundle);
    const player = new THREE.Vector3(0, 0.45, 0.6).applyMatrix4(this.toBundle);
    const report: string[] = [];
    const queued = this.hands.map((h) => h.segs);
    for (const kind of kinds) {
      for (const side of SIDED.includes(kind) ? ([0, 1] as const) : ([1] as const)) {
        let ok = true;
        let worstPush = 0;
        let worstIn = 0;
        for (const r of [0.2, 0.8]) {
          const inst: IdleInst = { kind, side, r: [r, 1 - r, r, 0.5, r, 1 - r] };
          this.idleInst = inst;
          this.idleFrom = null;
          this.idleT0 = this.now;
          this.elbowAdj = this.elbowW = this.leanS = this.leanV = this.riseS = this.riseV = this.slideS = this.slideV = 0;
          for (const h of this.hands) {
            h.segs = [];
            h.w = h.o = h.lean = h.twist = 0;
          }
          for (let i = 0; i < 100; i++) {
            this.now += 1 / 30;
            this.dt = 1 / 30;
            this.evalIdle(inst, this.idleLive);
            copyIdle(this.idleOut, this.idleLive);
            for (const h of this.hands) {
              h.p.copy(this.idleOut.hands[h.side].p);
              h.curl = this.idleOut.hands[h.side].curl;
              h.pin = h.pt = h.tuck = h.fist = 0;
              this.aimHand(h);
            }
            this.gazeB.copy(i % 40 < 20 ? board : player);
            this.solve(local0.map((q) => q.clone()), rootT);
            this.elbowControl(1 / 30);
            if (i < 25) continue; // let it settle (elbows find the table, hands find the chin)
            worstPush = Math.max(worstPush, this.guardPush);
            worstIn = Math.max(worstIn, this.guardResid);
          }
        }
        const contact = kind === "chin" || kind === "cheek";
        ok = worstIn < 0.003 && worstPush < (contact ? 0.015 : 0.06);
        if (ok) this.ok.add(SIDED.includes(kind) ? `${kind}:${side}` : kind);
        report.push(`${kind}${SIDED.includes(kind) ? ":" + side : ""} ${ok ? "ok" : "off"} (moved ${(worstPush * 100).toFixed(1)} cm, inside ${(worstIn * 100).toFixed(1)} cm)`);
      }
    }
    this.ok.add("ready");
    this.ok.add("rest"); // whatever happens, hands resting low (the guard still keeps them clear)
    this.lastReport = report;
    // back to the start, as if nothing had run
    this.now = t0;
    this.idleInst = { kind: "rest", side: 1, r: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] };
    this.idleFrom = null;
    this.elbowAdj = this.elbowW = this.leanS = this.leanV = this.riseS = this.riseV = this.slideS = this.slideV = 0;
    for (const h of this.hands) {
      h.w = h.o = h.lean = h.twist = 0;
      h.segs = queued[h.side];
    }
  }

  /** What verifyPoses found on this avatar, one line per pose (for checking it). */
  lastReport: string[] = [];

  // ---------------- the chair ----------------

  private buildTable(): THREE.Group {
    // dark walnut, matte, a faint grain along its length; the board set into its top; four slim legs to the floor
    const g = new THREE.Group();
    const grain = typeof document === "undefined" ? null : this.grain(); // (none outside a page: the pose check)
    const wood = new THREE.MeshStandardMaterial({ map: grain, color: grain ? 0xffffff : 0x1a1411, roughness: 0.78, metalness: 0, envMapIntensity: 0.22 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x15110e, roughness: 0.8, metalness: 0, envMapIntensity: 0.22 });
    this.chairMats.push(wood, legMat);
    const depth = TABLE_EDGE + TABLE_NEAR;
    const top = new THREE.Mesh(new RoundedBoxGeometry(TABLE_HALF_X * 2, TABLE_THICK, depth, 3, 0.006), wood);
    top.position.set(0, TABLE_TOP - TABLE_THICK / 2, (TABLE_NEAR - TABLE_EDGE) / 2);
    g.add(top);
    // a leg is 1 m tall from its top down; update() stretches it to the floor
    const leg = new THREE.CylinderGeometry(0.016, 0.012, 1, 16).translate(0, -0.5, 0);
    for (const lx of [-1, 1])
      for (const lz of [-TABLE_EDGE + 0.05, TABLE_NEAR - 0.05]) {
        const m = new THREE.Mesh(leg, legMat);
        m.position.set(lx * (TABLE_HALF_X - 0.05), TABLE_TOP - TABLE_THICK, lz);
        g.add(m);
        this.legs.push(m);
      }
    return g;
  }

  /** Dark walnut: a faint grain along the table's length. */
  private grain() {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const x = c.getContext("2d")!;
    x.fillStyle = "#1a1411";
    x.fillRect(0, 0, 512, 128);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 90; i++) {
      x.strokeStyle = `rgba(${rnd() < 0.5 ? "40,30,24" : "12,9,7"},${0.25 + 0.35 * rnd()})`;
      x.lineWidth = 0.6 + 1.6 * rnd();
      x.beginPath();
      const y0 = rnd() * 128;
      x.moveTo(0, y0);
      for (let px = 0; px <= 512; px += 32) x.lineTo(px, y0 + 3 * Math.sin(px / (60 + 80 * rnd()) + i));
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  private buildChair(): THREE.Group {
    // dark, minimal: a dark leather seat, four slim legs, two back posts and a curved-feeling rail. Front faces -Z.
    // Matte all over, the seat darkest: it shows under their jacket and past their trousers from the side and behind,
    // and must never read lighter than them or catch the room's reflections as a highlight
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.82, metalness: 0, envMapIntensity: 0.3 });
    const seat = new THREE.MeshStandardMaterial({ color: 0x121213, roughness: 0.95, metalness: 0, envMapIntensity: 0.12 });
    this.chairMats.push(mat, seat);
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, material: THREE.Material = mat) => {
      const m = new THREE.Mesh(geo, material);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      g.add(m);
    };
    const seatFront = -0.3;
    const seatBack = 0.12;
    const zc = (seatFront + seatBack) / 2;
    add(new RoundedBoxGeometry(0.44, 0.03, seatBack - seatFront, 3, 0.01), 0, SEAT_HEIGHT - 0.015, zc, 0, seat);
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
 * The forearm's share (80%) of a hand's turn about it, within what a forearm turns: + about the right forearm's axis
 * turns the palm up (supination, up to about 150 degrees from the rest pose's palm-down), - about the left's; the
 * rest pose is already near the end of pronation.
 */
function forearmTwist(rel: THREE.Quaternion, axis: THREE.Vector3, side: 0 | 1) {
  const t = twistAbout(rel, axis).slerp(ID, 0.2);
  const [lo, hi] = side === 1 ? [-0.4, 2.6] : [-2.6, 0.4];
  return t.setFromAxisAngle(axis, clamp(angleAbout(t, axis), lo, hi));
}

const WRIST_TWIST = 0.4;
const _tw = new THREE.Quaternion();
const _swg = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _fl = new THREE.Vector3();
const _dv = new THREE.Vector3();
/**
 * A wrist's turn relative to its forearm (q), within what a wrist does: flexion toward the palm up to 1.2 rad,
 * extension 1.0, side to side 0.5 (an ellipse between them), and 0.4 of twist left over from the forearm (SMPL-X has
 * no twist joints along the forearm, so a twisted wrist pinches the skin there: most of the twist is the forearm's). dir and
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
  if (k <= 1 && Math.abs(ta) <= WRIST_TWIST) return false;
  if (sn > 1e-6) _swg.setFromAxisAngle(_ax, k > 1 ? sa / Math.sqrt(k) : sa);
  else _swg.identity();
  out.copy(_swg).multiply(_tw.setFromAxisAngle(dir, clamp(ta, -WRIST_TWIST, WRIST_TWIST)));
  return true;
}
