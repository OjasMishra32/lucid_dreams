// Change seat (the presenter, between judges): from the watch, a 2 s hold on the palm menu's Change seat goes back to
// the setup page (Seat here over See my room); the show stops there, and the world stays on its anchor until the next
// Seat here, which takes a new seat under the head and waits for the next hand-over (seat.arrival); the show then
// starts from the top. A 1 s press changes nothing. Owner: the integrator.
import { rig } from "../rig.mjs";

export const owner = "integrator";
export const needs = ["ui", "seat", "seatmath", "clock", "vrhands"];

const HZ = 72;
const pose = (s) => JSON.stringify([s.world.position.map((v) => Number(v.toFixed(6))), Number(s.world.yaw.toFixed(6))]);

export default async function reseat(ctx) {
  const r = rig(ctx);
  await ctx.frames(2);
  await r.setHead([0, 1.15, 0], 0);
  await ctx.seatHere();
  await r.handOver();
  await ctx.until("watching", HZ * 8);
  await ctx.frames(HZ);
  await r.palm(true);
  const watchIds = (await r.buttons()).map((b) => b.id);
  ctx.check("Change seat is on the palm menu in the watch", watchIds.includes("changeSeat"), watchIds.join(", "));

  await r.hold("changeSeat", 1000);
  const short = await ctx.snapshot();
  ctx.check("a 1 s press on Change seat changes nothing", !short.setup && short.phase === "watching", `setup ${short.setup}, ${short.phase}`);
  await r.hold("changeSeat", 2300);
  const back = await ctx.snapshot();
  const setupIds = (await r.buttons()).map((b) => b.id);
  ctx.check("a 2 s hold goes back to the setup page", back.setup && setupIds.join() === "seatHere,room", `setup ${back.setup}, menu ${setupIds.join(", ")}`);
  const held = await ctx.frames(HZ);
  ctx.check("the show stops on the setup page", held.every((f) => f.setup && f.frame === held[0].frame), `clock frame ${held[0].frame} -> ${held.at(-1).frame} over ${held.length} frames`);
  const later = await ctx.snapshot();
  ctx.check("the world stays on its anchor until the next Seat here", pose(later) === pose(back), `${pose(back)} -> ${pose(later)}`);

  // a new seat: a step to the side and a turn, Seat here (the hold), the hand-over, the show from the top
  await r.handsAway();
  await r.setHead([0.6, 1.15, 0.4], 0.5);
  await ctx.frames(3);
  await r.palm(true);
  await r.hold("seatHere", 2300);
  const seated = await ctx.snapshot();
  const rep = await r.seat();
  const off = rep ? Math.hypot(rep.seatFloor[0] - rep.chair.position[0], rep.seatFloor[2] - rep.chair.position[2]) : Infinity;
  ctx.check("Seat here again takes a new seat under the head", !seated.setup && pose(seated) !== pose(back) && off <= 0.1, `setup ${seated.setup}, world ${pose(back)} -> ${pose(seated)}, ${(off * 1000).toFixed(2)} mm from the head`);
  const wait = await ctx.frames(Math.round(1.5 * HZ));
  ctx.check("then the arrival waits for the next hand-over", wait.every((f) => f.phase === "arrival" && f.lightsUp < 0), `${[...new Set(wait.map((f) => f.phase))].join(", ")}, lights-up ${wait.some((f) => f.lightsUp >= 0) ? "started" : "waiting"}`);
  await r.handsAway();
  await r.handOver();
  const run = await ctx.until("watching", HZ * 8);
  const top = run.at(-1);
  ctx.check("and the show starts from the top", top.phase === "watching" && top.segment === "pass1" && top.frame <= ctx.court.video.segments.pass1[0] + 2, `${top.phase} ${top.segment} frame ${top.frame}`);
}
