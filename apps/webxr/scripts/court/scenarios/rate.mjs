// The headset's display rate against the show's (rate.ts, court.ts at session start): the session runs at the show's
// rate whenever it offers it, and the show keeps the headset's own time: show seconds against XR frames / the rate the
// session reports, within one show frame over 10 s of the watch (with ?probe every XR frame is one period of that
// rate, as on a headset). Run as is (IWER's Quest 3 starts at 72 Hz), with --query xrhz=90 (a headset that starts at
// 90 Hz and offers 72: court.ts asks for 72) and with --query xrhz=90&xrrates=90,120 (one that can't run 72: the
// stand-in has no 90 Hz bake, so court.ts reports a mismatch and the clock's cadence keeps the time). Owner: the
// integrator.
export const owner = "integrator";
export const needs = ["clock"];

/** Show frames the clock stepped from a to b: one per frame inside a segment, one for each jump to a segment's start. */
function stepped(seg, a, b) {
  if (b.segment === a.segment && b.frame >= a.frame) return b.frame - a.frame;
  return seg[a.segment][1] - a.frame + 1 + b.frame - seg[b.segment][0];
}

export default async function rate(ctx) {
  await ctx.nextFrame();
  const xr = (await ctx.snapshot()).xr;
  if (!xr || !xr.rate) ctx.skip("the session reports no frame rate");
  const offered = xr.supported.some((r) => Math.abs(r - xr.showHz) < 0.5);
  const what = `${xr.rate} Hz for a ${xr.showHz} Hz show (offered ${xr.supported.join(", ") || "none"}; asked for ${xr.requested ?? "nothing"}; ${xr.verdict})`;
  if (offered) ctx.check("the session runs at the show's rate when it offers it", Math.abs(xr.rate - xr.showHz) < 0.5 && xr.verdict === "matched", what);
  else ctx.check("a headset that can't run the show's rate is judged (the 90 Hz bake, else a mismatch)", xr.verdict === "hz90" || xr.verdict === "mismatch", what);

  await ctx.seatHere();
  await ctx.handOver();
  await ctx.until("watching", Math.round(8 * xr.rate));
  const run = await ctx.frames(Math.round(10 * xr.rate) + 1);
  const seg = ctx.court.video.segments;
  let shown = 0;
  for (let i = 1; i < run.length; i++) shown += stepped(seg, run[i - 1], run[i]);
  const showS = shown / xr.showHz;
  const headsetS = (run.at(-1).n - run[0].n) / xr.rate;
  const off = (showS - headsetS) * xr.showHz;
  ctx.check("the show keeps the headset's time: within one show frame over 10 s", Math.abs(off) <= 1 + 1e-9 && run.every((f) => f.phase === "watching"),
    `${showS.toFixed(4)} s of show in ${headsetS.toFixed(4)} s at ${xr.rate} Hz (${off >= 0 ? "+" : ""}${off.toFixed(2)} show frames; ${[...new Set(run.map((f) => f.segment))].join(" -> ")})`);
}
