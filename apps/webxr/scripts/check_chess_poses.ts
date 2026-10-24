// Checks the seated chess opponent (src/chess/seated.ts) for anything passing through anything, and for joints turned
// further than the avatar's skin renders well. It runs the real SeatedOpponent on a real avatar bundle (its skeleton,
// skin and Gaussians from dreams/<id>/avatar), in the scene game.ts builds (table at 0.75 m, the board, the clock at
// the player's right, captured pieces at their left, the chair), through:
//   1. every idle pose (each side, two variants), held for a few seconds while the eyes move between board and player
//      (poses the avatar is never given are reported, not failed);
//   2. every transition between the poses it can be given;
//   3. a reach sweep: a piece picked up on each of the 64 squares and carried, then the clock pressed (as black, and
//      as white unless --quick);
//   4. the handshake at the start of a game: shaken, left hanging, a pinch held up to their hand (never a shake), and no
//      tracked hand at all (no offer: a nod and on with the game);
//   5. whole games (random legal moves for both sides, the opponent as black and as white), with captures beside the
//      board, castling, the clock, the king tipped over, and the handshake.
// Every frame the arms are posed through the avatar's own skinning and tested two ways:
//   capsules: fingers (3 per finger + a tip), palm, forearm (tapered) and upper arm, radii measured from the avatar's
//     Gaussians, against the board, the table top (seated.ts's TABLE_TOP / TABLE_EDGE), every piece by its real lathe
//     profile (pieces.ts; the one in the hand is measured on its own: fingers inside the piece they hold), the clock,
//     the chair's seat, back and posts, and the body's own torso and head (body.ts's measured blocks) and thighs; the
//     thighs against the table's underside;
//   gaussians: the hand and forearm Gaussians skinned with dual quaternions (as the viewer renders them) against the
//     same, and the trunk's and head's against the chair, the table, the board, the pieces and the clock; reported as
//     the 8th deepest so a stray floater doesn't count.
// And the joints: elbow flexion, forearm and wrist twist, wrist flexion and deviation, how far the shoulder joint has
// the arm raised and twisted, the collar, the neck, and how far the head is thrown back. Fails on any penetration over
// 5 mm or a joint past its limit. Writes a JSON report with the worst frame of each.
//   node scripts/check_chess_poses.ts [avatar ids...] [--quick] [--games 4] [--only idle,transition,reach,handshake,game]
//        [--json out.json] [--trace "<scenario text>"] [--pose] (rest pose numbers) [--pinch] (pinch weights)
import { registerHooks } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import * as THREE from "three";
import { Chess } from "chess.js";

// src/ is written for Vite (extensionless imports, parameter properties): resolve and transpile it on the fly
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = pathToFileURL(resolve(HERE, "../src")).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/.test(spec) && ctx.parentURL?.startsWith(SRC)) return next(spec + ".ts", ctx);
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith(SRC) || !url.endsWith(".ts")) return next(url, ctx);
    const text = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const seatedModule = await import("../src/chess/seated.ts");
const { SeatedOpponent } = seatedModule;
// (the table as seated.ts defines it; older versions of it didn't, and had this one in mind)
const TABLE_TOP: number = (seatedModule as Record<string, unknown>).TABLE_TOP as number ?? -0.012;
const TABLE_EDGE: number = (seatedModule as Record<string, unknown>).TABLE_EDGE as number ?? 0.398;
const TABLE_NEAR: number = (seatedModule as Record<string, unknown>).TABLE_NEAR as number ?? 0.45;
const TABLE_HALF_X: number = (seatedModule as Record<string, unknown>).TABLE_HALF_X as number ?? 0.6;
const TABLE_THICK: number = (seatedModule as Record<string, unknown>).TABLE_THICK as number ?? 0.04;
const { BodyShape } = await import("../src/chess/body.ts");
const { SQUARE, squareToLocal, pieceHeight, pieceRadius: pieceRadiusOf } = await import("../src/chess/pieces.ts");

const pieceRadius = (type: string, _h: number, y: number, dx = 1, dz = 0) => pieceRadiusOf(type as never, y, dx, dz);
const person = await import("../src/chess/person.ts");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const QUICK = flag("--quick");
const GAMES = Number(opt("--games", QUICK ? "2" : "4"));
const JSON_OUT = opt("--json", "");
const TRACE = opt("--trace", "");
const ONLY = new Set(opt("--only", "idle,transition,reach,handshake,game").split(","));
const ids = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--games", "--json", "--only", "--trace"].includes(args[i - 1])));
const AVATARS = ids.length ? ids : ["magnus-carlsen-uika-360", "bobby-fischer-uika"];
const DREAMS = process.env.LUCID_DREAMS ?? resolve(HERE, "../../../dreams");
const LIMIT = 0.005; // meters of penetration that fail
const HZ = 30;

// ---------------- the avatar bundle ----------------

interface Bundle {
  skeleton: { joints: string[]; parents: number[]; rest: number[][] };
  motion: { fps: number; frames: { root_t: number[]; root_q: number[]; pose: number[][] }[] };
  n: number;
  pos: Float32Array; // rest centres
  opacity: Float32Array; // 0..1
  bone: Uint8Array; // 4 per Gaussian
  weight: Float32Array; // 4 per Gaussian, sum 1
  dominant: Uint8Array;
}

function loadBundle(id: string): Bundle {
  const dir = resolve(DREAMS, id, "avatar");
  const skeleton = JSON.parse(readFileSync(resolve(dir, "skeleton.json"), "utf8"));
  const motion = JSON.parse(readFileSync(resolve(dir, "motion.json"), "utf8"));
  const buf = readFileSync(resolve(dir, "avatar.ply"));
  const end = buf.indexOf("end_header\n") + "end_header\n".length;
  const header = buf.subarray(0, end).toString("latin1");
  const n = Number(/element vertex (\d+)/.exec(header)![1]);
  const props = [...header.matchAll(/property (\w+) (\w+)/g)].map((m) => m[2]);
  if ([...header.matchAll(/property (\w+) /g)].some((m) => m[1] !== "float")) throw new Error("only float PLY properties");
  const stride = props.length * 4;
  const ix = props.indexOf("x");
  const io = props.indexOf("opacity");
  const dv = new DataView(buf.buffer, buf.byteOffset + end, n * stride);
  const pos = new Float32Array(n * 3);
  const opacity = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = dv.getFloat32(i * stride + (ix + k) * 4, true);
    opacity[i] = 1 / (1 + Math.exp(-dv.getFloat32(i * stride + io * 4, true)));
  }
  const skin = readFileSync(resolve(dir, "skin.bin"));
  if (skin.length !== n * 8) throw new Error(`skin.bin has ${skin.length / 8} records for ${n} Gaussians`);
  const bone = new Uint8Array(n * 4);
  const weight = new Float32Array(n * 4);
  const dominant = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let best = -1;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      bone[i * 4 + k] = skin[i * 8 + k];
      weight[i * 4 + k] = skin[i * 8 + 4 + k];
      sum += skin[i * 8 + 4 + k];
      if (skin[i * 8 + 4 + k] > best) {
        best = skin[i * 8 + 4 + k];
        dominant[i] = skin[i * 8 + k];
      }
    }
    for (let k = 0; k < 4; k++) weight[i * 4 + k] /= sum || 1;
  }
  return { skeleton, motion, n, pos, opacity, bone, weight, dominant };
}

const axisAngle = (v: number[]) => {
  const a = Math.hypot(v[0], v[1], v[2]);
  return a < 1e-12 ? new THREE.Quaternion() : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(v[0] / a, v[1] / a, v[2] / a), a);
};

/** Stands in for avatar.ts's SkinnedAvatar: poses the rig the same way and keeps every joint's transform. */
class FakeAvatar {
  mesh: THREE.Object3D;
  b: Bundle;
  frames: THREE.Quaternion[][];
  rootTs: THREE.Vector3[];
  rest: THREE.Vector3[];
  local: THREE.Quaternion[] = [];
  G: THREE.Quaternion[] = [];
  P: THREE.Vector3[] = [];
  constructor(b: Bundle) {
    this.b = b;
    this.rest = b.skeleton.rest.map((r) => new THREE.Vector3(r[0], r[1], r[2]));
    this.frames = b.motion.frames.map((f) => {
      const q = f.pose.map(axisAngle);
      q[0] = new THREE.Quaternion(f.root_q[0], f.root_q[1], f.root_q[2], f.root_q[3]).normalize().multiply(q[0]);
      return q;
    });
    this.rootTs = b.motion.frames.map((f) => new THREE.Vector3(f.root_t[0], f.root_t[1], f.root_t[2]));
    const mesh = new THREE.Object3D() as THREE.Object3D & Record<string, unknown>;
    const skinData = new Uint16Array(b.n * 4);
    for (let i = 0; i < b.n * 4; i++) skinData[i] = Math.round(b.weight[i] * 255) | (b.bone[i] << 8);
    mesh.skinning = { skinData };
    const c = new THREE.Vector3();
    mesh.forEachSplat = (cb: (i: number, center: THREE.Vector3, s: unknown, q: unknown, o: number) => void) => {
      for (let i = 0; i < b.n; i++) cb(i, c.set(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]), null, null, b.opacity[i]);
    };
    this.mesh = mesh;
  }
  pose(t: number, edit?: (local: THREE.Quaternion[], rootT: THREE.Vector3, s: Bundle["skeleton"]) => void) {
    const n = this.frames.length;
    const f = (((t * this.b.motion.fps) % n) + n) % n;
    const i0 = Math.floor(f);
    const i1 = (i0 + 1) % n;
    const local = this.frames[i0].map((q, j) => q.clone().slerp(this.frames[i1][j], f - i0));
    const rootT = this.rootTs[i0].clone().lerp(this.rootTs[i1], f - i0);
    edit?.(local, rootT, this.b.skeleton);
    const par = this.b.skeleton.parents;
    this.local = local;
    for (let j = 0; j < par.length; j++) {
      const p = par[j];
      if (p < 0) {
        this.G[j] = local[j].clone();
        this.P[j] = this.rest[j].clone().add(rootT);
      } else {
        this.G[j] = this.G[p].clone().multiply(local[j]);
        this.P[j] = this.rest[j].clone().sub(this.rest[p]).applyQuaternion(this.G[p]).add(this.P[p]);
      }
    }
  }
}

