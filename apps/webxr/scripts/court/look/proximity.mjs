// P17 (stream E's part of scenarios/walk.mjs, and look.mjs): an eye 0.2 m from a torso or head capsule fades that
// player to 30% within 300 ms (+1 frame); an eye 0.3 m from the ball fades nothing. Freeze.update runs once a display
// frame with the eye in court space: court.ts's own call in the open world, else this drives it (the phases that
// reach the freeze wait on the clock and the hand-off).
import { HZ, headAt } from "./view.mjs";

const FADE_TO = 0.3;

/** Step n display frames with the eye at `eye` (court space); the players' fade after each. */
async function stepAt(ctx, eye, n, ids) {
  await headAt(ctx, eye);
  return ctx.page.evaluate(async ([e, frames, names, hz]) => {
    const L = window.__courtLook;
    const out = [];
    for (let i = 0; i < frames; i++) {
      const s = window.__court.snapshot();
      // court.ts drives the fade in the open world; anywhere else, drive it here, once a display frame
      if (!["open", "walking", "returning"].includes(s.phase)) L.freeze.update({ court: e, room: e, yaw: 0, quaternion: [0, 0, 0, 1] }, 1 / hz);
      await window.__court.nextFrame();
      out.push(Object.fromEntries(names.map((id) => [id, L.freeze.opacityOf(id)])));
    }
    return out;
  }, [eye, n, ids, HZ]);
}

export async function checkProximity(ctx) {
  const players = ctx.court.freeze.players;
  const ids = players.map((p) => p.id);
  await ctx.page.evaluate(() => window.__courtLook.freeze.reveal(1));
  const far = [ctx.court.seat.pairCentre[0] - 4, 1.6, ctx.court.seat.pairCentre[2]];
  await stepAt(ctx, far, Math.round(0.4 * HZ), ids);
  const report = {};
  for (const p of players) {
    // 0.2 m from the torso capsule, straight out from its middle on the side away from the other player
    const t = p.capsules[0];
    const mid = t.a.map((v, i) => (v + t.b[i]) / 2);
    const other = players.find((o) => o.id !== p.id);
    const oc = other ? other.capsules[0].a : [mid[0] + 1, mid[1], mid[2]];
    let dir = [mid[0] - oc[0], 0, mid[2] - oc[2]];
    const l = Math.hypot(...dir) || 1;
    dir = dir.map((v) => v / l);
    const eye = mid.map((v, i) => v + dir[i] * (t.r + 0.2 - 1e-3));
    const fade = await stepAt(ctx, eye, Math.round(0.3 * HZ) + 2, ids);
    const at = fade.findIndex((o) => o[p.id] <= FADE_TO + 1e-9);
    ctx.check(`P17: 0.2 m from ${p.id}'s torso fades them to 30% in 300 ms`, at >= 0 && at + 1 <= Math.round(0.3 * HZ) + 1, `30% after ${at + 1} frames (${(((at + 1) / HZ) * 1000).toFixed(0)} ms)`);
    report[p.id] = at + 1;
    await stepAt(ctx, far, Math.round(0.4 * HZ), ids);
  }
  // 0.3 m from the ball, on the side away from both bodies: nobody fades
  const b = ctx.court.freeze.ball;
  const pc = ctx.court.seat.pairCentre;
  let dir = [b.centre[0] - pc[0], 0, b.centre[2] - pc[2]];
  const l = Math.hypot(...dir) || 1;
  dir = dir.map((v) => v / l);
  const eye = b.centre.map((v, i) => v + dir[i] * (b.radius + 0.3));
  const near = await stepAt(ctx, eye, Math.round(0.4 * HZ), ids);
  const min = Math.min(...near.flatMap((o) => Object.values(o)));
  ctx.check("P17: 0.3 m from the ball fades nobody", min === 1, `lowest opacity ${min}`);
  ctx.report.proximity = { framesTo30: report, ballMin: min };
}
