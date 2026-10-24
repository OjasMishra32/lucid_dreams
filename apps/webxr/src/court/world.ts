// The arena around the footage: the court floor (the footage plate inside the camera's frustum, the rendered rulebook
// court outside it, hardwood matched to the footage, dark during the watch and brightening as the world opens; it
// writes no depth so reflections show), structured darkness, light pools, soft fixture glows, the courtside plate's
// dimming off the camera ray (P30), colours graded to the players' white point (P13), the black BackSide dome drawn
// first (no depth test or write; opacity 1 -> 0 for See my room and near the edge: the session is immersive-ar drawn
// opaque, P33-P35), and the Reality marking of everything not filmed. Stream E (`look`) builds it.
import * as THREE from "three";
import type { PinholeCamera } from "./camera";
import type { CourtBundle } from "./format";
import type { Head } from "./types";

/** True once stream E has built this module. */
export const BUILT = false;

export class CourtWorld {
  /** The black dome, in room space around the head, drawn first: opaque arena = 1, the room = 0. */
  readonly dome: THREE.Mesh;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;
  private readonly world: THREE.Group;

  /** `world` is the world group (court space); the dome goes in `scene` (room space). */
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, world: THREE.Group, bundle: CourtBundle) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.world = world;
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(50, 16, 8),
      // opaque and first in the opaque list: a `transparent` material would be sorted after every opaque object and,
      // with no depth test, paint over them. To fade it (the room, the edge) keep it in the opaque list and blend with
      // CustomBlending (three disables NormalBlending for non-transparent materials).
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthTest: false, depthWrite: false }),
    );
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    scene.add(this.dome);
  }

  /** Build the floor, lines, pools, glows; load floor.jpg and floor-seen.png. Stub: resolves. */
  async load(): Promise<void> {}

  /** The arrival's lights-up: 0 = black, 1 = the watch's look (pools ignite in sequence). Stub: no-op. */
  arrive(p: number): void {}

  /** The world opening: 0 = the watch (court outside the frustum dark), 1 = the whole arena lit under your feet. Stub: no-op. */
  open(p: number): void {}

  /** House Lights' hook: 0 = the house as in the watch, 1 = the pool on the pair has spread to the judge's feet. Stub: no-op. */
  pools(p: number): void {}

  /** See my room: 0 = the arena, 1 = the room (darkness and stands first, then the floor; a 50% veil eases off). Stub: no-op. */
  room(p: number): void {}

  /** The edge fade, every frame: metres to the bounds; the room opens from EDGE_FADE[0] and is fully open at EDGE_FADE[1]. Stub: no-op. */
  edge(distance: number): void {}

  /** The Reality check: tint everything the camera never filmed (floor and stands outside the frustum). Stub: no-op. */
  reality(on: boolean): void {}

  /** The show frame's camera: the lit footage region and the plate's dimming follow its frustum. Stub: no-op. */
  frustum(camera: PinholeCamera): void {}

  /** Once a frame: the dome follows the head. */
  update(head: Head): void {
    this.dome.position.set(head.room[0], head.room[1], head.room[2]);
  }
}
