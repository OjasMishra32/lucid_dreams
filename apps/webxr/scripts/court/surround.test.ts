// surround.ts, the parts that run without a GPU: the imagined bowl's layout round the court (beyond the apron, behind
// the footage's stands proxy), its merged geometry (crowd tiles at real scale on the tiers, painter's order, facing
// the court, randomised per section) and camera F's far image as a pinhole camera.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Court, SurroundCrowd, SurroundFar } from "../../src/court/format.ts";
import { APRON_M, BOWL_KIND, LOWER, UPPER, bowlArrays, bowlLayout, farCamera, insideBowl, ringPoints } from "../../src/court/surround.ts";
import { project } from "../../src/court/camera.ts";
import { FIXTURE } from "./standin.mjs";

const court = (): Court => JSON.parse(readFileSync(FIXTURE, "utf8"));
const crowd: SurroundCrowd = {
  atlas: "surround/crowd.jpg", width: 1024, height: 512, pxPerM: 80,
  tiles: [[0, 0, 400, 160], [404, 0, 804, 160], [0, 164, 560, 324], [564, 164, 884, 324], [0, 328, 320, 488]],
};

test("the bowl starts beyond the apron on every side, with rounded corners", () => {
  const c = court();
  const l = bowlLayout(c);
  const hl = c.court.length / 2 + APRON_M;
  const hw = c.court.width / 2 + APRON_M;
  assert.ok(l.x1 > hl && -l.x0 > hl, `ends ${l.x0} ${l.x1} past the apron ${hl}`);
  assert.ok(l.z1 > hw && -l.z0 > hw, `sides ${l.z0} ${l.z1} past the apron ${hw}`);
  assert.ok(l.r > 1 && l.r <= Math.min(l.x1 - l.x0, l.z1 - l.z0) / 2);
});

test("a stands proxy plane farther out than the bowl's front pushes that end back behind it (the far image owns the space in front)", () => {
  const c = court();
  const base = bowlLayout(c);
  c.freeze.stands.proxy = [
    { kind: "plane", points: [[18.2, 0, -8], [18.2, 0, 8], [18.2, 3, 8], [18.2, 3, -8]] },
    { kind: "plane", points: [[19.4, 3, -8], [19.4, 3, 8], [19.4, 11, 8], [19.4, 11, -8]] },
  ];
  const l = bowlLayout(c);
  assert.ok(l.x1 >= 18.2 && l.x1 < 18.4, `the +x end at the nearest plane, got ${l.x1}`);
  assert.equal(l.x0, base.x0);
  assert.equal(l.z0, base.z0);
  assert.equal(l.z1, base.z1);
  // a plane nearer than the default front leaves the default
  c.freeze.stands.proxy = [{ kind: "plane", points: [[16, 0, -16], [16, 0, 16], [16, 9, 16], [16, 9, -16]] }];
  assert.equal(bowlLayout(c).x1, base.x1);
});

test("a ring round the bowl is closed, offset evenly outward, and never cuts inside the inner edge", () => {
  const l = bowlLayout(court());
  for (const o of [0, 5, 16]) {
    const pts = ringPoints(l, o);
    assert.deepEqual(pts[0], pts.at(-1));
    for (const [x, z] of pts) {
      // distance outside the inner rounded rectangle
      const qx = Math.max(l.x0 + l.r - x, 0, x - (l.x1 - l.r));
      const qz = Math.max(l.z0 + l.r - z, 0, z - (l.z1 - l.r));
      const d = Math.hypot(qx, qz) - l.r;
      assert.ok(Math.abs(d - o) < 1e-6, `offset ${o}: point ${x}, ${z} at ${d}`);
    }
  }
});

test("insideBowl is true on the court and apron, false past the bowl's front", () => {
  const c = court();
  const l = bowlLayout(c);
  assert.ok(insideBowl(l, 0, 0));
  assert.ok(insideBowl(l, c.court.length / 2 + APRON_M, c.court.width / 2 + APRON_M - 0.5));
  assert.ok(!insideBowl(l, l.x1 + 0.1, 0));
  assert.ok(!insideBowl(l, 0, l.z0 - 0.1));
  assert.ok(!insideBowl(l, l.x1 - 0.2, l.z1 - 0.2)); // the rounded corner
});

/** Per quad (4 vertices, 6 indices, in index order): kind, the info and tile attributes, its corners. */
function quads(a: ReturnType<typeof bowlArrays>) {
  const out = [];
  for (let i = 0; i < a.index.length; i += 6) {
    const v = a.index[i];
    const corners = [0, 1, 2, 3].map((k) => [a.position[3 * (v + k)], a.position[3 * (v + k) + 1], a.position[3 * (v + k) + 2]]);
    out.push({ v, kind: a.info[4 * v], info: Array.from(a.info.subarray(4 * v, 4 * v + 4)), tile: Array.from(a.tile.subarray(4 * v, 4 * v + 4)), corners, surf: [0, 1, 2, 3].map((k) => [a.surf[2 * (v + k)], a.surf[2 * (v + k) + 1]]) });
  }
  return out;
}

