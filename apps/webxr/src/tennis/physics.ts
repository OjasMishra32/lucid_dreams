import * as THREE from "three";
import { C, netHeight, WALL_X, WALL_Z } from "./court";

// A tennis ball in court space (court.ts): 6.7 cm, 57 g. Gravity, quadratic drag, the Magnus lift of its spin (topspin
// dips, slice floats), a low, skiddy grass bounce where friction at the contact patch trades pace for spin, the net
// (the tape takes most of its pace; the mesh stops it), and the walls round the run-off. One fixed step for everything
// (live play, the opponent's predictions, the shot solver), so what is predicted is what happens.

export const BALL_R = 0.0335;
const BALL_M = 0.057;
const AREA = Math.PI * BALL_R * BALL_R;
const RHO = 1.21;
const KD = (0.5 * RHO * 0.55 * AREA) / BALL_M; // drag: a = -KD |v| v
const KL = (0.5 * RHO * AREA) / BALL_M; // lift: a = KL Cl |v|^2 (w x v unit)
export const GRAVITY = 9.81;
export const STEP = 1 / 240;
const MU_GRASS = 0.42; // grass grips less than a hard court: the ball skids through
const SPIN_DECAY = 1 / 7; // per second, in the air

export interface Ball {
  p: THREE.Vector3;
  v: THREE.Vector3;
  w: THREE.Vector3; // spin, rad/s (right-hand rule)
  rolling: boolean;
}

export type BallEvent =
  | { type: "bounce"; p: THREE.Vector3; vIn: number; patch: number }
  | { type: "net"; p: THREE.Vector3; tape: boolean }
  | { type: "wall"; p: THREE.Vector3 };

export function newBall(): Ball {
  return { p: new THREE.Vector3(), v: new THREE.Vector3(), w: new THREE.Vector3(), rolling: false };
}
export function copyBall(to: Ball, from: Ball): Ball {
  to.p.copy(from.p);
  to.v.copy(from.v);
  to.w.copy(from.w);
  to.rolling = from.rolling;
  return to;
}

const _a = new THREE.Vector3();
const _c = new THREE.Vector3();

/** One step of h seconds. Events (bounce, net, wall) go to onEvent as they happen. */
export function stepBall(b: Ball, h: number, onEvent?: (e: BallEvent) => void, net = true) {
  const { p, v, w } = b;
  const px = p.x;
  const py = p.y;
  const pz = p.z;
  if (!b.rolling) {
    const s = v.length();
    _a.set(0, -GRAVITY, 0).addScaledVector(v, -KD * s);
    const ws = w.length();
    if (s > 0.5 && ws > 1) {
      const cl = Math.min(0.32, 1 / (2 + s / (BALL_R * ws)));
      _c.crossVectors(w, v).divideScalar(ws * s);
      _a.addScaledVector(_c, KL * cl * s * s);
    }
    v.addScaledVector(_a, h);
    p.addScaledVector(v, h);
    w.multiplyScalar(1 - h * SPIN_DECAY);
  } else {
    // rolling through grass: it slows quickly
    const s = Math.hypot(v.x, v.z);
    const dec = 3.2 * h;
    if (s <= dec) v.set(0, 0, 0);
    else v.multiplyScalar((s - dec) / s);
    v.y = 0;
    p.addScaledVector(v, h);
    p.y = BALL_R;
    w.set(v.z, 0, -v.x).divideScalar(BALL_R);
  }

  // the net: where the centre crossed z = 0 between the posts
  if (net && pz !== 0 && Math.sign(pz) !== Math.sign(p.z)) {
    const f = pz / (pz - p.z);
    const xc = px + (p.x - px) * f;
    const yc = py + (p.y - py) * f;
    if (Math.abs(xc) < C.postX + BALL_R) {
      const top = netHeight(xc);
      if (yc - BALL_R < top) {
        if (yc > top - BALL_R * 0.45) {
          // clipped the tape: most of the pace goes, it hops up and trickles on over
          v.z *= 0.42;
          v.x *= 0.75;
          v.y = Math.abs(v.y) * 0.25 + 0.9 + (yc - top) * 8;
          w.multiplyScalar(0.4);
          p.y = Math.max(p.y, top + BALL_R * 0.6);
          onEvent?.({ type: "net", p: new THREE.Vector3(xc, yc, 0), tape: true });
        } else {
          // into the mesh: it dies there and drops on the hitter's side
          p.set(xc, yc, Math.sign(pz) * (BALL_R + 0.004));
          v.set(v.x * 0.25, v.y * 0.3, -v.z * 0.08);
          w.multiplyScalar(0.2);
          b.rolling = false;
          onEvent?.({ type: "net", p: new THREE.Vector3(xc, yc, 0), tape: false });
        }
      }
    }
  }

  // the ground
  if (!b.rolling && p.y < BALL_R && v.y < 0) {
    p.y = BALL_R;
    const vn = -v.y;
    if (vn < 0.7) {
      b.rolling = true;
      v.y = 0;
    } else {
      const e = THREE.MathUtils.clamp(0.78 - 0.007 * vn, 0.62, 0.76); // a harder landing bounces relatively lower
      v.y = vn * e;
      // the contact point slides: friction slows it (and spins the ball) until it rolls, or until the grip runs out
      const ux = v.x + BALL_R * w.z;
      const uz = v.z - BALL_R * w.x;
      const u = Math.hypot(ux, uz);
      if (u > 1e-6) {
        const j = Math.min(MU_GRASS * (1 + e) * vn, 0.4 * u);
        const jx = (-ux / u) * j;
        const jz = (-uz / u) * j;
        v.x += jx;
        v.z += jz;
        w.x -= (1.5 / BALL_R) * jz;
        w.z += (1.5 / BALL_R) * jx;
      }
      v.x *= 0.975; // the grass takes a little of the pace as well
      v.z *= 0.975;
      w.y *= 0.6;
      onEvent?.({ type: "bounce", p: p.clone(), vIn: vn, patch: THREE.MathUtils.clamp(0.008 + vn * 0.0011, 0.008, 0.02) });
    }
  }

  // the walls round the run-off
  if (Math.abs(p.x) > WALL_X - BALL_R) {
    p.x = Math.sign(p.x) * (WALL_X - BALL_R);
    v.x = -v.x * 0.3;
    v.z *= 0.5;
    onEvent?.({ type: "wall", p: p.clone() });
  }
  if (Math.abs(p.z) > WALL_Z - BALL_R) {
    p.z = Math.sign(p.z) * (WALL_Z - BALL_R);
    v.z = -v.z * 0.3;
    v.x *= 0.5;
    onEvent?.({ type: "wall", p: p.clone() });
  }
}

