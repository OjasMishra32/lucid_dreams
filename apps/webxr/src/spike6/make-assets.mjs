// Writes the S6 test page's binary assets into ./assets (git-ignored). Same machine, same bytes: every noise source is
// seeded, nothing reads the clock, and x264 runs in average-bitrate mode (its VBV rate control is not deterministic
// across threads). Needs ffmpeg with libx264 (+ libfreetype for the labels).
//
//   wc-1440.h264       2560x1440 72 fps, 8 s (576 frames), High 5.2 (avc1.640034): the WebCodecs stream
//   wc-1440-ease.h264  the same scene easing to a stop from main frame 216 (3.0 s) over 2 s: the "press" segment
//   wc-1080.h264       1920x1080 72 fps, 4 s, High 5.0 (avc1.640032): the fallback (?wc=1080)
//   wc-1080-ease.h264  its ease segment
//   test-720.mp4       1280x720 59.94 fps, 10 s: phase 1's <video> clip
//
// The .h264 files are Annex B with an access unit delimiter before every frame, no B-frames, and an IDR (with SPS/PPS)
// at every 2 s segment start. The scene: a panning low courtside camera, a crowd, ad boards, a wood floor with the key,
// ten running players, the two in front jumping, a ball, sensor grain, and the frame number top left.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "assets");
const FONT = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"].find((f) => existsSync(f)) ?? null;
const font = FONT ? `fontfile='${FONT}':` : "";
const SEGMENT = 144; // 2 s at 72 fps

function ffmpeg(args, what) {
  const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", ...args], { stdio: "inherit" });
  if (r.error) throw new Error(`ffmpeg not found (${r.error.message}): brew install ffmpeg`);
  if (r.status !== 0) throw new Error(`ffmpeg failed making ${what}`);
}

// ---------------- the still background (4000 x 1800 world pixels) ----------------

function background(file) {
  const boards = ["COURT SIDE", "LUCID DREAMS", "GATOR HACK V", "SYNTHETIC ARENA"];
  const text = FONT
    ? Array.from({ length: 8 }, (_, i) => `,drawtext=${font}text='${boards[i % 4]}':fontsize=64:fontcolor=0xe8eef5:x=${i * 500 + 250}-tw/2:y=55-th/2`).join("")
    : "";
  const graph = [
    // the crowd: coloured blocks (seeded noise blown up), rails between the rows, softened
    "color=c=0x0e1422:s=400x80:d=1,noise=alls=90:allf=u:all_seed=7,scale=4000:800:flags=neighbor,eq=saturation=1.4:brightness=-0.06,drawgrid=w=4000:h=40:t=4:c=0x2a303c,gblur=sigma=1.2[crowd]",
    // ad boards, one panel every 500 px
    `color=c=0x16253e:s=4000x110:d=1,drawgrid=w=500:h=110:t=6:c=0x0a1220${text}[boards]`,
    // the floor: wood grain (noise smeared along the boards), plank seams, the far sideline and the key
    "color=c=0xc89655:s=4000x890:d=1,noise=alls=40:allf=u:all_seed=11,avgblur=sizeX=40:sizeY=1,drawgrid=w=224:h=26:t=2:c=0x7a5020@0.7," +
      "drawbox=x=0:y=40:w=4000:h=6:c=0xf6f0e4:t=fill,drawbox=x=1650:y=46:w=700:h=480:c=0x9b3038:t=fill,drawbox=x=1650:y=40:w=700:h=486:c=0xf6f0e4:t=6[floor]",
    "[crowd][boards][floor]vstack=inputs=3",
  ].join(";");
  ffmpeg(["-filter_complex", graph, "-frames:v", "1", file], "the background");
}

// ---------------- the moving scene ----------------

// (team, number, x, feet y, sway amplitude, cycles per 8 s, phase, depth sway, size); the first two are the main pair
const PLAYERS = [
  ["red", 23, 2050, 1380, 80, 1, 0.0, 30, 1.0], ["white", 6, 2160, 1420, 70, 1, 0.4, 25, 1.05],
  ["red", 3, 1500, 1180, 380, 1, 1.0, 60, 0.62], ["white", 11, 1650, 1200, 340, 1, 1.5, 50, 0.64],
  ["red", 8, 2800, 1250, 420, 2, 2.0, 70, 0.72], ["white", 0, 2700, 1270, 380, 2, 2.4, 60, 0.74],
  ["red", 30, 1100, 1060, 300, 1, 3.0, 30, 0.5], ["white", 34, 1200, 1080, 280, 1, 3.3, 30, 0.52],
  ["red", 1, 3200, 1100, 260, 3, 4.0, 40, 0.55], ["white", 2, 3050, 1120, 260, 3, 4.5, 40, 0.57],
];

