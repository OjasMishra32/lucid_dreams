// Court Side's two show transitions that were hard cuts: Reset (Replay, R) and Step into the court.
//   Reset from the 3D (the ease, the hand-off, the open world, the walk, the way back): the whole view fades to black
//   over RESET_OUT_S, the show restarts at full black (court.ts restart(): the seat, the screen, pass 1), and the view
//   fades back in over RESET_IN_S with the clock held on pass 1's first frame; then pass 1 plays. Reset at the screen
//   (the watch, the make, the end) restarts at once, since the seat and the arena stay where they are, and the screen
//   rises over RESET_IN_S as the arrival's does, the clock held the same way.
//   Step into the court (screen.ts glow, round the picture only: the picture's pixels never change): the press flares
//   the screen's rim and sends a ring of light out over the arena; the rim then holds charged, breathing, while the
//   stop is armed; through the ease it charges to full as time slows, and as the screen dissolves into the court a
//   second ring goes out, so the picture seems to spill into the arena it becomes.
// Pure timing (ResetFade, StepGlow) plus the head-centred black veil Reset fades through.
import * as THREE from "three";

/** Reset from the 3D: out to black, then back in (seconds). */
export const RESET_OUT_S = 0.4;
export const RESET_IN_S = 0.6;
/** Step into the court's flare: up to full over GLOW_UP_S, then down to the charged hold GLOW_HOLD over GLOW_SETTLE_S. */
export const GLOW_UP_S = 0.2;
export const GLOW_SETTLE_S = 1.2;
export const GLOW_HOLD = 0.3;
/** The charged hold breathes: this much either way, this often (Hz), faded in over GLOW_BREATHE_IN_S once settled. */
export const GLOW_BREATHE = 0.07;
export const GLOW_BREATHE_HZ = 0.5;
export const GLOW_BREATHE_IN_S = 0.8;
/** A ring of light crosses the halo (the rim out to SCREEN_HALO_M) in this long. */
export const WAVE_S = 1.1;

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

/**
 * Step into the court's glow on the screen's rim: start() on the press, stop() when the screen is gone or the show
 * restarts; update(dt, charge) once a frame, with the ease's progress toward the screen's dissolve (0-1) while easing,
 * else null. glow 0 is the plain rim, 1 the full flare; wave is a ring's progress across the halo (0-1), -1 none.
 */
export class StepGlow {
  private t = -1; // seconds since the press; -1 off
  private waveT = -1; // seconds since the last ring went out; -1 none
  private dissolved = false; // the dissolve's ring has gone out

  start(): void {
    this.t = 0;
    this.waveT = 0;
    this.dissolved = false;
  }

  stop(): void {
    this.t = -1;
    this.waveT = -1;
    this.dissolved = false;
  }

  update(dt: number, charge: number | null): { glow: number; wave: number } {
    if (this.t < 0) return { glow: 0, wave: -1 };
    const t = this.t;
    this.t += dt;
    const settled = t - GLOW_UP_S - GLOW_SETTLE_S;
    let glow = t < GLOW_UP_S ? smooth(t / GLOW_UP_S) : 1 - (1 - GLOW_HOLD) * smooth((t - GLOW_UP_S) / GLOW_SETTLE_S);
    if (settled > 0) glow += GLOW_BREATHE * smooth(settled / GLOW_BREATHE_IN_S) * Math.sin(2 * Math.PI * GLOW_BREATHE_HZ * settled);
    if (charge !== null) {
      const c = Math.min(1, Math.max(0, charge));
      glow = Math.max(glow, GLOW_HOLD + (1 - GLOW_HOLD) * smooth(c));
      if (c >= 1 && !this.dissolved) {
        this.dissolved = true;
        this.waveT = 0;
      }
    }
    let wave = -1;
    if (this.waveT >= 0) {
      wave = this.waveT / WAVE_S;
      this.waveT += dt;
      if (wave >= 1) {
        wave = -1;
        this.waveT = -1;
      }
    }
    return { glow: Math.min(1, Math.max(0, glow)), wave };
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