// ---------------------------------------------------------------- prediction

export interface Sample {
  t: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
}
export interface Prediction {
  samples: Sample[]; // every other step (1/120 s)
  events: { t: number; e: BallEvent }[];
}

/** The ball's path from now for up to maxT seconds, the same steps live play takes. stop() ends it early. */
export function predict(from: Ball, maxT: number, stop?: (b: Ball, t: number, events: { t: number; e: BallEvent }[]) => boolean): Prediction {
  const b = copyBall(newBall(), from);
  const out: Prediction = { samples: [], events: [] };
  let t = 0;
  let k = 0;
  while (t < maxT) {
    stepBall(b, STEP, (e) => out.events.push({ t: t + STEP, e }));
    t += STEP;
    if (k++ % 2 === 1) out.samples.push({ t, p: b.p.clone(), v: b.v.clone() });
    if (stop?.(b, t, out.events)) break;
  }
  return out;
}

// ---------------------------------------------------------------- the shot solver

export interface Shot {
  v: THREE.Vector3;
  w: THREE.Vector3;
  land: THREE.Vector3;
  clear: number; // meters over the net cord (Infinity when it doesn't cross)
  speed: number;
}

const fb = newBall();
/** Where a ball struck from p with v and spin w first lands (no net), and how high over the cord it crossed. */
function fly(p: THREE.Vector3, v: THREE.Vector3, w: THREE.Vector3, land: THREE.Vector3): number {
  fb.p.copy(p);
  fb.v.copy(v);
  fb.w.copy(w);
  fb.rolling = false;
  let clear = Infinity;
  const h = 1 / 120;
  for (let t = 0; t < 5; t += h) {
    const z0 = fb.p.z;
    const x0 = fb.p.x;
    const y0 = fb.p.y;
    stepBall(fb, h, undefined, false);
    if (z0 !== 0 && Math.sign(z0) !== Math.sign(fb.p.z)) {
      const f = z0 / (z0 - fb.p.z);
      const xc = x0 + (fb.p.x - x0) * f;
      clear = y0 + (fb.p.y - y0) * f - BALL_R - netHeight(xc);
    }
    if (fb.p.y <= BALL_R + 1e-4 && fb.v.y >= 0) break; // bounced
    if (fb.rolling) break;
  }
  land.copy(fb.p);
  return clear;
}

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _land = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/** The spin vector for `top` rad/s of topspin (negative: slice) on a ball heading along horizontal dir. */
export function spinFor(dir: THREE.Vector3, top: number, out = new THREE.Vector3()) {
  return out.set(dir.z, 0, -dir.x).normalize().multiplyScalar(top);
}

/**
 * A shot from `from` that lands on `target` (ground), at about `speed` m/s with `top` rad/s of topspin (negative:
 * slice) and `side` rad/s of sidespin (about the vertical: + curves it to the left of its line), crossing the net at
 * least `minClear` over the cord: the lowest arc that lands there, a slower ball when that arc would catch the net,
 * and its line turned against the curve so it still lands on the spot.
 */
export function solveShot(from: THREE.Vector3, target: THREE.Vector3, speed: number, top: number, minClear = 0.3, side = 0): Shot {
  const aim = target.clone();
  let shot = solveLine(from, aim, speed, top, minClear, side);
  if (side !== 0)
    for (let it = 0; it < 3; it++) {
      const miss = shot.land.clone().sub(target).setY(0);
      if (miss.length() < 0.05) break;
      aim.sub(miss);
      shot = solveLine(from, aim, speed, top, minClear, side);
    }
  return shot;
}

