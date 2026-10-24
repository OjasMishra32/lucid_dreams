// Checks rhythm.ts against a lesson run frame by frame the way viewer.ts runs it (each step slowed and repeated, then
// your turn at full speed): the beats fall due on the clip's clock, a player on the beat scores 100%, early and late
// strums are named, and nothing that isn't meant for a beat counts (strums between beats, the hand coming back up,
// strums while paused, a scrub).
//   node scripts/check_rhythm.ts [dreams/guitar-01]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { laneClock, type LessonLike, RhythmJudge, type StepLike, type Strums, TURN_LEAD, upcoming } from "../src/rhythm.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failed++;
};

const bundle = resolve(import.meta.dirname, "../../..", process.argv[2] ?? "dreams/guitar-01");
let strums: Strums = { times: [0.3, 0.8, 1.05, 1.55, 2.3, 2.55, 3.4, 4.1], down: [true, true, false, true, true, false, true, true] };
let steps: StepLike[] = [{ start: 0, end: 1.6, speed: 0.5, repeat: 2 }, { start: 1.6, end: 3.2, speed: 0.5, repeat: 2 }, { start: 3.2, end: 4.84, speed: 0.5, repeat: 2 }];
try {
  strums = JSON.parse(readFileSync(`${bundle}/strums.json`, "utf8"));
  steps = JSON.parse(readFileSync(`${bundle}/experience.json`, "utf8")).steps;
  console.log(`     ${bundle}: ${strums.times.length} strums, ${steps.length} steps`);
} catch {
  console.log("     (no bundle: a made-up pattern)");
}

/** experience.ts's Lesson, watch and turn, as viewer.ts drives it. */
class MiniLesson implements LessonLike {
  i = 0;
  rep = 0;
  phase = "watch";
  turnEnds = 0;
  turnLength = 0;
  readonly steps: StepLike[];
  constructor(steps: StepLike[]) {
    this.steps = steps;
  }
  get step() {
    return this.steps[this.i];
  }
  go(i: number) {
    this.i = (i + this.steps.length) % this.steps.length;
    this.rep = 0;
    this.phase = "watch";
  }
  update(t: number, now: number): number {
    const s = this.step;
    if (this.phase === "turn") {
      if (now < this.turnEnds) return s.end - 0.001;
      this.go(this.i + 1);
      return this.step.start;
    }
    if (t >= s.end) {
      this.rep++;
      if (this.rep >= (s.repeat ?? 2)) {
        this.phase = "turn";
        this.turnLength = (s.end - s.start) * 1000 + 1500;
        this.turnEnds = now + this.turnLength;
        return s.end - 0.001;
      }
      return s.start;
    }
    return t < s.start ? s.start : t;
  }
}

/** Runs the lesson at 72 frames a second for `seconds`; play(dueBeat) decides your strums. Returns the judge. */
function run(seconds: number, player: (beat: { at: number; down: boolean; turn: boolean }, judge: RhythmJudge) => { at: number; down: boolean }[], opts: { pauseAt?: [number, number]; extra?: { at: number; down: boolean }[] } = {}) {
  const lesson = new MiniLesson(steps);
  const judge = new RhythmJudge(strums);
  const duration = Math.max(...steps.map((s) => s.end));
  let t = steps[0].start;
  let step = 0;
  const strumsAt: { at: number; down: boolean }[] = [...(opts.extra ?? [])];
  const perStep: number[] = [];
  const total = { on: 0, early: 0, late: 0, missed: 0 };
  const addUp = () => (Object.keys(total) as (keyof typeof total)[]).forEach((k) => (total[k] += judge.stats[k]));
  const dueLog: { at: number; down: boolean; turn: boolean }[] = [];
  const dt = 1 / 72;
  for (let f = 0; f < seconds * 72; f++) {
    const now = f * dt;
    const playing = !(opts.pauseAt && now >= opts.pauseAt[0] && now < opts.pauseAt[1]);
    const speed = lesson.step.speed ?? 0.5;
    if (playing && lesson.phase === "watch") t = Math.min(t + dt * speed, duration);
    if (playing) t = lesson.update(t, now * 1000);
    if (lesson.i !== step) {
      perStep.push(judge.accuracy() ?? NaN);
      addUp();
      step = lesson.i;
      judge.resetStep();
    }
    // your strums due by now
    for (let k = strumsAt.length - 1; k >= 0; k--)
      if (strumsAt[k].at <= now) {
        judge.strum(strumsAt[k].down, strumsAt[k].at);
        strumsAt.splice(k, 1);
      }
    const { due } = judge.advance(laneClock(lesson, t, speed, playing, now * 1000, duration), now);
    for (const d of due) {
      dueLog.push({ at: d.at, down: d.down, turn: d.turn });
      strumsAt.push(...player({ at: d.at, down: d.down, turn: d.turn }, judge));
    }
  }
  addUp();
  return { judge, perStep, dueLog, total };
}

