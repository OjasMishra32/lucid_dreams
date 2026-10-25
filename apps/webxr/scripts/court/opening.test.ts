// opening.ts: the title over the arrival (from Seat here with ?solo, else the lights-up). Run: npm run test:court
import "./ts-resolve.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { lineLevel, sharpAt, trackAt, depthAt, texel, EARLY, LATE, TITLE, REST_EM, WIDE_EM } = await import("../../src/court/opening.ts");
const { ARRIVAL_S } = await import("../../src/court/lightfield.ts");
const { ARRIVAL_STILL_S } = await import("../../src/court/seatmath.ts");

type Timeline = typeof EARLY;
const steps = Math.ceil(TITLE.length / 2);
/** Every texel's display value: each line, each letter's sharp weight, the corners of sharp/soft/glow/streak (texel is linear in each). */
const values = (t: number, up: number, tl: Timeline): number[] => {
  const out: number[] = [];
  for (const line of ["title", "sub"] as const)
    for (let step = 0; step <= steps; step++) {
      const level = lineLevel(t, up, line, tl);
      const sharpW = sharpAt(t, up, line, tl, step);
      for (let c = 0; c < 16; c++) out.push(texel(level, sharpW, c & 1, (c >> 1) & 1, (c >> 2) & 1, (c >> 3) & 1));
    }
  return out;
};
/** The arrival's frames from the title's start: `hold` seconds of dark hold, then the lights-up to past the watch. */
const run = (hz: number, hold: number, tl: Timeline, f: (t: number, up: number) => void) => {
  for (let n = -1; n <= Math.ceil((hold + ARRIVAL_S) * hz) + 2; n++) f(n / hz, n / hz - hold);
};
const cases: [string, Timeline, number][] = [
  ["early, the shortest hold", EARLY, ARRIVAL_STILL_S],
  ["early, a 1.3 s hold", EARLY, 1.3],
  ["early, a 4 s hold", EARLY, 4],
  ["late (the hand-over: no title in the hold)", LATE, 0],
];

test("P44: no texel moves more than 0.97 grey levels a display frame, at 72 and 90 Hz", () => {
  for (const [name, tl, hold] of cases)
    for (const hz of [72, 90]) {
      let worst = 0;
      let prev: number[] | null = null;
      run(hz, hold, tl, (t, up) => {
        const next = values(t, up, tl);
        if (prev) next.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - prev![i]) * 255)));
        prev = next;
      });
      assert.ok(worst <= 0.97, `${name}, ${hz} Hz: ${worst.toFixed(3)} levels a frame`);
    }
});

test("nothing before it begins, gone before the watch, and bright in between", () => {
  for (const [name, tl, hold] of cases) {
    let peak = 0;
    run(72, hold, tl, (t, up) => {
      const v = values(t, up, tl);
      if (t <= 0 || up >= ARRIVAL_S - 0.1) assert.ok(v.every((x) => x === 0), `${name}: lit at t ${t.toFixed(2)}, up ${up.toFixed(2)}`);
      peak = Math.max(peak, ...v);
    });
    assert.ok(peak > (tl === EARLY ? 0.5 : 0.39), `${name}: peak ${peak.toFixed(3)}`);
  }
  // early: full, and every letter sharp, before the fade out at the shortest hold
  const t = ARRIVAL_STILL_S + EARLY.out[0];
  assert.ok(lineLevel(t, EARLY.out[0], "title", EARLY) > 0.999);
  for (let step = 0; step <= steps; step++) assert.ok(sharpAt(t, EARLY.out[0], "title", EARLY, step) > 0.999 && sharpAt(t, EARLY.out[0], "sub", EARLY) > 0.69);
});

test("the letters close up and the line drifts in to rest", () => {
  assert.ok(Math.abs(trackAt(0) - WIDE_EM) < 1e-9 && Math.abs(trackAt(10) - REST_EM) < 1e-9);
  for (let t = 0; t < 3.8; t += 0.05) assert.ok(trackAt(t + 0.05) <= trackAt(t) + 1e-12);
  assert.ok(depthAt(0, -1, EARLY) < -1, "starts behind its rest");
  assert.ok(Math.abs(depthAt(2.6, 1.6, EARLY)) < 0.05, "at rest at full");
  assert.ok(sharpAt(0.8, -1, "title", EARLY, 0) > sharpAt(0.8, -1, "title", EARLY, 4), "the centre sharpens first");
});
