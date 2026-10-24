// The sound (2, 3.2, 3.3, 3.5): room tone (never dead silence), the crowd bed as >= 4 HRTF sources at the stands (each
// the bed from its own offset, none head-locked: P31), the arrival's swell (-30 -> -12 dB over 2.5 s), the time stop
// (low-pass 18 kHz -> ~700 Hz and -12 dB over the ease, room tone kept: P20), See my room's murmur (-18 dB,
// low-passed), the swell one-shot on the make (and softly at Step in), and events at 3D positions when Vishal approves
// CC0 sounds. No voices ever (P19). Stream F (`sound`) builds it.
import type { ClockState } from "./clock";
import type { CourtBundle, Vec3 } from "./format";
import type { Head } from "./types";

/** True once stream F has built this module. */
export const BUILT = false;

export class Sound {
  /** HRTF sources in the graph (P31 reads it). */
  sources = 0;
  private readonly bundle: CourtBundle;

  constructor(bundle: CourtBundle) {
    this.bundle = bundle;
  }

  /** Fetch and decode the bed and one-shots (an AudioContext may be created suspended). Stub: resolves. */
  async load(): Promise<void> {}

  /** Inside the Enter tap (a user gesture): resume the context, start room tone and the bed at -30 dB. Stub: no-op. */
  start(): void {}

  /** The arrival: 0 = room tone only, 1 = the crowd at -12 dB. Stub: no-op. */
  arrive(p: number): void {}

  /** The time stop: 0 = the crowd open, 1 = low-passed to ~700 Hz and 12 dB down. Stub: no-op. */
  timeStop(p: number): void {}

  /** See my room: 0 = the arena, 1 = the room's murmur. Stub: no-op. */
  room(p: number): void {}

  /** A one-shot from court.json audio.oneShots by its cue. Stub: no-op. */
  oneShot(id: "make" | "stepIn"): void {}

  /** A sound at a court-space position (audio.events). Stub: no-op. */
  event(kind: string, at: Vec3): void {}

  /** Once a frame: the listener follows the head; the make and events fire as the show passes their source frames. Stub: no-op. */
  update(head: Head, clock: ClockState): void {}
}
