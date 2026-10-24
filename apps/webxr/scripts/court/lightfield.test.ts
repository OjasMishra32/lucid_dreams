// lightfield.ts: the one light field (3.3, 3.3a). The levels (court.json `light`, both sets), the beats, the pool's
// shape and growth, and P44's bar on the CPU twin of the GLSL: no light change faster than 1 grey level per display
// frame at 72 (and 90) Hz on any surface up to full white (SAFE_GREY), on the encoded 8-bit value (three's sRGB encode
// plus the field's dither), on both light sets, through every beat and through interrupted ones.
//   node --experimental-transform-types --test apps/webxr/scripts/court/lightfield.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";
import {
  BACK_DONE_S, LEVEL_S, LightField, OPEN_DONE_S, PART, POOL_START_S, SAFE_GREY, ARRIVAL_S, changeS, fixtureGlow,
  FILMED_NEAR, FILMED_FAR,
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

test("ease and hand-off: the crowd lands on 0.45 and the floor outside the pool on 0.30 at LEVEL_S per unit (F+1.2 and F+1.8 after the 1.2 s ease); the pair never moves", () => {
  const b = bundleOf();
  const f = new LightField(b);
  const [cx, , cz] = b.court.seat.pairCentre;
  const ease = 1.2;
  let pairMax = 0;
  for (let i = 0; i <= ease * HZ; i++) {
    f.set("ease", i / HZ);
    pairMax = Math.max(pairMax, Math.abs(perceived(f.pair()) - 1), Math.abs(p(f, cx, cz) - 1));
  }
  assert.ok(perceived(f.crowd()) < 0.75, `the crowd half way down at F: ${perceived(f.crowd()).toFixed(3)}`);
  for (let i = 0; i <= OPEN_DONE_S * HZ; i++) {
    f.set("handoff", i / HZ);
    pairMax = Math.max(pairMax, Math.abs(perceived(f.pair()) - 1), Math.abs(p(f, cx, cz) - 1));
  }
  f.set("handoff", changeS(1, TUNED.crowd) - ease);
  close(perceived(f.crowd()), TUNED.crowd, 1e-4, "crowd landed (the ease's last frame is 1/72 s before F)");
  close(changeS(1, TUNED.crowd) - ease, 1.165, 1e-9, "at F+1.2");
  f.set("handoff", changeS(1, TUNED.floor) - ease);
  close(p(f, -12, -7), TUNED.floor, 1e-4, "floor outside the pool landed");
  close(changeS(1, TUNED.floor) - ease, 1.81, 1e-9, "at F+1.8");
  assert.equal(pairMax, 0, "the pair and the floor under them stay at exactly 1 (P28)");
});

test("the dark set: 0.16 / 0.14 at the freeze", () => {
  const f = new LightField(bundleOf(), { set: "alternative" });
  f.set("ease", 10);
  close(perceived(f.crowd()), 0.16, 1e-6, "crowd");
  f.set("handoff", POOL_START_S);
  close(p(f, -12, -7), 0.14, 1e-6, "floor");
});

/** The whole show's light at `hz` for one ease length (0: a jump to F): [beat, t] per display frame (the arrival is its own test). */
function timeline(ease: number, hz = HZ): [Beat, number][] {
  const out: [Beat, number][] = [["watch", 0]];
  for (let i = 0; i < Math.round(ease * hz); i++) out.push(["ease", i / hz]);
  for (let i = 0; i <= OPEN_DONE_S * hz + 10; i++) out.push(["handoff", i / hz]);
  for (let i = 0; i <= BACK_DONE_S * hz + 10; i++) out.push(["return", i / hz]);
  for (let i = 0; i <= (0.25 + LEVEL_S) * hz + 10; i++) out.push(["resume", i / hz]);
  return out;
}

/** Interrupted changes: each beat cut short by the next (court.ts can't today, but the field must never jump). */
function interrupted(hz: number): [Beat, number][][] {
  const run = (beat: Beat, to: number): [Beat, number][] => Array.from({ length: Math.round(to * hz) + 1 }, (_, i) => [beat, i / hz]);
  return [
    [["watch", 0], ...run("ease", 0.3), ...run("return", 4.5), ...run("resume", 3)],
    [["watch", 0], ...run("ease", 0.5), ...run("resume", 3)],
    [["watch", 0], ...run("ease", 1.2), ...run("handoff", 2.0), ...run("return", 4.5), ...run("resume", 3)],
    [["watch", 0], ...run("ease", 1.2), ...run("handoff", 5), ...run("return", 1.0), ...run("resume", 3)],
    [["watch", 0], ...run("handoff", 5), ...run("return", 4.5)],
  ];
}

const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** three's sRGB encode (sRGBTransferOETF), 0-1. */
const enc = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
/** The field's dither (GLSL lightDither) at a fragment, in grey levels: -1..1. */
const ign = (x: number, y: number) => {
  const f = (v: number) => v - Math.floor(v);
  return f(52.9829189 * f(x * 0.06711056 + y * 0.00583715));
};
const dither = (x: number, y: number) => ign(x, y) + ign(x + 17, y + 59) - 1;

/** The 8-bit value written for a surface of linear colour c under linear multiplier k at a fragment with dither n. */
const byteLin = (c: number, k: number, n: number) => Math.min(255, Math.max(0, Math.round(255 * enc(c * k) + n)));
/** world.ts LINE_WHITE (linear): the floor shader's white markings, the brightest colour it draws itself. */
const LINE_WHITE = [0.72, 0.72, 0.69];

test("P44 on the encoded byte: no light change moves any pixel up to white more than 1 level a frame, 72 and 90 Hz, both sets, every ease, interrupted too", () => {
  const b = bundleOf();
  const [cx, , cz] = b.court.seat.pairCentre;
  // floor points over the court at three darkness-falloff values, the lane to the seat, the review's free-throw-circle
  // fragment (8.535, 1.83), and the crowd
  const pts: [number, number, number][] = [[8.535, 1.83, 1]];
  for (let x = -15; x <= 15; x += 3) for (let z = -8; z <= 8; z += 4) for (const r of [1, 0.5, 0]) pts.push([x, z, r]);
  for (let d = 0; d <= 8; d += 0.5) for (const r of [1, 0]) pts.push([cx - d, cz - 0.4 * d, r]);
  const fragments = Array.from({ length: 64 }, (_, i) => dither(0.5 + (i % 8) * 37, 0.5 + Math.floor(i / 8) * 23));
  fragments.push(dither(0.5, 0.5));
  // the bytes themselves, dither included: white, the line paint's channels, greys 170 and 125, on the crowd and on
  // the review's line fragment
  const colours = [1, ...LINE_WHITE, dec(170 / 255), dec(125 / 255)];
  const worst: Record<string, number> = {};
  for (const set of ["main", "alternative"] as const)
    for (const hz of [72, 90]) {
      const runs = [...[1.2, 1.0, 0.8, 0].map((e) => timeline(e, hz)), ...interrupted(hz)];
      runs.forEach((run, ri) => {
        const f = new LightField(b, { set });
        let prev: number[] | null = null;
        let prevK: number[] = [];
        let w = 0;
        let wAt = "";
        for (const [beat, t] of run) {
          f.set(beat, t);
          const ks = [...pts.map(([x, z, r]) => f.at(x, z, PART.floor, r)), f.crowd()];
          // white's continuous encoded value: a change under 1 level can only round to a 1-level step, and every
          // darker surface moves less
          const now = ks.map((k) => 255 * enc(k));
          if (prev)
            for (let i = 0; i < now.length; i++) {
              const d = Math.abs(now[i] - prev[i]);
              if (d > w) [w, wAt] = [d, `${beat} ${t.toFixed(3)} ${i < pts.length ? `floor ${pts[i]}` : "crowd"}`];
            }
          if (prevK.length)
            for (const idx of [0, ks.length - 1])
              for (const c of colours)
                for (const n of fragments) {
                  const step = Math.abs(byteLin(c, ks[idx], n) - byteLin(c, prevK[idx], n));
                  assert.ok(step <= 1, `${set} ${hz} Hz run ${ri}: ${idx ? "crowd" : "line"} colour ${c.toFixed(3)} steps ${step} at ${beat} ${t.toFixed(3)}`);
                }
          prev = now;
          prevK = ks;
        }
        assert.ok(w < 1, `${set} ${hz} Hz run ${ri}: largest encoded change on white ${w.toFixed(3)} levels a frame at ${wAt}`);
        worst[`${set} ${hz}`] = Math.max(worst[`${set} ${hz}`] ?? 0, w);
      });
    }
  assert.ok(worst["main 72"] > 0.85, `the bound is met, not avoided: ${JSON.stringify(worst)}`);
  assert.equal(SAFE_GREY, 255, "every surface");
});

test("the arrival rises evenly on white's encoded value (0.93 levels a frame at 72 Hz), and a watch that starts at court.ts's 2.5 s carries it on", () => {
  for (const hz of [72, 90])
    for (const grey of [255, 222, 170, 125, 60, 20])
      for (const cut of [ARRIVAL_S, 2.5]) {
        const f = new LightField(bundleOf());
        f.set("dark", 0);
        let worst = 0;
        let prev = 0;
        const run: [Beat, number][] = [];
        for (let i = 0; i <= Math.round(cut * hz); i++) run.push(["arrival", i / hz]);
        for (let i = 0; i <= 2 * hz; i++) run.push(["watch", i / hz]);
        run.forEach(([beat, t], i) => {
          f.set(beat, t);
          const v = 255 * enc(dec(grey / 255) * f.pair());
          if (i) worst = Math.max(worst, Math.abs(v - prev));
          prev = v;
        });
        assert.ok(worst < 0.95 * (72 / hz), `${hz} Hz grey ${grey}, watch at ${cut} s: largest encoded change ${worst.toFixed(3)}`);
        close(f.pair(), 1, 1e-12, `${hz} Hz grey ${grey}, watch at ${cut} s: all the way up`);
      }
});

test("the house lights (fixtureGlow) ignite and dim under 1 level a frame on their own white, every beat, both sets", () => {
  for (const set of ["main", "alternative"] as const)
    for (const hz of [72, 90]) {
      const f = new LightField(bundleOf(), { set });
      f.set("dark", 0);
      const run: [Beat, number][] = [];
      for (let i = 0; i <= Math.round(2.5 * hz); i++) run.push(["arrival", i / hz]);
      run.push(...timeline(1.2, hz));
      let prev: number[] | null = null;
      let worst = 0;
      for (const [beat, t] of run) {
        f.set(beat, t);
        const now = Array.from({ length: 8 }, (_, i) => 255 * enc(fixtureGlow(i, 8, f.crowdLevelNow, f.arrivalNow)));
        if (prev) for (let i = 0; i < 8; i++) worst = Math.max(worst, Math.abs(now[i] - prev[i]));
        prev = now;
      }
      assert.ok(worst < 1, `${set} ${hz} Hz: largest encoded change ${worst.toFixed(3)}`);
    }
  close(fixtureGlow(7, 8, 1, 1), 0.55, 1e-12, "every fixture all the way up at the end of the arrival");
  assert.ok(fixtureGlow(7, 8, 1, 0.1) < fixtureGlow(0, 8, 1, 0.1), "one after another");
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
  assert.ok(halfway[0] >= POOL_START_S, "the pool starts growing at F+POOL_START_S");
  assert.ok(halfway[halfway.length - 1] - halfway[0] >= 0.8, `the pool visibly grows: ${halfway.map((t) => t.toFixed(2)).join(" ")}`);
  f.set("handoff", OPEN_DONE_S);
  // by F+5 the pool has landed wherever the rendered court is no darker than half its falloff (camera F's frame holds
  // the seat, the lane and the walking floor); a point fully outside it (reach 0) comes up from black, a whole level,
  // so by then it's most of the way
  close(p(f, seat[0], seat[2], 0.5), 1, 1e-6, "the seat is lit");
  assert.ok(p(f, seat[0], seat[2], 0) > 0.9, `the seat lit even from black: ${p(f, seat[0], seat[2], 0).toFixed(3)}`);
  // the walking floor round the pair (the walking anchoring puts the pair at the room's centre): every point within
  // 2 m of the pair's centre, where the judge walks, is lit
  for (let a = 0; a < 360; a += 30) {
    const r = (a * Math.PI) / 180;
    close(p(f, cx + 2 * Math.cos(r), cz + 2 * Math.sin(r), 0.5), 1, 1e-6, `2 m from the pair at ${a} deg`);
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
  const ease = 1.2;
  f.set("ease", ease);
  let prev = 1;
  for (let t = 0; t <= OPEN_DONE_S + 0.01; t += 1 / HZ) {
    f.set("handoff", t);
    const c = perceived(f.crowd());
    if (t >= changeS(1, TUNED.crowd) - ease && t <= 3) close(c, TUNED.crowd, 1e-6, `crowd at F+${t.toFixed(2)}`);
    if (t < 3) assert.ok(c <= prev + 1e-12, `still falling at F+${t.toFixed(2)}`);
    else assert.ok(c >= prev - 1e-12, `never dips at F+${t.toFixed(2)}`);
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
  f.set("resume", 0.25 + changeS(TUNED.floor, 1));
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
  f.set("arrival", ARRIVAL_S / 2);
  close(255 * enc(dec(SAFE_GREY / 255) * f.pair()), SAFE_GREY / 2, 1e-9, "half way up on a white surface's encoded value (P44)");
  close(f.crowd(), f.pair(), 1e-12, "the crowd with it");
  f.set("arrival", ARRIVAL_S);
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

test("the splat dyno takes every change the GLSL takes, the same frame (no threshold): 72 Hz through every beat", () => {
  const b = bundleOf();
  const f = new LightField(b);
  let k: { value: number } | null = null;
  const api = { ...dyno, dynoFloat: (v: number) => (k = dyno.dynoFloat(v)) } as typeof dyno;
  let versions = 0;
  const mesh = { worldModifiers: undefined as unknown[] | undefined, updateGenerator() {}, updateVersion: () => versions++ };
  const person = { foot: [-6, -3] as [number, number] };
  f.modifier(mesh as never, person, api);
  assert.ok(k, "the modifier's light is a dyno uniform");
  const dk = k as { value: number };
  let prev = dk.value;
  let frames = 0;
  for (const [beat, t] of [...timeline(1.2), ...interrupted(HZ)[0]]) {
    const before = versions;
    f.set(beat, t);
    assert.equal(dk.value, f.personLight(person), `${beat} ${t.toFixed(3)}: the dyno's light is the GLSL's`);
    assert.equal(dk.value, f.at(-6, -3), `${beat} ${t.toFixed(3)}: the floor under the feet`);
    assert.equal(versions - before, dk.value !== prev ? 1 : 0, `${beat} ${t.toFixed(3)}: regenerated exactly when it moved`);
    if (dk.value !== prev) frames++;
    prev = dk.value;
  }
  assert.ok(frames > 200, `the extra's light moved on ${frames} frames`);
});

test("interrupted beats start from the light that is on: back mid-ease, resume mid-ease, back mid-hand-off, resume mid-back", () => {
  const b = bundleOf();
  const [cx, , cz] = b.court.seat.pairCentre;
  const levels = (f: LightField) => [f.crowd(), f.at(-12, -7), f.at(-6, -3, PART.floor, 0.5), f.at(cx, cz)];
  const cases: [string, [Beat, number][], Beat][] = [
    ["back after 0.3 s of ease", [["ease", 0.3]], "back"],
    ["return after 0.3 s of ease", [["ease", 0.3]], "return"],
    ["resume after 0.5 s of ease", [["ease", 0.5]], "resume"],
    ["back 2 s into the hand-off", [["ease", 1.2], ["handoff", 2]], "back"],
    ["resume 1 s into the return", [["ease", 1.2], ["handoff", 5], ["return", 1]], "resume"],
  ];
  for (const [name, path, next] of cases) {
    const f = new LightField(b);
    f.set("watch", 0);
    for (const [beat, end] of path) for (let i = 0; i <= Math.round(end * HZ); i++) f.set(beat, i / HZ);
    const was = levels(f);
    f.set(next, 0);
    const now = levels(f);
    now.forEach((v, i) => close(v, was[i], 1e-12, `${name}: level ${i} at the switch (was ${was[i].toFixed(3)})`));
    // and the first frame after moves under one encoded grey level (the full curves are in the P44 test)
    f.set(next, 1 / HZ);
    levels(f).forEach((v, i) => {
      const d = Math.abs(255 * (enc(dec(SAFE_GREY / 255) * v) - enc(dec(SAFE_GREY / 255) * now[i])));
      assert.ok(d < 1, `${name}: level ${i} moves ${d.toFixed(3)} on the first frame`);
    });
  }
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

test("the filmed floor (lightFilmedFloor): the footage from the dolly seat and a seated lean, the clean floor once you walk", () => {
  const b = bundleOf();
  const f = new LightField(b);
  const [cx, , cz] = b.court.seat.pairCentre;
  const seat = f.seatFloor;
  close(f.filmedAt([seat[0], 1.15, seat[2]]), 1, 0, "at the seat");
  close(f.filmedAt([seat[0] + 0.3, 1.15, seat[2] - 0.2]), 1, 0, "leaning 0.36 m");
  // every walk stop, 1.5 m round the pair: the clean floor
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    close(f.filmedAt([cx + 1.5 * Math.cos(a), 1.6, cz + 1.5 * Math.sin(a)]), 0, 0, `walk stop at ${k * 45} deg`);
  }
  // and it moves smoothly: a 1 cm step changes it by under 2%
  let worst = 0;
  for (let d = 0; d < 2; d += 0.01) worst = Math.max(worst, Math.abs(f.filmedAt([seat[0] + d, 1.6, seat[2]]) - f.filmedAt([seat[0] + d + 0.01, 1.6, seat[2]])));
  assert.ok(worst < 0.02, `largest change for a 1 cm step: ${worst.toFixed(4)}`);
  assert.ok(FILMED_NEAR > 0.3 && FILMED_FAR > FILMED_NEAR + 0.5, "a lean keeps it, a step starts the fade");
  assert.ok(f.glsl.includes("float lightFilmedFloor(vec3 p)") && f.glsl.includes("uLightFilmed"), "the GLSL names it");
});
