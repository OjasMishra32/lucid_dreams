import * as THREE from "three";
import { type Params, type Rig, BODY, blendParams, copyParams, J, newParams, racketTurn } from "./rig";
import { RACKET } from "./racket";

// How the opponent moves: a small state machine that turns what the AI wants (stand ready, split-step, run there,
// hit a forehand / backhand / serve whose contact lands at a given moment and place) into a pose every frame. Two
// sources behind the same interface: procedural keyframes (racket path, trunk turn, knees, left arm) solved by rig.ts,
// and, when they exist, real tennis clips from public/tennis/motions/ (index.json + one motion.json-style file per
// clip), time-warped so each stroke's contact frame lands when the ball reaches his racket, crossfaded in and out.

export type StrokeKind = "forehand" | "backhand" | "serve" | "fvolley" | "bvolley" | "smash";
export interface Stroke {
  kind: StrokeKind;
  tc: number; // the moment of contact (sim seconds)
  contact: THREE.Vector3; // the sweet spot at contact, F space (relative to where he stands)
}
export interface Drive {
  t: number; // sim seconds
  dt: number;
  ground: THREE.Vector3; // where he stands (court)
  vel: THREE.Vector3; // how he's moving over the court (m/s)
  stroke: Stroke | null;
  split: number; // sim time of his last split-step (or -1)
  look: THREE.Vector3; // court point his eyes are on
  holdingBall: boolean; // a ball in his left hand (before a serve)
  greet?: GreetPose | null; // the handshake at the net before a match
}

