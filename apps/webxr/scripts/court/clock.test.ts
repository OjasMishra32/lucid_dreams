// clock.ts's curve contract (shared by the bake and the clock): the eases land exactly on F from pass 2's speed, speed changes
// stay under 0.02 per display frame (P6, P18), and the stand-in's show obeys them; then the Clock (stream C): passes,
// the ladder, the cutoff, the armed stop, nextJump, the resume, at 72 and 90 Hz.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Cadence, EASE_SECONDS, RESUME_RAMP_S, easeFrameCount, easeSpeed, easeTau, easeTravel, rampTravel, resumeSpeed, resumeTau,
  smootherstep, stepFrames,
} from "../../src/court/clock.ts";
import { standinBundle } from "./standin.mjs";

/** Pass 2's speed comes from the bundle (court.video.pass2Speed); the stand-in's is made up. */
const PASS2_SPEED: number = standinBundle().court.video.pass2Speed;

const close = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test("smootherstep is 0 and 1 at the ends with flat ends", () => {
  close(smootherstep(0), 0);
  close(smootherstep(1), 1);
  close(smootherstep(0.5), 0.5);
  close(smootherstep(-1), 0);
  close(smootherstep(2), 1);
  const slope = (u: number) => (smootherstep(u + 1e-6) - smootherstep(u - 1e-6)) / 2e-6;
  close(slope(1e-3), 0, 1e-4);
  close(slope(1 - 1e-3), 0, 1e-4);
});

test("travel runs 0 -> 1 and is monotonic", () => {
  for (const travel of [easeTravel, rampTravel]) {
    close(travel(0), 0);
    close(travel(1), 1);
    let last = -1;
    for (let u = 0; u <= 1; u += 0.01) {
      assert.ok(travel(u) >= last);
      last = travel(u);
    }
  }
});

test("step = round(dt x displayHz) at 72 and 90 Hz", () => {
  assert.equal(stepFrames(1 / 72, 72), 1);
  assert.equal(stepFrames(1 / 90, 90), 1);
  assert.equal(stepFrames(2 / 72, 72), 2);
  assert.equal(stepFrames(1 / 120, 72), 1);
  assert.equal(stepFrames(0.004, 72), 0);
  assert.equal(stepFrames(1 / 90, 72), 1);
});

for (const seconds of EASE_SECONDS)
  test(`the ${seconds} s ease leaves pass 2's speed without a step, lands exactly on F and never changes speed by 0.02 a frame`, () => {
    const n = easeFrameCount(seconds, 72);
    close(easeTau(n, n, 72, PASS2_SPEED), 0);
    // entering from pass 2: the first step is a pass-2-speed step
    const first = (easeTau(1, n, 72, PASS2_SPEED) - easeTau(0, n, 72, PASS2_SPEED)) * 72;
    close(first, PASS2_SPEED, 0.002);
    let prev = PASS2_SPEED;
    for (let k = 1; k <= n; k++) {
      const s = easeSpeed(k, n, PASS2_SPEED);
      assert.ok(Math.abs(s - prev) <= 0.02, `frame ${k}: ${prev} -> ${s}`);
      prev = s;
    }
    close(prev, 0);
    // it starts speed x seconds / 2 of real time before F
    close(-easeTau(0, n, 72, PASS2_SPEED), (PASS2_SPEED * n) / 72 / 2);
  });

test("the resume ramps 0 -> pass 2's speed over 0.8 s within 0.02 a frame, then plays at it", () => {
  const n = easeFrameCount(RESUME_RAMP_S, 72);
  let prev = 0;
  for (let k = 1; k <= n; k++) {
    const s = resumeSpeed(k, n, PASS2_SPEED);
    assert.ok(Math.abs(s - prev) <= 0.02, `frame ${k}: ${prev} -> ${s}`);
    prev = s;
  }
  close(prev, PASS2_SPEED);
  close((resumeTau(n + 10, n, 72, PASS2_SPEED) - resumeTau(n + 9, n, 72, PASS2_SPEED)) * 72, PASS2_SPEED, 1e-9);
});

