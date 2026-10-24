// Where the judge is (Decision W, 3.1, 3.4, 3.5): the seat on camera F's optical ray at D' from the pair (`?seat=`
// 4-7 m), Seat here (the court placed so the seat is under the head and F's view is forward), the drawn chair in room
// space, the play area set at Seat here, Walk closer, the three viewing spots and Next view, the walk ring when the
// bounds allow it, distance to the bounds for the edge fade, the seated test, the persistent anchor (old handle
// deleted first) and the re-seat behind the fade. Nothing else ever moves the world (P24). The maths is DOM-free and
// three-free (seat.test.ts imports this file under node: type-only imports, no sibling values). Stream C (`core`)
// builds it; toRoom/toCourt (the WorldPose convention) are written at T0.
import type * as THREE from "three";
import type { WorldLock } from "../xr/anchor";
import type { PinholeCamera } from "./camera";
import type { Court, ShowFrame, Vec3 } from "./format";
import type { Head, Polygon, WorldPose } from "./types";

/** True once stream C has built this module. */
export const BUILT = false;

/** The default floor (Ojasva, binding): 3.5 x 3.5 m, the chair centred on one side, 0.6 m in from the edge. */
export const PLAY_AREA: [number, number] = [3.5, 3.5];
export const CHAIR_INSET = 0.6;
/** The room starts to open this far from the bounds and is fully open at the second distance, metres (P35). */
export const EDGE_FADE: [number, number] = [0.6, 0.3];
/** Standing up: the head rises this much above its seated height, metres. */
export const STAND_RISE = 0.25;
/** Seated again (Back to my seat): head within `radius` of the seat, `drop` lower than standing, still for `stillS`. */
export const SEATED = { radius: 0.35, drop: 0.25, stillS: 0.5 };
/** Every ring walk target keeps this far inside the bounds, metres. */
export const RING_INSET = 0.7;

const notBuilt = (what: string) => new Error(`${what} is not built yet (stream C)`);

// ---------------- the WorldPose convention (T0) ----------------

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

/**
 * The seat (court space): its floor point under camera F's optical ray, `distance` metres from the pair's centre on
 * the camera's side, and F's view direction along the floor (unit, y = 0).
 */
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

/** Next view: the world pose that turns the world about the pair so viewing spot `i` is where the judge stands. */
export function spotWorld(court: Court, i: number, current: WorldPose, standing: Vec3): WorldPose {
  throw notBuilt("spotWorld");
}

/** The play area set at Seat here (room space): a size[0] x size[1] square, the chair centred on one side `inset` in. */
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

// ---------------- the runtime (stream C) ----------------

/** The layout the judge walks: the three spots, or the ring when the bounds allow. */
export interface Layout {
  kind: "spots" | "ring";
  /** Walk targets, court space (floor points). */
  points: Vec3[];
}

/**
 * The only writer of the world group's transform (court -> room) and its anchor. Construct with the bundle, the world
 * group (court space; its parent must be the scene) and a WorldLock on it (null where anchors aren't offered). Every
 * move (place, closer, nextView, restore) sets `world`, writes the group (apply) and then locks the anchor; update()
 * lets the anchor correct the group and reads it back into `world`. Call them inside the XR frame (court.ts queues
 * every button and probe action to the top of the frame), since an anchor can only be made from an XRFrame.
 */
export class Seat {
  /** Where the court sits in the room now; court.ts applies it to the world group each frame. */
  world: WorldPose = { position: [0, 0, 0], yaw: 0 };
  /** The bounds: `bounded-floor` if granted, else the play area set at Seat here; null before Seat here. */
  bounds: Polygon | null = null;
  /** D' in metres (`?seat=` within court.seat.distanceRange, else court.seat.distance). */
  readonly distance: number;
  private readonly court: Court;
  private readonly frames: readonly ShowFrame[];
  private readonly group: THREE.Object3D;
  private readonly lock: WorldLock | null;

  constructor(court: Court, frames: readonly ShowFrame[], group: THREE.Object3D, lock: WorldLock | null, distance?: number) {
    this.court = court;
    this.frames = frames;
    this.group = group;
    this.lock = lock;
    const [lo, hi] = court.seat.distanceRange;
    this.distance = distance !== undefined && Number.isFinite(distance) ? Math.min(hi, Math.max(lo, distance)) : court.seat.distance;
  }

  /** Seat here: place the court for the head now (room space) and its yaw; set the play area, chair and anchor. Stub: no-op. */
  place(head: Head, yaw: number): void {}

  /** Back to the dolly seat (undoing Walk closer and Next view), behind the fade. Stub: no-op. */
  restore(): void {}

  /** Walk closer: one 0.3 s fade-jump along F's ray. Stub: no-op. */
  closer(): void {}

  /** Next view: one 0.3 s fade-jump to the next viewing spot (spots layout only). Stub: no-op. */
  nextView(): void {}

  /** The current layout. Stub: the bundle's spots. */
  layout(): Layout {
    return { kind: "spots", points: this.court.seat.spots };
  }

  /** Metres from the head to the bounds (the edge fade's input). Stub: far from any edge. */
  boundsDistance(head: Head): number {
    return Infinity;
  }

  /** True once the judge is back in the chair (SEATED). Stub: false. */
  seated(head: Head): boolean {
    return false;
  }

  /** Once a frame while presenting: the anchor corrects the group, and `world` follows it. */
  update(): void {
    this.lock?.update();
    const { position: p, quaternion: q } = this.group;
    // the yaw of a turn about +Y, read from the quaternion (rotation.y wraps past 90 deg)
    this.world = { position: [p.x, p.y, p.z], yaw: Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)) };
  }

  /** Write `world` onto the group (every move does this before locking the anchor). */
  protected apply(): void {
    this.group.position.set(this.world.position[0], this.world.position[1], this.world.position[2]);
    this.group.rotation.set(0, this.world.yaw, 0);
  }
}
