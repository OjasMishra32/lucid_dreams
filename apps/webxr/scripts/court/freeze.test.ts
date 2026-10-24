// freeze.ts's pure parts: the capsule proximity fade (P17) and the ball's projection from camera F (P8's ball pixels).
//   node --experimental-transform-types --test apps/webxr/scripts/court/freeze.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FADE_NEAR, FADE_S, FADE_TO, capsuleDistance, fadeStep, inBounds, nearBody, projectUv } from "../../src/court/freeze.ts";
import { cameraOf, project } from "../../src/court/camera.ts";
import type { Court, ShowFrame, Vec3 } from "../../src/court/format.ts";
import { standinBundle } from "./standin.mjs";
import { openEye } from "./look/proximity.mjs";
import { boundsCase } from "./look/bounds.mjs";

const { court, frames } = structuredClone(standinBundle()) as { court: Court; frames: ShowFrame[] };
const HZ = 72;
const close = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

test("capsule distance: zero on the surface, negative inside, the radius off at the ends", () => {
  const c = { a: [0, 1, 0] as Vec3, b: [0, 1.5, 0] as Vec3, r: 0.15 };
  close(capsuleDistance([0.15, 1.2, 0], c), 0, 1e-12, "side");
  close(capsuleDistance([0, 1.25, 0], c), -0.15, 1e-12, "axis");
  close(capsuleDistance([0, 1.85, 0], c), 0.2, 1e-12, "past the top");
});

test("P17: an eye 0.2 m from a torso or head capsule fades that player; 0.3 m from the ball or a hand never does", () => {
  for (const p of court.freeze.players) {
    const torso = p.capsules[0];
    const mid: Vec3 = [(torso.a[0] + torso.b[0]) / 2, (torso.a[1] + torso.b[1]) / 2, (torso.a[2] + torso.b[2]) / 2];
    const eye: Vec3 = [mid[0] + torso.r + FADE_NEAR - 1e-9, mid[1], mid[2]];
    assert.ok(nearBody(eye, p.capsules), `${p.id}: 0.2 m from the torso fades`);
    const head = p.capsules[p.capsules.length - 1];
    assert.ok(nearBody([head.a[0], head.a[1] + head.r + 0.19, head.a[2]], p.capsules), `${p.id}: 0.19 m over the head fades`);
  }
  // the ball sits by the shooter's hip, outside the capsules: an eye 0.3 m from it stays clear of every capsule
  const b = court.freeze.ball;
  for (const dir of [[1, 0, 0], [0, 0, 1], [0, 0, -1], [-1, 0, 0], [0, 1, 0]] as Vec3[]) {
    const eye: Vec3 = [b.centre[0] + dir[0] * (b.radius + 0.3), b.centre[1] + dir[1] * (b.radius + 0.3), b.centre[2] + dir[2] * (b.radius + 0.3)];
    const near = court.freeze.players.filter((p) => nearBody(eye, p.capsules)).map((p) => p.id);
    // only directions that also bring the eye within 0.2 m of a torso may fade (that is the torso, not the ball)
    for (const id of near) {
      const p = court.freeze.players.find((x) => x.id === id)!;
      assert.ok(p.capsules.some((c) => capsuleDistance(eye, c) <= FADE_NEAR), `${id} fades only by a capsule`);
    }
  }
  const far = court.freeze.players[0].capsules;
  assert.ok(!nearBody([b.centre[0], b.centre[1], b.centre[2] + 0.6], far), "beside the ball, away from the body: no fade");
});

test("the fade takes 300 ms (+-1 frame) each way and stops at 30%", () => {
  let o = 1;
  let n = 0;
  while (o > FADE_TO && n < 100) {
    o = fadeStep(o, true, 1 / HZ);
    n++;
  }
  assert.ok(Math.abs(n - FADE_S * HZ) <= 1, `${n} frames down`);
  close(o, FADE_TO, 1e-12, "floor");
  for (let i = 0; i < 10; i++) o = fadeStep(o, true, 1 / HZ);
  close(o, FADE_TO, 1e-12, "holds");
  n = 0;
  while (o < 1 && n < 100) {
    o = fadeStep(o, false, 1 / HZ);
    n++;
  }
  assert.ok(Math.abs(n - FADE_S * HZ) <= 1, `${n} frames up`);
});

test("the ball's pixels: projectUv is camera.ts's projection from camera F, as a texture coordinate", () => {
  const F = frames[court.video.segments.eases[0].frames[1]];
  const cam = cameraOf(court, F);
  for (const p of [court.freeze.ball.centre, court.seat.pairCentre, [5, 1.8, 0.7] as Vec3]) {
    const px = project(cam, p)!;
    const uv = projectUv(cam, p)!;
    close(uv[0], (px[0] + 0.5) / cam.width, 1e-9, "u");
    close(uv[1], 1 - (px[1] + 0.5) / cam.height, 1e-9, "v");
  }
  const uv = projectUv(cam, court.freeze.ball.centre)!;
  assert.ok(uv[0] > 0 && uv[0] < 1 && uv[1] > 0 && uv[1] < 1, "the ball is in F's frame");
  assert.equal(projectUv(cam, [court.camera.centre[0] - 3, 1, court.camera.centre[2]]), null, "behind the camera");
});

