// Everything the footage is projected onto, each show frame from its own solved camera (never a smoothed path): the
// court plane (exact: it's planar), the stands proxy, the depth cards (front row, photographers, the ref), one matte
// card per player at that frame's foot depth during the watch, and at F each player's splat-depth proxy (proxy.glb),
// the clean plate under the players, and the stands dim of the time stop (one stands mask, video and 3D alike). The
// flat-to-true-depth blend behind ShowVideo.depth(p) lives here. Domes and spheres are never used (3.3: they misalign
// by 0.16-1.2 deg). Stream D (`handoff`) builds it.
import * as THREE from "three";
import type { PinholeCamera } from "./camera";
import type { CourtBundle } from "./format";

/** True once stream D has built this module. */
export const BUILT = false;

export class Proxies {
  /** The projection surfaces, in court space (a child of the world group). */
  readonly group = new THREE.Group();
  /** The show frame on screen: ShowVideo uploads into it, every proxy samples it. */
  readonly texture = new THREE.VideoFrameTexture();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;

  constructor(renderer: THREE.WebGLRenderer, bundle: CourtBundle) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.group.name = "court-proxies";
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
  }

  /** Build the court plane, stands planes, depth cards, player cards; load proxy.glb, freeze-clean.png, stands-mask.png. Stub: resolves. */
  async load(): Promise<void> {}

  /** Project this display frame's show frame from its own camera (camera.ts cameraOf: source pixels). Stub: no-op. */
  project(camera: PinholeCamera): void {}

  /** 0 = each player on a flat card at their foot depth (the watch), 1 = on their splat-depth proxy (F). Stub: no-op. */
  depth(p: number): void {}

  /** The time stop: 0 = none, 1 = the stands and crowd dimmed by the full 10-20% (P28). Stub: no-op. */
  dimStands(p: number): void {}

  /** The video layer's opacity (ShowVideo.opacity is applied here: the proxies are the video layer). Stub: no-op. */
  setOpacity(k: number): void {}
}
