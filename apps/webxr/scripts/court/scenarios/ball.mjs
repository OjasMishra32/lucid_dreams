// One ball at the freeze. With freeze.ballInBody (the holder's own splats hold the ball, as the real shooter's do) the
// 3D draws no ball of its own and the ball's card goes with the video layer, in the same frames as the holder's card:
// drawn through the watch and the ease, gone at the hand-off, back on the resume. In the open world exactly one ball
// is drawn: the holder's splats (no card, no sphere). Without the field the sphere is the ball (no card while frozen).
// Run on the stand-in (no field) and on one built with --ball-in-body (standin.mjs --out <dir outside the checkout>,
// then --bundle <dir>). Owner: the integrator.
export const owner = "integrator";
export const needs = ["clock", "video", "proxies", "freeze", "handoff", "seat"];

const HZ = 72;

export default async function ball(ctx) {
  const holder = ctx.court.freeze.ballInBody ?? null;
  const balls = async () => (await ctx.snapshot()).balls;
  await ctx.seatHere();
  await ctx.handOver();
  await ctx.until("watching", HZ * 8);
  let f = await ctx.nextFrame();
  while (f.segment !== "pass2") f = await ctx.nextFrame();
  await ctx.press("step");
  await ctx.until("open", HZ * 40);
  await ctx.frames(HZ);
  const open = await balls();
  const count = (b) => Number(b.card) + Number(b.sphere) + Number(b.body);
  if (holder)
    ctx.check("one ball at F: the holder's own splats (no card, no sphere)", open.body && !open.card && !open.sphere && count(open) === 1, JSON.stringify(open));
  else ctx.check("one ball at F: the 3D's sphere (no card while frozen)", open.sphere && !open.card && !open.body && count(open) === 1, JSON.stringify(open));

  // Back to my seat: the hand-back brings the picture back and the show resumes through the make; wherever a frame has
  // the ball's card, it is drawn exactly when the holder's card is (both go with the video layer)
  const run = await ctx.page.evaluate(async (max) => {
    window.__court.press("back");
    const out = [];
    for (let i = 0; i < max; i++) {
      await window.__court.nextFrame();
      const s = window.__court.snapshot();
      out.push({ phase: s.phase, ...s.balls });
      if (s.phase === "ended") break;
    }
    return out;
  }, HZ * 60);
  const withBall = run.filter((x) => x.ballCardHere);
  const apart = withBall.filter((x) => x.card !== x.holderCard);
  const back = withBall.filter((x) => x.card).length;
  ctx.check("on the resume the ball's card is drawn exactly when the holder's card is", run.at(-1)?.phase === "ended" && back > 0 && apart.length === 0,
    `${run.length} frames to the end; the ball's card in ${withBall.length} of them, drawn in ${back}; ${apart.length} apart${apart.length ? `: ${JSON.stringify(apart[0])}` : ""}`);
  const sphere = run.filter((x) => x.sphere).length;
  if (holder) ctx.check("and no sphere of the 3D's own at any point", sphere === 0, `${sphere} frames with the sphere drawn`);
}
