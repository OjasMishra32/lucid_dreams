// ui.ts's HoldButton (P32): Seat here acts only after one unbroken 2 s push. A tip the hand tracking loses for a moment
// keeps the hold (HOLD_GRACE_MS); a tip that is seen coming back out of the button ends it at once, however short the
// gap; jitter at the button's face never ends it; a stopped frame loop never lets a short tap mature. ui.ts imports
// three and xr/* by value, so this file resolves extensionless sibling imports itself (vite does in the app) and stubs
// the canvas the button labels draw on.
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
const { HoldButton } = await import("../../src/court/ui.ts");

/** The button's own space is the world here: x across, y up, z out of its face (in front > 0). */
const FRONT = new THREE.Vector3(0, 0, 0.06);
const IN = new THREE.Vector3(0, 0, -0.006);

function button() {
  const fired: number[] = [];
  let now = 0;
  const b = new HoldButton("seatHere", "Seat here", () => fired.push(now));
  const at = (t: number, tip: InstanceType<typeof THREE.Vector3> | null) => {
    now = t;
    b.touch([null, tip], t);
  };
  return { b, fired, at };
}

test("P32: a 2 s push fires once, at 2 s", () => {
  const { fired, at } = button();
  at(0, FRONT);
  for (let t = 10; t <= 2500; t += 10) at(t, IN);
  assert.deepEqual(fired, [2010]);
});

test("P32: a tip seen coming back out ends the hold at once, even for 90 ms (no two short pushes make one)", () => {
  const { fired, at } = button();
  at(0, FRONT);
  for (let t = 10; t <= 1910; t += 10) at(t, IN);
  for (let t = 1920; t <= 2000; t += 10) at(t, FRONT); // withdrawn, in plain view, for 90 ms
  for (let t = 2010; t <= 3000; t += 10) at(t, IN);
  assert.deepEqual(fired, [], "neither push lasted 2 s");
  for (let t = 3010; t <= 4100; t += 10) at(t, IN);
  assert.deepEqual(fired, [4010], "the second push, held 2 s");
});

test("P32: a tip lost to tracking for under 150 ms keeps the hold; longer, and the hold starts again", () => {
  const short = button();
  short.at(0, FRONT);
  for (let t = 10; t <= 1000; t += 10) short.at(t, IN);
  for (let t = 1010; t <= 1100; t += 10) short.at(t, null);
  for (let t = 1110; t <= 2100; t += 10) short.at(t, IN);
  assert.deepEqual(short.fired, [2010]);
  const long = button();
  long.at(0, FRONT);
  for (let t = 10; t <= 1000; t += 10) long.at(t, IN);
  for (let t = 1010; t <= 1300; t += 10) long.at(t, null);
  for (let t = 1310; t <= 2100; t += 10) long.at(t, IN);
  assert.deepEqual(long.fired, []);
});

test("P32: tracking jitter at the button's face (a few mm either side of it) never ends the hold", () => {
  const { fired, at } = button();
  at(0, FRONT);
  for (let t = 10; t <= 2100; t += 10) at(t, new THREE.Vector3(0.004 * Math.sin(t), 0.003 * Math.cos(t), -0.004 + 0.006 * Math.sin(t * 1.7)));
  assert.deepEqual(fired, [2010]);
});

test("P32: a stopped frame loop never lets a short tap mature on the first frame back", () => {
  const { fired, at } = button();
  at(0, FRONT);
  at(10, IN);
  at(110, IN);
  at(2110, IN);
  assert.deepEqual(fired, []);
});
