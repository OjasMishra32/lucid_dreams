// The stand-in court bundle: a synthetic play shaped like the real one, so every stream builds and tests against a
// valid bundle before the real footage lands. Nothing in it comes from, or is measured from, broadcast footage: the
// camera, rates, speeds and frame numbers are made up.
//   node apps/webxr/scripts/court/standin.mjs [--out <dir>] [--render 768x432] [--workers N]
//   node apps/webxr/scripts/court/standin.mjs --fixture   (rewrites scripts/court/fixtures/court.json only)
// Writes (default) apps/webxr/scripts/court/out/standin/ (git-ignored by scripts/court/.gitignore):
//   court.json, video/frames.json, video/cards.json   valid per src/court/format.ts (checked before it exits)
//   video/show.h264 (+ show-small.h264)  the whole show at 72 Hz display times, each frame stacked 1536x2160: the live
//                                       frame (1536x864), its background plate (the same frame with nobody in it and
//                                       the rim painted out) and the matte atlas (1536x432, one tile per card);
//                                       avc1.640033 (High 5.1), -bf 0, an IDR at every segment start, AUD per frame;
//                                       pass 1 (1x), pass 2 (pass2Speed), three eases (1.2/1.0/0.8 s) ending on F, the
//                                       resume through the make
//   video/freeze.png, freeze-clean.png, stands-mask.png   frame F and its plate (1920x1080)
//   players/<id>/freeze.ply, reality.ply, proxy.glb, shadow.png, reflection.png   two frozen players (3DGS PLY, SH1)
//   others/trailer/...                 a third person in the lit region, built like the pair
//   stands/front-row.png, court/floor.jpg, court/floor-seen.png, audio/bed.m4a, audio/swell.m4a
// The scene: a fixed long-lens camera ~23 m from the pair that pans and zooms with the play; the pair stand with a
// clear gap between their bodies (the layered watch must show nobody twice through it, P43) and a third person
// trails them; each show frame is rendered from exactly the camera frames.json lists for it. The made-up source is a
// 180 fps real-time capture played at pass2Speed 0.4 in pass 2, so every pass-2 display frame is a real frame and at
// 1x one in two is (the rest are in-betweens, flagged interp).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { BALL_CARD, LABEL, validateCards, validateCourt, validateFrames } from "../../src/court/format.ts";
import { angleDeg, lookRotation, project, rotate, scaled } from "../../src/court/camera.ts";
import { EASE_SECONDS, RESUME_RAMP_S, easeFrameCount, easeTau, resumeTau } from "../../src/court/clock.ts";
import { splitAnnexB, spsCodec } from "../../src/court/annexb.ts";
import { writePng } from "./png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(HERE, "out", "standin");
export const FIXTURE = join(HERE, "fixtures", "court.json");

// ---------------- the show's timing (made up) ----------------
const HZ = 72;
const CAPTURE = 180; // source frames per second of real time (sourceFps 180 x slow 1)
const PASS2_SPEED = 0.4; // 180 x 0.4 = 72: every pass-2 display frame is a real frame
const F_SRC = 600; // F's source frame
const PASS1 = { start: -2.4, frames: 195 }; // real time relative to F, seconds; 1x
const PASS2 = { start: -1.2, end: 1.3 };
const RELEASE_TAU = 0.35; // the ball leaves the hands
const MAKE_TAU = 1.0; // the ball drops through the net
const SRC = { width: 3840, height: 2160, cx: 1919.5, cy: 1079.5 };
/** The stacked stream: live, plate and mattes regions, stream pixels [x, y, w, h]. */
export const STREAM = { width: 1536, height: 2160, live: [0, 0, 1536, 864], plate: [0, 864, 1536, 864], mattes: [0, 1728, 1536, 432] };
const SMALL = { width: 1280, height: 1800 };
/** The matte atlas: one 384 x 432 slot per card id (the ball's only from the release to the make). */
const SLOTS = { shooter: 0, defender: 1, trailer: 2, [BALL_CARD]: 3 };
const SLOT_W = 384;
const TILE_INSET = 2; // px between a tile and its slot's edge: >= 4 px between tiles

// ---------------- the scene (court space, made up) ----------------
const PC = [6.0, 0, 1.0]; // the pair's centre on the floor
const CAM_C = [-14.0, 1.35, -10.5]; // the camera's fixed centre (~23 m from the pair)
const F0 = 20000; // focal at F, source pixels (an 11 x 6 deg window: the pair head to toe with the raised hand)
const RIM = [12.73, 3.05, 0];
const BALL_R = 0.1195;
const STANDS_X = 16.0;
const CARD = { x: 15.2, z0: -4, z1: 10, y1: 1.35 };
const BOARD = { x: 13.105, y0: 2.9, y1: 3.97, z: 0.915 }; // the rulebook board: face 1.22 m in from the baseline
const LIGHT = norm([-0.35, 1, 0.3]);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
function norm(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}
const round = (v, d = 6) => Number(v.toFixed(d));

// the camera's horizontal frame toward the pair: people are placed along it and across it
const FWD = norm([PC[0] - CAM_C[0], 0, PC[2] - CAM_C[2]]);
const RIGHT = [-FWD[2], 0, FWD[0]];
const place = (along, across) => [PC[0] + FWD[0] * along + RIGHT[0] * across, 0, PC[2] + FWD[2] * along + RIGHT[2] * across];
const S_F = place(-0.25, -0.42); // the shooter, nearer the camera, his back to it
const D_F = place(0.25, 0.42); // the defender, facing the camera: ~0.5 m of clear floor between their bodies
const T_F = place(2.0, -1.45); // the third person, trailing behind and to the left
const V_S = add(mul(RIGHT, 0.9), mul(FWD, -0.15)); // m/s before F
const V_D = mul(V_S, 0.85);
const V_T = mul(V_S, 0.7);

const PALETTE = {
  shooter: { skin: [0.8, 0.62, 0.5], jersey: [0.16, 0.33, 0.74], shorts: [0.14, 0.29, 0.66], shoes: [0.95, 0.95, 0.95], hair: [0.22, 0.15, 0.1], height: 1.98 },
  defender: { skin: [0.45, 0.3, 0.22], jersey: [0.08, 0.3, 0.22], shorts: [0.07, 0.26, 0.19], shoes: [0.12, 0.12, 0.12], hair: [0.06, 0.05, 0.05], height: 2.16 },
  trailer: { skin: [0.62, 0.45, 0.35], jersey: [0.08, 0.3, 0.22], shorts: [0.07, 0.26, 0.19], shoes: [0.9, 0.9, 0.9], hair: [0.12, 0.08, 0.06], height: 2.05 },
};

/** A standing body as capsules: { a, b, r, part } in court space. */
function body(foot, facing, k, hands) {
  const f = norm([facing[0], 0, facing[2]]);
  const r = [-f[2], 0, f[0]];
  const p = (fw, side, up) => [foot[0] + f[0] * fw * k + r[0] * side * k, up * k, foot[2] + f[2] * fw * k + r[2] * side * k];
  const caps = [];
  for (const side of [-1, 1]) {
    const stance = side * 0.09;
    const hip = p(0, side * 0.1, 0.93);
    const ankle = p(stance, side * 0.12, 0.09);
    caps.push({ a: hip, b: ankle, r: 0.075 * k, part: "leg" });
    caps.push({ a: [ankle[0], 0.05 * k, ankle[2]], b: add([ankle[0], 0.05 * k, ankle[2]], mul(f, 0.17 * k)), r: 0.05 * k, part: "foot" });
  }
  caps.push({ a: p(0, 0, 0.98), b: p(0, 0, 1.42), r: 0.155 * k, part: "torso" });
  const head = p(0.02, 0, 1.66);
  caps.push({ a: head, b: head, r: 0.112 * k, part: "head" });
  const reach = 0.72 * k;
  for (const [side, target] of [[-1, hands.left], [1, hands.right]]) {
    const shoulder = p(0, side * 0.21, 1.43);
    const want = target ?? p(0.05, side * 0.28, 0.82);
    const d = sub(want, shoulder);
    const len = Math.hypot(...d);
    caps.push({ a: shoulder, b: add(shoulder, mul(d, Math.min(1, reach / len))), r: 0.048 * k, part: "arm" });
  }
  return { caps, head, foot, feet: caps.filter((c) => c.part === "foot").map((c) => c.a) };
}

