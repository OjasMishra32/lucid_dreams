// The frame-rate governor (src/xr/quality.ts) on a simulated headset at 72 Hz: a scene whose sharpest level only
// draws at 55 fps but holds 72 one level down. It must step down, and its tries at the sharper level must back off
// (5 s, then 10, 20, 40, 60) instead of stuttering every few seconds; a scene with room everywhere stays sharpest.
//   ../web/node_modules/.bin/tsx scripts/check_governor.ts   (quality.ts has parameter properties: not strip-only)
import { QualityGovernor } from "../src/xr/quality.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

function run(fpsAt: (level: number) => number, seconds: number) {
  const renderer = { xr: { isPresenting: true, getSession: () => ({ frameRate: 72 }), setFoveation: () => {} } };
  const g = new QualityGovernor(renderer as never);
  g.reset();
  let now = 1000;
  const changes: { t: number; level: number }[] = [];
  let last = g.level;
  let lateFrames = 0;
  let frames = 0;
  while (now < 1000 + seconds * 1000) {
    const fps = fpsAt(g.level);
    now += 1000 / fps;
    g.frame(now);
    frames++;
    if (fps < 72 * 0.9) lateFrames++;
    if (g.level !== last) {
      changes.push({ t: (now - 1000) / 1000, level: g.level });
      last = g.level;
    }
  }
  return { changes, level: g.level, lateShare: lateFrames / frames };
}

// level 0 too heavy, level 1 fits
const tight = run((level) => (level === 0 ? 55 : 72), 180);
const ups = tight.changes.filter((c, i) => i > 0 && c.level < tight.changes[i - 1].level);
check("steps down off a level that can't hold 72", tight.changes[0]?.level === 1, JSON.stringify(tight.changes.slice(0, 3)));
check("tries the sharper level again, backing off", ups.length >= 2 && ups.length <= 7, `${ups.length} tries in 180 s at ${ups.map((u) => u.t.toFixed(0)).join(", ")} s`);
const gaps = ups.slice(1).map((u, i) => u.t - ups[i].t);
check("each failed try waits longer than the last (up to a minute)", gaps.every((g, i) => i === 0 || g >= gaps[i - 1] - 1), gaps.map((g) => g.toFixed(1)).join(", "));
check("under 5% of frames late over three minutes", tight.lateShare < 0.05, `${(tight.lateShare * 100).toFixed(1)}%`);

// room everywhere: stays at the sharpest level
const easy = run(() => 72, 60);
check("a scene with room stays sharpest", easy.changes.length === 0 && easy.level === 0, JSON.stringify(easy.changes));

// a heavy scene: walks down until it holds, then stays
const heavy = run((level) => [40, 50, 60, 72, 72][level], 120);
check("a heavy scene settles where it holds", heavy.level === 3 || heavy.level === 4, `level ${heavy.level}, ${heavy.changes.length} changes`);

console.log(failed ? `GOVERNOR_FAIL ${failed}` : "GOVERNOR_OK");
process.exit(failed ? 1 : 0);
