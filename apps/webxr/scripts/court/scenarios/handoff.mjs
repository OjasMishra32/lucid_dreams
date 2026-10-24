// The hand-off at the dolly seat (3.3, 3.3a): P8 per eye at the seat and up to 40 cm up (<= 0.055 deg per eye; the
// mono and camera-F checks are handoff_check.py's), P9 mid-fade SSIM >= 0.95 per display frame, P10 a head rise
// > 10 cm finishes the fade within 0.3 s, P44 every light change <= 1 grey level per display frame. Drives a press in
// pass 2 through the ease into the open world and captures every display frame of the fade. Owner: stream D.
// Three hand-offs (Replay in between): (A) every frame's log from the press to the open world, with the picture on F
// captured before the fade and the 3D after it (P8, P10's 1.0 s, P44's light per frame); (B) the fade captured every
// few display frames and in consecutive pairs (P9, P44 per pixel); (C) the head rising 15 cm mid-fade (P10). Frames are
// kept in the page while the show runs (window.__courtSave held back) and handed over after, so none slips by. The e2e
// view is IWER's (~6 px/deg): sub-pixel shifts (Lucas-Kanade) carry P8 here; scripts/court/d-check.mjs measures it at
// the Quest's 19.5 px/deg and zoomed. On a real bundle there is no true scene to render: P8 is the bundle's own
// validate there (assembly.json: each frozen player's silhouette IoU at F through the real camera, over its bar).
import { readPng } from "../png.mjs";
import { shift, ssim, toLuma } from "../diff.mjs";
import { BEATS, HANDOFF_END, handoffBeats } from "../../../src/court/handoff.ts";

export const owner = "D (handoff)";
export const needs = ["clock", "video", "proxies", "handoff", "freeze", "world", "light", "seat", "seatmath"];

const HZ = 72;
/** The head rise for P10, metres (court.ts finishes the fade on > 10 cm). */
const RISE_M = 0.15;
/** P10: the fade is done this long after a rise. */
const RUSH_S = 0.3;
/** P9: the fade is captured every this many display frames. */
const EVERY = 6;
/** P44 per pixel: consecutive pairs captured at these seconds from F (the fade, the pool, the stands). */
const PAIRS_AT = [0.6, 1.1, 2.0, 3.6];
/** P9 per frame: the window's inside starts this many pixels in from its dark (the feathered edge, ~10% of the frame). */
const FEATHER_PX = 24;
/** The stand-in's pair in truthAt's kinds (people are 10 + their index; the shooter and the defender first). */
const PAIR_KINDS = [10, 11];
/** P8 on a real bundle: each frozen player's silhouette IoU at F at least this (assemble.py validate's silhouette bar, P42). */
export const P8_IOU_BAR = 0.95;

/**
 * P8 where there is no true scene to render (a real bundle): the bundle's own validate (assemble.py) is the ground
 * truth, each frozen player's splats seen through the real camera F against their mask at F (assembly.json
 * pieces["player:<id>"].silhouetteIoU). Every player must be measured and over the bar.
 */
export function p8FromAssembly(asm, players, bar = P8_IOU_BAR) {
  const how = `judged by the bundle validate (silhouette IoU at F through the real camera F, bar ${bar})`;
  if (!asm) return { ok: false, ious: [], detail: `${how}: no assembly.json beside the bundle` };
  const ious = players.map((p) => asm.pieces?.[`player:${p.id}`]?.silhouetteIoU);
  const missing = ious.map((x, i) => (typeof x === "number" ? null : `player ${i + 1}`)).filter(Boolean);
  const list = ious.map((x, i) => `player ${i + 1} ${typeof x === "number" ? x : "-"}`).join(", ");
  if (missing.length) return { ok: false, ious, detail: `${how}: ${missing.join(", ")} not measured (${list})` };
  return { ok: ious.every((x) => x >= bar), ious, detail: `${how}: ${list}` };
}

/** Back to the watch (Replay), then a press in pass 2. */
async function toPress(ctx, replay) {
  if (replay) await ctx.press("replay");
  await ctx.until("watching", HZ * 8);
  let f = await ctx.nextFrame();
  while (f.segment !== "pass2") f = await ctx.nextFrame();
  await ctx.press("step");
}

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

