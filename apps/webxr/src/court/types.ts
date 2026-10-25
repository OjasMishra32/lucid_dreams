// Runtime types shared by the court modules (not part of the bundle format, which is format.ts). Pure modules
// (format, camera, clock, seat maths, handoff) `import type` from here and never import a sibling's values, so node
// --test can load them; a stub that isn't built yet throws `Error("<what> is not built yet (stream X)")`. Owned by the
// integrator (frozen at T0).
import type { Quat, Vec3 } from "./format";

/** The phase machine's phases, in show order (court.ts). See my room works in every one of them (P34). */
export type Phase = "arrival" | "watching" | "easing" | "handoff" | "open" | "walking" | "returning" | "resume" | "ended";

export const PHASES: readonly Phase[] = ["arrival", "watching", "easing", "handoff", "open", "walking", "returning", "resume", "ended"];

/** The judge's eyes this frame, as court.ts hands them to every module. */
export interface Head {
  /** Eye position in room space (the XR reference space, local-floor: y = 0 on the real floor), metres. */
  room: Vec3;
  /** The same point in court space (through the world's current placement). */
  court: Vec3;
  /** Heading in room space about +Y, radians (three.js convention: 0 looks toward -Z, counterclockwise positive). */
  yaw: number;
  /** Orientation in room space. */
  quaternion: Quat;
}

/** Where the court sits in the room: room = R_y(yaw) * court + position. Nothing but seat.ts ever changes it (P24). */
export interface WorldPose {
  position: Vec3;
  yaw: number;
}

/** A floor polygon in room space, [x, z] corners in order (the `bounded-floor` bounds, else the play area). */
export type Polygon = [number, number][];
