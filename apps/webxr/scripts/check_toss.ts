// Checks toss.ts with synthetic tracked hands at 72 fps: a real toss (pinch, lift, let go) goes up to a height you can
// serve from; letting go of a still hand drops the ball; and things that must never toss: tracking jitter on a held
// ball, the fingers flickering open for a frame, tracking lost for a moment mid-lift, a hand flicked up without a
// pinch, a pinch while the palm menu is open. The ball you see must never jump.
//   node scripts/check_toss.ts
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import * as THREE from "three";
import type { Toss } from "../src/tennis/toss.ts";

// src/ is written for Vite (extensionless imports): resolve and transpile it on the fly
const SRC = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../src")).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/.test(spec) && ctx.parentURL?.startsWith(SRC)) return next(spec + ".ts", ctx);
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith(SRC) || !url.endsWith(".ts")) return next(url, ctx);
    const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const { TossHand } = await import("../src/tennis/toss.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failed++;
};

const FPS = 72;
const dt = 1 / FPS;
const EYE = 1.62;
const REST = new THREE.Vector3(-0.25, EYE - 0.55, 0.35);
let seed = 3;
const noise = (a: number) => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * a;

/** One frame of a left hand: where its pinch point is, how far apart thumb and index are, tracked or not. */
interface Frame {
  at: THREE.Vector3;
  gap: number;
  seen?: boolean;
  jitter?: number;
}
function run(frames: Frame[], canPinch = true) {
  const h = new TossHand();
  let out: (Toss & { frame: number }) | null = null;
  let maxStep = 0;
  const prev = new THREE.Vector3();
  const path: THREE.Vector3[] = [];
  frames.forEach((f, i) => {
    if (out) return;
    const j = f.jitter ?? 0.002;
    const c = f.at.clone().add(new THREE.Vector3(noise(j), noise(j), noise(j)));
    const thumb = c.clone().add(new THREE.Vector3(-f.gap / 2, 0, 0));
    const index = c.clone().add(new THREE.Vector3(f.gap / 2, 0, 0));
    const wrist = c.clone().add(new THREE.Vector3(0.02, -0.03, 0.08));
    const seen = f.seen !== false;
    const r = h.update({ t: i * dt, dt, thumb: seen ? thumb : null, index: seen ? index : null, wrist: seen ? wrist : null, eyeY: EYE, rest: REST, canPinch });
    if (i > 0) maxStep = Math.max(maxStep, h.ball.distanceTo(prev));
    prev.copy(h.ball);
    path.push(h.ball.clone());
    if (r) out = { ...r, frame: i };
  });
  return { out, maxStep, path, hand: h };
}
const still = (p: THREE.Vector3, n: number, gap: number, extra: Partial<Frame> = {}): Frame[] => Array.from({ length: n }, () => ({ at: p.clone(), gap, ...extra }));
const apexOf = (t: Toss) => t.p.y + (t.v.y * t.v.y) / (2 * 9.81);
const chest = new THREE.Vector3(-0.2, 1.1, 0.0);

// 1. a real toss: pinch at the chest, lift at ~1.6 m/s for 0.3 s, open the fingers near the top
{
  const f: Frame[] = [...still(chest, 30, 0.06), ...still(chest, 20, 0.015)];
  for (let i = 1; i <= 22; i++) f.push({ at: chest.clone().add(new THREE.Vector3(0, 1.6 * i * dt, -0.2 * i * dt)), gap: i < 20 ? 0.015 : 0.06 });
  const { out, maxStep } = run(f);
  check("a real toss goes up", !!out?.tossed, out ? `released at frame ${out.frame}, v ${out.v.toArray().map((x) => x.toFixed(2))}` : "never released");
  if (out) {
    const apex = apexOf(out);
    check("to a height you serve from", apex > EYE + 0.65 && apex < EYE + 1.3, `apex ${apex.toFixed(2)} m (eyes ${EYE})`);
    check("not far off your hand's line", Math.hypot(out.v.x, out.v.z) <= 0.5, `${Math.hypot(out.v.x, out.v.z).toFixed(2)} m/s sideways`);
  }
  check("the held ball moves smoothly", maxStep < 0.04, `largest step ${(maxStep * 100).toFixed(1)} cm per frame`);
}

// 2. a gentle toss (0.7 m/s) still gets the ball high enough
{
  const f: Frame[] = [...still(chest, 20, 0.015)];
  for (let i = 1; i <= 30; i++) f.push({ at: chest.clone().add(new THREE.Vector3(0, 0.7 * i * dt, 0)), gap: i < 28 ? 0.015 : 0.06 });
  const { out } = run(f);
  check("a gentle lift tosses", !!out?.tossed, out ? `apex ${apexOf(out).toFixed(2)} m` : "never released");
  if (out) check("high enough to serve", apexOf(out) > EYE + 0.65, `apex ${apexOf(out).toFixed(2)} m`);
}

