// What the judge reads and presses (3.6): the caption, the honesty label and the source credit (always, P22), the
// palm menu (left palm up, right index; xr/menu.ts HandMenu, 2 columns, first row on top; xr/hands.ts XrButton):
// top row Step into the court / Back to my seat (one slot) and Reality check; bottom row Replay and See my room
// (never moves or hides; flips to "Back to the arena"); Walk closer and Next view on their own row while they apply;
// the setup page's Seat here, a HoldButton (2 s, P32). No gesture acts by itself and there is no other control path
// (P21). Tested through the e2e (IWER hands), not node. Stream C (`core`) builds it; the action dispatch is written.
import type * as THREE from "three";
import { XrButton } from "../xr/hands";
import type { CourtBundle } from "./format";
import type { Head, Phase } from "./types";

/** True once stream C has built this module. */
export const BUILT = false;

/** Every button, by what it does. */
export type UiAction = "step" | "back" | "reality" | "replay" | "room" | "closer" | "nextView" | "seatHere";

/** What the menu shows besides the phase. */
export interface UiFlags {
  /** See my room is on (the button reads "Back to the arena"; Walk closer and Next view hide). */
  inRoom: boolean;
  /** Reality check is on. */
  reality: boolean;
  /** Seat here hasn't been held yet: the setup page. */
  setup: boolean;
  /** The walk ring replaced the spots (Next view hides). */
  ring: boolean;
}

/**
 * A button that acts only after a fingertip has held it for `holdMs` (Seat here: 2 s; a 1 s press changes nothing,
 * P32), with its progress shown on the face. A subclass, so xr/hands.ts stays as it is. Stub: never fires.
 */
export class HoldButton extends XrButton {
  /** 0-1: how far through the hold the current press is. */
  progress = 0;
  readonly holdMs: number;
  private readonly onHeld: () => void;

  constructor(id: string, label: string, onHeld: () => void, holdMs = 2000) {
    super(id, label, () => {}); // a plain push does nothing: only the hold acts
    this.onHeld = onHeld;
    this.holdMs = holdMs;
  }

  /** Both index fingertips in world space; fires onHeld once a tip has stayed pressed in for holdMs. Stub: no-op. */
  override touch(fingertips: (THREE.Vector3 | null)[], now: number): void {}
}

export class Ui {
  /** See my room's handler (the plan's name; the same as on("room", fn)). */
  onToggleRoom: (() => void) | null = null;
  private readonly handlers = new Map<UiAction, () => void>();
  private readonly scene: THREE.Scene;
  private readonly hands: THREE.Object3D[];
  private readonly sideOf: (i: number) => XRHandedness | null;
  private readonly bundle: CourtBundle;

  constructor(scene: THREE.Scene, hands: THREE.Object3D[], sideOf: (i: number) => XRHandedness | null, bundle: CourtBundle) {
    this.scene = scene;
    this.hands = hands;
    this.sideOf = sideOf;
    this.bundle = bundle;
  }

  /** Register what a button does (court.ts wires every action). */
  on(action: UiAction, fn: () => void): void {
    this.handlers.set(action, fn);
  }

  /** Act as if a button were pressed (the e2e's shortcut; the real presses come from the palm menu). */
  press(action: UiAction): void {
    if (action === "room" && this.onToggleRoom) this.onToggleRoom();
    else this.handlers.get(action)?.();
  }

  /** Which buttons show, and their labels, for this phase. Stub: no-op. */
  setPhase(phase: Phase, flags: UiFlags): void {}

  /** Once a frame while presenting: the menu follows the palm; buttons take fingertip presses. Stub: no-op. */
  update(head: Head, now: number, dt: number): void {}
}
