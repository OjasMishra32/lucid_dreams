// lightfield.ts: the one light field (3.3, 3.3a). The levels (court.json `light`, both sets), the beats, the pool's
// shape and growth, and P44's bar on the CPU twin of the GLSL: no light change faster than 1 grey level per display
// frame at 72 Hz on any surface up to SAFE_LUMA.
//   node --experimental-transform-types --test apps/webxr/scripts/court/lightfield.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";
import {
  BACK_DONE_S, CROWD_DIM_S, FLOOR_DIM_S, LightField, OPEN_DONE_S, PART, POOL_START_S, SAFE_LUMA,
  REACH_FALLOFF_M, VEIL, VEIL_S, edgeLevel, lightLevels, perceived, reachAt, reachPlanes, roomCurves, veil, whitePoint,
  type Beat,
} from "../../src/court/lightfield.ts";
import type { Court, CourtBundle } from "../../src/court/format.ts";
import { standinBundle } from "./standin.mjs";

const HZ = 72;
const bundleOf = (edit?: (c: Record<string, unknown>) => void): CourtBundle => {
  const { court, frames } = structuredClone(standinBundle()) as { court: Record<string, unknown>; frames: unknown[] };
  edit?.(court);
  return { base: "", court, frames, file: (p: string) => p } as unknown as CourtBundle;
};
const close = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
/** The floor's perceived level at (x, z). */
const p = (f: LightField, x: number, z: number, reach = 1) => perceived(f.at(x, z, PART.floor, reach));
/** The stand-in's levels (court.json `light`, the tuned set). */
const TUNED = (standinBundle() as { court: Court }).court.light;

test("levels: court.json's light block, its alternative on request; the penumbra never below 1.5 m", () => {
  const b = bundleOf((c) => (c.light = { crowd: 0.5, floor: 0.25, pair: 1, stands: 0.7, penumbra: 1.2, alternative: { crowd: 0.2, floor: 0.1 } }));
  assert.deepEqual(lightLevels(b.court), { crowd: 0.5, floor: 0.25, pair: 1, stands: 0.7, penumbra: 1.5 });
  assert.deepEqual(lightLevels(b.court, "alternative"), { crowd: 0.2, floor: 0.1, pair: 1, stands: 0.7, penumbra: 1.5 });
  // court.json alone (court.ts) and the bundle (frames: camera F's own ray) agree on the seat's side of the pair
  const fromCourt = new LightField(b.court);
  const fromBundle = new LightField(b);
  assert.ok(fromCourt.axis[0] * fromBundle.axis[0] + fromCourt.axis[1] * fromBundle.axis[1] > 0.99, "same ray within 8 deg");
  fromCourt.fitFrames(b.frames);
  close(fromCourt.axis[0], fromBundle.axis[0], 1e-12, "fitFrames gives the bundle's ray");
});

test("shared: one field per bundle", () => {
  const b = bundleOf();
  assert.equal(LightField.shared(b), LightField.shared(b));
  assert.notEqual(LightField.shared(b), LightField.shared(bundleOf()));
});

test("watch: the broadcast, everything at 1 on the footage's own surfaces", () => {
  const f = new LightField(bundleOf());
  f.set("watch", 0);
  for (const [x, z] of [[6, 1], [0, 0], [-10, 5], [12, -6]]) close(f.at(x, z), 1, 1e-9, `floor at ${x},${z}`);
  close(f.crowd(), 1, 1e-9, "crowd");
  close(f.pair(), 1, 1e-9, "pair");
  // the rendered court's darkness falloff passes straight through, except in the spot on the pair
  close(p(f, -10, 5, 0.25), 0.25, 1e-9, "dark rendered court");
  close(p(f, 6, 1, 0.25), 1, 1e-9, "the spot on the pair");
});