test("bounds (P34): an extra stays in the room only with its feet inside the bounds; no bounds, none stay", () => {
  const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
  assert.ok(inBounds(1, 1, square), "inside");
  assert.ok(!inBounds(3, 1, square), "beyond the side");
  assert.ok(!inBounds(1, -0.01, square), "just past the edge");
  // a room that isn't convex: an L, walked either way round
  const ell: [number, number][] = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  assert.ok(inBounds(0.5, 2.5, ell) && inBounds(2.5, 0.5, ell), "in both legs");
  assert.ok(!inBounds(2, 2, ell), "in the notch");
  assert.ok(inBounds(0.5, 2.5, [...ell].reverse()), "clockwise too");
  assert.ok(!inBounds(1, 1, null), "no bounds: nothing is inside");
  assert.ok(!inBounds(1, 1, [[0, 0], [2, 0]]), "fewer than 3 corners: nothing is inside");
});

test("P17's ball check leans in from the open side: a ball held at the hip, inside the torso's radius, still has room", () => {
  // a held ball as real bodies have it: centre 0.19 m from the torso's axis, the capsule 0.22 m round, at the hip
  const torso = { a: [0, 0.95, 0] as Vec3, b: [0, 1.45, 0] as Vec3, r: 0.22 };
  const head = { a: [0, 1.62, 0] as Vec3, b: [0, 1.72, 0] as Vec3, r: 0.11 };
  const other = { a: [1.1, 0.95, 0.3] as Vec3, b: [1.1, 1.45, 0.3] as Vec3, r: 0.2 };
  const players = [{ capsules: [torso, head] }, { capsules: [other] }];
  const ball = { centre: [0.0, 1.0, 0.19] as Vec3, radius: 0.12 };
  const { eye, gap } = openEye(ball, players, 0.3);
  close(Math.hypot(...eye.map((v: number, i: number) => v - ball.centre[i])), ball.radius + 0.3, 1e-9, "0.3 m from the ball's surface");
  close(gap, Math.min(...[torso, head, other].map((c) => capsuleDistance(eye, c))), 1e-9, "the gap is freeze.ts's own distance");
  assert.ok(gap > FADE_NEAR, `the open side clears every capsule: ${gap.toFixed(3)} m`);
  assert.ok(eye[1] > 0, "above the floor");
  // the old aim (away from the pair's centre, which here runs along his side, 20 deg back toward him) lands 0.176 m
  // from his torso: inside the fade, rightly
  const a = (20 * Math.PI) / 180;
  const side: Vec3 = [ball.centre[0] - 0.42 * Math.cos(a), ball.centre[1], ball.centre[2] - 0.42 * Math.sin(a)];
  close(capsuleDistance(side, torso), 0.176, 2e-3, "the review's 0.176 m");
  assert.ok(nearBody(side, [torso, head]), "along his side the holder fades");
});

test("P34's bounds case comes from court.json, whatever order the people load in: the extra inside one room, beyond the other", () => {
  const extra = court.freeze.others[0];
  assert.ok(extra, "the stand-in has an extra");
  // the extra standing close to either player, with the players and the extras listed in every order
  const order = <T,>(xs: T[], k: number) => xs.map((_, i) => xs[(i + k) % xs.length]);
  for (const near of court.freeze.players) {
    const foot: Vec3 = [near.bounds.max[0] + 0.3, 0, (near.bounds.min[2] + near.bounds.max[2]) / 2];
    for (let k = 0; k < court.freeze.players.length; k++) {
      const c = structuredClone(court);
      c.freeze.others = [{ ...extra, foot }, ...c.freeze.others.slice(1)];
      c.freeze.players = order(c.freeze.players, k);
      const kase = boundsCase(c)!;
      assert.equal(kase.id, extra.id, "the extra by its id");
      assert.ok(inBounds(foot[0], foot[2], kase.inside), `inside: next to ${near.id}, order ${k}`);
      assert.ok(!inBounds(foot[0], foot[2], kase.beyond), `beyond: next to ${near.id}, order ${k}`);
    }
  }
  // the page looks the extra up by id: a shuffled load order finds the same one
  const people = [...court.freeze.players.map((p) => ({ id: p.id, pair: true })), ...court.freeze.others.map((o) => ({ id: o.id, pair: false }))];
  for (let k = 0; k < people.length; k++) assert.equal(order(people, k).find((p) => p.id === boundsCase(court)!.id)?.id, extra.id, `load order ${k}`);
  assert.equal(boundsCase({ ...court, freeze: { ...court.freeze, others: [] } }), null, "no extras, no case");
});
