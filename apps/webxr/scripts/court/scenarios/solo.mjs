// ?solo: one person testing alone (in the headset or ?emulate). Seat here is taken where the head is once tracking
// settles, and the arrival doesn't wait for a hand-over that never comes: a seated, still head starts the lights-up,
// then the watch. Run with --query solo (skipped otherwise; without the flag the arrival scenario holds the wait).
// Owner: the integrator.
export const owner = "integrator";
export const needs = ["seat", "seatmath"];

const HZ = 72;

export default async function solo(ctx) {
  if (!new URL(ctx.page.url()).searchParams.has("solo")) ctx.skip("run with --query solo");
  const run = await ctx.until("watching", HZ * 15);
  const seated = run.find((f) => !f.setup);
  const up = run.find((f) => f.lightsUp >= 0);
  ctx.check("?solo: Seat here is taken by itself", !!seated, seated ? `seated at frame ${seated.n}` : `setup all ${run.length} frames`);
  ctx.check("?solo: the lights come up without a hand-over, on a seated, still head (1-1.1 s)", !!up && up.still >= 1 - 1e-6 && up.still <= 1.1, up ? `still ${up.still.toFixed(3)} s` : "never");
  ctx.check("?solo: then the watch", run.at(-1)?.phase === "watching", `${run.at(-1)?.phase} after ${run.length} frames`);
}