test("ease and open: the crowd lands on 0.45 at the end of the 1.2 s ease, the floor outside the pool on 0.30 by F+1, the pair never moves", () => {
  const b = bundleOf();
  const f = new LightField(b);
  const [cx, , cz] = b.court.seat.pairCentre;
  const ease = 1.2;
  let pairMax = 0;
  for (let i = 0; i <= ease * HZ; i++) {
    f.set("ease", i / HZ);
    pairMax = Math.max(pairMax, Math.abs(perceived(f.pair()) - 1), Math.abs(p(f, cx, cz) - 1));
  }
  close(perceived(f.crowd()), TUNED.crowd, 1e-3, "crowd at F (the ease's last frame, within 0.25 grey levels)");
  assert.ok(CROWD_DIM_S <= ease + 1e-9, "the crowd dims over the ease (P28)");
  for (let i = 0; i <= OPEN_DONE_S * HZ; i++) {
    f.set("handoff", i / HZ);
    pairMax = Math.max(pairMax, Math.abs(perceived(f.pair()) - 1), Math.abs(p(f, cx, cz) - 1));
  }
  f.set("handoff", POOL_START_S);
  close(p(f, -12, -7), TUNED.floor, 1e-3, "floor outside the pool at F+1");
  assert.equal(pairMax, 0, "the pair and the floor under them stay at exactly 1 (P28)");
});

test("the dark set: 0.16 / 0.14 at the freeze", () => {
  const f = new LightField(bundleOf(), { set: "alternative" });
  f.set("ease", 10);
  close(perceived(f.crowd()), 0.16, 1e-6, "crowd");
  f.set("handoff", POOL_START_S);
  close(p(f, -12, -7), 0.14, 1e-6, "floor");
});

/** The whole show's light at 72 Hz for one ease length: [beat, t] per display frame. */
function timeline(ease: number): [Beat, number][] {
  const out: [Beat, number][] = [["watch", 0]];
  for (let i = 0; i < Math.round(ease * HZ); i++) out.push(["ease", i / HZ]);
  for (let i = 0; i <= OPEN_DONE_S * HZ + 10; i++) out.push(["handoff", i / HZ]);
  for (let i = 0; i <= BACK_DONE_S * HZ + 10; i++) out.push(["return", i / HZ]);
  for (let i = 0; i <= (0.25 + FLOOR_DIM_S) * HZ + 10; i++) out.push(["resume", i / HZ]);
  return out;
}

test("P44: no light change faster than 1 grey level per display frame on surfaces up to SAFE_LUMA, every ease", () => {
  const b = bundleOf();
  const [cx, , cz] = b.court.seat.pairCentre;
  // a grid over the court and its apron, at three darkness-falloff values (the footage's own floor is reach 1)
  const pts: [number, number, number][] = [];
  for (let x = -16; x <= 16; x += 0.5) for (let z = -9; z <= 9; z += 0.5) for (const r of [1, 0.6, 0]) pts.push([x, z, r]);
  for (let d = 0; d <= 8; d += 0.05) pts.push([cx - d, cz - 0.4 * d, 0]); // toward the seat, finely
  for (const ease of [1.2, 1.0, 0.8]) {
    const f = new LightField(b);
    let worstFloor = 0;
    let worstCrowd = 0;
    let prev: number[] | null = null;
    let prevCrowd = 1;
    for (const [beat, t] of timeline(ease)) {
      f.set(beat, t);
      const now = pts.map(([x, z, r]) => p(f, x, z, r));
      if (prev) for (let i = 0; i < now.length; i++) worstFloor = Math.max(worstFloor, Math.abs(now[i] - prev[i]));
      const c = perceived(f.crowd());
      worstCrowd = Math.max(worstCrowd, Math.abs(c - prevCrowd));
      prev = now;
      prevCrowd = c;
    }
    assert.ok(worstFloor * SAFE_LUMA.floor <= 1, `ease ${ease}: floor step ${(worstFloor * SAFE_LUMA.floor).toFixed(3)} grey levels at luma ${SAFE_LUMA.floor}`);
    assert.ok(worstCrowd * SAFE_LUMA.crowd <= 1, `ease ${ease}: crowd step ${(worstCrowd * SAFE_LUMA.crowd).toFixed(3)} grey levels at luma ${SAFE_LUMA.crowd}`);
  }
  // the stand-in's hardwood is inside the bar
  const [r, g, bl] = b.court.court.hardwood;
  assert.ok(255 * (0.2126 * r + 0.7152 * g + 0.0722 * bl) <= SAFE_LUMA.floor, "hardwood luma under SAFE_LUMA.floor");
});