test("the stand-in's show follows the contract: every ease ends on F, pass 2 runs at its speed on real frames", () => {
  const { court, frames } = standinBundle();
  const v = court.video;
  for (const e of v.segments.eases) assert.equal(frames[e.frames[1]].src, v.freezeSource);
  const per = court.camera.sourceFps * court.camera.slow;
  for (let i = v.segments.pass2[0] + 1; i <= v.segments.pass2[1]; i++) {
    close(((frames[i].src - frames[i - 1].src) / per) * v.displayHz, v.pass2Speed, 1e-9);
    assert.equal(frames[i].interp, false);
  }
  // pass 1 at 1x: one display frame in two is a real frame (the stand-in's made-up 180 fps capture)
  const p1 = frames.slice(v.segments.pass1[0], v.segments.pass1[1] + 1);
  const real = p1.filter((f) => !f.interp).length / p1.length;
  close(real, 1 / 2, 0.01);
  assert.equal(v.cutoff, v.segments.eases[v.segments.eases.length - 1].start);
});

// ---------------- the Clock (stream C) ----------------
import { Clock, type ClockState } from "../../src/court/clock.ts";
import type { Court, ShowFrame } from "../../src/court/format.ts";

/** A show at `hz` built from the curve contract the way the bake builds it (pass 1 at 1x, pass 2 at pass2Speed, the ladder, the resume). */
function show(hz: number): { court: Court; frames: ShowFrame[] } {
  const base = standinBundle().court;
  const F = base.video.freezeSource;
  const taus: number[] = [];
  const range = (fill: () => void): [number, number] => {
    const first = taus.length;
    fill();
    return [first, taus.length - 1];
  };
  const pass1 = range(() => {
    for (let n = 0; n < Math.round(2.7 * hz); n++) taus.push(-2.4 + n / hz);
  });
  const sp = base.video.pass2Speed;
  const per = base.camera.sourceFps * base.camera.slow;
  const step2 = sp / hz;
  const pass2 = range(() => {
    for (let j = 0; -1.2 + j * step2 <= 1.3 + 1e-9; j++) taus.push(-1.2 + j * step2);
  });
  const eases = EASE_SECONDS.map((seconds) => {
    const n = easeFrameCount(seconds, hz);
    const j = Math.round((easeTau(0, n, hz, sp) + 1.2) / step2);
    const frames = range(() => {
      for (let k = 1; k <= n; k++) taus.push(easeTau(k, n, hz, sp));
    });
    return { start: pass2[0] + j, frames, seconds: n / hz };
  });
  const ramp = easeFrameCount(RESUME_RAMP_S, hz);
  const resume = range(() => {
    for (let k = 1; resumeTau(k, ramp, hz, sp) <= 1.3 + 1e-9; k++) taus.push(resumeTau(k, ramp, hz, sp));
  });
  const frames = taus.map((tau) => ({ src: F + tau * per, interp: false, q: [0, 0, 0, 1], f: 25000 }) as ShowFrame);
  const video = { ...base.video, displayHz: hz, segments: { pass1, pass2, resume, eases }, cutoff: eases[eases.length - 1].start };
  return { court: { ...base, video }, frames };
}

/** Run the clock n XR frames at its display rate; the state after each (copies). */
function run(clock: Clock, n: number, dt = 1 / clock["court"].video.displayHz): ClockState[] {
  const out: ClockState[] = [];
  for (let i = 0; i < n; i++) out.push({ ...clock.update(dt) });
  return out;
}

/** Frames until the clock first lands on F (segment "freeze"); null if it doesn't within `max`. */
function framesToFreeze(clock: Clock, max = 5000): ClockState[] | null {
  const out: ClockState[] = [];
  for (let i = 0; i < max; i++) {
    const s = { ...clock.update(1 / clock["court"].video.displayHz) };
    out.push(s);
    if (s.segment === "freeze") return out;
  }
  return null;
}

