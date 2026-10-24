// The guitar play-along's timing: where the teacher's strums (strums.json) fall on the clip's own clock as the lesson
// plays it (each step slowed and repeated, then your turn at full speed), and how your strums land against them. Plain
// maths, no three.js, so scripts/check_rhythm.ts runs it in node.

export interface Strums {
  times: number[]; // clip seconds
  down: boolean[];
}

export interface StepLike {
  start: number;
  end: number;
  speed?: number;
  repeat?: number;
}

/** What the lane needs of a Lesson (experience.ts). */
export interface LessonLike {
  i: number;
  rep: number;
  phase: string; // "watch", "turn", or "ghost" (the step once more beside your ghost, then the next step)
  turnEnds: number; // ms (performance.now)
  turnLength: number; // ms
  steps: StepLike[];
}

export const TURN_LEAD = 0.75; // s on your turn before the step's first beat (the turn is the move + 1.5 s)
export const WINDOW = 0.25; // s either side within which a strum is taken as meant for a beat
export const ON_BEAT = 0.08; // s either side counts as on the beat
const DEBOUNCE = 0.1; // s: the same way twice this soon is one stroke read twice (the other way back can be a real up-strum)

/** Where the lane's clock is this frame: clip time t at speed (clip s per real s), in segment seg, counting only notes
 * in [lo, hi] (the step being played). null while nothing plays. */
export interface LaneClock {
  t: number;
  speed: number;
  seg: string;
  lo: number;
  hi: number;
}

/** The lane's clock from the lesson (or plain playback): watching, the clip as it plays; your turn, the step again at
 * full speed from TURN_LEAD before its start. */
export function laneClock(lesson: LessonLike | null, t: number, speed: number, playing: boolean, nowMs: number, duration: number): LaneClock | null {
  if (!playing) return null;
  if (!lesson) return { t, speed, seg: "free", lo: 0, hi: duration };
  const st = lesson.steps[lesson.i];
  if (lesson.phase === "turn") {
    const elapsed = (nowMs - (lesson.turnEnds - lesson.turnLength)) / 1000;
    return { t: st.start - TURN_LEAD + elapsed, speed: 1, seg: `${lesson.i}:turn`, lo: st.start, hi: st.end };
  }
  return { t, speed, seg: `${lesson.i}:${lesson.phase}`, lo: st.start, hi: st.end };
}

export interface Upcoming {
  dt: number; // real seconds from now (negative: just passed)
  down: boolean;
  k: number; // index in strums
  turn: boolean; // on your turn
}

/** The strums the lane shows, from `past` seconds ago to `horizon` ahead, following the lesson forward: this pass, the
 * step's repeats, your turn, the next step. Paused, they hold still where they are. */
export function upcoming(s: Strums, lesson: LessonLike | null, t: number, speed: number, playing: boolean, nowMs: number, duration: number, horizon = 2.2, past = 0.35): Upcoming[] {
  const out: Upcoming[] = [];
  const add = (lo: number, hi: number, offset: number, rate: number, from: number, turn: boolean) => {
    // notes in [lo, hi] at real time offset + (time - from) / rate
    s.times.forEach((time, k) => {
      if (time < lo || time > hi) return;
      const dt = offset + (time - from) / rate;
      if (dt >= -past && dt <= horizon) out.push({ dt, down: s.down[k], k, turn });
    });
  };
  if (!lesson) {
    const rate = Math.max(speed, 1e-3);
    add(0, duration, 0, rate, t, false);
    if (playing) for (let clock = (duration - t) / rate, n = 0; clock < horizon && n < 8; clock += duration / rate, n++) add(0, duration, clock, rate, 0, false);
    return out;
  }
  const steps = lesson.steps;
  let i = lesson.i;
  let st = steps[i];
  let clock: number;
  if (lesson.phase === "turn") {
    const elapsed = (nowMs - (lesson.turnEnds - lesson.turnLength)) / 1000;
    add(st.start, st.end, 0, 1, st.start - TURN_LEAD + elapsed, true);
    clock = Math.max(0, (lesson.turnEnds - nowMs) / 1000);
  } else {
    const rate = Math.max(speed, 1e-3);
    add(st.start, st.end, 0, rate, t, false);
    if (!playing) return out;
    clock = (st.end - t) / rate;
    // watching: the step's remaining repeats, then your turn; beside your ghost it plays once, then the next step
    if (lesson.phase === "watch") {
      for (let r = lesson.rep + 1; r < (st.repeat ?? 2) && clock < horizon; r++) {
        add(st.start, st.end, clock, rate, st.start, false);
        clock += (st.end - st.start) / rate;
      }
      if (clock < horizon) add(st.start, st.end, clock + TURN_LEAD, 1, st.start, true);
      clock += st.end - st.start + 1.5;
    }
  }
  if (!playing) return out;
  for (let n = 0; clock < horizon && n < 4; n++) {
    i = (i + 1) % steps.length;
    st = steps[i];
    const rate = st.speed ?? 0.5;
    for (let r = 0; r < (st.repeat ?? 2) && clock < horizon; r++) {
      add(st.start, st.end, clock, rate, st.start, false);
      clock += (st.end - st.start) / rate;
    }
    if (clock < horizon) add(st.start, st.end, clock + TURN_LEAD, 1, st.start, true);
    clock += st.end - st.start + 1.5;
  }
  return out;
}