test("the pool grows nearest the pair first, then covers the footprint, the lane to the seat and every spot", () => {
  const b = bundleOf();
  const f = new LightField(b);
  const [cx, , cz] = b.court.seat.pairCentre;
  f.set("ease", 1.2);
  const seat = f.seatFloor;
  const dir = [seat[0] - cx, seat[2] - cz];
  const len = Math.hypot(dir[0], dir[1]);
  close(len, b.court.seat.distance, 1e-6, "seat at D' from the pair");
  // when each point along the lane (reach 0: the darkest start) first passes half way
  // along the lane the filmed floor gives way to the rendered court's darkness (reach 1 at the pair, 0 at the seat);
  // each point's time to come half way up from where the house left it; points the spot on the pair holds are skipped
  const halfway: number[] = [];
  for (let d = 0.5; d <= len; d += 0.5) {
    const x = cx + (dir[0] / len) * d;
    const z = cz + (dir[1] / len) * d;
    const reach = 1 - d / len;
    f.set("handoff", POOL_START_S);
    const from = p(f, x, z, reach);
    if (from >= 0.9) continue;
    const mid = (from + 1) / 2;
    let t = POOL_START_S;
    for (; t <= OPEN_DONE_S; t += 1 / HZ) {
      f.set("handoff", t);
      if (p(f, x, z, reach) >= mid) break;
    }
    halfway.push(t);
  }
  assert.ok(halfway.length >= 4, `${halfway.length} lane points outside the spot`);
  for (let i = 1; i < halfway.length; i++) assert.ok(halfway[i] >= halfway[i - 1], `nearest first: ${halfway.map((t) => t.toFixed(2)).join(" ")}`);
  assert.ok(halfway[0] >= POOL_START_S, "the pool starts growing at F+1");
  assert.ok(halfway[halfway.length - 1] - halfway[0] >= 0.8, `the pool visibly grows: ${halfway.map((t) => t.toFixed(2)).join(" ")}`);
  f.set("handoff", OPEN_DONE_S);
  close(p(f, seat[0], seat[2], 0), 1, 1e-6, "the seat is lit");
  // the walking floor round the pair (the walking anchoring puts the pair at the room's centre): every point within
  // 2 m of the pair's centre, where the judge walks, is lit
  for (let a = 0; a < 360; a += 30) {
    const r = (a * Math.PI) / 180;
    close(p(f, cx + 2 * Math.cos(r), cz + 2 * Math.sin(r), 0), 1, 1e-6, `2 m from the pair at ${a} deg`);
  }
  close(p(f, cx, cz, 0), 1, 1e-6, "the pair's floor");
});

test("the pool's edge is soft (penumbra >= 1.5 m), falls to dark beyond, and never opens the whole floor", () => {
  const b = bundleOf();
  const f = new LightField(b);
  f.set("ease", 1.2);
  f.set("handoff", OPEN_DONE_S);
  const [cx, , cz] = b.court.seat.pairCentre;
  const lit = 0.99;
  const dark = TUNED.floor * 0.5 + 0.001; // reach 0.5 outside
  // walk out from the pair across the camera axis until lit ends, then measure how far it takes to reach the dark
  const ax = f.axis; // unit, pair -> seat
  const across = [-ax[1], ax[0]];
  let litEnd = -1;
  let darkStart = -1;
  for (let d = 0; d < 20; d += 0.01) {
    const v = p(f, cx + across[0] * d, cz + across[1] * d, 0.5);
    if (litEnd < 0 && v < lit) litEnd = d;
    if (darkStart < 0 && v <= dark) darkStart = d;
  }
  assert.ok(litEnd > 0 && darkStart > 0, `lit to ${litEnd}, dark from ${darkStart}`);
  assert.ok(darkStart - litEnd >= 1.5 - 0.02, `penumbra ${(darkStart - litEnd).toFixed(2)} m`);
  let litArea = 0;
  let all = 0;
  for (let x = -14.3; x <= 14.3; x += 0.25)
    for (let z = -7.6; z <= 7.6; z += 0.25) {
      all++;
      if (p(f, x, z, 0.5) > 0.5) litArea++;
    }
  assert.ok(litArea / all < 0.35, `lit share of the court ${(litArea / all).toFixed(2)}`);
});

