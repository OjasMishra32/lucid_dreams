// The seat maths (Decision W, 3.1, 3.4, 3.5), pure. Two anchorings: for the watch and the hand-off, the seat on camera
// F's optical ray at D' from the pair (`?seat=` 4-7 m), the court placed so that seat is under the head and F's view is
// forward; once the world is open (Walk closer, standing up or Next view), the walking anchoring: the pair's centre at
// the room's centre and its long axis (the line through both bodies) on one room diagonal, turned so the chair (in the
// other diagonal's corner, 0.6 m from both walls, facing the centre) is on the camera's side and is spot 0; Next view
// only where a second placement fits; the automatic ring when the bounds hold it (every ring point >= `seat.clear`
// from both bodies and >= 0.7 m inside the bounds). All of it from the bounds and the bodies' bounds: the bundle stores
// no spots. Also the play area set at Seat here (default 3.5 x 3.5 m), distance to the bounds and the edge fade (P35),
// clearance (P29), the lean-in fade (P17), the arrival (P27) and the sit (3.5). DOM-free and three-free:
// seatmath.test.ts imports it under node (type-only imports). Stream C (`core`).
// Conventions: court space as format.ts; room space is the XR reference space (local-floor, y = 0 on the floor); a
// WorldPose maps court to room as three.js builds `rotation.y = yaw` (types.ts). A yaw is a heading: 0 looks toward
// -Z, counterclockwise positive, so a direction at yaw h is (-sin h, 0, -cos h).
import type { PinholeCamera } from "./camera";
import type { Capsule, Court, FreezePlayer, ShowFrame, Vec3 } from "./format";
import type { Polygon, WorldPose } from "./types";

/** True once stream C has built this module. */
export const BUILT = true;

/** The default floor (Ojasva, binding): 3.5 x 3.5 m. */
export const PLAY_AREA: [number, number] = [3.5, 3.5];
/** The chair sits this far from both walls of its corner. */
export const CHAIR_INSET = 0.6;
/** Both bodies stay at least this far inside the play area at every viewing spot. */
export const BODY_INSET = 0.3;
/** The room starts to open this far from the bounds and is fully open at the second distance, metres (P35). */
export const EDGE_FADE: [number, number] = [0.6, 0.3];
/** Standing up: the head rises this much above its seated height, metres. */
export const STAND_RISE = 0.25;
/** Seated again (Back to my seat): head within `radius` of the seat, `drop` lower than standing, still for `stillS`. */
export const SEATED = { radius: 0.35, drop: 0.25, stillS: 0.5 };
/** Every ring walk target keeps this far inside the bounds, metres. */
export const RING_INSET = 0.7;
/** A chair nearer the pair's axis line than this sees it end-on (one body hides the other): not a placement. */
export const SIDE_MIN = 0.3;
/** Lean in (P17): the eye this close to a torso or head capsule fades that player to `opacity` over `seconds` (within 300 ms). */
export const PROXIMITY = { distance: 0.2, opacity: 0.3, seconds: 0.25 };
/** The arrival (P27): a seated head still this long starts the lights-up. */
export const ARRIVAL_STILL_S = 1.0;
/** "Still": every head position over the time counted fits a box this big (its diagonal, metres). Quest tracking jitter
 * is a few mm; a 10 cm sway with a period up to ~4.5 s covers more than this in any second, even round the end of a swing. */
export const STILL_RANGE = 0.025;
/** The longest stillness measured, seconds (enough for every caller's wait). */
const STILL_SPAN_S = 2;
/** Head samples kept for it (2 s at up to 120 Hz). */
const STILL_SAMPLES = 256;
/** A head lower than this is not a seated person (a headset left on the chair), metres. */
const MIN_EYE = 0.6;

// ---------------- the WorldPose convention ----------------

/** v turned by `yaw` about +Y, as three.js's rotation.y does (x' = x cos + z sin, z' = -x sin + z cos). */
export function rotY(yaw: number, v: Vec3): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

/**
 * A court point in room space: room = R_y(yaw) court + position, R_y as three.js builds it for `rotation.y = yaw`
 * (x' = x cos + z sin, z' = -x sin + z cos). So the world group's transform is exactly the WorldPose.
 */
export function toRoom(world: WorldPose, p: Vec3): Vec3 {
  const r = rotY(world.yaw, p);
  return [r[0] + world.position[0], r[1] + world.position[1], r[2] + world.position[2]];
}