// the stand-in (its real frames snapped within 0.1 frame, as the bake does) and two exact bake-rule shows
for (const [name, bundle] of [["stand-in 72 Hz", standinBundle()], ["bake-rule 72 Hz", show(72)], ["bake-rule 90 Hz", show(90)]] as const) {
  const { court, frames } = bundle;
  const v = court.video;
  const hz = v.displayHz;
  /** Real-time speed is only exact where no frame was snapped to a real one. */
  const exact = name.startsWith("bake-rule");
  const F = v.freezeSource;
  const fresh = () => new Clock(court, frames);
  const srcOf = (s: ClockState) => frames[s.frame].src;
  /** The show's real-time speed between two consecutive states, from the frames' own source times. */
  const realStep = (a: ClockState, b: ClockState) => ((frames[b.frame].src - frames[a.frame].src) / (court.camera.sourceFps * court.camera.slow)) * hz;

  test(`${name}: unpressed, pass 1 plays at 1x, pass 2 at 0.6x through its end, then pass 2 repeats`, () => {
    const c = fresh();
    assert.equal(c.state.frame, v.segments.pass1[0]);
    assert.equal(c.state.segment, "pass1");
    const states = run(c, v.segments.pass1[1] - v.segments.pass1[0] + (v.segments.pass2[1] - v.segments.pass2[0] + 1) + 3);
    let k = 0;
    for (let f = v.segments.pass1[0] + 1; f <= v.segments.pass1[1]; f++, k++) {
      assert.equal(states[k].frame, f);
      assert.equal(states[k].segment, "pass1");
      assert.equal(states[k].speed, 1);
    }
    for (let f = v.segments.pass2[0]; f <= v.segments.pass2[1]; f++, k++) {
      assert.equal(states[k].frame, f, `pass 2 frame ${f}`);
      assert.equal(states[k].segment, "pass2");
      close(states[k].speed, v.pass2Speed);
      assert.equal(states[k].pass, 1);
    }
    assert.equal(states[k].frame, v.segments.pass2[0], "repeat from pass 2's start");
    assert.equal(states[k].pass, 2);
  });

  test(`${name}: a press in pass 1 arms the stop; pass 1 plays out and pass 2 takes the first (longest) ease onto F`, () => {
    for (const at of [0, 10, v.segments.pass1[1] - v.segments.pass1[0]]) {
      const c = fresh();
      run(c, at);
      c.press();
      assert.equal(c.state.armed, true);
      assert.equal(c.state.nextEase, 0);
      const path = framesToFreeze(c)!;
      assert.ok(path, "lands");
      // pass 1 was played out
      const pass1Left = v.segments.pass1[1] - v.segments.pass1[0] - at;
      assert.ok(path.slice(0, pass1Left).every((s) => s.segment === "pass1"));
      const easeFrames = path.filter((s) => s.segment === "ease");
      assert.equal(easeFrames[0].ease, 0);
      assert.equal(easeFrames[0].frame, v.segments.eases[0].frames[0]);
      const last = path[path.length - 1];
      assert.equal(srcOf(last), F, "0 frames off F");
      assert.equal(last.frame, v.segments.eases[0].frames[1]);
      assert.equal(last.speed, 0);
    }
  });

  test(`${name}: every press in pass 2 up to the cutoff lands exactly on F through the next ease start ahead`, () => {
    const [p2a] = v.segments.pass2;
    for (let f = p2a; f <= v.cutoff; f++) {
      const c = fresh();
      run(c, f - v.segments.pass1[0]);
      assert.equal(c.state.frame, f);
      const want = v.segments.eases.findIndex((e) => e.start >= f);
      assert.equal(c.state.nextEase, want, `nextEase at ${f}`);
      c.press();
      const path = framesToFreeze(c)!;
      const last = path[path.length - 1];
      assert.equal(srcOf(last), F, `press at ${f}`);
      assert.equal(path.find((s) => s.segment === "ease")!.ease, want);
      // pass 2 ran on to the ease start, then the ease's own frames: never a skipped or held show frame
      const pre = path.filter((s) => s.segment === "pass2");
      assert.equal(pre.length, v.segments.eases[want].start - f);
    }
  });

  test(`${name}: a press after the cutoff plays pass 2 through the make, and the next pass stops by itself`, () => {
    const c = fresh();
    run(c, v.cutoff + 1 - v.segments.pass1[0]);
    assert.equal(c.state.frame, v.cutoff + 1);
    assert.equal(c.state.nextEase, null);
    c.press();
    assert.equal(c.state.armed, true);
    const path = framesToFreeze(c)!;
    const reachedEnd = path.findIndex((s) => s.frame === v.segments.pass2[1]);
    assert.ok(reachedEnd >= 0, "pass 2 played to its end");
    assert.equal(path[reachedEnd + 1].frame, v.segments.pass2[0]);
    assert.equal(path[reachedEnd + 1].pass, 2);
    assert.equal(path.find((s) => s.segment === "ease")!.ease, 0);
    assert.equal(srcOf(path[path.length - 1]), F);
  });

  test(`${name}: every way into F changes speed by <= 0.02 per display frame, in real show time too`, () => {
    for (let f = v.segments.pass2[0]; f <= v.cutoff; f += 3) {
      const c = fresh();
      run(c, f - v.segments.pass1[0]);
      c.press();
      const path = [{ ...c.state }, ...framesToFreeze(c)!];
      for (let i = 1; i < path.length; i++) {
        assert.ok(Math.abs(path[i].speed - path[i - 1].speed) <= 0.02, `state speed ${path[i - 1].speed} -> ${path[i].speed}`);
        if (exact && i >= 2) {
          const a = realStep(path[i - 2], path[i - 1]);
          const b = realStep(path[i - 1], path[i]);
          assert.ok(Math.abs(a - b) <= 0.02, `real speed ${a} -> ${b} at show frame ${path[i].frame}`);
        }
      }
    }
  });

  test(`${name}: F holds until resume(); the resume ramps 0 -> 0.6x within 0.02 a frame, runs to its end and ends`, () => {
    const c = fresh();
    run(c, 5);
    c.press();
    framesToFreeze(c);
    const held = run(c, 30);
    assert.ok(held.every((s) => s.segment === "freeze" && srcOf(s) === F && s.speed === 0));
    c.press(); // nothing in the freeze
    assert.equal(c.state.segment, "freeze");
    c.resume();
    const [r0, r1] = v.segments.resume;
    const states = run(c, r1 - r0 + 5);
    assert.equal(states[0].frame, r0);
    assert.equal(states[0].segment, "resume");
    let prev = 0;
    let prevReal = 0;
    let last: ClockState = held[held.length - 1];
    for (const s of states.slice(0, r1 - r0 + 1)) {
      assert.ok(Math.abs(s.speed - prev) <= 0.02, `${prev} -> ${s.speed}`);
      const real = realStep(last, s);
      if (exact) assert.ok(Math.abs(real - prevReal) <= 0.02, `real ${prevReal} -> ${real}`);
      prev = s.speed;
      prevReal = real;
      last = s;
    }
    close(prev, v.pass2Speed);
    assert.equal(states[r1 - r0].frame, r1);
    assert.ok(states.slice(r1 - r0 + 1).every((s) => s.segment === "ended" && s.frame === r1));
  });

  test(`${name}: nextJump names every jump before it happens (the second decoder primes it)`, () => {
    const c = fresh();
    let prev = { ...c.state };
    let pressed = false;
    let resumed = false;
    for (let i = 0; i < 4000 && c.state.segment !== "ended"; i++) {
      if (!pressed && c.state.segment === "pass2" && c.state.frame === v.segments.eases[1].start - 2) {
        c.press();
        pressed = true;
        prev = { ...c.state };
      }
      if (!resumed && c.state.segment === "freeze" && i % 7 === 0) {
        c.resume();
        resumed = true;
        prev = { ...c.state };
      }
      const s = { ...c.update(1 / hz) };
      if (s.frame !== prev.frame + 1 && s.frame !== prev.frame) assert.equal(prev.nextJump, s.frame, `jump ${prev.frame} -> ${s.frame} was primed`);
      prev = s;
    }
    assert.ok(pressed && resumed);
    assert.equal(c.state.segment, "ended");
    // pass 2 unpressed before the cutoff primes the ease a press would take; after the cutoff the repeat
    const d = fresh();
    run(d, v.segments.pass2[0] + 1 - v.segments.pass1[0]);
    assert.equal(d.state.nextJump, v.segments.eases[d.state.nextEase!].frames[0]);
    run(d, v.cutoff + 1 - d.state.frame);
    assert.equal(d.state.nextJump, v.segments.pass2[0]);
  });

  test(`${name}: restart goes back to pass 1's start; jumpToFreeze holds F`, () => {
    const c = fresh();
    run(c, 300);
    c.press();
    c.restart();
    assert.equal(c.state.frame, v.segments.pass1[0]);
    assert.equal(c.state.segment, "pass1");
    assert.equal(c.state.armed, false);
    assert.equal(c.state.pass, 0);
    run(c, 3);
    c.jumpToFreeze();
    assert.equal(c.state.segment, "freeze");
    assert.equal(srcOf(c.state), F);
    assert.equal(c.state.speed, 0);
    c.resume();
    assert.equal(c.update(1 / hz).frame, v.segments.resume[0]);
  });

  test(`${name}: at a matched output rate the clock steps round(dt x displayHz) show frames per XR frame`, () => {
    const c = fresh();
    c.setOutputHz(hz); // the XR session's frameRate
    c.update(2 / hz);
    assert.equal(c.state.frame, v.segments.pass1[0] + 2);
    c.update(0.4 / hz);
    assert.equal(c.state.frame, v.segments.pass1[0] + 2);
    c.update(0);
    assert.equal(c.state.frame, v.segments.pass1[0] + 2);
    c.update(1 / 120); // one short frame at the matched rate is jitter: it still advances one show frame (round(0.6) = 1)
    assert.equal(c.state.frame, v.segments.pass1[0] + 3);
  });
}

