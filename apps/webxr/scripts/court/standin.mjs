// The stand-in court bundle: a synthetic play with the real one's geometry, so every stream builds and tests against
// a valid bundle before the real footage lands. Nothing in it comes from broadcast footage.
//   node apps/webxr/scripts/court/standin.mjs [--out <dir>] [--render 960x540] [--workers N]
// Writes (default) apps/webxr/scripts/court/out/standin/ (git-ignored by scripts/court/.gitignore):
//   court.json, video/frames.json      valid per src/court/format.ts (checked before it exits)
//   video/show.h264 (+ show-1080.h264)  the whole show at 72 Hz display times, 2560x1440 avc1.640034 (High 5.2),
//                                      -bf 0, an IDR at every segment start, AUD per frame; pass 1 (1x), pass 2
//                                      (0.6x), three eases (1.2/1.0/0.8 s) ending on F, the resume through the make
//   video/freeze.png, freeze-clean.png, stands-mask.png, inpaint-mask.png   frame F and its plates (1920x1080)
//   players/<id>/freeze.ply, reality.ply, proxy.glb, shadow.png, reflection.png   two frozen players (3DGS PLY, SH1)
//   others/ref/...                     one extra (a baseline ref)
//   stands/front-row.png, court/floor.jpg, court/floor-seen.png, audio/bed.m4a, audio/swell.m4a
// The scene: camera A's stand-in at a fixed centre ~30 m from the pair, 1.0 m high, f 25k px at F (an 8.8 x 4.9 deg
// window; calib-real's v9 solve says ~28.7k for A), panning and zooming with the play; each show frame is rendered from exactly the
// camera frames.json lists for it. The source clip is a 120 fps real-time capture (sourceFps 120, slow 1), so at 0.6x
// every display frame is a real frame and at 1x one in three is (the rest are in-betweens, flagged interp).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { LABEL, validateCourt, validateFrames } from "../../src/court/format.ts";
import { angleDeg, lookRotation, rotate, scaled } from "../../src/court/camera.ts";
import { EASE_SECONDS, PASS2_SPEED, RESUME_RAMP_S, easeFrameCount, easeTau, resumeTau } from "../../src/court/clock.ts";
import { splitAnnexB, spsCodec } from "../../src/court/annexb.ts";
import { writePng } from "./png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(HERE, "out", "standin");

// ---------------- the show's timing ----------------
const HZ = 72;
const CAPTURE = 120; // source frames per second of real time (sourceFps 120 x slow 1)
const F_SRC = 1244; // F's source frame
const PASS1 = { start: -2.4, frames: 195 }; // real time relative to F, seconds; 1x
const PASS2 = { start: -1.2, end: 1.3 }; // 0.6x
const MAKE_TAU = 1.0; // the ball drops through the net
const SRC = { width: 3840, height: 2160, cx: 1919.5, cy: 1079.5 };

// ---------------- the scene (court space) ----------------
const PC = [6.0, 0, 1.0]; // the pair's centre on the floor
const CAM_C = [-22.0, 1.0, -9.0]; // camera A's stand-in centre (~29.7 m from the pair)
const F0 = 25000; // focal at F, source pixels (head to toe with the raised hand in frame; v9 is ~28.7k)
const RIM = [12.73, 3.05, 0];
const BALL_R = 0.1195;
const REF_AT = [10.6, 0, 4.8];
const STANDS_X = 16.0;
const CARD = { x: 15.2, z0: -4, z1: 10, y1: 1.35 };
const BOARD = { x: 13.105, y0: 2.9, y1: 3.97, z: 0.915 };
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

// the camera's horizontal frame toward the pair: players are placed along it and across it
const FWD = norm([PC[0] - CAM_C[0], 0, PC[2] - CAM_C[2]]);
const RIGHT = [-FWD[2], 0, FWD[0]];
const place = (along, across) => [PC[0] + FWD[0] * along + RIGHT[0] * across, 0, PC[2] + FWD[2] * along + RIGHT[2] * across];
const S_F = place(-0.3, -0.25); // the shooter, nearer the camera, his back to it
const D_F = place(0.3, 0.25); // the defender, facing the camera
const V_S = add(mul(RIGHT, 0.9), mul(FWD, -0.15)); // m/s before F
const V_D = mul(V_S, 0.85);