/** A room point in court space (the inverse of toRoom). */
export function toCourt(world: WorldPose, p: Vec3): Vec3 {
  return rotY(-world.yaw, [p[0] - world.position[0], p[1] - world.position[1], p[2] - world.position[2]]);
}

/** The floor direction a yaw looks along (unit, y = 0). */
export function forwardOf(yaw: number): Vec3 {
  return [-Math.sin(yaw), 0, -Math.cos(yaw)];
}

/** The yaw (heading) of a direction along the floor. */
export function yawOf(dir: Vec3): number {
  return Math.atan2(-dir[0], -dir[2]);
}

const flatDist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

// ---------------- the watch anchoring: the seat on camera F's ray (P1) ----------------

/** The seat: its floor point (court space) and F's view direction along the floor (unit, y = 0). */
export interface SeatSpot {
  floor: Vec3;
  forward: Vec3;
}

/** Camera F: the camera of the show frame that is F (every ease ends on it, frames.json carries its own camera). */
export function freezeCamera(court: Court, frames: readonly ShowFrame[]): PinholeCamera {
  const f = frames[court.video.segments.eases[0].frames[1]];
  const c = court.camera;
  return { centre: [...c.centre], q: [...f.q], f: f.f, cx: c.cx, cy: c.cy, width: c.width, height: c.height };
}

/** The seat (court space): its floor point under camera F's optical ray, `distance` m from the pair's centre on the camera's side, and F's view direction along the floor (unit, y = 0). */
export function seatPoint(court: Court, camF: PinholeCamera, distance: number): SeatSpot {
  const [x, y, z, w] = camF.q;
  // the optical axis: the camera's +z turned by q (only its floor part is needed)
  const ax = 2 * (x * z + w * y);
  const az = 1 - 2 * (x * x + y * y);
  const n = Math.hypot(ax, az);
  if (n < 1e-6) throw new Error("seatPoint: camera F looks straight up or down");
  const d: Vec3 = [ax / n, 0, az / n];
  const pc = court.seat.pairCentre;
  const ox = camF.centre[0] - pc[0];
  const oz = camF.centre[2] - pc[2];
  // |C + t d - pc| = distance along the floor; the smaller root is on the camera's side of the pair
  const b = ox * d[0] + oz * d[2];
  const disc = b * b - (ox * ox + oz * oz - distance * distance);
  if (disc < 0) throw new Error(`seatPoint: camera F's ray passes more than ${distance} m from the pair's centre`);
  const t = -b - Math.sqrt(disc);
  return { floor: [camF.centre[0] + t * d[0], 0, camF.centre[2] + t * d[2]], forward: d };
}

/** The world pose that puts the seat's floor point under the head (room space) and F's direction along `headYaw`. */
export function placeWorld(seat: SeatSpot, head: Vec3, headYaw: number): WorldPose {
  const yaw = headYaw - yawOf(seat.forward);
  const r = rotY(yaw, seat.floor);
  return { position: [head[0] - r[0], 0, head[2] - r[2]], yaw };
}

// ---------------- the floor ----------------

/** Where the judge sat at Seat here: the chair's floor point (room space) and the way it faces. */
export interface ChairPose {
  position: Vec3;
  yaw: number;
}

/** The play area set at Seat here (room space): `size`, the chair in a corner `inset` from both walls, facing the far corner. */
export function playArea(chair: Vec3, yaw: number, size: [number, number] = PLAY_AREA, inset = CHAIR_INSET): Polygon {
  const a = forwardOf(yaw + Math.PI / 4);
  const b = forwardOf(yaw - Math.PI / 4);
  const k = [chair[0] - inset * (a[0] + b[0]), chair[2] - inset * (a[2] + b[2])];
  return [
    [k[0], k[1]],
    [k[0] + size[0] * a[0], k[1] + size[0] * a[2]],
    [k[0] + size[0] * a[0] + size[1] * b[0], k[1] + size[0] * a[2] + size[1] * b[2]],
    [k[0] + size[1] * b[0], k[1] + size[1] * b[2]],
  ];
}

