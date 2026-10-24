import type * as THREE from "three";
import { report } from "./report";

/**
 * renderer.setAnimationLoop, except that an error in one frame never stops the headset drawing. three.js asks for the
 * next frame only after the callback returns, so one exception (a hand joint missing for a frame, say) froze the last
 * image to your head for good. Now the error is reported, the scene is still drawn, and the next frame runs as usual.
 */
export function resilientLoop(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, frame: (time: number, xrFrame?: XRFrame) => void): void {
  // frame timing, reported to the Mac every 5 s when anything was slow: long callbacks mean our code (main thread),
  // long gaps with short callbacks mean the GPU couldn't keep up (resolution, splat count)
  let last = 0;
  let windowStart = 0;
  let frames = 0;
  let maxCall = 0;
  let maxGap = 0;
  let slow = 0;
  renderer.setAnimationLoop((time, xrFrame) => {
    const t0 = performance.now();
    if (last) {
      const gap = t0 - last;
      maxGap = Math.max(maxGap, gap);
      if (gap > 50) slow++;
    }
    last = t0;
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
    const call = performance.now() - t0;
    maxCall = Math.max(maxCall, call);
    frames++;
    if (!windowStart) windowStart = t0;
    if (t0 - windowStart > 5000) {
      if (renderer.xr.isPresenting && (maxCall > 40 || maxGap > 120 || slow > 10)) {
        const fps = (frames * 1000) / (t0 - windowStart);
        report(`slow: ${fps.toFixed(0)} fps, longest frame callback ${maxCall.toFixed(0)} ms, longest gap ${maxGap.toFixed(0)} ms, ${slow} gaps over 50 ms`, `perf ${Math.round(t0 / 5000)}`);
      }
      windowStart = t0;
      frames = 0;
      maxCall = 0;
      maxGap = 0;
      slow = 0;
    }
  });
}
