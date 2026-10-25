// Stream D's checks in a real browser (headless system Chrome, Metal, WebCodecs), on the stand-in bundle:
//   node apps/webxr/scripts/court/d-check.mjs [--only cadence,handoff,layers] [--bundle <url>] [--out <dir>]
// cadence (P4, P5): the show player at wall-clock 72 Hz through a press, the freeze and the resume: every display
//   frame shows the clock's frame, nothing held or skipped, queue 1-4, no seek, the primed decoder takes each jump.
// handoff (P8, P44): mono renders from the dolly seat at 19.5 px/deg: the video layer on F vs the 3D under it (the
//   freeze splats over F's plate), at the seat and 2/5/10 cm sideways and 25 cm up; then the hand-off stepped at 72 Hz.
// layers (P43): the layered watch from the seat vs the stand-in's own ray-traced truth from the same eye: no person
//   left on the plates (a double) and every person on a card (none torn or missing).
// One PASS/FAIL line per bar; reports and PNGs in scripts/court/out/d-check/; exit 0 only when every bar passes.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alignment, psnr, toLuma } from "./diff.mjs";
import { encodePng } from "./png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBXR = resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const OUT = resolve(opt("--out", join(HERE, "out", "d-check")));
const BUNDLE = opt("--bundle", "/scripts/court/out/standin/");
const ONLY = opt("--only", "cadence,handoff,layers").split(",");

function findPlaywright() {
  const require = createRequire(join(WEBXR, "package.json"));
  const tries = [];
  if (process.env.PLAYWRIGHT_CORE) tries.push(process.env.PLAYWRIGHT_CORE);
  try {
    tries.push(dirname(require.resolve("playwright-core/package.json")));
  } catch {
    // not a dependency: the npx cache
  }
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx))
    readdirSync(npx)
      .map((d) => join(npx, d, "node_modules", "playwright-core"))
      .filter((d) => existsSync(join(d, "package.json")))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .forEach((d) => tries.push(d));
  for (const dir of tries) {
    try {
      return require(dir);
    } catch {
      // next
    }
  }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE (nothing is downloaded)");
}

