// P27, arrival waits for the judge: black while the session is hidden, the head is standing or moving; the lights-up
// starts within 1.1 s of a still, seated head after Seat here. Drives IWER's device (visibility, head position).
// Runs on the stubs (court.ts's phase machine). Owner: the integrator.
export const owner = "integrator";
export const needs = [];

const HZ = 72;
/** The darkest the arrival may be before the lights-up: mean luma, 0-255 (the dome and the dark field). */
const BLACK = 2;

export default async function arrival(ctx) {
  await ctx.nextFrame();
  const seatedY = await ctx.device((d) => d.position.y);
  await ctx.seatHere();
  await ctx.frames(2);

  // hidden (the headset off, a system dialog): stays black however still the head is
  await ctx.device((d) => d.updateVisibilityState("visible-blurred"));
  const hidden = await ctx.frames(Math.round(2 * HZ));
  ctx.check("hidden: waits", hidden.every((f) => f.lightsUp < 0 && f.phase === "arrival"), `lights-up ${hidden.some((f) => f.lightsUp >= 0) ? "started" : "never started"} over 2 s hidden`);
  if (!ctx.timing) ctx.check("hidden: black", hidden.every((f) => f.luma <= BLACK), `mean luma max ${Math.max(...hidden.map((f) => f.luma))}`);
  await ctx.device((d) => d.updateVisibilityState("visible"));

  // standing (head 0.4 m over the seated eye), still: waits
  await ctx.device((d, y) => d.position.set(d.position.x, y + 0.4, d.position.z), seatedY);
  const standing = await ctx.frames(Math.round(2 * HZ));
  ctx.check("standing: waits", standing.slice(2).every((f) => f.lightsUp < 0), `lights-up ${standing.some((f) => f.lightsUp >= 0) ? "started" : "never started"} over 2 s standing`);

  // seated again (Seat here restarts the arrival, so each case starts from the dark), moving (0.3 m/s side to side): waits
  await ctx.device((d, y) => d.position.set(d.position.x, y, d.position.z), seatedY);
  await ctx.seatHere();
  await ctx.frames(2);
  await ctx.device((d, y) => {
    const x0 = d.position.x;
    const t0 = performance.now();
    window.__courtSway = setInterval(() => d.position.set(x0 + 0.1 * Math.sin((performance.now() - t0) / 333), y, d.position.z), 4);
  }, seatedY);
  const moving = await ctx.frames(Math.round(2 * HZ));
  ctx.check("moving: waits", moving.every((f) => f.lightsUp < 0), `lights-up ${moving.some((f) => f.lightsUp >= 0) ? "started" : "never started"} over 2 s moving`);
  if (!ctx.timing) ctx.check("waiting: black", [...standing, ...moving].every((f) => f.luma <= BLACK), `mean luma max ${Math.max(...[...standing, ...moving].map((f) => f.luma))}`);

  // still and seated: the lights-up starts within 1.1 s, and the watch follows
  await ctx.device(() => clearInterval(window.__courtSway));
  const settle = await ctx.until("watching", Math.round(5 * HZ));
  const start = settle.findIndex((f) => f.lightsUp >= 0);
  const dark = settle[0]?.lightsUp < 0;
  ctx.check("still: lights up within 1.1 s", dark && start >= 0 && start <= 1.1 * HZ, !dark ? "the lights were already up when the head stopped" : start >= 0 ? `after ${(start / HZ).toFixed(3)} s still` : "never");
  ctx.check("then the watch", settle.at(-1)?.phase === "watching", `${settle.at(-1)?.phase} after ${settle.length} frames`);
  ctx.report.frames = [...hidden, ...standing, ...moving, ...settle].map(({ thumb, view, ...f }) => f);
}