// 3. letting go of a still hand: it drops
{
  const { out } = run([...still(chest, 30, 0.015), ...still(chest, 20, 0.06)]);
  check("let go of a still hand: it drops", !!out && !out.tossed, out ? `v ${out.v.y.toFixed(2)} m/s` : "never released");
}

// 4. held with tracking jitter (4 mm) for 3 s: never released, and the drawn ball barely shakes
{
  const { out, path } = run(still(chest, FPS * 3, 0.015, { jitter: 0.004 }));
  check("jitter never lets go", !out, out ? `released at frame ${out.frame}` : "held");
  const tail = path.slice(FPS);
  const mean = tail.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(tail.length);
  const sd = Math.sqrt(tail.reduce((a, p) => a + p.distanceToSquared(mean), 0) / tail.length);
  check("the held ball is steady", sd < 0.0025, `${(sd * 1000).toFixed(1)} mm wobble (tracking ${4} mm)`);
}

// 5. the fingers flicker open for one frame on a still hand: still held
{
  const f = [...still(chest, 30, 0.015), { at: chest.clone(), gap: 0.06 }, ...still(chest, 30, 0.015)];
  const { out } = run(f);
  check("a one-frame flicker never lets go", !out, out ? `released at frame ${out.frame}` : "held");
}

// 6. tracking lost for 0.2 s while held, then back: held, and the ball never jumps
{
  const f = [...still(chest, 30, 0.015), ...still(chest, 14, 0.015, { seen: false }), ...still(chest.clone().add(new THREE.Vector3(0, 0.02, 0)), 30, 0.015)];
  const { out, maxStep, hand } = run(f);
  check("a moment of lost tracking keeps the ball", !out && hand.pinched, out ? `released at frame ${out.frame}` : `held, pinched ${hand.pinched}`);
  check("and it doesn't jump", maxStep < 0.02, `largest step ${(maxStep * 100).toFixed(1)} cm per frame`);
}

// 7. tracking lost for 2 s: the ball drifts to where it waits, never jumps, never tosses
{
  const { out, maxStep, path } = run([...still(chest, 30, 0.015), ...still(chest, FPS * 2, 0.015, { seen: false })]);
  const end = path[path.length - 1];
  check("lost for long: no toss", !out, out ? `released at frame ${out.frame}` : "none");
  check("the ball drifts to its rest", end.distanceTo(REST) < 0.05, `${(end.distanceTo(REST) * 100).toFixed(1)} cm from it`);
  check("never a jump", maxStep < 0.03, `largest step ${(maxStep * 100).toFixed(1)} cm per frame`);
}

// 8. an open hand flicked up fast (no pinch): nothing
{
  const f: Frame[] = [...still(chest, 20, 0.07)];
  for (let i = 1; i <= 25; i++) f.push({ at: chest.clone().add(new THREE.Vector3(0, 2.5 * i * dt, 0)), gap: 0.07 });
  const { out } = run(f);
  check("an open hand flicked up never tosses", !out, out ? `released at frame ${out.frame}` : "none");
}

// 9. the palm menu is open: a pinch doesn't take the ball
{
  const f: Frame[] = [...still(chest, 20, 0.015)];
  for (let i = 1; i <= 25; i++) f.push({ at: chest.clone().add(new THREE.Vector3(0, 1.6 * i * dt, 0)), gap: i < 22 ? 0.015 : 0.06 });
  const { out, hand } = run(f, false);
  check("no pinch while the menu is open", !out && !hand.pinched, out ? `released at frame ${out.frame}` : "none");
}

// 10. lost tracking just as the fingers open at the top of a lift: it waits, then tosses with the real lift once seen
{
  const f: Frame[] = [...still(chest, 20, 0.015)];
  for (let i = 1; i <= 18; i++) f.push({ at: chest.clone().add(new THREE.Vector3(0, 1.5 * i * dt, 0)), gap: 0.015 });
  const top = chest.clone().add(new THREE.Vector3(0, 1.5 * 18 * dt, 0));
  f.push(...still(top, 4, 0.015, { seen: false }));
  for (let i = 1; i <= 6; i++) f.push({ at: top.clone().add(new THREE.Vector3(0, 1.2 * i * dt, 0)), gap: 0.06 });
  const { out, maxStep } = run(f);
  check("a dropout mid-lift still tosses", !!out?.tossed, out ? `apex ${apexOf(out).toFixed(2)} m` : "never released");
  check("without a jump", maxStep < 0.05, `largest step ${(maxStep * 100).toFixed(1)} cm per frame`);
}

console.log(failed ? `\n${failed} FAILED` : "\nTOSS_OK");
process.exit(failed ? 1 : 0);
