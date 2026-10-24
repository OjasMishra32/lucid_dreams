import * as THREE from "three";
import { C } from "./court";
import { BALL_R, type Shot, solveLob, solveShot, spinFor, stepBall, newBall } from "./physics";

// What a racket does to the ball, and the help your shots get. The strings throw the ball back off their face with
// an apparent restitution (a real racket's recoil folded in), grip it across the face so a brushing swing spins it
// (up: topspin, down: slice), and then aim assist leans the shot toward a spot in the opponent's court near where you
// were aiming, more for a slow or off-centre hit, so a natural swing lands in and a wild one can still miss.

const _vbn = new THREE.Vector3();
const _vrt = new THREE.Vector3();
const _u = new THREE.Vector3();

/**
 * The ball off the strings. n: the face normal on the side the ball is thrown to (unit). vRacket: the strings' velocity
 * at the contact point. Null when the ball isn't meeting the face (it's moving away from it faster than the racket).
 */
export function racketResponse(vBall: THREE.Vector3, vRacket: THREE.Vector3, n: THREE.Vector3, wIn: THREE.Vector3, offCentre: number): { v: THREE.Vector3; w: THREE.Vector3 } | null {
  const vbn = vBall.dot(n);
  const vrn = vRacket.dot(n);
  const rel = vbn - vrn; // < 0: closing
  if (rel > 0.3) return null;
  const e = 0.44 * (1 - 0.4 * THREE.MathUtils.clamp(offCentre - 0.55, 0, 1)); // near the frame the strings are dead
  const outN = vrn - e * rel;
  // across the face: the ball grips the strings and leaves rolling (a hollow ball keeps 3/5 of its slide)
  _vbn.copy(vBall).addScaledVector(n, -vbn);
  _vrt.copy(vRacket).addScaledVector(n, -vrn);
  _u.subVectors(_vbn, _vrt);
  const v = _vrt.clone().addScaledVector(_u, 0.6).addScaledVector(n, outN);
  const w = new THREE.Vector3().crossVectors(n, _u).multiplyScalar((3 / (5 * BALL_R)) * 1.35).addScaledVector(wIn, 0.25);
  if (w.length() > 420) w.setLength(420);
  return { v, w };
}

/** Clamp a landing spot into a rectangle (court space). */
export function boxRegion(x0: number, x1: number, z0: number, z1: number) {
  return (p: THREE.Vector3) => p.set(THREE.MathUtils.clamp(p.x, Math.min(x0, x1), Math.max(x0, x1)), 0, THREE.MathUtils.clamp(p.z, Math.min(z0, z1), Math.max(z0, z1)));
}

/** Where a rally ball may be steered to on one side (side: -1 the opponent's half, +1 yours), with a margin. */
export function rallyRegion(side: 1 | -1, margin = 0.45) {
  return boxRegion(-(C.halfS - margin), C.halfS - margin, side * 2.6, side * (C.halfL - margin - 0.1));
}

/** The service box the receiver on `side` defends (deuce: their right half), with a margin. */
export function serveRegion(side: 1 | -1, deuce: boolean, margin = 0.3) {
  const sx = deuce ? side : -side; // the receiver's right is +x on your side, -x on theirs
  return boxRegion(sx * 0.22, sx * (C.halfS - margin), side * 1.6, side * (C.service - margin));
}

const _land = new THREE.Vector3();
function naturalLanding(p: THREE.Vector3, v: THREE.Vector3, w: THREE.Vector3): THREE.Vector3 {
  const b = newBall();
  b.p.copy(p);
  b.v.copy(v);
  b.w.copy(w);
  for (let t = 0; t < 4; t += 1 / 120) {
    stepBall(b, 1 / 120, undefined, false);
    if (b.p.y <= BALL_R + 1e-4 && b.v.y >= 0) break;
  }
  return _land.copy(b.p).setY(0);
}

export type ShotKind = "drive" | "slice" | "lob" | "drop" | "smash" | "volley" | "serve";

export interface AssistInfo {
  natural: THREE.Vector3;
  target: THREE.Vector3;
  assist: number;
  kind: ShotKind;
}

/**
 * Your shot, helped. contact: where the ball met the strings; vNat / wNat: what the strings alone did; quality 0..1
 * (centred and brisk is 1); racketSpeed: how fast the strings were moving. side: the half you're hitting into (-1:
 * theirs). serve: the box it must land in (deuce or ad), else a rally ball. volley: you took it out of the air.
 * What kind of shot it is comes from the swing itself: a soft touch that would land short is a drop shot, a ball sent
 * up steeply is a lob, a high ball hit down is a smash, a brushing swing is topspin or slice.
 */
