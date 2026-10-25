// transitions.ts: Reset's fade through black (the restart at full black, the clock held while the view comes back)
// and Step into the court's rim pulse. Run: npm run test:court
import "./ts-resolve.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { ResetFade, StepPulse, RESET_OUT_S, RESET_IN_S, PULSE_UP_S, PULSE_DOWN_S, smooth } = await import("../../src/court/transitions.ts");

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

test("Step into the court's pulse: up to 1 over PULSE_UP_S, back to 0 over PULSE_DOWN_S, then rest", () => {
  const pulse = new StepPulse();
  assert.equal(pulse.level(dt), 0);
  pulse.start();
  const levels: number[] = [];
  for (let i = 0; i < HZ * 2; i++) levels.push(pulse.level(dt));
  const peak = Math.max(...levels);
  assert.ok(peak > 0.99, `peak ${peak}`);
  assert.ok(Math.abs(levels.indexOf(peak) * dt - PULSE_UP_S) <= dt, "peaks at PULSE_UP_S");
  const end = levels.findIndex((v, i) => i > levels.indexOf(peak) && v === 0);
  assert.ok(Math.abs(end * dt - (PULSE_UP_S + PULSE_DOWN_S)) <= 1.5 * dt, `rests at ${(end * dt).toFixed(3)} s`);
  assert.ok(levels.slice(end).every((v) => v === 0));
  // a second press restarts it
  pulse.start();
  assert.equal(pulse.level(dt), 0);
  assert.ok(pulse.level(dt) > 0);
});

test("smooth: 0 and 1 at the ends, clamped, symmetric", () => {
  assert.equal(smooth(0), 0);
  assert.equal(smooth(1), 1);
  assert.equal(smooth(-1), 0);
  assert.equal(smooth(2), 1);
  assert.ok(Math.abs(smooth(0.3) + smooth(0.7) - 1) < 1e-12);
});
