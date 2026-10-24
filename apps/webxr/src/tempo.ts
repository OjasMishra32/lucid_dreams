// Golf tempo: the ratio of the backswing's time to the downswing's (tour players swing close to 3 : 1), his from the
// clip's joints and yours from your tracked hands, by the same three moments: the takeaway (the hands start moving), the
// top (the lead wrist at its highest) and impact (the hands at their lowest, moving fast). Plain maths, no three.js, so
// scripts/check_tempo.ts runs it in node.

export type Vec3 = [number, number, number];

export interface JointsLike {
  fps: number;
  names: string[];
  frames: number[][][]; // per frame, per name: [x, y, z] in bundle space (+X their right, +Y up, front -Z)
}

export interface Tempo {
  takeaway: number; // clip seconds (negative: before the clip's first frame)
  top: number;
  impact: number;
  back: number; // top - takeaway
  down: number; // impact - top
  ratio: number; // back / down
  lead: "left_wrist" | "right_wrist"; // the lead arm's wrist (a right-handed golfer's left)
  takeawayFrom: "joints" | "plan" | "clip start"; // the clip can begin after the hands have started back
  slowMotion: boolean; // a downswing this long (over 0.6 s) isn't full speed: the footage is slowed
  frames: { takeaway: number; top: number; impact: number }; // fractional frame indices (takeaway may be < 0)
}

const MID = (a: number[], b: number[]): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A peak's index to a fraction of a frame (the parabola through it and its neighbours). */
function refine(v: number[], i: number): number {
  if (i <= 0 || i >= v.length - 1) return i;
  const d = v[i - 1] - 2 * v[i] + v[i + 1];
  return Math.abs(d) < 1e-12 ? i : i + (0.5 * (v[i - 1] - v[i + 1])) / d;
}

/** Both hands (the middle of the wrists) per frame, and their speed (m/s, smoothed over three frames). */
export function handPath(j: JointsLike): { hands: Vec3[]; speed: number[] } {
  const L = j.names.indexOf("left_wrist"), R = j.names.indexOf("right_wrist");
  const hands = j.frames.map((f) => MID(f[L], f[R]));
  const n = hands.length;
  const raw = hands.map((_, i) => (dist(hands[Math.min(n - 1, i + 1)], hands[Math.max(0, i - 1)]) * j.fps) / (Math.min(n - 1, i + 1) - Math.max(0, i - 1) || 1));
  const speed = raw.map((_, i) => 0.25 * raw[Math.max(0, i - 1)] + 0.5 * raw[i] + 0.25 * raw[Math.min(n - 1, i + 1)]);
  return { hands, speed };
}

/**
 * His tempo from the clip's joints. Impact: the hands' lowest point among the frames where they move at more than
 * half their top speed (at address they're as low, but still). Top: the lead wrist's highest point before impact (the
 * lead is the arm that ends up on the target side: a right-handed golfer's hands sit to his right, +X, at the top).
 * Takeaway: back from the top, past its slow turn, to where the hands were still again (under a fifth of the
 * backswing's top speed). When the clip starts with the hands already moving, the takeaway comes from the plan
 * (experience.json "tempo": { "takeaway": seconds }, measured on the source clip) or, failing that, the clip's start.
 */
export function measureTempo(j: JointsLike, hint?: { takeaway?: number } | null): Tempo | null {
  const n = j.frames.length;
  if (n < 10 || !j.names.includes("left_wrist") || !j.names.includes("right_wrist")) return null;
  const { hands, speed } = handPath(j);
  const peak = Math.max(...speed);
  if (peak < 0.3) return null; // nobody swung
  let impact = -1;
  for (let i = 1; i < n - 1; i++) if (speed[i] > 0.5 * peak && (impact < 0 || hands[i][1] < hands[impact][1])) impact = i;
  if (impact < 3) return null;
  // the lead wrist: at the top the hands are on the trail side of where they meet the ball
  const topGuess = hands.slice(0, impact).reduce((b, h, i) => (h[1] > hands[b][1] ? i : b), 0);
  const lead = hands[topGuess][0] > hands[impact][0] ? "left_wrist" : "right_wrist";
  const li = j.names.indexOf(lead);
  const leadY = j.frames.map((f) => f[li][1]);
  let top = 0;
  for (let i = 0; i < impact; i++) if (leadY[i] > leadY[top]) top = i;
  const topF = Math.min(refine(leadY, top), impact - 0.5);
  const lowY = hands.map((h) => -h[1]);
  const impactF = refine(lowY, impact);
  // the takeaway: out of the top's slow turn, then back to where the hands were still
  const backPeak = Math.max(...speed.slice(0, top + 1));
  const still = 0.2 * backPeak;
  let k = top;
  while (k > 0 && speed[k] < still) k--;
  while (k > 0 && speed[k] >= still) k--;
  let takeawayF: number;
  let takeawayFrom: Tempo["takeawayFrom"] = "joints";
  if (k === 0 && speed[0] >= still) {
    // moving already in the first frame
    if (hint?.takeaway != null && Number.isFinite(hint.takeaway) && hint.takeaway <= 0) {
      takeawayF = hint.takeaway * j.fps;
      takeawayFrom = "plan";
    } else {
      takeawayF = 0;
      takeawayFrom = "clip start";
    }
  } else {
    // where the speed crossed the threshold, between frame k (still) and k + 1 (moving)
    const a = speed[k], b = speed[k + 1];
    takeawayF = k + (b > a ? (still - a) / (b - a) : 0);
  }
  const back = (topF - takeawayF) / j.fps;
  const down = (impactF - topF) / j.fps;
  if (!(back > 0 && down > 0)) return null;
  return {
    takeaway: takeawayF / j.fps,
    top: topF / j.fps,
    impact: impactF / j.fps,
    back,
    down,
    ratio: back / down,
    lead,
    takeawayFrom,
    slowMotion: down > 0.6,
    frames: { takeaway: takeawayF, top: topF, impact: impactF },
  };
}

