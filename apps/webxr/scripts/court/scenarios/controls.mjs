// P21 and P32 through IWER's hands (ui is tested here, not in node): the palm menu opens only palm-up (left palm,
// right index presses); every button works (Step into the court / Back to my seat, Reality check, Replay, See my room,
// Walk closer, and Next view where it applies: hidden at 3.5 x 3.5 m, unit-tested on a bigger floor in seat.test.ts);
// Seat here acts only after a 2.0 s hold (a 1 s press changes nothing); pinches, held pinches and swipes change
// nothing; P22 caption, label and credit; P23/P7 the Reality panel. Owner: stream C.
import { rig } from "../rig.mjs";

export const owner = "C (core)";
export const needs = ["ui", "vrhands", "seat", "clock"];

const LABEL = "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players.";
/** What a gesture could change (the phase and the clock move on by themselves). */
const state = (s) => JSON.stringify({ setup: s.setup, inRoom: s.inRoom, reality: s.reality, armed: s.clock.armed, world: s.world });

export default async function controls(ctx) {
  const r = rig(ctx);
  await ctx.frames(2);
  await r.setHead([0, 1.15, 0], 0);
  await r.handsAway();
  ctx.check("P21: the menu stays shut palm-down", !(await r.menuOpen()), "palm down: closed");
  await r.palm(true);
  const opened = await r.menuOpen();
  const setupIds = (await r.buttons()).map((b) => b.id);
  ctx.check("P21: the menu opens palm-up", opened && setupIds.join() === "seatHere,room", `palm up: ${opened ? "open" : "closed"}, setup page ${setupIds.join(", ")}`);

  // P32: a 1 s press changes nothing; a 2 s hold seats
  await r.hold("seatHere", 1000);
  const short = await ctx.snapshot();
  const h1 = (await r.ui((u) => u.holds()))[0];
  ctx.check("P32: a 1 s press on Seat here changes nothing", short.setup && h1 && h1.fired === null, `setup ${short.setup}, ${h1 ? "the hold let go before 2 s" : "no hold seen"}`);
  await r.hold("seatHere", 2300);
  const seated = await ctx.snapshot();
  const h2 = (await r.ui((u) => u.holds())).at(-1);
  const held = h2?.fired != null ? h2.fired - h2.start : null;
  ctx.check("P32: Seat here acts only after a 2.0 s hold", !seated.setup && held !== null && held >= 2000 && held < 2100, `setup ${seated.setup}, fired after ${held?.toFixed(0)} ms of holding`);

  // P21: pinches, held pinches and swipes change nothing
  await r.handsAway();
  const before = state(await ctx.snapshot());
  for (const side of ["left", "right"]) {
    await ctx.device((d, s) => (d.hands[s].poseId = "pinch"), side);
    for (const v of [1, 0, 1, 1, 0]) {
      await ctx.device((d, a) => d.hands[a.s].updatePinchValue(a.v), { s: side, v });
      await ctx.frames(8);
    }
    for (let k = 0; k < 6; k++) {
      await ctx.device((d, a) => d.hands[a.s].position.set(a.x, 1.1, -0.45), { s: side, x: (side === "left" ? -1 : 1) * (0.2 + 0.1 * k) });
      await ctx.frames(2);
    }
    await ctx.device((d, s) => {
      d.hands[s].updatePinchValue(0);
      d.hands[s].poseId = "default";
    }, side);
  }
  await ctx.frames(10);
  const after = state(await ctx.snapshot());
  ctx.check("P21: pinches, held pinches and swipes change nothing", before === after, before === after ? "setup, room, Reality, the stop and the world unchanged" : `${before} -> ${after}`);

  // the hand-over, a seated, still head: the watch
  await r.handOver();
  await r.setHead([0.02, 1.13, 0.03], 0);
  const toWatch = await ctx.until("watching", 72 * 8);
  ctx.check("reaches the watch after the hand-over", toWatch.at(-1)?.phase === "watching", `${toWatch.at(-1)?.phase} after ${toWatch.length} frames`);
  const text = await r.ui((u) => u.text());
  ctx.check("P22: caption, label and credit in the watch", text.visible && text.lines.includes(LABEL) && text.lines.includes(ctx.court.caption) && text.lines.includes(ctx.court.credit), `${text.visible ? "shown" : "hidden"}: ${text.lines.join(" | ")}`);

  // See my room and Reality check, both ways
  await r.palm(true);
  await r.point();
  await r.moveJointTo("right", "index-finger-tip", (await r.button("reality")).front);
  await ctx.save("controls-menu");
  const watchIds = (await r.buttons()).map((b) => b.id);
  await r.press("room");
  await ctx.frames(4);
  const inRoom = (await ctx.snapshot()).inRoom;
  const roomButton = (await r.buttons()).find((b) => b.id === "room");
  await r.press("room");
  await ctx.frames(4);
  const outRoom = (await ctx.snapshot()).inRoom;
  ctx.check("P21: See my room toggles, reads Back to the arena and stays lit", inRoom && !outRoom && roomButton?.label === "Back to the arena" && roomButton.on, `in ${inRoom} (${roomButton?.label}, lit ${roomButton?.on}), back ${!outRoom}`);
  await r.press("reality");
  await ctx.frames(4);
  const realOn = (await ctx.snapshot()).reality;
  const realText = await r.ui((u) => u.text());
  await r.press("reality");
  await ctx.frames(4);
  const realOff = (await ctx.snapshot()).reality;
  ctx.check("P21, P23, P7: Reality check toggles; its panel names the seen % and the interpolated share", realOn && !realOff && realText.lines.some((l) => /% seen/.test(l)) && realText.lines.some((l) => /In-between frames interpolated/.test(l)), realText.lines.slice(0, 3).join(" | "));

  // Step into the court (See my room restarted the watch: pass 1 again, so the press arms the stop)
  await ctx.until("watching", 10);
  await r.press("step");
  await ctx.frames(2);
  const clock = (await ctx.snapshot()).clock;
  ctx.check("P21: Step into the court takes or arms the stop", watchIds.join() === "changeSeat,step,reality,replay,room" && (clock.armed || clock.segment === "ease" || clock.segment === "freeze"), `menu ${watchIds.join(", ")}; armed ${clock.armed} in ${clock.segment}`);
  await r.handsAway();
  const toOpen = await ctx.until("open", 72 * 40);
  ctx.check("the stop lands and the world opens", toOpen.at(-1)?.phase === "open", `${toOpen.at(-1)?.phase} after ${toOpen.length} frames`);

  // Walk closer (seated), then the walking menu: Next view only where a second placement fits
  await r.palm(true);
  const openIds = (await r.buttons()).map((b) => b.id);
  await r.press("closer");
  await ctx.frames(40);
  const walking = await ctx.snapshot();
  const seatAt = await r.seat();
  await r.palm(true);
  const walkIds = (await r.buttons()).map((b) => b.id);
  const wantWalk = seatAt.nextView ? "changeSeat,nextView,back,reality,replay,room" : "changeSeat,back,reality,replay,room";
  ctx.check("P21: Walk closer jumps to the walking anchoring; Next view shows only where it applies", openIds.join() === "changeSeat,closer,back,reality,replay,room" && walking.phase === "walking" && seatAt.walking && walkIds.join() === wantWalk,
    `menus ${openIds.join(",")} / ${walkIds.join(",")}; Next view ${seatAt.nextView ? "applies" : "hidden (3.5 x 3.5 m)"}`);

  // stand up by the pair, then Back to my seat: through the room
  await r.handsAway();
  await r.setHead([0.4, 1.72, -0.6], 0);
  await ctx.frames(20);
  await r.palm(true);
  await r.press("back");
  await ctx.frames(4);
  const back = await ctx.snapshot();
  ctx.check("P21: Back to my seat goes through the room", back.phase === "returning" && back.inRoom, `${back.phase}, room ${back.inRoom}`);
  await r.handsAway();
  await r.setHead([0.03, 1.14, 0.02], 0);
  const toEnd = await ctx.until("ended", 72 * 40);
  const home = await r.seat();
  ctx.check("seated again: the watch anchoring returns and the play runs on to the end", toEnd.some((f) => f.phase === "resume") && toEnd.at(-1)?.phase === "ended" && !home.walking, `${[...new Set(toEnd.map((f) => f.phase))].join(" -> ")}; walking ${home.walking}`);
  await r.palm(true);
  await r.press("replay");
  await ctx.frames(4);
  const replay = await ctx.snapshot();
  ctx.check("P21: Replay starts the watch again", replay.phase === "watching" && replay.clock.segment === "pass1", `${replay.phase} ${replay.clock.segment}`);
}
