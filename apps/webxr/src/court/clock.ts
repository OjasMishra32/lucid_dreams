// The show clock, in show frames: pass 1 (1x), pass 2 (court.video.pass2Speed, Step into the court live), the ease
// ladder and its cutoff, a press in pass 1 armed for pass 2, the freeze on F, the resume through the make, the repeat. Every speed
// change is baked into the stream, so the clock only picks which show frame is on screen: it steps whole show frames
// (Cadence: round(dt x displayHz) at a matched display rate, displayHz / outputHz per frame at any other) and switches
// segments at their edges (never a seek, never a playbackRate).
// DOM-free (clock.test.ts imports it under node). Stream C (`core`) builds the Clock class; the curve functions below
// are the contract between the bake (bake_show.py, standin.mjs) and the clock, written at T0 and tested now.
import type { Court, ShowFrame } from "./format";

/** True once stream C has built the Clock class (the e2e report lists the modules still stubbed). */
export const BUILT = true;

/** Pass 1 plays at real speed. (Pass 2's speed is the bundle's: court.video.pass2Speed; every ease starts at it.) */
export const PASS1_SPEED = 1;
/** The resume eases 0 -> pass 2's speed over this long (P18: <= 0.02 per display frame). */
export const RESUME_RAMP_S = 0.8;
/** The ease ladder's lengths, seconds, earliest start first (1.2 s starts 0.36 s of real time before F). */
export const EASE_SECONDS: readonly number[] = [1.2, 1.0, 0.8];

/** Show frames to advance for one XR frame of `dt` seconds at a matched display rate (P6: round(dt x displayHz)). */
export function stepFrames(dt: number, displayHz: number): number {
  return Math.max(0, Math.round(dt * displayHz));
}

/** Display rates an output rate snaps to within SNAP (after the show's own rate, which always wins), Hz. */
const STANDARD_HZ: readonly number[] = [24, 25, 30, 48, 50, 60, 72, 75, 80, 90, 100, 120, 144, 165, 240];
/** How close an output rate must be to snap, as a fraction (72 and 75 Hz stay apart)... */
const SNAP = 0.02;
/** ...or, for an estimate, within this many times its uncertainty (a few jittered frame times can't tell 72 from 70). */
const SNAP_ERRORS = 3;
/** Frame times kept for the output-rate estimate when the XR session doesn't give one (a desktop capture). */
const RATE_SAMPLES = 121;
/** The newest frame times whose median is the rough period (only to count each frame's periods for the estimate). */
const ROUGH_SAMPLES = 15;
/** Frame times longer than this (a hitch, a tab in the background) never enter the estimate, seconds. */
const RATE_MAX_DT = 0.05;

/**
 * Show frames per output frame at any display rate. Each output frame counts the output periods it spans,
 * round(dt x outputHz), which shrugs off +-10% jitter and counts a dropped frame as 2; a Bresenham accumulator turns
 * periods into show frames at displayHz / outputHz, so the show keeps real time at 60, 90 or 120 Hz and steps as
 * evenly as it can (72 on 90: 4 of every 5 frames). At a matched rate that is exactly stepFrames, frame for frame.
 * outputHz is the XR session's frameRate when known (setOutputHz); else it is estimated from the frame times (the
 * time they span over the periods they count, the periods read against their median), snapped to a standard rate.
 */
export class Cadence {
  readonly showHz: number;
  private known: number | null = null;
  private readonly dts = new Float64Array(RATE_SAMPLES);
  private readonly rough = new Float64Array(ROUGH_SAMPLES);
  private count = 0;
  private next = 0;
  /** Show frames owed, a fraction: starts half a frame in so steps land mid-period; reset whenever the rate matches. */
  private owed = 0.5;
  /** The last estimate: its rate, Hz, and its relative uncertainty (Infinity from one frame time). */
  private readonly estimated = { hz: 0, error: Infinity };

  constructor(showHz: number) {
    this.showHz = showHz;
  }

  /** The XR session's frameRate; null, undefined or 0 estimates it from the frame times. */
  setOutputHz(hz: number | null | undefined): void {
    this.known = hz && hz > 0 ? hz : null;
  }

  /**
   * The output rate in use, Hz: the session's, or the estimate; snapped to the show's rate, else the nearest standard
   * rate, within SNAP (an estimate: within SNAP or SNAP_ERRORS times its uncertainty, whichever is wider); the show's before any frame.
   */
  outputHz(): number {
    let hz = this.known;
    let band = SNAP;
    if (hz === null) {
      if (!this.estimate()) return this.showHz;
      hz = this.estimated.hz;
      band = Math.max(SNAP, SNAP_ERRORS * this.estimated.error);
    }
    if (Math.abs(hz / this.showHz - 1) <= band) return this.showHz;
    let best: number | null = null;
    for (const c of STANDARD_HZ) if (Math.abs(hz / c - 1) <= band && (best === null || Math.abs(hz - c) < Math.abs(hz - best))) best = c;
    return best ?? hz;
  }

