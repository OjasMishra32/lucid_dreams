// P33-P35: the arena is opaque (alpha 255 everywhere) except where the room shows; See my room fades out over 0.6 s and
// back over 0.8 s (+/- 1 frame) and opens the room (alpha 0 on room pixels, once its 50% veil has eased off) while the
// players and their contact shadows stay; the room opens from 0.6 m to the bounds and is fully open at 0.3 m.
// Checked in the phases the stubs reach (arrival; watching once the clock is built, since the way back restarts it);
// the other seven join as their modules land (P34 asks for all 9). The edge is checked on a simulated distance to the
// bounds (world.testEdge, dev only), since the bounds are seat.ts's (seatmath.test.ts checks the distance itself).
// Owner: stream E.
import { HZ, alphaOk, sitAtSeat } from "../look/view.mjs";
import { boundsCase } from "../look/bounds.mjs";

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
    // extras beyond the bounds go with the arena, one inside them stays (P34); court.ts hands freeze.bounds the room.
    // The extra and both rooms come from court.json (boundsCase), never from the order the splats loaded in.
    const kept = await ctx.page.evaluate((c) => {
      if (!c) return null;
      const fz = window.__courtLook.freeze;
      const extra = fz.people.find((p) => p.id === c.id);
      if (!extra) return { id: c.id, missing: true };
      const opacity = () => extra.splats[0]?.opacity ?? extra.reliefMats[0]?.opacity ?? NaN;
      fz.bounds(null);
      const none = opacity();
      fz.bounds(c.inside);
      const inside = opacity();
      fz.bounds(c.beyond);
      const beyond = opacity();
      const pairStays = fz.people.filter((p) => p.pair).every((p) => p.splats[0]?.opacity === 1);
      fz.bounds(null);
      return { id: c.id, none, inside, beyond, pairStays };
    }, boundsCase(ctx.court));
    if (kept)
      ctx.check(
        "open world: an extra inside the bounds stays, one beyond them goes (P34)",
        !kept.missing && kept.none === 0 && kept.inside === 1 && kept.beyond === 0 && kept.pairStays,
        kept.missing ? `${kept.id} isn't in the freeze (it didn't load)` : `${kept.id}: ${kept.none} with no bounds, ${kept.inside} inside, ${kept.beyond} beyond; the pair ${kept.pairStays ? "stays" : "went"}`,
      );
    const back = await ctx.pressFrames("room", Math.round(0.8 * HZ) + 4);
    const backAt = back.findIndex((f) => f.roomP <= 0);
    ctx.check("open world: back in 0.8 s (P34)", Math.abs(backAt + 1 - 0.8 * HZ) <= 1, `arena back after ${backAt + 1} frames`);
    ctx.check("open world: opaque before and after (P33)", alphaOk(before) && back.at(-1).alphaMin === 255, `alpha min ${Math.min(...before.map((f) => f.alphaMin))} / ${back.at(-1).alphaMin}`);
    await ctx.page.evaluate(() => window.__courtLook.freeze.reveal(0));
    ctx.report.open = { outAt: outAt + 1, backAt: backAt + 1, veil: veil.alphaMin, inRoom: { alphaMin: inRoom.alphaMin, alphaMean: inRoom.alphaMean }, bounds: kept };
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
  if (ctx.handOver) await ctx.handOver(); // the arrival waits for the hand-over after Seat here (P38)
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

  // last (it takes the arena away): dispose frees the dome and every arena geometry, material and texture it made
  const freed = await ctx.page.evaluate(() => {
    const w = window.__courtLook.world;
    const r = w.renderer;
    const count = () => ({ geometries: r.info.memory.geometries, textures: r.info.memory.textures });
    let dome = 0;
    w.dome.geometry.addEventListener("dispose", () => dome++);
    w.dome.material.addEventListener("dispose", () => dome++);
    const before = count();
    w.dispose();
    return { before, after: count(), dome, domeInScene: !!w.dome.parent, arenaInWorld: !!w.group.parent };
  });
  ctx.check(
    "dispose frees the dome and the arena",
    freed.dome === 2 && !freed.domeInScene && !freed.arenaInWorld && freed.after.geometries < freed.before.geometries && freed.after.textures < freed.before.textures,
    `dome ${freed.dome}/2 disposed; geometries ${freed.before.geometries} -> ${freed.after.geometries}, textures ${freed.before.textures} -> ${freed.after.textures}`,
  );
  ctx.report.dispose = freed;
}