const PALETTE = {
  shooter: { skin: [0.8, 0.62, 0.5], jersey: [0.16, 0.33, 0.74], shorts: [0.14, 0.29, 0.66], shoes: [0.95, 0.95, 0.95], hair: [0.22, 0.15, 0.1], height: 1.98 },
  defender: { skin: [0.45, 0.3, 0.22], jersey: [0.08, 0.3, 0.22], shorts: [0.07, 0.26, 0.19], shoes: [0.12, 0.12, 0.12], hair: [0.06, 0.05, 0.05], height: 2.16 },
  ref: { skin: [0.7, 0.52, 0.42], jersey: [0.58, 0.58, 0.6], shorts: [0.08, 0.08, 0.09], shoes: [0.08, 0.08, 0.08], hair: [0.3, 0.3, 0.3], height: 1.85 },
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
  else if (tau <= 0.35) ball = lerp3(hip, over, smooth(tau / 0.35));
  else if (tau <= MAKE_TAU) {
    const s = (tau - 0.35) / (MAKE_TAU - 0.35);
    ball = add(lerp3(over, RIM, s), [0, 4 * 1.3 * s * (1 - s), 0]);
  } else ball = add(RIM, [0, -2.5 * (tau - MAKE_TAU), 0]);
  const sShoulder = (side) => add(add(S, mul(sRight, side * 0.21 * ks)), [0, 1.43 * ks, 0]);
  const onBall = (side) => add(ball, mul(norm(sub(sShoulder(side), ball)), BALL_R + 0.05));
  const hands =
    tau > 0.35
      ? { left: add(sShoulder(-1), [toD[0] * 0.15, 0.5 * ks, toD[2] * 0.15]), right: add(sShoulder(1), [toD[0] * 0.25, 0.55 * ks, toD[2] * 0.25]) }
      : { left: tau > -0.5 ? onBall(-1) : null, right: onBall(1) };
  const shooter = body(S, toD, ks, hands);
  // the defender's right arm rises over the shooter's head from tau = -1 to F
  const dRight = [-toS[2], 0, toS[0]];
  const hang = add(add(D, mul(dRight, 0.28 * kd)), [0, 0.82 * kd, 0]);
  const over_ = add(add(shooter.head, [0, 0.3, 0]), mul(toS, -0.12));
  const raise = smooth((tau + 1) / 1);
  const defender = body(D, toS, kd, { left: null, right: lerp3(hang, over_, raise) });
  const toPair = norm(sub(PC, REF_AT));
  const ref = body(REF_AT, toPair, PALETTE.ref.height / 1.95, { left: null, right: null });
  return {
    people: [
      { id: "shooter", ...shooter, palette: PALETTE.shooter, k: ks },
      { id: "defender", ...defender, palette: PALETTE.defender, k: kd },
      { id: "ref", ...ref, palette: PALETTE.ref, k: PALETTE.ref.height / 1.95 },
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
  const f = F0 * (1 + 0.04 * Math.sin(1.9 * tau)) * lerp(1, 0.5, follow);
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
    const j = Math.round((easeTau(0, n, HZ) - PASS2.start) / step2);
    if (Math.abs(PASS2.start + j * step2 - easeTau(0, n, HZ)) > 1e-9) throw new Error(`ease of ${n} frames doesn't start on pass 2's grid`);
    const frames = range(() => {
      for (let k = 1; k <= n; k++) taus.push(easeTau(k, n, HZ));
    });
    return { start: pass2[0] + j, frames, seconds: round(n / HZ, 4) };
  });
  const ramp = easeFrameCount(RESUME_RAMP_S, HZ);
  const resume = range(() => {
    for (let k = 1; resumeTau(k, ramp, HZ) <= PASS2.end + 1e-9; k++) taus.push(resumeTau(k, ramp, HZ));
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

/** court.json and frames.json for the stand-in (pure: no files). */
export function standinBundle() {
  const tl = timeline();
  const atF = sceneAt(0);
  const [shooter, defender, ref] = atF.people;
  const bounds = { shooter: capsuleBounds(shooter.caps), defender: capsuleBounds(defender.caps) };
  // the viewing spots: front (toward the camera) and 60 deg to either side, as close as 1.5 m and always `clear` m
  // from both bodies (P29)
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
  const refChest = [REF_AT[0], 1.2, REF_AT[2]];
  const maxRayAngle = Math.max(...spots.map((s) => angleDeg(sub(refChest, CAM_C), sub(refChest, eye(s)))));
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
    court: { length: 28.65, width: 15.24, rim: RIM, floor: "court/floor.jpg", floorSeen: "court/floor-seen.png", hardwood: [0.71, 0.52, 0.33] },
    camera: { centre: CAM_C, width: SRC.width, height: SRC.height, cx: SRC.cx, cy: SRC.cy, k1: 0, sourceFps: CAPTURE, captureFps: CAPTURE, slow: 1 },
    video: {
      file: "video/show.h264",
      codec: "avc1.640034",
      width: 2560,
      height: 1440,
      displayHz: HZ,
      fallbacks: { p1080: { file: "video/show-1080.h264", codec: "avc1.640032", width: 1920, height: 1080 } },
      frames: "video/frames.json",
      segments: tl.segments,
      cutoff: tl.cutoff,
      freezeSource: F_SRC,
      makeSource: F_SRC + MAKE_TAU * CAPTURE,
      freeze: "video/freeze.png",
      freezeClean: "video/freeze-clean.png",
      standsMask: "video/stands-mask.png",
      inpaintMask: "video/inpaint-mask.png",
    },
    seat: { ray: "freeze", distance: 5.0, distanceRange: [4, 7], pairCentre: PC, closer: 2.5, clear: 1.0, spots, ringArea: [4.5, 5.5] },
    freeze: {
      players: [player(shooter, "Shooter (stand-in)", seenShare(shooter)), player(defender, "Defender (stand-in)", seenShare(defender))],
      ball: { centre: atF.ball.map((x) => round(x, 4)), radius: BALL_R, erase: [{ player: "shooter", radius: 0.15 }] },
      others: [
        {
          id: "ref",
          name: "Baseline ref (stand-in)",
          kind: "splats",
          file: "others/ref/freeze.ply",
          reality: "others/ref/reality.ply",
          pose: "A",
          foot: REF_AT,
          height: PALETTE.ref.height,
          maxRayAngle: round(maxRayAngle, 2),
          shadow: { image: "others/ref/shadow.png", rect: floorRect(REF_AT, 0.8) },
          reflection: { image: "others/ref/reflection.png", rect: floorRect(REF_AT, 0.8) },
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
    metrics: { reprojDeg: { median: 0, p95: 0 }, heldOutPsnrVsGenerated: {}, seatPsnr: {}, interpShare: round(interpShare, 4) },
  };
  const frames = tl.shows.map((s) => ({ src: s.src, interp: s.interp, q: s.q.map((x) => round(x, 9)), f: round(s.f, 4) }));
  return { court, frames };
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
 * `people: false` paints the people and the ball out (the clean plate).
 */
export function render(cam, tau, opts = {}) {
  const { width: W, height: H, f, cx, cy } = cam;
  const C = cam.centre;
  const r0 = rotate(cam.q, [1, 0, 0]);
  const r1 = rotate(cam.q, [0, 1, 0]);
  const r2 = rotate(cam.q, [0, 0, 1]);
  const sc = sceneAt(tau);
  const withPeople = opts.people !== false;
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
      if (d[1] > 0) {
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

const srcCam = (s) => ({ centre: CAM_C, q: s.q, f: s.f, cx: SRC.cx, cy: SRC.cy, width: SRC.width, height: SRC.height });

const X264 = (level) => [
  "-c:v", "libx264", "-profile:v", "high", "-level:v", level, "-preset", "veryfast", "-crf", "18", "-bf", "0", "-refs", "3",
  "-g", "100000", "-keyint_min", "100000", "-sc_threshold", "0", "-forced-idr", "1",
  "-x264-params", "aud=1:repeat-headers=1:colorprim=bt709:transfer=bt709:colormatrix=bt709", "-f", "h264",
];

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const out = resolve(opt("--out", DEFAULT_OUT));
  const [RW, RH] = opt("--render", "960x540").split("x").map(Number);
  const workers = Number(opt("--workers", Math.max(1, Math.min(8, availableParallelism() - 2))));
  const t0 = Date.now();
  const log = (m) => console.log(`[standin ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  rmSync(out, { recursive: true, force: true });
  for (const d of ["video", "court", "stands", "audio", "players/shooter", "players/defender", "others/ref"]) mkdirSync(join(out, d), { recursive: true });

  const { court, frames } = standinBundle();
  const tl = timeline();
  writeFileSync(join(out, "court.json"), JSON.stringify(court, null, 2));
  writeFileSync(join(out, "video/frames.json"), JSON.stringify(frames));
  log(`court.json, frames.json (${frames.length} show frames, ${(court.metrics.interpShare * 100).toFixed(1)}% in-betweens)`);

  // frame F and its plates, at half the source size
  const fIndex = court.video.segments.eases[0].frames[1];
  const camF = srcCam(tl.shows[fIndex]);
  const camF2 = scaled(camF, 1920);
  const full = render(camF2, 0);
  const clean = render(camF2, 0, { people: false });
  const n = camF2.width * camF2.height;
  const mask = (pick) => {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = pick(i) ? 255 : 0;
    return { width: camF2.width, height: camF2.height, channels: 1, data: m };
  };
  writePng(join(out, "video/freeze.png"), { width: camF2.width, height: camF2.height, channels: 3, data: full.rgb });
  writePng(join(out, "video/freeze-clean.png"), { width: camF2.width, height: camF2.height, channels: 3, data: clean.rgb });
  writePng(join(out, "video/stands-mask.png"), mask((i) => clean.kind[i] === KIND.stands || clean.kind[i] === KIND.card));
  writePng(join(out, "video/inpaint-mask.png"), mask((i) => full.kind[i] >= KIND.person || full.kind[i] === KIND.ball));
  log("freeze.png, freeze-clean.png, stands-mask.png, inpaint-mask.png");

  // players and the extra: splats, reality, proxy, floor maps
  const atF = sceneAt(0);
  for (const [i, person] of atF.people.entries()) {
    const dir = person.id === "ref" ? "others/ref" : `players/${person.id}`;
    const pts = sampleBody(person, person.id === "ref" ? 12000 : 24000, 11 + i);
    writeFileSync(join(out, dir, "freeze.ply"), ply(pts, false));
    writeFileSync(join(out, dir, "reality.ply"), ply(pts, true));
    if (person.id !== "ref") writeFileSync(join(out, dir, "proxy.glb"), proxyGlb(person, camF));
    const rect = floorRect(person.foot, 0.8);
    writePng(join(out, dir, "shadow.png"), floorBlob(rect, person.feet, [0, 0, 0], 0.55));
    writePng(join(out, dir, "reflection.png"), floorBlob(rect, person.feet, person.palette.jersey, 0.15));
  }
  log("players/*/freeze.ply, reality.ply, proxy.glb, shadow.png, reflection.png; others/ref/*");

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

  // the show: every show frame rendered from its own camera, encoded twice (1440p High 5.2, 1080p High 5.0)
  const starts = [court.video.segments.pass1, court.video.segments.pass2, court.video.segments.resume, ...court.video.segments.eases.map((e) => e.frames)].map((r) => r[0]).sort((a, b) => a - b);
  const keys = `expr:${starts.map((s) => `eq(n,${s})`).join("+")}`;
  const ffmpeg = spawn("ffmpeg", [
    ...ff, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${RW}x${RH}`, "-r", String(HZ), "-i", "pipe:0",
    "-filter_complex", "[0:v]split=2[a][b];[a]scale=2560:1440:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p[hi];[b]scale=1920:1080:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p[lo]",
    "-map", "[hi]", "-force_key_frames", keys, ...X264("5.2"), join(out, "video/show.h264"),
    "-map", "[lo]", "-force_key_frames", keys, ...X264("5.0"), join(out, "video/show-1080.h264"),
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
      pool[next % workers].postMessage({ i: next, tau: s.tau, q: s.q, f: s.f });
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
    if (i % 100 === 0) log(`show frame ${i} / ${tl.shows.length}`);
  }
  ffmpeg.stdin.end();
  await encoded;
  await Promise.all(pool.map((w) => w.terminate()));
  log("video/show.h264, show-1080.h264");

  // self-check: the files as written are what the format promises
  const problems = [...validateCourt(JSON.parse(readFileSync(join(out, "court.json"), "utf8")))];
  problems.push(...validateFrames(JSON.parse(readFileSync(join(out, "video/frames.json"), "utf8")), court));
  for (const [file, codec] of [["video/show.h264", "avc1.640034"], ["video/show-1080.h264", "avc1.640032"]]) {
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
  parentPort.on("message", ({ i, tau, q, f }) => {
    const cam = scaled({ centre: CAM_C, q, f, cx: SRC.cx, cy: SRC.cy, width: SRC.width, height: SRC.height }, RW);
    cam.height = RH;
    const { rgb } = render(cam, tau);
    parentPort.postMessage({ i, rgb }, [rgb.buffer]);
  });
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
