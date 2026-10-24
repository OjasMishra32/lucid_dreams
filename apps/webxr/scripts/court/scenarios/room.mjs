// P33-P35: the arena is opaque (alpha 255 everywhere) except where the room shows; See my room fades out over 0.6 s and
// back over 0.8 s (+/- 1 frame) and opens the room (alpha 0 on room pixels); the room opens from 0.6 m to the bounds
// and is fully open at 0.3 m. Checked here in the phases the stubs reach (arrival, watching); the other seven join as
// their modules land (P34 asks for all 9). Owner: stream E.
export const owner = "E (look)";
export const needs = ["clock", "world"];

const HZ = 72;

export default async function room(ctx) {
  if (ctx.timing) ctx.skip("capture only");
  await ctx.seatHere();
  await ctx.handOver();
  for (const phase of ["arrival", "watching"]) {
    if (phase !== "arrival") await ctx.until(phase, HZ * 8);
    const out = await ctx.pressFrames("room", Math.round(0.6 * HZ) + 4);
    const outAt = out.findIndex((f) => f.roomP >= 1);
    ctx.check(`${phase}: out in 0.6 s`, out[0].phase === phase && Math.abs(outAt + 1 - 0.6 * HZ) <= 1, `room fully in after ${outAt + 1} frames (pressed in ${out[0].phase})`);
    ctx.check(`${phase}: the room shows`, out.at(-1).alphaMin === 0, `alpha min ${out.at(-1).alphaMin} with the room in`);
    const back = await ctx.pressFrames("room", Math.round(0.8 * HZ) + 4);
    const backAt = back.findIndex((f) => f.roomP <= 0);
    ctx.check(`${phase}: back in 0.8 s`, Math.abs(backAt + 1 - 0.8 * HZ) <= 1, `arena back after ${backAt + 1} frames`);
    ctx.check(`${phase}: opaque again (P33)`, back.at(-1).alphaMin === 255, `alpha min ${back.at(-1).alphaMin}`);
    ctx.report[phase] = [...out, ...back].map(({ thumb, view, ...f }) => f);
  }
  ctx.check("P35: the edge opens the room", false, "not written yet (stream E): walk the head to 0.6, 0.45 and 0.3 m from a simulated bounds polygon");
}
