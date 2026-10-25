// P27 and the arrival rule (plan 3.1, P38): after Seat here the arrival stays black until the hand-over (the session not
// visible, then visible: the headset passed to the judge) and the judge's head is seated in the chair and still; the
// lights-up starts within 1.1 s of a still, seated head. Hidden, standing and moving heads wait, and a second Seat here
// needs a new hand-over. Drives IWER's device (visibility, head position). The hand-over checks need court.ts to feed
// seat.arrival (update and visibility): until it does they SKIP with that reason. Owner: stream C.
import { rig } from "../rig.mjs";

export const owner = "C (core)";
export const needs = ["seat"];

const HZ = 72;
/** The darkest the arrival may be before the lights-up: mean luma, 0-255 (the dome and the dark field). */
const BLACK = 2;

const started = (fs) => (fs.some((f) => f.lightsUp >= 0) ? "started" : "never started");
const lumaMax = (fs) => Math.max(...fs.map((f) => f.luma));

/** Holds the head still at the seated height for `s` seconds, then reads the frames. */
const sit = async (ctx, y, s) => {
  await ctx.device((d, h) => d.position.set(d.position.x, h, d.position.z), y);
  return ctx.frames(Math.round(s * HZ));
};

export default async function arrival(ctx) {
  const r = rig(ctx);
  await ctx.nextFrame();
  const seatedY = await ctx.device((d) => d.position.y);
  await ctx.seatHere();
  await ctx.frames(2);

  // hidden (the headset off, being handed over): black however still the head is
  await ctx.device((d) => d.updateVisibilityState("hidden"));
  const hidden = await ctx.frames(Math.round(2 * HZ));
  ctx.check("P27: hidden: waits", hidden.every((f) => f.lightsUp < 0 && f.phase === "arrival"), `lights-up ${started(hidden)} over 2 s hidden`);
  if (!ctx.timing) ctx.check("P27: hidden: black", hidden.every((f) => f.luma <= BLACK), `mean luma max ${lumaMax(hidden)}`);
  await ctx.device((d) => d.updateVisibilityState("visible")); // the hand-over

  // standing (the head 0.4 m over the seated eye), still: waits
  await ctx.device((d, y) => d.position.set(d.position.x, y + 0.4, d.position.z), seatedY);
  const standing = await ctx.frames(Math.round(2 * HZ));
  ctx.check("P27: standing: waits", standing.slice(2).every((f) => f.lightsUp < 0), `lights-up ${started(standing)} over 2 s standing`);

  // seated, moving (0.3 m/s side to side; sat down and swaying in one step so no still frame slips in): waits
  await ctx.device((d, y) => {
    const x0 = d.position.x;
    const t0 = performance.now();
    d.position.set(x0, y, d.position.z);
    window.__courtSway = setInterval(() => d.position.set(x0 + 0.1 * Math.sin((performance.now() - t0) / 333), y, d.position.z), 4);
  }, seatedY);
  const moving = await ctx.frames(Math.round(2 * HZ));
  ctx.check("P27: moving: waits", moving.every((f) => f.lightsUp < 0), `lights-up ${started(moving)} over 2 s moving`);
  if (!ctx.timing) ctx.check("P27: waiting: black", [...standing, ...moving].every((f) => f.luma <= BLACK), `mean luma max ${lumaMax([...standing, ...moving])}`);

  // still and seated: the lights-up starts within 1.1 s, and the watch follows
  await ctx.device(() => clearInterval(window.__courtSway));
  const settle = await ctx.until("watching", Math.round(5 * HZ));
  const start = settle.findIndex((f) => f.lightsUp >= 0);
  const dark = settle[0]?.lightsUp < 0;
  ctx.check("P27: still: lights up within 1.1 s", dark && start >= 0 && start <= 1.1 * HZ, !dark ? "the lights were already up when the head stopped" : start >= 0 ? `after ${(start / HZ).toFixed(3)} s still` : "never");
  ctx.check("P27: then the watch", settle.at(-1)?.phase === "watching", `${settle.at(-1)?.phase} after ${settle.length} frames`);
  ctx.report.frames = [...hidden, ...standing, ...moving, ...settle].map(({ thumb, view, ...f }) => f);

  const rep = await r.seat();
  ctx.report.arrival = { waited: rep?.arrivalWaited ?? null, eyeY: rep?.eyeY ?? null };
  if (rep?.arrivalWaited == null) ctx.skip("the hand-over rule: court.ts doesn't feed seat.arrival yet (seat.arrival.update(dt, head.room) and .visibility(state))");
  ctx.check("P27: the rule's own wait: seated and still 1 s after the hand-over", rep.arrivalWaited >= 1 - 1e-6 && rep.arrivalWaited <= 1.1, `${rep.arrivalWaited.toFixed(3)} s`);

  // a second Seat here without a new hand-over: seated and still, it stays dark
  await ctx.seatHere();
  const noHand = await sit(ctx, seatedY, 2);
  ctx.check("P27: Seat here again: no lights-up without a new hand-over", noHand.slice(2).every((f) => f.lightsUp < 0 && f.phase === "arrival"), `lights-up ${started(noHand.slice(2))} over 2 s seated and still`);
  if (!ctx.timing) ctx.check("P27: Seat here again: black", noHand.slice(2).every((f) => f.luma <= BLACK), `mean luma max ${lumaMax(noHand.slice(2))}`);

  // the hand-over (the Quest reports visible-blurred while the headset is off): then the lights come up
  await r.handOver();
  const again = await ctx.until("watching", Math.round(5 * HZ));
  const s2 = again.findIndex((f) => f.lightsUp >= 0);
  ctx.check("P27: after the new hand-over: lights up within 1.1 s", again[0]?.lightsUp < 0 && s2 >= 0 && s2 <= 1.1 * HZ && again.at(-1)?.phase === "watching", s2 >= 0 ? `after ${(s2 / HZ).toFixed(3)} s, then ${again.at(-1)?.phase}` : "never");
}
