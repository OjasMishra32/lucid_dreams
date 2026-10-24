import * as THREE from "three";
import { type Beats, COUNT_IN, countAt } from "./beats";
import type { Lesson, Step } from "./experience";
import { type BodyJoints, eyeHeightOf, headJointOf, jointAt, matchOf, type Part, PARTS, SWAP, WEIGHT } from "./follow";
import { ScoreCard } from "./scorecard";
import { liveJoints } from "./xr/hands";
import { handIndex } from "./xr/menu";

// Your ghost: on your turn in a lesson the headset records what it knows of your body (your head, and both hands' 25
// joints) at 30 Hz; after the turn the step plays once more at its speed with that recording beside them, a soft light
// figure of you (glowing hands, the head as an oval with a nose line, shoulders and elbows worked out from those with a
// two-bone reach), so the two of you do the step side by side. Your recording is fitted to their clock (where you began
// and how fast you went), and drawn at their size, in their way round (a mirror copy when they face you), so a hand that
// was off shows as off. At the moments you were furthest from them a thin amber line runs from your hand to where theirs
// was, with the tip in words ("Left hand 18 cm low at the drop"). Each attempt's match uses Follow along's own rule over
// the whole move; after the routine a card gives each step its stars, the best step and the one to practise.
//
// The ghost stands beside them, never in front: about 0.9 m to one side (more if their arms or yours reach that way),
// on the side away from the step card, never within reach of you; anything of it that would cross them as you look dims.

type Place = "facing" | "beside" | "ahead";

/** The 25 joints of a WebXR hand, in the API's own order. */
export const HAND_JOINTS = [
  "wrist",
  "thumb-metacarpal",
  "thumb-phalanx-proximal",
  "thumb-phalanx-distal",
  "thumb-tip",
  ...["index-finger", "middle-finger", "ring-finger", "pinky-finger"].flatMap((f) => [
    `${f}-metacarpal`,
    `${f}-phalanx-proximal`,
    `${f}-phalanx-intermediate`,
    `${f}-phalanx-distal`,
    `${f}-tip`,
  ]),
];
const HAND_BONES: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4]];
for (let f = 0; f < 4; f++) {
  const b = 5 + f * 5;
  HAND_BONES.push([0, b], [b, b + 1], [b + 1, b + 2], [b + 2, b + 3], [b + 3, b + 4]);
}

const RATE_HZ = 30;
const STATURE_PER_EYE = 1 / 0.936; // eye height is about 93.6% of standing height
const GHOST = 0xe7e1ff; // light lavender: never their colours, never Follow along's blue targets
const GAP = 0xffc86b; // the gap lines' amber
const SIDE_MIN = 0.9;
const SIDE_MAX = 1.5;

type V = THREE.Vector3;
const v3 = () => new THREE.Vector3();

/** One moment of your turn as the headset saw it (world space). */
export interface Sample {
  t: number; // seconds into your turn
  eye: V;
  q: THREE.Quaternion;
  hands: (Float32Array | null)[]; // [your left, your right]: 25 joints x 3, or null while that hand isn't tracked
}

/** One moment of you, in their space (bundle axes, unmirrored, about the root on the floor, at their size). */
export interface Pose {
  t: number;
  eye: V;
  fwd: V; // where your face points (unit)
  up: V;
  head: V; // your head joint (Follow along's)
  neck: V;
  pelvis: V;
  shoulder: V[]; // [left, right]: yours, worked out from your head
  elbow: (V | null)[];
  wrist: (V | null)[];
  hand: (Float32Array | null)[];
}

export interface Gap {
  part: Part; // yours
  c: number; // clip time of the moment
  cm: number;
  text: string; // "Left hand 18 cm low at the drop"
  short: string; // "18 cm low", beside the line
}

/** One attempt at a step, fitted to their clock. */
export interface Take {
  step: number;
  start: number;
  end: number;
  length: number; // seconds recorded
  poses: Pose[];
  offset: number; // their clip time c plays your moment offset + (c - start) / rate
  rate: number;
  score: number; // 0-100: Follow along's rule, over the whole move
  stars: number; // 0-5 in halves
  gaps: Gap[];
  timing: string | null; // "About 15% slower than them"
  tips: string[]; // the gaps in words, biggest first, then the timing
  root: V; // their mean head position on the floor through the step (bundle space)
  flip: boolean; // your left hand is compared with their right (a mirror copy, or Mirror on)
  scale: number; // your eye height against theirs
  extent: { you: [number, number]; them: [number, number] }; // x range about the root, bundle space, unmirrored
}

export interface TurnContext {
  joints: BodyJoints;
  index: Record<string, number>;
  step: Step;
  stepIndex: number;
  facing: boolean; // they face you (you copy them like a mirror)
  mirrored: boolean; // they're drawn flipped (the palm menu's Mirror)
  front: V; // world: the way their front faces (horizontal unit)
  theirEye: number;
  yourEye: number;
  beats: Beats | null;
  leadIn: number;
}

/** Stars from a match score: five in halves, 92 for all five, never rounded up. */
export function starsOf(score: number): number {
  return THREE.MathUtils.clamp(Math.floor((score / 92) * 10) / 2, 0, 5);
}

/** How your timing compared, in words, or null when it was with them: your speed against theirs, and (with a count-in)
 * how far off the count you came in. */
export function timingOf(offset: number, rate: number, leadIn: number | null): string | null {
  if (rate < 0.88) return `About ${Math.round((1 - rate) * 100)}% slower than them`;
  if (rate > 1.12) return `About ${Math.round((rate - 1) * 100)}% quicker than them`;
  if (leadIn != null && Math.abs(offset - leadIn) >= 0.2)
    return `In ${(Math.abs(offset - leadIn)).toFixed(1)} s ${offset > leadIn ? "after" : "before"} the count`;
  return null;
}

