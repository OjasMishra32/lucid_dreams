// P21 and P32 through IWER's hands (ui is tested here, not in node): the palm menu opens only palm-up (left palm,
// right index presses); every button works (Step into the court / Back to my seat, Reality check, Replay, See my room,
// Walk closer, Next view); Seat here acts only after a 2.0 s hold (a 1 s press changes nothing); pinches, grabs and
// swipes change nothing. Pose the hands with ctx.device(d => d.hands...). Owner: stream C.
export const owner = "C (core)";
export const needs = ["ui", "vrhands"];

export default async function controls(ctx) {
  await ctx.nextFrame();
  ctx.check("P32: Seat here needs a 2 s hold", false, "not written yet (stream C)");
  ctx.check("P21: palm-up menu, every button, no gesture acts", false, "not written yet (stream C)");
}