/** Distance from a room point to the nearest edge of the bounds, metres along the floor (negative outside). */
export function boundsDistance(bounds: Polygon, point: Vec3): number {
  const px = point[0];
  const pz = point[2];
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = bounds.length - 1; i < bounds.length; j = i++) {
    const [ax, az] = bounds[j];
    const [bx, bz] = bounds[i];
    if (bz > pz !== az > pz && px < ((ax - bx) * (pz - bz)) / (az - bz) + bx) inside = !inside;
    const ex = bx - ax;
    const ez = bz - az;
    const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(px - (ax + t * ex), pz - (az + t * ez)));
  }
  return inside ? best : -best;
}

/** The edge fade (P35): 0 = the arena, 1 = the room fully open; smooth from EDGE_FADE[0] in to EDGE_FADE[1]. */
export function edgeFade(distance: number): number {
  return smooth((EDGE_FADE[0] - distance) / (EDGE_FADE[0] - EDGE_FADE[1]));
}

/** Metres from a court point (on the floor) to the nearest body's bounds (P29's clearance; 0 inside one). */
export function clearance(court: Court, point: Vec3): number {
  let best = Infinity;
  for (const { bounds: b } of court.freeze.players) {
    const dx = Math.max(b.min[0] - point[0], 0, point[0] - b.max[0]);
    const dz = Math.max(b.min[2] - point[2], 0, point[2] - b.max[2]);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/** Bounds smaller than this hold nobody, square metres (an empty, coincident or flat polygon: no room to lay out). */
const MIN_BOUNDS_AREA = 0.5;

/** True when the bounds are a floor at all: three or more corners enclosing at least MIN_BOUNDS_AREA. */
export function usableBounds(bounds: Polygon): boolean {
  if (bounds.length < 3) return false;
  let twice = 0;
  for (let i = 0, j = bounds.length - 1; i < bounds.length; j = i++) twice += bounds[j][0] * bounds[i][1] - bounds[i][0] * bounds[j][1];
  return Math.abs(twice) / 2 >= MIN_BOUNDS_AREA;
}

/** 2D cross product of (b - a) and (c - a). */
const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

/** Distance from point p to segment ab, on the floor. */
function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(px - (ax + t * ex), pz - (az + t * ez));
}

/**
 * How far a floor box (court space, placed by `world`) stands inside the bounds: when the whole box is inside (its
 * corners in, no boundary edge crossing it, no boundary corner in it) the least distance from the box to any boundary
 * edge; otherwise 0 or less, by the deepest of a grid of its points past the boundary. Concave rooms included: a notch
 * that pokes between a box's corners counts.
 */
function footprintInside(bounds: Polygon, world: WorldPose, min: Vec3, max: Vec3): number {
  const q = [toRoom(world, [min[0], 0, min[2]]), toRoom(world, [max[0], 0, min[2]]), toRoom(world, [max[0], 0, max[2]]), toRoom(world, [min[0], 0, max[2]])];
  const turn = Math.sign(cross(q[0][0], q[0][2], q[1][0], q[1][2], q[2][0], q[2][2])) || 1;
  let crossed = q.some((c) => boundsDistance(bounds, c) <= 0);
  let least = Infinity;
  for (let i = 0, j = bounds.length - 1; i < bounds.length && !crossed; j = i++) {
    const [ax, az] = bounds[j];
    const [bx, bz] = bounds[i];
    // a boundary corner inside the box
    if (q.every((c, k) => turn * cross(c[0], c[2], q[(k + 1) % 4][0], q[(k + 1) % 4][2], bx, bz) > 0)) crossed = true;
    for (let k = 0; k < 4 && !crossed; k++) {
      const [cx, , cz] = q[k];
      const [dx, , dz] = q[(k + 1) % 4];
      // a boundary edge crossing a box edge
      const s1 = cross(ax, az, bx, bz, cx, cz);
      const s2 = cross(ax, az, bx, bz, dx, dz);
      const s3 = cross(cx, cz, dx, dz, ax, az);
      const s4 = cross(cx, cz, dx, dz, bx, bz);
      if (s1 * s2 < 0 && s3 * s4 < 0) crossed = true;
      least = Math.min(least, segmentDistance(ax, az, cx, cz, dx, dz), segmentDistance(bx, bz, cx, cz, dx, dz), segmentDistance(cx, cz, ax, az, bx, bz));
    }
  }
  if (!crossed) return least;
  let deepest = 0;
  const n = 12;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      const p = toRoom(world, [min[0] + ((max[0] - min[0]) * i) / n, 0, min[2] + ((max[2] - min[2]) * j) / n]);
      deepest = Math.min(deepest, boundsDistance(bounds, p));
    }
  return deepest;
}

