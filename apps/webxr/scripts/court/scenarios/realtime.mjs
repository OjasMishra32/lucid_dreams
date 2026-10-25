// The demo in real time, as on the headset (?probe=realtime: the wall clock drives the show, no lockstep): after Enter
// the judge sees the real footage playing and moving, with no 3D anywhere; it eases to a stop at F and holds F's own
// pixels, and only then does the 3D take over; Back to my seat gives the picture back and the make plays as footage.
// A slow device (--throttle: CPU x4) must still show a moving picture, never a frozen one. Stills: rt-*.png.
// Run with --realtime --query solo (skipped otherwise).
// Owner: loop.
import { rig } from "../rig.mjs";

export const owner = "loop";
export const needs = ["clock", "video", "proxies", "handoff", "freeze", "seat", "seatmath"];

/** Show frames the picture may trail the clock by while it plays (median; ~0.1 s at the show's 72 Hz). */
const LAG_MAX = 8;
/** A playing picture shows at least this many different show frames per second of wall time. */
const MOVING_PER_S = 8;

export default async function realtime(ctx) {
  if (!ctx.realtime) ctx.skip("run with --realtime (the wall clock drives the show)");
  if (!new URL(ctx.page.url()).searchParams.has("solo")) ctx.skip("run with --query solo");
  const r = rig(ctx);
  const { segments } = ctx.court.video;
  // every ease ends on F's source frame at its own show frame (a later press takes a later ease): any of them is F
  const ENDS = new Set(segments.eases.map((e) => e.frames[1]));
  const F = segments.eases[0].frames[1];
  const isF = (k) => ENDS.has(k);
  // one atomic read: the clock, the frame on screen and whether any 3D player is drawn
  const now = () => ctx.page.evaluate(() => {
    const s = window.__court.snapshot();
    const video = window.__courtLook?.proxies?.video?.opacity ?? 1;
    return { phase: s.phase, frame: s.clock.frame, segment: s.clock.segment, onScreen: s.onScreen, freeze: !!window.__courtLook?.freeze?.group?.visible, video, t: performance.now() };
  });
  const playing = (samples) => {
    const shown = new Set(samples.map((x) => x.onScreen).filter((x) => x >= 0));
    const lags = samples.map((x) => x.frame - x.onScreen).sort((a, b) => a - b);
    const seconds = samples.length > 1 ? (samples.at(-1).t - samples[0].t) / 1000 : 0;
    // a 3D player counts as seen only when the picture over it is not fully opaque (handoff.ts draws them under it early)
    return { shown: shown.size, perS: seconds ? shown.size / seconds : 0, lag: lags[Math.floor(lags.length / 2)] ?? 99, freeze: samples.some((x) => x.freeze && x.video < 1), seconds };
  };
  const watchFor = async (seconds, stop = () => false) => {
    const out = [];
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      await ctx.nextFrame();
      const x = await now();
      out.push(x);
      if (stop(x)) break;
    }
    return out;
  };
  const report = (ctx.report.realtime = {});

  // ---- the watch: the footage plays, moving, keeping up, and no 3D
  const start = await ctx.until("watching", 72 * 40);
  ctx.check("realtime: the watch starts after Enter and the arrival", start.at(-1)?.phase === "watching", `${start.at(-1)?.phase} after ${start.length} frames`);
  const w1 = await watchFor(3);
  await ctx.save("rt-01-watch-3s");
  const w2 = await watchFor(5);
  await ctx.save("rt-02-watch-8s");
  for (const [name, w] of [["first 3 s", w1], ["3-8 s", w2]]) {
    const p = playing(w);
    report[name] = p;
    ctx.check(`realtime: the watch (${name}) shows the footage moving`, p.perS >= MOVING_PER_S, `${p.shown} different show frames in ${p.seconds.toFixed(1)} s (${p.perS.toFixed(1)}/s)`);
    ctx.check(`realtime: the watch (${name}) keeps up with the clock`, p.lag <= LAG_MAX, `median lag ${p.lag} show frames`);
    ctx.check(`realtime: no 3D player during the watch (${name})`, !p.freeze, p.freeze ? "a 3D player was drawn" : "none drawn");
  }

  // ---- Step into the court early in pass 2: the ease lands on F, F's own pixels hold, then the 3D takes over
  const toPass2 = await watchFor(20, (x) => x.segment === "pass2" && x.frame >= segments.pass2[0] + 24);
  ctx.check("realtime: pass 2 is reached", toPass2.at(-1)?.segment === "pass2", `segment ${toPass2.at(-1)?.segment}, show frame ${toPass2.at(-1)?.frame}`);
  await ctx.press("step");
  const ease = [];
  let savedBefore = false;
  let savedF = false;
  for (let i = 0; i < 72 * 20; i++) {
    await ctx.nextFrame();
    const x = await now();
    ease.push(x);
    if (!savedBefore && segments.eases.some((e) => x.frame >= e.frames[1] - 1 && x.frame <= e.frames[1])) {
      savedBefore = true;
      await ctx.save("rt-03-F-minus-1");
    }
    if (!savedF && isF(x.frame) && x.onScreen === x.frame) {
      savedF = true;
      await ctx.save("rt-04-F");
    }
    if (x.phase === "open" || x.phase === "walking") break;
  }
  const firstFreeze = ease.find((x) => x.freeze && x.video < 1);
  const beforeF = ease.filter((x) => !isF(x.frame) && x.segment !== "freeze");
  const heldF = ease.find((x) => isF(x.frame) && x.onScreen === x.frame);
  report.ease = { samples: ease.length, firstFreeze, heldF: !!heldF, last: ease.at(-1) };
  const seenBeforeF = beforeF.filter((x) => x.freeze && x.video < 1);
  ctx.check("realtime: the ease plays the footage into F (no 3D seen before F)", !seenBeforeF.length, `${beforeF.length} samples before F, ${beforeF.filter((x) => x.freeze).length} with the 3D drawn under the picture, ${seenBeforeF.length} with the picture below full opacity`);
  ctx.check("realtime: the picture lands on F and holds F's own pixels", !!heldF, heldF ? `on screen ${heldF.onScreen} = F at clock ${heldF.frame}` : `never (last: clock ${ease.at(-1)?.frame}, on screen ${ease.at(-1)?.onScreen})`);
  ctx.check("realtime: the 3D takes over only once F is on screen (the picture starts fading on F)", !!firstFreeze && isF(firstFreeze.frame) && firstFreeze.onScreen === firstFreeze.frame,
    firstFreeze ? `picture at ${firstFreeze.video.toFixed(3)} over the 3D first at clock ${firstFreeze.frame}, on screen ${firstFreeze.onScreen} (F's show frames ${[...ENDS].join("/")}), phase ${firstFreeze.phase}` : "the 3D never appeared");
  await watchFor(1);
  await ctx.save("rt-05-F-plus-1s");

  // ---- mid-walk: the 3D players stand there
  const home = await ctx.device((d) => [d.position.x, d.position.y, d.position.z]);
  await r.setHead([home[0] + 1.2, home[1], home[2] + 0.8], 0.6);
  await ctx.frames(10);
  await ctx.save("rt-06-mid-walk");
  const walk = await now();
  ctx.check("realtime: walking, the 3D players are drawn and the picture is gone", walk.freeze && walk.video === 0, `phase ${walk.phase}, 3D drawn ${walk.freeze}, picture ${walk.video}`);

  // ---- Back to my seat: the picture returns, and the make plays as real footage
  await ctx.press("back");
  await watchFor(3, (x) => x.phase === "returning");
  const chair = (await r.seat())?.chair?.position ?? [home[0], 0, home[2]];
  await r.setHead([chair[0], home[1], chair[2]], 0);
  const toResume = await watchFor(20, (x) => x.phase === "resume" && !x.freeze);
  ctx.check("realtime: Back to my seat gives the picture back", toResume.at(-1)?.phase === "resume", `phase ${toResume.at(-1)?.phase}`);
  const make = await watchFor(2.5, (x) => x.phase !== "resume");
  await ctx.save("rt-07-make");
  const pm = playing(make.filter((x) => x.phase === "resume"));
  report.make = pm;
  ctx.check("realtime: the make plays as footage, moving", pm.perS >= MOVING_PER_S, `${pm.shown} different show frames in ${pm.seconds.toFixed(1)} s (${pm.perS.toFixed(1)}/s)`);
  ctx.check("realtime: the make keeps up with the clock", pm.lag <= LAG_MAX, `median lag ${pm.lag} show frames`);
  ctx.check("realtime: no 3D player during the make", !pm.freeze, pm.freeze ? "a 3D player was drawn" : "none drawn");
}
