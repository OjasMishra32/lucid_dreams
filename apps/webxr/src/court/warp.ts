// Court Side's warp into the court (demo mode; `?demo=0` keeps the plain dissolve): Step into the court's ease ends in a
// rush from the cinema screen into the court, landing exactly on F's pixel-exact picture and its hand-off. This file
// runs the parts, each its own module on the one shared API (`object`, `update(tF, head)`, `dispose()`; tF seconds from
// F, negative before it; each draws nothing outside its own window):
//   - warpTunnel.ts: the screen's rim stretched into a tunnel toward the seat, and the picture punching in at the eye;
//   - warpStreaks.ts: hyperspace light streaks pouring out of the picture and rushing past the seat.
// Everything lives in court space (add `object` to the court world group), so the screen stays where Seat here put it.
// court.ts hands it tF through the ease and the hand-off, and null in every other phase (everything off).
import * as THREE from "three";
import type { Head } from "./types";
import type { CinemaScreen } from "./screen";
import { WarpStreaks } from "./warpStreaks";
import { WarpTunnel } from "./warpTunnel";

/** The warp: add `object` to the court world group; update once a frame. */
export class Warp {
  readonly object = new THREE.Group();
  private readonly tunnel: WarpTunnel;
  private readonly streaks: WarpStreaks;
  private readonly eye = new THREE.Vector3();

  /** `live`: the screen's own texture (the stream's live region, as CinemaScreen draws it). */
  constructor(screen: CinemaScreen, live: THREE.Texture) {
    this.object.name = "court-warp";
    this.tunnel = new WarpTunnel(screen, live);
    this.streaks = new WarpStreaks(new THREE.Vector3(...screen.pose.centre), 0); // court space: the floor at y = 0
    this.object.add(this.tunnel.object, this.streaks.object);
  }

  /** Compile every part's shaders now (at load), so the warp's first frame never stalls on a compile. */
  prewarm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): void {
    renderer.compile(this.object, camera, scene);
  }

  /** Once a frame: `tF` seconds from F through the ease and the hand-off, null otherwise (nothing drawn). */
  update(tF: number | null, head: Head): void {
    const t = tF ?? Infinity; // past every part's window
    this.tunnel.update(t, head);
    this.streaks.update(t, this.eye.set(...head.court)); // court space, as its screen centre
  }

  dispose(): void {
    this.tunnel.dispose();
    this.streaks.dispose();
    this.object.removeFromParent();
  }
}
