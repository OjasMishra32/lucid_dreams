// Drift and proximity while walking: the court moves 0 mm over a 17-pose walk around the play area (the world group's
// placement never changes after Seat here; seat.ts is its only writer), and P17 once the freeze is built (an eye 0.2 m
// from a torso or head capsule fades that player to 30% within 300 ms; 0.3 m from the ball or a hand fades nothing).
// Owner: stream C (P17: stream E).
export const owner = "C (core)";
export const needs = ["seat", "seatmath"];

export default async function walk(ctx) {
  await ctx.nextFrame();
  const y = await ctx.device((d) => d.position.y);
  await ctx.seatHere();
  await ctx.frames(4);
  const placed = (await ctx.snapshot()).world;
  let worst = 0;
  for (let i = 0; i < 17; i++) {
    const a = (2 * Math.PI * i) / 17;
    await ctx.device((d, p) => d.position.set(p.x, p.y, p.z), { x: 1.2 * Math.cos(a), y: y + 0.45 * (i % 2), z: 1.2 * Math.sin(a) });
    await ctx.frames(6);
    const w = (await ctx.snapshot()).world;
    worst = Math.max(worst, Math.hypot(...w.position.map((v, k) => v - placed.position[k])) * 1000, Math.abs(w.yaw - placed.yaw) * 1000);
  }
  ctx.check("no drift over 17 poses", worst === 0, `worst ${worst.toFixed(3)} mm (or mrad of yaw)`);
  if (ctx.modules.freeze) ctx.check("P17: capsule fade", false, "not written yet (stream E)");
  else ctx.report.proximity = "waiting on freeze (stream E)";
}