// ---------------- geometry ----------------

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _d = v3();
/** Signed distance from p to an axis-aligned box (centre c, half extents h). */
function sdBox(p: THREE.Vector3, c: THREE.Vector3, h: THREE.Vector3) {
  const qx = Math.abs(p.x - c.x) - h.x;
  const qy = Math.abs(p.y - c.y) - h.y;
  const qz = Math.abs(p.z - c.z) - h.z;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}
/** Signed distance from p to an upright cylinder (axis at x, z; radius r; from y0 to y1). */
function sdCyl(p: THREE.Vector3, x: number, z: number, r: number, y0: number, y1: number) {
  const dr = Math.hypot(p.x - x, p.z - z) - r;
  const dy = Math.max(y0 - p.y, p.y - y1);
  return Math.hypot(Math.max(dr, 0), Math.max(dy, 0)) + Math.min(Math.max(dr, dy), 0);
}
function sdSeg(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number) {
  _d.copy(b).sub(a);
  const t = THREE.MathUtils.clamp(_d.dot(v3().copy(p).sub(a)) / Math.max(_d.lengthSq(), 1e-12), 0, 1);
  return p.distanceTo(v3().copy(a).addScaledVector(_d, t)) - r;
}

interface Obstacle {
  name: string;
  sd: (p: THREE.Vector3) => number; // table-local
  lo: THREE.Vector3; // bounds, table-local
  hi: THREE.Vector3;
  piece?: THREE.Object3D;
}
const boxObs = (name: string, c: THREE.Vector3, h: THREE.Vector3): Obstacle => ({ name, sd: (p) => sdBox(p, c, h), lo: c.clone().sub(h), hi: c.clone().add(h) });

// SMPL-X joints
const L_SH = 16, R_SH = 17, L_EL = 18, R_EL = 19, L_WR = 20, R_WR = 21;
const FINGER_BASE = [25, 40]; // index1 of each hand; then middle, pinky, ring, thumb in threes
const FINGERS = ["index", "middle", "pinky", "ring", "thumb"];

interface Capsule {
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number; // radius at a
  rb?: number; // at b, if it tapers
  part: string; // e.g. "R index", "L palm", "R forearm"
  finger: boolean; // a finger or the palm (may touch what it holds)
}

/** Radii measured from the avatar's Gaussians (rest pose), so a thick sleeve or a big hand is tested as it is. */
interface Radii {
  finger: number[][]; // [side][finger]
  tip: number[][]; // how far each fingertip reaches past its last joint
  palm: number[];
  forearm: number[];
  cuff: number[];
  upper: number[];
  thigh: number[];
}

function pct(a: number[], q: number) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

function measureRadii(b: Bundle, rest: THREE.Vector3[]): Radii {
  const byBone = new Map<number, THREE.Vector3[]>();
  for (let i = 0; i < b.n; i++) {
    if (b.opacity[i] < 0.3) continue;
    const j = b.dominant[i];
    if (!byBone.has(j)) byBone.set(j, []);
    byBone.get(j)!.push(v3(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]));
  }
  const radial = (bones: number[], a: THREE.Vector3, c: THREE.Vector3, q: number, lo: number, hi: number, def: number) => {
    const d = bones.flatMap((j) => byBone.get(j) ?? []).map((p) => sdSeg(p, a, c, 0));
    const r = d.length > 20 ? pct(d, q) : def;
    return THREE.MathUtils.clamp(Number.isFinite(r) ? r : def, lo, hi);
  };
  const out: Radii = { finger: [[], []], tip: [[], []], palm: [0, 0], forearm: [0, 0], cuff: [0, 0], upper: [0, 0], thigh: [0, 0] };
  for (const side of [0, 1]) {
    const base = FINGER_BASE[side];
    for (let f = 0; f < 5; f++) {
      const j1 = base + 3 * f;
      const j3 = j1 + 2;
      const dir = rest[j3].clone().sub(rest[j3 - 1]).normalize();
      const along = (byBone.get(j3) ?? []).map((p) => p.clone().sub(rest[j3]).dot(dir));
      out.tip[side][f] = THREE.MathUtils.clamp(along.length > 10 ? pct(along, 0.95) : 0.02, 0.012, 0.032);
      const tip = rest[j3].clone().addScaledVector(dir, out.tip[side][f]);
      const d = [j1, j1 + 1, j3].flatMap((j) => byBone.get(j) ?? []).map((p) => Math.min(sdSeg(p, rest[j1], rest[j1 + 1], 0), sdSeg(p, rest[j1 + 1], rest[j3], 0), sdSeg(p, rest[j3], tip, 0)));
      out.finger[side][f] = THREE.MathUtils.clamp(d.length > 20 ? pct(d, 0.8) : 0.008, 0.006, 0.014);
    }
    const wr = side === 0 ? L_WR : R_WR;
    const palmPts = byBone.get(wr) ?? [];
    const d = palmPts.map((p) => Math.min(...[0, 1, 2, 3].map((f) => sdSeg(p, rest[wr], rest[base + 3 * f], 0))));
    out.palm[side] = THREE.MathUtils.clamp(d.length > 20 ? pct(d, 0.8) : 0.014, 0.01, 0.022);
    const [sh, el] = side === 0 ? [L_SH, L_EL] : [R_SH, R_EL];
    out.forearm[side] = radial([el], rest[el], rest[wr], 0.85, 0.03, 0.08, 0.045);
    {
      const ax = rest[wr].clone().sub(rest[el]);
      const len = ax.length();
      ax.divideScalar(len);
      const d = (byBone.get(el) ?? []).filter((p) => p.clone().sub(rest[el]).dot(ax) > 0.7 * len).map((p) => sdSeg(p, rest[el], rest[wr], 0));
      out.cuff[side] = THREE.MathUtils.clamp(d.length > 20 ? pct(d, 0.85) : out.forearm[side] * 0.75, 0.02, out.forearm[side]);
    }
    out.upper[side] = radial([sh], rest[sh], rest[el], 0.85, 0.035, 0.09, 0.055);
    const [hip, knee] = side === 0 ? [1, 4] : [2, 5];
    out.thigh[side] = radial([hip], rest[hip], rest[knee], 0.85, 0.05, 0.12, 0.08);
  }
  return out;
}

/** The arms' capsules this frame, table-local. */
function armCapsules(G: THREE.Quaternion[], P: THREE.Vector3[], toT: THREE.Matrix4, R: Radii, rest: THREE.Vector3[]): Capsule[] {
  const at = (p: THREE.Vector3) => p.clone().applyMatrix4(toT);
  const caps: Capsule[] = [];
  for (const side of [0, 1]) {
    const S = side === 0 ? "L" : "R";
    const [sh, el, wr] = side === 0 ? [L_SH, L_EL, L_WR] : [R_SH, R_EL, R_WR];
    caps.push({ a: at(P[sh]), b: at(P[el]), r: R.upper[side], part: `${S} upper arm`, finger: false });
    caps.push({ a: at(P[el]), b: at(P[wr]), r: R.forearm[side], rb: R.cuff[side], part: `${S} forearm`, finger: false });
    const base = FINGER_BASE[side];
    for (let f = 0; f < 5; f++) {
      const j1 = base + 3 * f;
      const j3 = j1 + 2;
      const restDir = rest[j3].clone().sub(rest[j3 - 1]).normalize();
      const r = R.finger[side][f];
      // the tip ball's centre a radius short of the furthest the finger's Gaussians reach
      const tip = restDir.multiplyScalar(Math.max(R.tip[side][f] - r, 0.004)).applyQuaternion(G[j3]).add(P[j3]);
      caps.push({ a: at(P[j1]), b: at(P[j1 + 1]), r, part: `${S} ${FINGERS[f]}`, finger: true });
      caps.push({ a: at(P[j1 + 1]), b: at(P[j3]), r, part: `${S} ${FINGERS[f]}`, finger: true });
      caps.push({ a: at(P[j3]), b: at(tip), r, part: `${S} ${FINGERS[f]} tip`, finger: true });
      if (f < 4) caps.push({ a: at(P[wr]), b: at(P[j1]), r: R.palm[side], part: `${S} palm`, finger: true });
    }
  }
  return caps;
}

