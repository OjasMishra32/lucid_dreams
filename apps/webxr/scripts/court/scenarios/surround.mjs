// The arena round the footage (court.surround: the pan's far end, real; the imagined bowl): stills from the seat in
// the watch (at the pair, and turned away from the picture), at F after the hand-off, at three walk stops, straight
// behind (toward the near end) and up at the roof, each with the surround shown and switched off (world.surround,
// the same frame: the look as a bundle without one), measuring the black share (luma under BLACK). Checks:
//   the black share drops a lot where the surround is (at most half, or under 5%);
//   inside the picture nothing changes (the plate owns those pixels): the watch and the open world, surround on vs
//   off, identical well inside the frame (P8's hand-off is the plate's, untouched);
//   the Reality check turns the imagined bowl blue (blue / red up at least 50% looking behind) while the far image
//   keeps its colour (within 3% on its filmed points outside F's frame).
// Driven on the setup page through window.__courtLook (as walkfloor), so every still is a static frame. Bundles
// without a surround SKIP. The PNGs (surround-<view>-on|off[-reality].png) are the before/after record.
// Owner: loop (the surround).
import { join } from "node:path";
import { readPng } from "../png.mjs";
import { HZ, blueRedAt, frameMargin, lookFrom, project, sitAtSeat, standingBoxes, walkStops } from "../look/view.mjs";

export const owner = "loop (surround)";
export const needs = ["world", "proxies", "video", "freeze"];

/** A pixel is black under this luma (0-255). */
const BLACK = 8;
/** The far image's filmed points: its alpha at least this, and this far outside F's frame (past the plate's feather). */
const FILMED_ALPHA = 0.95;
const OUTSIDE_F = -0.04;

const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

/** Share of a saved frame's pixels under BLACK, and its mean blue / red. */
function measure(ctx, name) {
  const img = readPng(join(ctx.out, `${name}.png`));
  let black = 0;
  let red = 0;
  let blue = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * img.channels;
    if (luma(img.data, o) < BLACK) black++;
    red += img.data[o];
    blue += img.data[o + 2];
  }
  return { black: black / n, blueRed: blue / Math.max(1, red) };
}

/** Largest per-channel difference between two saved frames at the given screen points (r-pixel windows). */
function maxDiffAt(ctx, a, b, view, points, r = 2) {
  const A = readPng(join(ctx.out, `${a}.png`));
  const B = readPng(join(ctx.out, `${b}.png`));
  let worst = 0;
  let n = 0;
  for (const p of points) {
    const px = project(view, p);
    if (!px) continue;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const X = Math.round(px[0]) + dx;
        const Y = Math.round(px[1]) + dy;
        if (X < 0 || Y < 0 || X >= A.width || Y >= A.height) continue;
        const o = (Y * A.width + X) * A.channels;
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(A.data[o + c] - B.data[o + c]));
        n++;
      }
  }
  return { worst, n };
}

/** Points on the stands planes and the floor well inside show frame k's picture (past its feather), on screen in `view`. */
function insidePicture(ctx, k, view, margin = 0.14) {
  const out = [];
  const [vx, vy, vw, vh] = view.viewport;
  const surfaces = ctx.court.freeze.stands.proxy.map((p) => p.points);
  for (const q of surfaces)
    for (let a = 0.02; a < 1; a += 0.04)
      for (let b = 0.02; b < 1; b += 0.04) {
        const p = [0, 1, 2].map((i) => q[0][i] + (q[1][i] - q[0][i]) * a + (q[3][i] - q[0][i]) * b);
        if (frameMargin(ctx, k, p) < margin) continue;
        const s = project(view, p);
        if (s && s[0] > vx + 4 && s[1] > vy + 4 && s[0] < vx + vw - 4 && s[1] < vy + vh - 4) out.push(p);
      }
  return out;
}

