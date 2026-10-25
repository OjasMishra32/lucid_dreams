// floortone.ts: the clean floor's colours, measured once from the real floor (court/floor.jpg where floor-seen.png
// marks it filmed): the wood as the median off the lanes and the centre circle (so a logo, a painted-on sign or a
// smeared band can't tint it), the lanes' paint as their own median, and the boards' tone spread across them.
//   node --experimental-transform-types --test apps/webxr/scripts/court/floortone.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_TEXELS, floorTones } from "../../src/court/floortone.ts";

const L = 28.65;
const W = 15.24;
// 0.05 m texels, rows along +z from -W/2 (floor.jpg's layout as the floor shader reads it)
const NX = 573;
const NZ = 305;
const WOOD = [163, 153, 141];
const PAINT = [38, 69, 92];

/** A synthetic floor: wood with a tone per 57 mm board (std `tone`), both lanes painted, a blue and white logo in the
 * centre circle, a green band along one sideline; seen where `seen(x, z)` says. RGBA bytes, as a canvas reads them. */
function floor(seen: (x: number, z: number) => boolean, tone = 0.05) {
  const rgb = new Uint8ClampedArray(NX * NZ * 4);
  const mask = new Uint8ClampedArray(NX * NZ * 4);
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const boardTone = Array.from({ length: Math.ceil(W / 0.057) + 1 }, () => 1 + (rand() - 0.5) * 3.4641 * tone);
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NX; i++) {
      const x = (i + 0.5) * (L / NX) - L / 2;
      const z = (j + 0.5) * (W / NZ) - W / 2;
      let c = WOOD.map((v) => v * boardTone[Math.floor((z + W / 2) / 0.057)]);
      if (Math.abs(x) >= L / 2 - 5.79 && Math.abs(z) <= 2.44) c = PAINT;
      if (Math.hypot(x, z) < 1.7) c = Math.hypot(x, z) < 1.0 ? [30, 60, 120] : [235, 235, 230];
      if (z > W / 2 - 0.6) c = [60, 140, 70];
      const o = (j * NX + i) * 4;
      rgb.set([...c, 255], o);
      mask.set(seen(x, z) ? [255, 255, 255, 255] : [0, 0, 0, 255], o);
    }
  return { rgb, mask };
}
const near = (a: readonly number[] | null, b: number[], eps: number, what: string) => {
  assert.ok(a, `${what}: measured`);
  a.forEach((v, k) => assert.ok(Math.abs(v * 255 - b[k]) <= eps, `${what}[${k}]: ${(v * 255).toFixed(1)} vs ${b[k]}`));
};

test("the wood is the seen floor's median off the lanes and the centre circle: no logo, sign or band tints it", () => {
  // a third of the court seen, the logo, one lane and the green band inside it (as the real floor has them)
  const { rgb, mask } = floor((x, z) => x > -4 && z > -2);
  const t = floorTones(rgb, mask, NX, NZ, L, W);
  near(t.wood, WOOD, 3, "wood");
  near(t.paint, PAINT, 1, "paint");
  assert.ok(t.tone >= 0.03 && t.tone <= 0.07, `board tone ${t.tone} (made with 0.05)`);
});

test("the median holds with the band a larger share of the seen wood (about a twelfth)", () => {
  const { rgb, mask } = floor((x, z) => x > -4 && z > 0.5);
  const t = floorTones(rgb, mask, NX, NZ, L, W);
  near(t.wood, WOOD, 4, "wood");
});

test("nothing seen: no wood and no paint (the bundle's hardwood and the rulebook's paint stand), the rulebook's tone", () => {
  const { rgb, mask } = floor(() => false);
  const t = floorTones(rgb, mask, NX, NZ, L, W);
  assert.equal(t.wood, null);
  assert.equal(t.paint, null);
  assert.equal(t.tone, 0.05);
});

test(`a lane seen on fewer than ${MIN_TEXELS} texels keeps the rulebook's paint`, () => {
  const { rgb, mask } = floor((x, z) => x > -4 && x < L / 2 - 5.79 + 0.1 && z > -2);
  const t = floorTones(rgb, mask, NX, NZ, L, W);
  assert.ok(t.wood);
  assert.equal(t.paint, null);
});
