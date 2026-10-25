// The whole judge experience, end to end, in IWER, with a still at every step (fullpath-NN-<step>.png in the out
// folder; --video records the run, --throttle runs it on a Quest-like link and CPU): solo seat, the arrival, the
// lights-up, the watch (pass 1), Step into the court, the ease to F, the hand-off, Walk closer, all the way round the
// pair and through it, Reality check, See my room and back, Back to my seat, the make, Replay, Change seat and Seat
// here again, the hand-over after the Meta button, and a judge who walks away. Every step has a check (the phase it
// should reach inside a bound, the picture opaque where it must be, nothing NaN); nothing here waits on wall-clock
// time except the palm menu's 2 s holds, which are real time by design. Everything comes from ctx.court: no numbers of
// the bundle live in this file. Run with --query solo (the first Seat here is taken by itself).
// Owner: the loop.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readPng } from "../png.mjs";
import { rig } from "../rig.mjs";
import { BEATS } from "../../../src/court/handoff.ts";
import { HZ, lookFrom, walkStops } from "../look/view.mjs";

export const owner = "loop";
export const needs = ["clock", "video", "proxies", "handoff", "freeze", "world", "light", "seat", "seatmath", "ui", "vrhands"];

/** The arrival is black (mean luma, 0-255) until the lights-up (arrival.mjs). */
const BLACK = 2;
/** P35: the arena is whole until this far (m) from the bounds. */
const EDGE_WHOLE = 0.6;
/** The judge walks this far (m) from the seat, in the room, and back. */
const AWAY_M = 6;
/** The chair sits at the fade's onset by design (0.6 m from the bounds): there the arena may have opened this much already. */
const ONSET_SLACK = 0.05;
/** A pixel this dark (0-255 luma) counts as black in the survey. */
const DARK = 8;

/** The first non-finite number in a JSON-like value, as a path ("world.position.1"), or null. */
const nonFinite = (v, path = "") => {
  if (typeof v === "number") return Number.isFinite(v) ? null : `${path} = ${v}`;
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      const bad = nonFinite(x, path ? `${path}.${k}` : k);
      if (bad) return bad;
    }
  return null;
};

