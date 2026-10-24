// The floor in the walk-around (stream E): the floor's footage is sharp across its camera's ray and smeared along it,
// so it is the floor only at the dolly seat (lightFilmedFloor) and the clean court floor everywhere you walk: the
// real floor's colour low-passed, boards, crisp lines and paint where the court model puts them. Checked at walk stops
// 2, 5, 7 and 8 (stream D's walk sheet: 1.5 m round the pair, eye 1.6 m), in the open world after the hand-off:
//   walking, the Reality check tints the floor the bundle marks as filmed (it is the clean floor now: imagined), up
//   at least 50% in blue / red; at the seat it leaves that floor alone (within 2%: the footage, as P23 has it).
// The frames (walk-<stop>.png) are the before/after record. D's 3D floor plate takes the same weight; until it does,
// it is hidden here and the check says so.
// Owner: stream E.
import { HZ, blueRedAt, lookFrom, realityPoints, sitAtSeat, walkStops } from "../look/view.mjs";

export const owner = "E (look)";
export const needs = ["world", "freeze"];

export default async function walkfloor(ctx) {
  if (ctx.timing) ctx.skip("capture only");
  const first = await ctx.nextFrame();
  if (!first.setup) ctx.skip("needs the setup page (before Seat here), where nothing else drives the light");
  const F = ctx.court.video.segments.eases[0]?.frames[1];
  // the open world as the hand-off leaves it: the light landed, the freeze up, the picture (on F) faded
  const plate = await ctx.page.evaluate(
    async ([f, hz]) => {
      const L = window.__courtLook;
      L.world.light.set("handoff", 5);
      L.freeze.reveal(1);
      if (!L.video || !L.proxies || f === undefined) return "none";
      for (let i = 0; i < 5 * hz && L.video.stats.onScreen !== f; i++) {
        L.video.show(f);
        L.proxies.project(f);
        L.world.frame(f);
        await window.__court.nextFrame();
      }
      L.video.opacity = 0;
      const floor = L.proxies.backgroundPlates.find((m) => m.name === "proxy-floor-3d");
      if (!floor) return "none";
      if (String(floor.material.fragmentShader).includes("lightFilmedFloor")) return "weighted";
      floor.visible = false; // its own streaks until D weights it too
      return "hidden";
    },
    [F, HZ],
  );
  const why = plate === "hidden" ? " (D's 3D floor plate hidden: waiting on D to weight it by lightFilmedFloor)" : "";
  await sitAtSeat(ctx);
  await ctx.frames(Math.round(0.4 * HZ));
  const views = [{ name: "seat", log: await ctx.save("walk-seat") }];
  for (const s of walkStops(ctx.court).filter((s) => [2, 5, 7, 8].includes(s.stop))) {
    await lookFrom(ctx, s.eye, s.target);
    await ctx.frames(Math.round(0.4 * HZ));
    views.push({ name: `stop ${s.stop}`, log: await ctx.save(`walk-${s.stop}`) });
  }
  // the same views with the Reality check on
  await ctx.pressFrames("reality", 3);
  await sitAtSeat(ctx);
  await ctx.frames(3);
  await ctx.save("walk-seat-reality");
  for (const s of walkStops(ctx.court).filter((s) => [2, 5, 7, 8].includes(s.stop))) {
    await lookFrom(ctx, s.eye, s.target);
    await ctx.frames(3);
    await ctx.save(`walk-${s.stop}-reality`);
  }
  await ctx.pressFrames("reality", 3);
  const report = {};
  for (const v of views) {
    const file = v.name === "seat" ? "walk-seat" : `walk-${v.name.split(" ")[1]}`;
    const { seen } = await realityPoints(ctx, v.log.view);
    const rise = blueRedAt(ctx, `${file}-reality`, v.log.view, seen) / blueRedAt(ctx, file, v.log.view, seen);
    report[v.name] = { points: seen.length, rise };
    if (v.name === "seat")
      ctx.check(`walk: from the seat the filmed floor is the footage (Reality leaves it within 2%)${why}`, seen.length >= 12 && Math.abs(rise - 1) <= 0.02, `${seen.length} filmed points, blue / red x${rise.toFixed(3)}`);
    else
      ctx.check(`walk: at ${v.name} the filmed floor is the clean floor (Reality tints it, up at least 50%)${why}`, seen.length >= 12 && rise >= 1.5, `${seen.length} filmed points, blue / red x${rise.toFixed(2)}`);
  }
  ctx.report.walkfloor = { plate, report };
}
