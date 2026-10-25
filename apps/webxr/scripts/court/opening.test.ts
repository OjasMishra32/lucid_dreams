// opening.ts: the title over the arrival's lights-up. Run: npm run test:court
import "./ts-resolve.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { lineLevel, sharpAt, trackAt, depthAt, texel, TITLE, TITLE_OUT_S, REST_EM, WIDE_EM } = await import("../../src/court/opening.ts");
const { ARRIVAL_S } = await import("../../src/court/lightfield.ts");

const steps = Math.ceil(TITLE.length / 2);
/** Every texel's display value at t: each line, each letter's sharp weight, the corners of sharp/soft/glow (texel is linear in each). */
const values = (t: number): number[] => {
  const out: number[] = [];
  for (const line of ["title", "sub"] as const)
    for (let step = 0; step <= steps; step++) {
      const level = lineLevel(t, line);
      const sharpW = sharpAt(t, line, step);
      for (let c = 0; c < 8; c++) out.push(texel(level, sharpW, c & 1, (c >> 1) & 1, (c >> 2) & 1));
    }
  return out;
};

test("P44: no texel moves more than 0.97 grey levels a display frame, at 72 and 90 Hz", () => {
  for (const hz of [72, 90]) {
    let worst = 0;
    let prev = values(-1 / hz);
    for (let n = 0; n <= Math.ceil(ARRIVAL_S * hz) + 2; n++) {
      const next = values(n / hz);
      next.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - prev[i]) * 255)));
      prev = next;
    }
    assert.ok(worst <= 0.97, `${hz} Hz: ${worst.toFixed(3)} levels a frame`);
  }
});

test("dark before the lights-up and gone before the watch; visible in between", () => {
  assert.ok(values(-0.5).every((v) => v === 0));
  assert.ok(values(0).every((v) => v === 0));
  for (let t = ARRIVAL_S - 0.1; t <= ARRIVAL_S + 1; t += 0.01) assert.ok(values(t).every((v) => v === 0), `lit at ${t.toFixed(2)} s`);
  const peak = Math.max(...Array.from({ length: 380 }, (_, i) => Math.max(...values(i / 100))));
  assert.ok(peak > 0.3, `peak ${peak.toFixed(3)}`);
  assert.ok(lineLevel(1.85, "title") > 0.99, "the title is full between the fades");
  for (let step = 0; step <= steps; step++) assert.ok(sharpAt(TITLE_OUT_S[0], "title", step) > 0.999 && sharpAt(TITLE_OUT_S[0], "sub") > 0.69, "every letter sharp before the fade out");
});

test("the letters close up and the line drifts in to rest", () => {
  assert.ok(Math.abs(trackAt(0) - WIDE_EM) < 1e-9 && Math.abs(trackAt(10) - REST_EM) < 1e-9);
  for (let t = 0; t < 3.8; t += 0.05) assert.ok(trackAt(t + 0.05) <= trackAt(t) + 1e-12);
  assert.ok(depthAt(0) < -0.5, "starts behind its rest");
  assert.ok(Math.abs(depthAt(1.9)) < 0.05, "at rest at full");
  assert.ok(sharpAt(0.8, "title", 0) > sharpAt(0.8, "title", 4), "the centre sharpens first");
});