async function startVite() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 5900 + Math.floor(Math.random() * 600);
    const server = spawn(process.execPath, [join(WEBXR, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
      cwd: WEBXR,
      env: { ...process.env, LUCID_HTTP: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    server.stdout.on("data", (d) => (log += d));
    server.stderr.on("data", (d) => (log += d));
    const until = Date.now() + 30000;
    while (Date.now() < until && server.exitCode === null) {
      if (log.includes(`127.0.0.1:${port}`)) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { server, port };
        } catch {
          // not yet
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    server.kill();
  }
  throw new Error("vite did not start");
}

let failed = 0;
const report = {};
const check = (scenario, what, ok, detail) => {
  (report[scenario] ??= { checks: [] }).checks.push({ what, ok: !!ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${scenario}: ${what}: ${detail}`);
};
const img = (b64, w, h) => ({ width: w, height: h, channels: 4, data: new Uint8Array(Buffer.from(b64, "base64")) });
const save = (name, im) => writeFileSync(join(OUT, `${name}.png`), encodePng(im));

/** Connected components of a boolean mask (8-neighbour): each one's pixel count and bounding-box diagonal in pixels. */
function blobs(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let n = 0;
    let [x0, y0, x1, y1] = [w, h, 0, 0];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const k = stack.pop();
      n++;
      const x = k % w;
      const y = (k - x) / w;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const kk = yy * w + xx;
          if (mask[kk] && !seen[kk]) {
            seen[kk] = 1;
            stack.push(kk);
          }
        }
    }
    out.push({ n, diag: Math.hypot(x1 - x0 + 1, y1 - y0 + 1) });
  }
  return out;
}

/** Grow a mask by r pixels (square). */
function dilate(mask, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = mask[y * w + k];
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = tmp[k * w + x];
      out[y * w + x] = v;
    }
  return out;
}

const SCENARIOS = {
  async cadence(page) {
    for (const between of [false, true]) {
      const name = between ? "press between ease starts" : "press in pass 1";
      const r = await page.evaluate(([b, bt]) => window.__d.cadence({ bundle: b, between: bt, freezeS: 1 }), [BUNDLE, between]);
      (report.cadence ??= { checks: [] })[name] = r;
      check("cadence", `${name}: one show frame per display frame (P4)`, r.wrong === 0 && r.held === 0 && r.skipped === 0,
        `${r.displayFrames} display frames, ${r.shown} shown, ${r.held} held${r.held ? ` at ${r.heldAt}` : ""}, ${r.skipped} skipped, ${r.wrong} off the clock`);
      check("cadence", `${name}: queue 1-4, never a seek at a press (P5)`, r.queueMax <= 4 && r.queueMin >= 1 && r.resets === 0 && r.switches >= 2,
        `queue ${r.queueMin}-${r.queueMax}, ${r.resets} seeks, ${r.switches} primed switches; decode p50 ${r.decodeMs.p50} p99 ${r.decodeMs.p99} ms, upload p99 ${r.uploadMs.p99} ms (desktop; the Quest bar is 3 ms)`);
      check("cadence", `${name}: no errors`, r.errors.length === 0, r.errors.length ? r.errors.slice(0, 3).join(" | ") : "none");
    }
  },

  async handoff(page) {
    const standin = await import("./standin.mjs");
    const offsets = [[0, 0], [0.02, 0], [0.05, 0], [0.1, 0], [0, 0.25]];
    const r = await page.evaluate(([b, o]) => window.__d.seat({ bundle: b, offsets: o, sequence: true }), [BUNDLE, offsets]);
    const { width: w, height: h } = r;
    const rows = {};
    for (const [key, v] of Object.entries(r.views)) {
      const ppd = key === "F" ? r.ppdF : r.ppd;
      const a = img(v.video, w, h);
      const b = img(v.d3, w, h);
      const tag = key.replace(/[^0-9.F-]/g, "_");
      save(`handoff-${tag}-video`, a);
      save(`handoff-${tag}-3d`, b);
      if (v.watch) save(`handoff-${tag}-watch`, img(v.watch, w, h)); // the picture with the cinema mask's dark, by eye
      const alphaMask = (b64) => {
        const d = img(b64, w, h).data;
        return new Uint8Array(w * h).map((_, i) => (d[4 * i + 3] > 128 ? 1 : 0));
      };
      const cards = alphaMask(v.mask);
      const pair = alphaMask(v.pair);
      const splat = alphaMask(v.splat);
      // the ball is stream E's 3D and the others' 3D too: both left out here (a disc round the ball, the other cards)
      const [bx, by, br] = v.ball;
      const nearBall = (i) => Math.hypot((i % w) - bx, Math.floor(i / w) - by) < br * 1.8 + 3;
      const others = dilate(cards.map((c, i) => c & (1 - pair[i])), w, h, 6);
      const keepPair = new Uint8Array(w * h).map((_, i) => (pair[i] && !nearBall(i) ? 1 : 0));
      const away = dilate(cards, w, h, 8);
      const elsewhere = new Uint8Array(w * h).map((_, i) => (away[i] || nearBall(i) ? 0 : 1));
      const row = { pairPixels: keepPair.reduce((x, y) => x + y, 0) };
      // players: silhouette edges (the cards' mattes vs the splats' coverage), both ways, in degrees; and the cards vs
      // the stand-in's own ray-traced bodies from the same eye (the geometry alone, without the splats' soft edges)
      row.silhouette = chamfer(pair, splat, w, h, (i) => !nearBall(i) && !others[i], ppd);
      const z = r.zoom[key];
      if (z) {
        // zoomed: the cards' edges vs the stand-in's ray-traced bodies from the same eye, and vs the splats
        const [zw, zh] = r.zoomSize;
        const zMask = (b64) => {
          const d = img(b64, zw, zh).data;
          return new Uint8Array(zw * zh).map((_, i) => (d[4 * i + 3] > 128 ? 1 : 0));
        };
        const tcam = { centre: z.eye, q: mulQ(z.q, [1, 0, 0, 0]), f: z.focal, cx: zw / 2 - 0.5, cy: zh / 2 - 0.5, width: zw, height: zh };
        const truth = standin.render(tcam, 0);
        const truthPair = new Uint8Array(zw * zh).map((_, i) => (truth.kind[i] === 10 || truth.kind[i] === 11 || truth.kind[i] === 6 ? 1 : 0));
        const zPair = zMask(z.pair);
        const zSplat = zMask(z.splat);
        const [zx, zy, zr] = z.ball;
        const keepZ = (i) => Math.hypot((i % zw) - zx, Math.floor(i / zw) - zy) >= zr * 1.8 + 6;
        // one-sided (how far each card edge lies outside the ray-traced bodies): where the seat sees a body part camera F
        // never saw (a side, a foot behind the other player's leg), the truth reaches past the footage; the splats fill it
        const zppd = (z.focal * Math.PI) / 180;
        row.zoomPpd = zppd;
        row.truthSilhouette = chamfer(zPair, truthPair, zw, zh, keepZ, zppd, true);
        row.truthSilhouetteBothWays = chamfer(zPair, truthPair, zw, zh, keepZ, zppd);
        if (key === "0,0" || key === "F")
          save(`handoff-zoom-silhouettes-${key === "F" ? "F" : "seat"}`, { width: zw, height: zh, channels: 4, data: new Uint8Array(zw * zh * 4).map((_, j) => (j % 4 === 3 ? 255 : j % 4 === 0 ? zPair[j >> 2] * 255 : j % 4 === 1 ? truthPair[j >> 2] * 255 : zSplat[j >> 2] * 120)) });
        row.zoomSilhouette = chamfer(zPair, zSplat, zw, zh, keepZ, zppd);
      }
      row.psnrPlayers = psnr(a, b, keepPair);
      row.psnrElsewhere = psnr(a, b, elsewhere);
      try {
        // whole tiles only: alignment() takes a tile half in its mask, and a tile's shift is found on all its pixels,
        // so one with a player in it measures the player (video card vs splats), not the background
        const T = 64;
        const tiles = Uint8Array.from(elsewhere);
        for (let y0 = 0; y0 + T <= h; y0 += T)
          for (let x0 = 0; x0 + T <= w; x0 += T) {
            let all = true;
            for (let y = y0; y < y0 + T && all; y++) for (let x = x0; x < x0 + T; x++) if (!elsewhere[y * w + x]) { all = false; break; }
            if (!all) for (let y = y0; y < y0 + T; y++) tiles.fill(0, y * w + x0, y * w + x0 + T);
          }
        row.alignBackground = alignment(a, b, { pxPerDeg: ppd, mask: tiles, tile: T });
      } catch (e) {
        row.alignBackground = { error: String(e.message) };
      }
      const la = toLuma(a);
      const lb = toLuma(b);
      let mad = 0;
      let n = 0;
      for (let i = 0; i < w * h; i++) {
        if (nearBall(i) || others[i]) continue;
        mad += Math.abs(la[i] - lb[i]);
        n++;
      }
      row.mad = mad / n;
      rows[key] = row;
      const sil = row.silhouette;
      if (key === "F") {
        const ft = row.truthSilhouette;
        check("handoff", "at camera F's own pose: the cards' edges vs the ray-traced bodies (no parallax: the matte and its mapping alone)", ft.p95Deg <= 0.05,
          `outside p95 ${ft.p95Deg.toFixed(4)} deg, median ${ft.medianDeg.toFixed(4)} (at ${row.zoomPpd.toFixed(0)} px/deg)`);
        check("handoff", "at camera F's own pose: players' silhouettes line up (P8)", sil.p95Deg <= 0.05,
          `edge p95 ${sil.p95Deg.toFixed(4)} deg, median ${sil.medianDeg.toFixed(4)} (${sil.edges} edge px at ${ppd.toFixed(0)} px/deg); PSNR players ${row.psnrPlayers.toFixed(2)} dB (the stand-in's splats vs its ray tracer), elsewhere ${row.psnrElsewhere === Infinity ? "inf" : row.psnrElsewhere.toFixed(2)} dB`);
        continue;
      }
      const seat = key === "0,0";
      const bar = seat ? 0.05 : 0.055;
      const ts = row.truthSilhouette;
      const zs = row.zoomSilhouette;
      check("handoff", `${seat ? "at the seat" : `eye offset ${key} m`}: the video layer's players sit on the bodies' true depth (P8 <= ${bar} deg p95)`, ts.p95Deg <= bar,
        `card edges outside the ray-traced bodies p95 ${ts.p95Deg.toFixed(4)} deg, median ${ts.medianDeg.toFixed(4)} (at ${row.zoomPpd.toFixed(0)} px/deg; both ways, disocclusions included, p95 ${row.truthSilhouetteBothWays.p95Deg.toFixed(4)}); vs the splats p95 ${zs.p95Deg.toFixed(4)} deg (the stand-in splats' soft edges)`);
      if (seat) {
        const bg = row.alignBackground;
        check("handoff", "at the seat: the background lines up and matches (P8 <= 0.05 deg p95, >= 32 dB)", bg.p95Deg !== undefined && bg.p95Deg <= 0.05 && row.psnrElsewhere >= 32,
          `${bg.p95Deg !== undefined ? `p95 ${bg.p95Deg.toFixed(4)} deg over ${bg.tiles} tiles` : bg.error}; PSNR ${row.psnrElsewhere === Infinity ? "inf" : row.psnrElsewhere.toFixed(2)} dB`);
        check("handoff", "at the seat: players' PSNR (P8 >= 30 dB; informational on the stand-in: its splats vs its ray tracer)", true, `${row.psnrPlayers.toFixed(2)} dB`);
        check("handoff", "video layer vs the 3D under it: MAD <= 1 grey level (P44; ball and extras are stream E's 3D, left out)", row.mad <= 1, `MAD ${row.mad.toFixed(3)}`);
      }
    }
    const seq = r.sequence;
    const meanSteps = seq.slice(1).map((s, i) => Math.abs(s.meanLuma - seq[i].meanLuma));
    const worstMean = Math.max(...meanSteps);
    const worst99 = Math.max(...seq.map((s) => s.p99Step));
    const worst999 = Math.max(...seq.map((s) => s.p999Step));
    const worstMax = Math.max(...seq.map((s) => s.maxStep));
    // per pixel, the fade can only move a pixel by its video-vs-3D difference x smootherstep's steepest 1.875/72: the
    // players' differences (their splats vs the footage) set the tail, not the light
    check("handoff", "through the hand-off at 72 Hz: <= 1 grey level of luma change per display frame (P44: mean luma, and per pixel at p99)", worstMean <= 1 && worst99 <= 1,
      `mean-luma step max ${worstMean.toFixed(3)}; per pixel p99 max ${worst99.toFixed(2)}, p99.9 max ${worst999.toFixed(2)}, max ${worstMax.toFixed(1)} (${seq.length} frames, ball and extras left out)`);
    Object.assign((report.handoff ??= { checks: [] }), { eye: r.eye, rows, sequence: seq, cards: r.cards });
  },

  async layers(page) {
    const standin = await import("./standin.mjs");
    const dir = join(WEBXR, BUNDLE);
    const court = JSON.parse(readFileSync(join(dir, "court.json"), "utf8"));
    const frames = JSON.parse(readFileSync(join(dir, court.video.frames), "utf8"));
    const seg = court.video.segments;
    // pass 2 frames spread from its start to the first ease start: the pair, the third person and the gap between
    const pick = [0, 0.3, 0.6, 1].map((k) => Math.round(seg.pass2[0] + 12 + k * (seg.eases[0].start - seg.pass2[0] - 12)));
    const r = await page.evaluate(([b, f]) => window.__d.layers({ bundle: b, frames: f }), [BUNDLE, pick]);
    const { width: w, height: h, ppd } = r;
    // three's camera looks down -Z with +Y up; the stand-in's renderer takes OpenCV axes (+y down, +z forward): turn it
    // half a turn about its own x
    const cam = { centre: r.eye, q: mulQ(r.q, [1, 0, 0, 0]), f: r.focal, cx: w / 2 - 0.5, cy: h / 2 - 0.5, width: w, height: h };
    const rows = [];
    for (const [k, frame] of pick.entries()) {
      const v = r.views[frame];
      const tau = (r.src[k] - court.video.freezeSource) / (court.camera.sourceFps * court.camera.slow);
      const truth = standin.render(cam, tau);
      const video = img(v.video, w, h);
      const plates = img(v.plates, w, h);
      const cards = img(v.cards, w, h);
      const rgba = (rgb) => ({ width: w, height: h, channels: 3, data: rgb });
      save(`layers-${frame}-video`, video);
      save(`layers-${frame}-truth`, rgba(truth.rgb));
      save(`layers-${frame}-plates`, plates);
      // the frame's own camera: where each seat pixel's plate surface lands in it ("inside the frame", and which source
      // pixel it shows). A double is a plate pixel showing a person: where camera k saw a person at that source pixel,
      // the plates pass must look like the clean truth there, not like the person.
      const camK = { centre: court.camera.centre, q: frames[frame].q, f: frames[frame].f, cx: court.camera.cx, cy: court.camera.cy };
      const { inside, src } = insideMask(court, camK, cam, w, h);
      const RW = 1536;
      const RH = 864;
      const s = RW / court.camera.width;
      const kcam = { centre: camK.centre, q: camK.q, f: camK.f * s, cx: (camK.cx + 0.5) * s - 0.5, cy: (camK.cy + 0.5) * s - 0.5, width: RW, height: RH };
      const kLive = standin.render(kcam, tau);
      const kPlate = standin.render(kcam, tau, { people: false });
      const leak = new Uint8Array(w * h);
      let risk = 0;
      for (let i = 0; i < w * h; i++) {
        if (!inside[i]) continue;
        const ku = Math.round((src[2 * i] + 0.5) * s - 0.5);
        const kv = Math.round((src[2 * i + 1] + 0.5) * s - 0.5);
        if (ku < 0 || kv < 0 || ku >= RW || kv >= RH || kLive.kind[kv * RW + ku] < 10) continue;
        risk++;
        // resampling moves thin floor lines by a pixel or two: the clean plate's nearest match within 2 source pixels
        const diff = (rgb, k) => Math.abs(plates.data[4 * i] - rgb[3 * k]) + Math.abs(plates.data[4 * i + 1] - rgb[3 * k + 1]) + Math.abs(plates.data[4 * i + 2] - rgb[3 * k + 2]);
        let dp = Infinity;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const x = Math.min(RW - 1, Math.max(0, ku + dx));
            const y = Math.min(RH - 1, Math.max(0, kv + dy));
            dp = Math.min(dp, diff(kPlate.rgb, y * RW + x));
          }
        const dl = diff(kLive.rgb, kv * RW + ku);
        if (dp > 60 && dl < 40) leak[i] = 1;
      }
      save(`layers-${frame}-leaks`, { width: w, height: h, channels: 4, data: new Uint8Array(w * h * 4).map((_, j) => (j % 4 === 3 ? 255 : j % 4 === 0 && leak[j >> 2] ? 255 : plates.data[j] >> 1)) });
      // a double is a solid patch; resampling at high-contrast edges (the paint's edge, the front row's cut-out) leaves
      // lines one or two pixels thin: erode by one pixel first (a 3 x 3 core is 0.15 deg)
      const core = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          let all = 1;
          for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1 && all; dx++) all = leak[(y + dy) * w + x + dx];
          core[y * w + x] = all;
        }
      const leaks = blobs(dilate(core, w, h, 1), w, h);
      const worstLeakDeg = Math.max(0, ...leaks.map((b) => b.diag / ppd));
      // every person the truth shows inside the frame lies on a card (within the cards' accepted limb error, 0.6 deg)
      const covered = dilate(new Uint8Array(w * h).map((_, i) => (cards.data[4 * i + 3] > 128 ? 1 : 0)), w, h, Math.round(0.6 * ppd));
      const people = {};
      for (let i = 0; i < w * h; i++) {
        const kd = truth.kind[i];
        if (kd < 10 || !inside[i]) continue;
        const p = (people[kd - 10] ??= { pixels: 0, covered: 0 });
        p.pixels++;
        if (covered[i]) p.covered++;
      }
      const missing = Object.entries(people).filter(([, p]) => p.pixels > 50 && p.covered / p.pixels < 0.95);
      rows.push({ frame, tau: Number(tau.toFixed(3)), worstLeakDeg, leakBlobs: leaks.length, riskPixels: risk, people });
      check("layers", `frame ${frame}: no person left on the plates (a double) > 0.1 deg (P43)`, worstLeakDeg <= 0.1 && risk > 0,
        `${risk} plate pixels behind people checked, ${leaks.length} person blobs, worst ${worstLeakDeg.toFixed(3)} deg`);
      check("layers", `frame ${frame}: every person on a card, none torn (P43)`, missing.length === 0 && Object.keys(people).length > 0,
        Object.entries(people).map(([id, p]) => `person ${id} ${((100 * p.covered) / p.pixels).toFixed(1)}% on a card`).join(", ") || "no people in the frame");
    }
    Object.assign((report.layers ??= { checks: [] }), { rows });
  },
};

