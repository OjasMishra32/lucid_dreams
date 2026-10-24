// The time stop from a press in pass 2: lands exactly on F (the show frame of the freeze is court.json's freezeSource)
// and is smooth: no per-display-frame change spike (max / median <= 2.5 of the 16 x 9 luma thumbnail's mean change)
// through the ease. The landing maths for every press time is clock.test.ts's; the resume's smoothness joins once the
// hand-off and the return run (stream C's clock, stream D's video). Owner: stream C.
export const owner = "C (core)";
export const needs = ["clock", "video"];

const SPIKE = 2.5;
const CELLS = 16 * 9;

export default async function ease(ctx) {
  await ctx.seatHere();
  await ctx.until("watching", 72 * 8);
  const { pass2 } = ctx.court.video.segments;
  // early in pass 2
  let f = await ctx.nextFrame();
  while (f.segment !== "pass2" || f.frame < pass2[0] + 24) f = await ctx.nextFrame();
  await ctx.press("step");
  const run = await ctx.until("handoff", 72 * 30);
  const easing = run.filter((x) => x.segment === "ease");
  const landed = run.find((x) => x.segment === "freeze");
  ctx.check("eases", easing.length > 0, `${easing.length} display frames of ease`);
  const src = landed ? ctx.showFrames[landed.onScreen]?.src : undefined;
  ctx.check("lands on F", src === ctx.court.video.freezeSource, landed ? `show frame ${landed.onScreen} (source ${src}; F is ${ctx.court.video.freezeSource})` : "never reached the freeze");
  if (!ctx.timing) {
    const change = [];
    for (let i = 1; i < easing.length; i++) change.push(easing[i].thumb.reduce((s, v, k) => s + Math.abs(v - easing[i - 1].thumb[k]), 0) / CELLS);
    const sorted = [...change].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const max = sorted.at(-1) ?? 0;
    ctx.check("no change spike", median > 0 && max / median <= SPIKE, `max ${max.toFixed(2)} / median ${median.toFixed(2)} grey levels per display frame`);
  }
  ctx.report.frames = run.map(({ thumb, view, ...x }) => x);
}
