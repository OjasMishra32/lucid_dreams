// Everything the footage is projected onto, each show frame from its own solved camera (never a smoothed path), in
// layers (3.2): the frame's background plate on the court plane (exact: it's planar), the stands proxy and the
// backboard plane (court.backboard); one card per person from cards.json, stood at their foot point and cut by their
// matte-atlas tile, so nobody shows twice through a gap and nobody tears at an edge (P43); the ball's card at the make;
// the depth cards (front row, photographers, the ref); at F each player's splat-depth proxy (proxy.glb) carrying the
// clean plate and their matte, and F's ball pixels on the drawn ball. Every footage material is multiplied by the
// light field (lightfield.ts `glsl`) and drawn at ShowVideo.opacity. The courtside plate's dimming off the camera ray
// is `dim(p)` (world.ts calls it, P30). Domes and spheres are never used (3.3). Stream D (`handoff`) builds it.
import * as THREE from "three";
import type { CourtBundle } from "./format";
import type { LightField } from "./lightfield";
import type { ShowVideo } from "./video";

/** True once stream D has built this module. */
export const BUILT = false;

export class Proxies {
  /** The projection surfaces and cards, in court space (a child of the world group). */
  readonly group = new THREE.Group();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;
  private readonly video: ShowVideo;
  private readonly light: LightField;

  /** Samples `video.regions`; multiplies by `light`. */
  constructor(renderer: THREE.WebGLRenderer, bundle: CourtBundle, video: ShowVideo, light: LightField) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.video = video;
    this.light = light;
    this.group.name = "court-proxies";
  }

  /** Build the court plane, stands planes, backboard plane, depth cards and person cards; load proxy.glb, freeze-clean.png, stands-mask.png. Stub: resolves. */
  async load(): Promise<void> {}

  /** Project show frame `frame` (its camera from frames.json, its cards from cards.json) onto every surface. Stub: no-op. */
  project(frame: number): void {}

  /** The courtside plate's dimming as the view leaves the camera ray: 0 = as filmed, 1 = dark (world.ts drives it). Stub: no-op. */
  dim(p: number): void {}

  /** The Reality check: tint the inpainted plate behind the players and the filled holes. Stub: no-op. */
  reality(on: boolean): void {}
}
