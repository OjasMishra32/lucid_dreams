// screen.ts: the Screen view's cinema screen in front of the seat. Run: npm run test:court
import "./ts-resolve.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vec3 } from "../../src/court/format.ts";

const { screenPose, viewMode, SCREEN_DEG, SCREEN_M, SCREEN_FLOOR_M } = await import("../../src/court/screen.ts");

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(...a);

test("the view setting: the screen by default, the projection only on ?view=courtside", () => {
  assert.equal(viewMode(null), "screen");
  assert.equal(viewMode("screen"), "screen");
  assert.equal(viewMode("courtside"), "courtside");
  assert.equal(viewMode("anything"), "screen");
});

test("the screen: SCREEN_DEG wide at SCREEN_M along the play, square to the eye, every corner in view, clear of the floor", () => {
  for (const eye of [[0.3, 0.76, -9] as Vec3, [2, 1.2, 8] as Vec3]) {
    // a camera axis looking down at the court: the screen still faces the eye, lifted above the horizon
    const axis: Vec3 = [0.8, -0.25, 0.55];
    const p = screenPose(eye, axis, 9 / 16);
    const toC = sub(p.centre, eye);
    assert.ok(Math.abs(norm(toC) - SCREEN_M) < 1e-9, "at SCREEN_M");
    assert.ok(Math.abs(dot(p.normal, toC) / norm(toC) + 1) < 1e-9, "square to the eye's ray");
    assert.ok(toC[1] > 0, "above eye level");
    const flat = Math.hypot(axis[0], axis[2]);
    assert.ok(Math.abs((toC[0] * axis[0] + toC[2] * axis[2]) / (Math.hypot(toC[0], toC[2]) * flat) - 1) < 1e-9, "along the play");
    const wide = 2 * Math.atan(p.width / 2 / SCREEN_M) * (180 / Math.PI);
    assert.ok(Math.abs(wide - SCREEN_DEG) < 1e-6, `${wide} deg wide`);
    assert.ok(Math.abs(p.height / p.width - 9 / 16) < 1e-12, "the frame's own aspect, never cropped");
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const c: Vec3 = [0, 1, 2].map((i) => p.centre[i] + (sx * p.width) / 2 * p.right[i] + (sy * p.height) / 2 * p.up[i]) as Vec3;
      const d = sub(c, eye);
      // in front of the eye, within 45 deg of the screen's centre: in a Quest's view looking at the screen
      assert.ok(dot(d, toC) / (norm(d) * norm(toC)) > Math.cos(Math.PI / 4), "corner in view");
      assert.ok(c[1] >= SCREEN_FLOOR_M - 1e-9, `corner at y ${c[1].toFixed(3)} clear of the floor`);
    }
  }
});
