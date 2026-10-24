// Checks tempo.ts: his tempo from a bundle's joints.json, and your swings from synthetic tracked hands (a clean 3 : 1
// swing, one hit, one losing tracking at the top, and things that must never count: a waggle, a practice wave with no
// address, the club picked up and carried).
//   node scripts/check_tempo.ts [dreams/golf-01]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { measureTempo, SwingTracker, type Swing, type Vec3 } from "../src/tempo.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failed++;
};

// ---------------- his, from the bundle
const bundle = resolve(import.meta.dirname, "../../..", process.argv[2] ?? "dreams/golf-01");
try {
  const joints = JSON.parse(readFileSync(`${bundle}/joints.json`, "utf8"));
  const plan = JSON.parse(readFileSync(`${bundle}/experience.json`, "utf8"));
  const his = measureTempo(joints, plan.tempo);
  const bare = measureTempo(joints, null);
  if (!his || !bare) check("his tempo", false, "nothing measured");
  else {
    const f = his.frames;
    console.log(`     his tempo ${his.ratio.toFixed(2)} : 1 (${his.back.toFixed(2)} s / ${his.down.toFixed(2)} s), lead ${his.lead}`);
    console.log(`     takeaway ${his.takeaway.toFixed(2)} s (frame ${f.takeaway.toFixed(1)}, from ${his.takeawayFrom}), top ${his.top.toFixed(2)} s (frame ${f.top.toFixed(1)}), impact ${his.impact.toFixed(2)} s (frame ${f.impact.toFixed(1)}), slowed clip: ${his.slowMotion}`);
    console.log(`     from the joints alone: ${bare.ratio.toFixed(2)} : 1 (${bare.back.toFixed(2)} s / ${bare.down.toFixed(2)} s, takeaway from ${bare.takeawayFrom})`);
    check("top before impact", his.top < his.impact, `${his.top.toFixed(2)} < ${his.impact.toFixed(2)}`);
    check("a right-handed swing", his.lead === "left_wrist", his.lead);
  }
} catch (e) {
  console.log(`(no bundle at ${bundle}: ${(e as Error).message})`);
}

// ---------------- yours, from synthetic hands at 72 Hz
type Plan = { still: number; back: number; down: number; gapAtTop?: number; address?: boolean; hit?: boolean; lift?: number };
const HZ = 72;
function swing(plan: Plan): { swings: Swing[]; tracker: SwingTracker } {
  const tr = new SwingTracker();
  const swings: Swing[] = [];
  tr.onSwing = (s) => swings.push(s);
  const addr: Vec3 = [0.1, 0.85, -0.3];
  const lift = plan.lift ?? 0.85;
  const jitter = () => (Math.random() - 0.5) * 0.006; // hand tracking shakes a few millimetres
  let t = 0;
  const step = (p: Vec3 | null, address: boolean) => {
    tr.update({ t, hands: p ? [p[0] + jitter(), p[1] + jitter(), p[2] + jitter()] : null, holding: true, address });
    t += 1 / HZ;
  };
  for (let k = 0; k < plan.still * HZ; k++) step(addr, plan.address ?? true);
  // back: up and round to the trail side, easing in and out (so the takeaway starts slowly, as a real one does)
  const t0 = t;
  for (let k = 0; k <= plan.back * HZ; k++) {
    const u = k / (plan.back * HZ);
    const e = 0.5 - 0.5 * Math.cos(Math.PI * u);
    const gap = plan.gapAtTop && t - t0 > plan.back - plan.gapAtTop / 2;
    step(gap ? null : [addr[0] + 0.35 * Math.sin(Math.PI * e * 0.9), addr[1] + lift * e, addr[2] + 0.2 * e], false);
  }
  const tTop = t0 + plan.back;
  // down: accelerating all the way to the ball
  for (let k = 1; k <= plan.down * HZ; k++) {
    const u = k / (plan.down * HZ);
    const e = u * u;
    const gap = plan.gapAtTop && t - tTop < plan.gapAtTop / 2;
    step(gap ? null : [addr[0] + 0.35 * Math.sin(Math.PI * 0.9) * (1 - e), addr[1] + lift * (1 - e), addr[2] + 0.2 * (1 - e)], false);
  }
  if (plan.hit) tr.hit(t);
  // through to the finish
  for (let k = 1; k <= 0.5 * HZ; k++) step([addr[0] - 0.4 * (k / (0.5 * HZ)), addr[1] + 0.8 * (k / (0.5 * HZ)), addr[2]], false);
  for (let k = 0; k < HZ; k++) step([addr[0] - 0.4, addr[1] + 0.8, addr[2]], false);
  return { swings, tracker: tr };
}

{
  const { swings } = swing({ still: 1, back: 0.81, down: 0.27 });
  const s = swings[0];
  check("a 3 : 1 swing reads 3 : 1", swings.length === 1 && Math.abs(s.ratio - 3) < 0.35, s ? `${s.ratio.toFixed(2)} : 1 (${s.back.toFixed(2)} s / ${s.down.toFixed(2)} s)` : "no swing");
}
{
  const { swings } = swing({ still: 1, back: 0.6, down: 0.3, hit: true });
  const s = swings[0];
  check("a quick 2 : 1 swing with a hit", swings.length === 1 && s.hit && Math.abs(s.ratio - 2) < 0.3, s ? `${s.ratio.toFixed(2)} : 1, hit ${s.hit}` : "no swing");
}
{
  const { swings } = swing({ still: 1, back: 0.9, down: 0.3, gapAtTop: 0.25 });
  const s = swings[0];
  check("tracking lost at the top", swings.length === 1 && Math.abs(s.ratio - 3) < 0.45 && s.topFromGap, s ? `${s.ratio.toFixed(2)} : 1, top from the gap ${s.topFromGap}` : "no swing");
}
{
  const { swings, tracker } = swing({ still: 1, back: 0.8, down: 0.3, lift: 0.15 });
  check("a waggle (hands lift 15 cm) is no swing", swings.length === 0, `${swings.length} swings (${tracker.rejected || tracker.state})`);
}
{
  const { swings } = swing({ still: 1, back: 0.8, down: 0.3, address: false });
  check("no address, no swing", swings.length === 0, `${swings.length} swings`);
}
{
  // the club picked up and carried: hands rise and drift with no address
  const tr = new SwingTracker();
  let n = 0;
  tr.onSwing = () => n++;
  for (let k = 0; k < 4 * HZ; k++) {
    const t = k / HZ;
    tr.update({ t, hands: [0.3 * Math.sin(t), 0.9 + 0.5 * Math.sin(t * 2), -0.3], holding: true, address: false });
  }
  check("carrying the club is no swing", n === 0, `${n} swings`);
}

console.log(failed ? `\n${failed} FAILED` : "\nTEMPO_OK");
process.exit(failed ? 1 : 0);
