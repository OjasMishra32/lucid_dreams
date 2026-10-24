// probe.ts viewOf: a captured frame's view as a pinhole camera in court space must project every court point to the
// pixel three.js drew it at, or truthAt()'s ground truth (P8, P43) would be off by the error.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { project } from "../../src/court/camera.ts";
import { viewOf } from "../../src/court/probe.ts";

/** The pixel (OpenCV: (0, 0) the top-left pixel's centre) three.js draws a court point at, inside the eye's viewport. */
function drawnAt(eye: THREE.PerspectiveCamera, world: THREE.Object3D, p: [number, number, number]): [number, number] {
  const ndc = world.localToWorld(new THREE.Vector3(...p)).project(eye);
  const vp = eye.viewport!;
  return [((ndc.x + 1) / 2) * vp.z - 0.5, ((1 - ndc.y) / 2) * vp.w - 0.5];
}

function rig(frustum: { left: number; right: number; top: number; bottom: number }, w: number, h: number) {
  const scene = new THREE.Scene();
  const world = new THREE.Group(); // court -> room: the seat's placement
  world.position.set(1.2, 0, -2.5);
  world.rotation.y = 0.7;
  scene.add(world);
  scene.updateMatrixWorld(true);
  const eye = new THREE.PerspectiveCamera();
  eye.position.set(0.3, 1.55, 0.4);
  eye.lookAt(world.localToWorld(new THREE.Vector3(6, 1.2, 0.8))); // toward the points, then a little roll
  eye.rotateZ(0.05);
  eye.projectionMatrix.makePerspective(frustum.left, frustum.right, frustum.top, frustum.bottom, 0.1, 100);
  eye.viewport = new THREE.Vector4(0, 0, w, h);
  scene.add(eye);
  scene.updateMatrixWorld(true);
  return { world, eye };
}

/** Court points around the pair, all in front of the eye. */
const POINTS: [number, number, number][] = [
  [6, 1, 1],
  [5.2, 0, 0.3],
  [8.5, 2.1, -0.7],
  [3, 1.6, 2.4],
];

test("viewOf: a symmetric view projects court points where three.js draws them", () => {
  const w = 1280;
  const h = 720;
  const { world, eye } = rig({ left: -0.8, right: 0.8, top: 0.45, bottom: -0.45 }, w, h);
  const view = viewOf(eye, world, w, h);
  assert.ok(Math.abs(view.fx - view.fy) < 1e-9, "square pixels");
  const cam = { ...view, f: view.fx };
  for (const p of POINTS) {
    const want = drawnAt(eye, world, p);
    const got = project(cam, p);
    assert.ok(got, `${p} in front of the eye`);
    assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 1e-6, `${p}: ${got} vs ${want}`);
  }
});

test("viewOf: an off-centre frustum (one eye of a headset) moves the principal point, not the pixels", () => {
  const w = 1000;
  const h = 1000;
  const { world, eye } = rig({ left: -0.5, right: 0.7, top: 0.65, bottom: -0.55 }, w, h);
  const view = viewOf(eye, world, w, h);
  assert.ok(Math.abs(view.cx - (w / 2 - 0.5)) > 10 && Math.abs(view.cy - (h / 2 - 0.5)) > 10, "off-centre");
  const cam = { ...view, f: view.fx };
  for (const p of POINTS) {
    const got = project(cam, p);
    assert.ok(got, `${p} in front of the eye`);
    const want = drawnAt(eye, world, p);
    assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 1e-6, `${p}: ${got} vs ${want}`);
  }
});

test("viewOf: the viewport is reported top-down for the read-back frame", () => {
  const { world, eye } = rig({ left: -0.8, right: 0.8, top: 0.45, bottom: -0.45 }, 640, 360);
  eye.viewport = new THREE.Vector4(640, 0, 640, 360); // the right half of a 1280 x 720 buffer (WebGL: y from the bottom)
  const view = viewOf(eye, world, 1280, 720);
  assert.deepEqual(view.viewport, [640, 360, 640, 360]);
  assert.equal(view.width, 640);
});