/** What to work on, from your ratio against his. */
export function tempoAdvice(yours: number, his: number): string {
  const d = yours - his;
  if (Math.abs(d) <= 0.3) return "That's his tempo.";
  return d < 0 ? "Slow the backswing." : "Take it back a little quicker.";
}

// ---------------------------------------------------------------- your swing, from your hands on the club

export interface SwingSample {
  t: number; // seconds
  hands: Vec3 | null; // your hands on the grip (world, metres, +Y up); null while not tracked
  holding: boolean; // the club is in your hands
  address: boolean; // the club is held still with its head down (club.ts)
}

export interface Swing {
  back: number;
  down: number;
  ratio: number;
  hit: boolean; // the ball was struck (impact is then the strike)
  takeaway: number;
  top: number;
  impact: number;
  topFromGap: boolean; // tracking dropped at the top (the hands over your shoulder): the middle of the gap
}

type State = "idle" | "address" | "back" | "down";

/**
 * Reads your swings, once each, from a held address only: hands still over the ball with the club down, then away
 * (takeaway: the last moment they were within 3 cm of address), up to their highest point (the top), and down to
 * their lowest or the strike (impact). A waggle, a practice wave or the club picked up never makes a swing: it has to
 * start from address, lift the hands at least 30 cm and come back down to about where it started, at a pace a swing
 * has. Hand tracking often loses the hands over your shoulder at the top; then the top is the middle of that gap.
 */
export class SwingTracker {
  state: State = "idle";
  /** Seconds the hands have been still at address (the tempo tones wait for this). */
  stillFor = 0;
  history: Swing[] = []; // newest last, at most 5
  onSwing: (s: Swing) => void = () => {};
  /** Why the last attempt wasn't counted (for checks). */
  rejected = "";
  private buf: { t: number; p: Vec3 | null }[] = [];
  private addr: Vec3 = [0, 0, 0];
  private addrY = 0;
  private takeaway = 0;
  private topY = -Infinity;
  private topT = 0;
  private topFromGap = false;
  private gapStart: number | null = null;
  private lastLive: { t: number; p: Vec3 } | null = null;
  private minY = Infinity;
  private minT = 0;
  private hitAt: number | null = null;
  private notHolding = 0;
  private settled = false; // the hands have been still at address for a moment (a swing starts from there)
  private prevT: number | null = null;

  /** The ball was struck (club.ts). */
  hit(t: number) {
    if (this.state === "back" || this.state === "down") this.hitAt = t;
  }

