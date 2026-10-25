// P43, the layered watch from the seat on the stand-in (a gap between the shooter and the defender, a third person
// behind): no doubled or torn body > 0.1 deg in any display frame (every person on their own card; the plate behind
// them has no people), and P9's held frame (<= 1 grey level per display frame under 2 cm of head sway). Captures fixed
// frames from the seat (every EVERY-th display frame of pass 2, taken in the page so load never changes which; those
// drawn in the replay wipe are left out by its level) with the true scene from the same view beside each
// (standin.mjs truthAt, from the frame's logged view, cropped round the pair); the judge is stream D's: each person's
// crop is aligned to the truth's sub-pixel (diff.mjs, Lucas-Kanade) and compared on the person's own pixels (those
// the picture shows at full strength: where the frame's edge cuts a body its feather fades it by design), so a body
// doubled or torn by more than 0.1 deg moves the alignment or breaks the match. The held frame is F between the
// press's landing and the fade (F + 0 to 0.15 s), the head swaying 2 cm, judged round the players. Owner: stream D.
import { readPng } from "../png.mjs";
import { sceneAt, tauOf } from "../standin.mjs";
import { shift, toLuma } from "../diff.mjs";
import { cameraOf, project, rayOf } from "../../../src/court/camera.ts";
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
/** The picture's feathered edge, frame uv (proxies.ts FEATHER: a card fades over it, as the window's edge). */
const FEATHER = 0.1;

/** count(x, y, k): how many pixels of the (2k + 1) square round (x, y) pass `test` (a summed-area table; off the image counts as not). */
function counts(w, h, test) {
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) sat[(y + 1) * (w + 1) + x + 1] = (test(x, y) ? 1 : 0) + sat[y * (w + 1) + x + 1] + sat[(y + 1) * (w + 1) + x] - sat[y * (w + 1) + x];
  return (x, y, k) => {
    const [x0, y0, x1, y1] = [Math.max(0, x - k), Math.max(0, y - k), Math.min(w, x + k + 1), Math.min(h, y + k + 1)];
    return sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
  };
}
const smooth = (e, x) => {
  const t = Math.min(1, Math.max(0, x / e));
  return t * t * (3 - 2 * t);
};
/**
 * Where a person's card shows at full strength: per pixel of the view crop r, whether the ray through it meets the
 * person's card plane (upright through their foot, square to the broadcast camera's horizontal ray: proxies.ts
 * cardPlane) inside the show frame's picture clear of its feathered edge (the edge's strength above `min`). A body
 * the frame's edge cuts (the camera tilting up after the ball) fades there by design: those pixels aren't the plate
 * showing through.
 */
function fullyInPicture(view, r, foot, centre, camK, min = 0.999) {
  const d = [foot[0] - centre[0], 0, foot[2] - centre[2]];
  const n = Math.hypot(d[0], d[2]);
  const normal = [d[0] / n, 0, d[2] / n];
  const cam = { centre: view.centre, q: view.q, f: view.fx, cx: view.cx, cy: view.cy, width: view.width, height: view.height };
  const w = r[2] - r[0];
  const out = new Uint8Array(w * (r[3] - r[1]));
  for (let y = r[1]; y < r[3]; y++)
    for (let x = r[0]; x < r[2]; x++) {
      const ray = rayOf(cam, x, y);
      const den = ray.dir[0] * normal[0] + ray.dir[2] * normal[2];
      if (Math.abs(den) < 1e-9) continue;
      const t = ((foot[0] - ray.origin[0]) * normal[0] + (foot[2] - ray.origin[2]) * normal[2]) / den;
      if (t <= 0) continue;
      const at = project(camK, ray.origin.map((o, k) => o + ray.dir[k] * t));
      if (!at) continue;
      const u = (at[0] + 0.5) / camK.width;
      const v = (at[1] + 0.5) / camK.height;
      out[(y - r[1]) * w + (x - r[0])] = smooth(FEATHER, Math.min(u, 1 - u)) * smooth(FEATHER, Math.min(v, 1 - v)) > min ? 1 : 0;
    }
  return out;
}

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
/** Hold saved frames in the page while the show runs; flush() hands them to the runner afterwards. */
const hold = (ctx) => ctx.page.evaluate(() => {
  if (window.__dHeld) return;
  window.__dHeld = { send: window.__courtSave, kept: [] };
  window.__courtSave = async (...args) => (window.__dHeld.kept.push(args), args[0]);
});
const flush = (ctx) => ctx.page.evaluate(async () => {
  const h = window.__dHeld;
  if (!h) return;
  window.__courtSave = h.send;
  delete window.__dHeld;
  for (const args of h.kept) await h.send(...args);
});

