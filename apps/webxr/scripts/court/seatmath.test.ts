// seatmath.ts: the seat on camera F's ray (P1), the play area set at Seat here, the walking anchoring (the pair's
// centre at the room's centre, its long axis on a diagonal, the chair as spot 0 on the camera's side) with Next view and
// the ring decided from the bounds and the bodies' bounds (P29), the bounds and the edge fade (P35), the lean-in fade
// (P17), and the arrival and seated watches (P27, 3.5). Run on the stand-in and on synthetic pairs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Arrival, BODY_INSET, CHAIR_INSET, EDGE_FADE, PLAY_AREA, PROXIMITY, ProximityFade, RING_INSET, SIDE_MIN, SeatedWatch,
  bodiesInside, boundsDistance, capsuleDistance, clearance, edgeFade, forwardOf, freezeCamera, nextViewWorld, pairAxis,
  placeWorld, placements, playArea, ringFits, ringPoints, roomFrame, seatPoint, toCourt, toRoom, walkingLayout, walkingProblems,
  usableBounds, walkingWorld, yawOf, type ChairPose, type LayoutCase,
} from "../../src/court/seatmath.ts";
import type { Court, ShowFrame, Vec3 } from "../../src/court/format.ts";
import type { Polygon, WorldPose } from "../../src/court/types.ts";
import { standinBundle } from "./standin.mjs";

const close = (a: number, b: number, eps = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);
const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const floorDist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const { court, frames } = standinBundle() as { court: Court; frames: ShowFrame[] };
const camF = freezeCamera(court, frames);

