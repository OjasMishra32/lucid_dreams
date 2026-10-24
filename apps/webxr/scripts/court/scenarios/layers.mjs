// P43, the layered watch from the seat on the stand-in (a gap between the shooter and the defender, a third person
// behind): no doubled or torn body > 0.1 deg in any display frame (every person on their own card; the plate behind
// them has no people), and P9's held frame (<= 1 grey level per display frame under 2 cm of head sway). Captures
// frames from the seat with the true scene from the same view beside each (standin.mjs truthAt, from the frame's
// logged view, cropped round the pair); the judge is stream D's: each person's crop is aligned to the truth's
// sub-pixel (diff.mjs, Lucas-Kanade) and compared on the person's own pixels, so a body doubled or torn by more than
// 0.1 deg moves the alignment or breaks the match. The held frame is F between the press's landing and the fade
// (F + 0 to 0.15 s), the head swaying 2 cm, judged round the players. Owner: stream D.
import { readPng } from "../png.mjs";
import { shift, toLuma } from "../diff.mjs";
import { project } from "../../../src/court/camera.ts";
import { BEATS } from "../../../src/court/handoff.ts";

export const owner = "D (handoff)";
export const needs = ["clock", "video", "proxies", "seat", "seatmath"];

/** Every how many display frames a frame is captured and judged. */
const EVERY = 9;
/** P43: a pixel this far off the truth (luma levels) is something else: the plate inside a body (torn), a person round it (doubled)... */
const OFF = 60;
/** ...and at most this share of a body's inside or ring may be (resampling and the plate's parallax are a few %). */
const SHARE = 0.05;
/** People in truthAt's kinds start here (10 + their index); the ball's (standin.mjs TRUTH_KIND). */
const PERSON = 10;
const BALL = 6;
/** P43 looks for a double this far round each body, pixels. */
const RING_PX = 24;
/** The truth is rendered for this crop round the pair, pixels (the rest of the view isn't judged). */
const CROP = [480, 360];
/** P9's held frame is judged this many pixels round the people (the court and the crowd behind them). */
const ROUND_PX = 24;

/** A view's crop round the pair's centre: the crop's rectangle in the view, and the view of just that crop. */
function cropView(view, pair) {
  const cam = { centre: view.centre, q: view.q, f: view.fx, cx: view.cx, cy: view.cy, width: view.width, height: view.height };
  const at = project(cam, [pair[0], 1, pair[2]]) ?? [view.cx, view.cy];
  const x0 = Math.max(0, Math.min(view.width - CROP[0], Math.round(at[0] - CROP[0] / 2)));
  const y0 = Math.max(0, Math.min(view.height - CROP[1], Math.round(at[1] - CROP[1] / 2)));
  return { rect: [x0, y0, x0 + CROP[0], y0 + CROP[1]], view: { ...view, width: CROP[0], height: CROP[1], cx: view.cx - x0, cy: view.cy - y0 } };
}
const crop = (img, [x0, y0, x1, y1]) => {
  const c = img.channels ?? 3;
  const w = x1 - x0;
  const data = new Uint8Array(w * (y1 - y0) * c);
  for (let y = y0; y < y1; y++) data.set(img.data.subarray((y * img.width + x0) * c, (y * img.width + x1) * c), (y - y0) * w * c);
  return { width: w, height: y1 - y0, channels: c, data };
};
/** The image moved by (dx, dy) pixels, bilinear (so its match to the truth is taken once aligned). */
const moved = (img, dx, dy) => {
  const c = img.channels;
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const sx = Math.min(img.width - 1.001, Math.max(0, x + dx));
      const sy = Math.min(img.height - 1.001, Math.max(0, y + dy));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let k = 0; k < c; k++) {
        const at = (xx, yy) => img.data[(yy * img.width + xx) * c + k];
        out[(y * img.width + x) * c + k] = Math.round((1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1)));
      }
    }
  return { ...img, data: out };
};
const p99 = (list) => {
  const s = [...list].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.99))] ?? 0;
};
const mean = (l) => l.reduce((x, y) => x + y, 0) / Math.max(1, l.length);