export default async function layers(ctx) {
  if (!ctx.standin) ctx.skip("P43 needs the stand-in's truth (run without --bundle)");
  if (ctx.timing) ctx.skip("capture only");
  const { pass2 } = ctx.court.video.segments;
  const pairCentre = ctx.court.seat.pairCentre;
  await ctx.seatHere();
  await ctx.handOver();

  // P43: fixed frames through pass 2 (every EVERY-th display frame from its first), each with the truth from its own
  // view round the pair. The show runs on while the runner works, so from the watch's start everything is done in one
  // page call (the frames held there, no round trip between them) and the truths rendered after: which frames are
  // judged never depends on load. The drawn hands are off (controllers): they cover the people's surroundings here
  await ctx.device((d) => (d.primaryInputMode = "controller"));
  await hold(ctx);
  const shots = await ctx.page.evaluate(async ({ every, last }) => {
    const c = window.__court;
    await c.until("watching", 72 * 8);
    let f = await c.nextFrame();
    while (f.segment !== "pass2") f = await c.nextFrame();
    const out = [];
    for (let k = 0; ; k++) {
      const name = `layers-${String(k).padStart(3, "0")}`;
      const shot = await c.save(name);
      if (shot.segment !== "pass2" || shot.frame >= last) break;
      // the replay wipe this frame was drawn with (video.ts: pass 2's first and last WIPE_S dimmed on purpose)
      out.push({ name, shot, wipe: window.__courtLook?.video?.wipeLevel ?? null });
      for (let i = 1; i < every; i++) await c.nextFrame();
    }
    return out;
  }, { every: EVERY, last: pass2[1] - EVERY });
  await flush(ctx);
  ctx.check("P43: the fixed frames from pass 2's start", shots[0]?.shot.frame === pass2[0] + 1, `first frame ${shots[0]?.shot.frame} (pass 2 from ${pass2[0]}), ${shots.length} frames`);
  if (shots.some((s) => s.wipe === null)) ctx.check("P43: the video's wipe level read with each frame", false, "no window.__courtLook.video (dev only)");
  const pairs = [];
  const wiped = [];
  for (const { name, shot, wipe } of shots) {
    if (wipe > 0) {
      wiped.push(shot.onScreen);
      continue;
    }
    const { rect, view } = cropView(shot.view, pairCentre);
    const truth = await ctx.truth(view, shot.onScreen);
    pairs.push({ name, frame: shot.onScreen, luma: shot.luma, view: shot.view, cropped: view, rect, truth: ctx.writePng(`${name}-truth`, { width: view.width, height: view.height, rgb: truth.rgb }), kind: truth.kind });
  }

  // each person in each frame (a frame in the replay wipe is dimmed on purpose and left out above, by the level it was
  // drawn with; a person in the dark round the window isn't on screen, left out below)
  const rows = [];
  const dark = [];
  for (const p of pairs) {
    const show = ctx.showFrames[p.frame];
    const people = sceneAt(tauOf(show.src)).people; // truth kind PERSON + i is people[i]
    const camK = cameraOf(ctx.court, show);
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
      if (mean(toLuma(c)) < 0.5 * mean(toLuma(a))) {
        dark.push(`${p.frame}/${kind - PERSON}`); // in the dark round the window
        continue;
      }
      const s = shift(a, c, { maxPx: 4 });
      const la = toLuma(a);
      const lm = toLuma(moved(c, s.dx, s.dy)); // the person aligned to the truth's
      const lc = toLuma(c); // the plate where it is
      const pic = fullyInPicture(p.cropped, r, people[kind - PERSON].foot, ctx.court.camera.centre, camK);
      // the plate is what shows round a person only inside the picture (at least half strength): outside it is the
      // cinema mask's dark, or with a surround (court.surround) the arena round the picture, never the plate
      const plate = fullyInPicture(p.cropped, r, people[kind - PERSON].foot, ctx.court.camera.centre, camK, 0.5);
      // the person's own pixels, 2 px in from their edge (a tear shows the plate there), and a ring round them, 5 px
      // clear (a double shows the person again on the plate there)
      const at = (x, y) => p.kind[(r[1] + y) * img.width + r[0] + x];
      const mine = counts(a.width, a.height, (x, y) => at(x, y) === kind);
      const anyone = counts(a.width, a.height, (x, y) => at(x, y) >= PERSON || at(x, y) === BALL);
      let torn = 0;
      let inside = 0;
      let cut = 0;
      let ghosts = 0;
      let ring = 0;
      for (let y = 0; y < a.height; y++)
        for (let x = 0; x < a.width; x++) {
          const core = mine(x, y, 2) === 25; // the whole 5 x 5 round it theirs (off the crop counts as not)
          const near = anyone(x, y, 5) > 0; // anyone's card may sit a little off (flat away from F)
          const i = y * a.width + x;
          if (core) {
            if (!pic[i]) {
              cut++; // (where the frame's edge cuts the body, its feather fades it: not judged)
              continue;
            }
            inside++;
            if (Math.abs(lm[i] - la[i]) > OFF) torn++;
          } else if (!near && plate[i] && lc[i] >= 0.5 * la[i]) {
            // (a pixel the window's feathered edge or the cinema mask darkens, or outside the picture, isn't the plate: not judged)
            ring++;
            if (Math.abs(lc[i] - la[i]) > OFF) ghosts++;
          }
        }
      rows.push({ frame: p.frame, person: kind - PERSON, deg: Math.hypot(s.dx, s.dy) / ppd, torn: torn / Math.max(1, inside), ghost: ghosts / Math.max(1, ring), inside, cut });
    }
  }
  for (const p of pairs) delete p.kind;
  ctx.report.pairs = pairs;
  ctx.report.p43 = { rows, wiped, dark, frames: shots.map((s) => s.shot.onScreen) };
  const worstDeg = Math.max(0, ...rows.map((r) => r.deg));
  const worstTorn = Math.max(0, ...rows.map((r) => r.torn));
  const worstGhost = Math.max(0, ...rows.map((r) => r.ghost));
  const cut = rows.reduce((n, r) => n + r.cut, 0);
  const worstCut = Math.max(0, ...rows.map((r) => r.cut / Math.max(1, r.cut + r.inside)));
  const ppd = ((pairs[0]?.view.fx ?? 0) * Math.PI) / 180;
  ctx.check("P43: no doubled or torn body > 0.1 deg", rows.length > 0 && worstTorn <= SHARE && worstGhost <= SHARE,
    `${rows.length} people judged over ${shots.length} fixed frames (show frames ${shots[0]?.shot.onScreen}-${shots.at(-1)?.shot.onScreen}, every ${EVERY}th display frame; ${wiped.length} in the replay wipe and ${dark.length} people in the dark round the window left out): pixels off the truth by > ${OFF} levels: torn (inside a body, aligned) worst ${(100 * worstTorn).toFixed(1)}%, doubled (a ring round it) worst ${(100 * worstGhost).toFixed(1)}% (each <= ${100 * SHARE}%); body pixels the frame's edge fades left out ${cut} of ${cut + rows.reduce((n, r) => n + r.inside, 0)} (worst body ${(100 * worstCut).toFixed(0)}%); whole-body offset worst ${worstDeg.toFixed(3)} deg (flat cards away from F: parallax, the depth proxy takes over at F; P8 judges F) at ${ppd.toFixed(1)} px/deg`);

  // P9's held frame: F before the fade, the head swaying 2 cm; every display frame kept in the page, handed over after.
  // The drawn hands are 40 cm away and sway with the head: off for this (controllers)
  await ctx.press("step");
  await ctx.device((d) => (d.primaryInputMode = "controller"));
  await hold(ctx);
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
  await flush(ctx);
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