/**
 * Silhouette alignment: the boundary pixels of masks A and B (where `keep` allows), each one's distance to the other's
 * nearest boundary pixel (a 3-4 chamfer distance transform), both ways: median and p95 in degrees.
 */
function chamfer(A, B, w, h, keep, ppd, oneSided = false) {
  const edge = (M) => {
    const e = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (M[i] && (!M[i - 1] || !M[i + 1] || !M[i - w] || !M[i + w])) e[i] = 1;
      }
    return e;
  };
  const dt = (E) => {
    const d = new Float32Array(w * h).fill(1e9);
    for (let i = 0; i < w * h; i++) if (E[i]) d[i] = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 3);
        if (y > 0) {
          d[i] = Math.min(d[i], d[i - w] + 3);
          if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + 4);
          if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + 4);
        }
      }
    for (let y = h - 1; y >= 0; y--)
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 3);
        if (y < h - 1) {
          d[i] = Math.min(d[i], d[i + w] + 3);
          if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + 4);
          if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + 4);
        }
      }
    return d;
  };
  const ea = edge(A);
  const eb = edge(B);
  // one-sided: how far each of A's edge pixels lies outside B (0 inside it: from the seat a body shows sides camera F
  // never saw, so the footage's edge may sit inside the body's, never outside it)
  const da = dt(ea);
  const db = oneSided ? dt(B) : dt(eb);
  const dist = [];
  for (let i = 0; i < w * h; i++) {
    if (!keep(i)) continue;
    if (ea[i]) dist.push(db[i] / 3);
    if (eb[i] && !oneSided) dist.push(da[i] / 3);
  }
  if (!dist.length) return { edges: 0, medianDeg: Infinity, p95Deg: Infinity };
  dist.sort((x, y) => x - y);
  const at = (p) => dist[Math.min(dist.length - 1, Math.ceil(dist.length * p) - 1)];
  return { edges: dist.length, medianDeg: at(0.5) / ppd, p95Deg: at(0.95) / ppd };
}

