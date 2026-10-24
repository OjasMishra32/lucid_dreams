// Checks ghost.ts's analysis on the real dance-01 and taichi-01 joints: a synthetic you copies each lesson step on your
// turn (late, at your own speed, standing where you stand, at your own height, the way Follow along asks: a mirror copy
// when they face you), with one hand put off by a known amount at a known moment. The take must find when you began
// and how fast you went, score the clean copy near 100, put the gap in words with the right size, hand, direction
// and moment, keep the ghost beside them (never over them or you), and come out the same for people 1.5 to 1.95 m tall.
//   node scripts/check_ghost.ts
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import * as THREE from "three";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = pathToFileURL(resolve(HERE, "../src")).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/.test(spec) && ctx.parentURL?.startsWith(SRC)) return next(spec + ".ts", ctx);
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith(SRC) || !url.endsWith(".ts")) return next(url, ctx);
    const text = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
(globalThis as unknown as { location: { search: string } }).location = { search: "" };
const { analyse, describe, momentOf, starsOf, timingOf } = await import("../src/ghost.ts");
const { eyeHeightOf, jointAt, SWAP } = await import("../src/follow.ts");
const { beatsBetween, countAt } = await import("../src/beats.ts");
type Take = NonNullable<ReturnType<typeof analyse>>;

const DREAMS = resolve(HERE, "../../../dreams");
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failed++;
};

type Part = "head" | "left_wrist" | "right_wrist";
interface Case {
  dream: string;
  step: number;
  place: "facing" | "beside" | "ahead";
  mirrored?: boolean;
  eye: number; // your eye height
  late: number; // when you began, into your turn
  rate: number; // how fast you went (1 = their full speed)
  error?: { part: Part; at: number; off: [number, number, number] }; // your (right, up, forward) metres, around clip time `at`
}

function hand(wrist: THREE.Vector3, out: Float32Array, side: number) {
  // a flat open hand off the wrist: enough joints for the figure, the wrist is what's compared
  for (let j = 0; j < 25; j++) {
    const finger = j < 5 ? 0 : Math.floor((j - 5) / 5) + 1;
    const seg = j === 0 ? 0 : j < 5 ? j : ((j - 5) % 5) + 1;
    out[j * 3] = wrist.x + side * (finger * 0.02 - 0.03) * (seg ? 1 : 0);
    out[j * 3 + 1] = wrist.y + seg * 0.02;
    out[j * 3 + 2] = wrist.z;
  }
}

function run(c: Case): { take: Take | null; truthCm: number | null; ctx: Record<string, unknown> } {
  const dream = JSON.parse(readFileSync(resolve(DREAMS, c.dream, "dream.json"), "utf8"));
  const joints = JSON.parse(readFileSync(resolve(DREAMS, c.dream, "joints.json"), "utf8"));
  const exp = JSON.parse(readFileSync(resolve(DREAMS, c.dream, "experience.json"), "utf8"));
  const beats = dream.beats ? JSON.parse(readFileSync(resolve(DREAMS, c.dream, dream.beats), "utf8")) : null;
  const step = exp.steps[c.step];
  const index: Record<string, number> = Object.fromEntries(joints.names.map((n: string, i: number) => [n, i]));
  const theirEye = eyeHeightOf(joints);
  const s = Math.min(1.3, Math.max(0.75, c.eye / theirEye));
  // the room: you at the origin looking down -Z; they're placed as the viewer places them
  const you = new THREE.Vector3(0.3, 0, 0.2);
  const look = new THREE.Vector3(0, 0, -1);
  const right = new THREE.Vector3(1, 0, 0);
  const person = new THREE.Object3D();
  if (c.place === "facing") {
    person.position.copy(you).addScaledVector(look, 1.8);
    person.rotation.y = Math.PI; // their front (-Z) turned toward you (+Z), as the viewer turns them
  } else if (c.place === "ahead") {
    person.position.copy(you).addScaledVector(look, 1.5);
    person.rotation.y = 0; // facing away, the way you face
  } else {
    person.position.copy(you).addScaledVector(right, 0.8).addScaledVector(look, 0.5);
    person.rotation.y = 0;
  }
  person.updateMatrixWorld();
  const front = new THREE.Vector3(0, 0, -1).transformDirection(person.matrixWorld);
  const facing = c.place === "facing";
  const mir = c.mirrored ? -1 : 1;
  const ms = mir * (facing ? -1 : 1);
  const flip = ms < 0;
  const fwdB = front.clone().multiplyScalar(facing ? -1 : 1);
  const rightB = new THREE.Vector3(-fwdB.z, 0, fwdB.x);
  const dur = step.end - step.start;
  const length = dur + 1.5;
  const J = new THREE.Vector3(), P = new THREE.Vector3(), H = new THREE.Vector3();
  // their mean head on the floor through the step (the take's root)
  for (let j = 0; j < 24; j++) {
    jointAt(joints, index, "head", step.start + (dur * j) / 23, J);
    H.x += J.x / 24;
    H.z += J.z / 24;
  }
  // your part at their clip time, as you'd copy it: about your own spot, your size
  const copy = (part: Part, cl: number, out: THREE.Vector3) => {
    jointAt(joints, index, flip ? SWAP[part] : part, cl, J);
    return out.copy(you).addScaledVector(rightB, ms * (J.x - H.x) * s).addScaledVector(fwdB, -(J.z - H.z) * s).setY(J.y * s);
  };
  const samples = [];
  let truthCm: number | null = null;
  for (let tau = 0; tau <= length + 1e-9; tau += 1 / 30) {
    const cl = Math.min(step.end, Math.max(step.start, step.start + (tau - c.late) * c.rate));
    // your head: their head joint where you'd copy it, the headset looking ahead of it
    const yaw = Math.atan2(-fwdB.x, -fwdB.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const headJ = copy("head", cl, new THREE.Vector3());
    const eye = headJ.clone().sub(new THREE.Vector3(0, -0.07, 0.06).applyQuaternion(q));
    const hands = (["left_wrist", "right_wrist"] as Part[]).map((part, side) => {
      const w = copy(part, cl, P);
      if (c.error && c.error.part === part) {
        const k = Math.max(0, 1 - Math.abs(cl - c.error.at) / 0.25); // a bump in time around the moment
        const [r, u, f] = c.error.off;
        w.addScaledVector(rightB, r * k).addScaledVector(fwdB, f * k);
        w.y += u * k;
        truthCm = Math.round(Math.hypot(r, u, f) * 100);
      }
      const out = new Float32Array(75);
      hand(w, out, side ? 1 : -1);
      return out;
    });
    samples.push({ t: tau, eye, q, hands });
  }
  const take = analyse(samples, { joints, index, step, stepIndex: c.step, facing, mirrored: !!c.mirrored, front, theirEye, yourEye: c.eye, beats, leadIn: beats ? 1.0 : 0.3 });
  // how far their hands travel in the step: a near-still step can't say how fast you went (any speed fits)
  let travel = 0;
  for (const part of ["left_wrist", "right_wrist"] as Part[]) {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let j = 1; j < 24; j++) travel = Math.max(travel, jointAt(joints, index, part, step.start + (dur * j) / 23, a).distanceTo(jointAt(joints, index, part, step.start, b)));
  }
  return { take, truthCm, ctx: { s, flip, person, travel } };
}

