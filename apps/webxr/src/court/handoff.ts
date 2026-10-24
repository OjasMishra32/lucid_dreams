// The hand-off choreography (3.3 steps 2-3, 3.3a): one function of progress that drives every part, so the three
// directions differ only here. p runs 0 -> 1 after the ease lands on F (court.ts advances it by dt / HANDOFF_SECONDS,
// and finishes the video fade within 0.3 s if the head rises > 10 cm), and 1 -> 0 for the hand-back from the seated
// eye (P18). Shared by every direction: the 3D is fully drawn under the opaque video from the ease start, then the
// video layer's opacity goes 1 -> 0 over FADE_SECONDS (an exact blend; never splat opacity in, P10), then the world
// opens. Pure (handoff.test.ts calls it under node with recording fakes): type-only imports. Stream D builds it.
import type { CourtWorld } from "./world";
import type { Freeze } from "./freeze";
import type { Proxies } from "./proxies";
import type { Sound } from "./sound";
import type { ShowVideo } from "./video";

/** True once stream D has built this module. */
export const BUILT = false;

/** Everything the hand-off moves. Each hook is a function of progress only, so recordings are deterministic. */
export interface HandoffParts {
  /** opacity (the video layer: set it here, it reaches the proxies), feather(p) (Same Pixels), depth(p) (Depth Grows). */
  video: ShowVideo;
  /** dimStands(p); its depth(p) is what video.depth(p) drives, so call the video's. */
  proxies: Proxies;
  /** open(p), pools(p) (House Lights). */
  world: CourtWorld;
  /** reveal(p). */
  freeze: Freeze;
  /** timeStop(p) as the hush lifts. */
  sound: Sound;
}

/** The three prototyped directions (3.3a); the pick is written in the status file. */
export type Direction = "same-pixels" | "house-lights" | "depth-grows";

/** The video layer fades out over this long (P10: 1.0 s +/- 1 frame). */
export const FADE_SECONDS = 1.0;
/** The whole hand-off, fade plus the world opening (~2 s), seconds: p = elapsed / HANDOFF_SECONDS. */
export const HANDOFF_SECONDS = 3.0;

/** Drive every part for hand-off progress p (0 = the footage on F, 1 = the world open). Stub: no-op. */
export function handoff(p: number, parts: HandoffParts): void {}