/** How far inside the bounds the bodies stand with the world at `world`, per body (its whole footprint), court.freeze.players order. */
export function bodiesInside(court: Court, world: WorldPose, bounds: Polygon): number[] {
  return court.freeze.players.map(({ bounds: b }) => footprintInside(bounds, world, b.min, b.max));
}

// ---------------- the walking anchoring (3.4, P29) ----------------

/** The pair's long axis (court space, on the floor): its centre (the middle of both bodies' extent) and unit direction, nearest the camera first. */
export interface PairAxis {
  centre: Vec3;
  dir: Vec3;
  /** Half the pair's extent along and across the axis, metres. */
  half: [number, number];
}

/**
 * The line through both bodies (their footprints' centres), pointing away from the camera, and the middle of the
 * pair's extent along and across it. One body (the pair alone): the camera's ray through it.
 */
export function pairAxis(court: Court): PairAxis {
  const cam = court.camera.centre;
  const centres = court.freeze.players.map(({ bounds: b }): Vec3 => [(b.min[0] + b.max[0]) / 2, 0, (b.min[2] + b.max[2]) / 2]);
  const near = (p: Vec3) => flatDist(p, cam);
  const sorted = [...centres].sort((a, b) => near(a) - near(b));
  const from = sorted.length >= 2 ? sorted[0] : cam;
  const to = sorted.at(-1) ?? court.seat.pairCentre;
  let dx = to[0] - from[0];
  let dz = to[2] - from[2];
  const n = Math.hypot(dx, dz) || 1;
  dx /= n;
  dz /= n;
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const { bounds: b } of court.freeze.players)
    for (const x of [b.min[0], b.max[0]])
      for (const z of [b.min[2], b.max[2]]) {
        const u = x * dx + z * dz;
        const v = -x * dz + z * dx;
        lo[0] = Math.min(lo[0], u);
        hi[0] = Math.max(hi[0], u);
        lo[1] = Math.min(lo[1], v);
        hi[1] = Math.max(hi[1], v);
      }
  const mu = (lo[0] + hi[0]) / 2;
  const mv = (lo[1] + hi[1]) / 2;
  return { centre: [mu * dx - mv * dz, 0, mu * dz + mv * dx], dir: [dx, 0, dz], half: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2] };
}

/** The room as a rectangle: the bounds' smallest enclosing rectangle (its centre, unit axes and half sizes). */
export interface RoomFrame {
  centre: Vec3;
  u: Vec3;
  v: Vec3;
  half: [number, number];
}

/** The bounds' smallest-area enclosing rectangle (exact for a rectangular room): its centre is the room's centre, its diagonals the room's. Throws on bounds with no area (check usableBounds). */
export function roomFrame(bounds: Polygon): RoomFrame {
  let best: RoomFrame | null = null;
  let area = Infinity;
  for (let i = 0, j = bounds.length - 1; i < bounds.length; j = i++) {
    const ex = bounds[i][0] - bounds[j][0];
    const ez = bounds[i][1] - bounds[j][1];
    const n = Math.hypot(ex, ez);
    if (n < 1e-9) continue;
    const u: Vec3 = [ex / n, 0, ez / n];
    const v: Vec3 = [-u[2], 0, u[0]];
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [x, z] of bounds) {
      const a = x * u[0] + z * u[2];
      const b = x * v[0] + z * v[2];
      u0 = Math.min(u0, a);
      u1 = Math.max(u1, a);
      v0 = Math.min(v0, b);
      v1 = Math.max(v1, b);
    }
    if ((u1 - u0) * (v1 - v0) < area - 1e-12) {
      area = (u1 - u0) * (v1 - v0);
      const mu = (u0 + u1) / 2;
      const mv = (v0 + v1) / 2;
      best = { centre: [mu * u[0] + mv * v[0], 0, mu * u[2] + mv * v[2]], u, v, half: [(u1 - u0) / 2, (v1 - v0) / 2] };
    }
  }
  if (!best) throw new Error("roomFrame: the bounds have no area");
  return best;
}