// ---- words ----
check("describe low", describe("left_wrist", 0, -0.18, 0).text === "Left hand 18 cm low", describe("left_wrist", 0, -0.18, 0).text);
check("describe wide (left hand out to your left)", describe("left_wrist", -0.15, 0.02, 0).text === "Left hand 15 cm too wide", describe("left_wrist", -0.15, 0.02, 0).text);
check("describe two ways", describe("right_wrist", 0.12, -0.14, 0).text === "Right hand 18 cm low and wide", describe("right_wrist", 0.12, -0.14, 0).text);
check("describe back", describe("right_wrist", 0, 0, -0.2).text === "Right hand 20 cm too far back", describe("right_wrist", 0, 0, -0.2).text);
const turnDrop = { start: 1.2, end: 2.8, title: "Turn and drop" };
check("moment from the title", momentOf(turnDrop, 1.4, null) === "at the turn" && momentOf(turnDrop, 2.5, null) === "at the drop", `${momentOf(turnDrop, 1.4, null)} / ${momentOf(turnDrop, 2.5, null)}`);
const grid = { bpm: 120, times: [0.25, 0.75, 1.25] };
check("count on the beat grid", momentOf({ start: 0.25, end: 2.5, title: "Open the gate" }, 1.26, grid) === "on count 3", momentOf({ start: 0.25, end: 2.5, title: "Open the gate" }, 1.26, grid));
check("beats carry on past the last", JSON.stringify(beatsBetween(grid, 1.0, 2.3)) === JSON.stringify([1.25, 1.75, 2.25]), JSON.stringify(beatsBetween(grid, 1.0, 2.3)));
check("beats carry back before the first", JSON.stringify(beatsBetween(grid, -0.8, 0.3).map((x: number) => +x.toFixed(2))) === JSON.stringify([-0.75, -0.25, 0.25]), JSON.stringify(beatsBetween(grid, -0.8, 0.3)));
check("count 1 at a step's first beat", countAt(grid, 0.75, 0.76) === 1, String(countAt(grid, 0.75, 0.76)));
check("stars", starsOf(95) === 5 && starsOf(89) === 4.5 && starsOf(72) === 3.5 && starsOf(50) === 2.5 && starsOf(10) === 0.5, [95, 89, 72, 50, 10].map(starsOf).join(" "));
check("timing words", timingOf(1.5, 0.8, 1.5) === "About 20% slower than them" && timingOf(1.9, 1, 1.5) === "In 0.4 s after the count" && timingOf(0.4, 1.05, null) === null, [timingOf(1.5, 0.8, 1.5), timingOf(1.9, 1, 1.5), timingOf(0.4, 1.05, null)].join(" / "));