test("the lower bowl: 20 tiers of 0.85 m tread and 0.4 m rise, crowd tiles at real scale on every tier, each tier one tile row", () => {
  const c = court();
  const a = bowlArrays(c, crowd, 3);
  const lower = quads(a).filter((q) => q.kind === BOWL_KIND.crowd);
  assert.equal(LOWER.rows, 20);
  assert.equal(LOWER.tread, 0.85);
  assert.equal(LOWER.rise, 0.4);
  const bottoms = [...new Set(lower.map((q) => Math.min(...q.corners.map((p) => p[1])).toFixed(3)))].map(Number).sort((x, y) => x - y);
  assert.equal(bottoms.length, LOWER.rows);
  bottoms.forEach((y, r) => assert.ok(Math.abs(y - (LOWER.firstTread + r * LOWER.rise)) < 1e-4, `tier ${r} at ${y}`));
  // every quad's atlas rect lies inside one of the tiles (inset), mirrored or not; its rows-per-tile from the tile's height
  const { width: W, height: H, pxPerM } = crowd;
  for (const q of lower) {
    const [u0, v0, u1, v1] = q.tile;
    const xs = [Math.min(u0, u1) * W, Math.max(u0, u1) * W];
    const ys = [(1 - Math.max(v0, v1)) * H, (1 - Math.min(v0, v1)) * H];
    const t = crowd.tiles.findIndex((b) => xs[0] >= b[0] && xs[1] <= b[2] && ys[0] >= b[1] && ys[1] <= b[3]);
    assert.ok(t >= 0, `quad's rect ${xs} ${ys} inside a tile`);
    const b = crowd.tiles[t];
    assert.equal(q.info[2], Math.max(1, Math.round((b[3] - b[1]) / pxPerM / LOWER.rise)), "rows per tile");
    assert.ok(q.info[1] >= 0 && q.info[1] < q.info[2] && Number.isInteger(q.info[1]), "the tier's row in its tile");
  }
  // real scale along the row: a whole tile spans its own width in metres
  const byTile = new Map<number, number>();
  for (const q of lower) {
    const len = Math.hypot(q.corners[1][0] - q.corners[0][0], q.corners[1][2] - q.corners[0][2]);
    const du = Math.abs(q.surf[1][0] - q.surf[0][0]);
    if (du > 0.2) byTile.set(Math.abs(q.tile[2] - q.tile[0]) * W, len / du);
  }
  for (const [px, m] of byTile) assert.ok(Math.abs(m - px / pxPerM) < 0.02 * (px / pxPerM), `a ${px} px tile spans ${m} m`);
});

test("tiles are chosen at random per section, both ways round, with a little brightness variation", () => {
  const a = bowlArrays(court(), crowd, 3);
  const lower = quads(a).filter((q) => q.kind === BOWL_KIND.crowd);
  const keys = new Set(lower.map((q) => q.tile.map((x) => x.toFixed(4)).join()));
  assert.ok(keys.size >= crowd.tiles.length * 2 - 1, `${keys.size} distinct (tile, mirror)`);
  assert.ok(lower.some((q) => q.tile[0] > q.tile[2]) && lower.some((q) => q.tile[0] < q.tile[2]), "mirrored and not");
  const shades = lower.map((q) => q.info[3]);
  assert.ok(Math.min(...shades) >= 0.9 && Math.max(...shades) <= 1.1 && Math.max(...shades) - Math.min(...shades) > 0.1);
  // deterministic for a seed, different for another
  assert.deepEqual(bowlArrays(court(), crowd, 3).tile, a.tile);
  assert.notDeepEqual(bowlArrays(court(), crowd, 4).tile, a.tile);
});

test("a few tiers in a row share their tiles: on a straight their columns line up and each shows the next row up", () => {
  const c = court();
  const l = bowlLayout(c);
  const a = bowlArrays(c, crowd, 5);
  // the +z side's straight, tiers 0 and 1 (every test tile holds 5 rows at 0.4 m: a group of 5)
  const side = quads(a).filter((q) => q.kind === BOWL_KIND.crowd && q.corners.every((p) => p[2] > l.z1 + 0.1 && p[0] < l.x1 - l.r + 1e-6 && p[0] > l.x0 + l.r - 1e-6));
  const at = (r: number) => side.filter((q) => Math.abs(Math.min(...q.corners.map((p) => p[1])) - (LOWER.firstTread + r * LOWER.rise)) < 1e-4);
  const [t0, t1] = [at(0), at(1)];
  assert.ok(t0.length > 3 && t0.length === t1.length, `${t0.length} and ${t1.length} quads`);
  t0.forEach((q, i) => {
    assert.deepEqual(q.tile, t1[i].tile, "the same tile, the same way round");
    assert.ok(Math.abs(q.corners[0][0] - t1[i].corners[0][0]) < 1e-4, "the same column");
    assert.equal(t1[i].info[1], q.info[1] + 1, "the next row up");
  });
});

