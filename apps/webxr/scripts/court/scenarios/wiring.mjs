// court.ts's wiring of stream C (the Codex review of court-c, items 1, 2, 5 and 7): the live arrival is seat.arrival's
// (the hand-over, then a seated head still 1 s; never a bare 1 s timer), Seat has the session through PersistentLock
// (bounded-floor, persistent anchors), the drawn hands are lit (VrHands.light: dark in the arrival's hold, lit in the
// watch), and seat.update is handed the frame's real dt (at a 90 Hz frame rate, 1/90 s, not one 72 Hz display frame).
// Owner: the integrator.
export const owner = "integrator";
export const needs = ["seat", "vrhands"];

const HZ = 72;

export default async function wiring(ctx) {
  const w = async () => (await ctx.snapshot()).wiring;
  await ctx.nextFrame();
  const w0 = await w();
  ctx.check("C2: Seat has the session through PersistentLock", w0.lock === "persistent" && w0.seatXr === true, `lock ${w0.lock}, session ${w0.seatXr ? "shared" : "missing"}`);

  // seated and still, but no hand-over: a bare 1 s timer would light up; seat.arrival waits
  await ctx.seatHere();
  const hold = await ctx.frames(Math.round(2.5 * HZ));
  ctx.check("C1: no lights-up without the hand-over (seat.arrival)", hold.every((f) => f.lightsUp < 0 && f.phase === "arrival"), `lights-up ${hold.some((f) => f.lightsUp >= 0) ? "started" : "never started"} over 2.5 s seated and still`);
  const dark = await w();
  ctx.check("C5: the drawn hands are dark in the arrival's hold", dark.hands === 0, `hands light ${dark.hands}`);

  await ctx.handOver();
  const run = await ctx.until("watching", HZ * 6);
  const up = run.find((f) => f.lightsUp >= 0);
  ctx.check("C1: after the hand-over, the lights come up 1-1.1 s into a seated, still head", !!up && up.still >= 1 - 1e-6 && up.still <= 1.1, up ? `after ${up.still.toFixed(3)} s` : "never");
  ctx.check("C1: then the watch", run.at(-1)?.phase === "watching", `${run.at(-1)?.phase} after ${run.length} frames`);
  const lit = await w();
  ctx.check("C5: the drawn hands are lit in the watch (VrHands.light)", lit.hands > 0.05, `hands light ${lit.hands.toFixed(3)}`);
  ctx.check("C7: seat.update gets the frame's dt at the show's rate", Math.abs(lit.seatDt - 1 / HZ) < 1e-9, `dt ${lit.seatDt}`);

  // a 90 Hz frame rate: every frame is 1/90 s, and Seat must be handed exactly that
  await ctx.page.evaluate(() => window.__court.setRate(90));
  await ctx.frames(3);
  const at90 = await w();
  await ctx.page.evaluate(() => window.__court.setRate(null));
  ctx.check("C7: seat.update gets the frame's dt at 90 Hz", Math.abs(at90.seatDt - 1 / 90) < 1e-9, `dt ${at90.seatDt}`);
}
