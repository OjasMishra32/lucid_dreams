// Court Side desktop capture: the show from the desktop dev viewer (IWER's emulated Quest 3, one eye) to an MP4 at
// exactly 72 fps, one display frame of the show per video frame, never a screen recording (a recording at 120 Hz plays
// the show about 1.7x fast). It starts src/court/serve.mjs --dev as the e2e does, opens
// `?mode=court&emulate&probe=capture&bundle=/bundle/` in headless system Chrome, turns on the probe's lockstep
// (probe.ts: the frame loop runs only the frames asked for, each advancing the show by exactly 1/72 s, never by the
// wall clock), drives the head along the shot list's beats (desktop-capture-60s.md) with the buttons pressed through
// window.__court.press, reads every frame's pixels back in the page and pipes them raw to ffmpeg (libx264, crf 14,
// preset slow, 72 fps, BT.709).
//   node apps/webxr/scripts/court/capture/capture.mjs [--bundle <folder with court.json, outside the repo>]
//        [--out <file.mp4>] [--seconds <cap>] [--stamp] [--seat <m>] [--width 1280 --height 720] [--png <every n>]
//        [--retries 2] (a crashed page is captured again from the top: lockstep makes the runs identical)
// --stamp paints the display frame, the clock's show frame and the frame on the video texture into the bottom-left
// corner (probe.ts STAMP) and checks every frame of the encoded file against the frame log by those pixels (no OCR);
// without it the file is clean and the log checks still run. Writes <out>.frames.json (one line of log per video
// frame) beside the video. Exit 0 when every check passed, 1 otherwise.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBXR = resolve(HERE, "../../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STANDIN = resolve(HERE, "../out/standin");
const BUNDLE = resolve(opt("--bundle", STANDIN));
const IS_STANDIN = BUNDLE === STANDIN;
const OUT = resolve(opt("--out", join(homedir(), "court-side-data/demo-kit/capture/court-side-60s.mp4")));
const STAMP = args.includes("--stamp");
const CAP = opt("--seconds", null) === null ? Infinity : Math.round(Number(opt("--seconds")) * 72);
const WIDTH = Number(opt("--width", 1280));
const HEIGHT = Number(opt("--height", 720));
const PNG_EVERY = Number(opt("--png", 0));
const HZ = 72;
/** No show runs past this many grabbed frames (a stuck phase must fail, not record forever). */
const MAX_FRAMES = 150 * HZ;
/** The stamp's layout, as probe.ts STAMP paints it. */
const CELL = 12;
const BITS = 16;
const ROWS = 3;

const log = (m) => process.stderr.write(`[capture] ${m}\n`);

/** playwright-core as e2e.mjs finds it: apps/webxr's node_modules, $PLAYWRIGHT_CORE or the npx cache; never downloaded. */
function findPlaywright() {
  const require = createRequire(join(WEBXR, "package.json"));
  const tries = [];
  if (process.env.PLAYWRIGHT_CORE) tries.push(process.env.PLAYWRIGHT_CORE);
  try {
    tries.push(dirname(require.resolve("playwright-core/package.json")));
  } catch {
    // not a dependency of apps/webxr: look in the npx cache
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
      // try the next one
    }
  }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE=<dir of playwright-core> (nothing is downloaded)");
}

/** serve.mjs --dev on a free port, as e2e.mjs starts it. */
async function startServer() {
  const argv = [join(WEBXR, "src/court/serve.mjs"), "--dev", "--port", "0", "--bundle", BUNDLE];
  if (IS_STANDIN) argv.push("--standin");
  const server = spawn(process.execPath, argv, { cwd: WEBXR, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));
  const until = Date.now() + 60000;
  while (Date.now() < until && server.exitCode === null) {
    const port = /Court Side on http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)?.[1];
    if (port) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/bundle/court.json`)).ok) return { server, port: Number(port) };
      } catch {
        // not answering yet
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`serve.mjs --dev did not start:\n${out}`);
}

function pageUrl(port) {
  const q = new URLSearchParams({ mode: "court", emulate: "", probe: "capture", bundle: "/bundle/" });
  if (STAMP) q.set("stamp", "");
  if (opt("--seat", null) !== null) q.set("seat", opt("--seat"));
  return `http://127.0.0.1:${port}/?${q.toString().replace(/=(&|$)/g, "$1")}`;
}

