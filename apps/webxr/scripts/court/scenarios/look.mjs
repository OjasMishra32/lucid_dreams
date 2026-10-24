// The look from the seat through the time stop, the hand-off's light and the pool (stream E's modules: the light
// field, the world, the freeze), driven straight through the light field before Seat here, so it runs ahead of the
// clock and the hand-off; P44 through court.ts's own phases is the handoff scenario's.
//   P33: alpha 255 on every frame. P44: no light change over 1 grey level per display frame (the 16 x 9 grid; the
//   CPU twin in lightfield.test.ts holds it per pixel on the encoded byte, dither included, up to SAFE_GREY). P28: the
//   house goes down while the pair's own pixels move <= 1 grey level. P23: the Reality check tints what was never
//   filmed. (P17, the capsule fade, is scenarios/proximity.mjs.)
// Owner: stream E.
import { HZ, alphaOk, blueRatio, lumaAt, runLight, sitAtSeat, worstStep } from "../look/view.mjs";

export const owner = "E (look)";
export const needs = ["light", "world", "freeze"];

export default async function look(ctx) {
  if (ctx.timing) ctx.skip("capture only");
  const first = await ctx.nextFrame();
  if (!first.setup) ctx.skip("needs the setup page (before Seat here), where nothing else drives the light");
  await sitAtSeat(ctx);
  await ctx.page.evaluate(() => {
    window.__courtLook.world.light.set("watch", 0);
    window.__courtLook.freeze.reveal(1);
  });
  await ctx.frames(Math.round(0.5 * HZ)); // Spark's first generation and sort (shown late, splats pop for 2-6 frames)
  const watch = await ctx.save("look-watch");
  const ease = Array.from({ length: Math.round(1.2 * HZ) }, (_, i) => ["ease", i / HZ, null]);
  const open = Array.from({ length: 5 * HZ + 1 }, (_, i) => ["handoff", i / HZ, null]);
  const a = await runLight(ctx, ease);
  const atF = await ctx.save("look-freeze");
  const b = await runLight(ctx, open);
  await ctx.save("look-open");
  const all = [...a, ...b];
  ctx.check("opaque through the ease and the pool (P33)", alphaOk(all), `alpha min ${Math.min(...all.map((f) => f.alphaMin))} over ${all.length} frames`);
  const s = worstStep(all);
  ctx.check("every light change <= 1 grey level per display frame (P44, 16 x 9 grid)", s.worst <= 1, `worst cell step ${s.worst} at frame ${s.at} of ${all.length} (${s.at < a.length ? "ease" : "hand-off"})`);
  ctx.check(
    "the house goes down over the ease and the pool lifts the floor after (P28)",
    a.at(-1).luma < a[0].luma && b.at(-1).luma > b[HZ].luma,
    `mean luma watch ${a[0].luma}, F ${a.at(-1).luma}, F+1 ${b[HZ].luma}, F+5 ${b.at(-1).luma}`,
  );
  // the pair's own pixels (the middle of each torso) through the time stop
  const torsos = ctx.court.freeze.players.map((p) => p.capsules[0].a.map((v, i) => (v + p.capsules[0].b[i]) / 2));
  const before = lumaAt(ctx, "look-watch", watch.view, torsos);
  const after = lumaAt(ctx, "look-freeze", atF.view, torsos);
  ctx.check("the pair stays at 1.0 through the time stop (P28: <= 1 grey level)", Math.abs(after - before) <= 1, `torso luma ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  // the Reality check: everything not filmed goes blue
  await ctx.pressFrames("reality", 3);
  await ctx.save("look-reality");
  await ctx.pressFrames("reality", 3);
  const r0 = blueRatio(ctx, "look-open");
  const r1 = blueRatio(ctx, "look-reality");
  ctx.check("the Reality check tints what was never filmed blue (P23)", r1 > r0 * 1.2, `blue / red ${r0.toFixed(2)} -> ${r1.toFixed(2)}`);
  ctx.report.luma = { watch: a[0].luma, freeze: a.at(-1).luma, open: b.at(-1).luma, pairBefore: before, pairAfter: after };
  ctx.report.frames = all.map(({ thumb, view, ...f }) => f);
}
