// The show clock, in show frames: pass 1 (1x), pass 2 (0.6x, Step into the court live), the ease ladder and its
// cutoff, a press in pass 1 armed for pass 2, the freeze on F, the resume through the make, the repeat. Every speed
// change is baked into the stream, so the clock only picks which show frame is on screen: it steps
// round(dt x displayHz) frames per XR frame and switches segments at their edges (never a seek, never a playbackRate).
// DOM-free (clock.test.ts imports it under node). Stream C (`core`) builds the Clock class; the curve functions below
// are the contract between the bake (bake_show.py, standin.mjs) and the clock, written at T0 and tested now.
import type { Court, ShowFrame } from "./format";

/** True once stream C has built the Clock class (the e2e report lists the modules still stubbed). */
export const BUILT = false;

/** Pass 1 plays at real speed. */
export const PASS1_SPEED = 1;
/** Pass 2, every ease's start and the resume after its ramp play at 0.6x (120 fps x 0.6 = 72: every display frame real). */
export const PASS2_SPEED = 0.6;
/** The resume eases 0 -> 0.6x over this long (P18: <= 0.02 per display frame). */
export const RESUME_RAMP_S = 0.8;
/** The ease ladder's lengths, seconds, earliest start first (1.2 s starts 0.36 s of real time before F). */
export const EASE_SECONDS: readonly number[] = [1.2, 1.0, 0.8];

/** Show frames to advance for one XR frame of `dt` seconds (P6: round(dt x displayHz)). */
export function stepFrames(dt: number, displayHz: number): number {
  return Math.max(0, Math.round(dt * displayHz));
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
 * at `speed`. Frame n is F (0); frame 0 would be the pass-2 frame it is entered from, -speed * n / displayHz / 2.
 */
export function easeTau(k: number, n: number, displayHz: number, speed = PASS2_SPEED): number {
  const distance = (speed * n) / displayHz / 2;
  return -distance * (1 - easeTravel(k / n));
}

/** Real time after F (seconds) of the resume's frame k = 1.., ramping 0 -> `speed` over n frames, then steady. */
export function resumeTau(k: number, n: number, displayHz: number, speed = PASS2_SPEED): number {
  const ramp = (speed * n) / displayHz / 2;
  return k <= n ? ramp * rampTravel(k / n) : ramp + (speed * (k - n)) / displayHz;
}

/** Playback speed (x real time) at an ease's frame k of n. */
export function easeSpeed(k: number, n: number, speed = PASS2_SPEED): number {
  return speed * (1 - smootherstep(k / n));
}

/** Playback speed at the resume's frame k with a ramp of n frames. */
export function resumeSpeed(k: number, n: number, speed = PASS2_SPEED): number {
  return speed * smootherstep(k / n);
}

/** Which part of the show is on screen. "freeze" holds F (after an ease lands, until resume()). */
export type Segment = "pass1" | "pass2" | "ease" | "freeze" | "resume" | "ended";

export interface ClockState {
  /** The show frame on screen (an index into the stream and frames.json). */
  frame: number;
  segment: Segment;
  /** The ease playing (index into video.segments.eases) while segment is "ease"; else null. */
  ease: number | null;
  /** Playback speed relative to real time: 1 in pass 1, 0.6 in pass 2, 0 frozen. */
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
 * time between frames: the e2e steps it at a fixed 1/72 s), then show `state.frame`.
 */
export class Clock {
  readonly state: ClockState;
  private readonly court: Court;
  private readonly frames: readonly ShowFrame[];

  constructor(court: Court, frames: readonly ShowFrame[]) {
    this.court = court;
    this.frames = frames;
    const first = court.video.segments.pass1[0];
    this.state = { frame: first, segment: "pass1", ease: null, speed: PASS1_SPEED, nextEase: 0, nextJump: null, armed: false, pass: 0, segmentFrame: 0 };
  }

  /** Advance by round(dt x displayHz) show frames across segment edges; returns the new state. Stub: holds pass 1's first frame. */
  update(dt: number): ClockState {
    return this.state;
  }

  /** Step into the court: take the next ease still ahead, arm it in pass 1, or arm the next pass after the cutoff. */
  press(): void {
    throw new Error("Clock.press is not built yet (stream C)");
  }

  /** From the freeze, play on through the make (the resume segment). */
  resume(): void {
    throw new Error("Clock.resume is not built yet (stream C)");
  }

  /** Back to pass 1's first frame (See my room during the watch restarts it; Replay). */
  restart(): void {
    throw new Error("Clock.restart is not built yet (stream C)");
  }

  /** Straight to F, frozen (See my room mid-ease finishes the hand-off under the fade). */
  jumpToFreeze(): void {
    throw new Error("Clock.jumpToFreeze is not built yet (stream C)");
  }
}