function sprite(team, number, rate) {
  const jersey = team === "red" ? "0xc52c38" : "0xe3e5ed";
  const shorts = team === "red" ? "0x9b202c" : "0x26344c";
  const skin = team === "red" ? "0xb97b53" : "0x8d563c";
  const box = (x, y, w, h, c) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:c=${c}@1:t=fill:replace=1`;
  const parts = [
    box(40, 0, 40, 46, skin), box(52, 44, 16, 8, skin), box(22, 50, 76, 122, jersey), box(6, 54, 16, 112, skin), box(98, 54, 16, 112, skin),
    box(24, 170, 72, 56, shorts), box(30, 226, 24, 80, skin), box(66, 226, 24, 80, skin), box(26, 304, 30, 14, "0xeeeeeb"), box(64, 304, 30, 14, "0xeeeeeb"),
  ];
  const label = FONT ? `,drawtext=${font}text='${number}':fontsize=44:fontcolor=${team === "red" ? "white" : "0x1e2846"}:x=60-tw/2:y=110-th/2` : "";
  return `color=c=black@0:s=120x320:r=${rate},format=rgba,${parts.join(",")}${label}`;
}

/** The filter graph for one clip. T is the scene time as an expression of t (the ease remaps it). */
function scene({ T, rate, grain, label }) {
  const lines = [`[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[w0]`];
  const jump = `if(between(${T},3.3,4.5),sin(PI*(${T}-3.3)/1.2),0)`;
  const xOf = ([, , x, , amp, cyc, ph]) => `(${x}+${amp}*sin(2*PI*${cyc}*${T}/8+${ph}))`;
  const yOf = ([, , , y, , cyc, ph, dz]) => `(${y}+${dz}*sin(2*PI*${cyc}*${T}/8+${ph * 1.7}))`;
  // draw far players first (smaller feet y), the main pair last
  const order = PLAYERS.map((p, i) => i).sort((a, b) => PLAYERS[a][3] - PLAYERS[b][3]);
  let prev = "w0";
  order.forEach((i, k) => {
    const p = PLAYERS[i];
    const [team, number] = p;
    const w = Math.round(120 * p[8] * 1.6);
    const h = Math.round(320 * p[8] * 1.6);
    const lift = i < 2 ? `150*${jump}` : `10*abs(sin(2*PI*2.25*${T}+${p[6]}))`;
    lines.push(`${sprite(team, number, rate)},scale=${w}:${h}[s${i}]`);
    lines.push(`[${prev}][s${i}]overlay=x='${xOf(p)}-w/2':y='${yOf(p)}-h-${lift}':eval=frame[w${k + 1}]`);
    prev = `w${k + 1}`;
  });
  // the ball: dribbled beside #23, then up with the jump
  const ballY = `if(between(${T},3.3,4.5),${yOf(PLAYERS[0])}-560-150*${jump},${yOf(PLAYERS[0])}-20-260*abs(sin(2*PI*1.5*${T})))`;
  lines.push(`color=c=black@0:s=52x52:r=${rate},format=rgba,geq=r='216':g='116':b='34':a='if(lt(hypot(X-26,Y-26),26),255,0)'[ball]`);
  lines.push(`[${prev}][ball]overlay=x='${xOf(PLAYERS[0])}+70-26':y='${ballY}-26':eval=frame[wb]`);
  // the camera: a slow pan and tilt across the world, then grain and the frame number
  const text = FONT ? `,drawtext=${font}text='${label} %{eif\\:n\\:d\\:3}':fontsize=64:fontcolor=white:box=1:boxcolor=black:boxborderw=24:x=60:y=50` : "";
  lines.push(`[wb]crop=2560:1440:x='720+600*sin(2*PI*${T}/8)':y='200+50*sin(2*PI*${T}/8+0.7)',noise=alls=7:allf=${grain}:all_seed=5${text}[v]`);
  return lines.join(";");
}

const X264 = (level, bitrate) => [
  "-c:v", "libx264", "-profile:v", "high", "-level:v", level, "-preset", "medium", "-pix_fmt", "yuv420p",
  "-bf", "0", "-g", String(SEGMENT), "-keyint_min", String(SEGMENT), "-sc_threshold", "0", "-refs", "3",
  "-b:v", bitrate,
  "-x264-params", "aud=1:repeat-headers=1:colorprim=bt709:transfer=bt709:colormatrix=bt709",
];

function streams(bg, { name, T, frames, fallbackFrames, grain }) {
  const graph = `${scene({ T, rate: 72, grain, label: name === "main" ? "MAIN" : "EASE" })};[v]split[a][b];[b]trim=end_frame=${fallbackFrames},scale=1920:1080:flags=lanczos[c]`;
  const suffix = name === "main" ? "" : "-ease";
  ffmpeg([
    "-loop", "1", "-framerate", "72", "-i", bg, "-filter_complex", graph,
    "-map", "[a]", "-frames:v", String(frames), ...X264("5.2", "16M"), "-f", "h264", join(out, `wc-1440${suffix}.h264`),
    "-map", "[c]", "-frames:v", String(fallbackFrames), ...X264("5.0", "8M"), "-f", "h264", join(out, `wc-1080${suffix}.h264`),
  ], `the ${name} streams`);
}

function clip720(bg) {
  const graph = `${scene({ T: "t", rate: "60000/1001", grain: "t+u", label: "720p" })};[v]scale=1280:720:flags=lanczos[o]`;
  ffmpeg([
    "-loop", "1", "-framerate", "60000/1001", "-i", bg, "-filter_complex", graph, "-map", "[o]", "-frames:v", "600",
    "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-pix_fmt", "yuv420p", "-b:v", "8M",
    "-g", "120", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", "-movflags", "+faststart", "-an", join(out, "test-720.mp4"),
  ], "the 720p clip");
}

// ---------------- check what came out ----------------

/** Access units (by delimiter), IDRs, and the first SPS's profile and level bytes. */
function inspect(file) {
  const b = readFileSync(file);
  let aus = 0;
  let idr = 0;
  let sps = null;
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue;
    const type = b[i + 3] & 0x1f;
    if (type === 9) aus++;
    else if (type === 5) idr++;
    else if (type === 7 && !sps) sps = `${b[i + 4].toString(16)}${b[i + 5].toString(16).padStart(2, "0")}${b[i + 6].toString(16)}`;
    i += 3;
  }
  return { aus, idr, codec: sps ? `avc1.${sps}` : null };
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

mkdirSync(out, { recursive: true });
const bg = join(out, "background.png");
const t0 = Date.now();
background(bg);
streams(bg, { name: "main", T: "t", frames: 576, fallbackFrames: 288, grain: "t+u" });
// the ease: velocity 1 -> 0 over 2 s, scene time 3.0 -> 4.0; the grain stops with time
streams(bg, { name: "ease", T: "(3+min(t,2)-min(t,2)*min(t,2)/4)", frames: 144, fallbackFrames: 144, grain: "u" });
clip720(bg);
rmSync(bg);

const want = {
  "wc-1440.h264": { aus: 576, idr: 4, codec: "avc1.640034" }, "wc-1440-ease.h264": { aus: 144, idr: 1, codec: "avc1.640034" },
  "wc-1080.h264": { aus: 288, idr: 2, codec: "avc1.640032" }, "wc-1080-ease.h264": { aus: 144, idr: 1, codec: "avc1.640032" },
};
let ok = true;
for (const [file, w] of Object.entries(want)) {
  const got = inspect(join(out, file));
  const good = got.aus === w.aus && got.idr === w.idr && got.codec === w.codec;
  ok &&= good;
  console.log(`${good ? "ok  " : "BAD "} ${file.padEnd(18)} ${(statSync(join(out, file)).size / 1e6).toFixed(1).padStart(5)} MB  ${got.aus} frames, ${got.idr} IDR, ${got.codec}  sha256 ${sha(join(out, file))}`);
}
const mp4 = join(out, "test-720.mp4");
console.log(`ok   test-720.mp4       ${(statSync(mp4).size / 1e6).toFixed(1).padStart(5)} MB  sha256 ${sha(mp4)}`);
console.log(`${FONT ? "" : "(no font found: labels and numbers left out) "}done in ${Math.round((Date.now() - t0) / 1000)} s -> ${out}`);
if (!ok) process.exit(1);
