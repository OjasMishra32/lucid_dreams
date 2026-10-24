// The hand-off choreography (3.3 steps 1-3, 3.3a: House Lights' pool on Same Pixels' timing) and the hand-back (3.5),
// each one function of time so every part moves together and recordings are deterministic:
// - handoff(t): t seconds from F (negative during the ease). The splats and ball come up under the opaque picture from
//   F - 0.45 to F + 0.3 s; the cinema mask lifts F + 0.1 to F + 1.0 s; the video layer fades F + 0.15 to F + 1.15 s
//   (smootherstep; an exact blend; never splat opacity in, P10); the pool grows F + 1.0 to F + 4.0 s; the stands rise
//   to light.stands F + 3.0 to F + 5.0 s (both lightfield.ts's own "handoff" beat, handed t from F). From F the time
//   stop's hush is held at 1: it lifts only on the resume (sound.ts). court.ts finishes the fade within 0.3 s if the
//   head rises > 10 cm (it runs t faster, and passes the unrushed time for the light), and owns the ease's light and
//   hush before F.
// - handback(t): t seconds from the sit (the world re-seated at the dolly seat): the video layer fades back in over
//   the 3D from 0.1 s before the sit ends, over 1.3 s, then the cinema mask closes (P18) while the splats and the open
//   world go down under the picture. The light is court.ts's "return" beat; the hush stays (sound.ts lifts it on play).
// Pure (handoff.test.ts calls it under node with recording fakes): type-only imports. Stream D builds it.
import type { CourtWorld } from "./world";
import type { Freeze } from "./freeze";
import type { LightField } from "./lightfield";
import type { Proxies } from "./proxies";
import type { Sound } from "./sound";
import type { ShowVideo } from "./video";

/** True once stream D has built this module. */
export const BUILT = true;

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

/** Every part's value at one instant, each 0-1. */
export interface Beats {
  /** The video layer's opacity over the 3D: 1 the picture, 0 handed off. */
  video: number;
  /** The cinema mask (ShowVideo.mask): 0 the watch's feathered edge, 1 lifted into the matched dark. */
  mask: number;
  /** The frozen 3D drawn under the picture (Freeze.reveal): 0 nothing, 1 the pair, the ball and the extras. */
  reveal: number;
  /** The arena (CourtWorld.open): 0 the watch's look, 1 the world as the pool leaves it. */
  open: number;
}

/** 6u^5 - 15u^4 + 10u^3 on [0, 1] (C2: zero slope and curvature at both ends); clock.ts's curve. */
function smootherstep(u: number): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return x * x * x * (x * (6 * x - 15) + 10);
}
/** 0 -> 1 over the beat [a, b]. */
const rise = (t: number, [a, b]: readonly [number, number]): number => smootherstep((t - a) / (b - a));

/** The hand-off's beats at t seconds from F. */
export function handoffBeats(t: number): Beats {
  return {
    video: 1 - rise(t, BEATS.videoFades),
    mask: rise(t, BEATS.maskLifts),
    reveal: rise(t, BEATS.splatsUp),
    open: rise(t, BEATS.poolGrows),
  };
}

/** The hand-back's beats at t seconds from the sit: the picture first, then the mask closes over the 3D going down. */
export function handbackBeats(t: number): Beats {
  const close = rise(t, BACK_BEATS.maskCloses);
  return { video: rise(t, BACK_BEATS.videoReturns), mask: 1 - close, reveal: 1 - close, open: 1 - close };
}

function apply(b: Beats, parts: HandoffParts): void {
  parts.video.opacity = b.video;
  parts.video.mask(b.mask);
  parts.freeze.reveal(b.reveal);
  parts.world.open(b.open);
}

/**
 * Drive every part for t seconds from F. `lightT` (default t) is the light field's own time from F: when court.ts runs
 * t faster to finish a fade the head rose in, it passes the unrushed time here so the light never rushes (P44).
 */
export function handoff(t: number, parts: HandoffParts, lightT = t): void {
  apply(handoffBeats(t), parts);
  if (t >= 0) parts.sound.timeStop(1); // landed on F: the full hush, held through the hand-off and the walk
  if (t >= 0 && lightT >= 0) parts.light.set("handoff", lightT); // before F the ease's light and hush are court.ts's
}

/** Drive every part back for t seconds from the sit. */
export function handback(t: number, parts: HandoffParts): void {
  apply(handbackBeats(t), parts);
}