test("stands: 0.45 at the freeze, rising to 0.6 over F+3..F+5, steadily", () => {
  const f = new LightField(bundleOf());
  f.set("ease", 1.2);
  let prev = 0;
  for (let t = 0; t <= OPEN_DONE_S + 0.01; t += 1 / HZ) {
    f.set("handoff", t);
    const c = perceived(f.crowd());
    if (t <= 3) close(c, TUNED.crowd, 1e-6, `crowd at F+${t.toFixed(2)}`);
    assert.ok(c >= prev - 1e-12, "never dips");
    prev = c;
  }
  close(prev, TUNED.stands, 1e-6, "stands at F+5");
});

test("back: the stands go down and the pool gathers onto the pair; resume: the house comes up 0.25 s after play", () => {
  const b = bundleOf();
  const f = new LightField(b);
  const seat = f.seatFloor;
  f.set("ease", 1.2);
  f.set("handoff", OPEN_DONE_S);
  f.set("return", BACK_DONE_S);
  close(perceived(f.crowd()), TUNED.crowd, 1e-6, "crowd back down");
  close(p(f, seat[0], seat[2], 0), 0, 1e-6, "the lane is dark again (reach 0)");
  const [cx, , cz] = b.court.seat.pairCentre;
  close(p(f, cx, cz), 1, 1e-9, "the pair's spot stays");
  f.set("resume", 0.25);
  close(perceived(f.crowd()), TUNED.crowd, 1e-6, "not before 0.25 s");
  f.set("resume", 0.25 + FLOOR_DIM_S);
  close(perceived(f.crowd()), 1, 1e-9, "crowd up");
  close(p(f, -12, -7), 1, 1e-9, "floor up");
});

test("a jump into the open world (See my room mid-ease) lands every level", () => {
  const f = new LightField(bundleOf());
  f.set("ease", 0.3);
  f.set("handoff", OPEN_DONE_S);
  close(perceived(f.crowd()), TUNED.stands, 1e-6, "stands");
  close(p(f, -12, -7), TUNED.floor, 1e-6, "floor outside the pool");
});

test("arrival: everything rises out of black together", () => {
  const f = new LightField(bundleOf());
  f.set("dark", 0);
  close(f.at(6, 1), 0, 1e-12, "floor");
  close(f.crowd(), 0, 1e-12, "crowd");
  close(f.pair(), 0, 1e-12, "pair");
  f.set("arrival", 1.25);
  close(perceived(f.pair()), 0.5, 1e-12, "half way up, linearly (P44)");
  f.set("arrival", 2.5);
  close(f.pair(), 1, 1e-12, "pair at the end");
});

test("frame: the GLSL's court-from-world matrix is the world group's inverse", () => {
  const f = new LightField(bundleOf());
  const g = new THREE.Group();
  g.position.set(1.5, 0, -2);
  g.rotation.y = 0.7;
  g.updateMatrixWorld(true);
  f.frame(g);
  const m = new THREE.Matrix4().fromArray(Array.from((f.uniforms.uLightCourtFromWorld.value as { elements: ArrayLike<number> }).elements));
  const court = new THREE.Vector3(3, 0.5, -1);
  const back = court.clone().applyMatrix4(g.matrixWorld).applyMatrix4(m);
  close(back.distanceTo(court), 0, 1e-9, "round trip");
});

test("the GLSL names every function the materials call", () => {
  const f = new LightField(bundleOf());
  for (const fn of ["float lightFloor(vec2 xz, float reach)", "float lightCrowd()", "float lightPair()", "float lightAt(vec2 foot)", "vec3 lightDither(vec3 rgb)"])
    assert.ok(f.glsl.includes(fn), fn);
  assert.ok(f.glsl.includes("float courtLight(vec3 worldPos, float part)"), "the integrator's courtLight");
  assert.ok(f.glslVertex.includes("vec3 lightCourt(vec4 worldPos)"));
  for (const name of Object.keys(f.uniforms)) assert.ok(f.glsl.includes(name) || f.glslVertex.includes(name), `uniform ${name} declared`);
});

