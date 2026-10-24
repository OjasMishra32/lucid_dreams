// The walk: P14 (0 mm of drift while the head walks round the chair: the court never moves without a fade). P17 (the
// capsule fade) is stream E's own scenario, proximity.mjs. Owner: stream C.
import { rig, wrap } from "../rig.mjs";

export const owner = "C (core)";
export const needs = ["seat"];

export default async function walk(ctx) {
  const r = rig(ctx);
  await ctx.frames(2);
  await r.setHead([0.4, 1.15, -0.3], 0.7);
  await ctx.frames(3);
  await ctx.seatHere();
  await ctx.frames(40);

  // P14: the court never moves while the head walks round the chair
  const w0 = (await ctx.snapshot()).world;
  let worst = 0;
  for (let k = 0; k < 17; k++) {
    const a = (2 * Math.PI * k) / 17;
    await r.setHead([0.4 + 1.2 * Math.sin(a), 1.15 + 0.45 * (k % 2), -0.3 + 1.2 * Math.cos(a)], a);
    await ctx.frames(4);
    const w = (await ctx.snapshot()).world;
    worst = Math.max(worst, Math.hypot(...w.position.map((v, i) => v - w0.position[i])), Math.abs(wrap(w.yaw - w0.yaw)));
  }
  ctx.check("P14: 0 mm of drift over a 17-pose walk", worst <= 1e-6, `worst ${(worst * 1000).toFixed(4)} mm (or mrad of yaw)`);
}