/** The step's moments by name: "Turn and drop" has a turn and a drop; else the count (with a beat), else where in it. */
export function momentOf(step: Step, c: number, beats: Beats | null): string {
  const p = (c - step.start) / Math.max(1e-3, step.end - step.start);
  const two = /^\s*([a-z]+)\s+and\s+([a-z]+)\s*$/i.exec(step.title);
  if (two) return `at the ${(p < 0.5 ? two[1] : two[2]).toLowerCase()}`;
  if (beats) return `on count ${countAt(beats, step.start, c)}`;
  return p < 0.25 ? "at the start" : p < 0.6 ? "midway" : p < 0.85 ? "near the end" : "at the end";
}

/** A gap in words, in your terms: r to your right, u up, f forward (metres). */
export function describe(part: Part, r: number, u: number, f: number): { text: string; short: string; cm: number } {
  const name = part === "head" ? "Head" : part === "left_wrist" ? "Left hand" : "Right hand";
  const out = part === "left_wrist" ? -r : part === "right_wrist" ? r : 0; // away from your middle
  const axes = [
    { v: Math.abs(u), word: u > 0 ? "high" : "low", short: u > 0 ? "high" : "low" },
    { v: Math.abs(f), word: f > 0 ? "too far forward" : "too far back", short: f > 0 ? "forward" : "back" },
    part === "head"
      ? { v: Math.abs(r), word: r > 0 ? "too far right" : "too far left", short: r > 0 ? "right" : "left" }
      : { v: Math.abs(out), word: out > 0 ? "too wide" : "too close in", short: out > 0 ? "wide" : "in close" },
  ].sort((a, b) => b.v - a.v);
  const cm = Math.round(Math.hypot(r, u, f) * 100);
  const how = axes[1].v > 0.55 * axes[0].v ? `${axes[0].short} and ${axes[1].short}` : axes[0].word;
  return { text: `${name} ${cm} cm ${how}`, short: `${cm} cm ${how}`, cm };
}

/** Elbow from shoulder S to wrist W (upper arm a, forearm b), bending toward `pole`. */
function elbowOf(S: V, W: V, a: number, b: number, pole: V, out: V): V {
  const d = v3().subVectors(W, S);
  let len = d.length();
  if (len < 1e-4) return out.copy(S).addScaledVector(pole, a);
  d.divideScalar(len);
  len = THREE.MathUtils.clamp(len, Math.abs(a - b) + 1e-3, a + b - 1e-3);
  const x = (a * a - b * b + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  const p = pole.clone().addScaledVector(d, -pole.dot(d));
  if (p.lengthSq() < 1e-8) p.set(0, -1, 0).addScaledVector(d, d.y);
  p.normalize();
  return out.copy(S).addScaledVector(d, x).addScaledVector(p, h);
}

const lerpV = (a: V | null, b: V | null, k: number, out: V): V | null => {
  if (a && b) return out.lerpVectors(a, b, k);
  const one = k < 0.5 ? a ?? b : b ?? a;
  return one ? out.copy(one) : null;
};

/** Your pose at moment tau of a take (between recorded samples), into `out` (reused). */
export function poseAt(poses: Pose[], tau: number, out: Pose): Pose {
  let lo = 0, hi = poses.length - 1;
  if (tau <= poses[0].t) hi = 0;
  else if (tau >= poses[hi].t) lo = hi;
  else
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (poses[mid].t <= tau) lo = mid;
      else hi = mid;
    }
  const a = poses[lo], b = poses[hi];
  const k = hi === lo ? 0 : (tau - a.t) / (b.t - a.t);
  out.t = tau;
  out.eye.lerpVectors(a.eye, b.eye, k);
  out.fwd.lerpVectors(a.fwd, b.fwd, k).normalize();
  out.up.lerpVectors(a.up, b.up, k).normalize();
  out.head.lerpVectors(a.head, b.head, k);
  out.neck.lerpVectors(a.neck, b.neck, k);
  out.pelvis.lerpVectors(a.pelvis, b.pelvis, k);
  for (let s = 0; s < 2; s++) {
    out.shoulder[s].lerpVectors(a.shoulder[s], b.shoulder[s], k);
    out.wrist[s] = lerpV(a.wrist[s], b.wrist[s], k, out.wrist[s] ?? v3());
    out.elbow[s] = lerpV(a.elbow[s], b.elbow[s], k, out.elbow[s] ?? v3());
    const ha = a.hand[s], hb = b.hand[s];
    if (ha && hb) {
      const h = (out.hand[s] ??= new Float32Array(75));
      for (let i = 0; i < 75; i++) h[i] = ha[i] + (hb[i] - ha[i]) * k;
    } else out.hand[s] = (k < 0.5 ? ha ?? hb : hb ?? ha) ?? null;
  }
  return out;
}

export const emptyPose = (): Pose => ({
  t: 0,
  eye: v3(),
  fwd: v3(),
  up: v3(),
  head: v3(),
  neck: v3(),
  pelvis: v3(),
  shoulder: [v3(), v3()],
  elbow: [null, null],
  wrist: [null, null],
  hand: [null, null],
});

/** Your part's point in a pose (head joint, or a wrist), or null while it wasn't tracked. */
const partOf = (p: Pose, part: Part): V | null => (part === "head" ? p.head : p.wrist[part === "left_wrist" ? 0 : 1]);

/**
 * The turn's recording turned into a take: into their space, fitted to their clock, scored, and its biggest gaps put in
 * words. Null when there's too little of you in it (hands not tracked through most of the turn).
 */