test("a dropped XR frame (dt = 2 frames) never skips an ease start: the stop still lands on F", () => {
  const { court, frames } = standinBundle();
  const v = court.video;
  for (const start of v.segments.eases.map((e) => e.start)) {
    const c = new Clock(court, frames);
    run(c, start - 1 - v.segments.pass1[0]);
    c.press();
    c.update(2 / 72); // start - 1 -> start -> the ease's first frame
    const path = framesToFreeze(c)!;
    assert.equal(frames[path[path.length - 1].frame].src, v.freezeSource);
  }
});

// ---------------- the cadence at any display rate ----------------

/** A seeded uniform random in [0, 1) (mulberry32), so every jittered run is the same run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n frame times at `hz`, each off by up to `jitter` of a frame either way, independently (P6's jitter: dt itself wanders). */
function dtJitter(hz: number, n: number, jitter = 0.1, seed = 7): number[] {
  const r = random(seed);
  return Array.from({ length: n }, () => (1 + jitter * (2 * r() - 1)) / hz);
}

/** n frame times at `hz` from vsync-locked timestamps, each up to half of `jitter` of a frame late or early (dt within +-jitter), with a dropped frame every `drop`. */
function vsyncJitter(hz: number, n: number, jitter = 0.1, drop = 0, seed = 11): number[] {
  const r = random(seed);
  const out: number[] = [];
  let tick = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    tick += drop && i % drop === drop - 1 ? 2 : 1;
    const t = (tick + (jitter / 2) * (2 * r() - 1)) / hz;
    out.push(t - last);
    last = t;
  }
  return out;
}

