// P17: you never enter a body, and leaning in never fades one. An eye 0.2 m from a torso or head capsule fades that
// player to 30% within 300 ms (+1 frame); an eye 0.3 m from the ball fades nobody. Run from the seat on the setup
// page, driving Freeze.update once a display frame (court.ts's own call takes over in the open world).
// Owner: stream E.
import { sitAtSeat } from "../look/view.mjs";
import { checkProximity } from "../look/proximity.mjs";

export const owner = "E (look)";
export const needs = ["world", "freeze"];

export default async function proximity(ctx) {
  if (ctx.timing) ctx.skip("capture only");
  await ctx.nextFrame();
  await sitAtSeat(ctx);
  await checkProximity(ctx);
}
