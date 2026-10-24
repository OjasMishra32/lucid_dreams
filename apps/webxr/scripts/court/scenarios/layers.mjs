// P43, the layered watch from the seat on the stand-in (a gap between the shooter and the defender, a third person
// behind): no doubled or torn body > 0.1 deg in any display frame (every person on their own card; the plate behind
// them has no people), and P9's held frame (<= 1 grey level per display frame under 2 cm of head sway). Captures
// frames from the seat with the true scene from the same view beside each (standin.mjs truthAt, from the frame's
// logged view); the judge is stream D's to write (diff.mjs alignment per person, with truth.kind as the people's
// masks). Owner: stream D.
export const owner = "D (handoff)";
export const needs = ["clock", "video", "proxies", "seat", "seatmath"];

/** Every how many display frames a frame is captured and judged. */
const EVERY = 9;

export default async function layers(ctx) {
  if (!ctx.standin) ctx.skip("P43 needs the stand-in's truth (run without --bundle)");
  if (ctx.timing) ctx.skip("capture only");
  await ctx.seatHere();
  await ctx.until("watching", 72 * 8);
  const { pass2 } = ctx.court.video.segments;
  const pairs = [];
  let f = await ctx.nextFrame();
  while (f.segment !== "pass2") f = await ctx.nextFrame();
  for (let k = 0; f.segment === "pass2" && f.frame < pass2[1] - EVERY; k++) {
    const shot = await ctx.save(`layers-${String(k).padStart(3, "0")}`);
    const truth = await ctx.truth(shot.view, shot.onScreen);
    pairs.push({ frame: shot.onScreen, view: shot.view, truth: ctx.writePng(`layers-${String(k).padStart(3, "0")}-truth`, { width: shot.view.width, height: shot.view.height, rgb: truth.rgb }) });
    await ctx.frames(EVERY - 1);
    f = await ctx.nextFrame();
  }
  ctx.report.pairs = pairs;
  ctx.check("P43: no doubled or torn body > 0.1 deg", false, `not written yet (stream D): judge ${pairs.length} captured frames against their truth`);
  ctx.check("P9: held frame <= 1 grey level per display frame", false, "not written yet (stream D)");
}