export default async function fullpath(ctx) {
  if (ctx.timing) ctx.skip("capture only");
  if (!new URL(ctx.page.url()).searchParams.has("solo")) ctx.skip("run with --query solo");
  const r = rig(ctx);
  const { segments, pass2Speed, freezeSource } = ctx.court.video;
  const survey = {};
  const trail = [];
  let n = 0;
  for (const f of readdirSync(ctx.out)) if (/^fullpath-\d+-.*\.png$/.test(f)) rmSync(join(ctx.out, f)); // this run's stills only

  /** Step the frames in the page until `pred(frame, arg)`; the frame that did, or null after `max`. */
  const upto = (pred, max, arg) =>
    ctx.page.evaluate(
      async ([src, m, a]) => {
        const p = new Function("f", "arg", `return (${src})(f, arg)`);
        for (let i = 0; i < m; i++) {
          const f = await window.__court.nextFrame();
          if (p(f, a)) return f;
        }
        return null;
      },
      [pred.toString(), max, arg],
    );

  /** A still (the next frame as fullpath-NN-<step>.png), its dark share, and the frame's log. */
  const still = async (step) => {
    const name = `fullpath-${String(++n).padStart(2, "0")}-${step}`;
    const log = await ctx.save(name);
    const img = readPng(join(ctx.out, `${name}.png`));
    // black = drawn and dark; a pixel the room shows through (alpha < 128: the headset's passthrough, which a PNG shows
    // as whatever is behind it) is counted apart, so the edge fade's opening never reads as black
    let dark = 0;
    let room = 0;
    const thirds = [0, 0, 0];
    const cols = [0, 0, 0];
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * img.channels;
        if (img.channels === 4 && img.data[o + 3] < 128) room++;
        else if (0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2] < DARK) {
          dark++;
          thirds[Math.min(2, Math.floor((3 * y) / img.height))]++;
          cols[Math.min(2, Math.floor((3 * x) / img.width))]++;
        }
      }
    const px = img.width * img.height;
    const share = (k) => Number((k / (px / 3)).toFixed(3));
    survey[name] = { width: img.width, height: img.height, black: Number((dark / px).toFixed(3)), room: Number((room / px).toFixed(3)), rows: thirds.map(share), cols: cols.map(share) };
    // metres from the head to the bounds (the edge fade's input, P35)
    const edge = await ctx.page.evaluate(() => window.__courtSeat?.boundsDistance([window.__xrDevice.position.x, window.__xrDevice.position.y, window.__xrDevice.position.z]) ?? null);
    return { name, log, edge };
  };

  /** One check per step: the phase reached, the picture opaque (unless the room is meant to show), nothing NaN. */
  const verify = async (what, got, { phase, opaque = true, also = [] } = {}) => {
    const { log, name } = got;
    const snap = await ctx.snapshot();
    const bad = nonFinite({ world: snap.world, head: snap.head, clock: snap.clock, view: log.view, luma: log.luma, alphaMin: log.alphaMin });
    const phases = [].concat(phase ?? log.phase);
    // opaque means whole, P35: 255 clear of the bounds; within the onset's slack of 0.6 m, at least 245 (a sliver opening)
    const clear = got.edge == null || got.edge >= EDGE_WHOLE + ONSET_SLACK;
    const whole = clear ? log.alphaMin === 255 : got.edge >= EDGE_WHOLE - ONSET_SLACK && log.alphaMin >= 245;
    const where = got.edge == null ? "" : `, ${got.edge.toFixed(2)} m from the bounds`;
    const parts = [
      [phases.includes(log.phase), `phase ${log.phase}${phase ? ` (want ${phases.join(" or ")})` : ""}`],
      [!opaque || whole, `alpha min ${log.alphaMin}${where}`],
      [!bad, bad ? `NaN: ${bad}` : "no NaN"],
      ...also,
    ];
    ctx.check(what, parts.every(([ok]) => ok), `${parts.map(([ok, t]) => (ok ? t : `${t} FAILED`)).join("; ")} [${name}]`);
    const { thumb, view, ...flat } = log;
    trail.push({ step: what, still: name, ...flat });
  };

  // ---- 1-4: solo seat, arrival, lights-up, the watch (pass 1)
  await r.setHead([0, 1.15, 0], 0);
  const sat = await upto((f) => !f.setup, HZ * 15);
  const home = await ctx.device((d) => [d.position.x, d.position.y, d.position.z]);
  await verify("1 solo seat: Seat here is taken by itself", await still("solo-seat"), { phase: "arrival", also: [[!!sat, sat ? `seated at frame ${sat.n}` : "never seated"]] });
  const dark = await still("arrival");
  await verify("2 arrival: black until the lights-up", dark, { phase: "arrival", also: [[dark.log.luma <= BLACK && dark.log.lightsUp < 0, `mean luma ${dark.log.luma}, lights-up ${dark.log.lightsUp}`]] });
  const rising = await upto((f) => f.lightsUp >= 0.4, HZ * 8);
  const up = await still("lights-up");
  await verify("3 lights-up: the picture rises out of black", up, {
    phase: ["arrival", "watching"],
    also: [[!!rising && up.log.luma > dark.log.luma, `mean luma ${dark.log.luma} -> ${up.log.luma} (lights-up ${rising?.lightsUp ?? "never"} s)`]],
  });
  await upto((f, p1) => f.phase === "watching" && f.segment === "pass1" && f.frame >= (p1[0] + p1[1]) / 2, HZ * 10, segments.pass1);
  const watch = await still("watch-pass1");
  await verify("4 the watch (pass 1)", watch, {
    phase: "watching",
    also: [
      [watch.log.segment === "pass1", `segment ${watch.log.segment}, show frame ${watch.log.frame}`],
      [ctx.showFrames[watch.log.onScreen] !== undefined && watch.log.onScreen >= segments.pass1[0] && watch.log.onScreen <= segments.pass1[1], `on screen ${watch.log.onScreen}`],
    ],
  });

  // ---- 5-6: Step into the court in pass 2, the ease, F
  await upto((f) => f.segment === "pass2" && f.frame >= arg[0] + 24, HZ * 30, segments.pass2);
  await ctx.press("step");
  const easeStart = await upto((f) => f.segment === "ease", HZ * 5);
  const midEase = await upto((f, k) => f.segment === "ease" && f.speed <= k * 0.5, HZ * 10, pass2Speed);
  const ease = await still("ease");
  const which = segments.eases.findIndex((e) => easeStart && easeStart.frame >= e.frames[0] && easeStart.frame <= e.frames[1]);
  await verify("5 Step into the court: the ease starts", ease, {
    phase: ["easing", "handoff"],
    also: [[!!easeStart && which >= 0, `the press took ease ${which}; the ease starts at show frame ${easeStart?.frame ?? "never"}, speed ${midEase?.speed?.toFixed(2) ?? "-"} at the still`]],
  });
  const landed = await upto((f) => f.phase === "handoff", HZ * 30);
  const F = which >= 0 ? segments.eases[which].frames[1] : segments.eases[0].frames[1];
  const atF = await still("F");
  const shown = ctx.showFrames[atF.log.onScreen]?.src;
  await verify("6 ease to F: the clock lands on the ease's F frame, the picture on F", atF, {
    phase: "handoff",
    also: [
      [!!landed && atF.log.frame === F && ctx.showFrames[F]?.src === freezeSource, `clock on show frame ${atF.log.frame} (the ease's F ${F}, source ${ctx.showFrames[atF.log.frame]?.src}, F is source ${freezeSource})`],
      [shown === freezeSource, `on screen show frame ${atF.log.onScreen} (source ${shown})`],
    ],
  });

  // ---- 7-8: the hand-off (the picture fades, the 3D shows), the open world
  const [fadeFrom, fadeTo] = BEATS.videoFades;
  await upto((f, k) => f.phase !== "handoff" || f.tF >= k, HZ * 10, (fadeFrom + fadeTo) / 2);
  const fade = await still("handoff-fade");
  await verify("7 hand-off: the picture fades over the 3D", fade, { phase: ["handoff", "open"] });
  const opened = await upto((f) => f.phase === "open", HZ * 15);
  await ctx.frames(HZ);
  const open = await still("open");
  const look = await ctx.page.evaluate(() => ({ video: window.__courtLook?.video?.opacity ?? null, reveal: window.__courtLook?.freeze?.revealP ?? null }));
  await verify("8 the open world: the picture gone, the 3D freeze there, F still the frame", open, {
    phase: "open",
    also: [
      [!!opened, opened ? `open after the hand-off` : "never opened"],
      [look.video === 0 && look.reveal === 1, `video opacity ${look.video}, freeze reveal ${look.reveal}`],
      [ctx.showFrames[open.log.onScreen]?.src === freezeSource, `on screen source ${ctx.showFrames[open.log.onScreen]?.src}`],
    ],
  });

  // ---- 9: Walk closer
  await ctx.press("closer");
  await upto((f) => f.phase === "walking", HZ * 3);
  for (let i = 0; i < 40; i++) {
    const rep = await r.seat();
    if (rep && rep.veil === 0 && rep.walking) break;
    await ctx.frames(4);
  }
  await ctx.frames(HZ / 2);
  const closer = await still("walk-closer");
  const rep0 = await r.seat();
  await verify("9 Walk closer: the walking anchoring, the veil gone", closer, { phase: "walking", also: [[rep0?.walking === true && rep0.veil === 0, `walking ${rep0?.walking}, veil ${rep0?.veil}, layout ${rep0?.layout} (${rep0?.layoutCase})`]] });

  /** A head pose in court space, a still, and its distance to the bounds (the edge fade, P35). */
  const stopAt = async (step, eye, target) => {
    await lookFrom(ctx, eye, target);
    await ctx.frames(Math.round(0.4 * HZ));
    return still(step);
  };
  const wholeOrEdge = (got) => [[got.edge == null || got.edge < EDGE_WHOLE || got.log.alphaMin === 255, `${got.edge == null ? "no bounds" : `${got.edge.toFixed(2)} m from the bounds`}, alpha min ${got.log.alphaMin}`]];

  // ---- 10: all the way round the pair
  const stops = walkStops(ctx.court);
  for (const s of stops) {
    const got = await stopAt(`round-${s.stop}`, s.eye, s.target);
    await verify(`10.${s.stop} walk round the pair: stop ${s.stop} (${s.deg} deg, eye 1.6 m)`, got, { phase: "walking", opaque: false, also: wholeOrEdge(got) });
  }

  // ---- 11: through the pair, on a straight line through the midpoint of the two players
  const [a, b] = ctx.court.freeze.players;
  const mid = [(a.bounds.min[0] + a.bounds.max[0] + b.bounds.min[0] + b.bounds.max[0]) / 4, (a.bounds.min[2] + a.bounds.max[2] + b.bounds.min[2] + b.bounds.max[2]) / 4];
  const dx = mid[0] - stops[0].eye[0];
  const dz = mid[1] - stops[0].eye[2];
  const len = Math.hypot(dx, dz);
  const dir = [dx / len, dz / len];
  const capsuleGap = (p) => {
    let best = Infinity;
    for (const pl of [a, b])
      for (const c of pl.capsules ?? []) {
        const ab = c.b.map((v, i) => v - c.a[i]);
        const t = Math.max(0, Math.min(1, ab.reduce((s, v, i) => s + v * (p[i] - c.a[i]), 0) / Math.max(1e-9, ab.reduce((s, v) => s + v * v, 0))));
        best = Math.min(best, Math.hypot(...c.a.map((v, i) => v + ab[i] * t - p[i])) - c.r);
      }
    return best;
  };
  const through = [];
  for (const t of [-1.5, -0.75, -0.3, 0, 0.3, 0.75, 1.5]) {
    const eye = [mid[0] + dir[0] * t, 1.6, mid[1] + dir[1] * t];
    const got = await stopAt(`through-${t < 0 ? "m" : t > 0 ? "p" : ""}${Math.abs(t).toFixed(2).replace(".", "")}`, eye, [eye[0] + dir[0] * 2, 1.3, eye[2] + dir[1] * 2]);
    const gap = capsuleGap(eye);
    through.push({ t, gap: Number(gap.toFixed(3)), edge: got.edge, alphaMin: got.log.alphaMin });
    await verify(`11 through the pair at ${t >= 0 ? "+" : ""}${t.toFixed(2)} m from the midpoint (${gap.toFixed(2)} m from the nearest body)`, got, { phase: "walking", opaque: false, also: wholeOrEdge(got) });
  }
  ctx.report.through = through;

  // ---- 12: Reality check on, a still, off
  // from inside the play area (the stops round the pair sit on its edge, where the room already shows through)
  await stopAt("reality-pose", [mid[0] - dir[0] * 1.0, 1.6, mid[1] - dir[1] * 1.0], [mid[0], 1.0, mid[1]]);
  await ctx.press("reality");
  await ctx.frames(HZ / 2);
  const real = await still("reality-on");
  await verify("12 Reality check on", real, { phase: "walking", also: [[(await ctx.snapshot()).reality === true, "reality on"]] });
  await ctx.press("reality");
  await ctx.frames(HZ / 2);
  const realOff = await still("reality-off");
  await verify("12 Reality check off", realOff, { phase: "walking", also: [[(await ctx.snapshot()).reality === false, "reality off"]] });

  // ---- 13: See my room and back
  const out = await ctx.pressFrames("room", Math.round(0.6 * HZ) + 4);
  await ctx.frames(Math.round(1.6 * HZ));
  const inRoom = await still("room");
  await verify("13 See my room: the room shows", inRoom, { phase: "walking", opaque: false, also: [[inRoom.log.alphaMin === 0 && out.some((f) => f.roomP >= 1), `alpha min ${inRoom.log.alphaMin}, room in after ${out.findIndex((f) => f.roomP >= 1) + 1} frames`]] });
  await ctx.pressFrames("room", Math.round(0.8 * HZ) + 4);
  const backIn = await still("room-back");
  await verify("13 back to the arena: opaque again", backIn, { phase: "walking", opaque: false, also: wholeOrEdge(backIn) });

  // ---- 14: Back to my seat (the head walks back to the chair; the picture returns, then the make)
  await ctx.press("back");
  const returning = await upto((f) => f.phase === "returning", HZ * 3);
  await ctx.frames(Math.round(0.8 * HZ));
  const walkBack = await still("back-returning");
  await verify("14 Back to my seat: through the room", walkBack, { phase: "returning", opaque: false, also: [[!!returning, returning ? "returning" : "never returned"]] });
  const chair = (await r.seat())?.chair?.position ?? [home[0], 0, home[2]];
  await r.setHead([chair[0], home[1], chair[2]], 0);
  const resumed = await upto((f) => f.phase === "resume", HZ * 15);
  const midMake = segments.resume[0] + Math.round((segments.resume[1] - segments.resume[0]) / 2);
  await upto((f, k) => f.phase !== "resume" || f.frame >= k, HZ * 30, midMake);
  const make = await still("make");
  await verify("14 the make plays after the sit", make, { phase: ["resume", "ended"], also: [[!!resumed, resumed ? `resume reached; make still at show frame ${make.log.frame}` : "never resumed"]] });
  const ended = await upto((f) => f.phase === "ended", HZ * 30);
  const end = await still("make-ended");
  await verify("14 the make runs on to the end of the show's last pass", end, { phase: "ended", also: [[!!ended && end.log.segment === "ended", `segment ${end.log.segment}, show frame ${end.log.frame} (the make ends at ${segments.resume[1]})`]] });

  // ---- 15: Replay
  await ctx.press("replay");
  await upto((f) => f.phase === "watching", HZ * 4);
  await ctx.frames(HZ / 2);
  const replay = await still("replay");
  const snapR = await ctx.snapshot();
  await verify("15 Replay: the watch from the top", replay, { phase: "watching", also: [[replay.log.segment === "pass1" && snapR.mask === 0, `segment ${replay.log.segment}, show frame ${replay.log.frame}, cinema mask ${snapR.mask}`]] });

  // ---- 16: Change seat (2 s hold) and Seat here again (2 s hold), the hand-over, a new watch
  await r.setHead(home, 0);
  await r.palm(true);
  await r.hold("changeSeat", 2300);
  const setupPage = await ctx.snapshot();
  await r.handsAway();
  const changed = await still("change-seat");
  await verify("16 Change seat: back to the setup page, the show stopped", changed, { phase: "arrival", also: [[setupPage.setup, `setup ${setupPage.setup}`]] });
  await r.setHead([home[0] + 0.6, home[1], home[2] + 0.4], 0.5);
  await ctx.frames(3);
  await r.palm(true);
  await r.hold("seatHere", 2300);
  const seatedAgain = await ctx.snapshot();
  await r.handsAway();
  const again = await still("seat-here-again");
  await verify("16 Seat here again: a new seat under the head", again, { phase: "arrival", also: [[!seatedAgain.setup, `setup ${seatedAgain.setup}`]] });
  await upto((f) => f.phase === "watching", HZ * 15);
  await ctx.frames(HZ / 2);
  const watchAgain = await still("watch-again");
  await verify("16 the watch from the top again", watchAgain, { phase: "watching", also: [[watchAgain.log.segment === "pass1" || watchAgain.log.segment === "pass2", `segment ${watchAgain.log.segment}, show frame ${watchAgain.log.frame}`]] });

  // ---- 17: re-entering after the Meta button (visible-blurred, then visible)
  const before = (await ctx.snapshot()).clock;
  await ctx.handOver();
  await ctx.frames(HZ / 2);
  const reentered = await still("meta-button");
  const after = (await ctx.snapshot()).clock;
  await verify("17 re-entering after the Meta button: the session carries on", reentered, {
    phase: ["watching", "easing"],
    also: [[after.frame !== before.frame || after.segment !== before.segment, `show frame ${before.segment} ${before.frame} -> ${after.segment} ${after.frame}`]],
  });

  // ---- 18: a judge who walks away (AWAY_M from the seat, in the room) and back
  const sitAt = (await r.seat())?.chair?.position ?? [home[0], 0, home[2]];
  const worldBefore = (await ctx.snapshot()).world;
  await r.setHead([sitAt[0] + AWAY_M, home[1], sitAt[2]], 0.5);
  await ctx.frames(2 * HZ);
  const away = await still("walked-away");
  const awaySnap = await ctx.snapshot();
  const awayEdge = away.edge;
  ctx.report.walkedAway = { phase: awaySnap.phase, clock: awaySnap.clock, roomP: awaySnap.roomP, alphaMin: away.log.alphaMin, alphaMean: away.log.alphaMean, luma: away.log.luma, edge: awayEdge, world: awaySnap.world };
  await verify("18 a judge walks away: nothing breaks or goes NaN", away, {
    phase: ["watching", "easing"],
    opaque: false,
    also: [[JSON.stringify(awaySnap.world) === JSON.stringify(worldBefore), `world ${JSON.stringify(worldBefore.position.map((v) => +v.toFixed(3)))} -> ${JSON.stringify(awaySnap.world.position.map((v) => +v.toFixed(3)))}; ${awayEdge == null ? "no bounds" : `${awayEdge.toFixed(2)} m from the bounds`}, alpha min ${away.log.alphaMin} mean ${away.log.alphaMean}, room ${awaySnap.roomP}`]],
  });
  await r.setHead(sitAt.length === 3 ? [sitAt[0], home[1], sitAt[2]] : home, 0.5);
  await ctx.frames(2 * HZ);
  const back = await still("walked-back");
  await verify("18 and back at the seat: opaque again, the show where it was going", back, { phase: ["watching", "easing", "handoff"] });
  ctx.report.trail = trail;
  ctx.report.survey = survey;
}