// ---------------- head poses (room space: metres, +Y up; yaw about +Y, pitch about the head's X) ----------------
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map((v) => v * s);
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const len = (a) => Math.hypot(...a);
const smooth = (t) => t * t * (3 - 2 * t);

/** The look from `eye` at `target` as { yaw, pitch } (three's camera looks down -Z). */
function lookAt(eye, target) {
  const f = sub(target, eye);
  return { yaw: Math.atan2(-f[0], -f[2]), pitch: Math.asin(f[1] / len(f)) };
}
/** q = qY(yaw) * qX(pitch), [x, y, z, w]. */
function quat({ yaw, pitch }) {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpLook = (a, b, t) => ({ yaw: a.yaw + wrap(b.yaw - a.yaw) * t, pitch: a.pitch + (b.pitch - a.pitch) * t });

/** The capture's driver over one page: steps, the head, the buttons, the grabbed frames into ffmpeg. */
function director(page, encoder, court) {
  const frames = [];
  const head = { p: [0, 1.15, 0], look: { yaw: 0, pitch: 0 } };
  let grabbing = false;
  let pngs = 0;
  const d = {
    frames,
    head,
    /** Grab from now on. */
    roll() {
      grabbing = true;
    },
    done: () => frames.length >= Math.min(CAP, MAX_FRAMES),
    /** One frame with the head where it is now; grabbed into the video once rolling. */
    async step() {
      if (d.done()) return frames.at(-1);
      const f = await page.evaluate(
        ([grab, p, q, yaw]) => {
          const dev = window.__xrDevice;
          dev.position.set(p[0], p[1], p[2]);
          dev.quaternion.set(q[0], q[1], q[2], q[3]);
          // IWER's hands parked below and behind the head, out of the picture (the buttons go through the probe)
          const [bx, bz] = [Math.sin(yaw) * 0.4, Math.cos(yaw) * 0.4];
          dev.hands?.left?.position.set(p[0] + bx, p[1] - 0.9, p[2] + bz);
          dev.hands?.right?.position.set(p[0] + bx, p[1] - 0.9, p[2] + bz);
          return window.__court.step(grab);
        },
        [grabbing, head.p, quat(head.look), head.look.yaw],
      );
      if (!grabbing) return f;
      if (f.width !== WIDTH || f.height !== HEIGHT) throw new Error(`the page draws ${f.width}x${f.height}, the encoder takes ${WIDTH}x${HEIGHT} (--width/--height)`);
      const px = Buffer.from(f.pixels, "base64");
      if (!encoder.stdin.write(px)) await new Promise((r) => encoder.stdin.once("drain", r));
      if (PNG_EVERY && frames.length % PNG_EVERY === 0) pngs += writePng(px, f, frames.length) ? 1 : 0;
      const { pixels, thumb, view, ...rest } = f;
      frames.push(rest);
      if (frames.length % HZ === 0) {
        const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
        log(`${(frames.length / HZ).toFixed(0)} s: ${f.phase} ${f.segment} show frame ${f.frame}, page heap ${(heap / 1e6).toFixed(0)} MB`);
      }
      return f;
    },
    async hold(seconds) {
      for (let i = 0; i < Math.round(seconds * HZ) && !d.done(); i++) await d.step();
    },
    /** Steps until `test(frame log)` (at most `maxS` seconds; throws past it). */
    async until(test, maxS, what) {
      for (let i = 0; i < maxS * HZ; i++) {
        if (d.done()) return;
        const f = await d.step();
        if (test(f)) return f;
      }
      throw new Error(`no ${what} within ${maxS} s (phase ${frames.at(-1)?.phase})`);
    },
    /** The head from where it is to `to` (room), its look to `look`, eased, over `seconds`. */
    async move(to, look, seconds) {
      const [p0, l0] = [head.p, head.look];
      const n = Math.max(1, Math.round(seconds * HZ));
      for (let i = 1; i <= n && !d.done(); i++) {
        const t = smooth(i / n);
        head.p = lerp(p0, to, t);
        head.look = lerpLook(l0, look, t);
        await d.step();
      }
      head.p = to;
      head.look = look;
    },
    /** A button, through the probe (queued to the next frame, which acts on it). */
    press: (action) => page.evaluate((a) => window.__court.press(a), action),
    /** Court space -> room space through the world group as it stands now. */
    toRoom: (points) => page.evaluate((ps) => {
      const g = window.__courtLook.world.group.parent;
      g.updateWorldMatrix(true, false);
      const m = g.matrixWorld.elements;
      return ps.map((p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]);
    }, points),
    /** Room space -> court space (the inverse). */
    toCourt: (points) => page.evaluate((ps) => {
      const g = window.__courtLook.world.group.parent;
      g.updateWorldMatrix(true, false);
      const inv = g.matrixWorld.clone().invert();
      const m = inv.elements;
      return ps.map((p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]);
    }, points),
    pngs: () => pngs,
    court,
  };
  return d;
}

/** A grabbed frame as a PNG beside the video (--png n: every n-th, to look at the framing). */
function writePng(px, f, k) {
  const dir = OUT.replace(/\.mp4$/, "-frames");
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${f.width}x${f.height}`, "-i", "-", "-vf", "vflip", "-frames:v", "1", join(dir, `${String(k).padStart(5, "0")}-${f.phase}.png`)], { input: px });
  return r.status === 0;
}

const centre = (b) => b.min.map((v, i) => (v + b.max[i]) / 2);

/**
 * The shot list's beats (desktop-capture-60s.md), from the hand-over to the end of the make. The show times its own
 * beats (the arrival, the passes, the ease, the hand-off, the hand-back, the make); the head path times the rest.
 */
async function shoot(d) {
  const { court } = d;
  const [shooter, defender] = court.freeze.players.map((p) => centre(p.bounds));
  const ball = court.freeze.ball.centre;
  const pair = [court.seat.pairCentre[0], 1.0, court.seat.pairCentre[2]];
  const chair = [0, 1.15, 0];

  // setup (not grabbed): seated at the chair, Seat here, the headset off and on again (the arrival waits for it)
  d.head.p = chair;
  d.head.look = { yaw: 0, pitch: 0 };
  for (let i = 0; i < 5; i++) await d.step();
  await d.page.evaluate(() => window.__court.seatHere());
  await d.step(); // the frame that takes Seat here: a hand-over before it would be re-armed away (e2e.mjs seatHere)
  await d.page.evaluate(() => window.__xrDevice.updateVisibilityState("visible-blurred"));
  for (let i = 0; i < 20; i++) await d.step();
  await d.page.evaluate(() => window.__xrDevice.updateVisibilityState("visible"));
  // the world group takes the seat once the anchor holds; look at the pair from the chair (the arrival wants the
  // head still, so the look is set before the still second starts)
  const [pairRoom] = await d.toRoom([pair]);
  if (len(sub(pairRoom, pair)) < 1e-6) throw new Error("the world group never left court space: Seat here did not take");
  d.head.look = lookAt(chair, pairRoom);
  const seatLook = d.head.look;
  log(`seated: the pair at room ${pairRoom.map((v) => v.toFixed(2))}, look yaw ${d.head.look.yaw.toFixed(3)} pitch ${d.head.look.pitch.toFixed(3)}`);

  // 0:03 arrival: black, the still second, the lights up; 0:08 pass 1 at real speed, Step into the court armed mid-way
  d.roll();
  log("arrival");
  await d.until((f) => f.phase === "watching", 20, "watch");
  const [p1a, p1b] = court.video.segments.pass1;
  await d.until((f) => f.frame >= (p1a + p1b) / 2, 30, "middle of pass 1");
  await d.press("step");
  // 0:15 pass 2 into the ease, 0:20 the hand-off (the show's own timing)
  log("pass 1 armed; pass 2, the ease, the hand-off");
  await d.until((f) => f.phase === "open", 90, "open world");
  await d.hold(1.0);

  // 0:25 Walk closer: the fade-jump to the walking anchoring, then to the chair spot on the defender's side
  log("walk closer");
  await d.press("closer");
  await d.hold(0.6);
  const across = [defender[0] - shooter[0], 0, defender[2] - shooter[2]];
  const side = scale(across, 1 / len(across));
  // the chair's side of the pair's line (the footage's side), a quarter turn off it
  const [chairCourt] = await d.toCourt([chair]);
  let toChair = [-side[2], 0, side[0]];
  if (toChair[0] * (chairCourt[0] - defender[0]) + toChair[2] * (chairCourt[2] - defender[2]) < 0) toChair = scale(toChair, -1);
  const spot = add(add(defender, scale(side, 1.1)), scale(toChair, 0.9));
  const [spotRoom, ballRoom, handsRoom, defenderRoom] = await d.toRoom([[spot[0], 1.62, spot[2]], ball, add(ball, [0, 0.14, 0]), [defender[0], 1.2, defender[2]]]);
  await d.move(spotRoom, lookAt(spotRoom, lerp(defenderRoom, ballRoom, 0.6)), 3.4);
  await d.hold(1.0);

  // 0:30 Lean in: to the ball, hold; to the hands, hold (stand-in bodies: the tag is the edit's)
  log("lean in");
  const toward = (target, dist, rise) => {
    const back = sub(d.head.p, target);
    const flat = scale([back[0], 0, back[2]], 1 / Math.hypot(back[0], back[2]));
    return add(add(target, scale(flat, dist)), [0, rise, 0]);
  };
  const nearBall = toward(ballRoom, 0.6, 0.28);
  await d.move(nearBall, lookAt(nearBall, ballRoom), 1.3);
  await d.hold(3.0);
  const nearHands = toward(handsRoom, 0.5, 0.18);
  await d.move(nearHands, lookAt(nearHands, handsRoom), 1.0);
  await d.hold(3.0);

  // 0:38 Reality check: back a step, blue on for 4.5 s, off
  log("reality check");
  await d.move(spotRoom, lookAt(spotRoom, lerp(defenderRoom, ballRoom, 0.6)), 1.4);
  await d.press("reality");
  await d.hold(4.6);
  await d.press("reality");
  await d.hold(0.9);

  // 0:45 Back to my seat: through the room to the chair, the arena returns, the footage folds back over the 3D
  log("back to my seat");
  await d.press("back");
  await d.hold(0.3);
  await d.move(chair, seatLook, 2.6);
  await d.until((f) => f.phase === "resume", 15, "resume");

  // 0:50 The make: the release, the tilt to the rim, the ball through the net
  log("the make");
  const [rimRoom] = await d.toRoom([court.court.rim]);
  const start = d.frames.length;
  await d.until((f) => f.phase === "ended" || d.frames.length - start >= 1.2 * HZ, 30, "release");
  if (d.frames.at(-1).phase !== "ended") {
    await d.move(chair, lerpLook(seatLook, lookAt(chair, rimRoom), 0.75), 1.6);
    await d.until((f) => f.phase === "ended", 30, "the end of the make");
  }
  await d.hold(0.5);
}

// ---------------- checks ----------------
/** The log's own checks: one display frame per video frame, at 72 Hz, with no video frame held or skipped. */
function checkLog(frames) {
  const out = [];
  const gaps = frames.slice(1).filter((f, k) => f.n !== frames[k].n + 1).length;
  out.push(["every display frame grabbed once, in order (no drop, no double)", gaps === 0, `${frames.length} frames, display frames ${frames[0]?.n}..${frames.at(-1)?.n}, ${gaps} gaps`]);
  const off = frames.filter((f) => f.xrHz !== HZ || f.clockHz !== HZ).length;
  out.push(["every frame stepped 1/72 s with the clock at 72 Hz", off === 0, `${off} frames off (xrHz ${[...new Set(frames.map((f) => f.xrHz))]}, clockHz ${[...new Set(frames.map((f) => f.clockHz))]})`]);
  const held = frames.filter((f) => f.fed >= 0 && f.onScreen !== f.fed);
  out.push(["the video shows the clock's show frame on every frame it is fed (no hold)", held.length === 0, `${held.length} held${held.length ? ` (first at video frame ${frames.indexOf(held[0])}: fed ${held[0].fed}, on screen ${held[0].onScreen})` : ""}`]);
  // inside one segment of a running clock, each display frame is the next show frame (the stream bakes every speed)
  let bad = 0;
  let steps = 0;
  for (let k = 1; k < frames.length; k++) {
    const [a, b] = [frames[k - 1], frames[k]];
    if (a.segment !== b.segment || a.segment === "freeze" || a.segment === "ended" || b.speed === 0) continue;
    if (!["watching", "easing", "resume"].includes(b.phase) || a.phase !== b.phase) continue;
    steps++;
    if (b.frame !== a.frame + 1) bad++;
  }
  out.push(["one show frame per video frame while the show runs", bad === 0 && steps > 0, `${steps - bad} of ${steps} running steps advance exactly one show frame`]);
  return out;
}

/** Every encoded frame's stamp against the log: the display frame, the clock's show frame, the frame on screen. */
function checkStamps(file, frames) {
  const w = (BITS + 2) * CELL;
  const h = ROWS * CELL;
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${w}:${h}:0:ih-${h}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) return [["stamps decoded", false, String(r.stderr).slice(0, 300)]];
  const size = w * h;
  const count = r.stdout.length / size;
  const cell = (img, row, k) => {
    // the middle 6 x 6 of the cell; row 0 is the bottom row
    const y0 = h - (row + 1) * CELL + 3;
    const x0 = k * CELL + 3;
    let s = 0;
    for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) s += img[y * w + x];
    return s / 36;
  };
  let wrong = 0;
  let unclear = 0;
  let first = "";
  for (let i = 0; i < count; i++) {
    const img = r.stdout.subarray(i * size, (i + 1) * size);
    const want = [frames[i]?.n, frames[i]?.frame, frames[i]?.onScreen].map((v) => (v ?? -2) & 0xffff);
    for (let row = 0; row < ROWS; row++) {
      if (cell(img, row, 0) < 192 || cell(img, row, 1) > 64) unclear++;
      let v = 0;
      for (let b = 0; b < BITS; b++) {
        const l = cell(img, row, b + 2);
        if (l > 64 && l < 192) unclear++;
        v = (v << 1) | (l >= 128 ? 1 : 0);
      }
      if (v !== want[row]) {
        wrong++;
        first ||= `video frame ${i} row ${row}: stamp ${v}, log ${want[row]}`;
      }
    }
  }
  return [
    ["stamps decoded, one per video frame", count === frames.length, `${count} stamped frames for ${frames.length} logged`],
    ["every frame's stamp is its logged display frame, show frame and frame on screen", wrong === 0 && unclear === 0, `${count * ROWS} values: ${wrong} wrong, ${unclear} cells unclear${first ? `; first: ${first}` : ""}`],
  ];
}

function checkFile(file, expected) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,r_frame_rate,avg_frame_rate,width,height,pix_fmt,codec_name:format=duration", "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) return [["ffprobe", false, r.stderr.slice(0, 300)]];
  const j = JSON.parse(r.stdout);
  const s = j.streams[0];
  const n = Number(s.nb_read_frames);
  return [
    ["the MP4 has exactly one video frame per grabbed frame", n === expected, `${n} frames in the file, ${expected} grabbed`],
    ["the MP4 runs at exactly 72 fps", s.r_frame_rate === "72/1" && s.avg_frame_rate === "72/1", `r ${s.r_frame_rate}, avg ${s.avg_frame_rate}, ${s.codec_name} ${s.pix_fmt} ${s.width}x${s.height}, ${Number(j.format.duration).toFixed(3)} s`],
  ];
}

async function main() {
  if (!existsSync(join(BUNDLE, "court.json"))) throw new Error(`no court.json in ${BUNDLE}${IS_STANDIN ? ": make the stand-in first (node apps/webxr/scripts/court/standin.mjs)" : ""}`);
  const court = JSON.parse(readFileSync(join(BUNDLE, "court.json"), "utf8"));
  if (court.video.displayHz !== HZ) throw new Error(`the bundle is baked for ${court.video.displayHz} Hz; the capture is ${HZ} fps`);
  mkdirSync(dirname(OUT), { recursive: true });
  const { chromium } = findPlaywright();
  const { server, port } = await startServer();
  let browser;
  let encoder;
  let failed = 0;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--ignore-gpu-blocklist", "--use-angle=metal", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"],
    });
    // one throwaway load first, as the e2e does: vite answers a page that races its first optimize with a 504
    const warm = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    try {
      await warm.goto(pageUrl(port), { waitUntil: "load" });
      await warm.waitForFunction(() => window.__court && (window.__court.ready || window.__court.error), null, { timeout: 120000, polling: 200 });
    } catch (e) {
      log(`warm-up: ${String(e?.message ?? e).split("\n")[0]}`);
    } finally {
      await warm.close();
    }
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    const tail = [];
    page.on("console", (m) => tail.push(`${m.type()}: ${m.text().slice(0, 200)}`) > 20 && tail.shift());
    page.on("crash", () => log(`the page crashed; its last console lines:\n  ${tail.join("\n  ")}`));
    await page.goto(pageUrl(port), { waitUntil: "load" });
    await page.waitForFunction(() => window.__court && (window.__court.ready || window.__court.error), null, { timeout: 120000, polling: 200 });
    const loadError = await page.evaluate(() => window.__court.error);
    if (loadError) throw new Error(`the page could not load the bundle: ${loadError}`);
    await page.click("#court-enter");
    await page.evaluate(() => window.__court.nextFrame());
    await page.evaluate(() => window.__court.lockstep(true));

    encoder = spawn("nice", ["-n", "10", "ffmpeg", "-v", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${HEIGHT}`, "-framerate", String(HZ), "-i", "-",
      "-vf", "vflip,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-r", String(HZ),
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart", OUT], { stdio: ["pipe", "inherit", "inherit"] });
    const encoded = new Promise((done) => encoder.on("close", done));
    const d = director(page, encoder, court);
    d.page = page;
    const t0 = Date.now();
    try {
      await shoot(d);
    } finally {
      encoder.stdin.end();
    }
    const code = await encoded;
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
    log(`${d.frames.length} frames (${(d.frames.length / HZ).toFixed(3)} s of show) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    writeFileSync(OUT.replace(/\.mp4$/, ".frames.json"), `[\n${d.frames.map((f) => JSON.stringify(f)).join(",\n")}\n]\n`);
    errors.push(...(await page.evaluate(() => window.__court.errors)));
    const checks = [
      ...checkFile(OUT, d.frames.length),
      ...checkLog(d.frames),
      ...(STAMP ? checkStamps(OUT, d.frames) : []),
      ["console clean", errors.length === 0, errors.length ? `${errors.length} errors: ${errors.slice(0, 3).join(" | ")}` : "0 errors"],
    ];
    if (CAP !== Infinity) checks.unshift(["the clip is as long as asked", d.frames.length === CAP, `${d.frames.length} frames for --seconds ${CAP / HZ}`]);
    for (const [what, ok, detail] of checks) {
      console.log(`${ok ? "PASS" : "FAIL"} ${what}: ${detail}`);
      if (!ok) failed++;
    }
    const phases = [];
    d.frames.forEach((f, k) => {
      if (phases.at(-1)?.phase !== f.phase) phases.push({ phase: f.phase, from: k });
    });
    console.log(`beats: ${phases.map((p) => `${p.phase} @ ${(p.from / HZ).toFixed(2)} s`).join(", ")}`);
    console.log(`${failed ? "CAPTURE FAIL" : "CAPTURE OK"}: ${OUT}`);
  } finally {
    await browser?.close();
    server.kill();
    if (encoder && encoder.exitCode === null) encoder.kill();
  }
  process.exit(failed ? 1 : 0);
}

// lockstep makes every run frame-identical, so a renderer crash (a memory-starved host) is simply run again from the top
const RETRIES = Number(opt("--retries", 2));
(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await main();
      return;
    } catch (e) {
      const crashed = /Target crashed|has been closed|context was destroyed/.test(String(e?.message ?? e));
      if (!crashed || attempt >= RETRIES) {
        console.error("CAPTURE FAILED:", e?.stack ?? e);
        process.exit(1);
      }
      log(`the page crashed (${String(e?.message ?? e).split("\n")[0]}); run ${attempt + 2} of ${RETRIES + 1}, from the top`);
    }
  }
})();