/** Everything that moves, at real time tau (seconds relative to F). */
export function sceneAt(tau) {
  const t = Math.min(tau, 0);
  const S = add(S_F, mul(V_S, t));
  const D = add(D_F, mul(V_D, t));
  const T = add(T_F, mul(V_T, t));
  const toD = norm(sub(D, S));
  const toS = mul(toD, -1);
  const ks = PALETTE.shooter.height / 1.95;
  const kd = PALETTE.defender.height / 1.95;
  const sRight = [-toD[2], 0, toD[0]];
  // the ball: dribbled in the right hand, gathered at the hip by F, lifted, shot, through the net at MAKE_TAU
  const dribble = (x) => add(add(add(S, mul(sRight, 0.3 * ks)), mul(toD, 0.18 * ks)), [0, 0.12 + 0.78 * Math.abs(Math.sin((Math.PI * (x + 0.5)) / 0.5)), 0]);
  const hip = add(add(add(S, mul(toD, 0.24 * ks)), mul(sRight, 0.14 * ks)), [0, 0.98 * ks, 0]);
  const over = add(add(S, mul(toD, 0.15 * ks)), [0, 2.35 * ks, 0]);
  let ball;
  if (tau <= -0.5) ball = dribble(tau);
  else if (tau <= 0) ball = lerp3(dribble(-0.5), hip, smooth((tau + 0.5) / 0.5));
  else if (tau <= RELEASE_TAU) ball = lerp3(hip, over, smooth(tau / RELEASE_TAU));
  else if (tau <= MAKE_TAU) {
    const s = (tau - RELEASE_TAU) / (MAKE_TAU - RELEASE_TAU);
    ball = add(lerp3(over, RIM, s), [0, 4 * 1.3 * s * (1 - s), 0]);
  } else ball = add(RIM, [0, -2.5 * (tau - MAKE_TAU), 0]);
  const sShoulder = (side) => add(add(S, mul(sRight, side * 0.21 * ks)), [0, 1.43 * ks, 0]);
  const onBall = (side) => add(ball, mul(norm(sub(sShoulder(side), ball)), BALL_R + 0.05));
  const hands =
    tau > RELEASE_TAU
      ? { left: add(sShoulder(-1), [toD[0] * 0.15, 0.5 * ks, toD[2] * 0.15]), right: add(sShoulder(1), [toD[0] * 0.25, 0.55 * ks, toD[2] * 0.25]) }
      : { left: tau > -0.5 ? onBall(-1) : null, right: onBall(1) };
  const shooter = body(S, toD, ks, hands);
  // the defender's right arm rises toward the shooter's head from tau = -1 to F, across the gap
  const dRight = [-toS[2], 0, toS[0]];
  const hang = add(add(D, mul(dRight, 0.28 * kd)), [0, 0.82 * kd, 0]);
  const reachUp = add(add(shooter.head, [0, 0.3, 0]), mul(toS, -0.12));
  const defender = body(D, toS, kd, { left: null, right: lerp3(hang, reachUp, smooth((tau + 1) / 1)) });
  const kt = PALETTE.trailer.height / 1.95;
  const trailer = body(T, norm(sub(PC, T)), kt, { left: null, right: null });
  return {
    people: [
      { id: "shooter", ...shooter, palette: PALETTE.shooter, k: ks },
      { id: "defender", ...defender, palette: PALETTE.defender, k: kd },
      { id: "trailer", ...trailer, palette: PALETTE.trailer, k: kt },
    ],
    ball,
  };
}

/** The camera at real time tau: where it looks, its focal (source px), and its rotation. */
export function cameraAt(tau) {
  const sc = sceneAt(tau);
  const S = sc.people[0].foot;
  const D = sc.people[1].foot;
  let target = add(mul(add(S, D), 0.5), [0, 1.12, 0]);
  target = add(target, add(mul(RIGHT, 0.18 * Math.sin(2.3 * tau)), [0, 0.05 * Math.sin(1.7 * tau), 0]));
  const follow = smooth((tau - 0.3) / 0.45);
  const look = tau > MAKE_TAU ? RIM : sc.ball;
  target = lerp3(target, look, follow);
  const f = F0 * (1 + 0.04 * Math.sin(1.9 * tau)) * lerp(1, 0.55, follow);
  return { q: lookRotation(sub(target, CAM_C)), f };
}

function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((x) => -x) : b;
  d = Math.abs(d);
  if (d > 0.99995) return norm4(a.map((x, i) => lerp(x, bb[i], t)));
  const th = Math.acos(d);
  const s = Math.sin(th);
  return norm4(a.map((x, i) => (x * Math.sin((1 - t) * th) + bb[i] * Math.sin(t * th)) / s));
}
function norm4(q) {
  const n = Math.hypot(...q);
  return q.map((x) => x / n);
}

/** The show: per show frame its real time, source frame, interp flag and camera; plus the segments. */
export function timeline() {
  const taus = [];
  const range = (fill) => {
    const first = taus.length;
    fill();
    return [first, taus.length - 1];
  };
  const pass1 = range(() => {
    for (let n = 0; n < PASS1.frames; n++) taus.push(PASS1.start + n / HZ);
  });
  const step2 = PASS2_SPEED / HZ;
  const pass2 = range(() => {
    for (let j = 0; PASS2.start + j * step2 <= PASS2.end + 1e-9; j++) taus.push(PASS2.start + j * step2);
  });
  const eases = EASE_SECONDS.map((seconds) => {
    const n = easeFrameCount(seconds, HZ);
    const j = Math.round((easeTau(0, n, HZ, PASS2_SPEED) - PASS2.start) / step2);
    if (Math.abs(PASS2.start + j * step2 - easeTau(0, n, HZ, PASS2_SPEED)) > 1e-9) throw new Error(`ease of ${n} frames doesn't start on pass 2's grid`);
    const frames = range(() => {
      for (let k = 1; k <= n; k++) taus.push(easeTau(k, n, HZ, PASS2_SPEED));
    });
    return { start: pass2[0] + j, frames, seconds: round(n / HZ, 4) };
  });
  const ramp = easeFrameCount(RESUME_RAMP_S, HZ);
  const resume = range(() => {
    for (let k = 1; resumeTau(k, ramp, HZ, PASS2_SPEED) <= PASS2.end + 1e-9; k++) taus.push(resumeTau(k, ramp, HZ, PASS2_SPEED));
  });
  // a display frame shows the real frame when one lies within 0.1 frame of its time, else an in-between whose camera
  // is the slerp of its two real neighbours' (as the bake does)
  const shows = taus.map((tau) => {
    const exact = F_SRC + tau * CAPTURE;
    const near = Math.round(exact);
    if (Math.abs(exact - near) <= 0.1) {
      const t = (near - F_SRC) / CAPTURE;
      const cam = cameraAt(t);
      return { tau: t, src: near, interp: false, q: cam.q, f: cam.f };
    }
    const lo = Math.floor(exact);
    const w = exact - lo;
    const a = cameraAt((lo - F_SRC) / CAPTURE);
    const b = cameraAt((lo + 1 - F_SRC) / CAPTURE);
    return { tau, src: round(exact, 4), interp: true, q: slerp(a.q, b.q, w), f: lerp(a.f, b.f, w) };
  });
  return { shows, segments: { pass1, pass2, resume, eases }, cutoff: eases[eases.length - 1].start };
}