/** The handshake at the net (game.ts drives it, rig.ts's greet() poses it). */
export interface GreetPose {
  w: number; // 0..1: standing tall at the net, racket in the left hand (0: the player he is in a match)
  reach: number; // 0..1: his right hand out to `palm`
  palm: THREE.Vector3; // court: where his palm goes
  facing: THREE.Vector3; // court: which way his palm faces (toward yours)
  grip: number; // his right fingers closed (0..1)
  pass: number; // 0..1: the racket back up in front, into both hands
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;
const smooth = (u: number) => u * u * (3 - 2 * u);
/** How far a smoothed value moves toward its target this frame (all the way when time stands still: a held pose). */
const ease = (dt: number, rate: number) => (dt > 0 ? Math.min(1, dt * rate) : 1);

// ---------------------------------------------------------------- keyframes

/** One key of a stroke (F space, for a body with its pelvis at 0.95 m; scaled to the avatar). */
interface Key {
  t: number; // seconds from contact
  ready?: boolean; // this key is the ready pose, whatever it is at the time
  S?: THREE.Vector3;
  shaft?: THREE.Vector3;
  face?: THREE.Vector3;
  L?: THREE.Vector3;
  throat?: number;
  turn?: number;
  hip?: number;
  lean?: number;
  side?: number;
  hipY?: number;
  rPole?: THREE.Vector3;
  lPole?: THREE.Vector3;
}

const FOREHAND: Key[] = [
  { t: -0.95, ready: true },
  { t: -0.62, S: v3(-0.55, 1.4, -0.05), shaft: v3(-0.3, 0.85, -0.45), face: v3(0, -0.4, 1), L: v3(-0.2, 1.25, 0.5), throat: 0.3, turn: -1.0, hip: -0.5, lean: 0.3, hipY: -0.12, rPole: v3(-0.8, -0.6, -0.4) },
  { t: -0.3, S: v3(-0.9, 1.25, -0.6), shaft: v3(-0.15, 0.55, -0.82), face: v3(-0.2, -0.6, 0.6), L: v3(-0.3, 1.3, 0.6), throat: 0, turn: -1.25, hip: -0.7, lean: 0.3, hipY: -0.16, rPole: v3(-0.7, -0.7, -0.5) },
  { t: -0.12, S: v3(-0.95, 0.68, -0.42), shaft: v3(-0.35, -0.55, -0.75), face: v3(-0.6, 0, 0.4), L: v3(0.0, 1.15, 0.45), throat: 0, turn: -0.85, hip: -0.35, lean: 0.28, hipY: -0.15, rPole: v3(-0.4, -1, -0.2) },
  { t: 0, S: v3(-0.85, 0.95, 0.4), shaft: v3(-0.95, 0.06, 0.28), face: v3(0, 0.1, 1), L: v3(0.25, 1.1, 0.25), throat: 0, turn: -0.2, hip: 0, lean: 0.25, hipY: -0.12, rPole: v3(-0.3, -1, 0) },
  { t: 0.14, S: v3(-0.3, 1.3, 0.95), shaft: v3(0.15, 0.5, 0.85), face: v3(0.6, 0.4, 0.5), L: v3(0.35, 1.05, 0.0), throat: 0, turn: 0.25, hip: 0.25, lean: 0.25, hipY: -0.1, rPole: v3(-0.5, -0.6, 0.2) },
  { t: 0.38, S: v3(0.42, 1.55, -0.2), shaft: v3(0.55, 0.3, -0.75), face: v3(0, 1, 0.2), L: v3(0.28, 1.35, 0.25), throat: 0.55, turn: 0.95, hip: 0.5, lean: 0.3, hipY: -0.1, rPole: v3(-0.2, -0.3, 1) },
  { t: 0.95, ready: true },
];

const BACKHAND: Key[] = [
  { t: -0.95, ready: true },
  { t: -0.6, S: v3(0.55, 1.32, 0.05), shaft: v3(0.35, 0.8, -0.45), face: v3(0, -0.3, -1), throat: 1, turn: 1.2, hip: 0.6, lean: 0.3, hipY: -0.12, rPole: v3(0.2, -1, 0.3) },
  { t: -0.3, S: v3(0.78, 1.25, -0.5), shaft: v3(0.25, 0.5, -0.83), face: v3(0.2, -0.5, -0.8), throat: 1, turn: 1.45, hip: 0.75, lean: 0.32, hipY: -0.16, rPole: v3(0.3, -1, 0.3) },
  { t: -0.12, S: v3(0.85, 0.62, -0.35), shaft: v3(0.3, -0.6, -0.7), face: v3(0.6, 0, -0.5), L: v3(0.22, 1.05, -0.3), throat: 0.25, turn: 1.2, hip: 0.6, lean: 0.3, hipY: -0.15, rPole: v3(0.2, -1, 0.2) },
  { t: 0, S: v3(0.76, 1.0, 0.45), shaft: v3(0.95, 0.06, 0.3), face: v3(0, 0.1, -1), L: v3(0.08, 1.15, -0.58), throat: 0, turn: 0.85, hip: 0.5, lPole: v3(0.3, -1, -0.3), lean: 0.25, hipY: -0.12, rPole: v3(0.1, -1, 0.2) },
  { t: 0.15, S: v3(0.7, 1.45, 0.8), shaft: v3(0.4, 0.75, 0.5), face: v3(0.3, 0, -1), L: v3(0.02, 1.2, -0.66), throat: 0, turn: 0.6, hip: 0.35, lPole: v3(0.3, -1, -0.3), lean: 0.25, hipY: -0.1, rPole: v3(0.3, -0.8, 0) },
  { t: 0.42, S: v3(0.62, 1.95, 0.05), shaft: v3(0.2, 0.95, -0.2), face: v3(-1, 0, -0.3), L: v3(0.12, 1.25, -0.55), throat: 0, turn: 0.35, hip: 0.2, lPole: v3(0.3, -1, -0.3), lean: 0.2, hipY: -0.08, rPole: v3(0.4, -0.5, 0.2) },
  { t: 0.95, ready: true },
];

const SERVE: Key[] = [
  { t: -1.75, S: v3(0.0, 1.05, 0.6), shaft: v3(0.1, 0.25, 0.96), face: v3(1, 0, 0), L: v3(0.02, 1.02, 0.45), throat: 0, turn: -1.0, hip: -0.9, lean: 0.12, hipY: -0.03, lPole: v3(0.6, -1, 0) },
  { t: -1.25, S: v3(-0.45, 0.72, 0.05), shaft: v3(-0.3, -0.25, -0.9), face: v3(1, 0, 0), L: v3(0.18, 0.85, 0.28), throat: 0, turn: -1.15, hip: -0.95, lean: 0.05, hipY: -0.05, rPole: v3(-0.5, -1, 0) },
  { t: -0.85, S: v3(-0.6, 1.42, -0.55), shaft: v3(-0.2, 0.45, -0.85), face: v3(-1, 0, 0), L: v3(0.18, 2.0, 0.42), throat: 0, turn: -1.2, hip: -0.9, lean: -0.1, hipY: -0.07, rPole: v3(-0.8, -0.5, -0.3), lPole: v3(1, 0, 0) },
  { t: -0.45, S: v3(-0.46, 1.86, -0.46), shaft: v3(0.15, 0.85, -0.5), face: v3(-1, 0, 0), L: v3(0.14, 2.12, 0.45), throat: 0, turn: -1.15, hip: -0.85, lean: -0.22, hipY: -0.14, rPole: v3(-1, -0.15, -0.6), lPole: v3(1, 0, 0) },
  { t: -0.15, S: v3(-0.15, 1.3, -0.48), shaft: v3(0.0, -0.85, -0.5), face: v3(-1, 0, 0), L: v3(0.2, 1.5, 0.35), throat: 0, turn: -0.7, hip: -0.6, lean: -0.1, hipY: -0.05, rPole: v3(-1, 0.6, -0.3) },
  { t: 0, S: v3(-0.14, 2.4, 0.42), shaft: v3(-0.05, 0.95, 0.3), face: v3(0, -0.15, 1), L: v3(0.25, 1.05, 0.2), throat: 0, turn: -0.1, hip: -0.3, lean: 0.15, hipY: 0.12, rPole: v3(-1, 0, 0) },
  { t: 0.18, S: v3(0.05, 1.7, 1.05), shaft: v3(0.1, 0.3, 0.95), face: v3(-0.5, -1, 0.2), L: v3(0.25, 1.0, 0.15), throat: 0, turn: 0.3, hip: 0.0, lean: 0.45, hipY: 0.0, rPole: v3(-0.6, -0.6, 0) },
  { t: 0.45, S: v3(0.55, 0.65, 0.35), shaft: v3(0.65, -0.55, -0.4), face: v3(0, 0, -1), L: v3(0.15, 1.0, 0.15), throat: 0, turn: 0.75, hip: 0.35, lean: 0.55, hipY: -0.1, rPole: v3(0, -1, 0.5) },
  { t: 1.1, ready: true },
];

// volleys: a short punch, no backswing, the racket head up and the face open a little
const FVOLLEY: Key[] = [
  { t: -0.5, ready: true },
  { t: -0.22, S: v3(-0.62, 1.25, 0.3), shaft: v3(-0.5, 0.75, 0.15), face: v3(0, 0, 1), L: v3(-0.12, 1.2, 0.62), throat: 0.2, turn: -0.55, hip: -0.25, lean: 0.32, hipY: -0.14, rPole: v3(-0.6, -1, 0) },
  { t: 0, S: v3(-0.62, 1.15, 0.55), shaft: v3(-0.7, 0.6, 0.3), face: v3(0, 0.15, 1), L: v3(0.2, 1.15, 0.35), throat: 0, turn: -0.25, hip: -0.1, lean: 0.35, hipY: -0.16, rPole: v3(-0.5, -1, 0) },
  { t: 0.15, S: v3(-0.45, 1.05, 0.85), shaft: v3(-0.5, 0.55, 0.6), face: v3(0, 0.3, 1), L: v3(0.22, 1.12, 0.3), throat: 0, turn: -0.1, hip: -0.05, lean: 0.35, hipY: -0.15, rPole: v3(-0.5, -1, 0) },
  { t: 0.55, ready: true },
];
const BVOLLEY: Key[] = [
  { t: -0.5, ready: true },
  { t: -0.22, S: v3(0.5, 1.25, 0.36), shaft: v3(0.5, 0.75, 0.15), face: v3(0, 0, -1), throat: 1, turn: 0.7, hip: 0.35, lean: 0.32, hipY: -0.14, rPole: v3(0.2, -1, 0.2) },
  { t: 0, S: v3(0.62, 1.15, 0.6), shaft: v3(0.7, 0.6, 0.35), face: v3(0, 0.15, -1), L: v3(-0.25, 1.1, -0.15), throat: 0, turn: 0.35, hip: 0.15, lean: 0.35, hipY: -0.16, rPole: v3(0.2, -1, 0.2) },
  { t: 0.15, S: v3(0.5, 1.05, 0.9), shaft: v3(0.5, 0.55, 0.6), face: v3(0, 0.3, -1), L: v3(-0.35, 1.1, -0.3), throat: 0, turn: 0.2, hip: 0.1, lean: 0.35, hipY: -0.15, rPole: v3(0.2, -1, 0.2) },
  { t: 0.55, ready: true },
];
// the overhead: the serve's trophy and throw without the toss, the left hand pointing up at the ball
const SMASH: Key[] = [
  { t: -0.9, ready: true },
  { t: -0.55, S: v3(-0.46, 1.86, -0.46), shaft: v3(0.15, 0.85, -0.5), face: v3(-1, 0, 0), L: v3(0.2, 2.05, 0.5), throat: 0, turn: -1.0, hip: -0.7, lean: -0.2, hipY: -0.12, rPole: v3(-1, -0.15, -0.6), lPole: v3(1, 0, 0) },
  { t: -0.15, S: v3(-0.15, 1.3, -0.48), shaft: v3(0.0, -0.85, -0.5), face: v3(-1, 0, 0), L: v3(0.2, 1.5, 0.35), throat: 0, turn: -0.6, hip: -0.5, lean: -0.1, hipY: -0.05, rPole: v3(-1, 0.6, -0.3) },
  { t: 0, S: v3(-0.16, 2.36, 0.4), shaft: v3(-0.05, 0.95, 0.3), face: v3(0, -0.3, 1), L: v3(0.25, 1.05, 0.2), throat: 0, turn: -0.1, hip: -0.2, lean: 0.2, hipY: 0.06, rPole: v3(-1, 0, 0) },
  { t: 0.18, S: v3(0.05, 1.6, 1.0), shaft: v3(0.1, 0.2, 0.95), face: v3(-0.5, -1, 0.2), L: v3(0.25, 1.0, 0.15), throat: 0, turn: 0.3, hip: 0.0, lean: 0.45, hipY: 0.0, rPole: v3(-0.6, -0.6, 0) },
  { t: 0.45, S: v3(0.55, 0.7, 0.35), shaft: v3(0.65, -0.55, -0.4), face: v3(0, 0, -1), L: v3(0.15, 1.0, 0.15), throat: 0, turn: 0.75, hip: 0.35, lean: 0.5, hipY: -0.1, rPole: v3(0, -1, 0.5) },
  { t: 1.0, ready: true },
];

/** Where the sweet spot is at contact for each stroke (F, for a body with its pelvis at 0.95 m): the AI stands so the
 * ball comes to it. */
export const CONTACT: Record<StrokeKind, THREE.Vector3> = {
  forehand: FOREHAND[4].S!.clone(),
  backhand: BACKHAND[4].S!.clone(),
  serve: SERVE[5].S!.clone(),
  fvolley: FVOLLEY[2].S!.clone(),
  bvolley: BVOLLEY[2].S!.clone(),
  smash: SMASH[3].S!.clone(),
};
const KEYS: Record<StrokeKind, Key[]> = { forehand: FOREHAND, backhand: BACKHAND, serve: SERVE, fvolley: FVOLLEY, bvolley: BVOLLEY, smash: SMASH };
/** How long before contact a stroke starts (seconds): the AI must be there by then. */
export const LEAD: Record<StrokeKind, number> = { forehand: 0.95, backhand: 0.95, serve: 1.75, fvolley: 0.5, bvolley: 0.5, smash: 0.9 };
/** When the ball leaves his left hand in a serve, seconds from contact. */
export const TOSS_AT = -0.85;
/** Stance for each stroke (F, ankles' ground points, for a 0.95 m pelvis), and how the feet turn. */
// standing at the net for the handshake: feet under the hips, toes a little out
const STAND = { feet: [v3(0.13, 0, 0.02), v3(-0.13, 0, 0)], yaw: [0.16, -0.16] };
const STANCE: Record<StrokeKind | "ready", { feet: [THREE.Vector3, THREE.Vector3]; yaw: [number, number] }> = {
  ready: { feet: [v3(0.31, 0, 0.02), v3(-0.31, 0, 0)], yaw: [0.28, -0.28] },
  forehand: { feet: [v3(0.36, 0, 0.12), v3(-0.42, 0, -0.12)], yaw: [-0.1, -0.85] },
  backhand: { feet: [v3(0.42, 0, -0.1), v3(-0.2, 0, 0.32)], yaw: [1.0, 0.75] },
  serve: { feet: [v3(0.1, 0, 0.3), v3(-0.28, 0, -0.12)], yaw: [-0.7, -1.4] },
  fvolley: { feet: [v3(0.3, 0, 0.22), v3(-0.3, 0, -0.05)], yaw: [-0.1, -0.6] },
  bvolley: { feet: [v3(0.3, 0, -0.05), v3(-0.25, 0, 0.25)], yaw: [0.6, 0.4] },
  smash: { feet: [v3(0.1, 0, 0.25), v3(-0.3, 0, -0.18)], yaw: [-0.6, -1.25] },
};

// ---------------------------------------------------------------- clips

// The library (public/tennis/motions/index.json, built by scripts/tennis_motion): SMPL-X neutral clips at 30 fps,
// soles on the floor, facing -Z (the serve is turned so its racket travels to -Z at contact), travel loops in place
// with their speed in the index, strokes with their contact frame. Retargeted to this avatar by leg length.

export type ClipKind = "forehand" | "backhand" | "serve" | "ready" | "run" | "shuffleLeft" | "shuffleRight" | "celebrate" | "fistPump";

export interface Clip {
  name: string;
  kind: ClipKind;
  fps: number;
  local: THREE.Quaternion[][]; // per frame, every joint (F: facing +Z)
  root: THREE.Vector3[]; // per frame, F: rootT (pelvis minus its rest position), on this body's floor
  loop: boolean;
  contact: number; // seconds into the clip (strokes), else 0
  duration: number;
  speed: number; // travel loops: their ground speed for this body (m/s)
  contactS: THREE.Vector3 | null; // strokes: the sweet spot at contact (F), with this avatar's racket in hand
  headSpeed: number; // strokes: the racket head's speed at contact in the footage (m/s)
  events: Record<string, number>; // seconds into the clip
}

const CLIP_KINDS: ClipKind[] = ["forehand", "backhand", "serve", "ready", "run", "shuffleLeft", "shuffleRight", "celebrate", "fistPump"];

interface ClipFile {
  fps?: number;
  loop?: boolean;
  frames: { root_t: number[]; root_q: number[]; pose: number[][] }[];
  contactFrame?: number;
  events?: Record<string, number>;
  contactPose?: { racketHeadVelocity?: number[] };
}
interface ClipIndex {
  fps?: number;
  body?: { restPelvis?: number[]; legLength?: number };
  clips?: Record<string, { file?: string; loop?: boolean; events?: Record<string, number>; contactFrame?: number; speed?: number; meanVelocity?: number[] }>;
}

const axisAngle = (v: number[], out: THREE.Quaternion) => {
  const a = Math.hypot(v[0], v[1], v[2]);
  if (a < 1e-12) return out.identity();
  return out.setFromAxisAngle(new THREE.Vector3(v[0] / a, v[1] / a, v[2] / a), a);
};

/** The motion library fitted to this avatar's rig. Missing or broken: an empty library (procedural motion only). */
export async function loadClips(rig: Rig, base = `${import.meta.env.BASE_URL}tennis/motions/`): Promise<Map<ClipKind, Clip>> {
  const out = new Map<ClipKind, Clip>();
  let index: ClipIndex;
  try {
    const r = await fetch(`${base}index.json`, { cache: "no-cache" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return out;
    index = (await r.json()) as ClipIndex;
  } catch {
    return out;
  }
  const restPelvis = new THREE.Vector3(...(index.body?.restPelvis ?? [0.0031, -0.3514, 0.012]));
  const legLength = index.body?.legLength ?? 0.7788;
  const R = rig.rest;
  const myLeg = (R[J.L_HIP].distanceTo(R[J.L_ANKLE]) + R[J.R_HIP].distanceTo(R[J.R_ANKLE])) / 2;
  const s = myLeg / legLength; // this body's size against the library's
  await Promise.all(
    Object.entries(index.clips ?? {}).map(async ([name, e]) => {
      const kind = CLIP_KINDS.find((k) => k === name);
      if (!kind) return;
      try {
        const r = await fetch(`${base}${e.file ?? `${name}.json`}`, { cache: "no-cache" });
        if (!r.ok) return;
        const m = (await r.json()) as ClipFile;
        if (!m.frames?.length) return;
        const clip = fitClip(rig, name, kind, m, e, restPelvis, s);
        if (clip) out.set(kind, clip);
      } catch (err) {
        console.info(`Tennis clip ${name} skipped:`, (err as Error).message);
      }
    }),
  );
  return out;
}

const TURN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // the library faces -Z, F faces +Z

function fitClip(rig: Rig, name: string, kind: ClipKind, m: ClipFile, e: NonNullable<ClipIndex["clips"]>[string], restPelvis: THREE.Vector3, s: number): Clip | null {
  const fps = m.fps ?? 30;
  const n = m.frames.length;
  const local = m.frames.map((f) => {
    const q = f.pose.map((v) => axisAngle(v, new THREE.Quaternion()));
    while (q.length < 55) q.push(new THREE.Quaternion());
    q[0] = TURN.clone().multiply(new THREE.Quaternion(f.root_q[0], f.root_q[1], f.root_q[2], f.root_q[3]).normalize()).multiply(q[0]);
    return q;
  });
  // the pelvis scaled to this body (soles stay on the floor), turned to face +Z: rootT' = s (root_t + restPelvis) - J0'
  const root = m.frames.map((f) => new THREE.Vector3(f.root_t[0], f.root_t[1], f.root_t[2]).add(restPelvis).multiplyScalar(s).applyQuaternion(TURN).sub(rig.rest[J.PELVIS]));
  // check the floor on this body: the lowest sole in the clip should be on it (a jump stays a jump)
  let low = Infinity;
  for (let i = 0; i < n; i += 2) {
    rig.fkAll(local[i], root[i]);
    low = Math.min(low, rig.P[J.L_FOOT].y, rig.P[J.R_FOOT].y);
  }
  const lift = 0.017 - low;
  if (Math.abs(lift) > 0.003) for (const t of root) t.y += lift;
  const events: Record<string, number> = {};
  for (const [k, f] of Object.entries(m.events ?? e.events ?? {})) events[k] = f / fps;
  const contactFrame = m.contactFrame ?? e.contactFrame ?? m.events?.contact;
  const stroke = kind === "forehand" || kind === "backhand" || kind === "serve";
  let contactS: THREE.Vector3 | null = null;
  if (stroke && contactFrame !== undefined) {
    rig.fkAll(local[contactFrame], root[contactFrame]);
    contactS = rig.racketP.clone().add(new THREE.Vector3(0, RACKET.headC, 0).applyQuaternion(rig.racketQ));
  }
  const hv = m.contactPose?.racketHeadVelocity;
  return {
    name,
    kind,
    fps,
    local,
    root,
    loop: !!(e.loop ?? m.loop),
    contact: contactFrame !== undefined ? contactFrame / fps : 0,
    duration: n / fps,
    speed: (e.speed ?? 0) * s,
    contactS,
    headSpeed: hv ? Math.hypot(hv[0], hv[1], hv[2]) : 0,
    events,
  };
}

/** A clip's pose at s seconds (looping, or held at its ends). */
function sampleClip(c: Clip, s: number, outLocal: THREE.Quaternion[], outRoot: THREE.Vector3) {
  const n = c.local.length;
  let f = s * c.fps;
  if (c.loop) f = ((f % n) + n) % n;
  else f = clamp(f, 0, n - 1);
  const i0 = Math.floor(f);
  const i1 = c.loop ? (i0 + 1) % n : Math.min(n - 1, i0 + 1);
  const a = f - i0;
  for (let j = 0; j < 55; j++) outLocal[j].slerpQuaternions(c.local[i0][j], c.local[i1][j], a);
  outRoot.lerpVectors(c.root[i0], c.root[i1], a);
}

/**
 * A stroke clip's clock: the footage's swings are gentle (a racket head at 5-12 m/s), so the last 0.25 s before contact
 * play `rate` times faster (the head reaches 15-20 m/s, a serve near 30) and the follow-through eases back to real
 * speed over 0.3 s. tau: seconds from contact (real); returns seconds into the clip.
 */
const WARP_IN = 0.25;
const WARP_OUT = 0.3;
function warpRate(kind: StrokeKind, c: Clip) {
  const want = kind === "serve" || kind === "smash" ? 28 : kind === "backhand" ? 16 : 17;
  return clamp(want / Math.max(3, c.headSpeed), 1, 2.8);
}
function clipClock(c: Clip, tau: number, r: number) {
  if (tau < -WARP_IN / r) return c.contact - WARP_IN + (tau + WARP_IN / r);
  if (tau <= 0) return c.contact + tau * r;
  if (tau < WARP_OUT) return c.contact + r * tau - ((r - 1) * tau * tau) / (2 * WARP_OUT);
  return c.contact + ((r + 1) / 2) * WARP_OUT + (tau - WARP_OUT);
}
/** Real seconds from a clip moment `at` (seconds into the clip, before contact) to contact. */
function realBefore(c: Clip, at: number, r: number) {
  const d = c.contact - at;
  return d <= WARP_IN ? d / r : d - WARP_IN + WARP_IN / r;
}
/** Where a stroke's clip starts (the smash: the serve from its trophy, no toss). */
function clipStart(kind: StrokeKind, c: Clip) {
  return kind === "smash" ? Math.max(0, (c.events.tossPeak ?? c.contact - 0.4) - 0.2) : 0;
}

// ---------------------------------------------------------------- the feet

/** Procedural stepping: a planted foot stays put (court space) until the body has moved on from it, then it steps. */
class Feet {
  readonly at = [new THREE.Vector3(), new THREE.Vector3()]; // court, y = lift
  readonly yaw = [0, 0];
  private planted = [new THREE.Vector3(), new THREE.Vector3()];
  private swing: ({ from: THREE.Vector3; to: THREE.Vector3; t0: number; dur: number; lift: number; yaw0: number; yaw1: number } | null)[] = [null, null];
  private started = false;
  private last = -1; // the foot that stepped last

  reset(homes: THREE.Vector3[], yaw: number[]) {
    for (const i of [0, 1]) {
      this.planted[i].copy(homes[i]).setY(0);
      this.at[i].copy(this.planted[i]);
      this.yaw[i] = yaw[i];
      this.swing[i] = null;
    }
    this.started = true;
  }

  /** homes: where each foot wants to be now (court). speed: how fast the body moves. */
  update(t: number, homes: THREE.Vector3[], yaw: number[], vel: THREE.Vector3, speed: number) {
    if (!this.started) this.reset(homes, yaw);
    const dur = clamp(0.3 - speed * 0.032, 0.13, 0.3);
    for (const i of [0, 1]) {
      const s = this.swing[i];
      if (s) {
        const u = clamp((t - s.t0) / s.dur, 0, 1);
        const e = smooth(u);
        this.at[i].lerpVectors(s.from, s.to, e).setY(Math.sin(Math.PI * u) * s.lift);
        this.yaw[i] = THREE.MathUtils.lerp(s.yaw0, s.yaw1, e);
        if (u >= 1) {
          this.planted[i].copy(s.to);
          this.swing[i] = null;
        }
        continue;
      }
      this.at[i].copy(this.planted[i]);
    }
    // the foot furthest from where it should be steps, when the other is down (or both may fly, running fast)
    const need = [0, 1].map((i) => this.planted[i].distanceTo(_h.copy(homes[i]).setY(0)) + Math.abs(this.yaw[i] - yaw[i]) * 0.08);
    const order = need[0] >= need[1] ? [0, 1] : [1, 0];
    for (const i of order) {
      if (this.swing[i]) continue;
      const other = 1 - i;
      const threshold = 0.07 + speed * 0.05;
      if (need[i] < threshold) continue;
      if (this.swing[other] && speed < 3.2) continue;
      if (this.last === i && !this.swing[other] && need[other] > threshold * 0.7) continue; // alternate
      const to = homes[i].clone().setY(0).addScaledVector(vel, dur * 0.6);
      this.swing[i] = { from: this.planted[i].clone(), to, t0: t, dur, lift: 0.05 + Math.min(0.12, speed * 0.022), yaw0: this.yaw[i], yaw1: yaw[i] };
      this.last = i;
      break;
    }
  }

  /** How airborne the feet are: 0 both planted, up to 1 mid-stride. */
  get air() {
    return Math.max(this.at[0].y, this.at[1].y) / 0.12;
  }
}
const _h = new THREE.Vector3();

// ---------------------------------------------------------------- the animator

const RUN_YAW = 1.15; // how far the body may turn toward where he runs

export class Animator {
  rig: Rig | null = null;
  clips = new Map<ClipKind, Clip>();
  readonly params = newParams();
  /** The racket (F): its butt and turn. */
  readonly racketP = new THREE.Vector3();
  readonly racketQ = new THREE.Quaternion();
  private base = newParams();
  private run = newParams();
  private key = newParams();
  private keyB = newParams();
  private feet = new Feet();
  private bodyYaw = 0;
  private runW = 0;
  private stanceKind: StrokeKind | "ready" = "ready";
  private loco: Record<LocoKind, number> = { ready: 0, shuffleLeft: 0, shuffleRight: 0, run: 0 };
  private clocks: Record<LocoKind, number> = { ready: 0, shuffleLeft: 0, shuffleRight: 0, run: 0 };
  private strokeClipW = 0;
  private cheering: { kind: "fistPump" | "celebrate"; t0: number } | null = null;
  private phase = 0;
  private strokeW = 0;
  private speed = 0;
  private greetW = 0;
  private drive: Drive | null = null;

  setRig(rig: Rig | null) {
    this.rig = rig;
  }

  /** Scale of the F-space numbers for this body (1 = a pelvis at 0.95 m). */
  get k() {
    return this.rig?.scale ?? 1;
  }

  /** Where the sweet spot is at contact for a stroke (F), on this body: a real clip's when there is one. */
  contactOffset(kind: StrokeKind): THREE.Vector3 {
    const c = this.strokeClip(kind);
    if (c?.contactS) return c.contactS.clone();
    return CONTACT[kind].clone().multiplyScalar(this.k);
  }

  /** The ready pose, the run blended over it by speed, and a split-step's hop. */
  private basePose(d: Drive, speed: number) {
    const k = this.k;
    const p = this.base;
    p.hipY = -0.1;
    p.lean = 0.32;
    p.turn = p.hip = p.side = 0;
    p.pelvis.set(0, 0, 0);
    p.S.set(0.02, 1.15, 0.74).multiplyScalar(k);
    racketTurn(_v.set(0.12, 0.6, 0.8), _f.set(1, 0, 0), p.R);
    p.throat = 1;
    p.L.set(0.25, 1.0, 0.35).multiplyScalar(k);
    p.Lq.identity();
    p.rPole.set(-0.85, -1, -0.1);
    p.lPole.set(0.85, -1, -0.1);
    p.grip = 0.85;
    // breathing and a slight bounce on the toes while waiting
    p.hipY += 0.008 * Math.sin(d.t * 2.2);
    // running: racket carried at his right, the left arm pumping, the trunk forward, the body turned to the run
    this.phase += d.dt * (2.2 + speed * 0.75);
    const r = this.run;
    copyParams(r, p);
    r.S.set(-0.32, 1.02, 0.42).multiplyScalar(k);
    racketTurn(_v.set(-0.15, 0.55, 0.8), _f.set(1, 0, 0), r.R);
    r.throat = 0;
    r.L.set(0.3, 0.98 + 0.06 * Math.sin(this.phase * Math.PI), 0.18 * Math.sin(this.phase * Math.PI)).multiplyScalar(k);
    r.lean = 0.42 + speed * 0.03;
    r.hipY = -0.1 - 0.035 * this.feet.air;
    const w = smooth(clamp((speed - 0.6) / 2.6, 0, 1));
    this.runW += (w - this.runW) * Math.min(1, d.dt * 8);
    blendParams(p, p, r, this.runW);
    // a split-step: a small hop just as the other player hits, landing wide and low
    const s = d.t - d.split;
    if (d.split >= 0 && s >= 0 && s < 0.5) p.hipY += s < 0.14 ? 0.05 * Math.sin((Math.PI * s) / 0.14) : -0.07 * Math.sin((Math.PI * (s - 0.14)) / 0.36);
    p.hip += this.bodyYaw * 0.7;
    p.turn += this.bodyYaw;
  }

  /** The stroke's keys at time t (F), blended over the base pose where a key is "ready". */
  private strokePose(st: Stroke, t: number, out: Params): number {
    const keys = KEYS[st.kind];
    const k = this.k;
    const tau = t - st.tc;
    const first = keys[0].t;
    const last = keys[keys.length - 1].t;
    if (tau <= first || tau >= last) return 0;
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t <= tau) i++;
    const ka = keys[i];
    const kb = keys[i + 1];
    const u = (tau - ka.t) / (kb.t - ka.t);
    const nominal = CONTACT[st.kind].clone().multiplyScalar(k);
    const shift = _sh.copy(st.contact).sub(nominal);
    const fill = (key: Key, o: Params) => {
      if (key.ready) return copyParams(o, this.base);
      copyParams(o, this.base);
      o.S.copy(key.S!).multiplyScalar(k).addScaledVector(shift, clamp(1 - Math.abs(key.t) / 0.4, 0, 1));
      racketTurn(key.shaft!, key.face!, o.R);
      if (key.L) o.L.copy(key.L).multiplyScalar(k);
      o.Lq.identity();
      o.throat = key.throat ?? 0;
      o.turn = key.turn ?? 0;
      o.hip = key.hip ?? 0;
      o.lean = key.lean ?? 0.3;
      o.side = key.side ?? 0;
      o.hipY = key.hipY ?? -0.1;
      // a low ball (a half-volley, a ball at the shoelaces): down into the knees and over it
      const near = clamp(1 - Math.abs(key.t) / 0.45, 0, 1);
      const low = Math.max(0, 0.85 * k - st.contact.y);
      o.hipY -= low * 0.5 * near;
      o.lean += low * 0.5 * near;
      if (key.rPole) o.rPole.copy(key.rPole);
      if (key.lPole) o.lPole.copy(key.lPole);
      o.pelvis.set(0, 0, 0);
      return o;
    };
    // a Hermite curve through the keys for the sweet spot (so the swing arcs), eased blends for the rest
    fill(ka, this.key);
    fill(kb, this.keyB);
    const e = smooth(u);
    blendParams(out, this.key, this.keyB, e);
    // the left hand goes back to the throat only once the racket is back in front of him (never through his chest)
    if (kb.ready && this.keyB.throat > this.key.throat) out.throat = this.key.throat + (this.keyB.throat - this.key.throat) * e * e * e;
    const prev = keys[Math.max(0, i - 1)];
    const next = keys[Math.min(keys.length - 1, i + 2)];
    const pPrev = prev === ka ? this.key.S.clone() : fill(prev, newParams()).S.clone();
    const pNext = next === kb ? this.keyB.S.clone() : fill(next, newParams()).S.clone();
    const dt = kb.t - ka.t;
    const m0 = this.keyB.S.clone().sub(pPrev).multiplyScalar(dt / Math.max(1e-3, kb.t - prev.t));
    const m1 = pNext.sub(this.key.S).multiplyScalar(dt / Math.max(1e-3, next.t - ka.t));
    const u2 = u * u;
    const u3 = u2 * u;
    out.S.copy(this.key.S).multiplyScalar(2 * u3 - 3 * u2 + 1)
      .addScaledVector(m0, u3 - 2 * u2 + u)
      .addScaledVector(this.keyB.S, -2 * u3 + 3 * u2)
      .addScaledVector(m1, u3 - u2);
    // in and out of the stroke softly
    const inW = smooth(clamp((tau - first) / 0.2, 0, 1));
    const outW = smooth(clamp((last - tau) / 0.25, 0, 1));
    return Math.min(inW, outW);
  }

  /** One frame: the pose's params for what the AI is doing (then apply() poses the body). */
  update(d: Drive) {
    const k = this.k;
    const speed = Math.hypot(d.vel.x, d.vel.z);
    // the body turns toward a long run (not when backing up)
    let want = 0;
    if (speed > 2.2 && !d.stroke) {
      const th = Math.atan2(d.vel.x, d.vel.z);
      if (Math.abs(th) < 2.2) want = clamp(th, -RUN_YAW, RUN_YAW) * smooth(clamp((speed - 2.2) / 2, 0, 1));
    }
    this.bodyYaw += (want - this.bodyYaw) * Math.min(1, d.dt * 6);
    this.basePose(d, speed);

    // the stroke over the base
    const p = this.params;
    copyParams(p, this.base);
    let strokeW = 0;
    if (d.stroke) {
      strokeW = this.strokePose(d.stroke, d.t, _stroke);
      if (strokeW > 0) blendParams(p, this.base, _stroke, strokeW);
    }
    // the stance: during a stroke its own, else ready (wider when he's low after a split)
    const st = d.stroke && strokeW > 0.05 ? d.stroke.kind : "ready";
    this.stanceKind = st;
    const S = STANCE[st];
    const turn = this.bodyYaw;
    // at the net for the handshake: standing tall, feet under the hips, the athletic crouch gone
    const gw = st === "ready" ? clamp(d.greet?.w ?? 0, 0, 1) : 0;
    this.greetW = clamp(d.greet?.w ?? 0, 0, 1);
    if (this.greetW > 0) {
      const e = smooth(this.greetW);
      p.hipY += (-0.02 + 0.004 * Math.sin(d.t * 1.7) - p.hipY) * e;
      p.lean += (0.07 + 0.12 * (d.greet?.reach ?? 0) - p.lean) * e; // leaning in a little to shake
      // the racket (once it's back in both hands) held up close in front of his chest, not out over the net at you
      p.S.lerp(_v.set(0.0, 1.28, 0.34).multiplyScalar(k), e);
      p.R.slerp(racketTurn(_v.set(0.04, 0.88, 0.47), _f.set(1, 0, 0), _q), e);
      p.turn *= 1 - e;
      p.hip *= 1 - e;
      p.side *= 1 - e;
    }
    const homes = [0, 1].map((i) => {
      const f = _hv[i].copy(S.feet[i]);
      if (gw > 0) f.lerp(STAND.feet[i], smooth(gw));
      f.multiplyScalar(k);
      if (st === "ready") f.applyAxisAngle(_up, turn);
      return f.add(d.ground);
    });
    const yaw = [0, 1].map((i) => THREE.MathUtils.lerp(S.yaw[i], STAND.yaw[i], smooth(gw)) + (st === "ready" ? turn : 0));
    // a serve's feet stay where they are from the toss until he lands
    this.feet.update(d.t, homes, yaw, d.vel, speed);
    for (const i of [0, 1]) {
      p.feet[i].copy(this.feet.at[i]).sub(_g.copy(d.ground).setY(0));
      p.footYaw[i] = this.feet.yaw[i];
    }
    p.look.copy(d.look).sub(_g.copy(d.ground).setY(0));
    if (d.holdingBall && (!d.stroke || d.t - d.stroke.tc < TOSS_AT)) p.L.set(0.15, 1.0, 0.42).multiplyScalar(k).lerp(p.L, strokeW);

    this.strokeW = strokeW;
    this.drive = d;
    this.speed = speed;
    // no body (yet): the racket alone follows the keys
    this.racketQ.copy(p.R);
    this.racketP.copy(p.S).sub(_v.set(0, RACKET.headC, 0).applyQuaternion(p.R));
  }

  /** How long before contact a stroke starts (real seconds): a clip's (warped) lead when there is one. */
  lead(kind: StrokeKind) {
    const c = this.strokeClip(kind);
    return c ? realBefore(c, clipStart(kind, c), warpRate(kind, c)) + 0.05 : LEAD[kind];
  }

  /** When the ball leaves his hand in a serve, seconds from contact (negative). */
  tossAt() {
    const c = this.clips.get("serve");
    return c && c.events.tossRelease !== undefined ? -realBefore(c, c.events.tossRelease, warpRate("serve", c)) : TOSS_AT;
  }

  /** A celebration (a fist pump after a game, the whole thing after the match), played once. */
  cheer(kind: "fistPump" | "celebrate", t: number) {
    if (this.clips.get(kind)) this.cheering = { kind, t0: t };
  }

  private strokeClip(kind: StrokeKind): Clip | undefined {
    if (kind === "smash") return this.clips.get("serve");
    if (kind === "forehand" || kind === "backhand" || kind === "serve") return this.clips.get(kind);
    return undefined; // volleys: a short procedural punch
  }

  /**
   * Pose the body for this frame: into `local` (the avatar's own motion frame, so its fingers start relaxed every
   * frame) and rootT. Call it from SkinnedAvatar.pose's edit hook. The procedural pose first, then the real clips over
   * it: ready, a shuffle (its playback matched to his speed so the feet don't slide), a run turned to where he runs,
   * a stroke on its warped clock with its contact on the ball, a celebration. Updates the racket from the posed hand.
   */
  apply(local: THREE.Quaternion[], rootT: THREE.Vector3) {
    const d = this.drive;
    const rig = this.rig;
    if (!rig || !d) return;
    rig.solve(local, rootT, this.params);
    // the handshake at the net goes over whatever the body is doing
    const greet = () => {
      const g = d.greet;
      if (g && g.w > 0.001) {
        _gp.copy(g.palm).sub(_g.copy(d.ground).setY(0));
        rig.greet(local, rootT, { w: g.w, reach: g.reach, palm: _gp, facing: g.facing, grip: g.grip, pass: g.pass });
      }
      this.racketP.copy(rig.racketP);
      this.racketQ.copy(rig.racketQ);
    };
    if (!this.clips.size) return greet();
    const dt = d.dt;
    const speed = this.speed;
    const vx = d.vel.x;
    const vz = d.vel.z;
    // what his legs should be doing
    const want: Record<LocoKind, number> = { ready: 0, shuffleLeft: 0, shuffleRight: 0, run: 0 };
    const strokeClip = d.stroke ? this.strokeClip(d.stroke.kind) : undefined;
    const procStroke = !!d.stroke && !strokeClip && this.strokeW > 0.02;
    const shuffle = this.clips.get(vx > 0 ? "shuffleLeft" : "shuffleRight");
    const cap = shuffle ? shuffle.speed * SHUFFLE_RATE_MAX : 0;
    if (!procStroke && !this.cheering) {
      if (speed < 0.3) want.ready = 1;
      else if (shuffle && Math.abs(vx) > Math.abs(vz) * 1.2 && speed <= cap) want[vx > 0 ? "shuffleLeft" : "shuffleRight"] = 1;
      else if (this.clips.get("run") && speed > 1.2 && !(vz < -0.3 && speed < 3)) want.run = 1;
      // else: backing up, or between: the procedural steps
    }
    let total = 0;
    for (const kind of LOCO) {
      const c = this.clips.get(kind);
      const w = (this.loco[kind] += ((c ? want[kind] : 0) - this.loco[kind]) * ease(dt, 7));
      if (!c) continue;
      // each loop runs on its own clock, at the rate that makes its feet match the ground speed
      const rate = kind === "ready" ? 1 : kind === "run" ? clamp(speed / Math.max(0.5, c.speed), 0.6, 1.9) : clamp(speed / Math.max(0.1, c.speed), 0.5, SHUFFLE_RATE_MAX);
      this.clocks[kind] += dt * rate;
      if (w < 0.01) continue;
      sampleClip(c, this.clocks[kind], _cl, _cr);
      if (kind === "run") {
        // turned to where he's going (the clip runs toward his front)
        _q.setFromAxisAngle(_up, Math.atan2(vx, vz) || 0);
        _cl[0].premultiply(_q);
      }
      total = blendInto(_pose, _proot, _cl, _cr, total, w);
    }
    // layers over the legs' blend: the stroke (dominant while it lasts), then a celebration
    const locoW = Math.min(1, this.loco.ready + this.loco.shuffleLeft + this.loco.shuffleRight + this.loco.run);
    let have = total > 0;
    let rest = 1 - (have ? locoW : 0); // how much of the procedural pose is left
    const layer = (w: number) => {
      if (w <= 0.001) return;
      if (!have) {
        for (let j = 0; j < 55; j++) _pose[j].copy(_cl[j]);
        _proot.copy(_cr);
        have = true;
      } else {
        for (let j = 0; j < 55; j++) _pose[j].slerp(_cl[j], w);
        _proot.lerp(_cr, w);
      }
      rest *= 1 - w;
    };
    const sw = strokeClip && d.stroke ? this.strokeWeight(d.stroke, strokeClip) : 0;
    this.strokeClipW += (sw - this.strokeClipW) * ease(dt, sw > this.strokeClipW ? 30 : 8);
    if (strokeClip && d.stroke && this.strokeClipW > 0.01) {
      sampleClip(strokeClip, clipClock(strokeClip, d.t - d.stroke.tc, warpRate(d.stroke.kind, strokeClip)), _cl, _cr);
      // the whole body shifted so the clip's contact lands on the ball (an overhead: moved under it)
      if (strokeClip.contactS) _cr.add(_sh.copy(d.stroke.contact).sub(strokeClip.contactS).setY(0));
      layer(this.strokeClipW);
    }
    if (this.cheering) {
      const c = this.clips.get(this.cheering.kind)!;
      const u = d.t - this.cheering.t0;
      if (u > c.duration) this.cheering = null;
      else {
        sampleClip(c, u, _cl, _cr);
        _cr.x = _cr.z = 0;
        layer(smooth(clamp(u / 0.3, 0, 1)) * smooth(clamp((c.duration - u) / 0.4, 0, 1)));
      }
    }
    const W = (1 - rest) * (1 - smooth(this.greetW)); // at the net for the handshake he stands as he is, not in a clip
    if (have && W > 0.01) {
      // a split-step's hop rides on top of whatever the legs are doing
      const sp = d.t - d.split;
      if (d.split >= 0 && sp >= 0 && sp < 0.5 && !d.stroke) _proot.y += sp < 0.14 ? 0.05 * Math.sin((Math.PI * sp) / 0.14) : -0.06 * Math.sin((Math.PI * (sp - 0.14)) / 0.36);
      for (let j = 0; j < 55; j++) if (local[j]) local[j].slerp(_pose[j], W);
      rootT.lerp(_proot, W);
      rig.fkAll(local, rootT);
      // on the move the racket is carried head up (the footage's arm swings it low, into a leg)
      const moving = (this.loco.run + this.loco.shuffleLeft + this.loco.shuffleRight) * (1 - this.strokeClipW);
      if (moving > 0.01) rig.carryRacket(local, rootT, Math.min(1, moving), this.loco.run > 0.5 ? Math.atan2(vx, vz) || 0 : 0);
      rig.fixClip(local, rootT); // the footage's arms and our racket kept out of this body
    }
    greet();
  }

  /** How much of the stroke clip is on now: in over its first moments, out at its end. */
  private strokeWeight(st: Stroke, c: Clip) {
    const r = warpRate(st.kind, c);
    const cs = clipClock(c, this.drive!.t - st.tc, r);
    const from = clipStart(st.kind, c);
    if (cs < from || cs > c.duration) return 0;
    return smooth(clamp((cs - from) / 0.2, 0, 1)) * smooth(clamp((c.duration - cs) / 0.35, 0, 1));
  }

  /** The ball in his left hand (F), when he's holding one. */
  leftBall(out: THREE.Vector3) {
    if (this.rig) return this.rig.leftBall(out);
    return out.set(0.15, 1.05, 0.42).multiplyScalar(this.k);
  }

  /** Forget planted feet (he was moved, between points), and stand in a stance (ready by default). */
  resetFeet(ground: THREE.Vector3, kind: StrokeKind | "ready" = "ready") {
    const k = this.k;
    const S = STANCE[kind];
    this.feet.reset(S.feet.map((f) => f.clone().multiplyScalar(k).add(ground)), S.yaw);
  }

  get stance() {
    return this.stanceKind;
  }
}

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();
const _r = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sh = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _hv = [new THREE.Vector3(), new THREE.Vector3()];
const _gp = new THREE.Vector3();
const _stroke = newParams();
type LocoKind = "ready" | "shuffleLeft" | "shuffleRight" | "run";
const LOCO: LocoKind[] = ["ready", "shuffleLeft", "shuffleRight", "run"];
const SHUFFLE_RATE_MAX = 3.2; // a shuffle played faster than this would show its feet sliding: he runs instead
const _cl: THREE.Quaternion[] = Array.from({ length: 55 }, () => new THREE.Quaternion());
const _cr = new THREE.Vector3();
const _pose: THREE.Quaternion[] = Array.from({ length: 55 }, () => new THREE.Quaternion());
const _proot = new THREE.Vector3();
/** Accumulate a weighted pose (a running normalized blend). Returns the new total weight. */
function blendInto(pose: THREE.Quaternion[], root: THREE.Vector3, l: THREE.Quaternion[], r: THREE.Vector3, total: number, w: number) {
  if (w <= 0) return total;
  const t = total + w;
  const a = w / t;
  if (total <= 0) {
    for (let j = 0; j < 55; j++) pose[j].copy(l[j]);
    root.copy(r);
  } else {
    for (let j = 0; j < 55; j++) pose[j].slerp(l[j], a);
    root.lerp(r, a);
  }
  return t;
}