const box = (kind, img, mask, pad) => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  for (let i = 0; i < mask.length; i++)
    if (mask[i] === kind) {
      const x = i % img.width;
      const y = (i / img.width) | 0;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  if (x1 < 0) return null;
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(img.width, x1 + pad + 1), Math.min(img.height, y1 + pad + 1)];
};
const crop = (img, [x0, y0, x1, y1]) => {
  const w = x1 - x0;
  const h = y1 - y0;
  const c = img.channels ?? 3;
  const data = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * c, ((y0 + y) * img.width + x1) * c), y * w * c);
  return { width: w, height: h, channels: c, data };
};
/** The mask shrunk by r pixels (a pixel stays when the whole (2r + 1) square round it is set). */
function erode(mask, w, h, r) {
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) sat[(y + 1) * (w + 1) + x + 1] = mask[y * w + x] + sat[y * (w + 1) + x + 1] + sat[(y + 1) * (w + 1) + x] - sat[y * (w + 1) + x];
  const out = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++)
    for (let x = r; x < w - r; x++) {
      const [x0, y0, x1, y1] = [x - r, y - r, x + r + 1, y + r + 1];
      const n = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      out[y * w + x] = n === (2 * r + 1) ** 2 ? 1 : 0;
    }
  return out;
}
const p99 = (list) => {
  const s = [...list].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.99))] ?? 0;
};

