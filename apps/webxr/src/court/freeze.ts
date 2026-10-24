// The frozen 3D: the pair's freeze splats and the ball, brought up under the opaque picture from F - 0.45 s to
// F + 0.3 s (never seen; Spark's first sort is done before the fade, and their opacity never fades, P10), the other
// players (3.4b: splats, body or relief, each handed off like the pair), erasing the ball inside the splats, contact
// shadows, soft reflections (a mirrored proxy of ~7% of the splats through a Spark worldModifier, Schlick f0 0.06;
// court-spikes/ground/), the capsule proximity fade (torso or head within 0.2 m -> 30% over 300 ms; hands and ball
// never, P17), the light field's dyno modifier on every splat mesh (LightField.modifier()), and the Reality check
// (reality.ply swapped in, seen % per player). Stream E (`look`) builds it.
import type * as THREE from "three";
import type { SparkRenderer } from "@sparkjsdev/spark";
import type { CourtBundle } from "./format";
import type { LightField } from "./lightfield";
import type { Head } from "./types";

/** True once stream E has built this module. */
export const BUILT = false;

export class Freeze {
  /** Seen fraction per player id (court.json seenFraction), for the Reality check's panel. */
  readonly seen: Record<string, number>;
  private readonly world: THREE.Group;
  private readonly bundle: CourtBundle;
  private readonly spark: SparkRenderer;
  private readonly light: LightField;

  /** Splats and maps go in `world` (court space). */
  constructor(world: THREE.Group, bundle: CourtBundle, spark: SparkRenderer, light: LightField) {
    this.world = world;
    this.bundle = bundle;
    this.spark = spark;
    this.light = light;
    this.seen = Object.fromEntries(bundle.court.freeze.players.map((p) => [p.id, p.seenFraction]));
  }

  /** Load every player's splats and reality splats, the extras, the floor maps; build the ball. Stub: resolves. */
  async load(): Promise<void> {}

  /** 0 = nothing drawn, 1 = the pair, the ball and the extras drawn (under the picture first), with shadows and reflections. Never splat opacity. Stub: no-op. */
  reveal(p: number): void {}

  /** The Reality check: swap in reality.ply, tint the ball's far side and the extras placed from another camera. Stub: no-op. */
  reality(on: boolean): void {}

  /** Once a frame: the capsule proximity fade (head in court space). Stub: no-op. */
  update(head: Head, dt: number): void {}
}