  /** Show frames to advance for one output frame of `dt` seconds. */
  steps(dt: number): number {
    if (dt > 0 && dt <= RATE_MAX_DT) {
      this.dts[this.next] = dt;
      this.next = (this.next + 1) % RATE_SAMPLES;
      this.count = Math.min(this.count + 1, RATE_SAMPLES);
    }
    const out = this.outputHz();
    const periods = stepFrames(dt, out);
    if (out === this.showHz) {
      this.owed = 0.5; // matched: P6's cadence exactly
      return periods;
    }
    this.owed += (periods * this.showHz) / out;
    const n = Math.floor(this.owed);
    this.owed -= n;
    return n;
  }

  /** Estimate the output rate from the kept frame times into `estimated`; false before any. */
  private estimate(): boolean {
    if (!this.count) return false;
    // the rough period: the median of the newest few (an insertion sort into a scratch array, no allocation)
    const m = Math.min(this.count, ROUGH_SAMPLES);
    const r = this.rough;
    for (let i = 0; i < m; i++) {
      const x = this.dts[(this.next - 1 - i + RATE_SAMPLES) % RATE_SAMPLES];
      let j = i - 1;
      for (; j >= 0 && r[j] > x; j--) r[j + 1] = r[j];
      r[j + 1] = x;
    }
    const period = r[(m - 1) >> 1];
    // the rate: the periods counted over the time they span; its uncertainty: how far the frames stray from that line
    // (vsync-locked times stay within a frame's jitter, so it shrinks as 1/n; times that wander, as 1/sqrt(n))
    const first = this.count < RATE_SAMPLES ? 0 : this.next;
    let time = 0;
    let periods = 0;
    for (let i = 0; i < this.count; i++) {
      const dt = this.dts[(first + i) % RATE_SAMPLES];
      time += dt;
      periods += Math.max(1, Math.round(dt / period));
    }
    const slope = time / periods;
    let t = 0;
    let k = 0;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < this.count; i++) {
      const dt = this.dts[(first + i) % RATE_SAMPLES];
      t += dt;
      k += Math.max(1, Math.round(dt / period));
      const off = t - slope * k;
      lo = Math.min(lo, off);
      hi = Math.max(hi, off);
    }
    this.estimated.hz = periods / time;
    this.estimated.error = this.count > 1 ? (hi - lo) / time : Infinity;
    return true;
  }
}

/** 6u^5 - 15u^4 + 10u^3 on [0, 1] (C2: zero slope and curvature at both ends). */
export function smootherstep(u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
}

/** The integral of smootherstep from 0 to u. */
function smootherstepIntegral(u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return x ** 6 - 3 * x ** 5 + 2.5 * x ** 4;
}

/** Share (0-1) of an ease's distance covered at u = elapsed / length, speed following 1 - smootherstep. */
export function easeTravel(u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return 2 * (x - smootherstepIntegral(x));
}

/** Share (0-1) of the resume ramp's distance covered at u = elapsed / ramp length, speed following smootherstep. */
export function rampTravel(u: number): number {
  return 2 * smootherstepIntegral(u);
}

/** Frames in an ease (or ramp) of `seconds` at `displayHz`. */
export function easeFrameCount(seconds: number, displayHz: number): number {
  return Math.round(seconds * displayHz);
}

/**
 * Real time (seconds, relative to F; negative before it) of an ease's frame k = 1..n, for an ease of n frames entered
 * at `speed` (pass 2's). Frame n is F (0); frame 0 would be the pass-2 frame it is entered from, -speed * n / displayHz / 2.
 */
export function easeTau(k: number, n: number, displayHz: number, speed: number): number {
  const distance = (speed * n) / displayHz / 2;
  return -distance * (1 - easeTravel(k / n));
}

/** Real time after F (seconds) of the resume's frame k = 1.., ramping 0 -> `speed` (pass 2's) over n frames, then steady. */
export function resumeTau(k: number, n: number, displayHz: number, speed: number): number {
  const ramp = (speed * n) / displayHz / 2;
  return k <= n ? ramp * rampTravel(k / n) : ramp + (speed * (k - n)) / displayHz;
}

