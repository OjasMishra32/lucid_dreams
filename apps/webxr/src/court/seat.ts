// Where the judge is, at runtime (Decision W, 3.1, 3.4, 3.5): Seat here (the court placed by seatmath.ts so the seat
// is under the head and F's view is forward), the room-space chair drawn over the real one, the play area (or the
// `bounded-floor` bounds when granted), Walk closer / standing up and Next view as 0.3 s fade-jumps to the walking
// anchoring, the persistent anchor (the old handles deleted first: 8 per site), the re-seat behind the fade, and seated
// detection. Nothing else ever moves the world (P24): Seat is the only writer of the world group's transform. All the
// maths is in seatmath.ts (node-tested); seat.test.ts runs this runtime under node and the e2e in the page. Stream C.
import * as THREE from "three";
import type { Court, ShowFrame, Vec3 } from "./format";
import {
  Arrival, SeatedWatch, boundsDistance, freezeCamera, nextViewWorld, placeWorld, placements, playArea, ringFits, ringPoints,
  seatPoint, toCourt, toRoom, usableBounds, walkingLayout, walkingProblems, walkingWorld, yawOf, type ChairPose, type LayoutCase, type SeatSpot,
} from "./seatmath";
import type { Head, Polygon, WorldPose } from "./types";

/** True once stream C has built this module. */
export const BUILT = true;

/** Every move is behind a black veil: in over the first half, the move at full black, out over the second (P24). */
export const JUMP_S = 0.3;

/** What Seat needs of an anchor: xr/anchor.ts's WorldLock, or PersistentLock below. */
export interface AnchorLock {
  lock(): void;
  release(): void;
  update(): void;
}

/** The parts of three's WebXRManager the seat reads (the session, the frame, the reference space). */
export interface XrSource {
  getSession(): XRSession | null;
  getFrame(): XRFrame | null;
  getReferenceSpace(): XRReferenceSpace | null;
}

/** Where the persistent handle is kept between sessions of this page. */
type HandleStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const HANDLE_KEY = "court-side.anchor";

function pageStorage(): HandleStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

/**
 * The court's anchor: a WebXR anchor at the world group's pose, read back every frame (WorldLock's job), made
 * persistent so a re-entry after the session ends (a system pinch) comes back to the same place. A site keeps at most
 * 8 persistent anchors, so every lock() deletes the old handles first (this page's, and any the session lists) and
 * only then asks for the new one; while one of them won't go, no new one is asked for (the seat is anchored for this
 * session only), so a refusing site never fills its quota. Drop-in for WorldLock: `new PersistentLock(renderer, world)`.
 */
export class PersistentLock implements AnchorLock {
  readonly xr: XrSource;
  private readonly obj: THREE.Object3D;
  private readonly store: HandleStore | null;
  private anchor: XRAnchor | null = null;
  private asked = 0;
  private session: XRSession | null = null;
  /** This page's persistent handle (also in the store). */
  private handle: string | null = null;
  /** Handles a delete was refused for: tried again at every lock(). */
  private readonly stuck = new Set<string>();

  constructor(renderer: { xr: XrSource }, obj: THREE.Object3D, store: HandleStore | null = pageStorage()) {
    this.xr = renderer.xr;
    this.obj = obj;
    this.store = store;
    try {
      this.handle = store?.getItem(HANDLE_KEY) ?? null;
    } catch {
      this.handle = null;
    }
  }

