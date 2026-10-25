// The opening title (opening.ts) over the arrival's lights-up (after Seat here and the hand-over, or --query solo's own
// seat): stills at points of the lights-up (out/opening-*.png) to look at (with ?solo one in the dark hold too, where
// the title rises), the hold black after a hand-over (P27), and the watch on time after it. The light steps themselves are opening.test.ts's (every texel at 72 and 90 Hz).
// Owner: the integrator.
import { rig } from "../rig.mjs";

export const owner = "integrator";
export const needs = ["seat", "light"];

const HZ = 72;
/** Seconds into the lights-up to save (EARLY's fade out 1.6-3.7, the watch at 3.8), and into the solo hold. */
const AT = [0.3, 0.9, 1.5, 2.2, 2.9, 3.5];
const HOLD_AT = 0.8;

export default async function opening(ctx) {
  const solo = new URL(ctx.page.url()).searchParams.has("solo");
  if (!solo) {
    await ctx.nextFrame();
    await ctx.seatHere();
    await rig(ctx).handOver();
  }
  const dark = [];
  let f = (await ctx.frames(1))[0];
  let held = null;
  for (let n = 0; n < HZ * 15 && f.lightsUp < 0; n++) {
    if (!f.setup) dark.push(f);
    if (solo && !held && dark.length >= HOLD_AT * HZ) f = held = (await ctx.save("opening-00-hold")) ?? f;
    else f = (await ctx.frames(1))[0];
  }
  if (solo) ctx.check("the opening: a still in the solo dark hold", !!held, held ? `lightsUp ${held.lightsUp}` : `hold ${dark.length} frames`);
  ctx.check("the opening: the lights-up starts", f.lightsUp >= 0, `lightsUp ${f.lightsUp}`);
  if (!ctx.timing && !ctx.realtime && !solo) ctx.check("the opening: nothing drawn in the dark hold after a hand-over", dark.every((d) => d.luma <= 2), `mean luma max ${Math.max(0, ...dark.map((d) => d.luma))} over ${dark.length} frames`);
  const saved = [];
  for (const at of AT) {
    while (f.phase === "arrival" && f.lightsUp < at - 0.5 / HZ) f = (await ctx.frames(1))[0];
    if (f.phase !== "arrival") break;
    const s = await ctx.save(`opening-${String(Math.round(at * 10)).padStart(2, "0")}`);
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