export function analyse(samples: Sample[], ctx: TurnContext): Take | null {
  if (samples.length < 10) return null;
  const tracked = samples.filter((s) => s.hands[0] || s.hands[1]).length;
  if (tracked < samples.length * 0.3) return null;
  const { step, joints, index } = ctx;
  const dur = step.end - step.start;
  const length = samples[samples.length - 1].t;
  const s = THREE.MathUtils.clamp(ctx.yourEye / ctx.theirEye, 0.75, 1.3);
  const statureYou = ctx.yourEye * STATURE_PER_EYE;
  const statureThem = ctx.theirEye * STATURE_PER_EYE;
  const k = statureYou / 1.75;
  // your body's axes: your forward is toward them when they face you, else the way they face
  const fwdB = ctx.front.clone().setY(0).normalize().multiplyScalar(ctx.facing ? -1 : 1);
  const rightB = new THREE.Vector3(-fwdB.z, 0, fwdB.x);
  const ms = (ctx.mirrored ? -1 : 1) * (ctx.facing ? -1 : 1); // your right lands on their right (+1) or left (-1)
  const flip = ms < 0;
  const srcOf = (part: Part): Part => (flip ? SWAP[part] : part);

  // their side: mean head on the floor through the step, and their parts about it
  const M = 24;
  const root = v3();
  const tmp = v3();
  for (let j = 0; j < M; j++) {
    jointAt(joints, index, "head", step.start + (dur * j) / (M - 1), tmp);
    root.x += tmp.x / M;
    root.z += tmp.z / M;
  }
  const theirs = (part: Part, c: number, out: V) => jointAt(joints, index, srcOf(part), c, out).sub(root);

  // your side, in the world: head joints, a torso that turns slowly after the head, the shoulders off that
  const heads = samples.map((x) => headJointOf(x.eye, x.q, v3()));
  const fwds = samples.map((x) => v3().set(0, 0, -1).applyQuaternion(x.q));
  const ups = samples.map((x) => v3().set(0, 1, 0).applyQuaternion(x.q));
  const headTop = Math.max(...heads.map((h) => h.y));
  const spine = Math.max(0.3, headTop - 0.53 * statureYou);
  const torso = v3().copy(fwdB);
  const hips = v3().copy(heads[0]).setY(0);
  const world = samples.map((x, i) => {
    const hf = tmp.copy(fwds[i]).setY(0);
    const dt = i ? x.t - samples[i - 1].t : 0;
    if (hf.lengthSq() > 1e-4) torso.lerp(hf.normalize(), i ? 1 - Math.exp(-dt / 0.4) : 1).normalize();
    const right = v3().set(-torso.z, 0, torso.x);
    const neck = v3().copy(heads[i]).addScaledVector(torso, -0.02 * k);
    neck.y -= 0.09 * k;
    hips.lerp(tmp.set(neck.x, 0, neck.z), i ? 1 - Math.exp(-dt / 0.6) : 1);
    const shoulders = [-1, 1].map((side) => v3().copy(neck).addScaledVector(right, side * 0.185 * k).setY(neck.y - 0.035 * k));
    return { neck, shoulders, pelvis: v3().set(hips.x, Math.max(0.25, heads[i].y - spine), hips.z) };
  });

  const toPoses = (O: V): Pose[] => {
    const map = (X: V, out: V) => {
      tmp.subVectors(X, O);
      return out.set(ms * (tmp.x * rightB.x + tmp.z * rightB.z), X.y, -(tmp.x * fwdB.x + tmp.z * fwdB.z)).divideScalar(s);
    };
    const dir = (d: V, out: V) => out.set(ms * (d.x * rightB.x + d.z * rightB.z), d.y, -(d.x * fwdB.x + d.z * fwdB.z)).normalize();
    const a = 0.186 * statureThem, b = 0.146 * statureThem; // upper arm and forearm at their size
    return samples.map((x, i) => {
      const hand = x.hands.map((h) => {
        if (!h) return null;
        const out = new Float32Array(75);
        for (let j = 0; j < 25; j++) {
          map(tmp.set(h[j * 3], h[j * 3 + 1], h[j * 3 + 2]), tmp);
          out[j * 3] = tmp.x;
          out[j * 3 + 1] = tmp.y;
          out[j * 3 + 2] = tmp.z;
        }
        return out;
      });
      const shoulder = world[i].shoulders.map((w) => map(w, v3()));
      const neck = map(world[i].neck, v3());
      const wrist = hand.map((h) => (h ? v3().set(h[0], h[1], h[2]) : null));
      const elbow = wrist.map((w, sd) => {
        if (!w) return null;
        const outward = Math.sign(shoulder[sd].x - neck.x) || (sd ? 1 : -1);
        return elbowOf(shoulder[sd], w, a, b, v3().set(outward * 0.6, -0.75, 0.3).normalize(), v3());
      });
      return {
        t: x.t,
        eye: map(x.eye, v3()),
        fwd: dir(fwds[i], v3()),
        up: dir(ups[i], v3()),
        head: map(heads[i], v3()),
        neck,
        pelvis: map(world[i].pelvis, v3()),
        shoulder,
        elbow,
        wrist,
        hand,
      };
    });
  };

  // their parts at M moments of the step, about their root
  const cs = Array.from({ length: M }, (_, j) => step.start + (dur * j) / (M - 1));
  const them = PARTS.map((part) => cs.map((c) => theirs(part, c, v3())));
  const scratch = emptyPose();
  const fit = (poses: Pose[]) => {
    let best = { cost: Infinity, offset: Math.max(0, length - dur), rate: 1 };
    for (let rate = 0.6; rate <= 1.5001; rate += 0.05)
      for (let offset = 0; offset + dur / rate <= length + 0.25; offset += 0.05) {
        let cost = 0, n = 0;
        for (let j = 0; j < M; j++) {
          const p = poseAt(poses, offset + (cs[j] - step.start) / rate, scratch);
          PARTS.forEach((part, q) => {
            const mine = partOf(p, part);
            if (!mine) return;
            cost += WEIGHT[part] * mine.distanceTo(them[q][j]);
            n += WEIGHT[part];
          });
        }
        if (!n) continue;
        cost = cost / n + 0.03 * Math.abs(offset - ctx.leadIn) + 0.05 * Math.abs(Math.log(rate));
        if (cost < best.cost) best = { cost, offset, rate };
      }
    return best;
  };
  // the root on your side: your mean head on the floor, first over the whole turn, then over the part that's the move
  const meanHead = (from: number, to: number) => {
    const O = v3();
    let n = 0;
    samples.forEach((x, i) => {
      if (x.t < from || x.t > to) return;
      O.x += heads[i].x;
      O.z += heads[i].z;
      n++;
    });
    return n ? O.divideScalar(n).setY(0) : heads[0].clone().setY(0);
  };
  let poses = toPoses(meanHead(0, length));
  let fitted = fit(poses);
  poses = toPoses(meanHead(fitted.offset, fitted.offset + dur / fitted.rate));
  fitted = fit(poses);
  const tauOf = (c: number) => fitted.offset + (c - step.start) / fitted.rate;

  // the match through the move (Follow along's rule, in your size), and the gaps along it
  const N = 60;
  let total = 0, frames = 0;
  const gaps: { part: Part; c: number; d: number; r: number; u: number; f: number }[][] = PARTS.map(() => []);
  const T = v3();
  for (let j = 0; j < N; j++) {
    const c = step.start + (dur * j) / (N - 1);
    const p = poseAt(poses, tauOf(c), scratch);
    let sum = 0, w = 0;
    PARTS.forEach((part, q) => {
      const mine = partOf(p, part);
      if (!mine) return;
      theirs(part, c, T);
      const g = tmp.subVectors(mine, T);
      const r = ms * g.x * s, u = g.y * s, f = -g.z * s;
      const d = Math.hypot(r, u, f);
      sum += WEIGHT[part] * matchOf(d);
      w += WEIGHT[part];
      gaps[q].push({ part, c, d, r, u, f });
    });
    if (w) {
      total += sum / w;
      frames++;
    }
  }
  const score = frames ? (100 * total) / frames : 0;
  // the biggest gaps: each one a peak of its own, apart in time, the largest first
  const peaks = gaps.flatMap((list) =>
    list.filter((g, i) => g.d > (g.part === "head" ? 0.12 : 0.08) && (i === 0 || g.d >= list[i - 1].d) && (i === list.length - 1 || g.d >= list[i + 1].d)),
  );
  peaks.sort((a, b) => b.d - a.d);
  const apart = Math.max(0.3, dur * 0.2);
  const chosen: typeof peaks = [];
  for (const g of peaks) {
    if (chosen.length >= 3) break;
    if (chosen.some((x) => x.part === g.part && Math.abs(x.c - g.c) < apart)) continue; // both hands at one moment is fine
    chosen.push(g);
  }
  const words = chosen.map((g) => {
    const d = describe(g.part, g.r, g.u, g.f);
    return { part: g.part, c: g.c, cm: d.cm, text: `${d.text} ${momentOf(step, g.c, ctx.beats)}`, short: d.short };
  });

  const timing = timingOf(fitted.offset, fitted.rate, ctx.beats ? ctx.leadIn : null);

  // how far either of you reaches to each side, for where the ghost can stand
  const you: [number, number] = [Infinity, -Infinity];
  for (const p of poses) {
    if (p.t < fitted.offset - 0.1 || p.t > fitted.offset + dur / fitted.rate + 0.1) continue;
    const xs = [p.head.x, p.shoulder[0].x, p.shoulder[1].x, ...p.wrist.map((w) => w?.x ?? p.head.x), ...p.elbow.map((e) => e?.x ?? p.head.x)];
    for (const x of xs) {
      you[0] = Math.min(you[0], x);
      you[1] = Math.max(you[1], x);
    }
  }
  const theirX: [number, number] = [Infinity, -Infinity];
  for (const c of cs)
    for (const name of joints.names) {
      const x = jointAt(joints, index, name, c, tmp).x - root.x;
      theirX[0] = Math.min(theirX[0], x);
      theirX[1] = Math.max(theirX[1], x);
    }
  if (!Number.isFinite(you[0])) you[0] = you[1] = 0;

  return {
    step: ctx.stepIndex,
    start: step.start,
    end: step.end,
    length,
    poses,
    offset: fitted.offset,
    rate: fitted.rate,
    score,
    stars: starsOf(score),
    gaps: words,
    timing,
    tips: [...words.map((w) => w.text).slice(0, timing ? 2 : 3), ...(timing ? [timing] : [])],
    root,
    flip,
    scale: s,
    extent: { you, them: theirX },
  };
}