  /** Pin the object where it stands now. Call inside the XR frame, right after moving it. */
  lock(): void {
    this.release();
    const frame = this.xr.getFrame();
    const space = this.xr.getReferenceSpace();
    const session = this.xr.getSession();
    if (!frame?.createAnchor || !space || !session) return;
    const id = this.asked;
    // the old handles go first: ours, any refused before, and any this site still holds; the old pose never comes back
    const old = [...new Set<string>([...(this.handle ? [this.handle] : []), ...this.stuck, ...(session.persistentAnchors ?? [])])];
    this.remember(null);
    const del = (uuid: string) => (session.deletePersistentAnchor ? session.deletePersistentAnchor(uuid) : Promise.reject(new Error("no delete")));
    const deleted = Promise.allSettled(old.map(del)).then((results) => {
      results.forEach((r, i) => (r.status === "rejected" ? this.stuck.add(old[i]) : this.stuck.delete(old[i])));
      return this.stuck.size === 0; // true: the site holds none of ours
    });
    const p = this.obj.position;
    const q = this.obj.quaternion;
    frame
      .createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), space)
      ?.then(async (a) => {
        if (id !== this.asked) return a.delete();
        this.anchor = a;
        // a handle that won't go stays counted against the site's 8: asking for another would only fill the quota
        if (!(await deleted) || id !== this.asked || !a.requestPersistentHandle) return;
        const uuid = await a.requestPersistentHandle();
        if (id === this.asked) this.remember(uuid);
        else await del(uuid).catch(() => this.stuck.add(uuid)); // superseded meanwhile: it goes too, or waits with the others
      })
      .catch(() => {}); // no anchors (or no persistence) here: it stays put in the reference space
  }

  /** Stop following the anchor (before moving the object). The persistent handle stays until the next lock(). */
  release(): void {
    this.asked++;
    try {
      this.anchor?.delete();
    } catch {
      // an anchor of a session that already ended
    }
    this.anchor = null;
  }

  /** Once a frame while presenting: the object goes back to where the room says it is; a new session restores the handle. */
  update(): void {
    const session = this.xr.getSession();
    if (session !== this.session) {
      this.session = session;
      this.anchor = null;
      if (session && this.handle && session.restorePersistentAnchor) {
        const id = this.asked;
        session
          .restorePersistentAnchor(this.handle)
          .then((a) => {
            if (id === this.asked && this.session === session) this.anchor = a;
            else a.delete();
          })
          .catch(() => {}); // the handle is gone: Seat here again (the drill)
      }
    }
    const frame = this.xr.getFrame();
    const space = this.xr.getReferenceSpace();
    if (!this.anchor || !frame || !space || (frame.trackedAnchors && !frame.trackedAnchors.has(this.anchor))) return;
    const pose = frame.getPose(this.anchor.anchorSpace, space);
    if (!pose) return;
    const { position: p, orientation: o } = pose.transform;
    this.obj.position.set(p.x, p.y, p.z);
    this.obj.quaternion.set(o.x, o.y, o.z, o.w);
  }

  private remember(uuid: string | null): void {
    this.handle = uuid;
    try {
      if (uuid) this.store?.setItem(HANDLE_KEY, uuid);
      else this.store?.removeItem(HANDLE_KEY);
    } catch {
      // storage blocked: the handle lives for this page only
    }
  }
}

/** The layout the judge walks (3.4): the chair spot (Next view where a second placement fits), or the ring when the bounds hold it. */
export interface Layout {
  kind: "chair" | "ring";
  /** Walk targets, court space (floor points): the chair's, or the ring's. */
  points: Vec3[];
  /** Which layout applied, richest first: "ring", "views" (Next view), "one-view", "overflow" (seatmath walkingLayout); null before Seat here. */
  case: LayoutCase | null;
  /** Why, in one line. */
  why: string;
}

