// The seat maths (Decision W, 3.1, 3.4, 3.5), pure: the seat on camera F's optical ray at D' from the pair (`?seat=`
// 4-7 m), the court placed so that seat is under the head and F's view is forward, the play area set at Seat here (the
// default 3.5 x 3.5 m: the chair in one corner, 0.6 m from both walls, facing the far corner, so F's line of sight runs
// down the room's diagonal; in a ring-size room the chair is centred on a short side), Walk closer (the pair's centre
// court.seat.closer m from the chair along the diagonal), the three viewing spots and Next view (each spot narrowed from
// 60 deg until both bodies stay >= 0.3 m inside the play area, P29), the walk ring when the bounds allow it, distance to
// the bounds, and the clearance of every spot and ring point. DOM-free and three-free: seatmath.test.ts imports it
// under node (type-only imports). Stream C (`core`) builds it; toRoom/toCourt (the WorldPose convention) are written.
import type { PinholeCamera } from "./camera";
import type { Court, Vec3 } from "./format";
import type { Polygon, WorldPose } from "./types";

/** True once stream C has built this module. */
export const BUILT = false;

/** The default floor (Ojasva, binding): 3.5 x 3.5 m. */
export const PLAY_AREA: [number, number] = [3.5, 3.5];
/** The chair sits this far from both walls of its corner. */
export const CHAIR_INSET = 0.6;
/** Both bodies stay at least this far inside the play area at every viewing spot. */
export const BODY_INSET = 0.3;
/** The widest the side spots go, degrees from the front spot. */
export const SIDE_SPOT_DEG = 60;
/** The room starts to open this far from the bounds and is fully open at the second distance, metres (P35). */
export const EDGE_FADE: [number, number] = [0.6, 0.3];
/** Standing up: the head rises this much above its seated height, metres. */
export const STAND_RISE = 0.25;
/** Seated again (Back to my seat): head within `radius` of the seat, `drop` lower than standing, still for `stillS`. */
export const SEATED = { radius: 0.35, drop: 0.25, stillS: 0.5 };
/** Every ring walk target keeps this far inside the bounds, metres. */
export const RING_INSET = 0.7;

const notBuilt = (what: string) => new Error(`${what} is not built yet (stream C)`);

// ---------------- the WorldPose convention ----------------

/**
 * A court point in room space: room = R_y(yaw) court + position, R_y as three.js builds it for `rotation.y = yaw`
 * (x' = x cos + z sin, z' = -x sin + z cos). So the world group's transform is exactly the WorldPose.
 */
export function toRoom(world: WorldPose, p: Vec3): Vec3 {
  const c = Math.cos(world.yaw);
  const s = Math.sin(world.yaw);
  return [c * p[0] + s * p[2] + world.position[0], p[1] + world.position[1], -s * p[0] + c * p[2] + world.position[2]];
}

/** A room point in court space (the inverse of toRoom). */
export function toCourt(world: WorldPose, p: Vec3): Vec3 {
  const c = Math.cos(world.yaw);
  const s = Math.sin(world.yaw);
  const x = p[0] - world.position[0];
  const z = p[2] - world.position[2];
  return [c * x - s * z, p[1] - world.position[1], s * x + c * z];
}

// ---------------- the maths (stream C) ----------------

/** The seat (court space): its floor point under camera F's optical ray, `distance` m from the pair's centre on the camera's side, and F's view direction along the floor (unit, y = 0). */
export function seatPoint(court: Court, camF: PinholeCamera, distance: number): { floor: Vec3; forward: Vec3 } {
  throw notBuilt("seatPoint");
}

/** The world pose that puts the seat's floor point under the head (room space) and F's direction along `headYaw`. */
export function placeWorld(seat: { floor: Vec3; forward: Vec3 }, head: Vec3, headYaw: number): WorldPose {
  throw notBuilt("placeWorld");
}

/** Walk closer: the world pose that leaves the pair's centre `court.seat.closer` m in front of the chair, along F's ray. */
export function closerWorld(court: Court, seat: { floor: Vec3; forward: Vec3 }, chair: { position: Vec3; yaw: number }): WorldPose {
  throw notBuilt("closerWorld");
}

/** The viewing spots' angles about the pair, degrees (0 = front): the side spots narrowed from SIDE_SPOT_DEG until both bodies stay BODY_INSET inside the play area. */
export function spotAngles(court: Court, area: Polygon, world: WorldPose): number[] {
  throw notBuilt("spotAngles");
}

/** Next view: the world pose that turns the world about the pair so viewing spot `i` is where the judge stands. */
export function spotWorld(court: Court, i: number, current: WorldPose, standing: Vec3): WorldPose {
  throw notBuilt("spotWorld");
}

/** The play area set at Seat here (room space): `size`, the chair in a corner `inset` from both walls, facing the far corner. */
export function playArea(chair: Vec3, yaw: number, size: [number, number] = PLAY_AREA, inset = CHAIR_INSET): Polygon {
  throw notBuilt("playArea");
}

/** True when the bounds hold the walk ring (`court.seat.ringArea`); then the ring replaces the spots. */
export function ringFits(bounds: Polygon, ringArea: [number, number]): boolean {
  throw notBuilt("ringFits");
}

/** The ring's walk targets (court space): each >= RING_INSET inside the bounds and `court.seat.clear` from both bodies. */
export function ringPoints(court: Court, bounds: Polygon, world: WorldPose, count = 17): Vec3[] {
  throw notBuilt("ringPoints");
}

/** Distance from a room point to the nearest edge of the bounds, metres along the floor (negative outside). */
export function boundsDistance(bounds: Polygon, point: Vec3): number {
  throw notBuilt("boundsDistance");
}

/** Metres from a court point (on the floor) to the nearest body's bounds (P29's clearance). */
export function clearance(court: Court, point: Vec3): number {
  throw notBuilt("clearance");
}
