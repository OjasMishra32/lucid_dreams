// The time stop from a press early in pass 2 (P6): the clock lands exactly on F (court.json's freezeSource), steps one
// show frame per display frame (no held or skipped frame; the only jump is into the ease), and its speed changes by no
// more than 0.02 per display frame; with the video built, the frame on screen lands on F too and the picture has no
// change spike: no display frame whose change (the 16 x 9 luma thumbnail's mean, grey levels) is both over 2.5 x the
// ease's median and at least 1 grey level (P44's bar; real footage near F moves well under 1 a frame, so the ratio
// alone flags noise). The landing maths for every press time is clock.test.ts's. Owner: stream C (the picture:
// stream D's video).
//   Negative control: COURT_E2E_CONTROL=ease-pop runs the same press with one display frame of the ease stepped
// POP_FRAMES display frames at once (a real skip on screen); the spike check must FAIL then.
import { rig } from "../rig.mjs";

export const owner = "C (core)";
export const needs = ["clock"];

const SPIKE = 2.5;
/** A spike must also be at least this big, grey levels (P44's own bar per display frame). */
const POP = 1;
const CELLS = 16 * 9;
/** The negative control's skip, display frames stepped in one. */
const POP_FRAMES = 12;

/** The picture's change per display frame (the thumbnail's mean absolute luma change, grey levels) and its spike, if any. */
export function changeSpike(thumbs) {
  const change = [];
  for (let i = 1; i < thumbs.length; i++) change.push(thumbs[i].reduce((s, v, k) => s + Math.abs(v - thumbs[i - 1][k]), 0) / CELLS);
  const sorted = [...change].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const max = sorted.at(-1) ?? 0;
  return { change, median, max, spike: max >= POP && max > SPIKE * median };
}

export default async function ease(ctx) {
  const r = rig(ctx);
  await ctx.seatHere();
  await r.handOver();
  await ctx.until("watching", 72 * 8);
  const { pass2, eases } = ctx.court.video.segments;
  // early in pass 2
  let f = await ctx.nextFrame();
  while (f.segment !== "pass2" || f.frame < pass2[0] + 24) f = await ctx.nextFrame();
  const control = process.env.COURT_E2E_CONTROL === "ease-pop";
  const run = control
    ? await ctx.page.evaluate(
        async ([m, k]) => {
          // the 5th display frame of the ease is followed by one stepped k display frames at once
          const c = window.__court;
          c.press("step");
          const out = [];
          let n = 0;
          for (let i = 0; i < m; i++) {
            const f = await c.nextFrame();
            out.push(f);
            c.setRate(f.segment === "ease" && ++n === 5 ? f.xrHz / k : null);
          }
          c.setRate(null);
          return out;
        },
        [72 * 6, POP_FRAMES],
      )
    : await ctx.pressFrames("step", 72 * 6);
  if (control) ctx.report.control = `ease-pop: one display frame of the ease stepped ${POP_FRAMES} at once (the spike check must FAIL)`;
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
      const { change, median, max, spike } = changeSpike(easing.map((x) => x.thumb));
      const at = change.indexOf(max) + 1;
      ctx.check(
        `P6: no change spike (a frame over ${SPIKE} x the median and at least ${POP} grey level)`,
        median > 0 && !spike,
        `max ${max.toFixed(2)} at ease frame ${at} (show ${easing[at - 1]?.onScreen} -> ${easing[at]?.onScreen} on screen) / median ${median.toFixed(2)} grey levels per display frame`,
      );
    }
  } else ctx.report.picture = "waiting on video (stream D)";
  ctx.report.frames = path.map(({ thumb, view, ...x }) => x);
}
