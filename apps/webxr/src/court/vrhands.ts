// The judge's hands in the arena: drawn softly and lit by the arena (the session is drawn opaque, so the real hands
// don't show), faded out in See my room as the real ones appear in passthrough (depth-only occluders, xr/hands.ts
// handOccluder, keep them in front of the players there). Starting point: court-spikes/s6-quest/spike6/vrhands.ts.
// Stream C (`core`) builds it.
import type * as THREE from "three";

/** True once stream C has built this module. */
export const BUILT = false;

export class VrHands {
  private readonly hands: THREE.Object3D[];
  private readonly scene: THREE.Scene;

  /** `hands` are renderer.xr.getHand(0) and (1), already in the scene. */
  constructor(hands: THREE.Object3D[], scene: THREE.Scene) {
    this.hands = hands;
    this.scene = scene;
  }

  /** Once a frame while presenting. Stub: no-op. */
  update(): void {}

  /** 0 = drawn hands (the arena), 1 = faded out (the room). Stub: no-op. */
  fade(p: number): void {}
}
