// The seat and the walk: P1 (Seat here puts the seat on F's ray under the head, F's view along its yaw), P24 (the world
// moves only behind a <= 0.3 s fade, once, at full black), P14 (0 mm of drift over a 17-pose walk), P29 in the page
// (standing up jumps to the walking anchoring: the chair 1 m clear, both bodies 0.3 m inside the 3.5 m floor), P35's
// input (seat.ts's distance to the play area at 0.6, 0.45 and 0.3 m from a wall), and P17 once the freeze is built
// (stream E's). Owner: stream C (P17: stream E).
import { fmt, rig, wrap } from "../rig.mjs";

export const owner = "C (core)";
export const needs = ["seat", "seatmath"];

const moved = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]) + Math.abs(wrap(a.yaw - b.yaw)) > 1e-6;

export default async function walk(ctx) {
  const r = rig(ctx);
  await ctx.frames(2);
  const yaw = 0.7;
  await r.setHead([0.4, 1.15, -0.3], yaw);
  await ctx.frames(3);
  await ctx.page.evaluate(() => window.__courtSeat.trace());
  const frames = await ctx.pressFrames("seatHere", 40);
  const trace = await ctx.page.evaluate(() => window.__courtSeat.trace());
  const log = trace.map(([veil, x, z, yw]) => ({ veil, world: { position: [x, 0, z], yaw: yw } }));
  const rep = await r.seat();
  const off = Math.hypot(rep.seatFloor[0] - rep.chair.position[0], rep.seatFloor[2] - rep.chair.position[2]);
  const yawErr = (Math.abs(wrap(rep.viewYaw - rep.chair.yaw)) * 180) / Math.PI;
  ctx.report.seat = rep;
  ctx.check("P1: the seat's floor point is under the head at Seat here, F's view along its yaw", off <= 0.1 && yawErr <= 0.5 && Math.abs(wrap(rep.chair.yaw - yaw)) < 0.01,
    `${(off * 1000).toFixed(2)} mm off, yaw error ${yawErr.toFixed(4)} deg, D' ${rep.distance} m`);
  const moves = log.filter((f, i) => i > 0 && moved(f.world, log[i - 1].world));
  const first = log.findIndex((f) => f.veil > 0);
  const clear = log.findIndex((f, i) => i > first && f.veil === 0);
  ctx.check("P24: Seat here moves the world once, at full black, behind a <= 0.3 s fade", moves.length === 1 && moves[0].veil === 1 && first >= 0 && clear - first + 1 <= Math.round(0.3 * 72),
    `${moves.length} move(s) at veil ${moves.map((m) => m.veil).join(",")}, veil up ${clear - first + 1} frames`);
  if (!ctx.timing) ctx.check("P33: opaque through the fade", frames.every((f) => f.alphaMin === 255), `alpha min ${Math.min(...frames.map((f) => f.alphaMin))} over ${frames.length} frames`);

  // P35's input: the distance to the play area set at Seat here, at 0.6, 0.45 and 0.3 m from the wall behind the chair
  const c = rep.chair;
  const back = [Math.sin(c.yaw + Math.PI / 4), Math.cos(c.yaw + Math.PI / 4)]; // out through one wall of the chair's corner
  const edges = [];
  for (const d of [0.6, 0.45, 0.3]) {
    const t = 0.6 - d;
    edges.push(await r.edge([c.position[0] + back[0] * t, 1.6, c.position[2] + back[1] * t]));
  }
  ctx.check("P35: the edge fade's input is the distance to the play area (0.6, 0.45, 0.3 m)", edges.every((e, i) => Math.abs(e - [0.6, 0.45, 0.3][i]) < 1e-6), edges.map((e) => fmt(e)).join(", "));

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

  // P29 in the page: through the watch to the open world, stand up: the walking anchoring
  if (!ctx.modules.clock) ctx.skip("the walking anchoring needs the clock (the open world)");
  await r.setHead([0.4, 1.15, -0.3], yaw);
  await r.handOver();
  await ctx.until("watching", 72 * 8);
  await ctx.press("step");
  const toOpen = await ctx.until("open", 72 * 40);
  if (toOpen.at(-1)?.phase !== "open") throw new Error(`never opened (${toOpen.at(-1)?.phase})`);
  await r.setHead([0.4, 1.15 + 0.4, -0.3], yaw);
  const up = await ctx.until("walking", 72 * 2);
  await ctx.frames(30);
  const w = await r.seat();
  ctx.report.walking = w;
  ctx.check("P29: standing up jumps to the walking anchoring; the chair 1 m clear, both bodies 0.3 m inside the 3.5 m floor", up.at(-1)?.phase === "walking" && w.walking && w.chairClearance >= ctx.court.seat.clear && Math.min(...w.inside) >= 0.3 && w.problems.length === 0,
    `${up.at(-1)?.phase}; chair ${fmt(w.chairClearance)} m clear; bodies ${w.inside.map((x) => fmt(x)).join(", ")} m inside${w.problems.length ? `; ${w.problems.join("; ")}` : ""}`);
  if (ctx.modules.freeze) ctx.check("P17: capsule fade", false, "not written yet (stream E): seatmath ProximityFade gives the opacities");
  else ctx.report.proximity = "waiting on freeze (stream E)";
}
