// `?splats=<n>` (splatcap.ts, dev only): at most n splats per body, the most important first (opacity x footprint),
// moved to the front of the packed array with their SH words, so a headset run can find its frame budget live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capPacked, capSplats, importanceOf, topOrder, type PackedLike } from "../../src/court/splatcap.ts";

/** A fake PackedSplats: splat i's words are [i, i, i, i] and its SH1 words [100 + i, 200 + i]. */
function packed(n: number, opacity: (i: number) => number, scale: (i: number) => number): PackedLike {
  const words = new Uint32Array(n * 4);
  const sh1 = new Uint32Array(n * 2);
  for (let i = 0; i < n; i++) {
    words.fill(i, 4 * i, 4 * i + 4);
    sh1[2 * i] = 100 + i;
    sh1[2 * i + 1] = 200 + i;
  }
  return {
    numSplats: n,
    packedArray: words,
    extra: { sh1 },
    needsUpdate: false,
    forEachSplat(cb) {
      for (let i = 0; i < this.numSplats; i++) {
        const s = scale(i);
        cb(i, { x: 0, y: 0, z: 0 }, { x: s, y: s, z: s / 10 }, { x: 0, y: 0, z: 0, w: 1 }, opacity(i), { r: 1, g: 1, b: 1 });
      }
    },
  };
}

test("topOrder: the n most important, most important first; ties keep their order", () => {
  assert.deepEqual([...topOrder(new Float32Array([0.1, 0.9, 0.5, 0.9, 0.0]), 3)], [1, 3, 2]);
  assert.deepEqual([...topOrder(new Float32Array([1, 1, 1]), 5)], [0, 1, 2]);
  assert.deepEqual([...topOrder(new Float32Array([1, 2]), 0)], []);
});

test("importance: opacity times the footprint of the two largest scales", () => {
  const p = packed(3, (i) => [1, 0.5, 1][i], (i) => [0.01, 0.02, 0.02][i]);
  const imp = importanceOf(p);
  assert.ok(imp[2] > imp[1] && imp[1] > imp[0], `${[...imp]}`);
  assert.ok(Math.abs(imp[2] / imp[1] - 2) < 1e-6, "same size, twice the opacity");
});

test("capPacked keeps the n most important splats at the front, their SH words with them, and draws only those", () => {
  const p = packed(10, (i) => (i % 3 === 0 ? 1 : 0.001), (i) => 0.01 * (1 + i));
  const kept = capPacked(p, 4, importanceOf(p));
  assert.equal(kept, 4);
  assert.equal(p.numSplats, 4);
  assert.equal(p.needsUpdate, true);
  // splats 9, 6, 3, 0 are opaque (the rest nearly clear); by footprint 9 > 6 > 3 > 0
  const order = [0, 1, 2, 3].map((k) => p.packedArray![4 * k]);
  assert.deepEqual(order, [9, 6, 3, 0]);
  for (let k = 0; k < 4; k++) {
    assert.deepEqual([...p.packedArray!.subarray(4 * k, 4 * k + 4)], Array(4).fill(order[k]), "all four words move together");
    const sh1 = p.extra.sh1 as Uint32Array;
    assert.deepEqual([sh1[2 * k], sh1[2 * k + 1]], [100 + order[k], 200 + order[k]], "the SH words follow");
  }
});

test("capPacked leaves a body at or under n alone", () => {
  const p = packed(5, () => 1, () => 0.01);
  const before = [...p.packedArray!];
  assert.equal(capPacked(p, 5, importanceOf(p)), 5);
  assert.equal(p.needsUpdate, false);
  assert.deepEqual([...p.packedArray!], before);
});

test("capSplats caps every splat mesh under a root, and reports what it drew before and after", () => {
  const a = { packedSplats: packed(8, () => 1, (i) => 0.01 + i * 0.001) };
  const b = { packedSplats: packed(3, () => 1, () => 0.01) };
  const root = { traverse: (fn: (o: unknown) => void) => [root, a, { notSplats: true }, b].forEach(fn) };
  const r = capSplats(root, 5);
  assert.deepEqual(r, { meshes: 2, before: 11, after: 8 });
  assert.equal(a.packedSplats.numSplats, 5);
  assert.equal(b.packedSplats.numSplats, 3);
  assert.throws(() => capSplats(root, 0));
  assert.throws(() => capSplats(root, Number.NaN));
});
