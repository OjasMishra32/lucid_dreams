// Checks budget.ts on a synthetic frame: exactly the budget is kept, everything kept adds at least as much to the
// picture (opacity x area) as everything dropped, a kept Gaussian's words and spherical harmonics move together, and
// a frame under its budget is untouched.
//   node scripts/check_budget.ts
import { trimSplats } from "../src/xr/budget.ts";
import type { PackedSplats } from "@sparkjsdev/spark";

let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails++;
};

const lnMin = -12;
const step = 21 / 254;
const byte = (s: number) => Math.min(255, Math.max(1, Math.round((Math.log(s) - lnMin) / step) + 1));
const make = (n: number) => {
  const a = new Uint32Array(n * 4);
  const sh1 = new Uint32Array(n * 2);
  const truth: { op: number; area: number; id: number }[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const op = Math.max(1, Math.floor(rnd() * 255));
    const s = [0.0005 + rnd() * 0.03, 0.0005 + rnd() * 0.03, 0.0002 + rnd() * 0.01].map(byte);
    a[i * 4] = (i & 0xffffff) | (op << 24); // the colour words carry the index, to follow each one
    a[i * 4 + 1] = i;
    a[i * 4 + 2] = i ^ 0x5555;
    a[i * 4 + 3] = s[0] | (s[1] << 8) | (s[2] << 16) | (17 << 24);
    sh1[i * 2] = i;
    sh1[i * 2 + 1] = ~i >>> 0;
    const ln = s.map((u) => lnMin + (u - 1) * step);
    truth.push({ op: op / 255, area: Math.exp(ln[0] + ln[1] + ln[2] - Math.min(...ln)), id: i });
  }
  return { ps: { numSplats: n, maxSplats: n, packedArray: a, extra: { sh1 }, splatEncoding: { lnScaleMin: -12, lnScaleMax: 9 }, needsUpdate: false } as unknown as PackedSplats, truth, a, sh1 };
};

const n = 50_000;
const budget = 20_000;
const { ps, truth, a, sh1 } = make(n);
const kept = trimSplats(ps, budget);
check(kept === budget && ps.numSplats === budget, `keeps exactly the budget (${kept} of ${n})`);
const ids = new Set<number>();
let moved = true;
for (let k = 0; k < kept; k++) {
  const id = a[k * 4 + 1];
  ids.add(id);
  if (a[k * 4 + 2] !== (id ^ 0x5555) || (a[k * 4] & 0xffffff) !== (id & 0xffffff) || sh1[k * 2] !== id || sh1[k * 2 + 1] !== (~id >>> 0)) moved = false;
}
check(moved, "each kept Gaussian's four words and its SH moved together");
check(ids.size === kept, "no Gaussian kept twice");
const score = (t: { op: number; area: number }) => t.op * t.area;
const minKept = Math.min(...truth.filter((t) => ids.has(t.id)).map(score));
const maxDropped = Math.max(...truth.filter((t) => !ids.has(t.id)).map(score));
// the histogram cut is exact up to one bin (2048 bins over e^-40..e^2: 2% in score)
check(minKept >= maxDropped * 0.97, `kept ones add the most (weakest kept ${minKept.toExponential(2)} vs strongest dropped ${maxDropped.toExponential(2)})`);
check(ps.needsUpdate === true, "marks the splats for upload");

const small = make(1000);
check(trimSplats(small.ps, 5000) === 1000 && small.ps.numSplats === 1000 && small.ps.needsUpdate === false, "a frame under its budget is untouched");
check(trimSplats(make(1000).ps, 0) === 1000, "budget 0 keeps everything");

if (fails) {
  console.log(`${fails} failed`);
  process.exit(1);
}
console.log("BUDGET_OK");