test("modifier: one dyno per splat mesh, regenerated only when its own light changes", async () => {
  const b = bundleOf();
  const f = new LightField(b);
  let versions = 0;
  const mesh = { worldModifiers: undefined as unknown[] | undefined, updateGenerator() {}, updateVersion: () => versions++ };
  const pair = { worldModifiers: undefined as unknown[] | undefined, updateGenerator() {}, updateVersion() {} };
  assert.equal(f.modifier(), null, "nothing to apply without a mesh and a person");
  f.modifier(mesh as never, { foot: [-12, -7] }, dyno);
  f.modifier(pair as never, { pair: true }, dyno);
  assert.equal(mesh.worldModifiers?.length, 1);
  assert.equal(pair.worldModifiers?.length, 1);
  f.set("watch", 0);
  const before = versions;
  f.set("watch", 0);
  assert.equal(versions, before, "no change, no regeneration");
  f.set("ease", 1.2);
  assert.ok(versions > before, "the extra at the dark end is regenerated");
  close(f.personLight({ foot: [-12, -7] }), f.at(-12, -7), 1e-12, "same number as the floor under the feet");
  close(f.personLight({ pair: true }), f.pair(), 1e-12, "the pair");
});

test("See my room: out, the darkness and stands go over 0-0.4 s and the floor over 0.2-0.6 s; back, the floor first", () => {
  const at = (t: number, s = 0.6) => roomCurves(t / s);
  close(at(0).stands, 1, 0, "stands at the toggle");
  close(at(0.4).stands, 0, 1e-12, "stands gone at 0.4 s");
  close(at(0.2).floor, 1, 1e-12, "floor holds to 0.2 s");
  close(at(0.6).floor, 0, 1e-12, "floor gone at 0.6 s");
  // back over 0.8 s: p = 1 - t / 0.8
  const back = (t: number) => roomCurves(1 - t / 0.8);
  assert.ok(back(0.4).floor > back(0.4).stands, "the floor returns first");
  close(back(0.8).stands, 1, 1e-12, "the arena is whole at 0.8 s");
  close(veil(0), VEIL, 1e-12, "the veil starts at 50%");
  close(veil(VEIL_S), 0, 1e-12, "and is gone by 1.5 s");
});

test("the edge fade (P35): the room starts to open 0.6 m from the bounds and is fully open at 0.3 m", () => {
  const fade: [number, number] = [0.6, 0.3];
  close(edgeLevel(Infinity, fade), 1, 0, "no bounds yet");
  close(edgeLevel(0.6, fade), 1, 1e-12, "0.6 m");
  close(edgeLevel(0.3, fade), 0, 1e-12, "0.3 m");
  close(edgeLevel(-1, fade), 0, 1e-12, "past the edge");
  assert.ok(edgeLevel(0.45, fade) > 0 && edgeLevel(0.45, fade) < 1, "between");
});

test("the darkness falloff: lit inside camera F's frame, dark REACH_FALLOFF_M outside it on the floor", () => {
  const b = bundleOf();
  const { court, frames } = b;
  const fr = frames[court.video.segments.eases[0].frames[1]];
  const cam = { centre: court.camera.centre, q: fr.q, f: fr.f, cx: court.camera.cx, cy: court.camera.cy, width: court.camera.width, height: court.camera.height };
  const r = reachPlanes(cam);
  const [cx, , cz] = court.seat.pairCentre;
  close(reachAt(r, [cx, 0, cz]), 1, 1e-12, "the pair's floor is in the frame");
  // walk sideways off the frame's right edge: the falloff spans REACH_FALLOFF_M of floor
  const f = new LightField(b);
  const across: [number, number] = [-f.axis[1], f.axis[0]];
  let edge = -1;
  let dark = -1;
  for (let d = 0; d < 30; d += 0.01) {
    const v = reachAt(r, [cx + across[0] * d, 0, cz + across[1] * d]);
    if (edge < 0 && v < 1) edge = d;
    if (dark < 0 && v <= 0) dark = d;
  }
  assert.ok(edge > 1 && dark > edge, `frame edge ${edge.toFixed(2)} m, dark from ${dark.toFixed(2)} m`);
  close(dark - edge, REACH_FALLOFF_M, 0.15, "falloff width across");
  // behind the camera is dark
  close(reachAt(r, [court.camera.centre[0] - 5, 0, court.camera.centre[2]]), 0, 1e-12, "behind the camera");
});

