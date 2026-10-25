// P17 (scenarios/proximity.mjs): you never enter a body, and leaning in never fades one. An eye 0.2 m from a torso or
// head capsule fades that
// player to 30% within 300 ms (+1 frame); an eye 0.3 m from the ball fades nothing. Freeze.update runs once a display
// frame with the eye in court space: court.ts's own call in the open world, else this drives it (the phases that
// reach the freeze wait on the clock and the hand-off).
import { HZ, headAt } from "./view.mjs";

const FADE_TO = 0.3;
const FADE_NEAR = 0.2; // freeze.ts
const SEGMENT = (p, a, b) => {
  const ab = b.map((v, i) => v - a[i]);
  const l2 = ab.reduce((s, v) => s + v * v, 0);
  const t = l2 > 0 ? Math.min(1, Math.max(0, ab.reduce((s, v, i) => s + v * (p[i] - a[i]), 0) / l2)) : 0;
  return a.map((v, i) => v + ab[i] * t);
};
/** Distance from p to a capsule's surface (freeze.ts capsuleDistance). */
const capsuleDistance = (p, c) => Math.hypot(...SEGMENT(p, c.a, c.b).map((v, i) => p[i] - v)) - c.r;

/**
 * The eye `d` from the ball's surface on its open side: of a sphere of directions (none putting the eye under the
 * floor), the one farthest from every fade capsule. A held ball sits against its holder, so "away from the pair" can
 * run along his side; leaning in to look at the ball means coming at it from where there's room.
 */
export function openEye(ball, players, d) {
  let eye = null;
  let gap = -Infinity;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    const p = [ball.centre[0] + Math.cos(phi) * r * (ball.radius + d), ball.centre[1] + y * (ball.radius + d), ball.centre[2] + Math.sin(phi) * r * (ball.radius + d)];
    if (p[1] <= 0) continue;
    const g = Math.min(...players.flatMap((pl) => pl.capsules.map((c) => capsuleDistance(p, c))));
    if (g > gap) [eye, gap] = [p, g];
  }
  return { eye, gap };
}

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
  // 0.3 m from the ball on its open side: nobody fades (the ball and hands never fade anyone)
  const b = ctx.court.freeze.ball;
  const open = openEye(b, players, 0.3);
  const near = await stepAt(ctx, open.eye, Math.round(0.4 * HZ), ids);
  const min = Math.min(...near.flatMap((o) => Object.values(o)));
  ctx.check(
    "P17: 0.3 m from the ball, on its open side, fades nobody",
    open.gap > FADE_NEAR && min === 1,
    `eye ${open.gap.toFixed(3)} m from the nearest torso or head (fades under ${FADE_NEAR}); lowest opacity ${min}`,
  );
  await stepAt(ctx, far, Math.round(0.4 * HZ), ids);
  // and the other way: an eye 0.15 m from the holder's torso, on the ball's side, fades the holder
  const holder = players.reduce((a, p) => (Math.min(...p.capsules.map((c) => capsuleDistance(b.centre, c))) < Math.min(...a.capsules.map((c) => capsuleDistance(b.centre, c))) ? p : a));
  const torso = holder.capsules[0];
  const axis = SEGMENT(b.centre, torso.a, torso.b);
  let out = b.centre.map((v, i) => v - axis[i]);
  const ol = Math.hypot(...out) || 1;
  out = out.map((v) => v / ol);
  // out from the torso through the ball, to exactly 0.15 m from the torso's surface (a leaning torso isn't upright)
  let [lo, hi] = [0, torso.r + 1];
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (capsuleDistance(axis.map((v, k) => v + out[k] * mid), torso) < 0.15) lo = mid;
    else hi = mid;
  }
  const lean = axis.map((v, i) => v + out[i] * hi);
  const leaned = await stepAt(ctx, lean, Math.round(0.3 * HZ) + 2, ids);
  const leanAt = leaned.findIndex((o) => o[holder.id] <= FADE_TO + 1e-9);
  ctx.check(
    `P17: 0.15 m from the ball holder's torso (${holder.id}) fades them`,
    leanAt >= 0 && leanAt + 1 <= Math.round(0.3 * HZ) + 1,
    `30% after ${leanAt + 1} frames (eye ${capsuleDistance(lean, torso).toFixed(3)} m from the torso)`,
  );
  await stepAt(ctx, far, Math.round(0.4 * HZ), ids);
  ctx.report.proximity = { framesTo30: report, ball: { gap: open.gap, min, eye: open.eye }, holder: { id: holder.id, framesTo30: leanAt + 1 } };
}