export default async function layers(ctx) {
  if (!ctx.standin) ctx.skip("P43 needs the stand-in's truth (run without --bundle)");
  if (ctx.timing) ctx.skip("capture only");
  await ctx.seatHere();
  await ctx.handOver();
  await ctx.until("watching", 72 * 8);
  const { pass2 } = ctx.court.video.segments;
  const pairCentre = ctx.court.seat.pairCentre;

  // P43: frames through pass 2, each with the truth from its own view round the pair. The drawn hands are off
  // (controllers): they cover the people's surroundings in this view
  await ctx.device((d) => (d.primaryInputMode = "controller"));
  const pairs = [];
  let f = await ctx.nextFrame();
  while (f.segment !== "pass2") f = await ctx.nextFrame();
  for (let k = 0; f.segment === "pass2" && f.frame < pass2[1] - EVERY; k++) {
    const name = `layers-${String(k).padStart(3, "0")}`;
    const shot = await ctx.save(name);
    const { rect, view } = cropView(shot.view, pairCentre);
    const truth = await ctx.truth(view, shot.onScreen);
    pairs.push({ name, frame: shot.onScreen, luma: shot.luma, view: shot.view, rect, truth: ctx.writePng(`${name}-truth`, { width: view.width, height: view.height, rgb: truth.rgb }), kind: truth.kind });
    await ctx.frames(EVERY - 1);
    f = await ctx.nextFrame();
  }

  // each person in each frame (a frame in the replay wipe at pass 2's ends is dimmed on purpose: well under the
  // others' mean luma; a person in the dark round the window isn't on screen)
  const typical = [...pairs.map((p) => p.luma)].sort((x, y) => x - y)[pairs.length >> 1] ?? 0;
  const rows = [];
  const skipped = [];
  for (const p of pairs) {
    if (p.luma < 0.9 * typical) {
      skipped.push(p.frame);
      continue;
    }
    const img = crop(readPng(`${ctx.out}/${p.name}.png`), p.rect);
    const truth = { width: img.width, height: img.height, channels: 3, data: readPng(p.truth).data };
    const ppd = (p.view.fx * Math.PI) / 180;
    const boxes = new Map();
    for (let i = 0; i < p.kind.length; i++) {
      if (p.kind[i] < PERSON) continue;
      const x = i % img.width;
      const y = (i / img.width) | 0;
      const b = boxes.get(p.kind[i]) ?? [Infinity, Infinity, -1, -1];
      boxes.set(p.kind[i], [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]);
    }
    for (const [kind, b] of boxes) {
      const pad = RING_PX; // a double sits off the body by the plate's parallax: well clear of it, so look round it
      const r = [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), Math.min(img.width, b[2] + pad + 1), Math.min(img.height, b[3] + pad + 1)];
      if (r[2] - r[0] < 16 || r[3] - r[1] < 16) continue; // too small in this view to judge
      const a = crop(truth, r);
      const c = crop(img, r);
      if (mean(toLuma(c)) < 0.5 * mean(toLuma(a))) continue; // in the dark round the window
      const s = shift(a, c, { maxPx: 4 });
      const la = toLuma(a);
      const lm = toLuma(moved(c, s.dx, s.dy)); // the person aligned to the truth's
      const lc = toLuma(c); // the plate where it is
      // the person's own pixels, 2 px in from their edge (a tear shows the plate there), and a ring round them, 5 px
      // clear (a double shows the person again on the plate there)
      const at = (x, y) => p.kind[(r[1] + y) * img.width + r[0] + x];
      const mine = (x, y) => x >= 0 && y >= 0 && x < a.width && y < a.height && at(x, y) === kind;
      const anyone = (x, y) => x >= 0 && y >= 0 && x < a.width && y < a.height && (at(x, y) >= PERSON || at(x, y) === BALL);
      let torn = 0;
      let inside = 0;
      let ghosts = 0;
      let ring = 0;
      for (let y = 0; y < a.height; y++)
        for (let x = 0; x < a.width; x++) {
          let near = false;
          let core = true;
          for (let dy = -5; dy <= 5; dy++)
            for (let dx = -5; dx <= 5; dx++) {
              if (!mine(x + dx, y + dy) && Math.abs(dx) <= 2 && Math.abs(dy) <= 2) core = false;
              if (anyone(x + dx, y + dy)) near = true; // anyone's card may sit a little off (flat away from F)
            }
          const i = y * a.width + x;
          if (core) {
            inside++;
            if (Math.abs(lm[i] - la[i]) > OFF) torn++;
          } else if (!near && lc[i] >= 0.5 * la[i]) {
            // (a pixel the window's feathered edge or the cinema mask darkens isn't the plate: not judged)
            ring++;
            if (Math.abs(lc[i] - la[i]) > OFF) ghosts++;
          }
        }
      rows.push({ frame: p.frame, person: kind - PERSON, deg: Math.hypot(s.dx, s.dy) / ppd, torn: torn / Math.max(1, inside), ghost: ghosts / Math.max(1, ring) });
    }
  }
  for (const p of pairs) delete p.kind;
  ctx.report.pairs = pairs;
  ctx.report.p43 = { rows, skipped };
  const worstDeg = Math.max(0, ...rows.map((r) => r.deg));
  const worstTorn = Math.max(0, ...rows.map((r) => r.torn));
  const worstGhost = Math.max(0, ...rows.map((r) => r.ghost));
  const ppd = ((pairs[0]?.view.fx ?? 0) * Math.PI) / 180;
  ctx.check("P43: no doubled or torn body > 0.1 deg", rows.length > 0 && worstTorn <= SHARE && worstGhost <= SHARE,
    `${rows.length} people over ${pairs.length - skipped.length} frames (${skipped.length} with the window out of view or dimmed left out): pixels off the truth by > ${OFF} levels: torn (inside a body, aligned) worst ${(100 * worstTorn).toFixed(1)}%, doubled (a ring round it) worst ${(100 * worstGhost).toFixed(1)}% (each <= ${100 * SHARE}%); whole-body offset worst ${worstDeg.toFixed(3)} deg (flat cards away from F: parallax, the depth proxy takes over at F; P8 judges F) at ${ppd.toFixed(1)} px/deg`);

  // P9's held frame: F before the fade, the head swaying 2 cm; every display frame kept in the page, handed over after.
  // The drawn hands are 40 cm away and sway with the head: off for this (controllers)
  await ctx.press("step");
  await ctx.device((d) => (d.primaryInputMode = "controller"));
  await ctx.page.evaluate(() => {
    window.__dHeld = { send: window.__courtSave, kept: [] };
    window.__courtSave = async (...args) => (window.__dHeld.kept.push(args), args[0]);
  });
  const held = await ctx.page.evaluate(async ({ max, until }) => {
    const c = window.__court;
    const d = window.__xrDevice;
    const [x0, y0, z0] = [d.position.x, d.position.y, d.position.z];
    let f = await c.nextFrame();
    while (f.segment !== "freeze" && max-- > 0) f = await c.nextFrame();
    const t0 = performance.now();
    const sway = setInterval(() => d.position.set(x0 + 0.02 * Math.sin((performance.now() - t0) / 107), y0, z0), 4);
    const shots = [];
    for (let k = 0; k < 9; k++) {
      const s = await c.save(`layers-held-${k}`);
      shots.push(s);
      if (s.tF >= until) break;
    }
    clearInterval(sway);
    d.position.set(x0, y0, z0);
    return shots;
  }, { max: 72 * 40, until: BEATS.videoFades[0] });
  await ctx.page.evaluate(async () => {
    const h = window.__dHeld;
    window.__courtSave = h.send;
    delete window.__dHeld;
    for (const args of h.kept) await h.send(...args);
  });
  await ctx.device((d) => (d.primaryInputMode = "hand"));
  const usable = held.filter((s) => s.tF < BEATS.videoFades[0] && s.onScreen === held[0].onScreen);
  // round the players: their truth boxes in the first held frame, grown by ROUND_PX
  const first = usable[0];
  const steps = [];
  if (first) {
    const { rect, view } = cropView(first.view, pairCentre);
    const kinds = (await ctx.truth(view, first.onScreen)).kind;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    for (let i = 0; i < kinds.length; i++)
      if (kinds[i] >= PERSON) [x0, y0, x1, y1] = [Math.min(x0, i % view.width), Math.min(y0, (i / view.width) | 0), Math.max(x1, i % view.width), Math.max(y1, (i / view.width) | 0)];
    const round = [rect[0] + Math.max(0, x0 - ROUND_PX), rect[1] + Math.max(0, y0 - ROUND_PX), rect[0] + Math.min(view.width, x1 + ROUND_PX + 1), rect[1] + Math.min(view.height, y1 + ROUND_PX + 1)];
    for (let k = 1; k < usable.length; k++) {
      if (usable[k].n !== usable[k - 1].n + 1) continue;
      const A = crop(readPng(`${ctx.out}/layers-held-${held.indexOf(usable[k - 1])}.png`), round);
      const B = crop(readPng(`${ctx.out}/layers-held-${held.indexOf(usable[k])}.png`), round);
      // the head's sway moves the view a fraction of a pixel: align, then what's left is shimmer
      const s = shift(A, B, { maxPx: 3 });
      const a = toLuma(A);
      const b = toLuma(moved(B, s.dx, s.dy));
      const keep = (i) => a[i] > 12 && (i % A.width) > 4 && (i % A.width) < A.width - 4 && i > 4 * A.width && i < (A.height - 4) * A.width;
      steps.push({ mean: Math.abs(mean(Array.from(b)) - mean(Array.from(a))), residual: p99(Array.from(a, (v, i) => Math.abs(b[i] - v)).filter((_, i) => keep(i))), dx: s.dx, dy: s.dy });
    }
  }
  ctx.report.held = { frames: held.map(({ thumb, view, ...x }) => x), steps };
  ctx.check("P9: held frame <= 1 grey level per display frame", steps.length >= 3 && steps.every((s) => s.mean <= 1),
    steps.length ? `frame F held over ${steps.length} consecutive display frame pairs, the head swaying 2 cm, round the players: mean luma step ${steps.map((s) => s.mean.toFixed(2)).join(", ")}; per pixel p99 once aligned ${steps.map((s) => s.residual.toFixed(1)).join(", ")} (resampling at ${ppd.toFixed(1)} px/deg)` : "no consecutive held frames captured before the fade");
}
