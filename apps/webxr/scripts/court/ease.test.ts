// The ease scenario's picture spike (scenarios/ease.mjs changeSpike): a display frame counts as a spike only when its
// change is both over 2.5 x the ease's median and at least 1 grey level (P44's bar), so real footage's slow sub-grey
// drift near F never flags, and a real pop still does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changeSpike } from "./scenarios/ease.mjs";

const CELLS = 16 * 9;
/** Thumbnails whose mean absolute change from one to the next is `steps[i]` grey levels (every cell moves alike). */
const thumbs = (steps: number[]) => {
  const out = [new Array(CELLS).fill(100)];
  for (const s of steps) out.push(out.at(-1)!.map((v: number) => v + s));
  return out;
};

test("the change per display frame is the thumbnail's mean absolute luma change", () => {
  const r = changeSpike(thumbs([0.5, 0.25, 1]));
  assert.deepEqual(r.change, [0.5, 0.25, 1]);
  assert.equal(r.median, 0.5);
  assert.equal(r.max, 1);
});

test("slow footage under 1 grey level a frame is no spike, whatever the ratio", () => {
  const r = changeSpike(thumbs([0.16, 0.12, 0.16, 0.2, 0.48, 0.16, 0.1, 0.16]));
  assert.ok(r.max / r.median > 2.5);
  assert.equal(r.spike, false);
});

test("a pop of a grey level or more over 2.5 x the median is a spike", () => {
  assert.equal(changeSpike(thumbs([0.16, 0.12, 0.16, 1.9, 0.16, 0.1, 0.16])).spike, true);
  assert.equal(changeSpike(thumbs([2, 2.2, 1.8, 9, 2, 2.1])).spike, true);
});

test("a big change in step with the rest is no spike", () => {
  assert.equal(changeSpike(thumbs([2, 2.2, 1.8, 4.5, 2, 2.1])).spike, false);
});
