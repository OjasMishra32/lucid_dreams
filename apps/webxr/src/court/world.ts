// The arena around the footage: the rendered rulebook court outside the camera's frustum (hardwood matched to the
// footage, lines; dark during the watch, lit afterwards only where the light field's pool reaches; it writes no depth
// so reflections show), the 3D rim and net at court.rim (reuse props.ts `standaloneHoop`, placed and turned to face
// the play, never rebuilt), structured darkness, soft fixture glows, the courtside plate's dimming off the camera ray
// (it calls Proxies.dim, P30), colours graded to the players' white point (P13), the black BackSide dome drawn first
// (opaque; it opens for See my room and near the edge: the session is immersive-ar drawn opaque, P33-P35), and the
// Reality marking of everything not filmed. Lit by lightfield.ts. Stream E (`look`) builds it.
import * as THREE from "three";
import type { CourtBundle } from "./format";
import type { LightField } from "./lightfield";
import type { Proxies } from "./proxies";
import type { Head } from "./types";

/** True once stream E has built this module. */
export const BUILT = false;

export class CourtWorld {
  /** The black dome, in room space around the head, drawn first: opaque arena = 1, the room = 0. */
  readonly dome: THREE.Mesh;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;
  private readonly world: THREE.Group;
  private readonly light: LightField;
  private readonly proxies: Proxies;

  /** `world` is the world group (court space); the dome goes in `scene` (room space). */
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, world: THREE.Group, bundle: CourtBundle, light: LightField, proxies: Proxies) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.world = world;
    this.light = light;
    this.proxies = proxies;
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

  /** Build the floor, lines, hoop, glows; load floor.jpg and floor-seen.png. Stub: resolves. */
  async load(): Promise<void> {}

  /** The arena after the hand-off: 0 = the watch's look, 1 = the world as the pool leaves it (the light field does the lighting). Stub: no-op. */
  open(p: number): void {}

  /** See my room: 0 = the arena, 1 = the room (darkness and stands first, then the floor; a 50% veil eases off). Stub: no-op. */
  room(p: number): void {}

  /** The edge fade, every frame: metres to the bounds; the room opens from 0.6 m and is fully open at 0.3 m (seatmath EDGE_FADE). Stub: no-op. */
  edge(distance: number): void {}

  /** The Reality check: tint everything the camera never filmed (the rendered court, floor and stands outside the frustum). Stub: no-op. */
  reality(on: boolean): void {}

  /** Once a frame: the dome follows the head; the plate's off-ray dimming (Proxies.dim) from the head's view. */
  update(head: Head): void {
    this.dome.position.set(head.room[0], head.room[1], head.room[2]);
  }
}
