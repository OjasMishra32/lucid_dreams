// camera.ts (the bundle's camera convention) and seat.ts's toRoom/toCourt (the WorldPose convention).
import { test } from "node:test";
import assert from "node:assert/strict";
import { angleDeg, fromBasis, lookRotation, opticalAxis, project, rayOf, rotate, scaled, toCamera, type PinholeCamera } from "../../src/court/camera.ts";
import { toCourt, toRoom } from "../../src/court/seat.ts";

const close = (a: number, b: number, eps = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);
const cam = (forward: [number, number, number], f = 28700): PinholeCamera => ({
  centre: [-22, 1, -9], q: lookRotation(forward), f, cx: 1919.5, cy: 1079.5, width: 3840, height: 2160,
});

test("a camera looking down +X has +Z on its right and the floor below its centre", () => {
  const c = cam([1, 0, 0]);
  const right = rotate(c.q, [1, 0, 0]);
  const down = rotate(c.q, [0, 1, 0]);
  [0, 0, 1].forEach((v, i) => close(right[i], v, 1e-12, "right"));
  [0, -1, 0].forEach((v, i) => close(down[i], v, 1e-12, "down"));
  const ahead = project(c, [0, 1, -9])!;
  close(ahead[0], c.cx, 1e-9, "u");
  close(ahead[1], c.cy, 1e-9, "v");
  const toRight = project(c, [0, 1, -8])!;
  assert.ok(toRight[0] > c.cx, "a point to the right (+Z) lands right of centre");
  const lower = project(c, [0, 0, -9])!;
  assert.ok(lower[1] > c.cy, "a point below lands below centre (+v)");
});

test("project and rayOf are inverses, at any pixel", () => {
  const c = cam([28, -0.2, 10]);
  for (const [u, v] of [[0, 0], [3839, 2159], [1919.5, 1079.5], [1200.25, 300.75]]) {
    const { origin, dir } = rayOf(c, u, v);
    const p: [number, number, number] = [origin[0] + 31 * dir[0], origin[1] + 31 * dir[1], origin[2] + 31 * dir[2]];
    const back = project(c, p)!;
    close(back[0], u, 1e-6, "u");
    close(back[1], v, 1e-6, "v");
  }
  assert.equal(project(c, [-40, 1, -15]), null, "behind the camera");
});

test("the optical axis is the camera's +z, and toCamera puts it on +z", () => {
  const c = cam([28, -1, 10]);
  const axis = opticalAxis(c);
  const n = Math.hypot(28, -1, 10);
  [28 / n, -1 / n, 10 / n].forEach((v, i) => close(axis[i], v, 1e-12));
  const p = toCamera(c, [c.centre[0] + 5 * axis[0], c.centre[1] + 5 * axis[1], c.centre[2] + 5 * axis[2]]);
  close(p[0], 0, 1e-9);
  close(p[1], 0, 1e-9);
  close(p[2], 5, 1e-9);
});

test("scaling to another image width keeps the same rays (pixel centres stay pixel centres)", () => {
  const c = cam([28, 0.1, 10]);
  const s = scaled(c, 2560);
  assert.equal(s.height, 1440);
  const p: [number, number, number] = [6, 1.2, 1.4];
  const a = project(c, p)!;
  const b = project(s, p)!;
  const k = 2560 / 3840;
  close(b[0], (a[0] + 0.5) * k - 0.5, 1e-6);
  close(b[1], (a[1] + 0.5) * k - 0.5, 1e-6);
});

test("fromBasis gives unit quaternions for every branch", () => {
  for (const f of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.3, -0.9, 0.2], [-0.5, 0.2, -0.7]] as [number, number, number][]) {
    const q = lookRotation(f);
    close(Math.hypot(...q), 1, 1e-12);
    const z = rotate(q, [0, 0, 1]);
    close(angleDeg(z, f), 0, 1e-6, "forward");
  }
  const q = fromBasis([0, 0, -1], [0, 1, 0], [1, 0, 0]);
  close(Math.hypot(...q), 1, 1e-12);
});

test("toRoom and toCourt are inverses and match three.js rotation.y", () => {
  const world = { position: [1.5, 0, -2] as [number, number, number], yaw: 0.7 };
  const p: [number, number, number] = [6, 1.2, 1];
  const r = toRoom(world, p);
  // three: rotation.y = yaw maps +X to (cos, 0, -sin)
  const x = toRoom({ position: [0, 0, 0], yaw: 0.7 }, [1, 0, 0]);
  close(x[0], Math.cos(0.7), 1e-12);
  close(x[2], -Math.sin(0.7), 1e-12);
  const back = toCourt(world, r);
  p.forEach((v, i) => close(back[i], v, 1e-12));
});