// the beats fall due on the lesson's clock: step 1 watched twice at half speed, then your turn at full speed
{
  const { dueLog } = run(12, () => []);
  const s0 = steps[0];
  const inStep = strums.times.filter((x) => x >= s0.start && x <= s0.end);
  const rate = s0.speed ?? 0.5;
  const want = [
    ...inStep.map((x) => (x - s0.start) / rate),
    ...inStep.map((x) => (s0.end - s0.start) / rate + (x - s0.start) / rate),
    ...inStep.map((x) => (2 * (s0.end - s0.start)) / rate + TURN_LEAD + (x - s0.start)),
  ];
  const got = dueLog.slice(0, want.length).map((d) => d.at);
  const err = Math.max(...want.map((w, k) => Math.abs(w - got[k])));
  check("beats due on the lesson's clock", got.length === want.length && err < 1 / 72 + 1e-6, `${got.length} of ${want.length}, worst ${(err * 1000).toFixed(1)} ms`);
  check("the turn's beats are marked", dueLog.slice(2 * inStep.length, 3 * inStep.length).every((d) => d.turn), `${dueLog.filter((d) => d.turn).length} turn beats`);
}
// a player on the beat (within 40 ms) scores 100% and builds a streak
{
  const { judge, perStep } = run(30, (b) => [{ at: b.at + (Math.random() - 0.5) * 0.08, down: b.down }]);
  const all = perStep.filter((x) => !Number.isNaN(x));
  check("on the beat: 100% every step", all.length > 0 && all.every((x) => x === 1), `${all.map((x) => Math.round(x * 100) + "%").join(", ")}; best streak ${judge.best}`);
}
// early and late are named, with how far off
{
  const early = run(8, (b) => [{ at: b.at - 0.15, down: b.down }]).judge;
  const late = run(8, (b) => [{ at: b.at + 0.12, down: b.down }]).judge;
  check("150 ms early is Early", early.stats.early > 0 && early.stats.on === 0 && early.last?.kind === "early" && Math.abs(early.last.ms + 150) <= 15, `${JSON.stringify(early.stats)}, last ${early.last?.ms} ms`);
  check("120 ms late is Late", late.stats.late > 0 && late.stats.on === 0 && late.last?.kind === "late" && Math.abs(late.last.ms - 120) <= 15, `${JSON.stringify(late.stats)}, last ${late.last?.ms} ms`);
}
// nothing that isn't meant for a beat counts
{
  // between every two beats, a strum the other way (the hand coming back) and one half a second off any beat
  const { total, dueLog } = run(12, (b) => [{ at: b.at, down: b.down }, { at: b.at + 0.17, down: !b.down }]);
  check("the hand coming back is ignored", total.early + total.late === 0 && total.on === dueLog.length, `${JSON.stringify(total)} for ${dueLog.length} beats`);
  const lone = run(6, () => [], { extra: [0.05, 2.0, 2.9, 5.5].map((at) => ({ at, down: true })) }).judge;
  const n = lone.stats.on + lone.stats.early + lone.stats.late;
  check("strums near no beat aren't judged", n <= 1, `${n} judged of 4 stray strums (${JSON.stringify(lone.stats)})`);
  const paused = run(6, () => [], { pauseAt: [0, 6], extra: [0.6, 1.2, 1.8].map((at) => ({ at, down: true })) }).judge;
  check("paused: nothing falls due or counts", paused.stats.on + paused.stats.early + paused.stats.late + paused.stats.missed === 0, JSON.stringify(paused.stats));
}
// beats you didn't play count as missed only once you're playing
{
  const watching = run(8, () => []).judge;
  check("just watching misses nothing", watching.stats.missed === 0, JSON.stringify(watching.stats));
}
// the lane shows what's coming: watching, the next repeat and then your turn at full speed
{
  const lesson = new MiniLesson(steps);
  const s0 = steps[0];
  const list = upcoming(strums, lesson, s0.end - 0.2, s0.speed ?? 0.5, true, 0, 4.84, 6, 0.3);
  const turnNotes = list.filter((u) => u.turn);
  check("upcoming: this pass, the repeat and the turn", list.length > 0 && turnNotes.length > 0, `${list.length} shown, ${turnNotes.length} on your turn`);
}

console.log(failed ? `\n${failed} FAILED` : "\nRHYTHM_OK");
process.exit(failed ? 1 : 0);