// ---------------- the figure ----------------

function haloTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.25, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function ringTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  x.strokeStyle = "rgba(255,255,255,0.95)";
  x.lineWidth = 10;
  x.beginPath();
  x.arc(64, 64, 46, 0, Math.PI * 2);
  x.stroke();
  return new THREE.CanvasTexture(c);
}

/** A soft shell: faint inside, glowing toward its edge (the head as light, not a solid). */
function shellMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float opacity;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float a = (0.07 + 0.85 * pow(rim, 2.4)) * opacity;
        gl_FragColor = vec4(color * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** A short label as a sprite, drawn at twice its size so it reads crisp. */
function labelSprite(text: string, color: string, height = 0.04): THREE.Sprite {
  const c = document.createElement("canvas");
  const x = c.getContext("2d")!;
  const font = '600 64px -apple-system, "SF Pro Text", "Inter", sans-serif';
  x.font = font;
  const w = Math.ceil(x.measureText(text).width) + 72;
  c.width = w;
  c.height = 112;
  x.font = font;
  x.fillStyle = "rgba(24,24,28,0.78)";
  x.beginPath();
  x.roundRect(2, 2, w - 4, 108, 54);
  x.fill();
  x.fillStyle = color;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(text, w / 2, 58);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
  sp.scale.set((height * w) / 112, height, 1);
  sp.renderOrder = 12;
  return sp;
}

const JOINTS = 25 * 2 + 6; // hands, then neck, pelvis, shoulders, elbows
const BONES = 24 * 2 + 7; // hands, then the shoulder line, upper arms, forearms, spine
const UP = new THREE.Vector3(0, 1, 0);

class Figure {
  readonly group = new THREE.Group();
  private joints: THREE.InstancedMesh;
  private bones: THREE.InstancedMesh;
  private head: THREE.Mesh;
  private nose: THREE.Mesh;
  private halos: THREE.Sprite[] = [];
  private floor: THREE.Mesh;
  private you: THREE.Sprite;
  private shell: THREE.ShaderMaterial;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private c = new THREE.Color();
  private basis = new THREE.Matrix4();
  private bx = new THREE.Vector3();
  private by = new THREE.Vector3();
  private bz = new THREE.Vector3();
  private pa = new THREE.Vector3();
  private pb = new THREE.Vector3();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  /** Per point, how much it's dimmed (it would cross them as you look); set by the caller before draw. */
  dim: (p: V) => number = () => 1;

  constructor() {
    const additive = { color: GHOST, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ ...additive, opacity: 0.85 }), JOINTS);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), new THREE.MeshBasicMaterial({ ...additive, opacity: 0.6 }), BONES);
    for (const im of [this.joints, this.bones]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      im.frustumCulled = false;
      im.renderOrder = 6;
      this.group.add(im);
    }
    this.shell = shellMaterial(GHOST);
    this.head = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), this.shell);
    this.head.renderOrder = 6;
    this.nose = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1), new THREE.MeshBasicMaterial({ ...additive, opacity: 0.9 }));
    this.nose.renderOrder = 6;
    const halo = haloTexture();
    for (let i = 0; i < 2; i++) {
      const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, color: GHOST, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      h.scale.setScalar(0.11);
      h.renderOrder = 5;
      this.halos.push(h);
      this.group.add(h);
    }
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: halo, color: GHOST, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.renderOrder = 1;
    this.you = labelSprite("You", "#e7e1ff", 0.05);
    this.group.add(this.head, this.nose, this.floor, this.you);
    this.group.visible = false;
  }

  private joint(i: number, p: V, r: number, bright: number) {
    this.m.compose(p, this.q.identity(), this.s.setScalar(r));
    this.joints.setMatrixAt(i, this.m);
    this.joints.setColorAt(i, this.c.setScalar(bright * this.dim(p)));
  }

  private bone(i: number, p: V | null, q: V | null, r: number, bright: number) {
    if (!p || !q || p.distanceToSquared(q) < 1e-10) return this.bones.setMatrixAt(i, this.zero);
    this.a.subVectors(q, p);
    const len = this.a.length();
    this.q.setFromUnitVectors(UP, this.a.divideScalar(len));
    this.m.compose(this.b.addVectors(p, q).multiplyScalar(0.5), this.q, this.s.set(r, len, r));
    this.bones.setMatrixAt(i, this.m);
    this.bones.setColorAt(i, this.c.setScalar(bright * Math.min(this.dim(p), this.dim(q))));
  }

  /** Draws a pose (already in the person's space, as drawn) at the given strength (0 hidden, 1 full). */
  draw(p: Pose, size: number, alpha: number) {
    this.group.visible = alpha > 0.002;
    if (!this.group.visible) return;
    (this.joints.material as THREE.MeshBasicMaterial).opacity = 0.85 * alpha;
    (this.bones.material as THREE.MeshBasicMaterial).opacity = 0.6 * alpha;
    const P = this.pa;
    for (let h = 0; h < 2; h++) {
      const hand = p.hand[h];
      for (let j = 0; j < 25; j++) {
        if (!hand) {
          this.joints.setMatrixAt(h * 25 + j, this.zero);
          continue;
        }
        P.set(hand[j * 3], hand[j * 3 + 1], hand[j * 3 + 2]);
        // the wrist largest, the fingertips smallest
        this.joint(h * 25 + j, P, (j === 0 ? 0.012 : j === 4 || j % 5 === 4 ? 0.007 : 0.008) * size, j === 0 ? 1 : 0.9);
      }
      HAND_BONES.forEach(([x, y], k) => {
        const i = h * 24 + k;
        if (!hand) return this.bone(i, null, null, 0, 0);
        this.bone(i, this.pa.set(hand[x * 3], hand[x * 3 + 1], hand[x * 3 + 2]), this.pb.set(hand[y * 3], hand[y * 3 + 1], hand[y * 3 + 2]), 0.0042 * size, 0.85);
      });
      const halo = this.halos[h];
      halo.visible = !!p.wrist[h];
      if (p.wrist[h]) {
        halo.position.copy(p.wrist[h]!);
        (halo.material as THREE.SpriteMaterial).opacity = 0.4 * alpha * this.dim(p.wrist[h]!);
      }
    }
    // the inferred upper body: quieter than the hands (it's worked out, not seen)
    this.joint(50, p.neck, 0.015 * size, 0.6);
    this.joint(51, p.pelvis, 0.018 * size, 0.4);
    this.joint(52, p.shoulder[0], 0.016 * size, 0.6);
    this.joint(53, p.shoulder[1], 0.016 * size, 0.6);
    for (let s = 0; s < 2; s++) {
      if (p.elbow[s]) this.joint(54 + s, p.elbow[s]!, 0.014 * size, 0.6);
      else this.joints.setMatrixAt(54 + s, this.zero);
    }
    const b0 = 48;
    this.bone(b0, p.shoulder[0], p.shoulder[1], 0.0065 * size, 0.5);
    this.bone(b0 + 1, p.shoulder[0], p.elbow[0], 0.0075 * size, 0.55);
    this.bone(b0 + 2, p.elbow[0], p.wrist[0], 0.0068 * size, 0.55);
    this.bone(b0 + 3, p.shoulder[1], p.elbow[1], 0.0075 * size, 0.55);
    this.bone(b0 + 4, p.elbow[1], p.wrist[1], 0.0068 * size, 0.55);
    this.bone(b0 + 5, p.neck, p.pelvis, 0.0065 * size, 0.32);
    this.bone(b0 + 6, p.neck, p.head, 0.0065 * size, 0.45);
    this.joints.instanceMatrix.needsUpdate = this.bones.instanceMatrix.needsUpdate = true;
    if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;
    if (this.bones.instanceColor) this.bones.instanceColor.needsUpdate = true;
    // the head: an oval of light round where your skull was, a nose line pointing where you looked
    this.bz.copy(p.fwd);
    this.by.copy(p.up).addScaledVector(this.bz, -p.up.dot(this.bz)).normalize();
    this.bx.crossVectors(this.by, this.bz);
    this.basis.makeBasis(this.bx, this.by, this.bz);
    this.head.quaternion.setFromRotationMatrix(this.basis);
    const centre = this.b.copy(p.eye).addScaledVector(this.bz, -0.075 * size).addScaledVector(this.by, 0.01 * size);
    this.head.position.copy(centre);
    this.head.scale.set(0.077 * size, 0.108 * size, 0.096 * size);
    this.shell.uniforms.opacity.value = 1.1 * alpha * this.dim(centre);
    const tip = this.pa.copy(centre).addScaledVector(this.bz, 0.13 * size).addScaledVector(this.by, -0.045 * size);
    const root = this.pb.copy(centre).addScaledVector(this.bz, 0.09 * size).addScaledVector(this.by, -0.005 * size);
    this.nose.position.addVectors(root, tip).multiplyScalar(0.5);
    const dir = this.a.subVectors(tip, root);
    const len = dir.length();
    this.nose.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
    this.nose.scale.set(0.0032 * size, len, 0.0032 * size);
    (this.nose.material as THREE.MeshBasicMaterial).opacity = 0.9 * alpha * this.dim(centre);
    // grounded: a faint glow on the floor under the hips, and a small "You" over the head so it's never taken for them
    this.floor.position.set(p.pelvis.x, 0.003, p.pelvis.z);
    this.floor.scale.set(0.7, 0.7, 1);
    (this.floor.material as THREE.MeshBasicMaterial).opacity = 0.22 * alpha;
    this.you.position.copy(centre);
    this.you.position.y += 0.18 * size;
    (this.you.material as THREE.SpriteMaterial).opacity = 0.9 * alpha;
  }
}