/** What the e2e and the frame log read about the seat (P1, P29). */
export interface SeatReport {
  world: WorldPose;
  chair: ChairPose | null;
  /** The seat's floor point in the room now (under the head at Seat here, P1). */
  seatFloor: Vec3;
  /** D' in metres. */
  distance: number;
  /** "bounded-floor", "play-area" or null before Seat here. */
  bounds: "bounded-floor" | "play-area" | null;
  layout: "chair" | "ring";
  /** The layout's case and why (seatmath walkingLayout). */
  layoutCase: LayoutCase | null;
  why: string;
  /** The world sits at the walking anchoring (or a Next view of it), not the watch's. */
  walking: boolean;
  /** Next view applies here (a second placement passes P29 and the ring is off). */
  nextView: boolean;
  /** The chair (spot 0) in court space at the walking anchoring, its clearance to the nearer body, and each body's metres inside the bounds. */
  chairCourt: Vec3 | null;
  chairClearance: number | null;
  inside: number[];
  /** Every P29 check the walking anchoring fails on this floor (empty when it holds; overflow is reported, not a failure). */
  problems: string[];
  /** The room heading F's view direction has now (P1: equal to the chair's yaw at the dolly seat). */
  viewYaw: number;
  /** The judge's seated eye height when the lights-up started (P1 logs it; the plan expects ~1.15 m). */
  eyeY: number | null;
  /** How long the head was seated and still before the lights-up, seconds (P27). */
  arrivalWaited: number | null;
  veil: number;
}

declare global {
  interface Window {
    /** The seat's report for the e2e (probe pages only). */
    __courtSeat?: { report(): SeatReport; trace(): number[][]; boundsDistance(room: Vec3): number };
  }
}

const samePose = (a: WorldPose, b: WorldPose) =>
  Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) < 1e-6 && Math.abs(Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw))) < 1e-6;
const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** A plain courtside chair, its origin on the floor under the seated head, facing -Z. */
function chairMesh(): THREE.Group {
  const g = new THREE.Group();
  g.name = "court-chair";
  const seatMat = new THREE.MeshBasicMaterial({ color: 0x2b2b30 });
  const frameMat = new THREE.MeshBasicMaterial({ color: 0x0e0e10 });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    g.add(mesh);
  };
  // the head sits above the front half of the seat: the seat's centre 0.12 m behind it
  box(0.46, 0.05, 0.44, 0, 0.45, 0.12, seatMat);
  box(0.46, 0.46, 0.04, 0, 0.72, 0.33, seatMat);
  for (const x of [-0.2, 0.2]) for (const z of [-0.07, 0.31]) box(0.03, 0.43, 0.03, x, 0.215, z, frameMat);
  return g;
}

/**
 * The only writer of the world group's transform (court -> room) and its anchor. Construct with the bundle, the world
 * group (court space; its parent must be the scene) and an anchor lock on it (null where anchors aren't offered).
 * Every move (place, closer, nextView, restore) is a fade-jump: the veil goes black over JUMP_S / 2, then `world` is
 * set, written to the group and the anchor locked, then the veil clears. update() runs the fade and lets the anchor
 * correct the group, reading it back into `world`. Call everything inside the XR frame (court.ts queues every button
 * and probe action to the top of the frame), since an anchor can only be made from an XRFrame.
 */
export class Seat {
  /** Where the court sits in the room now (court.ts reads it each frame). */
  world: WorldPose = { position: [0, 0, 0], yaw: 0 };
  /** The bounds: `bounded-floor` if granted, else the play area set at Seat here; null before Seat here. */
  bounds: Polygon | null = null;
  /** D' in metres (`?seat=` within court.seat.distanceRange, else court.seat.distance). */
  readonly distance: number;
  /** The arrival trigger (P27): feed it `visibility(state)` at every visibilitychange and update(dt, head.room) in the arrival. */
  readonly arrival = new Arrival();
  /** Where the judge sat at Seat here (room space); null before. */
  chair: ChairPose | null = null;
  /** The fade-jump's black veil, 0 clear to 1 black (drawn by this module, last, over everything). */
  veil = 0;
  /** Where the bounded-floor bounds come from (the lock's, else set by court.ts); null: the play area only. */
  xr: XrSource | null;
  private readonly court: Court;
  private readonly group: THREE.Object3D;
  private readonly lock: AnchorLock | null;
  /** The seat on F's ray (court space). */
  private readonly spotF: SeatSpot;
  private home: WorldPose | null = null;
  /** The pose the last move went to (the world reaches it at the middle of its fade). */
  private target: WorldPose | null = null;
  private walking = false;
  private jump: { to: WorldPose; t: number; movedAt: number | null } | null = null;
  private area: Polygon | null = null;
  private floorBounds: Polygon | null = null;
  private boundedSpace: { session: XRSession; space: XRBoundedReferenceSpace | null; age: number } | null = null;
  private readonly sit = new SeatedWatch();
  private lastDt = 1 / 72;
  /** The eye height at Seat here: the seated height to fall back on before the arrival measured the judge's. */
  private placedEyeY: number | null = null;
  /** Probe pages only: [veil, x, z, yaw] after every update, for the e2e (P24). */
  private trace: number[][] | null = null;
  private readonly chairObj: THREE.Group;
  private readonly veilMesh: THREE.Mesh;
  private readonly veilMat: THREE.MeshBasicMaterial;