// ---- takes ----
const cases: (Case & { name: string })[] = [
  { name: "dance, step 2, facing, clean copy, on the count", dream: "dance-01", step: 1, place: "facing", eye: 1.62, late: 1.0, rate: 1 },
  { name: "dance, step 2, facing, left hand 18 cm low at the drop", dream: "dance-01", step: 1, place: "facing", eye: 1.62, late: 1.0, rate: 1, error: { part: "left_wrist", at: 2.35, off: [0, -0.18, 0] } },
  { name: "dance, step 2, 1.50 m tall, late and slow", dream: "dance-01", step: 1, place: "facing", eye: 1.4, late: 0.6, rate: 0.8, error: { part: "left_wrist", at: 2.35, off: [0, -0.18, 0] } },
  { name: "dance, step 2, 1.95 m tall, quick", dream: "dance-01", step: 1, place: "facing", eye: 1.83, late: 0.9, rate: 1.25, error: { part: "left_wrist", at: 2.35, off: [0, -0.18, 0] } },
  { name: "dance, step 1, Mirror on, right hand wide, in late", dream: "dance-01", step: 0, place: "facing", mirrored: true, eye: 1.62, late: 1.3, rate: 1, error: { part: "right_wrist", at: 0.8, off: [0.16, 0, 0] } },
  { name: "dance, step 3, ahead of you, right hand back", dream: "dance-01", step: 2, place: "ahead", eye: 1.7, late: 1.1, rate: 1, error: { part: "right_wrist", at: 3.6, off: [0, 0, -0.2] } },
  { name: "tai chi, step 1, facing, left hand high", dream: "taichi-01", step: 0, place: "facing", eye: 1.55, late: 0.4, rate: 0.9, error: { part: "left_wrist", at: 1.2, off: [0, 0.15, 0] } },
  { name: "tai chi, step 3, beside you, clean", dream: "taichi-01", step: 2, place: "beside", eye: 1.75, late: 0.3, rate: 1 },
];
for (const c of cases) {
  const { take, truthCm, ctx } = run(c);
  if (!take) {
    check(c.name, false, "no take");
    continue;
  }
  const dur = take.end - take.start;
  // the moment in your turn their step started, and how fast you went: within 3 frames and 8%
  const still = (ctx.travel as number) < 0.15;
  const offOk = Math.abs(take.offset - c.late) <= 0.1 + 0.05 * dur;
  const rateOk = still || Math.abs(take.rate - c.rate) / c.rate <= 0.08;
  check(`${c.name}: clock`, offOk && rateOk, `began ${take.offset.toFixed(2)} s (truth ${c.late}), speed ${take.rate.toFixed(2)} (truth ${c.rate})${still ? `, their hands move ${Math.round((ctx.travel as number) * 100)} cm in the step: speed not judged` : ""}`);
  if (!c.error) {
    check(`${c.name}: score`, take.score >= 92 && take.tips.length === 0, `score ${take.score.toFixed(1)}, ${take.stars} stars, tips ${JSON.stringify(take.tips)}`);
  } else {
    const t0 = take.gaps[0];
    const want = c.error.part === "left_wrist" ? "Left hand" : "Right hand";
    const okText = !!t0 && t0.text.startsWith(want) && Math.abs(t0.cm - truthCm!) <= 3;
    const dirWord = c.error.off[1] < 0 ? "low" : c.error.off[1] > 0 ? "high" : c.error.off[2] < 0 ? "back" : "wide";
    const wantTiming = c.rate < 0.88 || c.rate > 1.12 || (c.dream === "dance-01" && Math.abs(c.late - 1.0) >= 0.2); // dance has a count-in
    check(`${c.name}: tip`, okText && t0.text.includes(dirWord) && Math.abs(t0.c - c.error.at) < (still ? 0.25 : 0.12) && (still || wantTiming === !!take.timing), `${JSON.stringify(take.tips)} at ${t0?.c.toFixed(2)} (truth ${truthCm} cm ${dirWord} at ${c.error.at}); score ${take.score.toFixed(1)}`);
  }
  check(`${c.name}: their size`, Math.abs(take.scale - (ctx.s as number)) < 1e-6, `your eyes at ${c.eye} m: you are drawn at ${(1 / take.scale).toFixed(3)} of your size, theirs`);
}

// the ghost's side: beside them, clear of their reach and yours, at least 90 cm off
{
  const { take } = run(cases[1]);
  const t = take!;
  const sideNeed = (side: number) => (side > 0 ? t.extent.them[1] - t.extent.you[0] : t.extent.you[1] - t.extent.them[0]) + 0.12;
  check("ghost clearance", Math.max(0.9, Math.min(sideNeed(1), sideNeed(-1))) <= 1.5, `their reach ${t.extent.them.map((x) => x.toFixed(2))}, yours ${t.extent.you.map((x) => x.toFixed(2))}, needs ${sideNeed(1).toFixed(2)} (+x) / ${sideNeed(-1).toFixed(2)} (-x)`);
}

console.log(failed ? `\n${failed} FAILED` : "\nGHOST_OK");
process.exit(failed ? 1 : 0);