test("the courtside plate dims off camera F's ray (Proxies.dim): 0 at the seat and along the ray, dark at 60 deg", () => {
  const b = bundleOf();
  const f = new LightField(b);
  const [cx, , cz] = b.court.seat.pairCentre;
  close(f.offRayAt(f.seatFloor[0], f.seatFloor[2]), 0, 1e-9, "the seat");
  close(f.offRayAt(cx + f.axis[0] * 2, cz + f.axis[1] * 2), 0, 1e-9, "closer along the ray");
  const side = (deg: number, r = 2) => {
    const a = (deg * Math.PI) / 180;
    const across: [number, number] = [-f.axis[1], f.axis[0]];
    return f.offRayAt(cx + (f.axis[0] * Math.cos(a) + across[0] * Math.sin(a)) * r, cz + (f.axis[1] * Math.cos(a) + across[1] * Math.sin(a)) * r);
  };
  assert.ok(side(60) > 0.85 && side(-60) > 0.85, `60 deg: ${side(60).toFixed(3)} ${side(-60).toFixed(3)}`);
  assert.ok(side(20) < side(40), "steadily darker");
  // standing by the players, the dim moves smoothly (no swing through the pair's centre)
  let worst = 0;
  for (let d = -1; d <= 1; d += 0.01) worst = Math.max(worst, Math.abs(f.offRayAt(cx + d * -f.axis[1], cz + d * f.axis[0]) - f.offRayAt(cx + (d + 0.01) * -f.axis[1], cz + (d + 0.01) * f.axis[0])));
  assert.ok(worst < 0.03, `max change per cm by the pair ${worst.toFixed(3)}`);
});

test("the players' white point (P13): within 0.02 chroma of the arena light that lit them", () => {
  // synthetic players: a white jersey, skin, dark shorts, under three arena lights
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const albedo: number[][] = [];
  for (let i = 0; i < 3000; i++) {
    const k = rnd();
    const shade = 0.5 + 0.5 * rnd(); // shading scales every channel of a splat together
    const a = k < 0.1 ? [0.85, 0.85, 0.85] : k < 0.5 ? [0.43, 0.26, 0.17] : [0.05, 0.06, 0.12];
    albedo.push(a.map((v) => v * shade));
  }
  const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  for (const light of [[1, 0.78, 0.5], [0.82, 0.93, 1], [0.42, 0.42, 0.5]]) {
    const colors: number[] = [];
    for (const a of albedo) for (let c = 0; c < 3; c++) colors.push(Math.round(enc(Math.min(1, a[c] * light[c])) * 255) / 255);
    const w = whitePoint(colors);
    const err = Math.max(Math.abs(w[0] - light[0] / light[1]), Math.abs(w[2] - light[2] / light[1]));
    assert.ok(err <= 0.02, `light ${light}: chroma error ${err.toFixed(4)}`);
  }
});

test("the integrator's beats: handoff before F is ignored (the ease drives it); a hand-off with no ease runs the dims from F", () => {
  const b = bundleOf();
  const f = new LightField(b);
  f.set("ease", 1.0);
  const crowd = f.crowd();
  f.set("handoff", -0.3);
  close(f.crowd(), crowd, 0, "handoff at t < 0 leaves the ease's field");
  const g = new LightField(b);
  g.set("watch", 0);
  g.set("handoff", 0);
  close(perceived(g.crowd()), 1, 1e-12, "no jump at F");
  g.set("handoff", OPEN_DONE_S);
  close(perceived(g.crowd()), TUNED.stands, 1e-9, "landed");
  // the aliases stream D first coded against
  const h = new LightField(b);
  h.set("ease", 1.2);
  h.set("open", 2);
  const viaOpen = h.at(-12, -7);
  h.set("handoff", 2);
  close(h.at(-12, -7), viaOpen, 0, "open = handoff");
});

test("courtLight's parts: floor, crowd and stands, a person by the floor under their feet; levels mirror the field", () => {
  const b = bundleOf();
  const f = new LightField(b);
  f.set("ease", 1.2);
  f.set("handoff", OPEN_DONE_S);
  close(f.at(-12, -7, PART.crowd), f.crowd(), 0, "crowd");
  close(f.at(-12, -7, PART.stands), f.crowd(), 0, "stands");
  close(f.at(-12, -7, PART.person), f.at(-12, -7, PART.floor, 1), 0, "person");
  close(f.levels.crowd, f.crowd(), 1e-12, "levels.crowd");
  close(f.levels.pair, 1, 1e-12, "levels.pair");
  assert.ok(f.levels.pool.radius > 0 && f.levels.pool.penumbra >= 1.5, `pool ${JSON.stringify(f.levels.pool)}`);
});
