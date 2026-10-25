// Court Side's two show transitions that were hard cuts: Reset (Replay, R) and Step into the court.
//   Reset from the 3D (the ease, the hand-off, the open world, the walk, the way back): the whole view fades to black
//   over RESET_OUT_S, the show restarts at full black (court.ts restart(): the seat, the screen, pass 1), and the view
//   fades back in over RESET_IN_S with the clock held on pass 1's first frame; then pass 1 plays. Reset at the screen
//   (the watch, the make, the end) restarts at once, since the seat and the arena stay where they are, and the screen
//   rises over RESET_IN_S as the arrival's does, the clock held the same way.
//   Step into the court: the screen's rim brightens over PULSE_UP_S and settles over PULSE_DOWN_S (screen.ts glow), so
//   the judge sees the press register; the picture's pixels never change.
// Pure timing (ResetFade, StepPulse) plus the head-centred black veil Reset fades through.
import * as THREE from "three";

/** Reset from the 3D: out to black, then back in (seconds). */
export const RESET_OUT_S = 0.4;
export const RESET_IN_S = 0.6;
/** Step into the court's rim pulse: up, then down (seconds). */
export const PULSE_UP_S = 0.15;
export const PULSE_DOWN_S = 0.9;

/** Smoothstep (Perlin's quintic) on [0, 1], clamped: zero slope at both ends, so a fade never starts or stops on a jump. */
export const smooth = (u: number): number => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
};

/** Reset's timing: start(), then update(dt) once a frame; it says on which frame the show restarts. */
export class ResetFade {
  private t = -1; // seconds since the press; -1 idle
  private out = 0; // this run's fade-out (0: the restart is at once)
  private restarted = false;

  /** A Reset press: `fadeOut` seconds to black before the restart (0 from the screen: at once). */
  start(fadeOut: number): void {
    this.t = 0;
    this.out = Math.max(0, fadeOut);
    this.restarted = false;
  }

  /** Change seat, or anything else that takes the view: no veil, no hold. */
  cancel(): void {
    this.t = -1;
    this.restarted = false;
  }

  /** A Reset is running (out, at black, or back in). */
  get active(): boolean {
    return this.t >= 0;
  }

  /** This run restarts at once, from the screen (no fade-out, no veil: the screen rises instead). */
  get atOnce(): boolean {
    return this.active && this.out === 0;
  }

  /** The show has restarted and the view is coming back in: the clock holds on pass 1's first frame. */
  get holding(): boolean {
    return this.active && this.restarted;
  }

  /** Advance by dt. True on the one frame the show restarts (at full black, or at once from the screen). */
  update(dt: number): boolean {
    if (!this.active) return false;
    if (!this.restarted) {
      if (this.t >= this.out) {
        this.restarted = true;
        this.t = this.out;
        return true;
      }
      this.t = Math.min(this.out, this.t + dt);
      return false;
    }
    this.t += dt;
    if (this.t >= this.out + RESET_IN_S) this.cancel();
    return false;
  }

  /** The black veil, 0 clear to 1 black: up over the fade-out, down over the fade-in (none from the screen). */
  get veil(): number {
    if (!this.active || this.out === 0) return 0;
    if (!this.restarted) return smooth(this.t / this.out);
    return 1 - this.rise;
  }

  /** The view's way back in after the restart, 0 dark to 1 whole (1 when no Reset is running). */
  get rise(): number {
    if (!this.active) return 1;
    if (!this.restarted) return 0;
    return smooth((this.t - this.out) / RESET_IN_S);
  }
}

/** Step into the court's rim pulse: start() on the press; level(dt) once a frame, 0 at rest to 1 at the peak. */
export class StepPulse {
  private t = -1;

  start(): void {
    this.t = 0;
  }

  level(dt: number): number {
    if (this.t < 0) return 0;
    const t = this.t;
    this.t += dt;
    if (t >= PULSE_UP_S + PULSE_DOWN_S) {
      this.t = -1;
      return 0;
    }
    return t < PULSE_UP_S ? smooth(t / PULSE_UP_S) : 1 - smooth((t - PULSE_UP_S) / PULSE_DOWN_S);
  }
}

/**
 * Reset's black veil: a sphere round the head drawn over everything (as seat.ts's fade-jump veil is). Add `mesh` to
 * the scene (room space, not the court world: it never moves with the seat).
 */
export class ResetVeil {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;

  constructor() {
    this.material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 8), this.material);
    this.mesh.name = "court-reset-veil";
    this.mesh.renderOrder = 1e6 + 1;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** The veil at `level` (0 clear, 1 black), centred on the head (room space). */
  set(level: number, head: readonly number[]): void {
    this.material.opacity = Math.min(1, Math.max(0, level));
    this.mesh.visible = this.material.opacity > 0;
    this.mesh.position.set(head[0], head[1], head[2]);
  }
}
