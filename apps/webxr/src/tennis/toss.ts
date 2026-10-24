import * as THREE from "three";
import { BALL_R, GRAVITY } from "./physics";

// Your toss in the headset, hands only: the ball waits at your left fingertips; pinch it, lift your hand and let go,
// and it goes up with your hand's lift (helped to a height you can serve from). Nothing else tosses: a hand rising
// without a pinch, a palm turned up for the menu, a pinch that flickers open for a frame or tracking that drops out
// for a moment never let the ball go. The ball you see in your fingers is smoothed (tracking shakes a little frame
// to frame, more when the hand moves fast), and a hand the headset loses keeps the ball where it was for a moment,
// then the ball drifts (never jumps) to where it waits in front of you. Court space throughout (meters, +Y up).

const PINCH_ON = 0.025; // thumb and index tips this close: the ball is held (a ball pinch is looser than a piece's)
const PINCH_OFF = 0.045; // this far apart: the fingers have opened
const OPEN_MS = 70; // fingers open this long on a still hand: let go (a flicker of tracking never drops the ball)
const LOST_MS = 300; // a hand lost to tracking keeps the ball this long
const RISING = 0.3; // m/s up as the fingers open: a toss (slower: you just let it drop)
const VEL_WINDOW = 0.08; // seconds of the pinch point's path the hand's velocity is read over

export interface TossInput {
  t: number; // seconds
  dt: number;
  thumb: THREE.Vector3 | null; // thumb tip (court), null when the hand or the joint isn't tracked
  index: THREE.Vector3 | null; // index tip
  wrist: THREE.Vector3 | null;
  eyeY: number; // your eyes' height (court)
  rest: THREE.Vector3; // where the ball waits when your hand isn't seen (court)
  canPinch: boolean; // false while the palm menu is open (a pinch already held carries on)
}

export interface Toss {
  p: THREE.Vector3;
  v: THREE.Vector3;
  tossed: boolean; // false: you let it drop
}

export class TossHand {
  /** Where the ball is drawn while it's in your hand (court). */
  readonly ball = new THREE.Vector3();
  pinched = false;
  private started = false;
  private openSince = 0;
  private lostSince = 0;
  private path: { t: number; p: THREE.Vector3 }[] = [];
  private target = new THREE.Vector3();
  private v = new THREE.Vector3();
  private pinch = new THREE.Vector3();
  private out = new THREE.Vector3();

  /** A new serve: the ball goes straight to where it waits (no drift from wherever the last one went). */
  reset() {
    this.pinched = false;
    this.started = false;
    this.openSince = 0;
    this.lostSince = 0;
    this.path.length = 0;
  }

  /** Once a frame while you're about to serve. Returns the toss (or the drop) the frame the ball leaves your hand. */
  update(i: TossInput): Toss | null {
    const seen = !!(i.thumb && i.index && i.wrist);
    if (seen) {
      this.lostSince = 0;
      const d = i.thumb!.distanceTo(i.index!);
      this.pinch.copy(i.thumb!).add(i.index!).multiplyScalar(0.5);
      // the ball just beyond the fingertips (out from the wrist, a little up), as if held there
      this.out.copy(this.pinch).sub(i.wrist!);
      if (this.out.lengthSq() < 1e-8) this.out.set(0, 0, -1);
      this.out.normalize().addScaledVector(UP, 0.5).normalize();
      this.target.copy(this.pinch).addScaledVector(this.out, BALL_R * 0.95);
      this.path.push({ t: i.t, p: this.pinch.clone() });
      while (this.path.length > 2 && i.t - this.path[1].t > VEL_WINDOW) this.path.shift();
      this.velocity(this.v);
      if (!this.pinched) {
        if (d < PINCH_ON && i.canPinch) {
          this.pinched = true;
          this.openSince = 0;
        }
      } else if (d > PINCH_OFF) {
        this.openSince ||= i.t;
        // a hand on its way up lets go at once (the lift is the toss); a still one only once it's really open
        if (this.v.y > RISING || i.t - this.openSince > OPEN_MS / 1000) return this.release(i);
      } else this.openSince = 0;
      this.follow(i.dt, this.v.length());
      this.started = true;
      return null;
    }
    // not seen: hold the ball where it was for a moment, then let it drift to where it waits
    this.path.length = 0;
    this.lostSince ||= i.t;
    const lost = i.t - this.lostSince;
    if (this.pinched && lost > LOST_MS / 1000) this.pinched = false;
    if (!this.started) {
      this.ball.copy(i.rest);
      this.started = true;
    } else if (!this.pinched && lost > LOST_MS / 1000) this.ball.lerp(i.rest, 1 - Math.exp(-i.dt * 4));
    return null;
  }

  /** The hand's velocity over the last few frames (one frame's is mostly tracking noise). */
  private velocity(out: THREE.Vector3) {
    const a = this.path[0];
    const b = this.path[this.path.length - 1];
    const span = b.t - a.t;
    return span > 1e-3 ? out.copy(b.p).sub(a.p).divideScalar(span) : out.set(0, 0, 0);
  }

  /** The held ball follows its spot: smoothed when the hand is still (no shake), close behind it when it moves. */
  private follow(dt: number, speed: number) {
    if (!this.started) {
      this.ball.copy(this.target);
      return;
    }
    const rate = 18 + 70 * THREE.MathUtils.clamp(speed / 1.2, 0, 1);
    this.ball.lerp(this.target, 1 - Math.exp(-dt * rate));
  }

  private release(i: TossInput): Toss {
    this.pinched = false;
    this.openSince = 0;
    const p = this.ball.clone();
    const hand = this.v.clone();
    if (hand.y <= RISING) return { p, v: hand.multiplyScalar(0.8), tossed: false }; // let go: it drops
    // the lift decides the height, helped into the band a serve is hit from (over your head, racket up)
    const apex = Math.max(p.y + 0.35, i.eyeY + THREE.MathUtils.clamp(0.55 + 0.25 * hand.y, 0.7, 1.25));
    const v = new THREE.Vector3(hand.x * 0.2, Math.sqrt(2 * GRAVITY * (apex - p.y)) * 1.012, hand.z * 0.2 - 0.12);
    const flat = Math.hypot(v.x, v.z);
    if (flat > 0.5) {
      v.x *= 0.5 / flat;
      v.z *= 0.5 / flat;
    }
    return { p, v, tossed: true };
  }
}

const UP = new THREE.Vector3(0, 1, 0);