/** Deepest penetration of a capsule into an obstacle (sampled every 4 mm along it). */
function capsuleDepth(c: Capsule, o: Obstacle) {
  const r = Math.max(c.r, c.rb ?? c.r);
  if (Math.min(c.a.x, c.b.x) - r > o.hi.x || Math.max(c.a.x, c.b.x) + r < o.lo.x) return 0;
  if (Math.min(c.a.y, c.b.y) - r > o.hi.y || Math.max(c.a.y, c.b.y) + r < o.lo.y) return 0;
  if (Math.min(c.a.z, c.b.z) - r > o.hi.z || Math.max(c.a.z, c.b.z) + r < o.lo.z) return 0;
  const n = Math.max(1, Math.ceil(c.a.distanceTo(c.b) / 0.004));
  let best = 0;
  const p = v3();
  for (let i = 0; i <= n; i++) {
    p.lerpVectors(c.a, c.b, i / n);
    best = Math.max(best, THREE.MathUtils.lerp(c.r, c.rb ?? c.r, i / n) - o.sd(p));
  }
  return best;
}

// ---------------- joint limits ----------------

const LIMITS = {
  elbowFlex: 2.45, // radians: the inner elbow's Gaussians fold into each other past about 140 degrees
  supMin: -0.6, // forearm twist at the elbow joint, + = toward palm up (supination) from the rest pose's palm down
  supMax: 1.75,
  wristTwist: 0.4,
  wristFlex: 1.2,
  wristExt: 0.9,
  wristDev: 0.5,
  shoulderElev: 2.15, // upper arm raised from hanging at the shoulder joint, radians (123 degrees, reaching the far rank; past it the shoulder folds)
  humerusTwist: 1.8, // the upper arm turned about itself from the rest pose (an elbow down in front of the body is about 1.6)
  neck: 0.6,
  headVsChest: 1.05,
  headBack: 0.35, // the face tipped up past the chest's forward (20 degrees: further, the neck stretches)
  collar: 0.66, // clavicle raised and drawn forward together (about 38 degrees, reaching the far rank)
  spine: 0.5,
};

function twistAngle(q: THREE.Quaternion, axis: THREE.Vector3) {
  let a = 2 * Math.atan2(q.x * axis.x + q.y * axis.y + q.z * axis.z, q.w);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
const angleOf = (q: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));

interface JointReport {
  [k: string]: number;
}
function jointAngles(local: THREE.Quaternion[], G: THREE.Quaternion[], P: THREE.Vector3[], rest: THREE.Vector3[]): JointReport {
  const out: JointReport = {};
  for (const side of [0, 1]) {
    const S = side === 0 ? "L" : "R";
    const [sh, el, wr] = side === 0 ? [L_SH, L_EL, L_WR] : [R_SH, R_EL, R_WR];
    const mid = FINGER_BASE[side] + 3;
    const fore = rest[wr].clone().sub(rest[el]).normalize();
    const tw = twistAngle(local[el], fore);
    const twq = new THREE.Quaternion(fore.x * Math.sin(tw / 2), fore.y * Math.sin(tw / 2), fore.z * Math.sin(tw / 2), Math.cos(tw / 2));
    out[`${S} elbow flex`] = angleOf(local[el].clone().multiply(twq.invert()));
    out[`${S} forearm supination`] = side === 1 ? tw : -tw;
    const hand = rest[mid].clone().sub(rest[wr]).normalize();
    const wt = twistAngle(local[wr], hand);
    out[`${S} wrist twist`] = Math.abs(wt);
    const wq = new THREE.Quaternion(hand.x * Math.sin(wt / 2), hand.y * Math.sin(wt / 2), hand.z * Math.sin(wt / 2), Math.cos(wt / 2));
    const swing = local[wr].clone().multiply(wq.invert());
    if (swing.w < 0) swing.set(-swing.x, -swing.y, -swing.z, -swing.w);
    const sa = angleOf(swing);
    const sn = Math.sqrt(Math.max(0, 1 - swing.w * swing.w));
    const palm = v3(0, -1, 0).addScaledVector(hand, hand.y).normalize(); // rest palms face down
    const flAx = hand.clone().cross(palm).normalize();
    const dvAx = flAx.clone().cross(hand).normalize();
    const ax = sn > 1e-6 ? v3(swing.x / sn, swing.y / sn, swing.z / sn) : v3();
    const flex = sa * ax.dot(flAx);
    out[`${S} wrist flex`] = Math.max(0, flex);
    out[`${S} wrist ext`] = Math.max(0, -flex);
    out[`${S} wrist dev`] = Math.abs(sa * ax.dot(dvAx));
    // the upper arm: how far the shoulder joint has it raised from hanging (along the collar's down: the shoulder blade
    // turning up with a raised arm is the collar's), and its twist about itself
    const down = v3(0, -1, 0).applyQuaternion(G[side === 0 ? 13 : 14]);
    const upper = P[el].clone().sub(P[sh]).normalize();
    out[`${S} shoulder raise`] = Math.acos(THREE.MathUtils.clamp(upper.dot(down), -1, 1));
    out[`${S} humerus twist`] = Math.abs(twistAngle(local[sh], rest[el].clone().sub(rest[sh]).normalize()));
    out[`${S} collar`] = angleOf(local[side === 0 ? 13 : 14]);
  }
  out.neck = angleOf(local[12]);
  out["head vs chest"] = angleOf(G[9].clone().invert().multiply(G[15]));
  // how far the face tips up past the chest's forward (the head thrown back)
  const fc = v3(0, 0, 1).applyQuaternion(G[15]).applyQuaternion(G[9].clone().invert());
  out["head back"] = Math.max(0, Math.atan2(fc.y, Math.hypot(fc.x, fc.z)));
  out.spine = Math.max(angleOf(local[3]), angleOf(local[6]), angleOf(local[9]));
  return out;
}
function jointLimit(k: string): [number, number] {
  if (k.endsWith("elbow flex")) return [0, LIMITS.elbowFlex];
  if (k.endsWith("supination")) return [LIMITS.supMin, LIMITS.supMax];
  if (k.endsWith("wrist twist")) return [0, LIMITS.wristTwist];
  if (k.endsWith("wrist flex")) return [0, LIMITS.wristFlex];
  if (k.endsWith("wrist ext")) return [0, LIMITS.wristExt];
  if (k.endsWith("wrist dev")) return [0, LIMITS.wristDev];
  if (k.endsWith("shoulder raise")) return [0, LIMITS.shoulderElev];
  if (k.endsWith("humerus twist")) return [0, LIMITS.humerusTwist];
  if (k.endsWith("collar")) return [0, LIMITS.collar];
  if (k === "neck") return [0, LIMITS.neck];
  if (k === "head vs chest") return [0, LIMITS.headVsChest];
  if (k === "head back") return [0, LIMITS.headBack];
  return [0, LIMITS.spine];
}

// ---------------- the scene ----------------

const BOARD_HALF = SQUARE * 4 + 0.018;
// the table (seated.ts builds it): its top TABLE_TOP, TABLE_THICK thick, TABLE_EDGE behind the board's centre on their
// side, TABLE_NEAR in front of it on the player's, TABLE_HALF_X either way across
const TABLE_C = v3(0, TABLE_TOP - TABLE_THICK / 2, (TABLE_NEAR - TABLE_EDGE) / 2);
const TABLE_H = v3(TABLE_HALF_X, TABLE_THICK / 2, (TABLE_NEAR + TABLE_EDGE) / 2);
// the far button of the clock, standing (clock.ts: body 0.095 x 0.034 x 0.18 at x = SQUARE * 4 + 0.13)
const CLOCK_X = SQUARE * 4 + 0.13;

