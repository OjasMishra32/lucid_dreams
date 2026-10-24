// P33-P35: the arena is opaque (alpha 255 everywhere) except where the room shows; See my room fades out over 0.6 s and
// back over 0.8 s (+/- 1 frame) and opens the room (alpha 0 on room pixels, once its 50% veil has eased off) while the
// players and their contact shadows stay; the room opens from 0.6 m to the bounds and is fully open at 0.3 m.
// Checked in the phases the stubs reach (arrival; watching once the clock is built, since the way back restarts it);
// the other seven join as their modules land (P34 asks for all 9). The edge is checked on a simulated distance to the
// bounds (world.testEdge, dev only), since the bounds are seat.ts's (seatmath.test.ts checks the distance itself).
// Owner: stream E.
import { HZ, alphaOk, sitAtSeat } from "../look/view.mjs";

export const owner = "E (look)";
export const needs = ["world"];

export default async function room(ctx) {
  if (ctx.timing) ctx.skip("capture only");
  // the open world first, on the setup page: the players and their shadows stay in the room, under a veil that eases off
  const first = await ctx.nextFrame();
  if (first.setup && ctx.modules.freeze) {
    await sitAtSeat(ctx);
    await ctx.page.evaluate(() => window.__courtLook.freeze.reveal(1));
    const before = await ctx.frames(3);
    const out = await ctx.pressFrames("room", Math.round(2.2 * HZ));
    await ctx.save("room-in");
    const outAt = out.findIndex((f) => f.roomP >= 1);
    ctx.check("open world: out in 0.6 s (P34)", Math.abs(outAt + 1 - 0.6 * HZ) <= 1, `room fully in after ${outAt + 1} frames`);
    const veil = out[Math.round(0.4 * HZ) - 1];
    ctx.check("a 50% veil over the room, easing off (3.6)", veil.alphaMin >= 90 && veil.alphaMin <= 115, `alpha min ${veil.alphaMin} at 0.4 s, ${out[outAt].alphaMin} at 0.6 s`);
    const inRoom = out.at(-1);
    ctx.check("open world: the room shows once the veil is off (P34)", inRoom.alphaMin === 0, `alpha min ${inRoom.alphaMin} at 2.2 s`);
    ctx.check("open world: the players and their shadows stay (P34: alpha > 0 on them)", inRoom.alphaMean > 0.5, `alpha mean ${inRoom.alphaMean} (0 = nothing kept)`);
    const back = await ctx.pressFrames("room", Math.round(0.8 * HZ) + 4);
    const backAt = back.findIndex((f) => f.roomP <= 0);
    ctx.check("open world: back in 0.8 s (P34)", Math.abs(backAt + 1 - 0.8 * HZ) <= 1, `arena back after ${backAt + 1} frames`);
    ctx.check("open world: opaque before and after (P33)", alphaOk(before) && back.at(-1).alphaMin === 255, `alpha min ${Math.min(...before.map((f) => f.alphaMin))} / ${back.at(-1).alphaMin}`);
    await ctx.page.evaluate(() => window.__courtLook.freeze.reveal(0));
    ctx.report.open = { outAt: outAt + 1, backAt: backAt + 1, veil: veil.alphaMin, inRoom: { alphaMin: inRoom.alphaMin, alphaMean: inRoom.alphaMean } };
  }

  // the edge, always on (P35): whole from 0.6 m, opening between, fully open at 0.3 m and past it
  const at = async (d) => {
    await ctx.page.evaluate((x) => (window.__courtLook.world.testEdge = x), d);
    return (await ctx.frames(3)).at(-1);
  };
  const far = await at(2);
  const start = await at(0.6);
  const mid = await at(0.45);
  const open = await at(0.3);
  const past = await at(0.1);
  await at(null);
  ctx.check("P35: whole until 0.6 m from the bounds", far.alphaMin === 255 && start.alphaMin === 255, `alpha min ${far.alphaMin} at 2 m, ${start.alphaMin} at 0.6 m`);
  ctx.check("P35: opening between 0.6 and 0.3 m", mid.alphaMin > 0 && mid.alphaMin < 255, `alpha min ${mid.alphaMin} at 0.45 m`);
  ctx.check("P35: fully open at 0.3 m and past it", open.alphaMin === 0 && past.alphaMin === 0, `alpha min ${open.alphaMin} at 0.3 m, ${past.alphaMin} at 0.1 m`);

  // See my room in each phase the stubs reach
  await ctx.seatHere();
  const phases = ctx.modules.clock ? ["arrival", "watching"] : ["arrival"];
  for (const phase of phases) {
    if (phase !== "arrival") await ctx.until(phase, HZ * 8);
    const out = await ctx.pressFrames("room", Math.round(0.6 * HZ) + 4);
    const outAt = out.findIndex((f) => f.roomP >= 1);
    ctx.check(`${phase}: out in 0.6 s`, out[0].phase === phase && Math.abs(outAt + 1 - 0.6 * HZ) <= 1, `room fully in after ${outAt + 1} frames (pressed in ${out[0].phase})`);
    const held = await ctx.frames(Math.round(1.6 * HZ));
    ctx.check(`${phase}: the room shows`, held.at(-1).alphaMin === 0, `alpha min ${held.at(-1).alphaMin} with the room in, the veil off`);
    const back = await ctx.pressFrames("room", Math.round(0.8 * HZ) + 4);
    const backAt = back.findIndex((f) => f.roomP <= 0);
    ctx.check(`${phase}: back in 0.8 s`, Math.abs(backAt + 1 - 0.8 * HZ) <= 1, `arena back after ${backAt + 1} frames`);
    ctx.check(`${phase}: opaque again (P33)`, back.at(-1).alphaMin === 255, `alpha min ${back.at(-1).alphaMin}`);
    ctx.report[phase] = [...out, ...back].map(({ thumb, view, ...f }) => f);
  }
  if (!ctx.modules.clock) ctx.report.watching = "waiting on the clock (stream C): the way back restarts it";
}