class GapMark {
  readonly group = new THREE.Group();
  private line: THREE.Mesh;
  private ring: THREE.Sprite;
  label: THREE.Sprite | null = null;
  constructor(ringTex: THREE.Texture) {
    this.line = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: GAP, transparent: true, depthWrite: false, opacity: 0 }));
    this.ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color: GAP, transparent: true, depthWrite: false, opacity: 0 }));
    this.ring.scale.setScalar(0.06);
    this.line.renderOrder = this.ring.renderOrder = 7;
    this.group.add(this.line, this.ring);
    this.group.visible = false;
  }
  setText(text: string) {
    if (this.label) {
      this.group.remove(this.label);
      (this.label.material as THREE.SpriteMaterial).map?.dispose();
    }
    this.label = labelSprite(text, "#ffd99a", 0.055);
    this.group.add(this.label);
  }
  /** From your hand (as drawn) to where theirs was, at strength w. */
  show(from: V, to: V, w: number) {
    this.group.visible = w > 0.01;
    if (!this.group.visible) return;
    const d = v3().subVectors(to, from);
    const len = d.length();
    this.line.position.addVectors(from, to).multiplyScalar(0.5);
    this.line.quaternion.setFromUnitVectors(UP, len > 1e-6 ? d.divideScalar(len) : UP);
    this.line.scale.set(0.0028, Math.max(len, 1e-4), 0.0028);
    (this.line.material as THREE.MeshBasicMaterial).opacity = 0.85 * w;
    this.ring.position.copy(to);
    (this.ring.material as THREE.SpriteMaterial).opacity = 0.9 * w;
    if (this.label) {
      this.label.position.copy(to);
      this.label.position.y += 0.07;
      (this.label.material as THREE.SpriteMaterial).opacity = w;
    }
  }
}