/** Stands in for game.ts: the table, board, pieces, clock and the opponent, with a game of chess on it. */
class Table {
  scene = new THREE.Scene();
  table = new THREE.Group();
  board = new THREE.Group();
  group = new THREE.Group();
  avatar: FakeAvatar;
  seated: InstanceType<typeof SeatedOpponent>;
  chess = new Chess();
  player: "w" | "b";
  meshes = new Map<string, THREE.Object3D>();
  taken: THREE.Object3D[] = []; // by the opponent, beside the board at their right
  takenByPlayer: THREE.Object3D[] = [];
  tMs = 1000;
  constructor(avatar: FakeAvatar, player: "w" | "b", seed: number) {
    this.avatar = avatar;
    this.player = player;
    this.table.position.set(0, 0.75, 0);
    this.scene.add(this.table);
    this.table.add(this.board);
    this.board.rotation.y = player === "w" ? 0 : Math.PI;
    this.scene.add(this.group);
    this.group.add(avatar.mesh);
    this.seated = new SeatedOpponent(avatar as never, this.table, this.board);
    this.seated.reseed(person.hashSeed("check", seed));
    this.seated.cancel(); // (no handshake at the start: the handshake scenarios ask for one themselves)
    this.seated.setClock(() => this.buttonTop());
    this.group.add(this.seated.chair);
    this.place();
    this.sync();
  }
  place() {
    this.table.updateMatrixWorld();
    const far = v3(0, 0, -this.seated.seatDistance);
    this.table.localToWorld(far);
    this.group.position.set(far.x, 0, far.z);
    this.group.rotation.y = this.table.rotation.y + Math.PI;
    this.scene.updateMatrixWorld(true);
  }
  buttonTop() {
    return v3(CLOCK_X + 0.031, 0.034 + 0.012 - 0.004 + 0.0065, -0.045);
  }
  makePiece(type: string, color: string) {
    const g = new THREE.Group();
    g.add(new THREE.Object3D());
    g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
    g.userData = { type, color, height: pieceHeight(type as never) };
    return g;
  }
  sync() {
    for (const o of this.meshes.values()) this.board.remove(o);
    this.meshes.clear();
    for (const row of this.chess.board())
      for (const c of row) {
        if (!c) continue;
        const o = this.makePiece(c.type, c.color);
        o.position.copy(squareToLocal(c.square));
        this.board.add(o);
        this.meshes.set(c.square, o);
      }
  }
  /** game.ts's slot(): captured pieces beside the board, each player's at their own end, at the player's left. */
  slot(byPlayer: boolean, i: number) {
    const tl = v3(-(SQUARE * 4 + 0.05 + Math.floor(i / 4) * 0.042), 0, (byPlayer ? 1 : -1) * (SQUARE * 3.5 - (i % 4) * 0.045));
    this.board.updateMatrix();
    return tl.applyMatrix4(this.board.matrix.clone().invert());
  }
  /** The opponent moves a piece by hand, as game.ts's handMove does. */
  handMove(mv: { from: string; to: string; flags: string; captured?: string }, done: () => void) {
    const obj = this.meshes.get(mv.from)!;
    const carry = (o: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, role: "victim" | "piece" | "rook") => ({ obj: o, from, to, role, height: o.userData.height as number, shadow: o.children[1] });
    const carries = [];
    const takenOn = mv.flags.includes("e") ? mv.to[0] + mv.from[1] : mv.to;
    const victim = mv.captured ? this.meshes.get(takenOn) : undefined;
    if (victim) carries.push(carry(victim, victim.position.clone(), this.slot(false, this.taken.length), "victim"));
    carries.push(carry(obj, squareToLocal(mv.from), squareToLocal(mv.to), "piece"));
    if (mv.flags.includes("k") || mv.flags.includes("q")) {
      const [rf, rt] = mv.flags.includes("k") ? ["h", "f"] : ["a", "d"];
      const rook = this.meshes.get(rf + mv.from[1]);
      if (rook) carries.push(carry(rook, squareToLocal(rf + mv.from[1]), squareToLocal(rt + mv.from[1]), "rook"));
    }
    this.seated.play(carries as never, () => {
      if (victim) {
        this.taken.push(victim);
        this.meshes.delete(takenOn);
      }
      done();
    }, { at: () => this.buttonTop(), onTap: () => {} }, { hardness: 0.4 });
  }
  /** Everything the opponent's arms could go through, table-local. */
  obstacles(exclude: Set<THREE.Object3D>): Obstacle[] {
    const out: Obstacle[] = [
      boxObs("board", v3(0, -0.00575, 0), v3(BOARD_HALF, 0.00625, BOARD_HALF)),
      boxObs("table", TABLE_C, TABLE_H),
      boxObs("clock", v3(CLOCK_X, 0.017, 0), v3(0.0475, 0.017, 0.09)),
      boxObs("clock (player's button)", v3(CLOCK_X + 0.031, 0.04, 0.045), v3(0.014, 0.006, 0.025)),
    ];
    const pieces = [...this.board.children].filter((o) => o.userData?.type);
    for (const o of pieces) {
      if (exclude.has(o) || !o.visible) continue;
      out.push(...this.pieceObstacles(o));
    }
    return out;
  }
  pieceObstacles(o: THREE.Object3D): Obstacle[] {
    const p = o.getWorldPosition(v3());
    this.table.worldToLocal(p);
    const h = o.userData.height as number;
    const tilt = Math.abs(o.rotation.x) + Math.abs(o.rotation.z) + Math.abs(o.quaternion.x) + Math.abs(o.quaternion.z) > 0.2;
    const name = `piece ${o.userData.color}${o.userData.type}`;
    if (tilt) {
      // tipping over (a resigning king): a capsule from its base to its top, as thick as its stem
      const a = this.table.worldToLocal(o.localToWorld(v3(0, 0.012, 0)));
      const b = this.table.worldToLocal(o.localToWorld(v3(0, h - 0.008, 0)));
      const r = 0.0135;
      return [{ name, sd: (q: THREE.Vector3) => sdSeg(q, a, b, r), lo: a.clone().min(b).subScalar(r), hi: a.clone().max(b).addScalar(r), piece: o }];
    }
    // its own lathe profile (pieces.ts): the distance to it, as near as the profile's radius at that height allows
    const type = o.userData.type as string;
    const top = h + (type === "r" ? 0.005 : 0); // (userData.height includes the king's cross)
    const sd = (q: THREE.Vector3) => {
      const y = q.y - p.y;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const here = pieceRadius(type, h, y, q.x - p.x, q.z - p.z);
      if (d < here) return -Math.min(here - d, top - y, y); // inside: how far to its side, or out of its top
      let best = Infinity;
      for (let i = 0; i <= 40; i++) {
        const yy = (i / 40) * top;
        const r = pieceRadius(type, h, yy, q.x - p.x, q.z - p.z);
        if (r > 0) best = Math.min(best, Math.hypot(Math.max(d - r, 0), yy - y));
      }
      return best;
    };
    return [{ name, sd, lo: v3(p.x - 0.0175, p.y, p.z - 0.0175), hi: v3(p.x + 0.0175, p.y + top, p.z + 0.0175), piece: o }];
  }
}

// ---------------- running it ----------------

interface Hit {
  depth: number;
  part: string;
  obstacle: string;
  scenario: string;
  t: number;
  what: string;
}
interface Result {
  avatar: string;
  capsule: Map<string, Hit>; // worst per scenario family + obstacle class
  gauss: Map<string, Hit>;
  grip: Map<string, Hit>; // fingers inside the piece they hold
  joints: Map<string, { max: number; maxAt: string; min: number; minAt: string }>;
  frames: number;
  reachError: number;
  reachAt: string;
  handshake: string[];
  floats: Map<string, Hit>; // a resting hand (idle) above the table: how far its lowest point floats
}

/** What a hit is grouped under: each idle on its own, every reach together, every game together. */
const family = (name: string) => (name.startsWith("idle ") ? name.split(":")[0] : name.startsWith("transition") ? "transition" : name.startsWith("reach") ? "reach" : name.startsWith("game") ? "game" : name);
const obsClass = (n: string) => (n.startsWith("piece") ? "pieces" : n);

function record(map: Map<string, Hit>, key: string, h: Hit) {
  const cur = map.get(key);
  if (!cur || h.depth > cur.depth) map.set(key, h);
}