const srcCam = (s) => ({ centre: CAM_C, q: s.q, f: s.f, cx: SRC.cx, cy: SRC.cy, width: SRC.width, height: SRC.height });

/** A capsule body's (or the ball's) box in an image: [x0, y0, x1, y1], clipped to it; null when it is off the image. */
function boxOf(cam, caps) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of caps)
    for (const p of [c.a, c.b]) {
      const uv = project(cam, p);
      const z = dot(sub(p, cam.centre), rotate(cam.q, [0, 0, 1]));
      if (!uv || z <= 0) return null;
      const m = (cam.f * c.r) / z + 1;
      box[0] = Math.min(box[0], uv[0] - m);
      box[1] = Math.min(box[1], uv[1] - m);
      box[2] = Math.max(box[2], uv[0] + m);
      box[3] = Math.max(box[3], uv[1] + m);
    }
  const clip = [Math.max(0, Math.floor(box[0])), Math.max(0, Math.floor(box[1])), Math.min(cam.width, Math.ceil(box[2])), Math.min(cam.height, Math.ceil(box[3]))];
  return clip[0] < clip[2] && clip[1] < clip[3] ? clip : null;
}

/**
 * The cards of one show frame (format.ts ShowCard): every person whose box is in the frame, and the ball from the
 * release to the make. Boxes in source pixel edges; each matte's tile (0-1 in the atlas) in its own slot, 2 px inside
 * it, so tiles keep >= 4 px apart and mip sampling never bleeds one matte into the next.
 */
export function cardsAt(show) {
  const cam = srcCam(show);
  const sc = sceneAt(show.tau);
  const list = [];
  for (const person of sc.people) {
    const box = boxOf(cam, person.caps);
    if (box) list.push({ id: person.id, kind: "person", at: [round(person.foot[0], 4), 0, round(person.foot[2], 4)], box, depth: dot(sub(person.foot, CAM_C), FWD) });
  }
  if (show.tau >= RELEASE_TAU && show.tau <= MAKE_TAU) {
    const box = boxOf(cam, [{ a: sc.ball, b: sc.ball, r: BALL_R }]);
    if (box) list.push({ id: BALL_CARD, kind: "ball", at: sc.ball.map((x) => round(x, 4)), box, depth: dot(sub(sc.ball, CAM_C), FWD) });
  }
  list.sort((a, b) => a.depth - b.depth);
  const [, , mw, mh] = STREAM.mattes;
  const [iw, ih] = [SLOT_W - 2 * TILE_INSET, mh - 2 * TILE_INSET];
  return list.map(({ id, kind, at, box }, order) => {
    // the box scaled into its slot, aspect kept
    const s = Math.min(iw / (box[2] - box[0]), ih / (box[3] - box[1]));
    const x0 = SLOTS[id] * SLOT_W + TILE_INSET;
    const px = [x0, TILE_INSET, x0 + Math.max(1, Math.round((box[2] - box[0]) * s)), TILE_INSET + Math.max(1, Math.round((box[3] - box[1]) * s))];
    return { id, kind, at, box, tile: [px[0] / mw, px[1] / mh, px[2] / mw, px[3] / mh].map((u) => round(u, 7)), order };
  });
}

const capsuleBounds = (caps) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const c of caps)
    for (const p of [c.a, c.b])
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], p[i] - c.r);
        max[i] = Math.max(max[i], p[i] + c.r);
      }
  min[1] = Math.max(0, min[1]);
  return { min: min.map((x) => round(x, 4)), max: max.map((x) => round(x, 4)) };
};
const boxDistance = (p, b) => Math.hypot(Math.max(b.min[0] - p[0], 0, p[0] - b.max[0]), Math.max(b.min[2] - p[2], 0, p[2] - b.max[2]));
const floorRect = (c, half) => [round(c[0] - half, 3), round(c[2] - half, 3), round(c[0] + half, 3), round(c[2] + half, 3)];

/** court.json, frames.json and cards.json for the stand-in (pure: no files). */
export function standinBundle() {
  const tl = timeline();
  const atF = sceneAt(0);
  const [shooter, defender, trailer] = atF.people;
  const bounds = { shooter: capsuleBounds(shooter.caps), defender: capsuleBounds(defender.caps) };
  // walk spots around the pair (front, toward the camera, and 60 deg to either side, as close as 1.5 m and always
  // `clear` m from both bodies, P29), only to bound the trailer's maxRayAngle; the bundle stores no spots (3.4)
  const toCam = norm([CAM_C[0] - PC[0], 0, CAM_C[2] - PC[2]]);
  const spotAt = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    const d = [toCam[0] * Math.cos(a) - toCam[2] * Math.sin(a), 0, toCam[0] * Math.sin(a) + toCam[2] * Math.cos(a)];
    return [round(PC[0] + d[0] * r, 3), 0, round(PC[2] + d[2] * r, 3)];
  };
  let radius = 1.5;
  while ([-60, 0, 60].some((deg) => Object.values(bounds).some((b) => boxDistance(spotAt(deg, radius), b) < 1.05))) radius += 0.05;
  const spots = [0, -60, 60].map((deg) => spotAt(deg, radius));
  const eye = (p) => [p[0], 1.6, p[2]];
  const chest = [trailer.foot[0], 1.2, trailer.foot[2]];
  const maxRayAngle = Math.max(...spots.map((s) => angleDeg(sub(chest, CAM_C), sub(chest, eye(s)))));
  const interpShare = tl.shows.filter((s) => s.interp).length / tl.shows.length;
  const player = (p, name, seen) => ({
    id: p.id,
    name,
    splats: `players/${p.id}/freeze.ply`,
    reality: `players/${p.id}/reality.ply`,
    proxy: `players/${p.id}/proxy.glb`,
    bounds: bounds[p.id],
    seenFraction: seen,
    capsules: p.caps.filter((c) => c.part === "torso" || c.part === "head").map((c) => ({ a: c.a.map((x) => round(x, 4)), b: c.b.map((x) => round(x, 4)), r: round(c.r, 4) })),
    shadow: { image: `players/${p.id}/shadow.png`, rect: floorRect(p.foot, 0.8) },
    reflection: { image: `players/${p.id}/reflection.png`, rect: floorRect(p.foot, 0.8) },
  });
  const court = {
    version: 1,
    title: "Court Side stand-in",
    caption: "Stand-in · the defender closes out as the shooter gathers",
    label: LABEL,
    credit: "Synthetic stand-in bundle: no broadcast footage.",
    court: {
      length: 28.65, width: 15.24, rim: RIM,
      backboard: [[BOARD.x, BOARD.y0, -BOARD.z], [BOARD.x, BOARD.y0, BOARD.z], [BOARD.x, BOARD.y1, BOARD.z], [BOARD.x, BOARD.y1, -BOARD.z]],
      floor: "court/floor.jpg", floorSeen: "court/floor-seen.png", hardwood: [0.71, 0.52, 0.33],
    },
    camera: { centre: CAM_C, width: SRC.width, height: SRC.height, cx: SRC.cx, cy: SRC.cy, k1: 0, sourceFps: CAPTURE, captureFps: CAPTURE, slow: 1 },
    video: {
      file: "video/show.h264",
      codec: "avc1.640033",
      width: STREAM.width,
      height: STREAM.height,
      regions: { live: STREAM.live, plate: STREAM.plate, mattes: STREAM.mattes },
      displayHz: HZ,
      pass2Speed: PASS2_SPEED,
      fallbacks: { small: { file: "video/show-small.h264", codec: "avc1.640033", width: SMALL.width, height: SMALL.height } },
      frames: "video/frames.json",
      cards: "video/cards.json",
      segments: tl.segments,
      cutoff: tl.cutoff,
      freezeSource: F_SRC,
      makeSource: F_SRC + MAKE_TAU * CAPTURE,
      freeze: "video/freeze.png",
      freezeClean: "video/freeze-clean.png",
      standsMask: "video/stands-mask.png",
    },
    light: { crowd: 0.45, floor: 0.3, pair: 1.0, stands: 0.6, penumbra: 1.5, alternative: { crowd: 0.16, floor: 0.14 } },
    seat: { ray: "freeze", distance: 5.0, distanceRange: [4, 7], pairCentre: PC, clear: 1.0 },
    freeze: {
      players: [player(shooter, "Shooter (stand-in)", seenShare(shooter)), player(defender, "Defender (stand-in)", seenShare(defender))],
      ball: { centre: atF.ball.map((x) => round(x, 4)), radius: BALL_R, erase: [{ player: "shooter", radius: 0.15 }] },
      others: [
        {
          id: "trailer",
          name: "Trailer (stand-in)",
          kind: "splats",
          file: "others/trailer/freeze.ply",
          reality: "others/trailer/reality.ply",
          pose: "A",
          foot: [round(trailer.foot[0], 4), 0, round(trailer.foot[2], 4)],
          height: PALETTE.trailer.height,
          maxRayAngle: round(maxRayAngle, 2),
          shadow: { image: "others/trailer/shadow.png", rect: floorRect(trailer.foot, 0.8) },
          reflection: { image: "others/trailer/reflection.png", rect: floorRect(trailer.foot, 0.8) },
        },
      ],
      stands: {
        proxy: [{ kind: "plane", points: [[STANDS_X, 0, -16], [STANDS_X, 0, 16], [STANDS_X, 9, 16], [STANDS_X, 9, -16]] }],
        cards: [{ id: "front-row", image: "stands/front-row.png", quad: [[CARD.x, 0, CARD.z0], [CARD.x, 0, CARD.z1], [CARD.x, CARD.y1, CARD.z1], [CARD.x, CARD.y1, CARD.z0]] }],
      },
    },
    audio: {
      bed: "audio/bed.m4a",
      lufs: -23,
      sources: [[STANDS_X, 3, -8], [STANDS_X, 4, -2], [STANDS_X, 3, 4], [STANDS_X, 4, 10], [0, 4, 9.5]].map((at, i) => ({ at, offsetS: round(i * 3.8, 2) })),
      oneShots: [
        { file: "audio/swell.m4a", at: "make", gainDb: 0 },
        { file: "audio/swell.m4a", at: "stepIn", gainDb: -12 },
      ],
      events: [],
    },
    metrics: { reprojDeg: { median: null, p95: null }, heldOutPsnrVsGenerated: {}, seatPsnr: {}, interpShare: round(interpShare, 4) },
  };
  const frames = tl.shows.map((s) => ({ src: s.src, interp: s.interp, q: s.q.map((x) => round(x, 9)), f: round(s.f, 4) }));
  const cards = tl.shows.map((s) => ({ cards: cardsAt(s) }));
  return { court, frames, cards };
}

