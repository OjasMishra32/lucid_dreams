// The look from the seat through the time stop, the hand-off's light and the pool (stream E's modules: the light
// field, the world, the freeze), driven straight through the light field before Seat here, so it runs ahead of the
// clock and the hand-off; P44 through court.ts's own phases is the handoff scenario's.
//   P33: alpha 255 on every frame. P44: no light change over 1 grey level per display frame (the 16 x 9 grid; the
//   CPU twin in lightfield.test.ts holds it per pixel on the encoded byte, dither included, up to SAFE_GREY). P28: the
//   house goes down while the pair's own pixels move <= 1 grey level. P23: the Reality check tints the floor no
//   camera filmed (neither floor-seen nor camera F's picture) and leaves the filmed floor alone. (P17, the capsule
//   fade, is scenarios/proximity.mjs.)
// Owner: stream E.
import { HZ, alphaOk, backgroundPoints, blueRedAt, lumaAt, lumaEach, realityPoints, runLight, sitAtSeat, worstStep } from "../look/view.mjs";

export const owner = "E (look)";
export const needs = ["light", "world", "freeze"];

export default async function look(ctx) {
  if (ctx.timing) ctx.skip("capture only");
  const first = await ctx.nextFrame();
  if (!first.setup) ctx.skip("needs the setup page (before Seat here), where nothing else drives the light");
  await sitAtSeat(ctx);
  await ctx.page.evaluate(() => {
    window.__courtLook.world.light.set("watch", 0);
    window.__courtLook.freeze.reveal(1);
  });
  // the picture on F, as at the real time stop: with the video layer built (stream D's player and proxies on
  // __courtLook) the pair's pixels are F's own, so the light can be judged on them; the stubs keep the 3D alone
  const F = ctx.court.video.segments.eases[0]?.frames[1];
  const onF = await ctx.page.evaluate(
    async ([f, hz]) => {
      const L = window.__courtLook;
      if (!L.video || !L.proxies || f === undefined) return null;
      L.video.opacity = 1;
      for (let i = 0; i < 5 * hz; i++) {
        L.video.show(f);
        L.proxies.project(f);
        L.world.frame(f);
        await window.__court.nextFrame();
        if (L.video.stats.onScreen === f) return { frames: i + 1, onScreen: f };
      }
      return { frames: -1, onScreen: L.video.stats.onScreen };
    },
    [F, HZ],
  );
  if (onF) ctx.check("the picture is on F for the time stop (P28)", onF.frames > 0, `show frame ${onF.onScreen} on screen after ${onF.frames} frames (F is ${F})`);
  await ctx.frames(Math.round(0.5 * HZ)); // Spark's first generation and sort (shown late, splats pop for 2-6 frames)
  const watch = await ctx.save("look-watch");
  const ease = Array.from({ length: Math.round(1.2 * HZ) }, (_, i) => ["ease", i / HZ, null]);
  const open = Array.from({ length: 5 * HZ + 1 }, (_, i) => ["handoff", i / HZ, null]);
  const a = await runLight(ctx, ease);
  const atF = await ctx.save("look-freeze");
  // the field at F (perceived): its floor level, and which floor points it leaves at that level (outside the spot that
  // holds the pair), for the background's dim
  // (a 0.25 m grid over the court and its apron: the extras stand on much of the lit floor beyond the pair)
  const cand = backgroundPoints(ctx, watch.view, 0, { step: 0.25, apron: 1.7 });
  const { floorAtF, outside } = await ctx.page.evaluate((pts) => {
    const light = window.__courtLook.world.light;
    const level = Math.pow(light.levels.floor, 1 / 2.4);
    return { floorAtF: level, outside: pts.map(([x, , z]) => Math.abs(Math.pow(light.at(x, z), 1 / 2.4) - level) < 0.01) };
  }, cand);
  const b = await runLight(ctx, open);
  const opened = await ctx.save("look-open");
  const all = [...a, ...b];
  ctx.check("opaque through the ease and the pool (P33)", alphaOk(all), `alpha min ${Math.min(...all.map((f) => f.alphaMin))} over ${all.length} frames`);
  const s = worstStep(all);
  ctx.check("every light change <= 1 grey level per display frame (P44, 16 x 9 grid)", s.worst <= 1, `worst cell step ${s.worst} at frame ${s.at} of ${all.length} (${s.at < a.length ? "ease" : "hand-off"})`);
  ctx.check(
    "the house goes down over the ease and the pool lifts the floor after (P28)",
    a.at(-1).luma < a[0].luma && b.at(-1).luma > b[HZ].luma,
    `mean luma watch ${a[0].luma}, F ${a.at(-1).luma}, F+1 ${b[HZ].luma}, F+5 ${b.at(-1).luma}`,
  );
  // the pair's own pixels (the middle of each torso) through the time stop
  const torsos = ctx.court.freeze.players.map((p) => p.capsules[0].a.map((v, i) => (v + p.capsules[0].b[i]) / 2));
  const before = lumaAt(ctx, "look-watch", watch.view, torsos);
  const after = lumaAt(ctx, "look-freeze", atF.view, torsos);
  ctx.check(
    `the pair stays at 1.0 through the time stop (P28: <= 1 grey level${onF ? ", the picture on F" : ", the 3D alone"})`,
    Math.abs(after - before) <= 1,
    `torso luma ${before.toFixed(2)} -> ${after.toFixed(2)}`,
  );
  // and the background does dim, as the house light says: the floor the field leaves outside the pair's spot at F
  // (points bright enough at the watch to measure, luma 20 or more), against the field's level
  const lw = lumaEach(ctx, "look-watch", watch.view, cand);
  const lf = lumaEach(ctx, "look-freeze", atF.view, cand);
  const lit = cand.map((_, i) => i).filter((i) => outside[i] && lw[i] >= 20 && Number.isFinite(lf[i]));
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const [bw, bf] = [mean(lit.map((i) => lw[i])), mean(lit.map((i) => lf[i]))];
  ctx.check(
    "the background away from the pair dims at F as the house light says (P28: within 0.1 of the field's floor level)",
    lit.length >= 12 && bf / bw <= 0.9 && Math.abs(bf / bw - floorAtF) <= 0.1,
    `${lit.length} lit floor points outside the pair's spot (of ${cand.length} on screen and clear, ${outside.filter(Boolean).length} outside the spot): luma ${bw.toFixed(2)} -> ${bf.toFixed(2)} (x${(bf / bw).toFixed(3)}); the field's floor at F ${floorAtF.toFixed(3)}`,
  );
  // the Reality check, judged on the floor the bundle marks: what was never filmed goes clearly blue, and what was
  // filmed doesn't move (a tint missing and a tint leaking onto real footage both fail)
  await ctx.pressFrames("reality", 3);
  await ctx.save("look-reality");
  await ctx.pressFrames("reality", 3);
  // filmed and imagined by the one definition (floor-seen, or camera F's picture where D's floor plate shows it)
  const sets = await realityPoints(ctx, opened.view, { plates: !!onF });
  const rise = (pts) => blueRedAt(ctx, "look-reality", opened.view, pts) / blueRedAt(ctx, "look-open", opened.view, pts);
  const [imagined, seen] = [rise(sets.imagined), rise(sets.seen)];
  const ratios = (pts) => `${blueRedAt(ctx, "look-open", opened.view, pts).toFixed(3)} -> ${blueRedAt(ctx, "look-reality", opened.view, pts).toFixed(3)}`;
  ctx.check(
    "the Reality check tints the imagined floor blue (P23: blue / red up at least 50%)",
    sets.imagined.length >= 12 && imagined >= 1.5,
    `${sets.imagined.length} imagined points: blue / red ${ratios(sets.imagined)} (x${imagined.toFixed(2)})`,
  );
  ctx.check(
    "the Reality check leaves the filmed floor alone (P23: blue / red within 2%)",
    sets.seen.length >= 12 && Math.abs(seen - 1) <= 0.02,
    `${sets.seen.length} filmed points: blue / red ${ratios(sets.seen)} (x${seen.toFixed(3)})`,
  );
  ctx.report.reality = { imagined: { points: sets.imagined.length, rise: imagined }, seen: { points: sets.seen.length, rise: seen } };
  // the hoop and the house lights take the field's light the frame it moves: court.ts calls the world's per-frame
  // methods (update, room, then edge) and moves the field after them, so here the field moves right after edge()
  const sync = await ctx.page.evaluate(async (hz) => {
    const w = window.__courtLook.world;
    const methods = ["edge"];
    const saved = methods.map((m) => w[m]);
    let t = 0;
    w.light.set("watch", 0);
    methods.forEach((m, i) => {
      w[m] = function (...args) {
        saved[i].apply(this, args);
        w.light.set("ease", t);
      };
    });
    const out = [];
    try {
      for (let i = 0; i < 8; i++) {
        t += 1 / hz;
        await window.__court.nextFrame();
        const drawn = { hoop: w.hoopK.value, glow: w.glows[0]?.material.color.g ?? NaN };
        w.lights(); // what the field says now
        out.push({ ...drawn, hoopNow: w.hoopK.value, glowNow: w.glows[0]?.material.color.g ?? NaN });
      }
    } finally {
      methods.forEach((m, i) => (w[m] = saved[i]));
    }
    return out;
  }, HZ);
  const lagging = sync.filter((s) => s.hoop !== s.hoopNow || s.glow !== s.glowNow).length;
  ctx.check(
    "the hoop and the house lights move with the field the same frame (P44)",
    lagging === 0 && sync[0].hoop !== sync.at(-1).hoop && sync[0].glow !== sync.at(-1).glow,
    `${lagging} of ${sync.length} frames drawn a frame behind; hoop ${sync[0].hoop.toFixed(4)} -> ${sync.at(-1).hoop.toFixed(4)}, glow ${sync[0].glow.toFixed(4)} -> ${sync.at(-1).glow.toFixed(4)}`,
  );
  ctx.report.luma = { watch: a[0].luma, freeze: a.at(-1).luma, open: b.at(-1).luma, pairBefore: before, pairAfter: after, onF, background: { points: lit.length, watch: bw, freeze: bf, floorAtF } };
  ctx.report.frames = all.map(({ thumb, view, ...f }) => f);
}