export function assistShot(
  contact: THREE.Vector3,
  vNatIn: THREE.Vector3,
  wNat: THREE.Vector3,
  quality: number,
  racketSpeed: number,
  side: 1 | -1,
  serve: { deuce: boolean } | null,
  volley: boolean,
  info?: AssistInfo,
): Shot {
  const vNat = quality < 0.2 ? vNatIn.clone().multiplyScalar(0.65) : vNatIn; // a frame shot loses its pace
  let L: THREE.Vector3;
  const flat = Math.hypot(vNat.x, vNat.z);
  const forward = vNat.z * side > 0.5;
  if (forward) L = naturalLanding(contact, vNat, wNat).clone();
  else L = new THREE.Vector3(contact.x + vNat.x * 0.4, 0, side * (C.halfL - 2)); // back at yourself or straight up: a soft ball deep
  const elev = Math.atan2(vNat.y, Math.max(flat, 1e-3));
  const speed0 = vNat.length();
  const soft = racketSpeed < 3.2 && speed0 < 12;
  if (forward && !serve) {
    // a swing that would dump the ball into the net (or just over it) still has its line and its pace: it goes where
    // the swing points, as deep as its pace carries it; a soft touch goes just over
    const over = L.z * side;
    if (over < 0.4 || (!soft && over < 5)) {
      const depth = side * (soft ? 1.6 : THREE.MathUtils.clamp(3 + speed0 * 0.36, 6, C.halfL - 0.9));
      const k = (depth - contact.z) / vNat.z;
      L.set(contact.x + vNat.x * k, 0, depth);
    }
  }
  let kind: ShotKind;
  let region: (p: THREE.Vector3) => THREE.Vector3;
  if (serve) {
    kind = "serve";
    region = serveRegion(side, serve.deuce);
  } else if (contact.y > 1.75 && vNat.y < 1 && racketSpeed > 4.5) {
    kind = "smash";
    region = boxRegion(-(C.halfS - 0.5), C.halfS - 0.5, side * 2.5, side * (C.halfL - 0.6));
  } else if (forward && elev > 0.42 && contact.y < 1.8) {
    kind = "lob";
    region = boxRegion(-(C.halfS - 0.7), C.halfS - 0.7, side * (C.halfL - 3.6), side * (C.halfL - 0.7));
  } else if (forward && soft && Math.abs(L.z) < 7.5) {
    kind = "drop";
    region = boxRegion(-(C.halfS - 0.5), C.halfS - 0.5, side * 1.1, side * 5.5);
  } else {
    kind = volley ? "volley" : wNat.dot(spinFor(new THREE.Vector3(L.x - contact.x, 0, L.z - contact.z).normalize(), 1)) < -40 ? "slice" : "drive";
    region = rallyRegion(side, 0.45);
  }
  const A = region(L.clone());
  // hand tracking makes the face's angle noisy: however wild the swing, its line is taken as at most a few meters
  // outside where it may land, then leaned in (more for a slow or off-centre hit); a near miss is pulled in whole
  // A ball met on the strings is leaned in (more the further off-centre: its quality is lower) and lands in; only a
  // frame shot (quality under 0.2: the ball caught outside the strings, in the generous zone's outer ring) is a mishit,
  // its line mostly its own and its pace gone, and that can be long, wide or into the net.
  const mishit = quality < 0.2;
  const reach = serve ? 2.5 : 3;
  const off = L.clone().sub(A);
  if (off.length() > reach) L.copy(A).addScaledVector(off.normalize(), reach);
  let a = mishit ? 0.5 : THREE.MathUtils.clamp(0.9 + 0.1 * (1 - quality), serve ? 0.94 : 0.9, 1);
  if (!mishit && L.distanceTo(A) < (serve ? 1.5 : 1.2)) a = 1;
  const T = L.clone().lerp(A, a);
  const dir = new THREE.Vector3(T.x - contact.x, 0, T.z - contact.z).normalize();
  const topAxis = spinFor(dir, 1);
  const top0 = wNat.dot(topAxis);
  const sideSpin = THREE.MathUtils.clamp(wNat.y, -200, 200);
  if (info) {
    info.natural = L;
    info.target = T;
    info.assist = a;
    info.kind = kind;
  }
  switch (kind) {
    case "serve":
      // the swing's pace, its brush: flat, slice (sidespin) or kick (heavy topspin, a higher arc)
      return solveShot(contact, T, THREE.MathUtils.clamp(speed0, 15, 52), THREE.MathUtils.clamp(top0, -80, 380), top0 > 200 ? 0.55 : 0.08, sideSpin);
    case "smash":
      return solveShot(contact, T, THREE.MathUtils.clamp(speed0, 18, 42), THREE.MathUtils.clamp(top0, -60, 120), 0.12);
    case "lob":
      return solveLob(contact, T, THREE.MathUtils.clamp(elev, 0.55, 0.95), THREE.MathUtils.clamp(top0, -150, 300));
    case "drop":
      return solveShot(contact, T, THREE.MathUtils.clamp(speed0, 5, 11), THREE.MathUtils.clamp(top0, -300, 0), 0.12);
    default: {
      const speed = THREE.MathUtils.clamp(Math.max(speed0, flat * 1.05), volley ? 9 : 10, 38);
      return solveShot(contact, T, speed, THREE.MathUtils.clamp(top0, -260, 380), volley ? 0.15 : 0.3, sideSpin * 0.5);
    }
  }
}
