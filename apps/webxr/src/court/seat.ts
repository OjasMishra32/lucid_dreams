// Where the judge is, at runtime (Decision W, 3.1, 3.4, 3.5): Seat here (the court placed by seatmath.ts so the seat
// is under the head and F's view is forward), the room-space chair drawn over the real one, the play area, Walk closer
// and Next view as 0.3 s fade-jumps, the persistent anchor (the old handle deleted first: 8 per site), the re-seat
// behind the fade, and seated detection. Nothing else ever moves the world (P24): Seat is the only writer of the world
// group's transform. All the maths is in seatmath.ts (node-tested); this file is tested through the e2e. Stream C
// (`core`) builds it; update()/apply() (the single-writer rule) are written.
import type * as THREE from "three";
import type { WorldLock } from "../xr/anchor";
import type { Court, ShowFrame, Vec3 } from "./format";
import type { Head, Polygon, WorldPose } from "./types";

/** True once stream C has built this module. */
export const BUILT = false;

/** The layout the judge walks (3.4): the chair spot (Next view where a second placement fits), or the ring when the bounds hold it. */
export interface Layout {
  kind: "chair" | "ring";
  /** Walk targets, court space (floor points): the chair's, or the ring's. */
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
  /** Where the court sits in the room now. */
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

  /** Walk closer or standing up: one 0.3 s fade-jump to the walking anchoring (seatmath walkingWorld). Stub: no-op. */
  closer(): void {}

  /** Next view: one 0.3 s fade-jump to the other placement, when one fits (seatmath nextViewWorld). Stub: no-op. */
  nextView(): void {}

  /** True when Next view applies: walking, a second placement fits and the ring is off. Stub: false. */
  hasNextView(): boolean {
    return false;
  }

  /** The current layout. Stub: no walk targets. */
  layout(): Layout {
    return { kind: "chair", points: [] };
  }

  /** Metres from the head to the bounds (the edge fade's input). Stub: far from any edge. */
  boundsDistance(head: Head): number {
    return Infinity;
  }

  /** True once the judge is back in the chair (seatmath SEATED). Stub: false. */
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