export interface GhostOptions {
  joints: BodyJoints;
  lesson: Lesson;
  hands: THREE.Object3D[];
  sideOf: (i: number) => XRHandedness | null;
  beats: Beats | null;
  /** Where the step card is in the room (the ghost keeps clear of it). */
  card: () => THREE.Vector3 | null;
  /** The routine's name, on the card at its end. */
  title: string;
}

export class Ghost {
  /** In the person's own space: add it to the person, so it stands where they stand. */
  readonly group = new THREE.Group();
  /** Play every turn back with you beside them (the palm menu's Auto replay). */
  auto = true;
  /** The latest take of each step, and the latest of all. */
  readonly takes: (Take | null)[];
  last: Take | null = null;
  /** Follow along's best for each step's last attempt, for a step with no take. */
  readonly followBest: (number | null)[];
  /** The take that's playing in the ghost phase, and which side of them it stands (person space x). */
  playing: Take | null = null;
  sideX = 0;
  /** The end-of-routine card: put it where the step card is. */
  readonly card = new ScoreCard();
  /** The card has come up (true) or gone (false): the step card makes way for it. */
  onCard: (on: boolean) => void = () => {};
  private cardOn = false;
  private prev: { i: number; phase: string } | null = null;
  private idx: Record<string, number>;
  private theirEye: number;
  private yourEye = 0;
  private samples: Sample[] = [];
  private recording = false;
  private turnStart = 0;
  private lastSample = -Infinity;
  private figure = new Figure();
  private marks: GapMark[];
  private pose = emptyPose();
  private drawn = emptyPose();
  private alpha = 0;
  private active = false;
  private front = new THREE.Vector3();
  private yourEyeWorld = new THREE.Vector3(); // your eyes in the room, as of the last frame (for the side choice)
  private v = Array.from({ length: 8 }, () => new THREE.Vector3());

  constructor(private o: GhostOptions) {
    this.idx = Object.fromEntries(o.joints.names.map((n, i) => [n, i]));
    this.theirEye = eyeHeightOf(o.joints);
    this.takes = o.lesson.steps.map(() => null);
    this.followBest = o.lesson.steps.map(() => null);
    const ring = ringTexture();
    this.marks = [0, 1, 2].map(() => new GapMark(ring));
    this.group.add(this.figure.group, ...this.marks.map((m) => m.group));
  }

  setActive(on: boolean) {
    this.active = on;
    if (!on) {
      this.recording = false;
      this.samples = [];
      this.alpha = 0;
      this.hide();
      this.card.hide();
    }
  }

