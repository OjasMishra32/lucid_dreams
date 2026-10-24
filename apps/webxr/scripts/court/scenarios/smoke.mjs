// The page loads, enters the emulated session, takes Seat here and reaches the watch, drawn opaque (P33) with a clean
// console (P25). Runs on the stubs. Owner: the integrator.
export const owner = "integrator";
export const needs = [];

export default async function smoke(ctx) {
  const first = await ctx.nextFrame();
  ctx.check("session", first.phase === "arrival" && first.setup, `first XR frame in ${first.phase}, setup ${first.setup}`);
  await ctx.seatHere();
  await ctx.handOver();
  const toWatch = await ctx.until("watching", 72 * 8);
  if (!toWatch.length) throw new Error("no frames rendered after Seat here");
  const last = toWatch[toWatch.length - 1];
  const reached = last?.phase === "watching";
  ctx.check("reaches the watch", reached, reached ? `watching after ${toWatch.length} frames (${(toWatch.length / 72).toFixed(2)} s of show time)` : `still ${last?.phase} after ${toWatch.length} frames`);
  const watching = reached ? await ctx.frames(72) : [];
  const saved = await ctx.save("smoke-watch");
  const all = [...toWatch, ...watching];
  if (!ctx.timing) {
    // every frame must have been read back, or the check proves nothing
    const read = all.filter((f) => typeof f.alphaMin === "number");
    const alphaMin = Math.min(...read.map((f) => f.alphaMin));
    ctx.check("opaque (P33)", read.length === all.length && alphaMin === 255, `alpha min ${alphaMin} over ${read.length} of ${all.length} frames read back`);
    const v = saved?.view;
    ctx.check("view logged", !!v && v.width > 0 && Math.abs(v.fx - v.fy) < 1e-3 * v.fx, v ? `${v.width}x${v.height}, f ${v.fx.toFixed(1)}, centre ${v.centre.map((x) => x.toFixed(2))}` : "no view on the saved frame");
  }
  ctx.report.phases = [...new Set(all.map((f) => f.phase))];
  ctx.report.framesToWatch = toWatch.length;
  ctx.report.frames = all.map(({ thumb, ...f }) => f);
  ctx.report.snapshot = await ctx.snapshot();
}
