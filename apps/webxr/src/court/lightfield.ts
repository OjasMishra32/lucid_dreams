// The one world-space light field (3.3, 3.3a: House Lights' pool on Same Pixels' timing): the crowd's level, the floor
// outside the pool, the pair (always 1), the stands, and the growing pool (the real footprint plus a lane to the
// viewer's feet, each floor point brightening on its own curve nearest the pair first, penumbra >= 1.5 m, dark beyond;
// it never opens to the whole floor). One GLSL chunk multiplies every footage, floor and stands material
// (proxies.ts, world.ts) and one Spark dyno modifier multiplies every splat mesh (freeze.ts, `worldModifiers`,
// SplatMesh.d.ts:37-38), so footage and splats get the same numbers; dark gradients are dithered (the 8-bit panel
// bands). A CPU `at(x, z)` gives the same number for the tests. Levels come from court.json `light`. Pure (type-only
// imports), so lightfield.test.ts can load it under node. Stream E (`look`) builds it; port House Lights' `FIELD_GLSL`
// and `splatK` (court-spikes/proto-house-lights/webxr/src/proto/directions/house-lights.ts).
import type { GsplatModifier } from "@sparkjsdev/spark";
import type { Court } from "./format";

/** True once stream E has built this module. */
export const BUILT = false;

/** What the field is doing; `set(beat, t)` takes seconds into the beat. */
export type Beat =
  | "dark" // the arrival's hold: everything at 0
  | "arrival" // the lights come up (2.5 s): the pools ignite in sequence
  | "watch" // the arena as filmed
  | "ease" // the time stop over the ease: crowd -> light.crowd, floor outside the pool -> light.floor, the pair at 1
  | "handoff" // from F: the pool grows (F + 1.0 to F + 4.0 s), the stands rise to light.stands (F + 3.0 to F + 5.0 s)
  | "return" // Back to my seat: the stands go down, the pool gathers onto the pair
  | "resume"; // the house comes up 0.25 s after the sound

/** The field now. Multipliers are 0-1 (1 = as filmed). */
export interface FieldState {
  crowd: number;
  floor: number;
  pair: number;
  stands: number;
  /** The pool on the floor: centre (court x, z), radius and soft edge, metres. */
  pool: { centre: [number, number]; radius: number; penumbra: number };
}

/** What a footage, floor or stands pixel is, for the GLSL chunk's `courtLight(worldPos, part)`. */
export const PART = { floor: 0, crowd: 1, stands: 2, person: 3 } as const;

export class LightField {
  /** The field now (after the last set()). */
  readonly levels: FieldState;
  /**
   * GLSL: the uniforms and `float courtLight(vec3 worldPos, float part)` (part: PART.*), the multiplier to apply to a
   * footage, floor or stands fragment at a court-space position. Every material includes it and shares `uniforms`.
   */
  readonly glsl: string;
  /** The uniforms `glsl` reads; one object, shared by every material (set() updates it in place). */
  readonly uniforms: Record<string, { value: unknown }> = {};
  private readonly court: Court;

  constructor(court: Court) {
    this.court = court;
    const [x, , z] = court.seat.pairCentre;
    this.levels = { crowd: 1, floor: 1, pair: 1, stands: 1, pool: { centre: [x, z], radius: 0, penumbra: court.light.penumbra } };
    // stub: no change to anything until stream E writes the field
    this.glsl = "float courtLight(vec3 worldPos, float part) { return 1.0; }\n";
  }

  /** Move the field to `t` seconds into `beat` (a pure function of the two: recordings are deterministic). Stub: no-op. */
  set(beat: Beat, t: number): void {}

  /** The Spark dyno modifier that applies the field to a splat mesh (add it to `worldModifiers`). Stub: null (no change). */
  modifier(): GsplatModifier | null {
    return null;
  }

  /** The multiplier at a floor point (court x, z) for `part`, as the GLSL computes it (the tests' CPU twin). Stub: 1. */
  at(x: number, z: number, part: number = PART.floor): number {
    return 1;
  }
}