function solveLine(from: THREE.Vector3, target: THREE.Vector3, speed: number, top: number, minClear: number, side: number): Shot {
  _dir.set(target.x - from.x, 0, target.z - from.z);
  const D = _dir.length();
  _dir.divideScalar(Math.max(D, 1e-6));
  spinFor(_dir, top, _w);
  _w.y += side;
  let s = Math.max(3, speed);
  const distAt = (th: number) => {
    _v.copy(_dir).multiplyScalar(Math.cos(th) * s).setY(Math.sin(th) * s);
    const clear = fly(from, _v, _w, _land);
    return { d: (_land.x - from.x) * _dir.x + (_land.z - from.z) * _dir.z, clear };
  };
  const LO = -0.45;
  const HI = 0.8;
  let th = 0;
  let clear = Infinity;
  for (let round = 0; round < 18; round++) {
    if (distAt(HI).d < D) {
      s *= 1.15;
      continue;
    }
    if (distAt(LO).d > D) {
      s *= 0.86;
      continue;
    }
    let lo = LO;
    let hi = HI;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (distAt(mid).d < D) lo = mid;
      else hi = mid;
    }
    th = (lo + hi) / 2;
    clear = distAt(th).clear;
    if (clear >= minClear || s < 5) break;
    s *= 0.93; // too flat to clear: slower, higher
  }
  const v = _dir.clone().multiplyScalar(Math.cos(th) * s).setY(Math.sin(th) * s);
  const land = new THREE.Vector3();
  clear = fly(from, v, _w, land);
  return { v, w: _w.clone(), land, clear, speed: s };
}

/** A lob: launched `elevation` radians up, as fast as it needs to be to land on `target`. */
export function solveLob(from: THREE.Vector3, target: THREE.Vector3, elevation: number, top: number): Shot {
  _dir.set(target.x - from.x, 0, target.z - from.z);
  const D = _dir.length();
  _dir.divideScalar(Math.max(D, 1e-6));
  spinFor(_dir, top, _w);
  let lo = 2;
  let hi = 45;
  let clear = Infinity;
  for (let i = 0; i < 22; i++) {
    const s = (lo + hi) / 2;
    _v.copy(_dir).multiplyScalar(Math.cos(elevation) * s).setY(Math.sin(elevation) * s);
    clear = fly(from, _v, _w, _land);
    const d = (_land.x - from.x) * _dir.x + (_land.z - from.z) * _dir.z;
    if (d < D) lo = s;
    else hi = s;
  }
  const s = (lo + hi) / 2;
  const v = _dir.clone().multiplyScalar(Math.cos(elevation) * s).setY(Math.sin(elevation) * s);
  const land = new THREE.Vector3();
  clear = fly(from, v, _w, land);
  return { v, w: _w.clone(), land, clear, speed: s };
}

/**
 * A shot that comes to someone: it lands in `region` and, after the bounce, passes `hit` (the point by their racket,
 * at about hit.y) going down or at the top of its bounce. Returns the shot and where it will be at that moment.
 */
export function aimToReach(
  from: THREE.Vector3,
  hit: THREE.Vector3,
  speed: number,
  top: number,
  region: (p: THREE.Vector3) => THREE.Vector3,
  minClear = 0.4,
): { shot: Shot; at: THREE.Vector3 } {
  const dir = new THREE.Vector3(hit.x - from.x, 0, hit.z - from.z).normalize();
  let after = 4; // meters from the bounce to the hitting point
  let shot!: Shot;
  const B = new THREE.Vector3();
  const at = hit.clone();
  for (let it = 0; it < 4; it++) {
    B.copy(hit).addScaledVector(dir, -after).setY(0);
    region(B);
    shot = solveShot(from, B, speed, top, minClear);
    // follow it past the bounce to where it is at the hitting height (on its way down, or its top if lower)
    const b = newBall();
    b.p.copy(from);
    b.v.copy(shot.v);
    b.w.copy(shot.w);
    let bounced = false;
    let best: THREE.Vector3 | null = null;
    let apex = new THREE.Vector3();
    for (let t = 0; t < 4; t += 1 / 120) {
      const vy0 = b.v.y;
      stepBall(b, 1 / 120, (e) => {
        if (e.type === "bounce") bounced = true;
      }, false);
      if (!bounced) continue;
      if (vy0 > 0 && b.v.y <= 0) apex = b.p.clone();
      if (b.v.y < 0 && b.p.y <= hit.y) {
        best = apex.y > 0 && apex.y < hit.y + 0.12 ? apex : b.p.clone();
        break;
      }
      if (b.rolling) break;
    }
    if (!best) break;
    at.copy(best);
    const d = (best.x - B.x) * dir.x + (best.z - B.z) * dir.z;
    if (Math.abs(d - after) < 0.05) break;
    after = THREE.MathUtils.clamp(d, 0.5, 14);
  }
  return { shot, at };
}

/** For checks: where a ball now in flight first lands (no net), with its full physics. */
export function landingOf(b: Ball): THREE.Vector3 {
  const land = new THREE.Vector3();
  fly(b.p, b.v, b.w, land);
  return land;
}

export { UP };