test("drawn back to front (the bowl writes no depth): the roof first, the upper deck, then the lower tiers outermost first", () => {
  const a = bowlArrays(court(), crowd, 1);
  const q = quads(a);
  const first = (k: number) => q.findIndex((x) => x.kind === k);
  assert.equal(q[0].kind, BOWL_KIND.roof);
  assert.ok(first(BOWL_KIND.upper) < first(BOWL_KIND.crowd));
  const lower = q.filter((x) => x.kind === BOWL_KIND.crowd).map((x) => Math.min(...x.corners.map((p) => p[1])));
  for (let i = 1; i < lower.length; i++) assert.ok(lower[i] <= lower[i - 1] + 1e-6, "lower tiers drawn top (outer) to bottom (inner)");
  const upper = q.filter((x) => x.kind === BOWL_KIND.upper).map((x) => Math.min(...x.corners.map((p) => p[1])));
  for (let i = 1; i < upper.length; i++) assert.ok(upper[i] <= upper[i - 1] + 1e-6);
  assert.ok(UPPER.rows >= 10);
});

test("every tier, wall and board faces the court (front faces only), the roof faces down, and nothing stands on the court or apron", () => {
  const c = court();
  const a = bowlArrays(c, crowd, 1);
  const l = bowlLayout(c);
  for (let i = 0; i < a.index.length; i += 3) {
    const [p, q, r] = [a.index[i], a.index[i + 1], a.index[i + 2]].map((v) => [a.position[3 * v], a.position[3 * v + 1], a.position[3 * v + 2]]);
    const kind = a.info[4 * a.index[i]];
    const scoreboard = kind === BOWL_KIND.board || kind === BOWL_KIND.screen || (kind === BOWL_KIND.led && a.info[4 * a.index[i] + 1] === 2);
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const g = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3];
    if (kind === BOWL_KIND.roof) assert.ok(n[1] < 0, "the roof faces down");
    else if (scoreboard) assert.ok(n[0] * g[0] + n[1] * (g[1] - 16) + n[2] * g[2] > 0, "the scoreboard faces out");
    else {
      assert.ok(n[0] * -g[0] + n[2] * -g[2] > 0, `kind ${kind} faces the court`);
      assert.ok(!insideBowl(l, g[0], g[2]) || Math.hypot(Math.max(l.x0 + l.r - g[0], 0, g[0] - (l.x1 - l.r)), Math.max(l.z0 + l.r - g[2], 0, g[2] - (l.z1 - l.r))) - l.r > -1e-3, "outside the court and apron");
    }
  }
});

test("without crowd tiles the bowl is still built (a procedural crowd, the same tiers)", () => {
  const a = bowlArrays(court(), null, 1);
  const lower = quads(a).filter((q) => q.kind === BOWL_KIND.crowd);
  assert.ok(lower.length > 100);
  assert.ok(lower.every((q) => q.tile.every((x) => x === 0)));
});

test("the far image is a pinhole camera at camera F's centre and rotation with its own intrinsics", () => {
  const c = court();
  const frames = [{ src: 0, interp: false, q: [0.1, 0.7, -0.1, 0.7] as [number, number, number, number], f: 20000 }];
  const n = Math.hypot(...frames[0].q);
  frames[0].q = frames[0].q.map((x) => x / n) as [number, number, number, number];
  const far: SurroundFar = { image: "a.jpg", alpha: "a.png", frame: 0, f: 5000, cx: 1100, cy: 600, width: 2048, height: 1280 };
  const cam = farCamera(c, frames, far);
  assert.deepEqual(cam.centre, c.camera.centre);
  assert.deepEqual(cam.q, frames[0].q);
  assert.equal(cam.f, 5000);
  // the optical axis lands on the principal point
  const ax = [0, 0, 1];
  const [x, y, z, w] = cam.q;
  const tx = 2 * (y * ax[2] - z * ax[1]), ty = 2 * (z * ax[0] - x * ax[2]), tz = 2 * (x * ax[1] - y * ax[0]);
  const d = [ax[0] + w * tx + (y * tz - z * ty), ax[1] + w * ty + (z * tx - x * tz), ax[2] + w * tz + (x * ty - y * tx)];
  const px = project(cam, [c.camera.centre[0] + 10 * d[0], c.camera.centre[1] + 10 * d[1], c.camera.centre[2] + 10 * d[2]])!;
  assert.ok(Math.abs(px[0] - 1100) < 1e-6 && Math.abs(px[1] - 600) < 1e-6);
});
