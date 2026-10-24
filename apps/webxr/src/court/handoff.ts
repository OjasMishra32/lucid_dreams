// The hand-off choreography (3.3 steps 1-3, 3.3a: House Lights' pool on Same Pixels' timing) and the hand-back (3.5),
// each one function of time so every part moves together and recordings are deterministic:
// - handoff(t): t seconds from F (negative during the ease). The splats and ball come up under the opaque picture from
//   F - 0.45 to F + 0.3 s; the cinema mask lifts F + 0.1 to F + 1.0 s; the video layer fades F + 0.15 to F + 1.15 s
//   (smootherstep; an exact blend; never splat opacity in, P10); the pool grows F + 1.0 to F + 4.0 s; the stands rise
//   to light.stands F + 3.0 to F + 5.0 s. court.ts finishes the fade within 0.3 s if the head rises > 10 cm.
// - handback(t): t seconds from the sit (the world re-seated at the dolly seat): the video layer fades back in over
//   the 3D from 0.1 s before the sit ends, over 1.3 s, then the cinema mask closes (P18).
// Pure (handoff.test.ts calls it under node with recording fakes): type-only imports. Stream D builds it.
import type { CourtWorld } from "./world";
import type { Freeze } from "./freeze";
import type { LightField } from "./lightfield";
import type { Proxies } from "./proxies";
import type { Sound } from "./sound";
import type { ShowVideo } from "./video";

/** True once stream D has built this module. */
export const BUILT = false;

/** Everything the hand-off moves. */
export interface HandoffParts {
  /** opacity (the video layer, over the 3D) and mask(p) (the cinema mask). */
  video: ShowVideo;
  /** dim(p) where the plate leaves the camera ray. */
  proxies: Proxies;
  /** open(p). */
  world: CourtWorld;
  /** reveal(p). */
  freeze: Freeze;
  /** timeStop(p) as the hush lifts. */
  sound: Sound;
  /** set("handoff", t) / set("return", t): the pool and the levels. */
  light: LightField;
}

/** The beats, seconds from F (3.3). */
export const BEATS = {
  splatsUp: [-0.45, 0.3],
  maskLifts: [0.1, 1.0],
  videoFades: [0.15, 1.15],
  poolGrows: [1.0, 4.0],
  standsRise: [3.0, 5.0],
} as const;
/** The hand-off is done (the world open) this long after F. */
export const HANDOFF_END = 5.0;
/** The hand-back's beats, seconds from the end of the sit (3.5). */
export const BACK_BEATS = { videoReturns: [-0.1, 1.2], maskCloses: [1.2, 1.8] } as const;
/** The hand-back is done (the picture back on F) this long after the sit. */
export const HANDBACK_END = 1.8;

/** Drive every part for t seconds from F. Stub: no-op. */
export function handoff(t: number, parts: HandoffParts): void {}

/** Drive every part back for t seconds from the sit. Stub: no-op. */
export function handback(t: number, parts: HandoffParts): void {}
