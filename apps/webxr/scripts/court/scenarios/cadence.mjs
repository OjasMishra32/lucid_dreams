// P4: one show frame per display frame through pass 1 and pass 2 (none held, none skipped), and the frame on screen is
// always the one the clock asks for (P5's part the page can see). Judder CV, the decode queue and decode p99 are
// smooth_metrics.py's (stream D's tool) on this run's report and the Quest checkpoints. Owner: stream D.
export const owner = "D (handoff)";
export const needs = ["clock", "video"];

export default async function cadence(ctx) {
  await ctx.seatHere();
  await ctx.handOver();
  const first = (await ctx.until("watching", 72 * 8)).at(-1); // the watch's first frame: show frame 0
  const { pass1, pass2 } = ctx.court.video.segments;
  const log = [first, ...(await ctx.frames(pass2[1] - pass1[0] + 1 + 36))];
  const watch = log.filter((f) => f.segment === "pass1" || f.segment === "pass2");
  let held = 0;
  let skipped = 0;
  for (let i = 1; i < watch.length; i++) {
    const step = watch[i].frame - watch[i - 1].frame;
    if (step === 0) held++;
    else if (step > 1) skipped += step - 1;
  }
  const wrong = watch.filter((f) => f.onScreen !== f.frame);
  ctx.check("P4: no held frames", held === 0, `${held} held over ${watch.length} display frames`);
  ctx.check("P4: no skipped show frames", skipped === 0, `${skipped} skipped`);
  ctx.check("P5: on screen = asked for", wrong.length === 0, wrong.length ? `${wrong.length} frames off, first at show frame ${wrong[0].frame} (on screen ${wrong[0].onScreen})` : `every frame of ${watch.length}`);
  // unpressed, pass 2 plays through and repeats, so "covered" means both ends were shown
  const ends = [pass1[0], pass1[1], pass2[0], pass2[1]];
  ctx.check("covers both passes", ends.every((e) => watch.some((f) => f.frame === e)), `ends shown: ${ends.filter((e) => watch.some((f) => f.frame === e)).join(", ")} of ${ends.join(", ")}`);
  ctx.report.frames = log.map(({ thumb, view, ...f }) => f);
}