/** An axis-aligned w x d room centred on `at`, turned by `yaw`. */
const rect = (w: number, d: number, yaw = 0, at: [number, number] = [0, 0]): Polygon => {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return ([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as [number, number][]).map(([x, z]) => [at[0] + c * x + s * z, at[1] - s * x + c * z]);
};

/**
 * The stand-in with its pair replaced by two synthetic bodies: `along` m either side of the pair's centre along the
 * camera's line (the first nearer the camera), `across` m either side across it, each footprint depth x width.
 */
function pairOf(along: number, across: number, depth: number, width: number): Court {
  const pc = court.seat.pairCentre;
  const t = [court.camera.centre[0] - pc[0], court.camera.centre[2] - pc[2]];
  const n = Math.hypot(t[0], t[1]);
  const u = [t[0] / n, t[1] / n]; // toward the camera
  const v = [-u[1], u[0]];
  const box = (a: number, b: number) => {
    const c = [pc[0] + u[0] * a + v[0] * b, pc[2] + u[1] * a + v[1] * b];
    const hx = (Math.abs(u[0]) * depth + Math.abs(u[1]) * width) / 2;
    const hz = (Math.abs(u[1]) * depth + Math.abs(u[0]) * width) / 2;
    return { min: [c[0] - hx, 0, c[1] - hz] as Vec3, max: [c[0] + hx, 2.2, c[1] + hz] as Vec3 };
  };
  const players = court.freeze.players.map((p, i) => ({ ...p, bounds: i === 0 ? box(along, across) : box(-along, -across) }));
  return { ...court, freeze: { ...court.freeze, players } };
}

/** The chair in the corner of a play area set at Seat here, and the world the walking anchoring puts there. */
function corner(c: Court, size: [number, number] = PLAY_AREA, yaw = 0.3) {
  const chair = { position: [0.2, 0, -0.4] as Vec3, yaw };
  const bounds = playArea(chair.position, chair.yaw, size);
  return { chair, bounds, world: walkingWorld(c, bounds, chair) };
}

// ---------------- the WorldPose convention ----------------

test("toRoom and toCourt are inverses; a yaw turns headings by exactly that much", () => {
  const w: WorldPose = { position: [1.2, 0, -0.7], yaw: 2.1 };
  for (const p of [[0, 0, 0], [5, 1, -3], [-2, 0.5, 9]] as Vec3[]) {
    const back = toCourt(w, toRoom(w, p));
    p.forEach((v, i) => close(back[i], v, 1e-12));
  }
  for (const h of [0, 1, -2.5, 3]) close(wrap(yawOf(toRoom({ position: [0, 0, 0], yaw: 0.4 }, forwardOf(h))) - (h + 0.4)), 0, 1e-12);
  close(yawOf([0, 0, -1]), 0);
  close(yawOf([-1, 0, 0]), Math.PI / 2);
});

// ---------------- P1: the seat on camera F's ray ----------------

for (const distance of [5, 4, 7])
  test(`P1: the seat's floor point is under camera F's optical ray, ${distance} m from the pair, on the camera's side`, () => {
    const seat = seatPoint(court, camF, distance);
    const pc = court.seat.pairCentre;
    close(floorDist(seat.floor, pc), distance, 1e-9, "D'");
    close(seat.floor[1], 0);
    // on the ray's floor projection: the ray point above it is within 0.10 m (P1) - here exactly on it
    const c = camF.centre;
    const axis = seat.forward;
    const t = (seat.floor[0] - c[0]) * axis[0] + (seat.floor[2] - c[2]) * axis[2];
    const onRay = [c[0] + axis[0] * t, c[2] + axis[2] * t];
    close(Math.hypot(onRay[0] - seat.floor[0], onRay[1] - seat.floor[2]), 0, 1e-9, "off the ray");
    assert.ok((pc[0] - seat.floor[0]) * axis[0] + (pc[2] - seat.floor[2]) * axis[2] > 0, "the pair is ahead");
    close(Math.hypot(axis[0], axis[2]), 1, 1e-12);
    close(axis[1], 0);
  });

test("P1: Seat here puts the seat's floor point under the head and F's view along the head's yaw (any yaw)", () => {
  const seat = seatPoint(court, camF, 5);
  for (const yaw of [0, 0.7, -2.9, Math.PI]) {
    const head: Vec3 = [0.4, 1.15, -1.3];
    const w = placeWorld(seat, head, yaw);
    const under = toRoom(w, seat.floor);
    assert.ok(floorDist(under, head) <= 0.1, "floor point within 0.10 m");
    close(floorDist(under, head), 0, 1e-9);
    close(under[1], 0, 1e-12, "court floor on the room floor");
    const err = deg(Math.abs(wrap(yawOf(toRoom({ position: [0, 0, 0], yaw: w.yaw }, seat.forward)) - yaw)));
    assert.ok(err <= 0.5, `yaw error ${err} deg`);
    close(err, 0, 1e-9);
  }
});

// ---------------- the floor ----------------

test("the default play area is 3.5 x 3.5 m with the chair in a corner, 0.6 m from both walls, facing the far corner", () => {
  const chair: Vec3 = [0.3, 0, -0.2];
  const yaw = 0.8;
  const area = playArea(chair, yaw);
  assert.equal(area.length, 4);
  const side = (i: number) => Math.hypot(area[(i + 1) % 4][0] - area[i][0], area[(i + 1) % 4][1] - area[i][1]);
  [0, 1, 2, 3].forEach((i) => close(side(i), PLAY_AREA[0], 1e-9, `side ${i}`));
  close(boundsDistance(area, chair), CHAIR_INSET, 1e-9, "0.6 m from the nearest wall");
  // 0.6 m from two walls: a step back along either wall's normal is 0.6 m too
  const f = forwardOf(yaw);
  const far = [chair[0] + f[0] * (PLAY_AREA[0] - CHAIR_INSET) * Math.SQRT2, 0, chair[2] + f[2] * (PLAY_AREA[0] - CHAIR_INSET) * Math.SQRT2] as Vec3;
  close(Math.min(...area.map((c) => Math.hypot(c[0] - far[0], c[1] - far[2]))), 0, 1e-9, "facing the far corner");
  close(boundsDistance(area, [chair[0] - f[0] * 0.6 * Math.SQRT2, 0, chair[2] - f[2] * 0.6 * Math.SQRT2]), 0, 1e-9, "the corner behind");
});


// ---------------- P29: the walking anchoring ----------------

test("the pair's axis runs from the body nearest the camera through the other; its centre is the middle of the pair's extent", () => {
  const c = pairOf(0.9, 0.3, 0.4, 0.5);
  const a = pairAxis(c);
  const near = c.freeze.players[0].bounds;
  const far = c.freeze.players[1].bounds;
  const mid = (b: { min: Vec3; max: Vec3 }): Vec3 => [(b.min[0] + b.max[0]) / 2, 0, (b.min[2] + b.max[2]) / 2];
  const d = [mid(far)[0] - mid(near)[0], mid(far)[2] - mid(near)[2]];
  close(a.dir[0] * d[1] - a.dir[2] * d[0], 0, 1e-9, "along the line through both bodies");
  assert.ok(a.dir[0] * d[0] + a.dir[2] * d[1] > 0, "away from the camera");
  close(floorDist(a.centre, c.seat.pairCentre), 0, 1e-9, "a symmetric pair centres on its middle");
  // one body: the camera's ray through it
  const alone: Court = { ...c, freeze: { ...c.freeze, players: [c.freeze.players[0]] } };
  const b = pairAxis(alone);
  const toCam = [c.camera.centre[0] - b.centre[0], c.camera.centre[2] - b.centre[2]];
  assert.ok(Math.abs(b.dir[0] * toCam[1] - b.dir[2] * toCam[0]) / Math.hypot(...toCam) < 0.2);
});

test("roomFrame finds a turned rectangle's centre, axes and size exactly", () => {
  const f = roomFrame(rect(3.5, 5, 0.7, [1, -2]));
  close(f.centre[0], 1, 1e-9);
  close(f.centre[2], -2, 1e-9);
  assert.deepEqual([...f.half].map((x) => Number(x.toFixed(9))).sort(), [1.75, 2.5]);
});

for (const [name, c] of [["the stand-in", court], ["a pair side by side", pairOf(0.15, 0.55, 0.4, 0.5)], ["a pair 1.8 m deep", pairOf(0.65, 0.15, 0.45, 0.6)]] as const)
  test(`P29 (${name}): at 3.5 x 3.5 m the pair's centre is the room's centre, its axis on the diagonal away from the chair, the chair on the camera's side 1 m clear, both bodies 0.3 m inside`, () => {
    for (const yaw of [0.3, -2.2]) {
      const { chair, bounds, world } = corner(c, PLAY_AREA, yaw);
      const room = roomFrame(bounds);
      const a = pairAxis(c);
      const centre = toRoom(world, a.centre);
      close(floorDist(centre, room.centre), 0, 1e-9, "centred");
      // the axis on a diagonal: 45 deg off the room's sides on a square, and that diagonal's line misses the chair by ~1.6 m
      const dir = toRoom({ position: [0, 0, 0], yaw: world.yaw }, a.dir);
      const offSide = deg(Math.abs(wrap(Math.atan2(dir[2], dir[0]) - Math.atan2(room.u[2], room.u[0])))) % 90;
      close(offSide, 45, 1e-6, "on a diagonal");
      const fromLine = Math.abs(dir[0] * (chair.position[2] - room.centre[2]) - dir[2] * (chair.position[0] - room.centre[0]));
      close(fromLine, (Math.SQRT2 * PLAY_AREA[0]) / 2 - Math.SQRT2 * CHAIR_INSET, 1e-6, "the other diagonal's corner");
      const chairCourt = toCourt(world, chair.position);
      const cam = c.camera.centre;
      const side = (p: Vec3) => a.dir[0] * (p[2] - a.centre[2]) - a.dir[2] * (p[0] - a.centre[0]);
      assert.ok(Math.sign(side(chairCourt)) === Math.sign(side(cam)) && Math.abs(side(chairCourt)) >= SIDE_MIN, "the camera's side");
      assert.ok(clearance(c, chairCourt) >= c.seat.clear, `chair ${clearance(c, chairCourt)} m from the nearer body`);
      for (const d of bodiesInside(c, world, bounds)) assert.ok(d >= BODY_INSET, `a body ${d} m inside`);
      assert.deepEqual(walkingProblems(c, bounds, chair), []);
    }
  });

test("P29: at 3.5 x 3.5 m Next view hides (the only other placement shows the far side or looks down the pair's axis)", () => {
  for (const c of [court, pairOf(0.15, 0.55, 0.4, 0.5), pairOf(0.65, 0.15, 0.45, 0.6)]) {
    const { chair, bounds, world } = corner(c);
    assert.equal(nextViewWorld(c, bounds, chair, world), null);
    const all = placements(c, bounds, chair);
    assert.equal(all.filter((p) => p.passes).length, 1);
    assert.ok(all.filter((p) => !p.passes).every((p) => !p.cameraSide), "every other placement puts the chair on the far side or on the axis");
  }
});

test("P29: Next view where a second placement passes (the chair mid-side of a 4.8 m room), cycling back to the first", () => {
  const bounds = rect(4.8, 4.8);
  const chair = { position: [0, 0, 1.8] as Vec3, yaw: 0 };
  const first = walkingWorld(court, bounds, chair);
  const second = nextViewWorld(court, bounds, chair, first);
  assert.ok(second, "a second placement");
  const p = placements(court, bounds, chair).find((x) => Math.abs(wrap(x.world.yaw - second!.yaw)) < 1e-9)!;
  assert.ok(p.passes && p.cameraSide && p.clearance >= court.seat.clear && Math.min(...p.inside) >= BODY_INSET);
  const back = nextViewWorld(court, bounds, chair, second!)!;
  close(wrap(back.yaw - first.yaw), 0, 1e-9, "back to the first");
  assert.equal(ringFits(court, bounds), false, "and the ring doesn't fit here, so Next view applies");
});

test("P29: a pair too long for the floor reports the overflow (not a failure): the placement still comes back", () => {
  const deep = pairOf(1.9, 0.2, 0.5, 0.7);
  const { chair, bounds, world } = corner(deep);
  const problems = walkingProblems(deep, bounds, chair);
  assert.ok(problems.some((l) => /inside the bounds/.test(l)), problems.join("; "));
  assert.ok(problems.some((l) => /past them, clipped in See my room/.test(l)), problems.join("; "));
  close(floorDist(toRoom(world, pairAxis(deep).centre), roomFrame(bounds).centre), 0, 1e-9, "still centred");
  const small = corner(court, [3, 3]);
  assert.match(walkingProblems(court, small.bounds, small.chair).join("; "), /from the nearer body/);
});

/** A synthetic pair whose bounds span exactly `span` m along the pair axis (near body's front to far body's back). */
function spanPair(span: number): Court {
  let lo = 0;
  let hi = span;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (2 * pairAxis(pairOf(mid, 0.3, 0.5, 0.6)).half[0] < span) lo = mid;
    else hi = mid;
  }
  return pairOf(lo, 0.3, 0.5, 0.6);
}

