// vrhands.ts: the drawn hands go over stream D's footage (its layers draw at renderOrder 50-90 without the depth test,
// so anything drawn before them is painted over during the watch), and stay hidden until court.ts lights them.
// vrhands.ts imports three and xr/hands by value, so this file resolves extensionless sibling imports itself (vite does
// in the app) and stubs the canvas its matcap draws on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith(".ts")) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        // not a sibling .ts: resolve as written
      }
    }
    return next(specifier, context);
  },
});
const context2d = new Proxy({}, { get: (_, p) => (p === "measureText" ? () => ({ width: 20 }) : () => ({ addColorStop() {} })), set: () => true });
(globalThis as Record<string, unknown>).document ??= { createElement: () => ({ getContext: () => context2d }) };
const THREE = await import("three");
const { HANDS_ORDER, VrHands } = await import("../../src/court/vrhands.ts");

/** The highest renderOrder stream D's footage layers use. */
const FOOTAGE_TOP = 90;

function scene() {
  const s = new THREE.Scene();
  const hands = [0, 1].map(() => {
    const h = new THREE.Group() as InstanceType<typeof THREE.Group> & { joints: Record<string, InstanceType<typeof THREE.Group>> };
    h.joints = { wrist: new THREE.Group(), "index-finger-tip": new THREE.Group() };
    s.add(h);
    return h;
  });
  return { s, vr: new VrHands(hands, s) };
}

test("the drawn hands draw after the footage (renderOrder over D's 50-90), both meshes", () => {
  const { s } = scene();
  const meshes = s.children.filter((c) => c.name === "court-hands");
  assert.equal(meshes.length, 2);
  assert.ok(HANDS_ORDER > FOOTAGE_TOP);
  for (const m of meshes) assert.equal(m.renderOrder, HANDS_ORDER);
});

test("the drawn hands stay hidden until court.ts lights them (the arrival's black hold), then show", () => {
  const { s, vr } = scene();
  vr.fade(0);
  vr.update();
  const meshes = s.children.filter((c) => c.name === "court-hands");
  assert.ok(meshes.every((m) => !m.visible));
  vr.light(1);
  assert.ok(meshes.every((m) => m.visible));
});