function runAvatar(id: string): Result {
  const bundle = loadBundle(id);
  const res: Result = { avatar: id, capsule: new Map(), gauss: new Map(), grip: new Map(), joints: new Map(), frames: 0, reachError: 0, reachAt: "", handshake: [], floats: new Map() };
  const avatar0 = new FakeAvatar(bundle);
  const rest = avatar0.rest;
  const radii = measureRadii(bundle, rest);
  const body = BodyShape.measure(avatar0.mesh as never, rest);
  console.log(`\n== ${id}: ${bundle.n} Gaussians; forearm r ${(radii.forearm[1] * 100).toFixed(1)}-${(radii.cuff[1] * 100).toFixed(1)} cm, palm ${(radii.palm[1] * 100).toFixed(1)}, fingers ${radii.finger[1].map((r) => (r * 1000).toFixed(0)).join("/")} mm, thigh ${(radii.thigh[1] * 100).toFixed(1)} cm`);

  // the hand and forearm Gaussians (dual quaternion skinning, as Spark renders them), and the torso's and thighs'
  const ARM = new Set([L_EL, R_EL, L_WR, R_WR, ...Array.from({ length: 30 }, (_, i) => 25 + i)]);
  const armIdx: number[] = [];
  for (let i = 0; i < bundle.n; i++) if (bundle.opacity[i] >= 0.3 && ARM.has(bundle.dominant[i])) armIdx.push(i);
  const torsoIdx: number[] = [];
  const thighIdx: number[] = [];
  for (let i = 0; i < bundle.n; i++) {
    if (bundle.opacity[i] < 0.3) continue;
    const d = bundle.dominant[i];
    if ([0, 3, 6, 9, 13, 14, 12, 15, 22, 23, 24].includes(d)) torsoIdx.push(i);
    else if (d === 1 || d === 2 || d === 4 || d === 5) thighIdx.push(i);
  }

  const skinPoints = (av: FakeAvatar, idx: number[], toT: THREE.Matrix4) => {
    // dual quaternion per bone: M_j = [G_j | P_j - G_j rest_j]
    const nb = av.G.length;
    const dq = new Float64Array(nb * 8);
    for (let j = 0; j < nb; j++) {
      const q = av.G[j];
      const t = av.P[j].clone().sub(rest[j].clone().applyQuaternion(q));
      dq.set([q.x, q.y, q.z, q.w], j * 8);
      // dual part: 0.5 * (t, 0) * q
      const [tx, ty, tz] = [t.x, t.y, t.z];
      dq[j * 8 + 4] = 0.5 * (tx * q.w + ty * q.z - tz * q.y);
      dq[j * 8 + 5] = 0.5 * (-tx * q.z + ty * q.w + tz * q.x);
      dq[j * 8 + 6] = 0.5 * (tx * q.y - ty * q.x + tz * q.w);
      dq[j * 8 + 7] = 0.5 * (-tx * q.x - ty * q.y - tz * q.z);
    }
    const e = toT.elements;
    const out = new Float32Array(idx.length * 3);
    const b = new Float64Array(8);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      b.fill(0);
      const j0 = bundle.bone[i * 4];
      for (let m = 0; m < 4; m++) {
        const w = bundle.weight[i * 4 + m];
        if (w <= 0) continue;
        const j = bundle.bone[i * 4 + m];
        const s = dq[j * 8] * dq[j0 * 8] + dq[j * 8 + 1] * dq[j0 * 8 + 1] + dq[j * 8 + 2] * dq[j0 * 8 + 2] + dq[j * 8 + 3] * dq[j0 * 8 + 3] < 0 ? -w : w;
        for (let c = 0; c < 8; c++) b[c] += s * dq[j * 8 + c];
      }
      const n = Math.hypot(b[0], b[1], b[2], b[3]);
      const [x, y, z, w] = [b[0] / n, b[1] / n, b[2] / n, b[3] / n];
      const [dx, dy, dz, dw] = [b[4] / n, b[5] / n, b[6] / n, b[7] / n];
      // translation = 2 * dual * conj(real)
      const tx = 2 * (-dw * x + dx * w - dy * z + dz * y);
      const ty = 2 * (-dw * y + dx * z + dy * w - dz * x);
      const tz = 2 * (-dw * z - dx * y + dy * x + dz * w);
      const px = bundle.pos[i * 3], py = bundle.pos[i * 3 + 1], pz = bundle.pos[i * 3 + 2];
      // rotate p by (x, y, z, w)
      const ix = w * px + y * pz - z * py, iy = w * py + z * px - x * pz, iz = w * pz + x * py - y * px, iw = -x * px - y * py - z * pz;
      const rx = ix * w + iw * -x + iy * -z - iz * -y + tx;
      const ry = iy * w + iw * -y + iz * -x - ix * -z + ty;
      const rz = iz * w + iw * -z + ix * -y - iy * -x + tz;
      out[k * 3] = e[0] * rx + e[4] * ry + e[8] * rz + e[12];
      out[k * 3 + 1] = e[1] * rx + e[5] * ry + e[9] * rz + e[13];
      out[k * 3 + 2] = e[2] * rx + e[6] * ry + e[10] * rz + e[14];
    }
    return out;
  };

  /** One scene: steps it at 30 Hz, testing every frame (Gaussians every `gaussEvery`). */
  const sim = (scn: Table, scenario: () => string, gaussEvery = 3, hand: ((t: number) => unknown) | null = null) => {
    const av = scn.avatar;
    const S = scn.seated as unknown as Record<string, any>;
    const viewer = v3(0, 1.25, 0.62);
    let frame = 0;
    const toTable = new THREE.Matrix4();
    const toBundle = new THREE.Matrix4();
    return (seconds: number, ctx: { thinking?: boolean } = {}) => {
      const steps = Math.round(seconds * HZ);
      for (let s = 0; s < steps; s++) {
        scn.tMs += 1000 / HZ;
        scn.seated.update(scn.tMs, { thinking: !!ctx.thinking, viewer, pressure: 0, watch: null, hand: (hand ? hand(scn.tMs / 1000) : null) as never });
        frame++;
        res.frames++;
        scn.scene.updateMatrixWorld(true);
        toTable.copy(scn.table.matrixWorld).invert().multiply(av.mesh.matrixWorld);
        toBundle.copy(toTable).invert();
        const name = scenario();
        const fam = family(name);
        const t = scn.tMs / 1000;
        const segs = (S.hands as { segs: { kind: string; k?: { c: { obj: THREE.Object3D } }; tip?: { obj: THREE.Object3D } }[]; held: { c: { obj: THREE.Object3D } } | null; w: number }[]);
        const what = `${S.idleInst.kind}${S.idleFrom ? " (blending)" : ""}; L ${segs[0].segs[0]?.kind ?? "idle"}, R ${segs[1].segs[0]?.kind ?? "idle"}`;
        // what each hand is allowed to touch: the piece it holds or is about to (fingers only), the clock button it presses
        const touching = [new Set<THREE.Object3D>(), new Set<THREE.Object3D>()];
        const pressing = [false, false];
        for (const side of [0, 1]) {
          const h = segs[side];
          const seg = h.segs[0];
          if (h.held) touching[side].add(h.held.c.obj);
          if (seg?.k && ["descend", "grip", "carry", "set", "hover", "adjust", "release", "lift"].includes(seg.kind)) touching[side].add(seg.k.c.obj);
          if (seg?.tip) touching[side].add(seg.tip.obj);
          // lift: the one just let go of
          if (seg?.kind === "lift" || seg?.kind === "return") for (const o of [...scn.board.children]) if (o.userData?.type && o.getWorldPosition(v3()).distanceTo(S.hands[side].world) < 0.06) touching[side].add(o);
          pressing[side] = seg?.kind === "press" || (seg?.kind === "reach" && !seg.k);
        }
        const all = new Set([...touching[0], ...touching[1]]);
        const obs = scn.obstacles(new Set());
        // the chair, in bundle space -> table-local
        const chairObs = chairObstacles(toTable);
        const caps = armCapsules(av.G, av.P, toTable, radii, rest);
        for (const c of caps) {
          const side = c.part[0] === "L" ? 0 : 1;
          for (const o of [...obs, ...chairObs]) {
            if (o.piece && touching[side].has(o.piece) && c.finger) {
              const d = capsuleDepth(c, o);
              if (d > 0) record(res.grip, `${fam}`, { depth: d, part: c.part, obstacle: o.name, scenario: name, t, what });
              continue;
            }
            if (o.piece && all.has(o.piece) && !c.finger) continue;
            const d = capsuleDepth(c, o);
            if (d > 0) record(res.capsule, `${fam} | ${obsClass(o.name)}`, { depth: d, part: c.part, obstacle: o.name, scenario: name, t, what });
          }
        }
        // the body's own torso and head (blocks measured from its Gaussians), and thighs
        const G = av.G;
        const P = av.P;
        const thighs = [0, 1].map((side) => {
          const [hip, knee] = side === 0 ? [1, 4] : [2, 5];
          return { a: P[hip].clone().applyMatrix4(toTable), b: P[knee].clone().applyMatrix4(toTable), r: radii.thigh[side] };
        });
        const contact = (side: number) => (S.idleOut.hands[side].head as number) * (1 - smoothW(S.hands[side].w as number)) > 0.5;
        for (const c of caps) {
          const side = c.part[0] === "L" ? 0 : 1;
          if (c.part.includes("upper arm")) continue; // an upper arm at the side touches the body, as anyone's does
          const fore = c.part.includes("forearm");
          const n = Math.max(1, Math.ceil(c.a.distanceTo(c.b) / 0.006));
          let dT = 0;
          let dH = 0;
          let dL = 0;
          const pB = v3();
          for (let i = 0; i <= n; i++) {
            const u = i / n;
            if (fore && u < 0.4) continue; // near the elbow a forearm is an arm at the side
            const cr = THREE.MathUtils.lerp(c.r, c.rb ?? c.r, u);
            pB.lerpVectors(c.a, c.b, u).applyMatrix4(toBundle);
            dT = Math.max(dT, body.depth(pB, cr, G, P, undefined, "torso"));
            dH = Math.max(dH, body.depth(pB, cr, G, P, undefined, "head"));
            const pT = v3().lerpVectors(c.a, c.b, u);
            for (const th of thighs) dL = Math.max(dL, th.r + cr - (sdSeg(pT, th.a, th.b, 0)));
          }
          if (dT > 0) record(res.capsule, `${fam} | body (torso)`, { depth: dT, part: c.part, obstacle: "torso", scenario: name, t, what });
          if (dH > 0 && !contact(side)) record(res.capsule, `${fam} | body (head)`, { depth: dH, part: c.part, obstacle: "head", scenario: name, t, what });
          if (dH > 0.012 && contact(side)) record(res.capsule, `${fam} | body (head)`, { depth: dH - 0.012, part: c.part, obstacle: "head (resting on it, past 12 mm)", scenario: name, t, what });
          if (dL > 0) record(res.capsule, `${fam} | body (thighs)`, { depth: dL, part: c.part, obstacle: "thigh", scenario: name, t, what });
        }
        // thighs and knees against the table's underside; the torso against the chair's back
        const under = boxObs("table underside", TABLE_C, TABLE_H);
        for (const th of thighs) {
          const d = capsuleDepth({ a: th.a, b: th.b, r: th.r, part: "thigh", finger: false }, under);
          if (d > 0) record(res.capsule, `${fam} | table underside`, { depth: d, part: "thigh / knee", obstacle: "table underside", scenario: name, t, what });
        }
        // a hand resting on the table (both hands idle, no piece): its lowest point should be on the table, not over it
        for (const side of [0, 1]) {
          if (segs[side].segs.length || S.idleFrom || (S.idleOut.hands[side].elbow as number) > 0 || (S.idleOut.hands[side].head as number) > 0) continue;
          const kind = S.idleInst.kind as string;
          if (["chin", "cheek", "clasped", "armsFolded"].includes(kind)) continue;
          let low = Infinity;
          for (const c of caps) if (c.finger && (c.part[0] === "L" ? 0 : 1) === side) low = Math.min(low, c.a.y - c.r, c.b.y - c.r);
          const over = Math.abs(low - TABLE_TOP);
          if (low > TABLE_TOP) record(res.floats, `${fam}`, { depth: over, part: side === 0 ? "L hand" : "R hand", obstacle: "above the table", scenario: name, t, what });
        }
        if (frame % gaussEvery === 0) {
          const pts = skinPoints(av, armIdx, toTable);
          const p = v3();
          for (const o of [...obs, ...chairObs]) {
            const deep: number[] = [];
            let part = "";
            for (let k = 0; k < armIdx.length; k++) {
              const x = pts[k * 3], y = pts[k * 3 + 1], z = pts[k * 3 + 2];
              if (x < o.lo.x || x > o.hi.x || y < o.lo.y || y > o.hi.y || z < o.lo.z || z > o.hi.z) continue;
              const j = bundle.dominant[armIdx[k]];
              const side = j === L_EL || j === L_WR || (j >= 25 && j < 40) ? 0 : 1;
              if (o.piece && touching[side].has(o.piece)) continue;
              if (o.piece && all.has(o.piece)) continue;
              const d = -o.sd(p.set(x, y, z));
              if (d > 0) {
                deep.push(d);
                part = `${side === 0 ? "L" : "R"} ${j === L_EL || j === R_EL ? "forearm" : "hand"}`;
              }
            }
            if (deep.length >= 8) {
              deep.sort((a, b) => b - a);
              record(res.gauss, `${fam} | ${obsClass(o.name)}`, { depth: deep[7], part: `${part} (${deep.length} Gaussians in)`, obstacle: o.name, scenario: name, t, what });
            }
          }
          // torso and head against the chair's back and posts, and (leaning in) the table, the board, the pieces, the
          // clock (every 4th test: it's most of the Gaussians)
          const tp = frame % (gaussEvery * 4) === 0 ? skinPoints(av, torsoIdx, toTable) : new Float32Array(0);
          const tlo = v3(Infinity, Infinity, Infinity);
          const thi = v3(-Infinity, -Infinity, -Infinity);
          for (let k = 0; k < tp.length; k += 3) {
            tlo.min(p.set(tp[k], tp[k + 1], tp[k + 2]));
            thi.max(p);
          }
          for (const o of tp.length ? [...chairObs, ...obs] : []) {
            if (o.lo.x > thi.x || o.hi.x < tlo.x || o.lo.y > thi.y || o.hi.y < tlo.y || o.lo.z > thi.z || o.hi.z < tlo.z) continue;
            if (o.name === "chair seat") continue;
            const deep: [number, number][] = [];
            for (let k = 0; k < torsoIdx.length; k++) {
              p.set(tp[k * 3], tp[k * 3 + 1], tp[k * 3 + 2]);
              if (p.x < o.lo.x || p.x > o.hi.x || p.y < o.lo.y || p.y > o.hi.y || p.z < o.lo.z || p.z > o.hi.z) continue;
              const d = -o.sd(p);
              if (d > 0) deep.push([d, bundle.dominant[torsoIdx[k]]]);
            }
            if (deep.length >= 8) {
              deep.sort((a, b) => b[0] - a[0]);
              const bones = [...new Set(deep.slice(0, 8).map(([, j]) => av.b.skeleton.joints[j]))].join("/");
              record(res.gauss, `${fam} | ${obsClass(o.name)} (torso, head)`, { depth: deep[7][0], part: `${bones} (${deep.length} Gaussians in)`, obstacle: o.name, scenario: name, t, what });
            }
          }
          if (frame % (gaussEvery * 4) === 0) {
            const lp = skinPoints(av, thighIdx, toTable);
            const deep: number[] = [];
            for (let k = 0; k < thighIdx.length; k++) {
              p.set(lp[k * 3], lp[k * 3 + 1], lp[k * 3 + 2]);
              const d = -under.sd(p);
              if (d > 0) deep.push(d);
            }
            if (deep.length >= 8) {
              deep.sort((a, b) => b - a);
              record(res.gauss, `${fam} | table underside`, { depth: deep[7], part: `thighs (${deep.length} Gaussians in)`, obstacle: "table underside", scenario: name, t, what });
            }
          }
        }
        // joints
        const ja = jointAngles(av.local, av.G, av.P, rest);
        for (const [k, v] of Object.entries(ja)) {
          const key = `${fam} | ${k}`;
          const cur = res.joints.get(key);
          if (!cur) res.joints.set(key, { max: v, maxAt: `${name} t ${t.toFixed(2)}; ${what}`, min: v, minAt: `${name} t ${t.toFixed(2)}; ${what}` });
          else {
            if (v > cur.max) [cur.max, cur.maxAt] = [v, `${name} t ${t.toFixed(2)}; ${what}`];
            if (v < cur.min) [cur.min, cur.minAt] = [v, `${name} t ${t.toFixed(2)}; ${what}`];
          }
        }
        if (scn.seated.reachError > res.reachError) [res.reachError, res.reachAt] = [scn.seated.reachError, `${name} t ${t.toFixed(2)}; ${what}`];
        if (TRACE && name.includes(TRACE) && frame % 3 === 0) {
          const f = (j: number) => av.P[j].clone().applyMatrix4(toTable).toArray().map((x) => x.toFixed(2)).join(",");
          const hs = S.hands as { side: number; p: THREE.Vector3; w: number; segs: { kind: string }[] }[];
          const h = hs[1].w > hs[0].w ? hs[1] : hs[0];
          const [sh, el, wr] = h.side === 0 ? [16, 18, 20] : [17, 19, 21];
          // the hand as seated.ts models it (balls), against the capsules here: lowest point of each, table-local
          const hsh = S.shape(h.side, { pin: (h as unknown as Record<string, number>).pin, pt: (h as unknown as Record<string, number>).pt, curl: (h as unknown as Record<string, number>).curl });
          let lowB = Infinity;
          for (let i = 0; i < hsh.pts.length; i++) lowB = Math.min(lowB, hsh.pts[i].clone().applyQuaternion(av.G[wr]).add(av.P[wr]).applyMatrix4(toTable).y - hsh.r[i]);
          let lowC = Infinity;
          let lowPart = "";
          for (const c of armCapsules(av.G, av.P, toTable, radii, rest)) if (c.finger && (c.part[0] === "L" ? 0 : 1) === h.side && Math.min(c.a.y, c.b.y) - c.r < lowC) [lowC, lowPart] = [Math.min(c.a.y, c.b.y) - c.r, c.part];
          const held = (h as unknown as { held: { c: { obj: THREE.Object3D }; grip: number } | null }).held;
          if (held) {
            const caps = armCapsules(av.G, av.P, toTable, radii, rest).filter((c) => c.part.startsWith(h.side ? "R" : "L"));
            const it = caps.find((c) => c.part.endsWith("index tip"))!.b;
            const tt = caps.find((c) => c.part.endsWith("thumb tip"))!.b;
            const pc = held.c.obj.getWorldPosition(v3());
            scn.table.worldToLocal(pc);
            const hd = (q: THREE.Vector3) => Math.hypot(q.x - pc.x, q.z - pc.z);
            console.log(`      held ${held.c.obj.userData.type} grip ${(held.grip * 1000).toFixed(0)} mm: index tip ${(hd(it) * 1000).toFixed(1)} mm from its axis at ${((it.y - pc.y) * 1000).toFixed(0)} up, thumb tip ${(hd(tt) * 1000).toFixed(1)} at ${((tt.y - pc.y) * 1000).toFixed(0)}; tips ${(it.distanceTo(tt) * 1000).toFixed(1)} apart (finger r ${(radii.finger[h.side][0] * 1000).toFixed(1)}/${(radii.finger[h.side][4] * 1000).toFixed(1)})`);
          }
          {
            // the model's own deepest ball in a piece it isn't taking, against the capsules'
            const st = { pin: (h as unknown as Record<string, number>).pin, pt: (h as unknown as Record<string, number>).pt, curl: (h as unknown as Record<string, number>).curl, tuck: (h as unknown as Record<string, number>).tuck };
            const m = S.shape(h.side, st);
            const sk = (h as unknown as { segs: { k?: { c: { obj: THREE.Object3D } } }[] }).segs[0]?.k?.c.obj ?? null;
            let deep = -Infinity;
            for (let i = 0; i < m.pts.length; i++) {
              const q = m.pts[i].clone().applyQuaternion(av.G[wr]).add(av.P[wr]).applyMatrix4(toTable);
              deep = Math.max(deep, S.ground(q.x, q.z, m.r[i], new Set([sk])) + m.r[i] - q.y);
            }
            console.log(`      model deepest under ${(deep * 1000).toFixed(1)} mm`);
          }
          console.log(`      model low ${(lowB * 1000).toFixed(1)} mm, capsules low ${(lowC * 1000).toFixed(1)} mm (${lowPart}); pin ${(h as unknown as Record<string, number>).pin.toFixed(2)}`);
          if (flag("--chest")) {
            const loc = av.local.map((q) => q.clone());
            const rt = v3();
            const G0 = S.G.map((q: THREE.Quaternion) => q.clone());
            const P0 = S.P.map((q: THREE.Vector3) => q.clone());
            const c = S.chestInTable(loc, rt, S.leanS, S.riseS, S.slideS);
            S.G.forEach((q: THREE.Quaternion, i: number) => q.copy(G0[i]));
            S.P.forEach((q: THREE.Vector3, i: number) => q.copy(P0[i]));
            console.log(`      chestInTable ${(c * 1000).toFixed(1)} mm; rise ${(S.riseS * 100).toFixed(1)} cm slide ${(S.slideS * 100).toFixed(1)} cm`);
          }
          console.log(`   ${t.toFixed(2)} ${h.side ? "R" : "L"} ${h.segs[0]?.kind ?? "-"} w ${h.w.toFixed(2)} lean ${(S.leanS as number).toFixed(2)} target ${h.p.toArray().map((x) => x.toFixed(2))} sh ${f(sh)} el ${f(el)} wr ${f(wr)} err ${(scn.seated.reachError * 100).toFixed(1)}cm raise ${jointAngles(av.local, av.G, av.P, rest)[`${h.side ? "R" : "L"} shoulder raise`].toFixed(2)}`);
        }
      }
    };
  };

  const smoothW = (u: number) => u * u * (3 - 2 * u);

  // the chair, as seated.ts builds it (front faces -Z, in the opponent's group: bundle space), to table-local
  const chairObstacles = (toT: THREE.Matrix4): Obstacle[] => {
    const SEAT = 0.46;
    const out: Obstacle[] = [];
    const inv = toT.clone().invert();
    const local = (sd: (p: THREE.Vector3) => number, lo: THREE.Vector3, hi: THREE.Vector3, name: string): Obstacle => {
      const box = new THREE.Box3(lo, hi).applyMatrix4(toT);
      const q = v3();
      return { name, sd: (p) => sd(q.copy(p).applyMatrix4(inv)), lo: box.min, hi: box.max };
    };
    out.push(local((p) => sdBox(p, v3(0, SEAT - 0.015, -0.09), v3(0.22, 0.015, 0.21)), v3(-0.22, SEAT - 0.03, -0.3), v3(0.22, SEAT, 0.12), "chair seat"));
    const tilt = 0.08;
    const postH = 0.42;
    for (const x of [-0.19, 0.19]) {
      const a = v3(x, SEAT - 0.01, 0.1);
      const b = v3(x, SEAT + postH - 0.01, 0.1 + Math.sin(tilt) * postH);
      out.push(local((p) => sdSeg(p, a, b, 0.011), v3(x - 0.011, SEAT - 0.02, 0.09), v3(x + 0.011, SEAT + postH, 0.15), "chair post"));
    }
    const rc = v3(0, SEAT + postH - 0.08, 0.11 + Math.sin(tilt) * (postH - 0.07));
    const rq = new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), -tilt);
    const rr = v3();
    out.push(local((p) => sdBox(rr.copy(p).sub(rc).applyQuaternion(rq), v3(), v3(0.21, 0.06, 0.01)), rc.clone().sub(v3(0.21, 0.07, 0.02)), rc.clone().add(v3(0.21, 0.07, 0.02)), "chair back"));
    return out;
  };

  // ---- 1. every idle, each side, two variants
  const kinds = ["still", "rest", "scan", "leanIn", "leanBack", "shift", "breath", "neckRoll", "shoulderRoll", "ready", "chin", "cheek", "clasped", "forearms", "armsFolded"];
  const scnI = new Table(new FakeAvatar(bundle), "w", 1);
  let label = "";
  const runI = sim(scnI, () => label);
  runI(0.5);
  const SI = scnI.seated as unknown as Record<string, any>;
  const report: string[] = SI.lastReport;
  console.log(`  verifyPoses: ${report.join("; ")}`);
  const allowed = new Set<string>();
  for (const k of kinds) if (k === "ready" || SI.allows(k)) allowed.add(k);
  const chosen = new Set<string>();
  for (const m of ["think", "wait", "over"]) for (let i = 0; i < 400; i++) chosen.add(person.pickIdle(new person.Rng(i + 7), m as never, null, (k: string) => SI.allows(k)));
  console.log(`  idles this avatar can be given: ${[...chosen].join(", ")} (+ ready)`);
  console.log(`  seat ${SI.seatDistance.toFixed(3)} m behind the board's centre (body front ${body.front.toFixed(3)}); hand ${body.handLen.map((x: number) => x.toFixed(3))} m`);
  if (flag("--pose")) {
    // where the joints are in the calm rest pose, table-local, and what the guard did
    SI.startIdle({ kind: "still", side: 1, r: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }, SI.now);
    SI.switchAt = Infinity;
    runI(2);
    const av = scnI.avatar;
    const toT = scnI.table.matrixWorld.clone().invert().multiply(av.mesh.matrixWorld);
    const f = (v: THREE.Vector3) => v.clone().applyMatrix4(toT).toArray().map((x) => x.toFixed(3)).join(", ");
    for (const [n, j] of [["pelvis", 0], ["spine3", 9], ["L shoulder", 16], ["L elbow", 18], ["L wrist", 20], ["L middle1", 28], ["R shoulder", 17], ["R elbow", 19], ["R wrist", 21], ["R middle1", 43]] as const) console.log(`    ${n}: ${f(av.P[j])}`);
    console.log(`    idle p L ${SI.idleOut.hands[0].p.toArray().map((x: number) => x.toFixed(3))} R ${SI.idleOut.hands[1].p.toArray().map((x: number) => x.toFixed(3))}; guard push ${(SI.guardPush * 100).toFixed(1)} cm, inside ${(SI.guardResid * 100).toFixed(1)} cm`);
    console.log(`    body: arm ${body.arm.map((x: number) => x.toFixed(3))} cuff ${body.cuff.map((x: number) => x.toFixed(3))} upper ${body.upper.map((x: number) => x.toFixed(3))} finger ${body.finger.map((x: number) => x.toFixed(4))} palm ${body.palm.map((x: number) => x.toFixed(4))} tip ${body.tip.map((x: number) => x.toFixed(4))}`);
    if (flag("--pinch")) {
      // the thumb-to-index vector over a grid of (index, thumb) pinch weights: gap, and how much of it runs along the hand
      for (const side of [1]) {
        const dir = rest[43].clone().sub(rest[21]).normalize();
        const rows: string[] = [];
        for (let wi = -0.6; wi <= 1.01; wi += 0.2)
          for (let wt = -0.6; wt <= 1.41; wt += 0.2) {
            const sh = SI.shape(side, { pin: wi, pt: 0, curl: 0, tuck: 1, thumb: wt });
            const v = sh.index.clone().sub(sh.thumb);
            rows.push(`wi ${wi.toFixed(1)} wt ${wt.toFixed(1)}: gap ${(v.length() * 1000).toFixed(0)} along ${(Math.abs(v.dot(dir)) / v.length()).toFixed(2)}`);
          }
        console.log(rows.join("\n"));
      }
      process.exit(0);
    }
    const ja = jointAngles(av.local, av.G, av.P, rest);
    console.log("    " + Object.entries(ja).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("; "));
    process.exit(0);
  }
  for (const kind of ONLY.has("idle") ? kinds : []) {
    for (const side of [0, 1]) {
      for (const r of [0.15, 0.85]) {
        label = `idle ${kind}:${side}${chosen.has(kind) || kind === "ready" ? "" : " (never chosen)"}`;
        SI.startIdle({ kind, side, r: [r, 1 - r, r, 0.5, r, 1 - r] }, SI.now);
        SI.switchAt = Infinity;
        runI(QUICK ? 2 : 3.2, { thinking: r < 0.5 });
      }
    }
  }

  // ---- 2. transitions between the idles it can be given (and ready, while a move starts)
  const act = ONLY.has("transition") ? [...chosen, "ready"] : [];
  for (const a of act)
    for (const b of act) {
      if (a === b) continue;
      label = `transition ${a} -> ${b}`;
      SI.startIdle({ kind: a, side: 1, r: [0.3, 0.6, 0.4, 0.5, 0.7, 0.2] }, SI.now);
      SI.switchAt = Infinity;
      runI(QUICK ? 1.6 : 2.2);
      SI.startIdle({ kind: b, side: 0, r: [0.7, 0.4, 0.6, 0.5, 0.3, 0.8] }, SI.now);
      SI.switchAt = Infinity;
      runI(QUICK ? 1.8 : 2.4);
    }

  // ---- 3. the reach sweep: a piece picked up on each of the 64 squares, carried, and the clock pressed
  for (const player of ["w", "b"] as const) {
    if ((QUICK && player === "b") || !ONLY.has("reach")) break;
    const scn = new Table(new FakeAvatar(bundle), player, 2);
    let lab = "";
    const run = sim(scn, () => lab);
    run(1.0);
    const files = "abcdefgh";
    for (let f = 0; f < 8; f++)
      for (let r = 1; r <= 8; r++) {
        const sq = files[f] + r;
        scn.chess.reset();
        scn.sync();
        let obj = scn.meshes.get(sq);
        if (!obj) {
          obj = scn.makePiece("p", player === "w" ? "b" : "w");
          obj.position.copy(squareToLocal(sq));
          scn.board.add(obj);
          scn.meshes.set(sq, obj);
        }
        // to the nearest empty square toward the middle of the board
        let to = "";
        for (const dr of [r <= 4 ? 1 : -1, r <= 4 ? 2 : -2, r <= 4 ? 3 : -3, r <= 4 ? 4 : -4]) {
          const cand = files[f] + (r + dr);
          if (r + dr >= 1 && r + dr <= 8 && !scn.meshes.get(cand)) {
            to = cand;
            break;
          }
        }
        lab = `reach ${sq}->${to} (${player === "w" ? "as black" : "as white"})`;
        let placed = false;
        scn.handMove({ from: sq, to, flags: "n" }, () => (placed = true));
        for (let i = 0; i < 40 && (!placed || (scn.seated as unknown as Record<string, any>).moving); i++) run(0.25);
        run(0.6);
        for (const o of [...scn.board.children]) if (o.userData?.type) scn.board.remove(o);
        scn.meshes.clear();
      }
  }

  // ---- 4. the handshake at the start of a game: shaken (your hand comes to his and shakes), left hanging, and a pinch
  // held up to his hand (which must not count)
  for (const how of ["shaken", "left hanging", "pinch", "no hands"] as const) {
    if (!ONLY.has("handshake")) break;
    const scn = new Table(new FakeAvatar(bundle), "w", 30);
    const SS = scn.seated as unknown as Record<string, any>;
    let came = -1;
    let his = v3();
    // a tracked hand of yours resting on your side of the table (not held out)
    const resting = () => ({ palm: scn.table.localToWorld(v3(0.15, 0.03, 0.32)), normal: v3(0, 1, 0), ok: false });
    const yours = (t: number) => {
      if (how === "no hands") return null;
      if (how === "left hanging") return resting();
      const phase = SS.greet.phase as string;
      if (phase === "back" || phase === "none") return resting(); // your hand's back down
      if (phase !== "offer" && phase !== "shake") return resting();
      if (came < 0 && SS.hands[1].segs[0]?.kind !== "offer") return resting(); // (you hold yours out once his is out)
      if (came < 0) [came, his] = [t, (SS.hands[1].world as THREE.Vector3).clone()]; // (and go to where it is)
      const k = Math.min(1, (t - came) / 0.7);
      // coming in from your side, palm toward his; then your own up-and-down
      const palm = his.clone().add(v3(0.03, -0.01, 0.03 + 0.25 * (1 - k)));
      if (how === "shaken" && t - came > 1.6) palm.y -= 0.2 * Math.min(1, (t - came - 1.6) / 0.5); // you pull your hand down toward the board
      if (phase === "shake") palm.y += 0.025 * Math.sin(2 * Math.PI * 2 * (t - came));
      return { palm, normal: v3(-1, 0, 0), ok: how === "shaken" };
    };
    let lab = `handshake ${how}`;
    const run = sim(scn, () => lab, 3, yours);
    SS.greetPlayer(0.4);
    const phases = new Set<string>();
    for (let i = 0; i < 60 && (i < 4 || SS.greeting); i++) {
      run(0.2);
      phases.add(SS.greet.phase);
    }
    run(1.5);
    lab = `handshake ${how}: done`;
    const shook = phases.has("shake");
    const offered = phases.has("offer");
    const right = (how === "shaken") === shook && (how === "no hands") !== offered;
    res.handshake.push(`${how}: ${[...phases].join(" -> ")}${right ? "" : " (WRONG)"}`);
  }

  // ---- 5. whole games
  for (let g = 0; g < (ONLY.has("game") ? GAMES : 0); g++) {
    const player = g % 2 === 0 ? "w" : "b";
    const scn = new Table(new FakeAvatar(bundle), player, 10 + g);
    let lab = "";
    const run = sim(scn, () => lab);
    const rng = new person.Rng(person.hashSeed("game", g));
    let ply = 0;
    run(1.5);
    const maxPly = QUICK ? 30 : 70;
    while (!scn.chess.isGameOver() && ply < maxPly) {
      const moves = scn.chess.moves({ verbose: true });
      const caps = moves.filter((m) => m.captured);
      const mv = caps.length && rng.chance(0.6) ? rng.pick(caps) : rng.pick(moves);
      if (scn.chess.turn() === player) {
        lab = `game ${g + 1}: player ${mv.san}`;
        scn.chess.move(mv);
        if (mv.captured) {
          const takenOn = mv.flags.includes("e") ? mv.to[0] + mv.from[1] : mv.to;
          const v = scn.meshes.get(takenOn);
          if (v) {
            v.position.copy(scn.slot(true, scn.takenByPlayer.length));
            scn.takenByPlayer.push(v);
          }
        }
        // the board as it is now, the captured pieces kept where they stand
        const keep = [...scn.taken, ...scn.takenByPlayer];
        for (const o of [...scn.board.children]) if (o.userData?.type && !keep.includes(o)) scn.board.remove(o);
        scn.sync();
        scn.seated.saw(squareToLocal(mv.to));
        run(rng.range(0.8, 2.2));
      } else {
        lab = `game ${g + 1}: thinking`;
        run(rng.range(1.2, 3.5), { thinking: true });
        lab = `game ${g + 1}: opponent ${mv.san}`;
        let placed = false;
        scn.handMove(mv, () => (placed = true));
        for (let i = 0; i < 48 && (!placed || (scn.seated as unknown as Record<string, any>).moving); i++) run(0.25);
        scn.chess.move(mv);
        const keep = [...scn.taken, ...scn.takenByPlayer];
        for (const o of [...scn.board.children]) if (o.userData?.type && !keep.includes(o)) scn.board.remove(o);
        scn.sync();
        run(rng.range(0.3, 1.0));
      }
      ply++;
    }
    // the end: they lose half the time (the king goes over), then the handshake
    const opp = player === "w" ? "b" : "w";
    let king: THREE.Object3D | undefined;
    for (const row of scn.chess.board()) for (const c of row) if (c && c.type === "k" && c.color === opp) king = scn.meshes.get(c.square);
    lab = `game ${g + 1}: end`;
    if (king && g % 2 === 0) {
      const fall = v3(-1, 0, 0).applyQuaternion(scn.board.quaternion.clone().invert());
      scn.seated.endGame({ obj: king, base: king.position.clone(), fall, height: king.userData.height, shadow: king.children[1] });
    } else scn.seated.endGame();
    run(4);
    lab = `game ${g + 1}: handshake`;
    scn.seated.shake();
    run(3);
  }
  return res;
}