/** Synthetic pairs: the stand-in's, and two long ones. */
const PAIRS: [string, Court][] = [["the stand-in pair", court], ["a 2.6 m pair", spanPair(2.6)], ["a 3.2 m pair", spanPair(3.2)]];
/** What each floor holds with the chair in a corner (3.5, 5, 7 m): the richest layout that fits. */
const WANT: Record<string, LayoutCase[]> = {
  "the stand-in pair": ["one-view", "ring", "ring"],
  "a 2.6 m pair": ["one-view", "one-view", "ring"],
  "a 3.2 m pair": ["one-view", "one-view", "ring"],
};

for (const [name, c] of PAIRS)
  test(`P29 (${name}) on 3.5, 5 and 7 m floors: the richest layout that fits, and every offered view clears (1 m from the chair, bodies 0.3 m inside)`, () => {
    [3.5, 5, 7].forEach((size, k) => {
      const { chair, bounds } = corner(c, [size, size]);
      const l = walkingLayout(c, bounds, chair);
      if (c !== court) assert.ok(Math.abs(2 * pairAxis(c).half[0] - Number.parseFloat(name.slice(2))) < 1e-6);
      assert.equal(l.case, WANT[name][k], `${size} m: ${l.case} (${l.why})`);
      for (const p of l.offered) {
        assert.ok(p.passes && p.clearance >= c.seat.clear - 1e-9 && Math.min(...p.inside) >= BODY_INSET - 1e-9, `${size} m: an offered view fails`);
      }
      // the richest that fits: a ring only when it fits, views only with two passing placements, overflow only with none
      const passing = placements(c, bounds, chair).filter((p) => p.passes).length;
      assert.equal(l.case === "ring", ringFits(c, bounds));
      if (l.case !== "ring") assert.equal(l.case, passing >= 2 ? "views" : passing === 1 ? "one-view" : "overflow");
      assert.ok(l.why.length > 0);
      assert.equal(nextViewWorld(c, bounds, chair, l.first.world) !== null, l.case === "views"); // Next view only between offered views
    });
  });

