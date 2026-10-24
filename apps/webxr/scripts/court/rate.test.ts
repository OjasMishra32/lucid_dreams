// rate.ts: the headset's display rate against the show's. court.ts asks the session for the show's own rate whenever
// the session offers it, and judges the rate it then runs at: frame for frame, the bundle's 90 Hz bake (a headset that
// can't run the show's rate but can run 90), or a mismatch played through the clock's cadence and reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeRate, wantRate } from "../../src/court/rate.ts";

test("the show's rate is asked for when the session offers it, as the session's own number", () => {
  assert.equal(wantRate(72, [72, 80, 90, 120]), 72);
  assert.equal(wantRate(90, Float32Array.of(72, 90)), 90);
  assert.equal(wantRate(72, [71.9, 90]), 71.9); // updateTargetFrameRate takes exactly one of supportedFrameRates
});

test("nothing is asked for when the session can't run the show's rate or lists no rates", () => {
  assert.equal(wantRate(72, [90, 120]), null);
  assert.equal(wantRate(72, []), null);
  assert.equal(wantRate(72, null), null);
  assert.equal(wantRate(72, undefined), null);
});

test("a session at the show's rate plays frame for frame", () => {
  assert.equal(judgeRate(72, 72, [72, 90], 90), "matched");
  assert.equal(judgeRate(72, 72.02, [72.02], null), "matched");
  assert.equal(judgeRate(90, 90, [72, 90], null), "matched"); // already on the 90 Hz bake
});

test("a headset that can't run the show's rate takes the 90 Hz bake when it can run 90", () => {
  assert.equal(judgeRate(72, 90, [90, 120], 90), "hz90");
  assert.equal(judgeRate(72, 120, [90, 120], 90), "hz90"); // at 120 now, but 90 is on offer
});

test("otherwise the rate is a mismatch: the clock's cadence plays it, and court.ts says so", () => {
  assert.equal(judgeRate(72, 90, [90, 120], null), "mismatch"); // no 90 Hz bake in the bundle
  assert.equal(judgeRate(72, 120, [120], 90), "mismatch"); // the bake is there, the headset can't run 90
  assert.equal(judgeRate(72, 90, [72, 90], null), "mismatch"); // 72 on offer but refused
});

test("a session that reports no rate is unknown (the clock estimates it from the frame times)", () => {
  assert.equal(judgeRate(72, undefined, undefined, 90), "unknown");
  assert.equal(judgeRate(72, null, [72], null), "unknown");
  assert.equal(judgeRate(72, 0, [72], null), "unknown");
});