export default async function handoff(ctx) {
  await ctx.seatHere();
  await ctx.handOver();

  // (A) the press to the open world, every frame logged; the picture on F before the fade, the 3D after it
  await toPress(ctx, false);
  await hold(ctx);
  const a = await ctx.page.evaluate(async (max) => {
    const c = window.__court;
    const ease = await c.until("handoff", max);
    const pre = await c.save("handoff-pre"); // on F, the picture opaque (the fade starts at F + 0.15 s)
    const fade = await c.until("open", 72 * 8);
    const post = await c.save("handoff-post");
    return { ease: ease.map(({ thumb, view, ...x }) => x), fade, pre, post };
  }, HZ * 30);
  await flush(ctx);
  ctx.check("reaches the open world", a.fade.at(-1)?.phase === "open", `${a.fade.at(-1)?.phase} after ${a.fade.length} frames of hand-off`);
  ctx.report.frames = a.fade.map(({ thumb, view, ...x }) => x);
  ctx.report.ease = a.ease;

  // P44, the light per display frame through the whole hand-off: mean luma (to 0.01) and the 16 x 9 grid (whole grey
  // levels, so a step of 2 there can be a true 1.01)
  let meanStep = 0;
  let meanAt = 0;
  let cellStep = 0; // outside the window's opening (the cinema mask lifting is judged on its own)
  let cellLift = 0;
  const run = [a.pre, ...a.fade];
  const liftingAt = (t) => t >= BEATS.maskLifts[0] && t <= BEATS.maskLifts[1] + 1 / HZ;
  for (let i = 1; i < run.length; i++) {
    const [p, q] = [run[i - 1], run[i]];
    if (q.n !== p.n + 1 || p.luma === undefined || q.luma === undefined) continue;
    if (Math.abs(q.luma - p.luma) > meanStep) [meanStep, meanAt] = [Math.abs(q.luma - p.luma), q.tF];
    if (!p.thumb || !q.thumb) continue;
    for (let k = 0; k < p.thumb.length; k++) {
      const d = Math.abs(q.thumb[k] - p.thumb[k]);
      if (liftingAt(q.tF)) cellLift = Math.max(cellLift, d);
      else cellStep = Math.max(cellStep, d);
    }
  }

  // P10's 1.0 s: unrushed, the fade's beat spans 72 display frames (+/- 1)
  const fadeFrames = run.filter((f) => f.phase === "handoff" && f.tF >= BEATS.videoFades[0] && f.tF < BEATS.videoFades[1]).length;
  const contiguous = run.every((f, i) => i < 2 || f.n === run[i - 1].n + 1);

  // P8: the players in the picture on F vs the true scene from the same eye (the stand-in's splats are its own
  // approximation, so the 3D after the fade is reported beside it, not judged)
  const pre = readPng(`${ctx.out}/handoff-pre.png`);
  const post = readPng(`${ctx.out}/handoff-post.png`);
  const ppd = (a.pre.view.fx * Math.PI) / 180;
  const players = [];
  if (ctx.standin) {
    const truth = await ctx.truth(a.pre.view, a.pre.onScreen);
    const truthImg = { width: pre.width, height: pre.height, channels: 3, data: truth.rgb };
    for (const kind of PAIR_KINDS) {
      const b = box(kind, pre, truth.kind, 6);
      if (!b || b[2] - b[0] < 16 || b[3] - b[1] < 16) continue;
      const vt = shift(crop(truthImg, b), crop(pre, b), { maxPx: 4 });
      const v3 = shift(crop(post, b), crop(pre, b), { maxPx: 4 });
      players.push({ kind, box: b, vsTruthDeg: Math.hypot(vt.dx, vt.dy) / ppd, vs3dDeg: Math.hypot(v3.dx, v3.dy) / ppd });
    }
  }
  const worst = Math.max(0, ...players.map((p) => p.vsTruthDeg));
  ctx.report.p8 = { ppd, players };
  if (ctx.standin)
    ctx.check("P8: same pixels per eye at the seat", players.length > 0 && worst <= 0.055,
      players.length
        ? `the picture's players vs the true scene, worst ${worst.toFixed(4)} deg (${players.map((p) => p.vsTruthDeg.toFixed(4)).join(", ")}); vs the 3D after the fade ${players.map((p) => p.vs3dDeg.toFixed(4)).join(", ")} (the stand-in's splats); ${ppd.toFixed(1)} px/deg, sub-pixel`
        : "no player in view");
  else {
    const asm = await ctx.page.evaluate(() => fetch("/bundle/assembly.json").then((r) => (r.ok ? r.json() : null)).catch(() => null));
    const p8 = p8FromAssembly(asm, ctx.court.freeze.players);
    ctx.report.p8.assembly = p8.ious;
    ctx.check("P8: same pixels at F", p8.ok, p8.detail);
  }

  // (B) the fade every EVERY display frames, and consecutive pairs for P44 per pixel
  await toPress(ctx, true);
  await hold(ctx);
  const b = await ctx.page.evaluate(async ({ max, every, from, to, pairsAt }) => {
    const c = window.__court;
    await c.until("handoff", max);
    const first = await c.save("handoff-b-pre");
    const shots = [];
    const pairs = [];
    let next = first.n;
    const want = [...pairsAt];
    for (;;) {
      const f = await c.nextFrame();
      if (f.phase !== "handoff") break;
      if (want.length && f.tF >= want[0]) {
        want.shift();
        const k = pairs.length;
        pairs.push([await c.save(`handoff-pair-${k}-a`), await c.save(`handoff-pair-${k}-b`)]);
        continue;
      }
      if (f.tF < from || f.tF > to || f.n < next) continue;
      const shot = await c.save(`handoff-b-${String(shots.length).padStart(2, "0")}`);
      shots.push(shot);
      next = shot.n + every;
    }
    return { first, shots, pairs };
  }, { max: HZ * 30, every: EVERY, from: BEATS.videoFades[0], to: BEATS.videoFades[1] + 0.15, pairsAt: PAIRS_AT });
  await flush(ctx);
  const bPre = readPng(`${ctx.out}/handoff-b-pre.png`);
  const lastShot = b.shots.at(-1);
  const bPost = lastShot ? readPng(`${ctx.out}/handoff-b-${String(b.shots.length - 1).padStart(2, "0")}.png`) : bPre;
  // the window (the picture's lit region inside the cinema mask's dark): where the fade happens; outside it the mask
  // lifts on its own beat, which is no blend of the two
  const lit = new Uint8Array(bPre.width * bPre.height);
  const lp = toLuma(bPre);
  for (let i = 0; i < lit.length; i++) lit[i] = lp[i] > 12 ? 1 : 0;
  // its inside, clear of the feathered edge (where the mask's lift shows): FEATHER_PX in from any dark pixel
  const inside = erode(lit, bPre.width, bPre.height, FEATHER_PX);
  const mids = [];
  for (const [k, shot] of b.shots.entries()) {
    if (shot.tF > BEATS.videoFades[1]) continue;
    const img = readPng(`${ctx.out}/handoff-b-${String(k).padStart(2, "0")}.png`);
    const v = handoffBeats(shot.tF).video;
    const blend = { ...img, data: img.data.map((_, i) => (i % img.channels === 3 ? 255 : Math.round(v * bPre.data[i] + (1 - v) * bPost.data[i]))) };
    mids.push({ tF: shot.tF, v: Number(v.toFixed(3)), ssim: ssim(img, blend, lit) });
  }
  const minSsim = mids.length ? Math.min(...mids.map((m) => m.ssim)) : NaN;
  ctx.report.p9 = mids;
  ctx.check("P9: mid-fade SSIM >= 0.95", mids.length >= 5 && minSsim >= 0.95,
    `${mids.length} frames through the fade, min SSIM ${minSsim.toFixed(4)} vs the blend of the picture and the 3D at each frame's opacity (the 3D: F + ${lastShot?.tF.toFixed(2)} s)`);
  // P44 per pixel: consecutive display frames over the whole view, the luma change's p99; the window opening (the
  // cinema mask lifting, F + 0.1 to 1.0 s) apart from the light's own moves (the pool, the stands)
  const pixel = b.pairs.map(([x, y], k) => {
    const consecutive = y.n === x.n + 1;
    const la = toLuma(readPng(`${ctx.out}/handoff-pair-${k}-a.png`));
    const lb = toLuma(readPng(`${ctx.out}/handoff-pair-${k}-b.png`));
    const d = Array.from(la, (v, i) => Math.abs(lb[i] - v));
    return { tF: x.tF, consecutive, lifting: x.tF <= BEATS.maskLifts[1], p99: p99(d), window: p99(d.filter((_, i) => inside[i])) };
  });
  // P9's <= 1 grey level per display frame: inside the window, clear of its edge, while the picture fades
  const fadePairs = pixel.filter((p) => p.consecutive && p.tF >= BEATS.videoFades[0] && p.tF <= BEATS.videoFades[1]);
  ctx.check("P9: <= 1 grey level per display frame through the fade (the window)", fadePairs.length > 0 && fadePairs.every((p) => p.window <= 1 + 1e-6),
    fadePairs.length ? `per pixel p99 inside the window ${fadePairs.map((p) => `${p.window.toFixed(2)} at F + ${p.tF.toFixed(2)}`).join(", ")}` : "no consecutive pair in the fade");
  ctx.report.p44 = { meanStep, meanAt, cellStep, cellLift, pixel };
  const say = (list) => list.map((p) => `${p.p99.toFixed(2)} at F + ${p.tF.toFixed(2)}${p.consecutive ? "" : " (not consecutive)"}`).join(", ");
  const light = pixel.filter((p) => !p.lifting);
  const lifting = pixel.filter((p) => p.lifting);
  ctx.check("P44: <= 1 grey level of light change per display frame", meanStep <= 1 && cellStep <= 2 && light.some((p) => p.consecutive) && light.every((p) => !p.consecutive || p.p99 <= 1 + 1e-6),
    `mean-luma step max ${meanStep.toFixed(2)} (F + ${meanAt.toFixed(2)} s) over ${run.length} frames to F + ${HANDOFF_END} s; 16 x 9 grid step max ${cellStep} (whole levels); per pixel p99 ${say(light)}`);
  ctx.check("P44: the window opens (the cinema mask lifting) <= 1 grey level per display frame", lifting.some((p) => p.consecutive) && lifting.every((p) => !p.consecutive || p.p99 <= 1 + 1e-6) && cellLift <= 2,
    `per pixel p99 ${say(lifting)}; 16 x 9 grid step max ${cellLift} (what the lift uncovers is the arena as the light field leaves it at F)`);

  // (C) the head rises 15 cm mid-fade: the fade is done within 0.3 s (court.ts runs the hand-off's time faster)
  await toPress(ctx, true);
  const c = await ctx.page.evaluate(async ({ max, rise, at }) => {
    const c = window.__court;
    let f = (await c.until("handoff", max)).at(-1);
    while (f.tF < at) f = await c.nextFrame();
    const d = window.__xrDevice;
    d.position.set(d.position.x, d.position.y + rise, d.position.z);
    const after = await c.frames(72);
    return { from: f, after: after.map(({ thumb, view, ...x }) => x) };
  }, { max: HZ * 30, rise: RISE_M, at: 0.4 });
  const done = c.after.findIndex((f) => f.tF >= BEATS.videoFades[1]);
  const rushS = done < 0 ? Infinity : (done + 1) / HZ;
  ctx.report.p10 = { fadeFrames, contiguous, rushS, riseAt: c.from.tF };
  ctx.check("P10: a head rise finishes the fade within 0.3 s", contiguous && Math.abs(fadeFrames - HZ) <= 1 && rushS <= RUSH_S,
    `unrushed fade ${fadeFrames} display frames (${HZ} +/- 1)${contiguous ? "" : " (the log has gaps)"}; a ${RISE_M * 100} cm rise at F + ${c.from.tF.toFixed(2)} s done ${rushS.toFixed(3)} s later`);
}