  /**
   * The lesson moved (Lesson.onChange). Coming round from the last step's turn (or its ghost) to the first step means
   * the routine is done: the card comes up with every step's stars.
   */
  onStep(now: number) {
    const { i, phase, steps } = this.o.lesson;
    const p = this.prev;
    this.prev = { i, phase };
    if (!this.active || !p || p.i !== steps.length - 1 || (p.phase !== "turn" && p.phase !== "ghost") || i !== 0 || phase !== "watch") return;
    if (!this.takes.some(Boolean) && !this.followBest.some((x) => x != null)) return;
    this.card.show(this.o.title, this.scores(), now);
  }

  /** Each step's stars: its latest take, else Follow along's best on its last attempt. */
  scores() {
    return this.o.lesson.steps.map((st, k) => {
      const take = this.takes[k];
      const score = take ? take.score : this.followBest[k];
      return { title: st.title, score: score ?? null, stars: score == null ? null : starsOf(score), tip: take?.tips[0] };
    });
  }

  private hide() {
    this.figure.group.visible = false;
    for (const m of this.marks) m.group.visible = false;
  }

  /**
   * Once a frame in your room. t: the clip time shown; now: performance.now(); eye, headQ: your headset; person: them
   * (where they're placed); mirrored: they're drawn flipped.
   */
  update(dt: number, t: number, now: number, eye: V, headQ: THREE.Quaternion, person: THREE.Object3D, mirrored: boolean) {
    if (!this.active) return;
    const lesson = this.o.lesson;
    this.yourEyeWorld.copy(eye);
    const card = this.card.update(now, dt);
    if (card !== this.cardOn) this.onCard((this.cardOn = card));
    this.yourEye = this.yourEye ? Math.max(eye.y, this.yourEye - dt * 0.01) : eye.y;
    // recording: your turn, from its first frame to its last (a turn cut short by Again / Back / Next is dropped)
    if (lesson.phase === "turn") {
      const start = lesson.turnEnds - lesson.turnLength;
      if (!this.recording || this.turnStart !== start) {
        this.recording = true;
        this.turnStart = start;
        this.samples = [];
        this.lastSample = -Infinity;
      }
      const at = (now - start) / 1000;
      if (at - this.lastSample >= 1 / RATE_HZ - 0.004) {
        this.lastSample = at;
        this.samples.push({ t: at, eye: eye.clone(), q: headQ.clone(), hands: [this.hand("left"), this.hand("right")] });
      }
    } else if (this.recording) {
      this.recording = false; // the turn was left some other way than its end
      this.samples = [];
    }
    // playing back: the step again on their clock, you beside them
    const take = lesson.phase === "ghost" && this.playing?.step === lesson.i ? this.playing : null;
    const want = take ? 1 : 0;
    this.alpha += (want - this.alpha) * (1 - Math.exp(-dt / 0.18));
    if (!take && this.alpha < 0.01) {
      this.alpha = 0;
      this.hide();
      return;
    }
    const k = take ?? this.playing;
    if (!k) return this.hide();
    this.draw(k, t, person, eye, mirrored);
  }

  private hand(side: "left" | "right"): Float32Array | null {
    const joints = liveJoints(this.o.hands[handIndex(this.o.sideOf, side)]);
    if (!joints.wrist?.visible) return null;
    const out = new Float32Array(75);
    const p = this.v[7];
    for (let j = 0; j < 25; j++) {
      const joint = joints[HAND_JOINTS[j]];
      if (!joint?.visible) return null;
      joint.getWorldPosition(p);
      out[j * 3] = p.x;
      out[j * 3 + 1] = p.y;
      out[j * 3 + 2] = p.z;
    }
    return out;
  }

  /**
   * Your turn has ended (Lesson.afterTurn): the recording becomes a take. True when it should play back now (Auto
   * replay on, and there was enough of you in it). place/mirrored/person: how they stood through the turn.
   */
  endTurn(place: Place, mirrored: boolean, person: THREE.Object3D, followBest: number | null): boolean {
    const lesson = this.o.lesson;
    this.followBest[lesson.i] = followBest;
    const samples = this.recording ? this.samples : [];
    this.recording = false;
    this.samples = [];
    person.updateMatrixWorld();
    this.front.set(0, 0, -1).transformDirection(person.matrixWorld);
    const take = analyse(samples, {
      joints: this.o.joints,
      index: this.idx,
      step: lesson.step,
      stepIndex: lesson.i,
      facing: place === "facing",
      mirrored,
      front: this.front,
      theirEye: this.theirEye,
      yourEye: this.yourEye || 1.6,
      beats: this.o.beats,
      leadIn: this.o.beats ? COUNT_IN : 0.3, // with a beat you go on the count; without, as soon as it's your turn
    });
    if (!take) return false;
    this.takes[lesson.i] = this.last = take;
    if (!this.auto) return false;
    this.begin(take, person, mirrored);
    return true;
  }

  /** "Watch my ghost": the latest take plays again (from its step's start), then the lesson goes on from there. */
  watch(person: THREE.Object3D, mirrored: boolean): boolean {
    if (!this.last) return false;
    this.begin(this.last, person, mirrored);
    this.o.lesson.replay(this.last.step);
    return true;
  }

  /** The words for this take's step card and voice. */
  tipsFor(step: number): string[] {
    return this.takes[step]?.tips ?? [];
  }

  /** What the device says as your ghost starts. */
  line(): string {
    const k = this.playing;
    if (!k) return "";
    const first = k.tips[0]?.replace(/(\d+) cm/, "$1 centimetres");
    return first ? `Here's you, beside them. ${first}.` : "Here's you, beside them. Right with them.";
  }

  private begin(take: Take, person: THREE.Object3D, mirrored: boolean) {
    this.playing = take;
    this.sideX = this.chooseSide(take, person, mirrored);
    take.gaps.forEach((g, i) => this.marks[i].setText(`${g.part === "head" ? "Head" : g.part === "left_wrist" ? "Left hand" : "Right hand"} ${g.short}`));
  }