/** One way to stand the pair in the room: its world pose and what the P29 checks find there. */
export interface Placement {
  world: WorldPose;
  /** The chair in court space (spot 0). */
  chair: Vec3;
  /** Metres from the chair to the nearer body's bounds (>= seat.clear passes). */
  clearance: number;
  /** Per body, metres inside the bounds (>= BODY_INSET passes; negative: past the boundary). */
  inside: number[];
  /** Metres from the chair (room space) in to the bounds (>= BODY_INSET passes; negative: outside them). */
  chairInside: number;
  /** The chair is on the camera's side of the pair's axis, at least SIDE_MIN from its line (the defender's side, never the invented front). */
  cameraSide: boolean;
  /** How far the chair is from the axis's diagonal, metres: the walking anchoring takes the diagonal away from the chair. */
  offDiagonal: number;
  passes: boolean;
}

/** The four placements with the pair's centre at the room's centre and its axis on a room diagonal (either diagonal, either way round); none for unusable bounds. */
export function placements(court: Court, bounds: Polygon, chair: ChairPose): Placement[] {
  if (!usableBounds(bounds)) return [];
  const axis = pairAxis(court);
  const room = roomFrame(bounds);
  const cam = court.camera.centre;
  const camSide = axis.dir[0] * (cam[2] - axis.centre[2]) - axis.dir[2] * (cam[0] - axis.centre[0]);
  const chairInside = boundsDistance(bounds, chair.position);
  const out: Placement[] = [];
  for (const s of [1, -1]) {
    const d: Vec3 = [room.u[0] * room.half[0] + s * room.v[0] * room.half[1], 0, room.u[2] * room.half[0] + s * room.v[2] * room.half[1]];
    const n = Math.hypot(d[0], d[2]);
    const diag: Vec3 = [d[0] / n, 0, d[2] / n];
    const offDiagonal = Math.abs(diag[0] * (chair.position[2] - room.centre[2]) - diag[2] * (chair.position[0] - room.centre[0]));
    for (const flip of [1, -1]) {
      const want: Vec3 = [flip * diag[0], 0, flip * diag[2]];
      const yaw = yawOf(want) - yawOf(axis.dir);
      const r = rotY(yaw, axis.centre);
      const world: WorldPose = { position: [room.centre[0] - r[0], 0, room.centre[2] - r[2]], yaw };
      const c = toCourt(world, [chair.position[0], 0, chair.position[2]]);
      const side = axis.dir[0] * (c[2] - axis.centre[2]) - axis.dir[2] * (c[0] - axis.centre[0]);
      const cameraSide = Math.sign(side) === Math.sign(camSide) && Math.abs(side) >= SIDE_MIN;
      const clear = clearance(court, c);
      const inside = bodiesInside(court, world, bounds);
      const passes = cameraSide && clear >= court.seat.clear - 1e-9 && Math.min(...inside) >= BODY_INSET - 1e-9 && chairInside >= BODY_INSET - 1e-9;
      out.push({ world, chair: [c[0], 0, c[2]], clearance: clear, inside, chairInside, cameraSide, offDiagonal, passes });
    }
  }
  return out;
}

/**
 * The walking anchoring's placement: one that passes P29 if any does; among those, the chair on the camera's side and
 * the axis on the diagonal away from the chair.
 */
function primary(list: Placement[]): Placement | null {
  if (!list.length) return null;
  const ranked = [...list].sort(
    (a, b) => Number(b.passes) - Number(a.passes) || Number(b.cameraSide) - Number(a.cameraSide) || b.offDiagonal - a.offDiagonal,
  );
  return ranked[0];
}

/**
 * The walking layout a floor holds, richest first (P29): "ring" (the bounds hold the walk ring; Next view hides),
 * "views" (two or more placements pass: Next view between them), "one-view" (one passes: one view and free walking,
 * no Next view), "overflow" (none passes: the walking anchoring anyway, its overflow reported and clipped in See my
 * room, no Next view). The 0.3 m and 1 m limits are never reduced.
 */
export type LayoutCase = "ring" | "views" | "one-view" | "overflow";

export interface WalkingLayout {
  case: LayoutCase;
  /** Why this case, in one line. */
  why: string;
  /** The walking anchoring: the first placement (Walk closer and standing up jump here); null for unusable bounds. */
  first: Placement | null;
  /** The placements offered as views, first one first: every one passes P29 (empty for "overflow"). */
  offered: Placement[];
}