export default async function surround(ctx) {
  if (ctx.timing) ctx.skip("capture only");
  if (!ctx.court.surround) ctx.skip("no surround in this bundle (court.surround)");
  const first = await ctx.nextFrame();
  if (!first.setup) ctx.skip("needs the setup page (before Seat here), where nothing else drives the light");
  const F = ctx.court.video.segments.eases[0]?.frames[1];
  const pass2 = ctx.court.video.segments.pass2;
  // a watch frame well before F (the camera panned away from F's framing a little)
  const W = Math.round(pass2[0] + (pass2[1] - pass2[0]) * 0.35);

  /** The look on the setup page: show frame `f` on the textures, the light and the layers as the beat has them. */
  const look = (state) =>
    ctx.page.evaluate(
      async ([s, hz]) => {
        const L = window.__courtLook;
        L.world.light.set(s.beat, s.t);
        L.freeze.reveal(s.reveal);
        L.world.open(s.open);
        L.video.mask(s.mask);
        for (let i = 0; i < 5 * hz && L.video.stats.onScreen !== s.frame; i++) {
          L.video.show(s.frame);
          L.proxies.project(s.frame);
          L.world.frame(s.frame);
          await window.__court.nextFrame();
        }
        L.video.opacity = s.opacity;
        return L.video.stats.onScreen;
      },
      [state, HZ],
    );
  const surroundOn = (on) => ctx.page.evaluate((x) => window.__courtLook.world.surround(x), on);
  /** The view saved with the surround on and off (the same static frame). */
  const pair = async (name) => {
    await surroundOn(true);
    await ctx.frames(2);
    const on = await ctx.save(`surround-${name}-on`);
    await surroundOn(false);
    await ctx.frames(2);
    await ctx.save(`surround-${name}-off`);
    await surroundOn(true);
    return on;
  };

  const court = ctx.court;
  const [px, , pz] = court.seat.pairCentre;
  const views = {};

  // the watch: the picture opaque, the cinema mask down, from the seat at the pair and turned 70 deg away
  const shown = await look({ beat: "watch", t: 0, reveal: 0, open: 0, mask: 0, opacity: 1, frame: W });
  await sitAtSeat(ctx);
  await ctx.frames(3);
  views.watch = await pair("watch");
  const seatEye = views.watch.view.centre;
  const turn = (deg, up = 0) => {
    const a = Math.atan2(pz - seatEye[2], px - seatEye[0]) + (deg * Math.PI) / 180;
    return [seatEye[0] + 10 * Math.cos(a), seatEye[1] + 10 * Math.tan((up * Math.PI) / 180), seatEye[2] + 10 * Math.sin(a)];
  };
  await lookFrom(ctx, seatEye, turn(70));
  views["watch-side"] = await pair("watch-side");

  // F after the hand-off: the light landed, the freeze up, the picture faded, the mask lifted
  await look({ beat: "handoff", t: 5, reveal: 1, open: 1, mask: 1, opacity: 0, frame: F });
  await sitAtSeat(ctx);
  await ctx.frames(3);
  views.open = await pair("open");
  await lookFrom(ctx, seatEye, turn(180));
  views.behind = await pair("behind");
  await lookFrom(ctx, seatEye, turn(20, 70));
  views.roof = await pair("roof");
  for (const s of walkStops(court).filter((s) => [3, 5, 7].includes(s.stop))) {
    await lookFrom(ctx, s.eye, s.target);
    await ctx.frames(3);
    views[`stop-${s.stop}`] = await pair(`stop-${s.stop}`);
  }

  // the Reality check: the open world from the seat, and behind
  await ctx.pressFrames("reality", 3);
  await sitAtSeat(ctx);
  await ctx.frames(3);
  await ctx.save("surround-open-on-reality");
  await lookFrom(ctx, seatEye, turn(180));
  await ctx.frames(2);
  await ctx.save("surround-behind-on-reality");
  await ctx.pressFrames("reality", 3);

  // the black share, on and off
  const report = {};
  for (const name of Object.keys(views)) {
    const on = measure(ctx, `surround-${name}-on`);
    const off = measure(ctx, `surround-${name}-off`);
    report[name] = { blackOn: Number(on.black.toFixed(4)), blackOff: Number(off.black.toFixed(4)) };
  }
  for (const [name, r] of Object.entries(report))
    ctx.check(`the black share drops where the surround is: ${name}`, r.blackOn <= Math.max(0.05, 0.5 * r.blackOff),
      `${(100 * r.blackOff).toFixed(1)}% black without the surround, ${(100 * r.blackOn).toFixed(1)}% with it (luma < ${BLACK})`);

  // inside the picture nothing changes: surround on vs off, well inside the frame on screen
  for (const [name, k] of [["watch", shown], ["open", F]]) {
    const pts = insidePicture(ctx, k, views[name].view);
    const d = maxDiffAt(ctx, `surround-${name}-on`, `surround-${name}-off`, views[name].view, pts);
    ctx.check(`inside the picture the surround changes nothing: ${name}`, pts.length >= 20 && d.worst <= 1,
      `${pts.length} points well inside show frame ${k} (${d.n} pixels), largest difference ${d.worst} grey levels`);
    report[name].insideWorst = d.worst;
  }

  // the Reality check: the far image's filmed points outside F's frame keep their colour; the bowl behind turns blue
  const far = court.surround.far;
  const farPts = [];
  if (far) {
    const alpha = await ctx.page.evaluate(async (path) => {
      const img = new Image();
      img.src = window.__courtLook.world.bundle.file(path);
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const g = cv.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const out = new Uint8Array(cv.width * cv.height);
      for (let i = 0; i < out.length; i++) out[i] = d[4 * i];
      return { w: cv.width, h: cv.height, data: Array.from(out) };
    }, far.alpha);
    const fr = ctx.showFrames[far.frame];
    const farView = { q: fr.q, centre: court.camera.centre, viewport: [0, 0, far.width, far.height], cx: far.cx + 0.5, cy: far.cy + 0.5, fx: far.f, fy: far.f };
    const view = views.open.view;
    const [vx, vy, vw, vh] = view.viewport;
    const boxes = standingBoxes(ctx, view); // the players, the ball and the hoop (tinted by the check: imagined)
    for (const q of court.freeze.stands.proxy.map((p) => p.points))
      for (let a = 0.01; a < 1; a += 0.02)
        for (let b = 0.01; b < 1; b += 0.02) {
          const p = [0, 1, 2].map((i) => q[0][i] + (q[1][i] - q[0][i]) * a + (q[3][i] - q[0][i]) * b);
          if (frameMargin(ctx, F, p) > OUTSIDE_F) continue;
          const u = project(farView, p);
          if (!u) continue;
          // well inside the filmed region: clear of the image's faded edges and of any unfilmed pixel within 2% of it
          const [nu, nv] = [u[0] / far.width, u[1] / far.height];
          if (Math.min(nu, 1 - nu, nv, 1 - nv) < 0.05) continue;
          const filmed = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => {
            const X = Math.floor((nu + 0.02 * dx) * alpha.w);
            const Y = Math.floor((nv + 0.02 * dy) * alpha.h);
            return alpha.data[Y * alpha.w + X] >= 255 * FILMED_ALPHA;
          });
          if (!filmed) continue;
          const s = project(view, p);
          if (!s || s[0] <= vx + 4 || s[1] <= vy + 4 || s[0] >= vx + vw - 4 || s[1] >= vy + vh - 4) continue;
          if (!boxes.some(([x0, y0, x1, y1]) => s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1)) farPts.push(p);
        }
  }
  if (farPts.length >= 12) {
    const keep = blueRedAt(ctx, "surround-open-on-reality", views.open.view, farPts) / blueRedAt(ctx, "surround-open-on", views.open.view, farPts);
    ctx.check("the Reality check leaves the far image's colour (real footage)", Math.abs(keep - 1) <= 0.03, `${farPts.length} filmed points outside F's frame, blue / red x${keep.toFixed(3)}`);
    report.realityFar = keep;
  } else ctx.check("the Reality check leaves the far image's colour (real footage)", !far, far ? `only ${farPts.length} filmed points of the far image in view` : "no far image in this bundle");
  const behind = measure(ctx, "surround-behind-on-reality").blueRed / measure(ctx, "surround-behind-on").blueRed;
  ctx.check("the Reality check turns the imagined bowl blue (looking behind)", behind >= 1.5, `blue / red x${behind.toFixed(2)} over the whole view`);
  report.realityBehind = behind;
  // what the far image measured (proxies.ts measureTone): its tone to the plate
  report.tone = await ctx.page.evaluate(() => Promise.race([window.__courtLook.proxies.measured, new Promise((done) => setTimeout(() => done("not measured in 10 s"), 10000))]));
  ctx.report.surround = report;
}
