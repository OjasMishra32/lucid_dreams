// The time stop from a press early in pass 2 (P6): the clock lands exactly on F (court.json's freezeSource), steps one
// show frame per display frame (no held or skipped frame; the only jump is into the ease), and its speed changes by no
// more than 0.02 per display frame; with the video built, the frame on screen lands on F too and the picture has no
// change spike (max / median <= 2.5 of the 16 x 9 luma thumbnail's mean change). The landing maths for every press
// time is clock.test.ts's. Owner: stream C (the picture: stream D's video).
import { rig } from "../rig.mjs";

export const owner = "C (core)";
export const needs = ["clock"];

const SPIKE = 2.5;
const CELLS = 16 * 9;

export default async function ease(ctx) {
  const r = rig(ctx);
  await ctx.seatHere();
  await r.handOver();
  await ctx.until("watching", 72 * 8);
  const { pass2, eases } = ctx.court.video.segments;
  // early in pass 2
  let f = await ctx.nextFrame();
  while (f.segment !== "pass2" || f.frame < pass2[0] + 24) f = await ctx.nextFrame();
  const run = await ctx.pressFrames("step", 72 * 6);
  const until = run.findIndex((x) => x.segment === "freeze");
  const path = until >= 0 ? run.slice(0, until + 1) : run;
  const easing = path.filter((x) => x.segment === "ease");
  const landed = path.at(-1);
  const src = ctx.showFrames[landed?.frame]?.src;
  ctx.check("P6: the press eases", easing.length > 0, `${easing.length} display frames of ease (ease ${eases.findIndex((e) => e.frames[0] === easing[0]?.frame)})`);
  ctx.check("P6: lands exactly on F", landed?.segment === "freeze" && src === ctx.court.video.freezeSource, landed ? `show frame ${landed.frame} (source ${src}; F is ${ctx.court.video.freezeSource})` : "never reached the freeze");
  let held = 0;
  let skipped = 0;
  let worst = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    worst = Math.max(worst, Math.abs(b.speed - a.speed));
    if (b.segment === "freeze" && a.segment === "freeze") continue;
    if (b.frame === a.frame) held++;
    else if (b.frame !== a.frame + 1 && !(b.segment === "ease" && a.segment === "pass2")) skipped++;
  }
  ctx.check("P6: one show frame per display frame into F", held === 0 && skipped === 0, `${held} held, ${skipped} skipped over ${path.length} frames`);
  ctx.check("P6: speed changes <= 0.02 per display frame", worst <= 0.02 + 1e-9, `largest change ${worst.toFixed(4)}`);
  if (ctx.modules.video) {
    const shown = ctx.showFrames[landed?.onScreen]?.src;
    ctx.check("P6: the frame on screen lands on F", shown === ctx.court.video.freezeSource, `on screen ${landed?.onScreen} (source ${shown})`);
    if (!ctx.timing) {
      const change = [];
      for (let i = 1; i < easing.length; i++) change.push(easing[i].thumb.reduce((s, v, k) => s + Math.abs(v - easing[i - 1].thumb[k]), 0) / CELLS);
      const sorted = [...change].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const max = sorted.at(-1) ?? 0;
      ctx.check("no change spike", median > 0 && max / median <= SPIKE, `max ${max.toFixed(2)} / median ${median.toFixed(2)} grey levels per display frame`);
    }
  } else ctx.report.picture = "waiting on video (stream D)";
  ctx.report.frames = path.map(({ thumb, view, ...x }) => x);
}