test("P29: \"views\" where a second placement passes (the chair mid-side of a 4.8 m room); \"overflow\" offers nothing and says why", () => {
  const views = walkingLayout(court, rect(4.8, 4.8), { position: [0, 0, 1.8], yaw: 0 });
  assert.equal(views.case, "views");
  assert.equal(views.offered.length, 2);
  const deep = pairOf(1.9, 0.2, 0.5, 0.7);
  const { chair, bounds } = corner(deep);
  const over = walkingLayout(deep, bounds, chair);
  assert.equal(over.case, "overflow");
  assert.deepEqual(over.offered, []);
  assert.match(over.why, /past them, clipped in See my room/);
});

/** The least boundsDistance over a dense grid of every body's footprint (room space) at `world`: the truth bodiesInside must never beat. */
const footprintTruth = (c: Court, world: WorldPose, bounds: Polygon, n = 24) =>
  c.freeze.players.map(({ bounds: b }) => {
    let least = Infinity;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) {
        const p: Vec3 = [b.min[0] + ((b.max[0] - b.min[0]) * i) / n, 0, b.min[2] + ((b.max[2] - b.min[2]) * j) / n];
        least = Math.min(least, boundsDistance(bounds, toRoom(world, p)));
      }
    return least;
  });

/** Two 1.2 m footprints 1.8 m apart (synthetic), as in the concave-room cases. */
const squares = (() => {
  const c = structuredClone(court) as Court;
  c.freeze.players.forEach((p, i) => (p.bounds = { min: [i * 1.8 - 0.6, 0, -0.6], max: [i * 1.8 + 0.6, 2, 0.6] }));
  return c;
})();
const notched = (x: number, end: number): Polygon => [[-3, -3], [3, -3], [3, 3], [x + 0.1, 3], [x + 0.1, end], [x - 0.1, end], [x - 0.1, 3], [-3, 3]];

