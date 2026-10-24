// The seat maths (Decision W, 3.1, 3.4, 3.5), pure. Two anchorings: for the watch and the hand-off, the seat on camera
// F's optical ray at D' from the pair (`?seat=` 4-7 m), the court placed so that seat is under the head and F's view is
// forward; once the world is open (Walk closer, standing up or Next view), the walking anchoring: the pair's centre at
// the room's centre and its long axis (the line through both bodies) on one room diagonal, turned so the chair (in the
// other diagonal's corner, 0.6 m from both walls, facing the centre) is on the camera's side and is spot 0; Next view
// only where a second placement fits; the automatic ring when the bounds hold it (every ring point >= `seat.clear`
// from both bodies and >= 0.7 m inside the bounds). All of it from the bounds and the bodies' bounds: the bundle stores
// no spots. Also the play area set at Seat here (default 3.5 x 3.5 m), distance to the bounds, clearance. DOM-free and
// three-free: seatmath.test.ts imports it under node (type-only imports). Stream C (`core`) builds it; toRoom/toCourt
// (the WorldPose convention) are written.
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

/**
 * The walking anchoring (3.4): the world pose that puts the pair's centre at the bounds' centre with its long axis on
 * one diagonal, turned so the chair (room space) is on the camera's side. Walk closer and standing up jump here.
 */
export function walkingWorld(court: Court, bounds: Polygon, chair: { position: Vec3; yaw: number }): WorldPose {
  throw notBuilt("walkingWorld");
}

/** Next view: the other placement from the chair, when one fits the bounds with both bodies BODY_INSET inside; null hides Next view. */
export function nextViewWorld(court: Court, bounds: Polygon, chair: { position: Vec3; yaw: number }, current: WorldPose): WorldPose | null {
  throw notBuilt("nextViewWorld");
}

/** The play area set at Seat here (room space): `size`, the chair in a corner `inset` from both walls, facing the far corner. */
export function playArea(chair: Vec3, yaw: number, size: [number, number] = PLAY_AREA, inset = CHAIR_INSET): Polygon {
  throw notBuilt("playArea");
}

/** True when the bounds hold the walk ring around the pair at the walking anchoring (decided from the bounds and the bodies' bounds alone); then the ring replaces the chair spot and Next view hides. */
export function ringFits(court: Court, bounds: Polygon): boolean {
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
