// transitions.ts: Reset's fade through black (the restart at full black, the clock held while the view comes back)
// and Step into the court's glow round the screen. Run: npm run test:court
import "./ts-resolve.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { ResetFade, StepGlow, RESET_OUT_S, RESET_IN_S, GLOW_UP_S, GLOW_SETTLE_S, GLOW_HOLD, GLOW_BREATHE, WAVE_S, smooth } = await import("../../src/court/transitions.ts");

const HZ = 72;
const dt = 1 / HZ;

test("Reset from the 3D: out to black, the restart on the one frame at full black, then back in with the clock held", () => {
  const fade = new ResetFade();
  assert.equal(fade.active, false);
  assert.equal(fade.veil, 0);
  fade.start(RESET_OUT_S);
  const rows: { restart: boolean; veil: number; holding: boolean; rise: number }[] = [];
  for (let i = 0; i < HZ * 2 && (i === 0 || fade.active); i++) {
    const restart = fade.update(dt);
    rows.push({ restart, veil: fade.veil, holding: fade.holding, rise: fade.rise });
  }
  const at = rows.findIndex((r) => r.restart);
  assert.equal(rows.filter((r) => r.restart).length, 1, "one restart");
  assert.equal(rows[at].veil, 1, "the restart is at full black");
  assert.ok(Math.abs(at * dt - RESET_OUT_S) <= 1.5 * dt, `restart at ${(at * dt).toFixed(3)} s`);
  assert.ok(rows.slice(0, at).every((r) => !r.holding && r.rise === 0), "the show runs on under the fade-out");
  assert.ok(rows.slice(at, -1).every((r) => r.holding), "the clock holds from the restart until the view is back");
  const total = rows.length * dt;
  assert.ok(Math.abs(total - (RESET_OUT_S + RESET_IN_S)) <= 2 * dt, `the whole Reset takes ${total.toFixed(3)} s`);
  assert.equal(fade.active, false);
  assert.equal(fade.veil, 0);
  assert.equal(fade.rise, 1);
  // the veil only rises then only falls, never by more than a smoothstep's steepest frame
  const veil = rows.map((r) => r.veil);
  const steepest = (s: number) => (1.875 * dt) / s + 1e-9; // quintic smoothstep's peak slope is 15/8
  for (let i = 1; i < veil.length; i++) {
    const d = veil[i] - veil[i - 1];
    if (i <= at) assert.ok(d >= 0 && d <= steepest(RESET_OUT_S), `out frame ${i}: ${d}`);
    else assert.ok(d <= 0 && -d <= steepest(RESET_IN_S), `in frame ${i}: ${d}`);
  }
});

test("Reset at the screen: the restart at once (no veil), the screen rises with the clock held", () => {
  const fade = new ResetFade();
  fade.start(0);
  assert.equal(fade.atOnce, true);
  assert.equal(fade.update(dt), true, "restart on the press's own frame");
  assert.equal(fade.veil, 0);
  assert.equal(fade.holding, true);
  let frames = 0;
  let last = fade.rise;
  while (fade.active) {
    assert.equal(fade.update(dt), false);
    assert.equal(fade.veil, 0);
    assert.ok(fade.rise >= last);
    last = fade.rise;
    frames++;
  }
  assert.ok(Math.abs(frames * dt - RESET_IN_S) <= 1.5 * dt, `${frames} frames`);
  assert.equal(fade.rise, 1);
});

test("Change seat cancels a Reset: no veil, no hold", () => {
  const fade = new ResetFade();
  fade.start(RESET_OUT_S);
  for (let i = 0; i < 10; i++) fade.update(dt);
  assert.ok(fade.veil > 0);
  fade.cancel();
  assert.equal(fade.active, false);
  assert.equal(fade.veil, 0);
  assert.equal(fade.holding, false);
  assert.equal(fade.update(dt), false);
});

test("Step into the court's glow: a flare and a ring, a breathing charged hold, full charge at the dissolve with a second ring", () => {
  const g = new StepGlow();
  assert.deepEqual(g.update(dt, null), { glow: 0, wave: -1 });
  g.start();
  const rows: { glow: number; wave: number }[] = [];
  for (let i = 0; i < HZ * 4; i++) rows.push(g.update(dt, null));
  const peakAt = rows.findIndex((r) => r.glow > 0.999);
  assert.ok(Math.abs(peakAt * dt - GLOW_UP_S) <= 1.5 * dt, `flare peaks at ${(peakAt * dt).toFixed(3)} s`);
  // the press's ring crosses the halo once, outward
  const waves = rows.map((r) => r.wave).filter((w) => w >= 0);
  assert.ok(Math.abs(waves.length * dt - WAVE_S) <= 1.5 * dt, `ring for ${(waves.length * dt).toFixed(3)} s`);
  assert.ok(waves.every((w, i) => i === 0 || w > waves[i - 1]));
  // settled: the hold breathes within GLOW_BREATHE of GLOW_HOLD, never to dark, never back to the flare
  const held = rows.slice(Math.ceil((GLOW_UP_S + GLOW_SETTLE_S) * HZ));
  assert.ok(held.every((r) => Math.abs(r.glow - GLOW_HOLD) <= GLOW_BREATHE + 1e-9), "breathing hold");
  // no frame steps by more than a smoothstep's steepest frame of the flare (no pops)
  for (let i = 1; i < rows.length; i++) assert.ok(Math.abs(rows[i].glow - rows[i - 1].glow) <= (1.875 * dt) / GLOW_UP_S + 1e-9, `frame ${i}`);
  // the ease: the charge climbs from the hold to full, with no step as it starts
  let last = rows.at(-1)!.glow;
  let second = -1;
  for (let k = 0; k <= HZ; k++) {
    const r = g.update(dt, k / HZ);
    assert.ok(Math.abs(r.glow - last) <= 0.05, `charge frame ${k}: ${last} -> ${r.glow}`);
    last = r.glow;
    if (r.wave === 0) second = k;
  }
  assert.equal(last, 1, "full charge at the dissolve");
  assert.equal(second, HZ, "the dissolve's ring goes out as the charge lands");
  g.stop();
  assert.deepEqual(g.update(dt, 1), { glow: 0, wave: -1 });
});

test("smooth: 0 and 1 at the ends, clamped, symmetric", () => {
  assert.equal(smooth(0), 0);
  assert.equal(smooth(1), 1);
  assert.equal(smooth(-1), 0);
  assert.equal(smooth(2), 1);
  assert.ok(Math.abs(smooth(0.3) + smooth(0.7) - 1) < 1e-12);
});