// ---------------- report ----------------

const fmt = (m: number) => `${(m * 1000).toFixed(1)} mm`;
let failed = 0;
const json: Record<string, unknown> = {};
for (const id of AVATARS) {
  if (!existsSync(resolve(DREAMS, id, "avatar", "skeleton.json"))) {
    console.log(`skip ${id}: no bundle in dreams/`);
    continue;
  }
  const t0 = Date.now();
  const r = runAvatar(id);
  console.log(`  ${r.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s; worst reach error ${fmt(r.reachError)} (${r.reachAt})`);
  for (const h of r.handshake) {
    console.log(`  handshake ${h}`);
    if (h.includes("WRONG")) failed++;
  }
  const sections: [string, Map<string, Hit>, boolean][] = [
    ["capsules (fingers, palm, forearm, upper arm, thighs)", r.capsule, true],
    ["Gaussians (hand and forearm centres, 8th deepest; torso vs chair; thighs vs table)", r.gauss, true],
    ["fingers inside the piece they hold", r.grip, true],
    ["resting hands above the table (floating)", r.floats, false],
  ];
  for (const [title, map, gate] of sections) {
    console.log(`  -- ${title}`);
    const rows = [...map.entries()].sort((a, b) => b[1].depth - a[1].depth);
    if (!rows.length) console.log("     none");
    for (const [k, h] of rows) {
      const shown = !h.scenario.includes("(never chosen)");
      const bad = shown && (gate ? h.depth > LIMIT : h.depth > 0.02);
      if (bad) failed++;
      console.log(`     ${bad ? "FAIL" : shown || h.depth <= LIMIT ? "ok  " : "off "} ${k}: ${fmt(h.depth)} (${h.part} in ${h.obstacle}; ${h.scenario}, t ${h.t.toFixed(2)} s; ${h.what})`);
    }
  }
  console.log("  -- joints (range seen over everything; limits in radians)");
  const range = new Map<string, { max: number; maxAt: string; min: number; minAt: string }>();
  for (const [k, j] of r.joints) {
    const name = k.split(" | ")[1];
    if (j.maxAt.includes("(never chosen)")) continue; // a pose this avatar is never given
    const [lo, hi] = jointLimit(name);
    if (j.max > hi + 1e-6) {
      failed++;
      console.log(`     FAIL ${k}: ${j.max.toFixed(3)} > ${hi} (${j.maxAt})`);
    }
    if (j.min < lo - 1e-6) {
      failed++;
      console.log(`     FAIL ${k}: ${j.min.toFixed(3)} < ${lo} (${j.minAt})`);
    }
    const w = range.get(name);
    if (!w) range.set(name, { ...j });
    else {
      if (j.max > w.max) [w.max, w.maxAt] = [j.max, j.maxAt];
      if (j.min < w.min) [w.min, w.minAt] = [j.min, j.minAt];
    }
  }
  for (const [name, w] of [...range.entries()].sort()) {
    const [lo, hi] = jointLimit(name);
    console.log(`     ${name}: ${w.min.toFixed(2)}..${w.max.toFixed(2)} (limit ${lo}..${hi}; max at ${w.maxAt.split(";")[0]})`);
  }
  json[id] = {
    frames: r.frames,
    reachError: r.reachError,
    capsule: Object.fromEntries(r.capsule),
    gauss: Object.fromEntries(r.gauss),
    grip: Object.fromEntries(r.grip),
    floats: Object.fromEntries(r.floats),
    joints: Object.fromEntries(r.joints),
  };
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(json, null, 1));
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nCHESS_POSES_OK");
