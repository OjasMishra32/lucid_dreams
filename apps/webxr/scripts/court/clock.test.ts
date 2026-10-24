// clock.ts's curve contract (shared by the bake and the clock): the eases land exactly on F from pass 2's speed, speed changes
// stay under 0.02 per display frame (P6, P18), and the stand-in's show obeys them. The Clock class itself is stream
// C's: its tests (passes, ladder, cutoff, armed stop) go here when it is built.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EASE_SECONDS, RESUME_RAMP_S, easeFrameCount, easeSpeed, easeTau, easeTravel, rampTravel, resumeSpeed, resumeTau,
  smootherstep, stepFrames,
} from "../../src/court/clock.ts";
import { standinBundle } from "./standin.mjs";

/** Pass 2's speed comes from the bundle (court.video.pass2Speed); the stand-in's is made up. */
const PASS2_SPEED: number = standinBundle().court.video.pass2Speed;

const close = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test("smootherstep is 0 and 1 at the ends with flat ends", () => {
  close(smootherstep(0), 0);
  close(smootherstep(1), 1);
  close(smootherstep(0.5), 0.5);
  close(smootherstep(-1), 0);
  close(smootherstep(2), 1);
  const slope = (u: number) => (smootherstep(u + 1e-6) - smootherstep(u - 1e-6)) / 2e-6;
  close(slope(1e-3), 0, 1e-4);
  close(slope(1 - 1e-3), 0, 1e-4);
});

test("travel runs 0 -> 1 and is monotonic", () => {
  for (const travel of [easeTravel, rampTravel]) {
    close(travel(0), 0);
    close(travel(1), 1);
    let last = -1;
    for (let u = 0; u <= 1; u += 0.01) {
      assert.ok(travel(u) >= last);
      last = travel(u);
    }
  }
});

test("step = round(dt x displayHz) at 72 and 90 Hz", () => {
  assert.equal(stepFrames(1 / 72, 72), 1);
  assert.equal(stepFrames(1 / 90, 90), 1);
  assert.equal(stepFrames(2 / 72, 72), 2);
  assert.equal(stepFrames(1 / 120, 72), 1);
  assert.equal(stepFrames(0.004, 72), 0);
  assert.equal(stepFrames(1 / 90, 72), 1);
});

for (const seconds of EASE_SECONDS)
  test(`the ${seconds} s ease leaves pass 2's speed without a step, lands exactly on F and never changes speed by 0.02 a frame`, () => {
    const n = easeFrameCount(seconds, 72);
    close(easeTau(n, n, 72, PASS2_SPEED), 0);
    // entering from pass 2: the first step is a pass-2-speed step
    const first = (easeTau(1, n, 72, PASS2_SPEED) - easeTau(0, n, 72, PASS2_SPEED)) * 72;
    close(first, PASS2_SPEED, 0.002);
    let prev = PASS2_SPEED;
    for (let k = 1; k <= n; k++) {
      const s = easeSpeed(k, n, PASS2_SPEED);
      assert.ok(Math.abs(s - prev) <= 0.02, `frame ${k}: ${prev} -> ${s}`);
      prev = s;
    }
    close(prev, 0);
    // it starts speed x seconds / 2 of real time before F
    close(-easeTau(0, n, 72, PASS2_SPEED), (PASS2_SPEED * n) / 72 / 2);
  });

test("the resume ramps 0 -> pass 2's speed over 0.8 s within 0.02 a frame, then plays at it", () => {
  const n = easeFrameCount(RESUME_RAMP_S, 72);
  let prev = 0;
  for (let k = 1; k <= n; k++) {
    const s = resumeSpeed(k, n, PASS2_SPEED);
    assert.ok(Math.abs(s - prev) <= 0.02, `frame ${k}: ${prev} -> ${s}`);
    prev = s;
  }
  close(prev, PASS2_SPEED);
  close((resumeTau(n + 10, n, 72, PASS2_SPEED) - resumeTau(n + 9, n, 72, PASS2_SPEED)) * 72, PASS2_SPEED, 1e-9);
});

test("the stand-in's show follows the contract: every ease ends on F, pass 2 runs at its speed on real frames", () => {
  const { court, frames } = standinBundle();
  const v = court.video;
  for (const e of v.segments.eases) assert.equal(frames[e.frames[1]].src, v.freezeSource);
  const per = court.camera.sourceFps * court.camera.slow;
  for (let i = v.segments.pass2[0] + 1; i <= v.segments.pass2[1]; i++) {
    close(((frames[i].src - frames[i - 1].src) / per) * v.displayHz, v.pass2Speed, 1e-9);
    assert.equal(frames[i].interp, false);
  }
  // pass 1 at 1x: one display frame in two is a real frame (the stand-in's made-up 180 fps capture)
  const p1 = frames.slice(v.segments.pass1[0], v.segments.pass1[1] + 1);
  const real = p1.filter((f) => !f.interp).length / p1.length;
  close(real, 1 / 2, 0.01);
  assert.equal(v.cutoff, v.segments.eases[v.segments.eases.length - 1].start);
});
