// warpLanding.ts: the flash peaks just before F and is gone by F (or 0.15 s after at most: F's own pixels are left),
// never past 0.85; the shockwave ring runs after F, out from under the players; nothing jumps between two 72 Hz frames.
//   node --experimental-transform-types --test apps/webxr/scripts/court/warpLanding.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLASH_CLEAR_S, FLASH_PEAK, RING_FROM_S, RING_S, WarpLanding, flashLevel, ringAt } from "../../src/court/warpLanding.ts";

const FRAME = 1 / 72;
const span = (a: number, b: number) => Array.from({ length: Math.round((b - a) / FRAME) + 1 }, (_, i) => a + i * FRAME);

test("the flash: up before F, its peak just before F and at most 0.85, clear within 0.15 s of F, smooth", () => {
  assert.equal(flashLevel(-1), 0);
  assert.ok(FLASH_PEAK <= 0.85);
  const ts = span(-1, 1);
  const peakT = ts.reduce((a, t) => (flashLevel(t) > flashLevel(a) ? t : a), ts[0]);
  assert.ok(peakT < 0 && peakT > -0.25, `peaks just before F (${peakT.toFixed(3)} s)`);
  assert.ok(Math.abs(flashLevel(peakT) - FLASH_PEAK) < 0.02, "reaches its peak");
  assert.ok(FLASH_CLEAR_S <= 0.15);
  for (const t of span(FLASH_CLEAR_S, 2)) assert.equal(flashLevel(t), 0, `clear at ${t.toFixed(3)} s`);
  for (const t of ts) assert.ok(Math.abs(flashLevel(t + FRAME) - flashLevel(t)) < 0.1, `no jump at ${t.toFixed(3)} s`);
});

test("the ring: nothing on F, out from under the players and gone by +1.2 s or so, growing every frame, smooth", () => {
  for (const t of span(-0.5, RING_FROM_S - 0.005)) assert.equal(ringAt(t).level, 0, `F's pixels untouched at ${t.toFixed(3)} s`);
  assert.equal(ringAt(RING_FROM_S + RING_S + 0.01).level, 0);
  assert.ok(RING_FROM_S >= 0.15 && RING_FROM_S + RING_S <= 1.3, "starts with the hand-off (handoff.ts videoFades)");
  let last = ringAt(RING_FROM_S);
  for (const t of span(RING_FROM_S + FRAME, RING_FROM_S + RING_S)) {
    const r = ringAt(t);
    assert.ok(r.radius > last.radius, `grows at ${t.toFixed(3)} s`);
    assert.ok(Math.abs(r.level - last.level) < 0.1, `no jump at ${t.toFixed(3)} s`);
    last = r;
  }
  assert.ok(Math.max(...span(0, 1.3).map((t) => ringAt(t).level)) > 0.3, "and is seen");
});

test("WarpLanding draws nothing outside the landing and hides the flash once it has cleared", () => {
  const players = [{ bounds: { min: [4, 0, 1], max: [6, 2, 2] } }, { bounds: { min: [7, 0, 0], max: [8, 2, 1] } }];
  const w = new WarpLanding(players as never);
  const head = { court: [0, 1.2, 0] as [number, number, number] };
  const drawn = () => w.object.children.filter((c) => c.visible).map((c) => c.name);
  w.update(-2, head);
  assert.deepEqual(drawn(), []);
  w.update(-0.1, head);
  assert.deepEqual(drawn(), ["court-warp-flash"]);
  w.update(FLASH_CLEAR_S, head);
  assert.ok(!drawn().includes("court-warp-flash"), "F's pixels: no veil once clear");
  w.update(0.5, head);
  assert.ok(drawn().includes("court-warp-ring"));
  const ring = w.object.getObjectByName("court-warp-ring")!;
  assert.ok(Math.abs(ring.position.x - 6.25) < 1e-6 && Math.abs(ring.position.z - 1) < 1e-6, "centred under the players");
  w.update(3, head);
  assert.deepEqual(drawn(), []);
  w.dispose();
});
