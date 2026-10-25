// The demo in real time, as on the headset (?probe=realtime: the wall clock drives the show, no lockstep): after Enter
// the judge sees the real footage playing and moving, with no 3D anywhere (in the Screen view, no footage on the floor
// either); with ?solo the show steps into the court by itself in pass 2, eases to a stop at F and holds F's own
// pixels, and only then does the 3D take over; Back to my seat gives the picture back and the make plays as footage.
// The demo (court.ts demo.ts: every page unless ?demo=0): the watch is one clip looping (pass 2 up to the first ease's
// press window) with no step by itself; a press after it has looped replays it from its first frame into the ease, and
// the arena stays whole walking anywhere (far past the play area too). ?demo=0 is the full show's path above.
// A slow device (--throttle: CPU x4) must still show a moving picture, never a frozen one. Stills: rt-*.png.
// Run with --realtime --query solo (skipped otherwise; --query "solo&demo=0" for the full show).
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
  const demo = new URL(ctx.page.url()).searchParams.get("demo") !== "0";
  const { segments } = ctx.court.video;
  // every ease ends on F's source frame at its own show frame (a later press takes a later ease): any of them is F
  const ENDS = new Set(segments.eases.map((e) => e.frames[1]));
  const F = segments.eases[0].frames[1];
  const isF = (k) => ENDS.has(k);
  // one atomic read: the clock, the frame on screen and whether any 3D player is drawn
  const now = () => ctx.page.evaluate(() => {
    const s = window.__court.snapshot();
    const video = window.__courtLook?.proxies?.video?.opacity ?? 1;
    const floor = window.__courtLook?.world?.filmedLevel ?? -1;
    const arena = window.__courtLook?.world?.arena ?? { stands: -1, floor: -1, dome: -1 };
    return { phase: s.phase, frame: s.clock.frame, segment: s.clock.segment, pass: s.clock.pass, onScreen: s.onScreen, freeze: !!window.__courtLook?.freeze?.group?.visible, video, floor, arena: { ...arena }, t: performance.now() };
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
  const screenView = new URL(ctx.page.url()).searchParams.get("view") !== "courtside";

  // ---- the watch: the footage plays, moving, keeping up, and no 3D
  const start = await ctx.until("watching", 72 * 40);
  ctx.check("realtime: the watch starts after Enter and the arrival", start.at(-1)?.phase === "watching", `${start.at(-1)?.phase} after ${start.length} frames`);
  // the watch proper: pass 1 and pass 2, up to the ease ?solo's own step starts (it can fall inside 8 s of wall time)
  const easing = (x) => x.segment === "ease" || x.segment === "freeze";
  const w1 = await watchFor(3, easing);
  await ctx.save("rt-01-watch-3s");
  const w2 = easing(w1.at(-1)) ? [] : await watchFor(5, easing);
  await ctx.save("rt-02-watch-8s");
  for (const [name, all] of [["first 3 s", w1], ["3-8 s", w2]]) {
    const w = all.filter((x) => !easing(x));
    if (w.length < 2) continue;
    const p = playing(w);
    report[name] = p;
    ctx.check(`realtime: the watch (${name}) shows the footage moving`, p.perS >= MOVING_PER_S, `${p.shown} different show frames in ${p.seconds.toFixed(1)} s (${p.perS.toFixed(1)}/s)`);
    ctx.check(`realtime: the watch (${name}) keeps up with the clock`, p.lag <= LAG_MAX, `median lag ${p.lag} show frames`);
    ctx.check(`realtime: no 3D player during the watch (${name})`, !p.freeze, p.freeze ? "a 3D player was drawn" : "none drawn");
    if (screenView) {
      const lit = w.filter((x) => x.floor !== 0);
      ctx.check(`realtime: Screen view, no footage on the floor during the watch (${name})`, !lit.length, lit.length ? `${lit.length} of ${w.length} samples with the footage floor at ${lit[0].floor}` : `footage floor 0 in all ${w.length} samples`);
    }
  }

  let toEase;
  if (demo) {
    // ---- the demo's clip: it loops in its window, never steps in by itself; a press (after it has looped) replays it
    // from its first frame into the first ease
    const clip = [segments.pass2[0], segments.eases[0].start - 1];
    const watched = [...w1, ...w2];
    const wraps = watched.filter((x, i) => i > 0 && x.pass > watched[i - 1].pass).length;
    const outside = watched.filter((x) => x.segment !== "pass2" || x.frame < clip[0] || x.frame > clip[1]);
    report.loop = { clip, wraps, passes: [...new Set(watched.map((x) => x.pass))], outside: outside.length };
    ctx.check("realtime: demo, no step by itself (8 s of watch, no ease)", !watched.some(easing), `${watched.filter(easing).length} of ${watched.length} samples in an ease or the freeze`);
    ctx.check("realtime: demo, the clip loops (it repeats from its first frame)", wraps >= 1, `${wraps} repeats in ${((watched.at(-1).t - watched[0].t) / 1000).toFixed(1)} s (passes ${report.loop.passes.join(", ")})`);
    ctx.check("realtime: demo, the clip stays in its window (pass 2 up to the first ease's press window)", !outside.length, outside.length ? `${outside.length} samples outside [${clip}], first ${outside[0].segment} ${outside[0].frame}` : `all ${watched.length} samples in [${clip}]`);
    const pressedAt = watched.at(-1);
    await ctx.press("step");
    toEase = await watchFor(20, easing);
    const run = toEase.filter((x) => x.segment === "pass2");
    const lowest = Math.min(...run.map((x) => x.frame));
    const seconds = toEase.length > 1 ? (toEase.at(-1).t - toEase[0].t) / 1000 : 0;
    report.replay = { pressedAt: pressedAt.frame, lowest, lastBeforeEase: run.at(-1)?.frame, seconds };
    ctx.check("realtime: demo, Step into the court replays the clip from its first frame", lowest <= clip[0] + 24 && run.every((x, i) => i === 0 || x.frame >= run[i - 1].frame),
      `pressed at show frame ${pressedAt.frame}; the replay's lowest ${lowest} (clip starts ${clip[0]}), ${run.length} samples, then ${toEase.at(-1)?.segment}`);
    ctx.check("realtime: demo, the replay plays on into the ease (no repeat once pressed)", toEase.at(-1)?.segment === "ease" && (run.at(-1)?.frame ?? 0) >= clip[1] - 12,
      `segment ${toEase.at(-1)?.segment} at show frame ${toEase.at(-1)?.frame} after ${seconds.toFixed(1)} s; last clip sample ${run.at(-1)?.frame}`);
    await ctx.save("rt-02b-ease");
  } else {
    // ---- no press: ?solo steps into the court by itself in pass 2 (court.ts AUTO_STEP_FRAMES); the ease lands on F, F's
    // own pixels hold, then the 3D takes over
    const last = (w2.length ? w2 : w1).at(-1);
    toEase = easing(last) ? [last] : await watchFor(40, easing);
    ctx.check("realtime: ?solo steps into the court by itself (the ease starts with no press)", toEase.at(-1)?.segment === "ease", `segment ${toEase.at(-1)?.segment}, show frame ${toEase.at(-1)?.frame}`);
  }
  const ease = toEase.at(-1)?.segment === "ease" ? [toEase.at(-1)] : [];
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
  if (screenView) {
    ctx.check("realtime: Screen view, F's floor footage is all there on F (the hand-off's own floor)", !!heldF && heldF.floor === 1, `footage floor ${heldF?.floor} on F`);
    ctx.check("realtime: Screen view, clean wood under the 3D once it has the court", walk.floor === 0, `footage floor ${walk.floor} mid-walk`);
  }
  if (demo) {
    // ---- the demo: the arena whole wherever the head goes, far past the play area and turned round (no edge fade, no
    // room), and standing up never jumps the world
    const before = await r.seat();
    const walked = [walk];
    for (const [dx, dz, yaw] of [[3, 2, 1.6], [5.5, -1, 3.1], [-4, 4.5, -2]]) {
      await r.setHead([home[0] + dx, home[1] + 0.45, home[2] + dz], yaw);
      walked.push(...(await watchFor(0.6)));
    }
    await ctx.save("rt-06b-far-walk");
    const dim = walked.filter((x) => x.arena.stands < 1 || x.arena.floor < 1 || x.arena.dome < 1);
    const edges = await r.edge([home[0] + 5.5, 0, home[2] - 1]);
    report.walkArena = { samples: walked.length, dim: dim.length, edgeAtFarthest: edges };
    ctx.check("realtime: demo, the arena stays opaque walking anywhere (stands, floor, dome all 1)", !dim.length && walked.every((x) => x.arena.stands === 1),
      dim.length ? `${dim.length} of ${walked.length} samples dimmed, first ${JSON.stringify(dim[0].arena)} (phase ${dim[0].phase})` : `all ${walked.length} samples at 1, incl. ${edges?.toFixed?.(2)} m from the play area's edge`);
    const after = await r.seat();
    const moved = !before || !after || before.world.position.some((v, i) => Math.abs(v - after.world.position[i]) > 0.01) || Math.abs(before.world.yaw - after.world.yaw) > 0.01;
    ctx.check("realtime: demo, standing up and walking never jump the world", !moved, moved ? `world ${JSON.stringify(before?.world)} -> ${JSON.stringify(after?.world)}` : `world held at ${JSON.stringify(after?.world)}`);
  }

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