for (const hz of [72, 90])
  test(`cadence at a matched rate (${hz}/${hz}): exactly round(dt x displayHz) every frame under +-10% jitter and dropped frames (the session's rate; or estimated from vsync-locked or exact frame times)`, () => {
    const runs: [string, number | null, number[]][] = [
      ["known, dt wandering", hz, dtJitter(hz, 3000)],
      ["known, vsync-locked", hz, vsyncJitter(hz, 3000, 0.1, 37)],
      ["estimated, vsync-locked", null, vsyncJitter(hz, 3000, 0.1, 37)],
      ["estimated, exact (the probe)", null, Array.from({ length: 500 }, () => 1 / hz)],
    ];
    for (const [name, known, dts] of runs) {
      const c = new Cadence(hz);
      c.setOutputHz(known);
      dts.forEach((dt, i) => assert.equal(c.steps(dt), stepFrames(dt, hz), `${name}: frame ${i} (dt ${(dt * hz).toFixed(3)} frames)`));
    }
  });

for (const out of [60, 90, 120])
  test(`cadence at ${out} Hz out for a 72 Hz show: real time within one show frame over 10 s (rate known or estimated, jittered and with dropped frames)`, () => {
    for (const known of [out, null])
      for (const drop of [0, 53]) {
        const c = new Cadence(72);
        c.setOutputHz(known);
        let wall = 0;
        let shown = 0;
        let worst = 0;
        for (const dt of vsyncJitter(out, 10 * out, 0.1, drop)) {
          wall += dt;
          shown += c.steps(dt);
          worst = Math.max(worst, Math.abs(shown / 72 - wall));
        }
        assert.ok(worst <= 1 / 72 + 1e-9, `${known ?? "estimated"} ${out} Hz, drop ${drop}: ${(worst * 72).toFixed(2)} show frames off real time`);
        assert.ok(Math.abs(c.outputHz() - out) < 0.5, `rate ${c.outputHz()}`);
      }
  });