// ---------------- splats (deterministic) ----------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The albedo of a body part at height y (shorts, jersey, shoes, hair). */
function albedo(part, y, pal, k) {
  if (part === "foot") return pal.shoes;
  if (part === "leg") return y > 0.62 * k ? pal.shorts : y < 0.14 * k ? pal.shoes : pal.skin;
  if (part === "torso") return y < 1.05 * k ? pal.shorts : pal.jersey;
  if (part === "head") return y > 1.71 * k ? pal.hair : pal.skin;
  return pal.skin;
}
const lambert = (rgb, n) => {
  const l = 0.38 + 0.75 * Math.max(0, dot(n, LIGHT));
  return [Math.min(1, rgb[0] * l), Math.min(1, rgb[1] * l), Math.min(1, rgb[2] * l)];
};

/** Points on a body's capsules, shaded as the footage shades them: { p, n, rgb }. */
function sampleBody(person, count, seed) {
  const r = rng(seed);
  const areas = person.caps.map((c) => 2 * Math.PI * c.r * Math.hypot(...sub(c.b, c.a)) + 4 * Math.PI * c.r * c.r);
  const total = areas.reduce((s, a) => s + a, 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    let pick = r() * total;
    let ci = 0;
    while (pick > areas[ci] && ci < areas.length - 1) pick -= areas[ci++];
    const c = person.caps[ci];
    const axis = sub(c.b, c.a);
    const len = Math.hypot(...axis);
    let p;
    let n;
    // uniform direction
    const z = 2 * r() - 1;
    const phi = 2 * Math.PI * r();
    const s = Math.sqrt(1 - z * z);
    const dir = [s * Math.cos(phi), z, s * Math.sin(phi)];
    if (len < 1e-6 || r() < (4 * c.r * c.r) / (4 * c.r * c.r + 2 * c.r * len)) {
      // a cap: the hemisphere the direction points into
      const end = len < 1e-6 || dot(dir, axis) < 0 ? c.a : c.b;
      n = dir;
      p = add(end, mul(dir, c.r));
    } else {
      const ax = norm(axis);
      const perp = norm(sub(dir, mul(ax, dot(dir, ax))));
      n = perp;
      p = add(add(c.a, mul(axis, r())), mul(perp, c.r));
    }
    // drop points buried inside another of this body's capsules
    const buried = person.caps.some((o, k) => k !== ci && pointCapsule(p, o) < o.r - 0.004);
    if (buried) {
      i--;
      continue;
    }
    out.push({ p, n, rgb: lambert(albedo(c.part, p[1], person.palette, person.k), n) });
  }
  return out;
}

function pointCapsule(p, c) {
  const ba = sub(c.b, c.a);
  const pa = sub(p, c.a);
  const bb = dot(ba, ba);
  const h = bb > 0 ? Math.min(1, Math.max(0, dot(pa, ba) / bb)) : 0;
  return Math.hypot(...sub(pa, mul(ba, h)));
}

/** Share of a body's surface camera F sees (facing it), from a fixed sample. */
function seenShare(person) {
  const pts = sampleBody(person, 3000, 99);
  return round(pts.filter((s) => dot(s.n, sub(CAM_C, s.p)) > 0).length / pts.length, 3);
}