/** Playback speed (x real time) at an ease's frame k of n. */
export function easeSpeed(k: number, n: number, speed: number): number {
  return speed * (1 - smootherstep(k / n));
}

/** Playback speed at the resume's frame k with a ramp of n frames. */
export function resumeSpeed(k: number, n: number, speed: number): number {
  return speed * smootherstep(k / n);
}

/** `to` when it doesn't follow `from` in the stream (a jump the second decoder must prime), else null. */
function jumpTo(from: number, to: number): number | null {
  return to === from + 1 ? null : to;
}

/** Which part of the show is on screen. "freeze" holds F (after an ease lands, until resume()). */
export type Segment = "pass1" | "pass2" | "ease" | "freeze" | "resume" | "ended";

export interface ClockState {
  /** The show frame on screen (an index into the stream and frames.json). */
  frame: number;
  segment: Segment;
  /** The ease playing (index into video.segments.eases) while segment is "ease"; else null. */
  ease: number | null;
  /** Playback speed relative to real time: 1 in pass 1, court.video.pass2Speed in pass 2, 0 frozen. */
  speed: number;
  /** The ease a press now would take (or the armed one); null after the cutoff or outside pass 1-2. */
  nextEase: number | null;
  /**
   * The next show frame the clock will jump to that doesn't follow the one on screen in the stream (an ease's first
   * frame, pass 2's start for the repeat, the resume's first frame); null when the next segment is contiguous. The
   * second decoder primes it, so no jump ever needs a reset or a seek (P5).
   */
  nextJump: number | null;
  /** A press is waiting: made in pass 1 (for pass 2's first ease) or after the cutoff (for the next pass). */
  armed: boolean;
  /** Times pass 2 has started (0 during pass 1). */
  pass: number;
  /** Frames into the current segment (0 on its first frame). */
  segmentFrame: number;
}

/**
 * The show clock. Construct from the bundle; call update(dt) once per XR frame with the frame's own dt (never wall
 * time between frames: the e2e steps it at a fixed 1/72 s), then show `state.frame`. Presses and the resume only change
 * what the next steps do, so every show frame comes from the stream in order except at a jump, and every jump is named
 * in `state.nextJump` before it happens.
 */
export class Clock {
  readonly state: ClockState;
  private readonly court: Court;
  private readonly frames: readonly ShowFrame[];
  /** The ease pass 2 takes at its start frame (a press before the cutoff, or the armed stop carried into this pass). */
  private take: number | null = null;
  /** A press in pass 1 or after the cutoff: the next pass 2 takes the first ease. */
  private armNext = false;
  /** resume() was called in the freeze: the next step enters the resume. */
  private resuming = false;
  private readonly cadence: Cadence;

  constructor(court: Court, frames: readonly ShowFrame[]) {
    this.court = court;
    this.frames = frames;
    this.cadence = new Cadence(court.video.displayHz);
    const first = court.video.segments.pass1[0];
    this.state = { frame: first, segment: "pass1", ease: null, speed: PASS1_SPEED, nextEase: 0, nextJump: null, armed: false, pass: 0, segmentFrame: 0 };
    this.restart();
  }

  /** The display's frame rate: the XR session's frameRate when it has one (at start and on frameratechange); null estimates it from dt. */
  setOutputHz(hz: number | null | undefined): void {
    this.cadence.setOutputHz(hz);
  }

  /** The output rate the cadence is using, Hz (for the frame log). */
  outputHz(): number {
    return this.cadence.outputHz();
  }

  /** Advance by the cadence's show frames for this output frame (round(dt x displayHz) at a matched rate) across segment edges, one frame at a time; returns the state. */
  update(dt: number): ClockState {
    for (let n = this.cadence.steps(dt); n > 0; n--) this.step();
    this.refresh();
    return this.state;
  }

  /** Step into the court: take the next ease still ahead, arm it in pass 1, or arm the next pass after the cutoff. */
  press(): void {
    const s = this.state;
    if (s.segment === "pass1") this.armNext = true;
    else if (s.segment === "pass2" && this.take === null) {
      const k = this.easeAhead(s.frame);
      if (k === null) this.armNext = true;
      else this.take = k;
    }
    this.refresh();
  }

  /** From the freeze, play on through the make (the resume segment). */
  resume(): void {
    if (this.state.segment !== "freeze") return;
    this.resuming = true;
    this.refresh();
  }

  /** Back to pass 1's first frame (See my room during the watch restarts it; Replay). */
  restart(): void {
    Object.assign(this.state, { frame: this.court.video.segments.pass1[0], segment: "pass1", ease: null, speed: PASS1_SPEED, pass: 0, segmentFrame: 0 });
    this.take = null;
    this.armNext = false;
    this.resuming = false;
    this.refresh();
  }

