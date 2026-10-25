// opening.ts: the title in the arrival (its own stage on the dark screen with ?solo, else over the lights-up). Run: npm run test:court
import "./ts-resolve.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { lineLevel, sharpAt, trackAt, depthAt, texel, EARLY, LATE, EARLY_STAGE_S, TITLE, REST_EM, WIDE_EM } = await import("../../src/court/opening.ts");
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
/**
 * The arrival's frames from the title's start: the still head's trigger `still` seconds after Seat here, the lights-up
 * from then (late) or once the title's stage is through too (early), to past the watch.
 */
const run = (hz: number, still: number, tl: Timeline, f: (t: number, up: number) => void) => {
  const start = tl === EARLY ? Math.max(still, EARLY_STAGE_S) : 0;
  for (let n = -1; n <= Math.ceil((start + ARRIVAL_S) * hz) + 2; n++) f(n / hz, n / hz - start);
};
const cases: [string, Timeline, number][] = [
  ["early, the shortest still", EARLY, ARRIVAL_STILL_S],
  ["early, a 4.5 s wait for a still head", EARLY, 4.5],
  ["early, an 8 s wait", EARLY, 8],
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
      const gone = tl === EARLY ? t >= EARLY.out[1] : up >= ARRIVAL_S - 0.1;
      if (t <= 0 || gone) assert.ok(v.every((x) => x === 0), `${name}: lit at t ${t.toFixed(2)}, up ${up.toFixed(2)}`);
      peak = Math.max(peak, ...v);
    });
    assert.ok(peak > (tl === EARLY ? 0.5 : 0.39), `${name}: peak ${peak.toFixed(3)}`);
  }
  // early: full, and every letter sharp, for the beat before the fade out, all in the dark hold
  assert.ok(EARLY.out[0] - EARLY.titleIn[1] >= 0.5 && EARLY_STAGE_S > EARLY.out[0], "a beat at full, on the dark screen");
  const t = EARLY.out[0];
  assert.ok(lineLevel(t, -1, "title", EARLY) > 0.999);
  for (let step = 0; step <= steps; step++) assert.ok(sharpAt(t, -1, "title", EARLY, step) > 0.999 && sharpAt(t, -1, "sub", EARLY) > 0.69);
  // the lights-up starts under the title's last light: at most a quarter of it left
  assert.ok(lineLevel(EARLY_STAGE_S, 0, "title", EARLY) < 0.3 && lineLevel(EARLY_STAGE_S, 0, "title", EARLY) > 0);
});

test("the letters close up and the line drifts in to rest", () => {
  assert.ok(Math.abs(trackAt(0) - WIDE_EM) < 1e-9 && Math.abs(trackAt(10) - REST_EM) < 1e-9);
  for (let t = 0; t < 3.8; t += 0.05) assert.ok(trackAt(t + 0.05) <= trackAt(t) + 1e-12);
  assert.ok(depthAt(0, -1, EARLY) < -1, "starts behind its rest");
  assert.ok(Math.abs(depthAt(EARLY.out[0], -1, EARLY)) < 0.05, "at rest at full");
  assert.ok(sharpAt(0.8, -1, "title", EARLY, 0) > sharpAt(0.8, -1, "title", EARLY, 4), "the centre sharpens first");
});