const C0 = 0.28209479177387814;
/** 3DGS PLY, SH degree 1 (rest bands zero), binary little endian. `tint` recolours the points the camera never saw. */
function ply(points, tint) {
  const props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", ...Array.from({ length: 9 }, (_, i) => `f_rest_${i}`), "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`;
  const body = Buffer.alloc(points.length * props.length * 4);
  const spacing = 0.011;
  let o = 0;
  const put = (v) => {
    body.writeFloatLE(v, o);
    o += 4;
  };
  for (const s of points) {
    const seen = dot(s.n, sub(CAM_C, s.p)) > 0;
    const rgb = tint && !seen ? lerp3(s.rgb, [0.15, 0.35, 1.0], 0.65) : s.rgb;
    put(s.p[0]);
    put(s.p[1]);
    put(s.p[2]);
    put(s.n[0]);
    put(s.n[1]);
    put(s.n[2]);
    for (const c of rgb) put((c - 0.5) / C0);
    for (let i = 0; i < 9; i++) put(0);
    put(Math.log(0.97 / 0.03));
    put(Math.log(spacing * 0.75));
    put(Math.log(spacing * 0.75));
    put(Math.log(spacing * 0.18));
    // rotation taking local +z onto the normal (w, x, y, z)
    const zx = [0, 0, 1];
    const c = dot(zx, s.n);
    const axis = [zx[1] * s.n[2] - zx[2] * s.n[1], zx[2] * s.n[0] - zx[0] * s.n[2], zx[0] * s.n[1] - zx[1] * s.n[0]];
    const q = c < -0.9999 ? [0, 1, 0, 0] : norm4([1 + c, axis[0], axis[1], axis[2]]);
    for (const x of q) put(x);
  }
  return Buffer.concat([Buffer.from(header, "ascii"), body]);
}

// ---------------- the renderer (footage frames, plates, masks) ----------------

const KIND = { dark: 0, floor: 1, stands: 2, card: 3, board: 4, rim: 5, ball: 6, person: 10 };

function hash(a, b) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const PAINT = [0.18, 0.3, 0.52];
const APRON = [0.3, 0.22, 0.16];
const HARDWOOD = [0.71, 0.52, 0.33];
/** The floor's colour at court point (x, z), before shadows: hardwood planks, paint, lines, the apron. */
function floorAt(x, z) {
  const L = 28.65 / 2;
  const W = 15.24 / 2;
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const line = 0.05;
  const onLine = (d) => Math.abs(d) < line / 2;
  if (ax > L + line / 2 || az > W + line / 2) return APRON;
  // lines: boundary, half court, centre circle, both keys, free-throw circles, three-point lines
  const hoopX = 12.73 * Math.sign(x || 1);
  const dh = Math.hypot(x - hoopX, z);
  const keyX = L - 5.79;
  if (onLine(ax - L) || onLine(az - W) || onLine(x) || onLine(Math.hypot(x, z) - 1.83)) return [0.93, 0.93, 0.9];
  if (ax >= keyX - line / 2 && az <= 2.44 + line / 2 && (onLine(az - 2.44) || onLine(ax - keyX))) return [0.93, 0.93, 0.9];
  if (onLine(Math.hypot(ax - keyX, z) - 1.83) && ax <= keyX) return [0.93, 0.93, 0.9];
  if ((az <= 6.71 && onLine(dh - 7.24) && ax < 12.73 + 0.2) || (onLine(az - 6.71) && ax > 12.73 - 2.7)) return [0.93, 0.93, 0.9];
  if (ax > keyX && az < 2.44) return PAINT;
  // planks along X, 6 cm wide, each a little different, broken every few metres
  const plank = Math.floor((z + W) / 0.06);
  const seg = Math.floor((x + L + hash(plank, 7) * 3) / 2.4);
  const j = 0.94 + 0.12 * hash(plank, seg);
  return [HARDWOOD[0] * j, HARDWOOD[1] * j, HARDWOOD[2] * j];
}

const floorLight = (x, z) => 0.62 + 0.4 * Math.exp(-((x - PC[0]) ** 2 + (z - PC[2]) ** 2) / 60);

/** The crowd on the stands plane at (z, y): seated people in rows, dim. */
function crowdAt(z, y) {
  const cz = Math.floor((z + 16) / 0.42);
  const cy = Math.floor(y / 0.55);
  const lz = (z + 16) / 0.42 - cz;
  const ly = y / 0.55 - cy;
  const h = hash(cz, cy);
  const ox = 0.5 + (hash(cy, cz) - 0.5) * 0.3;
  const head = (lz - ox) ** 2 + (ly - 0.78) ** 2 < 0.16 ** 2;
  const torso = ((lz - ox) / 0.38) ** 2 + ((ly - 0.32) / 0.36) ** 2 < 1;
  if (head) return [0.42 * 0.7, 0.32 * 0.7, 0.26 * 0.7];
  if (torso && h > 0.12) {
    const k = Math.floor(h * 6);
    const shirt = [[0.6, 0.12, 0.1], [0.1, 0.2, 0.5], [0.75, 0.75, 0.75], [0.1, 0.35, 0.2], [0.6, 0.5, 0.15], [0.2, 0.2, 0.22]][k];
    return mul(shirt, 0.55);
  }
  return [0.07, 0.07, 0.09];
}

/** The front-row card's pattern at (z, y): alpha and colour (seats below, heads and shoulders above). */
function cardAt(z, y) {
  if (y < 0 || y > CARD.y1 || z < CARD.z0 || z > CARD.z1) return null;
  if (y < 0.45) return [0.12, 0.12, 0.14];
  const cell = Math.floor((z - CARD.z0) / 0.7);
  const zc = CARD.z0 + (cell + 0.5) * 0.7 + (hash(cell, 3) - 0.5) * 0.12;
  const head = (z - zc) ** 2 + (y - 1.14) ** 2 < 0.105 ** 2;
  const torso = Math.abs(z - zc) < 0.21 && (y < 0.92 || ((z - zc) / 0.21) ** 2 + ((y - 0.92) / 0.12) ** 2 < 1);
  if (head) return [0.62, 0.46, 0.36];
  if (torso) return mul([[0.5, 0.1, 0.1], [0.12, 0.2, 0.45], [0.8, 0.8, 0.8], [0.15, 0.15, 0.17]][Math.floor(hash(cell, 9) * 4)], 0.85);
  return null;
}

/**
 * Renders the scene at real time `tau` from a camera (court space, OpenCV axes) into W x H RGB, plus a kind per pixel.
 * `people: false` paints the people and the ball out, `rim: false` the rim (the plate).
 */
export function render(cam, tau, opts = {}) {
  const { width: W, height: H, f, cx, cy } = cam;
  const C = cam.centre;
  const r0 = rotate(cam.q, [1, 0, 0]);
  const r1 = rotate(cam.q, [0, 1, 0]);
  const r2 = rotate(cam.q, [0, 0, 1]);
  const sc = sceneAt(tau);
  const withPeople = opts.people !== false;
  const withRim = opts.rim !== false; // the plate paints the rim out (it is drawn in 3D at court.rim)
  // capsules: precomputed for the fixed ray origin C, with an image-space box each
  const caps = [];
  if (withPeople)
    sc.people.forEach((person, pi) =>
      person.caps.forEach((c) => {
        const ba = sub(c.b, c.a);
        const oa = sub(C, c.a);
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const p of [c.a, c.b]) {
          const v = sub(p, C);
          const z = dot(v, r2);
          const u = cx + (f * dot(v, r0)) / z;
          const w = cy + (f * dot(v, r1)) / z;
          const m = (f * c.r) / z + 2;
          box[0] = Math.min(box[0], u - m);
          box[1] = Math.min(box[1], w - m);
          box[2] = Math.max(box[2], u + m);
          box[3] = Math.max(box[3], w + m);
        }
        caps.push({ c, pi, ba, oa, baba: dot(ba, ba), baoa: dot(ba, oa), oaoa: dot(oa, oa), ob: sub(C, c.b), box, person });
      }),
    );
  const ball = withPeople ? sc.ball : null;
  const feet = sc.people.flatMap((p) => p.feet);
  const rgb = new Uint8Array(W * H * 3);
  const kind = new Uint8Array(W * H);
  const d = [0, 0, 0];
  for (let v = 0; v < H; v++) {
    const row = caps.filter((k) => v >= k.box[1] && v <= k.box[3]);
    const yv = (v - cy) / f;
    for (let u = 0; u < W; u++) {
      const xu = (u - cx) / f;
      d[0] = r0[0] * xu + r1[0] * yv + r2[0];
      d[1] = r0[1] * xu + r1[1] * yv + r2[1];
      d[2] = r0[2] * xu + r1[2] * yv + r2[2];
      const dn = Math.hypot(d[0], d[1], d[2]);
      d[0] /= dn;
      d[1] /= dn;
      d[2] /= dn;
      let best = Infinity;
      let hit = KIND.dark;
      let cap = null;
      for (const k of row) {
        if (u < k.box[0] || u > k.box[2]) continue;
        const t = rayCapsule(d, k);
        if (t > 0 && t < best) {
          best = t;
          hit = KIND.person + k.pi;
          cap = k;
        }
      }
      if (ball) {
        const oc = sub(C, ball);
        const b = dot(oc, d);
        const h = b * b - (dot(oc, oc) - BALL_R * BALL_R);
        if (h > 0) {
          const t = -b - Math.sqrt(h);
          if (t > 0 && t < best) {
            best = t;
            hit = KIND.ball;
          }
        }
      }
      if (d[1] < 0) {
        const t = -C[1] / d[1];
        if (t < best) {
          best = t;
          hit = KIND.floor;
        }
      }
      if (d[0] > 0) {
        let t = (BOARD.x - C[0]) / d[0];
        if (t < best) {
          const y = C[1] + t * d[1];
          const z = C[2] + t * d[2];
          if (y > BOARD.y0 && y < BOARD.y1 && Math.abs(z) < BOARD.z) {
            best = t;
            hit = KIND.board;
          }
        }
        t = (CARD.x - C[0]) / d[0];
        if (t < best && cardAt(C[2] + t * d[2], C[1] + t * d[1])) {
          best = t;
          hit = KIND.card;
        }
        t = (STANDS_X - C[0]) / d[0];
        if (t < best) {
          const y = C[1] + t * d[1];
          const z = C[2] + t * d[2];
          if (y >= 0 && y <= 9 && Math.abs(z) <= 16) {
            best = t;
            hit = KIND.stands;
          }
        }
      }
      if (withRim && d[1] > 0) {
        const t = (RIM[1] - C[1]) / d[1];
        if (t < best) {
          const rr = Math.hypot(C[0] + t * d[0] - RIM[0], C[2] + t * d[2] - RIM[2]);
          if (rr > 0.2286 && rr < 0.2486) {
            best = t;
            hit = KIND.rim;
          }
        }
      }
      let col;
      const px = C[0] + best * d[0];
      const py = C[1] + best * d[1];
      const pz = C[2] + best * d[2];
      if (hit >= KIND.person) {
        const c = cap.c;
        const pa = [px - c.a[0], py - c.a[1], pz - c.a[2]];
        const h = cap.baba > 0 ? Math.min(1, Math.max(0, dot(pa, cap.ba) / cap.baba)) : 0;
        const n = norm(sub(pa, mul(cap.ba, h)));
        col = lambert(albedo(c.part, py, cap.person.palette, cap.person.k), n);
      } else if (hit === KIND.ball) col = lambert([0.85, 0.42, 0.12], norm(sub([px, py, pz], ball)));
      else if (hit === KIND.floor) {
        let shade = floorLight(px, pz);
        if (withPeople) for (const ft of feet) shade *= 1 - 0.45 * Math.exp(-((px - ft[0]) ** 2 + (pz - ft[2]) ** 2) / 0.06);
        col = mul(floorAt(px, pz), shade);
      } else if (hit === KIND.stands) col = crowdAt(pz, py);
      else if (hit === KIND.card) col = cardAt(pz, py);
      else if (hit === KIND.board) col = Math.abs(pz) > BOARD.z - 0.05 || py < BOARD.y0 + 0.05 || py > BOARD.y1 - 0.05 ? [0.75, 0.12, 0.1] : [0.86, 0.86, 0.88];
      else if (hit === KIND.rim) col = [0.85, 0.35, 0.08];
      else col = [0.02, 0.02, 0.025];
      const o = (v * W + u) * 3;
      rgb[o] = Math.round(Math.min(1, col[0]) * 255);
      rgb[o + 1] = Math.round(Math.min(1, col[1]) * 255);
      rgb[o + 2] = Math.round(Math.min(1, col[2]) * 255);
      kind[v * W + u] = hit;
    }
  }
  return { rgb, kind };
}

/** Real time tau (seconds from F) of a source frame (frames.json `src`; fractional for in-betweens). */
export function tauOf(src) {
  return (src - F_SRC) / CAPTURE;
}

/**
 * The stand-in's true scene at source frame `src`, seen from `view` (a captured frame's view: probe.ts ProbeView,
 * court space, OpenCV axes): what a perfect watch would show in that frame, people and rim included. `{ rgb, kind }`
 * at the view's size; kind per pixel: 10 + i for person i of court.json's order (shooter, defender, trailer), 6 the
 * ball, else the background. The e2e's ground truth for P43 and P8 (layers, handoff).
 */
export function truthAt(view, src, opts = {}) {
  if (Math.abs(view.fx - view.fy) > 1e-3 * view.fx) throw new Error(`truthAt: square pixels only (fx ${view.fx}, fy ${view.fy})`);
  const cam = { width: view.width, height: view.height, f: view.fx, cx: view.cx, cy: view.cy, centre: view.centre, q: view.q };
  return render(cam, tauOf(src), opts);
}

export const TRUTH_KIND = { ball: KIND.ball, person: KIND.person };

/** Ray (origin C, unit d) against a precomputed capsule; the distance, or -1. (Inigo Quilez's capsule intersection.) */
function rayCapsule(d, k) {
  const bard = k.ba[0] * d[0] + k.ba[1] * d[1] + k.ba[2] * d[2];
  const rdoa = d[0] * k.oa[0] + d[1] * k.oa[1] + d[2] * k.oa[2];
  const r = k.c.r;
  const a = k.baba - bard * bard;
  let b = k.baba * rdoa - k.baoa * bard;
  let c = k.baba * k.oaoa - k.baoa * k.baoa - r * r * k.baba;
  let h = b * b - a * c;
  if (h >= 0 && a > 1e-12) {
    const t = (-b - Math.sqrt(h)) / a;
    const y = k.baoa + t * bard;
    if (y > 0 && y < k.baba) return t;
    const oc = y <= 0 ? k.oa : k.ob;
    b = d[0] * oc[0] + d[1] * oc[1] + d[2] * oc[2];
    c = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - r * r;
    h = b * b - c;
    if (h > 0) return -b - Math.sqrt(h);
  } else if (a <= 1e-12 || k.baba === 0) {
    // a sphere (a = b), or a ray along the axis
    const oc = k.oa;
    b = d[0] * oc[0] + d[1] * oc[1] + d[2] * oc[2];
    c = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - r * r;
    h = b * b - c;
    if (h > 0) return -b - Math.sqrt(h);
  }
  return -1;
}

// ---------------- writers ----------------

/** A depth mesh of a body seen from camera F (the splat-depth proxy stand-in), as a binary glTF. */
function proxyGlb(person, camF) {
  const caps = person.caps.map((c) => {
    const ba = sub(c.b, c.a);
    const oa = sub(CAM_C, c.a);
    return { c, ba, oa, ob: sub(CAM_C, c.b), baba: dot(ba, ba), baoa: dot(ba, oa), oaoa: dot(oa, oa) };
  });
  // the body's box in camera F's image
  const r0 = rotate(camF.q, [1, 0, 0]);
  const r1 = rotate(camF.q, [0, 1, 0]);
  const r2 = rotate(camF.q, [0, 0, 1]);
  let [u0, v0, u1, v1, zMean, zN] = [Infinity, Infinity, -Infinity, -Infinity, 0, 0];
  for (const c of person.caps)
    for (const p of [c.a, c.b]) {
      const v = sub(p, CAM_C);
      const z = dot(v, r2);
      const m = (camF.f * c.r) / z;
      const u = camF.cx + (camF.f * dot(v, r0)) / z;
      const w = camF.cy + (camF.f * dot(v, r1)) / z;
      [u0, v0, u1, v1] = [Math.min(u0, u - m), Math.min(v0, w - m), Math.max(u1, u + m), Math.max(v1, w + m)];
      zMean += z;
      zN++;
    }
  zMean /= zN;
  const [nu, nv] = [40, 80];
  const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const u = lerp(u0, u1, i / nu);
      const v = lerp(v0, v1, j / nv);
      const d = norm(add(add(mul(r0, (u - camF.cx) / camF.f), mul(r1, (v - camF.cy) / camF.f)), r2));
      let t = Infinity;
      for (const k of caps) {
        const x = rayCapsule(d, k);
        if (x > 0 && x < t) t = x;
      }
      // off the body the mesh sits at the body's mean depth (the matte hides it)
      if (!Number.isFinite(t)) t = zMean / dot(d, r2);
      const p = add(CAM_C, mul(d, t));
      pos.set(p, ((j * (nu + 1)) + i) * 3);
    }
  const idx = new Uint16Array(nu * nv * 6);
  let o = 0;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      idx.set([a, a + nu + 1, a + 1, a + 1, a + nu + 1, a + nu + 2], o);
      o += 6;
    }
  const min = [0, 1, 2].map((k) => Math.min(...pos.filter((_, n) => n % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...pos.filter((_, n) => n % 3 === k)));
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const json = {
    asset: { version: "2.0", generator: "court-side standin.mjs" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: `${person.id}-proxy` }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
  };
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const ch = (b, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(b.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, b]);
  };
  return Buffer.concat([head, ch(jsonChunk, 0x4e4f534a), ch(binChunk, 0x004e4942)]);
}

/** A soft floor blob on a rect (shadow: black; reflection: the jersey colour). */
function floorBlob(rect, feet, rgb, strength, size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const x = lerp(rect[0], rect[2], (i + 0.5) / size);
      const z = lerp(rect[1], rect[3], (j + 0.5) / size);
      let a = 0;
      for (const ft of feet) a = Math.max(a, Math.exp(-((x - ft[0]) ** 2 + (z - ft[2]) ** 2) / 0.09));
      const o = (j * size + i) * 4;
      data.set([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, Math.round(a * strength * 255)], o);
    }
  return { width: size, height: size, channels: 4, data };
}

function run(cmd, args, input) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.slice(0, 6).join(" ")} ... exited ${code}\n${err}`))));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