/** The walking layout for this floor and chair (3.4, P29). */
export function walkingLayout(court: Court, bounds: Polygon, chair: ChairPose): WalkingLayout {
  if (!usableBounds(bounds)) return { case: "overflow", why: "no usable bounds", first: null, offered: [] };
  const list = placements(court, bounds, chair);
  const first = primary(list)!;
  const offered = [first, ...list.filter((p) => p !== first)].filter((p) => p.passes);
  if (ringFits(court, bounds))
    return { case: "ring", why: `the bounds hold a ring ${ringRadius(court).toFixed(2)} m round the pair, ${court.seat.clear} m clear of both bodies and ${RING_INSET} m inside`, first, offered };
  if (offered.length >= 2) return { case: "views", why: `${offered.length} placements keep the chair ${court.seat.clear} m clear and both bodies ${BODY_INSET} m inside: Next view between them`, first, offered };
  if (offered.length === 1) return { case: "one-view", why: "one placement passes (the chair on the camera's side): one view and free walking, no Next view", first, offered };
  return { case: "overflow", why: `no placement passes: ${walkingProblems(court, bounds, chair).join("; ")}`, first, offered };
}

/**
 * The walking anchoring (3.4): the world pose that puts the pair's centre at the bounds' centre with its long axis on
 * one diagonal, turned so the chair (room space) is on the camera's side. Walk closer and standing up jump here.
 */
export function walkingWorld(court: Court, bounds: Polygon, chair: ChairPose): WorldPose | null {
  return primary(placements(court, bounds, chair))?.world ?? null;
}

/** The P29 checks on the walking anchoring, one line per failure; empty when it holds. On a smaller floor the overflow is reported, not a failure (See my room clips it). */
export function walkingProblems(court: Court, bounds: Polygon, chair: ChairPose): string[] {
  const p = primary(placements(court, bounds, chair));
  if (!p) return ["no usable bounds"];
  const out: string[] = [];
  if (p.chairInside < BODY_INSET - 1e-9) out.push(`the chair is ${p.chairInside.toFixed(2)} m inside the bounds (want >= ${BODY_INSET})`);
  if (!p.cameraSide) out.push("the chair isn't on the camera's side of the pair in any diagonal placement");
  if (p.clearance < court.seat.clear - 1e-9) out.push(`the chair is ${p.clearance.toFixed(2)} m from the nearer body (want >= ${court.seat.clear})`);
  p.inside.forEach((d, i) => {
    if (d < BODY_INSET - 1e-9) out.push(`${court.freeze.players[i].id} is ${d.toFixed(2)} m inside the bounds (want >= ${BODY_INSET}${d < 0 ? `: ${(-d).toFixed(2)} m past them, clipped in See my room` : ""})`);
  });
  return out;
}

/** True when two poses are the same placement (within 1 cm and 1 deg). */
function samePose(a: WorldPose, b: WorldPose): boolean {
  const dy = Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw));
  return Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) < 0.01 && Math.abs(dy) < Math.PI / 180;
}

/** Next view: the next offered placement in the "views" layout (every one passes P29); null hides Next view (ring, one view, overflow). */
export function nextViewWorld(court: Court, bounds: Polygon, chair: ChairPose, current: WorldPose): WorldPose | null {
  const { case: kind, offered } = walkingLayout(court, bounds, chair);
  if (kind !== "views") return null;
  const others = offered.filter((p) => !samePose(p.world, current));
  if (!others.length) return null;
  const at = offered.findIndex((p) => samePose(p.world, current));
  return at < 0 ? others[0].world : offered[(at + 1) % offered.length].world;
}

/** The ring's radius round the pair's axis centre: the smallest that keeps every point `seat.clear` from both bodies (court space). */
function ringRadius(court: Court): number {
  const c = pairAxis(court).centre;
  for (let r = 0.5; r <= 12; r += 0.05) {
    let ok = true;
    for (let k = 0; k < 72 && ok; k++) {
      const a = (2 * Math.PI * k) / 72;
      ok = clearance(court, [c[0] + r * Math.cos(a), 0, c[2] + r * Math.sin(a)]) >= court.seat.clear;
    }
    if (ok) return r;
  }
  return Infinity;
}

/** True when the bounds hold the walk ring around the pair at the walking anchoring (decided from the bounds and the bodies' bounds alone); then the ring replaces the chair spot and Next view hides. */
export function ringFits(court: Court, bounds: Polygon): boolean {
  if (!usableBounds(bounds)) return false;
  const r = ringRadius(court);
  if (!Number.isFinite(r)) return false;
  const c = roomFrame(bounds).centre;
  for (let k = 0; k < 72; k++) {
    const a = (2 * Math.PI * k) / 72;
    if (boundsDistance(bounds, [c[0] + r * Math.cos(a), 0, c[2] + r * Math.sin(a)]) < RING_INSET - 1e-9) return false;
  }
  return true;
}