test("P29 in a concave room: a body crossing a notch in the bounds never passes (the whole footprint, not its corners)", () => {
  const chair: ChairPose = { position: [-2, 0, -2], yaw: 0 };
  // the notch pokes 2 m into the room between the corners of one footprint
  const b = notched(-1.15, 0.85);
  for (const p of placements(squares, b, chair)) {
    const truth = footprintTruth(squares, p.world, b);
    // inside: never more than the truth; past the boundary: 0 or less (how far past is for the report)
    p.inside.forEach((d, i) => assert.ok(truth[i] < 0 ? d <= 0 : d <= truth[i] + 1e-9, `body ${i}: ${d} m inside, but a point of it is ${truth[i]} m`));
  }
  // every notch across the room: what is offered really stands 0.3 m inside
  for (let x = -1.5; x < 1.5; x += 0.15)
    for (let end = -1.5; end < 1.5; end += 0.15) {
      const bounds = notched(x, end);
      for (const p of walkingLayout(squares, bounds, chair).offered)
        footprintTruth(squares, p.world, bounds).forEach((d, i) => assert.ok(d >= BODY_INSET - 1e-6, `notch at ${x.toFixed(2)}, ${end.toFixed(2)}: body ${i} offered at ${d.toFixed(3)} m inside`));
    }
});