  update(s: SwingSample) {
    const dt = this.prevT === null ? 0 : Math.max(0, s.t - this.prevT);
    this.prevT = s.t;
    this.buf.push({ t: s.t, p: s.hands });
    while (this.buf.length && this.buf[0].t < s.t - 4) this.buf.shift();
    this.notHolding = s.holding ? 0 : this.notHolding + dt;
    const p = s.hands;
    switch (this.state) {
      case "idle":
        if (s.holding && s.address && p) this.toAddress(p);
        break;
      case "address": {
        if (this.notHolding > 0.3) return this.reset("");
        if (!p) break;
        const d = dist(p, this.addr);
        if (d < 0.05) {
          this.stillFor += dt;
          if (this.stillFor >= 0.2) this.settled = true;
          for (let k = 0; k < 3; k++) this.addr[k] += (p[k] - this.addr[k]) * Math.min(1, dt * 3); // settles with you
          this.addrY = this.addr[1];
        } else this.stillFor = 0;
        if (d > 0.12) {
          if (!this.settled) return this.reset("not from a still address");
          this.takeaway = this.departure(s.t);
          this.state = "back";
          this.topY = p[1];
          this.topT = s.t;
          this.topFromGap = false;
          this.gapStart = null;
          this.lastLive = { t: s.t, p };
          this.hitAt = null;
        }
        break;
      }
      case "back":
        if (this.notHolding > 0.5 || s.t - this.takeaway > 3) return this.reset("put down, or too long going back");
        if (!p) {
          this.gapStart ??= this.lastLive?.t ?? s.t;
          break;
        }
        if (this.gapStart !== null) {
          // tracking came back: if the hands went into the gap rising (the top so far was the last thing seen) and
          // came out lower, the top was in the gap
          if (this.lastLive && this.topT >= this.lastLive.t - 1e-6 && p[1] < this.topY && s.t - this.gapStart > 0.1) {
            this.topT = (this.gapStart + s.t) / 2;
            this.topFromGap = true;
          }
          this.gapStart = null;
        }
        if (p[1] > this.topY) {
          this.topY = p[1];
          this.topT = s.t;
          this.topFromGap = false;
        }
        this.lastLive = { t: s.t, p };
        if (this.hitAt !== null || (p[1] < this.topY - 0.15 && this.vy() < -0.6)) {
          this.state = "down";
          this.minY = p[1];
          this.minT = s.t;
        }
        break;
      case "down":
        if (s.t - this.topT > 2) return this.reset("too long coming down");
        if (p && p[1] < this.minY) {
          this.minY = p[1];
          this.minT = s.t;
        }
        if (this.hitAt !== null) return this.finish(this.hitAt, true);
        if ((p && p[1] > this.minY + 0.08) || s.t - this.minT > 0.3 || this.notHolding > 0.3) this.finish(this.minT, false);
        break;
    }
  }

  private toAddress(p: Vec3) {
    this.state = "address";
    this.addr = [...p];
    this.addrY = p[1];
    this.stillFor = 0;
    this.settled = false;
  }

  private reset(why: string) {
    if (why) this.rejected = why;
    this.state = "idle";
    this.stillFor = 0;
  }

  /**
   * When the hands left address. Tracking shakes a hand by millimetres, so the start of a slow takeaway can't be read
   * from one frame; instead, the moments they passed 3 cm and 8 cm from address, and the hands taken to start from rest
   * at an even acceleration (distance grows with the square of time): t0 = t3 - (t8 - t3) * sqrt(3) / (sqrt(8) - sqrt(3)).
   */
  private departure(now: number): number {
    const cross = (r: number): number | null => {
      for (let k = this.buf.length - 1; k > 0; k--) {
        const a = this.buf[k - 1], b = this.buf[k];
        if (!a.p || !b.p) continue;
        const da = dist(a.p, this.addr), db = dist(b.p, this.addr);
        if (da <= r && db > r) return a.t + ((r - da) / (db - da)) * (b.t - a.t);
      }
      return null;
    };
    const t3 = cross(0.03), t8 = cross(0.08);
    if (t3 === null) return now;
    if (t8 === null || t8 <= t3) return t3;
    return t3 - ((t8 - t3) * Math.sqrt(3)) / (Math.sqrt(8) - Math.sqrt(3));
  }

  /** The hands' vertical speed over the last ~60 ms (m/s). */
  private vy(): number {
    const live = this.buf.filter((b) => b.p);
    if (live.length < 2) return 0;
    const last = live[live.length - 1];
    let k = live.length - 2;
    while (k > 0 && last.t - live[k].t < 0.06) k--;
    const first = live[k];
    return last.t > first.t ? (last.p![1] - first.p![1]) / (last.t - first.t) : 0;
  }

  private finish(impact: number, hit: boolean) {
    const back = this.topT - this.takeaway;
    const down = impact - this.topT;
    const lift = this.topY - this.addrY;
    const bottom = this.addrY - this.minY;
    const ok = back >= 0.3 && back <= 3 && down >= 0.1 && down <= 1.5 && lift > 0.3 && bottom > -0.25 && back / down >= 0.8 && back / down <= 8;
    this.state = "idle";
    this.stillFor = 0;
    if (!ok) {
      this.rejected = `not a swing (back ${back.toFixed(2)} s, down ${down.toFixed(2)} s, lift ${lift.toFixed(2)} m, bottom ${bottom.toFixed(2)} m)`;
      return;
    }
    const swing: Swing = { back, down, ratio: back / down, hit, takeaway: this.takeaway, top: this.topT, impact, topFromGap: this.topFromGap };
    this.history.push(swing);
    if (this.history.length > 5) this.history.shift();
    this.rejected = "";
    this.onSwing(swing);
  }
}