export type Kind = "on" | "early" | "late";
export interface Verdict {
  kind: Kind;
  ms: number; // your strum minus the beat (negative: early)
  down: boolean;
  k: number;
}

interface Due {
  k: number;
  down: boolean;
  at: number; // real seconds when the clip passed it
  turn: boolean;
  verdict: Verdict | null;
}

/**
 * Judges your strums against the teacher's. A beat falls due as the clip passes it; a strum within WINDOW of a beat
 * going the same way is taken as meant for it (on the beat within ON_BEAT, else early or late); a strum near no beat,
 * or going the other way (the hand coming back up between down strums), is ignored, never counted against you. A beat
 * nobody strummed counts as missed once you've started playing in this step. Scrubbing, a repeat starting over or a
 * new step is a new pass: the beats skipped over are never due.
 */
export class RhythmJudge {
  stats = { on: 0, early: 0, late: 0, missed: 0 };
  streak = 0;
  best = 0;
  playing = false; // you've strummed in this step
  last: Verdict | null = null;
  lastAt = -Infinity;
  private prev: { t: number; seg: string } | null = null;
  private due: Due[] = [];
  private pending: { down: boolean; at: number }[] = [];
  private lastStrum = { at: -Infinity, down: true };
  readonly strums: Strums;

  constructor(strums: Strums) {
    this.strums = strums;
  }

  resetStep() {
    this.stats = { on: 0, early: 0, late: 0, missed: 0 };
    this.streak = 0;
    this.playing = false;
    this.due = [];
    this.pending = [];
  }

  /** On-beat strums over every beat judged this step (missed included); null before anything's judged. */
  accuracy(): number | null {
    const { on, early, late, missed } = this.stats;
    const n = on + early + late + missed;
    return n ? on / n : null;
  }

  /** Once a frame: the beats that fell due this frame (for a tick on your turn), and any early strums now judged. */
  advance(clock: LaneClock | null, now: number): { due: Due[]; verdicts: Verdict[] } {
    const fresh: Due[] = [];
    const verdicts: Verdict[] = [];
    if (clock) {
      const p = this.prev;
      const sameRun = p && p.seg === clock.seg && clock.t >= p.t && clock.t - p.t < 0.25;
      if (sameRun) {
        this.strums.times.forEach((s, k) => {
          if (s > p!.t && s <= clock.t && s >= clock.lo && s <= clock.hi) {
            const d: Due = { k, down: this.strums.down[k], at: now - (clock.t - s) / clock.speed, turn: clock.seg.endsWith(":turn"), verdict: null };
            this.due.push(d);
            fresh.push(d);
            // an early strum waiting for this beat
            const w = this.pending.findIndex((q) => q.down === d.down && Math.abs(q.at - d.at) <= WINDOW);
            if (w >= 0) {
              verdicts.push(this.judge(d, this.pending[w].at));
              this.pending.splice(w, 1);
            }
          }
        });
      }
      this.prev = { t: clock.t, seg: clock.seg };
    } else this.prev = null;
    // beats nobody played, and strums meant for nothing
    this.due = this.due.filter((d) => {
      if (now - d.at <= WINDOW + 0.25) return true; // kept a little longer, to colour the lane
      if (!d.verdict && this.playing) {
        this.stats.missed++;
        this.streak = 0;
      }
      return false;
    });
    this.pending = this.pending.filter((q) => now - q.at <= WINDOW);
    return { due: fresh, verdicts };
  }

  /** Your strum (guitar.ts): judged now if its beat has passed, else held for a beat coming within WINDOW. */
  strum(down: boolean, now: number): Verdict | null {
    const gap = now - this.lastStrum.at;
    if (gap < 0.04 || (gap < DEBOUNCE && down === this.lastStrum.down)) return null;
    this.lastStrum = { at: now, down };
    this.playing = true;
    let best: Due | null = null;
    for (const d of this.due) if (!d.verdict && d.down === down && Math.abs(now - d.at) <= WINDOW && (!best || Math.abs(now - d.at) < Math.abs(now - best.at))) best = d;
    if (best) return this.judge(best, now);
    this.pending.push({ down, at: now });
    return null;
  }

  /** How the beat k was played, if it fell due lately (to colour the lane): null while it can still be played. */
  stateOf(k: number, now: number): Kind | "missed" | null {
    for (let n = this.due.length - 1; n >= 0; n--) {
      const d = this.due[n];
      if (d.k === k) return d.verdict?.kind ?? (this.playing && now - d.at > WINDOW ? "missed" : null);
    }
    return null;
  }

  private judge(d: Due, at: number): Verdict {
    const err = at - d.at;
    const kind: Kind = Math.abs(err) <= ON_BEAT ? "on" : err < 0 ? "early" : "late";
    d.verdict = { kind, ms: Math.round(err * 1000), down: d.down, k: d.k };
    this.stats[kind]++;
    if (kind === "on") {
      this.streak++;
      this.best = Math.max(this.best, this.streak);
    } else this.streak = 0;
    this.last = d.verdict;
    this.lastAt = at;
    return d.verdict;
  }
}