const X264 = [
  "-c:v", "libx264", "-profile:v", "high", "-level:v", "5.1", "-preset", "veryfast", "-crf", "18", "-bf", "0", "-refs", "3",
  "-g", "100000", "-keyint_min", "100000", "-sc_threshold", "0", "-forced-idr", "1",
  "-x264-params", "aud=1:repeat-headers=1:colorprim=bt709:transfer=bt709:colormatrix=bt709", "-f", "h264",
];

/** Bilinear resize of RGB. */
function resize(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      for (let k = 0; k < 3; k++) {
        const a = src[(y0 * sw + x0) * 3 + k] * (1 - wx) + src[(y0 * sw + x1) * 3 + k] * wx;
        const b = src[(y1 * sw + x0) * 3 + k] * (1 - wx) + src[(y1 * sw + x1) * 3 + k] * wx;
        out[(y * dw + x) * 3 + k] = Math.round(a * (1 - wy) + b * wy);
      }
    }
  }
  return out;
}

/**
 * One stacked show frame (STREAM.width x STREAM.height RGB): the live frame, its plate (nobody in it, the rim painted
 * out) and the matte atlas, each card's matte (the person's visible pixels in the live frame) in its tile.
 */
export function stackedFrame(show, cards, rw, rh) {
  const cam = scaled(srcCam(show), rw);
  cam.height = rh;
  const live = render(cam, show.tau);
  const plate = render(cam, show.tau, { people: false, rim: false });
  const [, , lw, lh] = STREAM.live;
  const out = new Uint8Array(STREAM.width * STREAM.height * 3);
  out.set(resize(live.rgb, rw, rh, lw, lh), (STREAM.live[1] * STREAM.width + STREAM.live[0]) * 3);
  out.set(resize(plate.rgb, rw, rh, lw, lh), (STREAM.plate[1] * STREAM.width + STREAM.plate[0]) * 3);
  const ids = sceneAt(show.tau).people.map((p) => p.id);
  const [, , mw, mh] = STREAM.mattes;
  const toRender = rw / SRC.width; // source pixel edges -> render pixels
  for (const card of cards) {
    const want = card.kind === "ball" ? KIND.ball : KIND.person + ids.indexOf(card.id);
    const [tx0, ty0, tx1, ty1] = [card.tile[0] * mw, card.tile[1] * mh, card.tile[2] * mw, card.tile[3] * mh].map(Math.round);
    const [bx0, by0, bx1, by1] = card.box;
    for (let ty = ty0; ty < ty1; ty++)
      for (let tx = tx0; tx < tx1; tx++) {
        let hits = 0;
        // 2 x 2 samples per atlas pixel, through the box (mapped linearly onto the tile) into the render
        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const bx = bx0 + ((tx - tx0 + ox) / (tx1 - tx0)) * (bx1 - bx0);
          const by = by0 + ((ty - ty0 + oy) / (ty1 - ty0)) * (by1 - by0);
          const rx = Math.min(rw - 1, Math.floor(bx * toRender));
          const ry = Math.min(rh - 1, Math.floor(by * toRender));
          if (live.kind[ry * rw + rx] === want) hits++;
        }
        const v = Math.round((hits / 4) * 255);
        const o = ((STREAM.mattes[1] + ty) * STREAM.width + STREAM.mattes[0] + tx) * 3;
        out[o] = out[o + 1] = out[o + 2] = v;
      }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const { court, frames, cards } = standinBundle();
  if (args.includes("--fixture")) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(court, null, 2)}\n`);
    console.log(`FIXTURE ${FIXTURE}`);
    return;
  }
  const out = resolve(opt("--out", DEFAULT_OUT));
  const [RW, RH] = opt("--render", "768x432").split("x").map(Number);
  const workers = Number(opt("--workers", Math.max(1, Math.min(8, availableParallelism() - 2))));
  const t0 = Date.now();
  const log = (m) => console.log(`[standin ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  rmSync(out, { recursive: true, force: true });
  for (const d of ["video", "court", "stands", "audio", "players/shooter", "players/defender", "others/trailer"]) mkdirSync(join(out, d), { recursive: true });

  const tl = timeline();
  writeFileSync(join(out, "court.json"), JSON.stringify(court, null, 2));
  writeFileSync(join(out, "video/frames.json"), JSON.stringify(frames));
  writeFileSync(join(out, "video/cards.json"), JSON.stringify(cards));
  log(`court.json, frames.json, cards.json (${frames.length} show frames, ${(court.metrics.interpShare * 100).toFixed(1)}% in-betweens)`);

  // frame F and its plate, at half the source size
  const fIndex = court.video.segments.eases[0].frames[1];
  const camF = srcCam(tl.shows[fIndex]);
  const camF2 = scaled(camF, 1920);
  const full = render(camF2, 0);
  const clean = render(camF2, 0, { people: false, rim: false });
  const n = camF2.width * camF2.height;
  const mask = (pick) => {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = pick(i) ? 255 : 0;
    return { width: camF2.width, height: camF2.height, channels: 1, data: m };
  };
  writePng(join(out, "video/freeze.png"), { width: camF2.width, height: camF2.height, channels: 3, data: full.rgb });
  writePng(join(out, "video/freeze-clean.png"), { width: camF2.width, height: camF2.height, channels: 3, data: clean.rgb });
  writePng(join(out, "video/stands-mask.png"), mask((i) => clean.kind[i] === KIND.stands || clean.kind[i] === KIND.card));
  log("freeze.png, freeze-clean.png, stands-mask.png");

  // the pair and the trailer: splats, reality, proxy (the pair), floor maps
  const atF = sceneAt(0);
  for (const [i, person] of atF.people.entries()) {
    const dir = person.id === "trailer" ? "others/trailer" : `players/${person.id}`;
    const pts = sampleBody(person, person.id === "trailer" ? 16000 : 24000, 11 + i);
    writeFileSync(join(out, dir, "freeze.ply"), ply(pts, false));
    writeFileSync(join(out, dir, "reality.ply"), ply(pts, true));
    if (person.id !== "trailer") writeFileSync(join(out, dir, "proxy.glb"), proxyGlb(person, camF));
    const rect = floorRect(person.foot, 0.8);
    writePng(join(out, dir, "shadow.png"), floorBlob(rect, person.feet, [0, 0, 0], 0.55));
    writePng(join(out, dir, "reflection.png"), floorBlob(rect, person.feet, person.palette.jersey, 0.15));
  }
  log("players/*/freeze.ply, reality.ply, proxy.glb, shadow.png, reflection.png; others/trailer/*");

  // the front-row card, cut as the footage shows it
  {
    const ppm = 60;
    const w = Math.round((CARD.z1 - CARD.z0) * ppm);
    const h = Math.round(CARD.y1 * ppm);
    const data = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const c = cardAt(CARD.z0 + ((i + 0.5) / w) * (CARD.z1 - CARD.z0), CARD.y1 * (1 - (j + 0.5) / h));
        if (c) data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], (j * w + i) * 4);
      }
    writePng(join(out, "stands/front-row.png"), { width: w, height: h, channels: 4, data });
  }

  // the floor from above, and where the camera saw it (any show frame, every 4th checked)
  {
    const ppm = 40;
    const w = Math.round(28.65 * ppm);
    const h = Math.round(15.24 * ppm);
    const rgb = new Uint8Array(w * h * 3);
    const seen = new Uint8Array(w * h);
    const cams = tl.shows.filter((_, i) => i % 4 === 0).map((s) => {
      const c = srcCam(s);
      return { f: c.f, r0: rotate(c.q, [1, 0, 0]), r1: rotate(c.q, [0, 1, 0]), r2: rotate(c.q, [0, 0, 1]) };
    });
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const x = -14.325 + ((i + 0.5) / w) * 28.65;
        const z = -7.62 + ((j + 0.5) / h) * 15.24;
        const c = mul(floorAt(x, z), floorLight(x, z));
        rgb.set([c[0] * 255, c[1] * 255, c[2] * 255], (j * w + i) * 3);
        const v = [x - CAM_C[0], -CAM_C[1], z - CAM_C[2]];
        for (const k of cams) {
          const zc = dot(v, k.r2);
          const u = SRC.cx + (k.f * dot(v, k.r0)) / zc;
          const vv = SRC.cy + (k.f * dot(v, k.r1)) / zc;
          if (zc > 0 && u >= -0.5 && u < SRC.width - 0.5 && vv >= -0.5 && vv < SRC.height - 0.5) {
            seen[j * w + i] = 255;
            break;
          }
        }
      }
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "pipe:0", "-q:v", "3", join(out, "court/floor.jpg")], Buffer.from(rgb));
    writePng(join(out, "court/floor-seen.png"), { width: w, height: h, channels: 1, data: seen });
  }
  log("court/floor.jpg, floor-seen.png, stands/front-row.png");

  // a crowd-like bed (pink noise, slow swells, -23 LUFS) and a swell one-shot
  const ff = ["-y", "-hide_banner", "-loglevel", "error"];
  await run("ffmpeg", [...ff, "-f", "lavfi", "-i", "anoisesrc=d=19:c=pink:r=48000:a=0.5:seed=7", "-af", "highpass=f=120,lowpass=f=5000,tremolo=f=0.35:d=0.3,loudnorm=I=-23:TP=-1.5:LRA=7", "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", "128k", join(out, "audio/bed.m4a")]);
  await run("ffmpeg", [...ff, "-f", "lavfi", "-i", "anoisesrc=d=3:c=pink:r=48000:a=0.6:seed=11", "-af", "highpass=f=150,lowpass=f=6000,afade=t=in:d=1.2,afade=t=out:st=2:d=1,loudnorm=I=-18:TP=-1.5", "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", "128k", join(out, "audio/swell.m4a")]);
  log("audio/bed.m4a, swell.m4a");

  // the show: every stacked frame rendered from its own camera, encoded twice (1536 wide and the small copy)
  const starts = [court.video.segments.pass1, court.video.segments.pass2, court.video.segments.resume, ...court.video.segments.eases.map((e) => e.frames)].map((r) => r[0]).sort((a, b) => a - b);
  const keys = `expr:${starts.map((s) => `eq(n,${s})`).join("+")}`;
  const ffmpeg = spawn("ffmpeg", [
    ...ff, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${STREAM.width}x${STREAM.height}`, "-r", String(HZ), "-i", "pipe:0",
    "-filter_complex", `[0:v]split=2[a][b];[a]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[hi];[b]scale=${SMALL.width}:${SMALL.height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p[lo]`,
    "-map", "[hi]", "-force_key_frames", keys, ...X264, join(out, "video/show.h264"),
    "-map", "[lo]", "-force_key_frames", keys, ...X264, join(out, "video/show-small.h264"),
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let ffErr = "";
  ffmpeg.stderr.on("data", (d) => (ffErr += d));
  const encoded = new Promise((ok, fail) => ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}\n${ffErr}`)))));
  const pool = Array.from({ length: workers }, () => new Worker(new URL(import.meta.url), { workerData: { RW, RH } }));
  const done = new Map();
  let waiting = null;
  pool.forEach((w) =>
    w.on("message", ({ i, rgb }) => {
      done.set(i, rgb);
      if (waiting && done.has(waiting.i)) waiting.resolve();
    }),
  );
  let next = 0;
  const ask = () => {
    if (next < tl.shows.length) {
      const s = tl.shows[next];
      pool[next % workers].postMessage({ i: next, show: { tau: s.tau, q: s.q, f: s.f }, cards: cards[next].cards });
      next++;
    }
  };
  for (let k = 0; k < workers * 3; k++) ask();
  for (let i = 0; i < tl.shows.length; i++) {
    if (!done.has(i)) await new Promise((r) => (waiting = { i, resolve: r }));
    const rgb = done.get(i);
    done.delete(i);
    ask();
    if (!ffmpeg.stdin.write(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength))) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (i % 200 === 0) log(`show frame ${i} / ${tl.shows.length}`);
  }
  ffmpeg.stdin.end();
  await encoded;
  await Promise.all(pool.map((w) => w.terminate()));
  log("video/show.h264, show-small.h264");

  // self-check: the files as written are what the format promises
  const written = JSON.parse(readFileSync(join(out, "court.json"), "utf8"));
  const problems = [...validateCourt(written)];
  problems.push(...validateFrames(JSON.parse(readFileSync(join(out, "video/frames.json"), "utf8")), court));
  problems.push(...validateCards(JSON.parse(readFileSync(join(out, "video/cards.json"), "utf8")), court, frames));
  for (const [file, codec] of [["video/show.h264", "avc1.640033"], ["video/show-small.h264", "avc1.640033"]]) {
    const bytes = new Uint8Array(readFileSync(join(out, file)));
    const units = splitAnnexB(bytes);
    const keyAt = units.flatMap((u, i) => (u.key ? [i] : []));
    if (units.length !== frames.length) problems.push(`${file}: ${units.length} access units for ${frames.length} show frames`);
    if (keyAt.join() !== starts.join()) problems.push(`${file}: IDRs at ${keyAt.join(",")}, segments start at ${starts.join(",")}`);
    const sps = spsCodec(bytes);
    if (sps?.codec !== codec) problems.push(`${file}: SPS says ${sps?.codec}, court.json says ${codec}`);
    log(`${file}: ${units.length} frames, IDR at ${keyAt.join(",")}, ${sps?.codec}, ${(bytes.length / 1e6).toFixed(1)} MB`);
  }
  if (problems.length) {
    console.error(`STANDIN FAIL\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`STANDIN OK ${out} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

if (!isMainThread) {
  const { RW, RH } = workerData;
  parentPort.on("message", ({ i, show, cards }) => {
    const rgb = stackedFrame(show, cards, RW, RH);
    parentPort.postMessage({ i, rgb }, [rgb.buffer]);
  });
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