  constructor(court: Court, frames: readonly ShowFrame[], group: THREE.Object3D, lock: AnchorLock | null, distance?: number) {
    this.court = court;
    this.group = group;
    this.lock = lock;
    this.xr = (lock as { xr?: XrSource } | null)?.xr ?? null;
    const [lo, hi] = court.seat.distanceRange;
    this.distance = distance !== undefined && Number.isFinite(distance) ? Math.min(hi, Math.max(lo, distance)) : court.seat.distance;
    this.spotF = seatPoint(court, freezeCamera(court, frames), this.distance);
    this.chairObj = chairMesh();
    this.chairObj.visible = false;
    // a sphere round the room, drawn last with no depth test: black over everything while it is up
    this.veilMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.veilMesh = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 8), this.veilMat);
    this.veilMesh.name = "court-veil";
    this.veilMesh.renderOrder = 1e6;
    this.veilMesh.frustumCulled = false;
    this.veilMesh.visible = false;
    group.parent?.add(this.chairObj, this.veilMesh);
    if (typeof window !== "undefined" && window.__court) {
      this.trace = [];
      window.__courtSeat = {
        report: () => this.report(),
        trace: () => this.trace!.splice(0),
        boundsDistance: (room) => (this.bounds ? boundsDistance(this.bounds, room) : Infinity),
      };
    }
  }

  /** Seat here: place the court for the head now (room space) and its yaw; set the chair, the play area and the anchor. */
  place(head: Head, yaw: number): void {
    const position: Vec3 = [head.room[0], 0, head.room[2]];
    this.chair = { position, yaw };
    this.area = playArea(position, yaw);
    this.useBounds(this.floorBounds);
    this.home = placeWorld(this.spotF, head.room, yaw);
    this.walking = false;
    this.arrival.seatHere(position, head.room[1]);
    this.placedEyeY = head.room[1];
    this.sit.reset(position);
    this.chairObj.position.set(position[0], 0, position[2]);
    this.chairObj.rotation.set(0, yaw, 0);
    this.chairObj.visible = true;
    this.veilMesh.position.set(head.room[0], head.room[1], head.room[2]);
    if (this.group.parent && this.chairObj.parent !== this.group.parent) this.group.parent.add(this.chairObj, this.veilMesh);
    this.go(this.home);
  }

  /** Back to the dolly seat (undoing the walking anchoring), behind the fade. */
  restore(): void {
    if (!this.home) return;
    this.walking = false;
    this.go(this.home);
  }

  /** Walk closer or standing up: one 0.3 s fade-jump to the walking anchoring (seatmath walkingWorld). Once per walk. */
  closer(): void {
    if (!this.chair || !this.bounds) return;
    const w = walkingWorld(this.court, this.bounds, this.chair);
    if (!w || (this.walking && this.target && samePose(this.target, w))) return; // already there: no blink
    this.walking = true;
    this.go(w);
  }

  /** Next view: one 0.3 s fade-jump to the other placement, when one fits (seatmath nextViewWorld). */
  nextView(): void {
    const next = this.nextWorld();
    if (next) this.go(next);
  }

  /** True when Next view applies: walking, a second placement fits and the ring is off. */
  hasNextView(): boolean {
    return this.nextWorld() !== null;
  }

  /** The current layout: the chair spot at the walking anchoring, or the ring when the bounds hold it. */
  layout(): Layout {
    if (!this.chair || !this.bounds) return { kind: "chair", points: [], case: null, why: "before Seat here" };
    const l = walkingLayout(this.court, this.bounds, this.chair);
    if (!l.first) return { kind: "chair", points: [], case: l.case, why: l.why };
    const w = l.first.world;
    if (l.case === "ring") return { kind: "ring", points: ringPoints(this.court, this.bounds, w), case: l.case, why: l.why };
    return { kind: "chair", points: [toCourt(w, this.chair.position)], case: l.case, why: l.why };
  }

  /** Metres from the head to the bounds (the edge fade's input, P35); far from any edge before Seat here. */
  boundsDistance(head: Head): number {
    return this.bounds ? boundsDistance(this.bounds, head.room) : Infinity;
  }

  /** True once the judge is back in the chair (SEATED); call once a frame while it matters (Back to my seat). */
  seated(head: Head): boolean {
    if (!this.chair) return false;
    return this.sit.update(this.lastDt, head.room);
  }

  /**
   * Once a frame while presenting, with the frame's dt and the head: the fade-jump runs, the bounded-floor bounds are
   * read, and the anchor corrects the group (`world` follows it). Without dt it assumes one 72 Hz frame.
   */
  update(dt = 1 / 72, head?: Head): void {
    this.lastDt = dt;
    this.readBoundedFloor(dt);
    this.lock?.update();
    const { position: p, quaternion: q } = this.group;
    // the yaw of a turn about +Y, read from the quaternion (rotation.y wraps past 90 deg)
    const w = this.world;
    w.position[0] = p.x;
    w.position[1] = p.y;
    w.position[2] = p.z;
    w.yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
    if (head) this.veilMesh.position.set(head.room[0], head.room[1], head.room[2]);
    const j = this.jump;
    if (j) {
      j.t += dt;
      if (j.movedAt === null && j.t >= JUMP_S / 2 - 1e-9) {
        // full black on the frame the world moves; the veil then clears by JUMP_S
        this.world = { position: [...j.to.position], yaw: j.to.yaw };
        this.apply();
        this.lock?.lock();
        j.movedAt = j.t;
      }
      this.veil = j.movedAt === null ? smooth(j.t / (JUMP_S / 2)) : smooth(1 - (j.t - j.movedAt) / (JUMP_S - j.movedAt));
      if (j.t >= JUMP_S - 1e-9) {
        this.jump = null;
        this.veil = 0;
      }
    }
    this.veilMat.opacity = this.veil;
    this.veilMesh.visible = this.veil > 0;
    if (this.trace && this.trace.length < 4000) this.trace.push([this.veil, this.world.position[0], this.world.position[2], this.world.yaw]);
  }

  /** The bounds in room space: `bounded-floor` (when granted and it has area: seatmath usableBounds) or the play area. */
  useBounds(floorBounds: Polygon | null): void {
    this.floorBounds = floorBounds && usableBounds(floorBounds) ? floorBounds : null; // no area: the play area set at Seat here
    this.bounds = this.floorBounds ?? this.area;
  }

  /** What the e2e and the frame log read (P1 seat pose, P29). */
  report(): SeatReport {
    const seatFloor = toRoom(this.world, this.spotF.floor);
    const layout = this.layout();
    const walk = this.chair && this.bounds ? placements(this.court, this.bounds, this.chair) : null;
    const w = this.chair && this.bounds ? walkingWorld(this.court, this.bounds, this.chair) : null;
    const at = walk && w ? walk.find((p) => p.world.yaw === w.yaw && p.world.position[0] === w.position[0]) ?? null : null;
    return {
      world: { position: [...this.world.position], yaw: this.world.yaw },
      chair: this.chair && { position: [...this.chair.position], yaw: this.chair.yaw },
      seatFloor,
      distance: this.distance,
      bounds: this.floorBounds ? "bounded-floor" : this.area ? "play-area" : null,
      layout: layout.kind,
      layoutCase: layout.case,
      why: layout.why,
      walking: this.walking,
      nextView: this.hasNextView(),
      chairCourt: at?.chair ?? null,
      chairClearance: at?.clearance ?? null,
      inside: at?.inside ?? [],
      problems: this.chair && this.bounds ? walkingProblems(this.court, this.bounds, this.chair) : [],
      viewYaw: this.world.yaw + yawOf(this.spotF.forward),
      eyeY: this.arrival.eyeY,
      arrivalWaited: this.arrival.waited,
      veil: this.veil,
    };
  }

  /** Write `world` onto the group (every move does this before locking the anchor). */
  protected apply(): void {
    this.group.position.set(this.world.position[0], this.world.position[1], this.world.position[2]);
    this.group.rotation.set(0, this.world.yaw, 0);
  }

  /** Start a fade-jump to `to` (a jump under way is retargeted, its veil keeps going). */
  private go(to: WorldPose): void {
    this.target = to;
    this.sit.reset(this.chair?.position ?? [0, 0, 0], this.arrival.eyeY ?? this.placedEyeY);
    this.lock?.release();
    const j = this.jump;
    if (j && j.movedAt === null) j.to = to;
    else {
      // clearing after a move: go dark again from the veil's level now (never a pop)
      const level = j && j.movedAt !== null ? 1 - (j.t - j.movedAt) / (JUMP_S - j.movedAt) : 0;
      this.jump = { to, t: (JUMP_S / 2) * Math.max(0, level), movedAt: null };
    }
  }

  /** Next view's target from where the world is going now, or null (not walking, the ring is on, or no second placement fits). */
  private nextWorld(): WorldPose | null {
    if (!this.walking || !this.chair || !this.bounds || !this.target || ringFits(this.court, this.bounds)) return null;
    return nextViewWorld(this.court, this.bounds, this.chair, this.target);
  }

  /** bounded-floor: asked for once per session; its polygon brought into the reference space about once a second. */
  private readBoundedFloor(dt: number): void {
    const session = this.xr?.getSession() ?? null;
    if (!session) return;
    if (this.boundedSpace?.session !== session) {
      const entry: { session: XRSession; space: XRBoundedReferenceSpace | null; age: number } = { session, space: null, age: Infinity };
      this.boundedSpace = entry;
      session
        .requestReferenceSpace("bounded-floor")
        .then((space) => {
          entry.space = space as XRBoundedReferenceSpace;
          entry.space.addEventListener?.("reset", () => (entry.age = Infinity));
        })
        .catch(() => {}); // not granted: the play area set at Seat here
      return;
    }
    const b = this.boundedSpace;
    b.age += dt;
    if (!b.space || b.age < 1) return;
    const frame = this.xr?.getFrame();
    const ref = this.xr?.getReferenceSpace();
    const pose = frame && ref ? frame.getPose(b.space, ref) : null;
    if (!pose) return;
    b.age = 0;
    const m = pose.transform.matrix;
    const poly: Polygon = (b.space.boundsGeometry ?? []).map((p) => [m[0] * p.x + m[8] * p.z + m[12], m[2] * p.x + m[10] * p.z + m[14]]);
    const same = this.floorBounds && this.floorBounds.length === poly.length && poly.every((p, i) => Math.hypot(p[0] - this.floorBounds![i][0], p[1] - this.floorBounds![i][1]) < 0.01);
    if (!same && usableBounds(poly)) this.useBounds(poly);
  }
}
