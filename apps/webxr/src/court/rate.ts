// The headset's display rate against the show's. The show is baked for court.video.displayHz (72, or 90 with ?hz=90):
// at that rate the clock shows one show frame per XR frame; at any other it plays through the clock's cadence (every
// show frame on time, some held for two XR frames). court.ts asks the session for the show's rate at the start when
// the session offers it, then judges the rate it runs at: frame for frame, the bundle's 90 Hz bake (a headset that
// can't run the show's rate but can run 90), or a mismatch, logged and shown in ?stats. DOM-free (rate.test.ts).

/** How close two rates must be to count as the same, Hz (supportedFrameRates are Float32: 72.0 may read 71.99...). */
const SAME_HZ = 0.5;

const same = (a: number, b: number): boolean => Math.abs(a - b) < SAME_HZ;

/** What the session's rate means for the show: see judgeRate. */
export type RateVerdict = "matched" | "hz90" | "mismatch" | "unknown";

/** The rate court.ts saw at the session's start (the probe's snapshot and ?stats report it). */
export interface XrRate {
  /** The session's frameRate, Hz (null: none reported). */
  rate: number | null;
  /** The session's supportedFrameRates. */
  supported: number[];
  /** What court.ts asked updateTargetFrameRate for (null: nothing). */
  requested: number | null;
  /** The show's displayHz (the stream in use). */
  showHz: number;
  verdict: RateVerdict;
}

/** The rate to ask the session for: the show's own, as the session lists it, when it is on offer; else null. */
export function wantRate(showHz: number, supported: ArrayLike<number> | null | undefined): number | null {
  for (const r of Array.from(supported ?? [])) if (same(r, showHz)) return r;
  return null;
}

/**
 * The verdict on the rate the session runs at: "matched" (the show's own rate: frame for frame), "hz90" (the headset
 * can't run the show's rate, the bundle has a 90 Hz bake `hz90` and the headset runs or offers 90: switch to it),
 * "mismatch" (play through the clock's cadence and say so), "unknown" (no rate reported: the clock estimates it).
 * `hz90` is the bake's displayHz, or null when the bundle has none or it is already the stream in use.
 */
export function judgeRate(showHz: number, rate: number | null | undefined, supported: ArrayLike<number> | null | undefined, hz90: number | null): RateVerdict {
  if (!rate) return "unknown";
  if (same(rate, showHz)) return "matched";
  if (hz90 !== null && (same(rate, hz90) || wantRate(hz90, supported) !== null)) return "hz90";
  return "mismatch";
}