test("P29: the chair must stand 0.3 m inside the bounds for any view to be offered", () => {
  for (const at of [[0, 0, 2.3], [0, 0, 5]] as Vec3[]) {
    const l = walkingLayout(court, rect(4.8, 4.8), { position: at, yaw: 0 });
    assert.equal(l.case, "overflow", `chair at ${at}: ${l.case}`);
    assert.deepEqual(l.offered, []);
    assert.match(l.why, /the chair is -?[0-9.]+ m inside the bounds/);
  }
  for (const p of walkingLayout(court, rect(4.8, 4.8), { position: [0, 0, 1.8], yaw: 0 }).offered) assert.ok(p.chairInside >= BODY_INSET);
});

test("P29: empty, coincident or flat bounds give \"overflow\" (no usable bounds), never a throw", () => {
  const chair: ChairPose = { position: [0, 0, 0], yaw: 0 };
  for (const b of [[], [[0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [2, 0]], [[0, 0], [1, 0]]] as Polygon[]) {
    const l = walkingLayout(court, b, chair);
    assert.equal(l.case, "overflow");
    assert.equal(l.why, "no usable bounds");
    assert.equal(l.first, null);
    assert.deepEqual(l.offered, []);
    assert.equal(walkingWorld(court, b, chair), null);
    assert.equal(ringFits(court, b), false);
    assert.equal(nextViewWorld(court, b, chair, { position: [0, 0, 0], yaw: 0 }), null);
    assert.deepEqual(walkingProblems(court, b, chair), ["no usable bounds"]);
    assert.equal(usableBounds(b), false);
  }
  assert.equal(usableBounds(rect(3.5, 3.5)), true);
});

test("the ring turns on from the bounds and the bodies alone: every point 1 m clear of both bodies and 0.7 m inside", () => {
  assert.equal(ringFits(court, rect(3.5, 3.5)), false);
  assert.equal(ringFits(court, rect(8, 8, 0.4, [3, 1])), true);
  const deep = pairOf(1.1, 0.2, 0.5, 0.7);
  assert.equal(ringFits(court, rect(5.5, 5.5)), true);
  assert.equal(ringFits(deep, rect(5.5, 5.5)), false, "a deeper pair needs a bigger room");
  for (const c of [court, deep]) {
    const bounds = rect(9, 9);
    const chair = { position: [0, 0, 3.9] as Vec3, yaw: 0 };
    const w = walkingWorld(c, bounds, chair);
    const ring = ringPoints(c, bounds, w);
    assert.equal(ring.length, 17);
    for (const p of ring) {
      assert.ok(clearance(c, p) >= c.seat.clear - 1e-9);
      assert.ok(boundsDistance(bounds, toRoom(w, p)) >= RING_INSET - 1e-9);
    }
  }
  const small = corner(court);
  assert.deepEqual(ringPoints(court, small.bounds, small.world), []);
});

// ---------------- P35: bounds distance and the edge fade ----------------

test("boundsDistance is exact: positive inside, 0 on an edge, negative outside, concave polygons too", () => {
  const sq = rect(4, 4);
  close(boundsDistance(sq, [0, 1.6, 0]), 2);
  close(boundsDistance(sq, [1.5, 0, 0.2]), 0.5);
  close(boundsDistance(sq, [2, 0, 0]), 0);
  close(boundsDistance(sq, [3, 0, 0]), -1);
  close(boundsDistance(sq, [3, 0, 3]), -Math.SQRT2);
  const L: Polygon = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
  close(boundsDistance(L, [1, 0, 1]), 1);
  close(boundsDistance(L, [4, 0, 4]), -2);
  close(boundsDistance(L, [3, 0, 1.5]), 0.5);
});

test("P35: the room starts to open 0.6 m from the bounds and is fully open at 0.3 m", () => {
  close(edgeFade(EDGE_FADE[0]), 0);
  close(edgeFade(2), 0);
  close(edgeFade(EDGE_FADE[1]), 1);
  close(edgeFade(0), 1);
  close(edgeFade(-1), 1);
  close(edgeFade(0.45), 0.5);
  let last = -1;
  for (let d = 0.7; d >= 0.2; d -= 0.01) {
    assert.ok(edgeFade(d) >= last);
    last = edgeFade(d);
  }
});

// ---------------- P17: lean in ----------------

test("P17: the eye 0.2 m from a torso or head capsule fades that player to 30% within 300 ms; the ball and hands never", () => {
  const players = court.freeze.players;
  const torso = players[0].capsules[0];
  close(capsuleDistance([torso.a[0], (torso.a[1] + torso.b[1]) / 2, torso.a[2] + torso.r + 0.2], torso), 0.2, 1e-9);
  const fade = new ProximityFade(players);
  const eye: Vec3 = [torso.a[0] - torso.r - 0.19, (torso.a[1] + torso.b[1]) / 2, torso.a[2]];
  let t = 0;
  while (fade.opacity[0] > PROXIMITY.opacity + 1e-9 && t < 1) {
    fade.update(eye, 1 / 72);
    t += 1 / 72;
  }
  assert.ok(t <= PROXIMITY.seconds + 1e-9, `faded in ${t} s`);
  close(fade.opacity[0], PROXIMITY.opacity);
  // the other player is untouched
  close(fade.opacity[1], 1);
  // the eye 0.3 m from the ball (on its open side) and by the hands: no fade
  const ball = court.freeze.ball.centre;
  const axisPoint = [torso.a[0], ball[1], torso.a[2]];
  const away = [ball[0] - axisPoint[0], 0, ball[2] - axisPoint[2]];
  const n = Math.hypot(away[0], away[2]);
  const byBall: Vec3 = [ball[0] + (away[0] / n) * 0.3, ball[1], ball[2] + (away[2] / n) * 0.3];
  const fresh = new ProximityFade(players);
  for (let i = 0; i < 72; i++) fresh.update(byBall, 1 / 72);
  assert.deepEqual(fresh.opacity, [1, 1]);
  // and back to full once the eye leaves
  for (let i = 0; i < 72; i++) fade.update([0, 1.6, 0], 1 / 72);
  close(fade.opacity[0], 1);
});

// ---------------- P27: the arrival; 3.5: seated again ----------------

test("P27: black until a hand-over (not visible -> visible), then a seated head still for 1 s starts the lights-up", () => {
  const seat: Vec3 = [0, 0, 0];
  const a = new Arrival();
  a.seatHere(seat, 1.15);
  const dt = 1 / 72;
  const run = (head: Vec3, s: number) => {
    for (let t = 0; t < s; t += dt) if (a.update(dt, head)) return t;
    return null;
  };
  // the presenter sitting still after Seat here: nothing (no hand-over yet)
  assert.equal(run([0.02, 1.15, 0.05], 3), null);
  a.visibility("visible-blurred");
  assert.equal(run([0.02, 1.15, 0.05], 2), null, "while blurred");
  a.visibility("hidden");
  a.visibility("visible");
  // standing, or moving: still black
  assert.equal(run([0.05, 1.6, 0.1], 2), null, "standing");
  let moving = null;
  for (let t = 0; t < 2 && moving === null; t += dt) moving = a.update(dt, [0.1 * Math.sin(t * 6), 1.15, 0]) ? t : null;
  assert.equal(moving, null, "moving");
  assert.equal(run([0.6, 1.15, 0], 2), null, "away from the chair");
  // seated and still: within 1.1 s
  const at = run([0.04, 1.12, 0.06], 2);
  assert.ok(at !== null && at <= 1.1, `lights-up after ${at} s`);
  assert.equal(a.ready, true);
  // latched
  assert.equal(a.update(dt, [3, 1.8, 3]), true);
  // a new Seat here waits for a new hand-over
  a.seatHere(seat, 1.15);
  assert.equal(run([0.04, 1.12, 0.06], 2), null);
});

test("P27: a sway is not still (10 cm side to side, periods 1-4 s): it waits, however long each swing dwells near its end", () => {
  for (const period of [1, 2.1, 4]) {
    const a = new Arrival();
    a.seatHere([0, 0, 0], 1.15);
    a.visibility("hidden");
    a.visibility("visible");
    let at: number | null = null;
    for (let i = 0; i < 6 * 72 && at === null; i++) if (a.update(1 / 72, [0.1 * Math.sin((2 * Math.PI * i) / 72 / period), 1.15, 0])) at = i / 72;
    assert.equal(at, null, `${period} s sway lit up after ${at} s`);
  }
});

test("P27: a head that stops mid-sway lights up 1 s after it stops (no filter lag: P27 allows 1.1 s)", () => {
  for (const stopAt of [0.5, 0.9, 1.3]) {
    const a = new Arrival();
    a.seatHere([0, 0, 0], 1.15);
    a.visibility("hidden");
    a.visibility("visible");
    const dt = 1 / 72;
    const x = (t: number) => 0.1 * Math.sin(3 * Math.min(t, stopAt)); // 0.3 m/s side to side, then still
    let at: number | null = null;
    for (let i = 0; i < 4 * 72 && at === null; i++) if (a.update(dt, [x(i * dt), 1.15, 0])) at = i * dt;
    assert.ok(at !== null && at - stopAt <= 1.0 + dt + 1e-9, `stopped at ${stopAt} s, lit at ${at} s`);
  }
});

test("P27: tracking jitter (a few mm a frame) still counts as still", () => {
  const a = new Arrival();
  a.seatHere([0, 0, 0], 1.15);
  a.visibility("hidden");
  a.visibility("visible");
  let at: number | null = null;
  for (let i = 0; i < 200 && at === null; i++) if (a.update(1 / 72, [0.003 * Math.sin(i * 2.3), 1.13 + 0.003 * Math.cos(i * 1.7), 0.002 * (i % 2)])) at = i / 72;
  assert.ok(at !== null && at <= 1.1, `${at}`);
});

test("3.5: seated again means within 0.35 m of the seat, 0.25 m lower than standing, still for 0.5 s", () => {
  const w = new SeatedWatch();
  w.reset([0, 0, 0]);
  const dt = 1 / 72;
  const run = (head: Vec3, s: number) => {
    let at: number | null = null;
    for (let t = 0; t < s && at === null; t += dt) if (w.update(dt, head)) at = t;
    return at;
  };
  assert.equal(run([1.5, 1.7, 0.5], 1), null, "standing by the pair");
  assert.equal(run([0.1, 1.7, 0.1], 1), null, "standing at the chair");
  assert.equal(run([0.6, 1.2, 0], 1), null, "low but not at the chair");
  const at = run([0.1, 1.2, 0.1], 1.5);
  assert.ok(at !== null && at >= 0.5 - 1e-9 && at <= 0.55, `${at}`);
});