  /** Straight to F, frozen (See my room mid-ease finishes the hand-off under the fade). */
  jumpToFreeze(): void {
    const eases = this.court.video.segments.eases;
    const k = this.state.ease ?? this.take ?? this.state.nextEase ?? 0;
    this.take = null;
    this.armNext = false;
    this.resuming = false;
    Object.assign(this.state, { frame: eases[k].frames[1], segment: "freeze", ease: null, speed: 0, segmentFrame: 0 });
    this.refresh();
  }

  /** The first ease whose start is still ahead of (or on) pass-2 frame `frame`, if it is not past the cutoff. */
  private easeAhead(frame: number): number | null {
    const v = this.court.video;
    if (frame > v.cutoff) return null;
    const eases = v.segments.eases;
    for (let k = 0; k < eases.length; k++) if (eases[k].start >= frame) return k;
    return null;
  }

  private enter(segment: Segment, frame: number): void {
    this.state.segment = segment;
    this.state.frame = frame;
    this.state.segmentFrame = 0;
  }

  /** One show frame on. */
  private step(): void {
    const s = this.state;
    const seg = this.court.video.segments;
    switch (s.segment) {
      case "pass1":
        if (s.frame < seg.pass1[1]) {
          s.frame++;
          s.segmentFrame++;
        } else this.startPass2();
        break;
      case "pass2":
        if (this.take !== null && s.frame === seg.eases[this.take].start) {
          s.ease = this.take;
          this.take = null;
          this.enter("ease", seg.eases[s.ease].frames[0]);
        } else if (s.frame < seg.pass2[1]) {
          s.frame++;
          s.segmentFrame++;
        } else this.startPass2();
        break;
      case "ease":
        s.frame++;
        s.segmentFrame++;
        if (s.frame >= seg.eases[s.ease!].frames[1]) {
          s.ease = null;
          this.enter("freeze", s.frame);
        }
        break;
      case "freeze":
        if (this.resuming) {
          this.resuming = false;
          this.enter("resume", seg.resume[0]);
        }
        break;
      case "resume":
        if (s.frame < seg.resume[1]) {
          s.frame++;
          s.segmentFrame++;
        } else this.enter("ended", s.frame);
        break;
      case "ended":
        break;
    }
  }

  /** Pass 2 from its first frame (after pass 1, and every repeat); an armed stop becomes this pass's first ease. */
  private startPass2(): void {
    const s = this.state;
    s.segment = "pass2";
    s.frame = this.court.video.segments.pass2[0];
    s.segmentFrame = 0;
    s.pass++;
    if (this.armNext) {
      this.armNext = false;
      this.take = 0;
    }
  }

  /** speed, nextEase, nextJump and armed for the state as it now stands. */
  private refresh(): void {
    const s = this.state;
    const v = this.court.video;
    const seg = v.segments;
    const ramp = easeFrameCount(RESUME_RAMP_S, v.displayHz);
    s.armed = this.armNext || this.take !== null;
    switch (s.segment) {
      case "pass1":
        s.speed = PASS1_SPEED;
        s.nextEase = 0;
        // a press now (or the armed stop) takes the first ease in pass 2: prime it once pass 2's start needs no priming
        s.nextJump = jumpTo(seg.pass1[1], seg.pass2[0]) ?? seg.eases[0].frames[0];
        break;
      case "pass2": {
        s.speed = v.pass2Speed;
        s.nextEase = this.take ?? (this.armNext ? 0 : this.easeAhead(s.frame));
        const easeNow = this.take ?? (this.armNext ? null : this.easeAhead(s.frame));
        s.nextJump = easeNow !== null ? seg.eases[easeNow].frames[0] : seg.pass2[0];
        break;
      }
      case "ease": {
        const [e0, e1] = seg.eases[s.ease!].frames;
        s.speed = easeSpeed(s.frame - e0 + 1, e1 - e0 + 1, v.pass2Speed);
        s.nextEase = null;
        s.nextJump = jumpTo(e1, seg.resume[0]);
        break;
      }
      case "freeze":
        s.speed = 0;
        s.nextEase = null;
        s.nextJump = jumpTo(s.frame, seg.resume[0]);
        break;
      case "resume":
        s.speed = resumeSpeed(s.segmentFrame + 1, ramp, v.pass2Speed);
        s.nextEase = null;
        s.nextJump = null;
        break;
      case "ended":
        s.speed = 0;
        s.nextEase = null;
        s.nextJump = seg.pass1[0]; // Replay
        break;
    }
  }
}
