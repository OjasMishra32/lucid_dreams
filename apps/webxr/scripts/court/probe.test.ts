// probe.ts viewOf: a captured frame's view as a pinhole camera in court space must project every court point to the
// pixel three.js drew it at, or truthAt()'s ground truth (P8, P43) would be off by the error.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { project } from "../../src/court/camera.ts";
import { Probe, STAMP, viewOf } from "../../src/court/probe.ts";

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

/** A WebGL stand-in for the probe's read-back: scissored clears really paint its buffer (rows bottom up, as GL's). */
function fakeGl(w: number, h: number) {
  const px = new Uint8Array(w * h * 4);
  let scissor = false;
  let box = [0, 0, w, h];
  let clear = [0, 0, 0, 0];
  const gl = {
    FRAMEBUFFER: 1, RGBA: 2, UNSIGNED_BYTE: 3, SCISSOR_TEST: 4, SCISSOR_BOX: 5, COLOR_CLEAR_VALUE: 6, COLOR_WRITEMASK: 7, COLOR_BUFFER_BIT: 8,
    drawingBufferWidth: w,
    drawingBufferHeight: h,
    bindFramebuffer: () => {},
    isEnabled: () => scissor,
    enable: () => (scissor = true),
    disable: () => (scissor = false),
    getParameter: (p: number) => (p === 5 ? Int32Array.from(box) : p === 6 ? Float32Array.from(clear) : [true, true, true, true]),
    colorMask: () => {},
    scissor: (x: number, y: number, bw: number, bh: number) => (box = [x, y, bw, bh]),
    clearColor: (r: number, g: number, b: number, a: number) => (clear = [r, g, b, a]),
    clear: () => {
      const [x0, y0, bw, bh] = scissor ? box : [0, 0, w, h];
      for (let y = y0; y < Math.min(h, y0 + bh); y++)
        for (let x = x0; x < Math.min(w, x0 + bw); x++) px.set(clear.map((c) => Math.round(c * 255)), (y * w + x) * 4);
    },
    readPixels: (_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Uint8Array) => out.set(px),
    state: () => ({ scissor, box, clear }),
  };
  return gl;
}

/** The capture's stamp reader (capture.mjs checkStamps), on GL's bottom-up rows: row r's value. */
function readStamp(px: Uint8Array, w: number, row: number): number {
  let v = 0;
  for (let b = 0; b < STAMP.bits; b++) {
    const x = (b + 2) * STAMP.cell + STAMP.cell / 2;
    const y = row * STAMP.cell + STAMP.cell / 2;
    v = (v << 1) | (px[(y * w + x) * 4] >= 128 ? 1 : 0);
  }
  return v;
}

function probeFor(query: string, frame: { frame: number; onScreen: number }) {
  const g = globalThis as unknown as { window?: unknown; location?: unknown };
  g.window = globalThis;
  g.location = { search: query };
  const clock = { frame: frame.frame, segment: "pass1", ease: null, speed: 1, nextEase: null, nextJump: null, armed: false, pass: 1, segmentFrame: 0 };
  return new Probe("capture", {
    snapshot: () => ({ phase: "watching", setup: false, clock, onScreen: frame.onScreen, still: 0, lightsUp: 0, tF: 0, roomP: 0, fed: frame.frame, lightBeat: "", lightT: 0, xrHz: 72, clockHz: 72 }),
    seatHere: () => {},
    press: () => {},
    modules: {},
    stats: () => null,
    view: () => null,
  });
}

test("lockstep: the frame loop runs only the frames step() asks for, and each step resolves with its own frame", async () => {
  const probe = probeFor("?mode=court", { frame: 7, onScreen: 7 });
  const gl = fakeGl(320, 48) as unknown as WebGL2RenderingContext;
  assert.equal(probe.run(), true, "free-running until lockstep");
  probe.api.lockstep(true);
  assert.equal(probe.run(), false, "held: no frame was asked for");
  const one = probe.api.step(false);
  const two = probe.api.step(true);
  assert.equal(probe.run(), true);
  probe.afterRender(gl, 1);
  assert.equal(probe.run(), true);
  probe.afterRender(gl, 1);
  assert.equal(probe.run(), false, "two steps, two frames, then held again");
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual([a.n, b.n], [0, 1]);
  assert.equal(a.pixels, undefined);
  assert.equal(Buffer.from(b.pixels!, "base64").length, 320 * 48 * 4);
  probe.api.lockstep(false);
  assert.equal(probe.run(), true);
});

test("stamp: ?stamp paints the display frame, the show frame and the frame on screen, and puts GL's state back", async () => {
  const probe = probeFor("?mode=court&stamp", { frame: 1234, onScreen: -1 });
  const fake = fakeGl(320, 48);
  const gl = fake as unknown as WebGL2RenderingContext;
  probe.api.lockstep(true);
  const steps = [probe.api.step(false), probe.api.step(false), probe.api.step(true)];
  for (let i = 0; i < 3; i++) {
    probe.run();
    probe.afterRender(gl, 1);
  }
  const f = (await Promise.all(steps))[2];
  const px = new Uint8Array(Buffer.from(f.pixels!, "base64"));
  assert.deepEqual([0, 1, 2].map((row) => readStamp(px, 320, row)), [2, 1234, 0xffff]);
  assert.equal(px[(STAMP.cell / 2) * 320 * 4 + (STAMP.cell / 2) * 4], 255, "white guard");
  assert.equal(px[(STAMP.cell / 2) * 320 * 4 + (STAMP.cell + STAMP.cell / 2) * 4], 0, "black guard");
  assert.deepEqual(fake.state(), { scissor: false, box: [0, 0, 320, 48], clear: [0, 0, 0, 0] });
});