/** The ring's walk targets (court space): each >= RING_INSET inside the bounds and `court.seat.clear` from both bodies; empty when they don't all fit. */
export function ringPoints(court: Court, bounds: Polygon, world: WorldPose, count = 17): Vec3[] {
  if (!usableBounds(bounds)) return [];
  const r = ringRadius(court);
  if (!Number.isFinite(r)) return [];
  const axis = pairAxis(court);
  const c = axis.centre;
  const back: Vec3 = [-axis.dir[0], 0, -axis.dir[2]]; // the first point toward the camera
  const pts = Array.from({ length: count }, (_, k): Vec3 => {
    const d = rotY((2 * Math.PI * k) / count, back);
    return [c[0] + d[0] * r, 0, c[2] + d[2] * r];
  });
  return pts.every((p) => boundsDistance(bounds, toRoom(world, p)) >= RING_INSET - 1e-9) ? pts : [];
}

// ---------------- lean in (P17) ----------------

/** Distance from a point to a capsule's surface, metres (negative inside). */
export function capsuleDistance(p: Vec3, cap: Capsule): number {
  const ax = cap.b[0] - cap.a[0];
  const ay = cap.b[1] - cap.a[1];
  const az = cap.b[2] - cap.a[2];
  const px = p[0] - cap.a[0];
  const py = p[1] - cap.a[1];
  const pz = p[2] - cap.a[2];
  const len2 = ax * ax + ay * ay + az * az;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (px * ax + py * ay + pz * az) / len2)) : 0;
  return Math.hypot(px - t * ax, py - t * ay, pz - t * az) - cap.r;
}

/**
 * The lean-in fade (P17): a player fades to PROXIMITY.opacity while the eye (court space) is within
 * PROXIMITY.distance of one of their torso or head capsules, and back when it leaves, each way smooth over
 * PROXIMITY.seconds. The capsules hold no arms or hands, so the ball and the hands never fade anything.
 * freeze.ts applies `opacity[i]` to player i (court.freeze.players order).
 */
export class ProximityFade {
  readonly opacity: number[];
  private readonly capsules: Capsule[][];
  private readonly progress: number[];

  constructor(players: readonly FreezePlayer[]) {
    this.capsules = players.map((p) => p.capsules);
    this.opacity = players.map(() => 1);
    this.progress = players.map(() => 0);
  }

  update(eye: Vec3, dt: number): number[] {
    for (let i = 0; i < this.capsules.length; i++) {
      const caps = this.capsules[i];
      let near = false;
      for (let k = 0; k < caps.length && !near; k++) near = capsuleDistance(eye, caps[k]) <= PROXIMITY.distance;
      this.progress[i] = Math.min(1, Math.max(0, this.progress[i] + ((near ? 1 : -1) * dt) / PROXIMITY.seconds));
      this.opacity[i] = 1 - (1 - PROXIMITY.opacity) * smooth(this.progress[i]);
    }
    return this.opacity;
  }
}

// ---------------- the arrival (P27) and the sit (3.5) ----------------

/**
 * How long the head has been still: the time back over which every position fits a STILL_RANGE box, up to STILL_SPAN_S.
 * A window, not a filter, so a head that stops counts from the moment it stopped (P27's 1.1 s leaves no room for lag).
 */
class Stillness {
  seconds = 0;
  /** Ring of [t, x, y, z] samples; the newest is just before `next`. */
  private readonly ring = new Float64Array(STILL_SAMPLES * 4);
  private count = 0;
  private next = 0;
  private now = 0;

