// The opening title (opening.ts) over the arrival's lights-up (after Seat here and the hand-over, or --query solo's own
// seat): stills to look at (out/opening-*.png): with ?solo the title's own stage on the dark screen (opening-0*-hold),
// then the lights-up and the broadcast rising after it; the hold black after a hand-over (P27); then the watch. The light steps themselves are opening.test.ts's (every texel at 72 and 90 Hz).
// Owner: the integrator.
import { rig } from "../rig.mjs";

export const owner = "integrator";
export const needs = ["seat", "light"];

const HZ = 72;
/** Seconds into the lights-up to save (the watch at 3.8), and from the first seated frame in the solo hold (EARLY: in to 2.2, full, out 2.9-5.0, the lights-up from 4.4). */
const AT = [0.3, 1.2, 2.2, 3.3];
const HOLD_AT = [0.7, 1.6, 2.6, 3.7];

export default async function opening(ctx) {
  const solo = new URL(ctx.page.url()).searchParams.has("solo");
  if (!solo) {
    await ctx.nextFrame();
    await ctx.seatHere();
    await rig(ctx).handOver();
  }
  const dark = [];
  let f = (await ctx.frames(1))[0];
  const held = [];
  let t0 = 0;
  for (let n = 0; n < HZ * 20 && f.lightsUp < 0; n++) {
    if (!f.setup) {
      if (!dark.length) t0 = Date.now();
      dark.push(f);
    }
    const at = HOLD_AT[held.length];
    if (solo && dark.length && at !== undefined && (Date.now() - t0) / 1000 >= at) {
      const s = await ctx.save(`opening-0${held.length + 1}-hold`);
      held.push({ at, s: Number(((Date.now() - t0) / 1000).toFixed(2)), lightsUp: s?.lightsUp });
      f = s ?? f;
    } else f = (await ctx.frames(1))[0];
  }
  if (solo) ctx.check("the opening: stills of the title on the dark screen (the lights-up not started)", held.length >= 3 && held.every((h) => h.lightsUp < 0), held.map((h) => `${h.at}: at ${h.s} s up ${h.lightsUp}`).join("; "));
  ctx.check("the opening: the lights-up starts", f.lightsUp >= 0, `lightsUp ${f.lightsUp}`);
  if (!ctx.timing && !ctx.realtime && !solo) ctx.check("the opening: nothing drawn in the dark hold after a hand-over", dark.every((d) => d.luma <= 2), `mean luma max ${Math.max(0, ...dark.map((d) => d.luma))} over ${dark.length} frames`);
  const saved = [];
  for (const at of AT) {
    while (f.phase === "arrival" && f.lightsUp < at - 0.5 / HZ) f = (await ctx.frames(1))[0];
    if (f.phase !== "arrival") break;
    const s = await ctx.save(`opening-up-${String(Math.round(at * 10)).padStart(2, "0")}`);
    saved.push({ at, lightsUp: s?.lightsUp, luma: s?.luma });
    f = s ?? f;
  }
  ctx.report.stills = saved;
  // on time only under --realtime: otherwise each save's read-back stalls frames that run freely, and the lights-up
  // runs past the next points before the save returns
  if (ctx.realtime) ctx.check("the opening: stills through the lights-up", saved.length === AT.length, saved.map((s) => `${s.at}: up ${s.lightsUp} luma ${s.luma}`).join("; "));
  const run = await ctx.until("watching", HZ * 3);
  const up = run.at(-1);
  ctx.check("the opening: then the watch, on the lights-up's time", up?.phase === "watching", `${up?.phase} at lightsUp ${up?.lightsUp}`);
}
