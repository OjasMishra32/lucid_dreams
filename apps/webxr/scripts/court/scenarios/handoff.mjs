// The hand-off at the dolly seat (3.3, 3.3a): P8 per eye at the seat and up to 40 cm up (<= 0.055 deg per eye; the
// mono and camera-F checks are handoff_check.py's), P9 mid-fade SSIM >= 0.95 per display frame, P10 a head rise
// > 10 cm finishes the fade within 0.3 s, P44 every light change <= 1 grey level per display frame. Drives a press in
// pass 2 through the ease into the open world and captures every display frame of the fade. Owner: stream D.
export const owner = "D (handoff)";
export const needs = ["clock", "video", "proxies", "handoff", "freeze", "world", "light", "seat", "seatmath"];

export default async function handoff(ctx) {
  await ctx.seatHere();
  await ctx.handOver();
  await ctx.until("watching", 72 * 8);
  let f = await ctx.nextFrame();
  while (f.segment !== "pass2") f = await ctx.nextFrame();
  await ctx.press("step");
  await ctx.until("handoff", 72 * 30);
  const fade = await ctx.until("open", 72 * 8);
  ctx.check("reaches the open world", fade.at(-1)?.phase === "open", `${fade.at(-1)?.phase} after ${fade.length} frames of hand-off`);
  ctx.report.frames = fade.map(({ thumb, view, ...x }) => x);
  ctx.check("P8: same pixels per eye at the seat", false, "not written yet (stream D)");
  ctx.check("P9: mid-fade SSIM >= 0.95", false, "not written yet (stream D)");
  ctx.check("P10: a head rise finishes the fade within 0.3 s", false, "not written yet (stream D)");
  ctx.check("P44: <= 1 grey level of light change per display frame", false, "not written yet (streams D, E)");
}