test("cadence steps evenly (Bresenham): 72 Hz on 90 Hz is 4 of every 5 frames, on 120 Hz 3 of every 5, on 60 Hz 1 or 2 (6 per 5)", () => {
  for (const [out, per5] of [[90, [0, 1]], [120, [0, 1]], [60, [1, 2]]] as const) {
    const c = new Cadence(72);
    c.setOutputHz(out);
    const steps = Array.from({ length: 100 }, () => c.steps(1 / out));
    assert.ok(steps.every((n) => (per5 as readonly number[]).includes(n)), `${out} Hz: ${steps.slice(0, 10)}`);
    for (let i = 0; i + 5 <= steps.length; i += 5) assert.equal(steps.slice(i, i + 5).reduce((a, b) => a + b, 0), (72 * 5) / out);
  }
});

test("the Clock under +-10% jitter at 72 Hz shows exactly the frames it shows at an exact 72 Hz, press and stop included", () => {
  const { court, frames } = standinBundle();
  const exact = new Clock(court, frames);
  const jittered = new Clock(court, frames);
  const dts = dtJitter(72, 1500);
  const a: number[] = [];
  const b: number[] = [];
  dts.forEach((dt, i) => {
    if (i === 260) {
      exact.press();
      jittered.press();
    }
    a.push(exact.update(1 / 72).frame);
    b.push(jittered.update(dt).frame);
  });
  assert.deepEqual(b, a);
});

test("the Clock at 120 Hz keeps real time (not 1.67x) and the stop still lands on F one show frame at a time", () => {
  const { court, frames } = standinBundle();
  const v = court.video;
  const c = new Clock(court, frames);
  c.setOutputHz(120);
  const states: ClockState[] = [];
  for (let i = 0; i < 120 * 2; i++) states.push({ ...c.update(1 / 120) });
  // pass 1 plays 1x: 2 s of wall time is 144 show frames
  assert.ok(Math.abs(states.at(-1)!.frame - v.segments.pass1[0] - 144) <= 1, `${states.at(-1)!.frame - v.segments.pass1[0]} frames in 2 s`);
  c.press();
  let prev = { ...c.state };
  for (let i = 0; i < 120 * 30 && c.state.segment !== "freeze"; i++) {
    const s = { ...c.update(1 / 120) };
    if (s.segment === prev.segment && s.ease === prev.ease) assert.ok([0, 1].includes(s.segmentFrame - prev.segmentFrame), `${s.segment}: ${prev.segmentFrame} -> ${s.segmentFrame}`);
    prev = s;
  }
  assert.equal(c.state.segment, "freeze");
  assert.equal(frames[c.state.frame].src, v.freezeSource);
});