  /** Beside them, on whichever side keeps it clear of their reach and yours, the step card, and you. */
  private chooseSide(take: Take, person: THREE.Object3D, mirrored: boolean): number {
    const mir = mirrored ? -1 : 1;
    // their reach and yours about the root, as drawn
    const them = mir > 0 ? take.extent.them : ([-take.extent.them[1], -take.extent.them[0]] as [number, number]);
    const you = mir > 0 ? take.extent.you : ([-take.extent.you[1], -take.extent.you[0]] as [number, number]);
    const need = (side: number) => THREE.MathUtils.clamp(side > 0 ? them[1] - you[0] + 0.12 : you[1] - them[0] + 0.12, SIDE_MIN, SIDE_MAX);
    person.updateMatrixWorld();
    const [eye, chest, card, toCard, toChest] = this.v;
    eye.copy(this.yourEyeWorld);
    const cardAt = this.o.card();
    const options = [1, -1].map((side) => {
      const d = need(side);
      person.localToWorld(chest.set(mir * take.root.x + side * d, 1.2, take.root.z));
      const reach = Math.hypot(chest.x - eye.x, chest.z - eye.z);
      let clear = 90;
      if (cardAt) {
        card.copy(cardAt);
        clear = THREE.MathUtils.radToDeg(toCard.subVectors(card, eye).angleTo(toChest.subVectors(chest, eye)));
      }
      return { x: side * d, d, ok: reach >= 0.9 && clear >= 18, clear, reach };
    });
    const good = options.filter((o) => o.ok).sort((a, b) => a.d - b.d);
    const pick = good[0] ?? options.sort((a, b) => Math.min(b.clear, b.reach * 30) - Math.min(a.clear, a.reach * 30))[0];
    return mir * take.root.x + pick.x;
  }

  private draw(take: Take, t: number, person: THREE.Object3D, eye: V, mirrored: boolean) {
    const mir = mirrored ? -1 : 1;
    const tau = THREE.MathUtils.clamp(take.offset + (t - take.start) / take.rate, 0, take.length);
    const p = poseAt(take.poses, tau, this.pose);
    // into the person's space as they're drawn, beside them
    const gx = this.sideX, gz = take.root.z;
    const place = (src: V, out: V) => out.set(mir * src.x + gx, src.y, src.z + gz);
    const d = this.drawn;
    d.t = p.t;
    place(p.eye, d.eye);
    d.fwd.set(mir * p.fwd.x, p.fwd.y, p.fwd.z);
    d.up.set(mir * p.up.x, p.up.y, p.up.z);
    place(p.head, d.head);
    place(p.neck, d.neck);
    place(p.pelvis, d.pelvis);
    for (let s = 0; s < 2; s++) {
      place(p.shoulder[s], d.shoulder[s]);
      d.wrist[s] = p.wrist[s] ? place(p.wrist[s]!, d.wrist[s] ?? v3()) : null;
      d.elbow[s] = p.elbow[s] ? place(p.elbow[s]!, d.elbow[s] ?? v3()) : null;
      const h = p.hand[s];
      if (h) {
        const out = (d.hand[s] ??= new Float32Array(75));
        for (let j = 0; j < 25; j++) {
          out[j * 3] = mir * h[j * 3] + gx;
          out[j * 3 + 1] = h[j * 3 + 1];
          out[j * 3 + 2] = h[j * 3 + 2] + gz;
        }
      } else d.hand[s] = null;
    }
    // never over them as you look: anything of the ghost inside their outline from your eyes, and nearer, dims
    person.updateMatrixWorld();
    const [centre, toC, toP, w] = this.v;
    jointAt(this.o.joints, this.idx, "spine2", t, centre);
    centre.x *= mir;
    person.localToWorld(centre);
    toC.subVectors(centre, eye);
    const dist = toC.length();
    const cone = Math.atan2(0.3, Math.max(0.3, dist));
    this.figure.dim = (q: V) => {
      person.localToWorld(w.copy(q));
      toP.subVectors(w, eye);
      if (toP.length() > dist + 0.3) return 1;
      const a = toP.angleTo(toC);
      return a < cone ? 0.25 : a < cone * 1.3 ? 0.25 + (0.75 * (a - cone)) / (cone * 0.3) : 1;
    };
    this.figure.draw(d, 1 / take.scale, this.alpha);
    // the gap lines at their moments: your hand (as drawn) to where theirs was, fading in and out around it
    const win = Math.max(0.18, (take.end - take.start) * 0.16);
    take.gaps.forEach((g, i) => {
      const mark = this.marks[i];
      const x = 1 - Math.abs(t - g.c) / win;
      const strength = x <= 0 ? 0 : x * x * (3 - 2 * x);
      const mine = g.part === "head" ? d.head : d.wrist[g.part === "left_wrist" ? 0 : 1];
      if (!mine || strength <= 0) return mark.show(mine ?? d.head, mine ?? d.head, 0);
      const src: Part = take.flip ? SWAP[g.part] : g.part;
      const theirs = jointAt(this.o.joints, this.idx, src, t, this.v[4]).sub(take.root);
      place(theirs, theirs);
      mark.show(mine, theirs, strength * this.alpha);
    });
    for (let i = take.gaps.length; i < this.marks.length; i++) this.marks[i].group.visible = false;
  }

  /** For checks (dev). */
  debug() {
    const r = (x: number) => +x.toFixed(3);
    const k = this.last;
    return {
      recording: this.recording,
      samples: this.samples.length,
      auto: this.auto,
      sideX: r(this.sideX),
      alpha: r(this.alpha),
      last: k
        ? { step: k.step, length: r(k.length), offset: r(k.offset), rate: r(k.rate), score: Math.round(k.score), stars: k.stars, tips: k.tips, flip: k.flip, scale: r(k.scale), poses: k.poses.length }
        : null,
      takes: this.takes.map((x) => (x ? { score: Math.round(x.score), stars: x.stars } : null)),
      followBest: this.followBest.map((x) => (x == null ? null : Math.round(x))),
    };
  }
}

/** Your ghost needs your hands' joints and their joints; nothing else in a lesson changes without it. */
export const canGhost = (lesson: Lesson | null, joints: BodyJoints | null): boolean => !!lesson && !!joints;
