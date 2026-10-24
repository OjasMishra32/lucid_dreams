import type * as THREE from "three";
import { report } from "./report";

/**
 * renderer.setAnimationLoop, except that an error in one frame never stops the headset drawing. three.js asks for the
 * next frame only after the callback returns, so one exception (a hand joint missing for a frame, say) froze the last
 * image to your head for good. Now the error is reported, the scene is still drawn, and the next frame runs as usual.
 */
export function resilientLoop(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, frame: (time: number, xrFrame?: XRFrame) => void): void {
  renderer.setAnimationLoop((time, xrFrame) => {
    try {
      frame(time, xrFrame);
    } catch (e) {
      report(e, "frame");
      try {
        renderer.render(scene, camera);
      } catch (e2) {
        report(e2, "render");
      }
    }
  });
}