  update(dt: number, head: Vec3, counting: boolean): number {
    if (!counting) {
      this.reset();
      return 0;
    }
    this.now += dt;
    const r = this.ring;
    const at = this.next * 4;
    r[at] = this.now;
    r[at + 1] = head[0];
    r[at + 2] = head[1];
    r[at + 3] = head[2];
    this.next = (this.next + 1) % STILL_SAMPLES;
    this.count = Math.min(this.count + 1, STILL_SAMPLES);
    let x0 = head[0], x1 = head[0], y0 = head[1], y1 = head[1], z0 = head[2], z1 = head[2];
    let from = this.now;
    for (let k = 1; k < this.count; k++) {
      const b = ((this.next - 1 - k + STILL_SAMPLES) % STILL_SAMPLES) * 4;
      if (this.now - r[b] > STILL_SPAN_S) break;
      x0 = Math.min(x0, r[b + 1]);
      x1 = Math.max(x1, r[b + 1]);
      y0 = Math.min(y0, r[b + 2]);
      y1 = Math.max(y1, r[b + 2]);
      z0 = Math.min(z0, r[b + 3]);
      z1 = Math.max(z1, r[b + 3]);
      if (Math.hypot(x1 - x0, y1 - y0, z1 - z0) > STILL_RANGE) break;
      from = r[b];
    }
    this.seconds = this.now - from;
    return this.seconds;
  }

  reset(): void {
    this.count = 0;
    this.next = 0;
    this.seconds = 0;
  }
}

/**
 * The arrival trigger (3.1, 3.2, P27): after Seat here, black and room tone until the hand-over (the session goes
 * not-visible, as when the headset comes off, then visible again as the judge puts it on), then until the head is
 * seated (within SEATED.radius of the seat, not standing, not on the chair seat) and still for ARRIVAL_STILL_S.
 * `ready` latches until the next seatHere(). Never ends the session on `visible-blurred` (P38): it only waits.
 */
export class Arrival {
  ready = false;
  /** The hand-over happened (not visible, then visible). */
  handedOver = false;
  /** The judge's seated eye height when the lights-up started (logged; the sit test uses it). */
  eyeY: number | null = null;
  /** How long the head had been seated and still when the lights-up started, seconds (P27: <= 1.1). */
  waited: number | null = null;
  private seat: Vec3 = [0, 0, 0];
  private seatEyeY = 1.15;
  private visible = true;
  private wentAway = false;
  private readonly still = new Stillness();

  /** Seat here: the seat's floor point and the presenter's eye height there (room space). */
  seatHere(seat: Vec3, eyeY: number): void {
    this.seat = [...seat];
    this.seatEyeY = eyeY;
    this.ready = false;
    this.handedOver = false;
    this.wentAway = false;
    this.eyeY = null;
    this.waited = null;
    this.still.reset();
  }

  /** The session's visibilityState, at every visibilitychange. */
  visibility(state: string): void {
    this.visible = state === "visible";
    if (!this.visible) {
      this.wentAway = true;
      this.still.reset();
    } else if (this.wentAway) this.handedOver = true;
  }

  /** True when the head (room space) is seated in the chair. */
  seated(head: Vec3): boolean {
    return flatDist(head, this.seat) <= SEATED.radius && head[1] <= this.seatEyeY + STAND_RISE && head[1] >= MIN_EYE;
  }

  /** Once a frame; true from the frame the lights-up should start. */
  update(dt: number, head: Vec3): boolean {
    if (this.ready) return true;
    const waiting = this.handedOver && this.visible && this.seated(head);
    const still = this.still.update(dt, head, waiting);
    if (still >= ARRIVAL_STILL_S - 1e-9) {
      this.ready = true;
      this.eyeY = head[1];
      this.waited = still;
    }
    return this.ready;
  }
}

/**
 * Seated again (Back to my seat, 3.5): the head within SEATED.radius of the seat, SEATED.drop lower than the highest
 * it stood since reset() (or at most `eyeY` + 0.1, the judge's own seated height, if they never stood), and still for
 * SEATED.stillS.
 */
export class SeatedWatch {
  private seat: Vec3 = [0, 0, 0];
  private eyeY = -Infinity;
  private standing = -Infinity;
  private readonly still = new Stillness();

  reset(seat: Vec3, eyeY: number | null = null): void {
    this.seat = [...seat];
    this.eyeY = eyeY ?? -Infinity;
    this.standing = -Infinity;
    this.still.reset();
  }

  update(dt: number, head: Vec3): boolean {
    this.standing = Math.max(this.standing, head[1]);
    const low = head[1] <= Math.max(this.standing - SEATED.drop, this.eyeY + 0.1) && head[1] >= MIN_EYE;
    const near = flatDist(head, this.seat) <= SEATED.radius;
    return this.still.update(dt, head, low && near) >= SEATED.stillS;
  }
}