/** Hamilton product a * b. */
function mulQ(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** For each seat pixel: true when the proxy surface it sees (floor, stands planes, cards, backboard) lies well inside camera k's frame. */
function insideMask(court, camK, cam, w, h) {
  const rot = (q, v) => {
    const [x, y, z, ww] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + ww * tx + (y * tz - z * ty), v[1] + ww * ty + (z * tx - x * tz), v[2] + ww * tz + (x * ty - y * tx)];
  };
  // the depth cards (front row) are cut out by their PNG's alpha, which this ray cast doesn't read: a seat pixel that
  // lands on one is left out (its surface could be the card or the stands behind)
  const cardQuads = court.freeze.stands.cards.map((c) => c.quad);
  const quads = [...court.freeze.stands.proxy.map((p) => p.points), ...cardQuads, ...(court.court.backboard ? [court.court.backboard] : [])];
  const planes = quads.map((pts) => {
    const e1 = pts[1].map((v, i) => v - pts[0][i]);
    const e2 = pts[3].map((v, i) => v - pts[0][i]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    return { p0: pts[0], e1, e2, n, card: cardQuads.includes(pts) };
  });
  const inv = [-camK.q[0], -camK.q[1], -camK.q[2], camK.q[3]];
  const out = new Uint8Array(w * h);
  const src = new Float32Array(w * h * 2).fill(-1);
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const d = rot(cam.q, [(u - cam.cx) / cam.f, (v - cam.cy) / cam.f, 1]);
      let best = d[1] < 0 ? -cam.centre[1] / d[1] : Infinity;
      let onCard = false;
      for (const pl of planes) {
        const den = pl.n[0] * d[0] + pl.n[1] * d[1] + pl.n[2] * d[2];
        if (Math.abs(den) < 1e-9) continue;
        const t = (pl.n[0] * (pl.p0[0] - cam.centre[0]) + pl.n[1] * (pl.p0[1] - cam.centre[1]) + pl.n[2] * (pl.p0[2] - cam.centre[2])) / den;
        if (t <= 0 || t >= best) continue;
        const p = [cam.centre[0] + t * d[0] - pl.p0[0], cam.centre[1] + t * d[1] - pl.p0[1], cam.centre[2] + t * d[2] - pl.p0[2]];
        const a = (p[0] * pl.e1[0] + p[1] * pl.e1[1] + p[2] * pl.e1[2]) / (pl.e1[0] ** 2 + pl.e1[1] ** 2 + pl.e1[2] ** 2);
        const b = (p[0] * pl.e2[0] + p[1] * pl.e2[1] + p[2] * pl.e2[2]) / (pl.e2[0] ** 2 + pl.e2[1] ** 2 + pl.e2[2] ** 2);
        if (a >= 0 && a <= 1 && b >= 0 && b <= 1) {
          best = t;
          onCard = pl.card;
        }
      }
      if (best === Infinity || onCard) continue;
      const P = [cam.centre[0] + best * d[0], cam.centre[1] + best * d[1], cam.centre[2] + best * d[2]];
      const c = rot(inv, [P[0] - camK.centre[0], P[1] - camK.centre[1], P[2] - camK.centre[2]]);
      if (c[2] <= 0) continue;
      const su = camK.cx + (camK.f * c[0]) / c[2];
      const sv = camK.cy + (camK.f * c[1]) / c[2];
      const x = (su + 0.5) / court.camera.width;
      const y = (sv + 0.5) / court.camera.height;
      src[2 * (v * w + u)] = su;
      src[2 * (v * w + u) + 1] = sv;
      if (Math.min(x, y, 1 - x, 1 - y) > 0.12) out[v * w + u] = 1;
    }
  return { inside: out, src };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = findPlaywright();
  const { server, port } = await startVite();
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-gpu-blocklist", "--use-angle=metal", "--enable-gpu"] });
    for (const name of ONLY) {
      if (!SCENARIOS[name]) throw new Error(`no scenario "${name}" (have: ${Object.keys(SCENARIOS).join(", ")})`);
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [];
      page.on("console", (m) => {
        if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 300));
      });
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
      try {
        await page.goto(`http://127.0.0.1:${port}/scripts/court/d-check.html`, { waitUntil: "load" });
        await page.waitForFunction(() => window.__d?.ready, null, { timeout: 60000 });
        await SCENARIOS[name](page);
      } catch (e) {
        check(name, "runs", false, String(e?.message ?? e).split("\n")[0]);
      }
      check(name, "console clean", errors.length === 0, errors.length ? errors.slice(0, 3).join(" | ") : "0 errors");
      await page.close();
    }
  } finally {
    await browser?.close();
    server.kill();
  }
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(failed ? `D-CHECK FAIL (${failed} bars; ${OUT})` : `D-CHECK OK (${OUT})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("D-CHECK RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
