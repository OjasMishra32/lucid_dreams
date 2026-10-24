import * as THREE from "three";
import type { SkinnedAvatar } from "../avatar";
import { Rng } from "../chess/person";
import { BodyShape } from "../chess/body";
import { blobShadow, C, inCourt, inServiceBox, WALL_Z } from "./court";
import { Animator, type GreetPose, type Stroke, type StrokeKind } from "./motion";
import { type Ball, type BallEvent, GRAVITY, predict, type Shot, solveLob, solveShot, aimToReach, STEP } from "./physics";
import { buildRacket, RACKET } from "./racket";
import { Rig } from "./rig";
import { rallyRegion, serveRegion } from "./shots";

// The opponent: an AI that reads the ball (the same physics, run ahead), split-steps as you hit, runs to where it can
// take the ball (with real acceleration and a top speed), picks a forehand or backhand, a volley at the net, an
// overhead on a short lob or a low half-volley, and plays the shot the situation asks for: deep crosscourt in a rally,
// an approach and the net on a short ball, a pass or a lob when you come in, a drop shot when you're far back, and
// his serve (flat out wide, kick, slice into the body). Then back toward the centre. With rally assist on, his
// groundstrokes come to within reach of where you stand. His body is an avatar bundle posed by motion.ts.

export interface Level {
  id: string;
  label: string;
  speed: number; // top speed, m/s
  accel: number;
  react: number; // seconds before he moves after your hit
  pace: [number, number]; // groundstroke speed, m/s
  serve: [number, number]; // first serve
  err: number; // chance of an unforced error per shot
  reach: number; // with rally assist: how far to your side his ball comes (m)
  net: number; // how often he comes in behind a short ball
  special: number; // how often he tries a drop shot, lob or angle
  fault: number; // first-serve fault rate
}

export const LEVELS: Level[] = [
  { id: "easy", label: "Easy", speed: 4.4, accel: 6.5, react: 0.3, pace: [13, 17], serve: [24, 29], err: 0.13, reach: 0.78, net: 0.08, special: 0.1, fault: 0.22 },
  { id: "club", label: "Club", speed: 5.1, accel: 7.5, react: 0.22, pace: [16, 21], serve: [29, 35], err: 0.09, reach: 1.0, net: 0.18, special: 0.16, fault: 0.28 },
  { id: "pro", label: "Pro", speed: 5.8, accel: 8.5, react: 0.16, pace: [19, 26], serve: [35, 42], err: 0.055, reach: 1.3, net: 0.3, special: 0.22, fault: 0.32 },
  { id: "tour", label: "Tour", speed: 6.4, accel: 9.5, react: 0.12, pace: [22, 30], serve: [40, 48], err: 0.035, reach: 1.55, net: 0.4, special: 0.28, fault: 0.36 },
];

export type ShotType = "rally" | "approach" | "pass" | "lob" | "drop" | "smash" | "volley" | "dropvolley" | "serve-flat" | "serve-slice" | "serve-kick";

interface Plan {
  tc: number; // contact time
  contact: THREE.Vector3; // court
  kind: StrokeKind;
  body: THREE.Vector3; // where he needs to stand (court)
  go: number; // when he starts moving (after his reaction)
  reachable: boolean;
  bounced: boolean; // a groundstroke (vs. a volley or an overhead)
}

export interface HitResult {
  kind: StrokeKind;
  type: ShotType;
  speed: number;
}

const HOME_Z = -(C.halfL + 0.7); // where he waits for a rally ball
const NET_Z = -3.1; // where he volleys from, once he's in
const APPROACH_Z = -5.4; // where he gets to behind an approach (around the service line), then closes in

export class Opponent {
  readonly root = new THREE.Group(); // court space: his own F space (origin where he stands, facing +z)
  readonly racket: THREE.Group;
  readonly shadow: THREE.Mesh;
  readonly anim = new Animator();
  avatar: SkinnedAvatar | null = null;
  name = "Opponent";
  readonly ground = new THREE.Vector3(0, 0, HOME_Z);
  readonly vel = new THREE.Vector3();
  level: Level = LEVELS[2];
  rallyAssist = true;
  plan: Plan | null = null;
  stroke: Stroke | null = null;
  holdingBall = false;
  atNet = false;
  lastShot: ShotType | null = null;
  readonly misses: string[] = []; // for checks: balls he couldn't get to
  /** The handshake at the net before a match (game.ts drives it); null in a match. */
  greet: GreetPose | null = null;
  /** What his eyes are on instead of the ball (court), or null. */
  lookAt: THREE.Vector3 | null = null;
  /** A walk or a jog instead of his match pace (m/s). */
  speedCap = Infinity;
  private recover = new THREE.Vector3(0, 0, HOME_Z);
  private split = -1;
  private rng = new Rng(7);
  private serve: { tc: number; deuce: boolean; second: boolean; tossed: boolean; type: ShotType; volley: boolean } | null = null;
  private opacity = 0;
  private look = new THREE.Vector3(0, 1, 10);
  private tmp = new THREE.Vector3();
  private t = 0;

  constructor(court: THREE.Object3D, env?: THREE.Texture) {
    court.add(this.root);
    this.racket = buildRacket({ frame: 0x1b1b1e, grip: "#f4f4f0", wrap: "#d6d6d2" }, env);
    this.root.add(this.racket);
    this.shadow = blobShadow(1.2, 0.5);
    court.add(this.shadow);
    this.root.position.copy(this.ground);
    this.anim.resetFeet(this.ground);
  }

  /** His body: an avatar bundle with a rig (it fades in). Null: the racket alone. */
  setAvatar(a: SkinnedAvatar | null, name: string) {
    if (this.avatar) {
      this.root.remove(this.avatar.mesh);
      this.avatar.mesh.dispose();
    }
    this.avatar = a;
    this.name = name;
    if (!a) {
      this.anim.setRig(null);
      return;
    }
    a.pose(0, (_l, _t, s) => this.anim.setRig(new Rig(s)));
    // his real bulk (as the chess opponent measures it), so no racket or arm goes into it
    if (this.anim.rig) this.anim.rig.body = BodyShape.measure(a.mesh, this.anim.rig.rest);
    a.mesh.opacity = 0;
    this.opacity = 0;
    this.root.add(a.mesh);
    this.anim.resetFeet(this.ground);
  }

  /** The middle of his right palm (court): where a handshake meets. */
  palm(out: THREE.Vector3) {
    return this.anim.rig ? this.anim.rig.rightPalm(out).add(this.ground) : out.set(-0.2, 1.0, 0.4).add(this.ground);
  }

  /** How tall he stands (m). */
  get height() {
    return this.anim.rig?.height ?? 1.85;
  }

  reseed(seed: number) {
    this.rng = new Rng(seed);
  }

  /** Between points: stand at a spot (no running), ready. */
  placeAt(x: number, z: number) {
    this.ground.set(x, 0, z);
    this.recover.copy(this.ground);
    this.vel.set(0, 0, 0);
    this.plan = null;
    this.stroke = null;
    this.serve = null;
    this.holdingBall = false;
    this.atNet = false;
    this.anim.resetFeet(this.ground);
  }

  /** Send him somewhere (court), running (between points, or for checks). */
  moveTo(x: number, z: number) {
    this.recover.set(x, 0, z);
  }

  /** Where he waits for your serve. */
  receivePosition(deuce: boolean, second: boolean) {
    return new THREE.Vector3(deuce ? -1.6 : 1.6, 0, -(C.halfL + (second ? 0.2 : 1.0)));
  }

  /** A fist pump after a game he wins, the whole celebration after the match. */
  cheer(kind: "fistPump" | "celebrate") {
    this.anim.cheer(kind, this.t);
  }

  /** You're about to hit (or just did): a split-step. */
  splitStep(t: number) {
    if (!this.stroke && t - this.split > 0.6) this.split = t;
  }

  // ---------------------------------------------------------------- reading your shot

  private travel(d: number) {
    const { speed: v, accel: a } = this.level;
    return d < (v * v) / a ? 2 * Math.sqrt(d / a) : d / v + v / a;
  }

  /**
   * Your ball is on its way (a rally shot, or your serve): where can he take it? Run the ball ahead; a ball going out
   * (or a fault) he lets go; otherwise the best place he can reach in time: a volley or an overhead at the net, a
   * groundstroke at a comfortable height after the bounce, a half-volley if that's all there is.
   */
  read(ball: Ball, t: number, serve: { deuce: boolean } | null) {
    this.plan = null;
    const pred = predict(ball, 5, (b, _t, ev) => b.p.z < -(WALL_Z - 0.2) || ev.filter((e) => e.e.type === "bounce").length >= 2 || ev.some((e) => e.e.type === "net" && !e.e.tape));
    const bounces = pred.events.filter((e) => e.e.type === "bounce") as { t: number; e: Extract<BallEvent, { type: "bounce" }> }[];
    const b1 = bounces[0];
    if (pred.events.some((e) => e.e.type === "net" && !e.e.tape)) return; // into the net
    if (!b1 || b1.e.p.z > 0) return; // it won't land on his side
    const good = serve ? inServiceBox(b1.e.p.x, b1.e.p.z, b1.e.patch, -1, serve.deuce) : inCourt(b1.e.p.x, b1.e.p.z, b1.e.patch);
    if (!good) return; // going out: he watches it go
    const t2 = bounces[1]?.t ?? 4.5;
    const k = this.anim.k;
    const reactAt = t + this.level.react;
    type Cand = { c: THREE.Vector3; tc: number; kind: StrokeKind; body: THREE.Vector3; cost: number; bounced: boolean };
    let best: Cand | null = null as Cand | null;
    let fallback: Cand | null = null as Cand | null;
    const atNet = this.atNet || this.ground.z > -7;
    for (let i = 0; i < pred.samples.length; i += 2) {
      const s = pred.samples[i];
      if (s.t >= t2 - 0.02) break;
      if (s.p.z > -0.6) continue;
      const before = s.t < b1.t;
      const y = s.p.y;
      if (before && serve) continue; // a serve must bounce first
      let kind: StrokeKind;
      if (before) {
        if (y > 2.15 * k && y < 3.1 * k) kind = "smash";
        else if (y > 0.45 && y < 1.9 * k && atNet) kind = s.p.x < this.ground.x + 0.1 ? "fvolley" : "bvolley";
        else continue;
      } else {
        if (y < 0.28 || y > 2.85 * k) continue;
        if (y > 2.0 * k) kind = "smash"; // a high bounce: an overhead off the bounce
        else kind = s.p.x < this.ground.x + 0.25 ? "forehand" : "backhand";
      }
      const off = this.anim.contactOffset(kind);
      const have = s.t - this.level.react;
      const setup = kind === "smash" ? 0.35 : before ? 0.05 : 0.12;
      // where he'd stand: in his stroke's own spot, or stretched (a lunge for a volley, a reach for a groundstroke)
      let body = new THREE.Vector3(s.p.x - off.x, 0, s.p.z - off.z);
      let need = this.travel(body.distanceTo(this.ground)) + setup;
      if (need > have && kind !== "smash") {
        const stretch = new THREE.Vector3(s.p.x - off.x * (before ? 1.45 : 1.2), 0, s.p.z - off.z);
        const n2 = this.travel(stretch.distanceTo(this.ground)) + setup;
        if (n2 < need) {
          body = stretch;
          need = n2;
        }
      }
      if (body.z > -0.7) continue; // never on top of the net
      // the height his stroke meets the ball at (the real clip's, where there is one), within a comfortable band
      const ideal = kind === "smash" ? 2.4 * k : before ? 1.15 * k : THREE.MathUtils.clamp(off.y, 0.75 * k, 1.05 * k);
      let cost = Math.abs(y - ideal) * 1.2 + s.t * 0.15;
      if (before && !atNet && kind !== "smash") cost += 2;
      if (!before && atNet) cost += 0.7;
      if (!before && y < 0.5) cost += 0.6; // a half-volley: only when nothing better
      if (body.z < -(C.halfL + 3)) cost += 0.8;
      const cand = { c: s.p.clone(), tc: t + s.t, kind, body, cost, bounced: !before };
      if (need <= have) {
        if (!best || cost < best.cost) best = cand;
      } else if (!fallback || (cost + (need - have) * 3) < fallback.cost) fallback = { ...cand, cost: cost + (need - have) * 3 };
    }
    const pick = best ?? fallback;
    if (!pick) return;
    this.plan = { tc: pick.tc, contact: pick.c, kind: pick.kind, body: pick.body, go: reactAt, reachable: !!best, bounced: pick.bounced };
  }

  // ---------------------------------------------------------------- his shots

  /** Every physics step: when the ball reaches his racket, he hits it. Returns what he did, or null. */
  tryHit(ball: Ball, t: number, player: THREE.Vector3): HitResult | null {
    const plan = this.plan;
    if (this.serve && !this.serve.tossed && t >= this.serve.tc + this.anim.tossAt()) this.toss(ball);
    if (this.serve?.tossed && t >= this.serve.tc) return this.serveHit(ball, player);
    if (!plan || t < plan.tc - STEP / 2) return null;
    this.plan = null;
    if (!plan.reachable || ball.p.distanceTo(plan.contact) > 0.5) {
      this.misses.push(`${t.toFixed(2)} ${plan.kind} ${plan.reachable ? `off by ${ball.p.distanceTo(plan.contact).toFixed(2)}` : "too far"}`);
      return null; // he didn't get there
    }
    const res = this.shot(ball, plan, player);
    this.lastShot = res.type;
    return res;
  }

  private jitter(a: number, b: number) {
    return this.rng.range(a, b);
  }

  private shot(ball: Ball, plan: Plan, player: THREE.Vector3): HitResult {
    const L = this.level;
    const from = ball.p.clone();
    const playerAtNet = player.z < 7.2;
    const short = from.z > -8.4;
    const special = L.special * (this.rallyAssist ? 0.6 : 1);
    let type: ShotType;
    if (plan.kind === "smash") type = "smash";
    else if (plan.kind === "fvolley" || plan.kind === "bvolley") type = from.y < 0.85 && this.rng.chance(0.35 + special) ? "dropvolley" : "volley";
    else if (playerAtNet) type = this.rng.chance(player.z < 4.5 ? 0.45 : 0.25) ? "lob" : "pass";
    else if (short && this.rng.chance(L.net + 0.12)) type = "approach";
    else if (player.z > C.halfL + 1.2 && from.z > -10.8 && this.rng.chance(special)) type = "drop";
    else if (!this.atNet && this.rng.chance(special * 0.35)) type = "lob";
    else type = "rally";
    const open = player.x > 0 ? -1 : 1; // the side of your court you're not covering
    let shot: Shot;
    let speed = this.jitter(L.pace[0], L.pace[1]);
    const volleyed = plan.kind === "fvolley" || plan.kind === "bvolley";
    const top = volleyed ? -this.jitter(60, 140) : plan.kind === "backhand" && this.rng.chance(0.3) ? -this.jitter(120, 220) : this.jitter(160, 320);
    const assist = this.rallyAssist && (type === "rally" || type === "approach" || type === "volley" || type === "pass");
    if (assist) {
      // to within reach of where you stand, mostly to your forehand
      const fore = this.rng.chance(0.65) ? 1 : -1;
      const lateral = L.reach * this.jitter(0.85, 1.15) * (type === "pass" ? 1.2 : 1);
      const hitY = playerAtNet ? 1.15 : this.jitter(0.9, 1.1);
      const H = new THREE.Vector3(THREE.MathUtils.clamp(player.x + fore * lateral, -(C.halfS + 0.6), C.halfS + 0.6), hitY, player.z - 0.35);
      if (type === "volley" || type === "approach") speed *= 0.95;
      shot = aimToReach(from, H, speed, top, rallyRegion(1, 0.5), 0.35).shot;
    } else {
      let target: THREE.Vector3;
      switch (type) {
        case "approach":
          target = new THREE.Vector3(open * this.jitter(2.6, 3.4), 0, this.jitter(9.2, 10.6));
          speed *= 1.05;
          break;
        case "pass":
          target = new THREE.Vector3(open * this.jitter(3.0, 3.6), 0, this.jitter(6.5, 10));
          speed *= 1.1;
          break;
        case "volley":
          target = new THREE.Vector3(open * this.jitter(1.8, 3.3), 0, this.jitter(8.5, 10.6));
          speed = this.jitter(17, 24);
          break;
        default: {
          // a rally ball: deep, mostly crosscourt (from his right side that's your left), sometimes down the line
          const cross = this.rng.chance(0.68);
          const fromSide = Math.sign(from.x - this.ground.x * 0.3) || 1;
          target = new THREE.Vector3((cross ? -fromSide : fromSide) * this.jitter(1.6, 3.3), 0, this.jitter(8.6, 10.9));
        }
      }
      shot = solveShot(from, target, speed, top, type === "pass" ? 0.2 : 0.4);
    }
    switch (type) {
      case "lob":
        shot = solveLob(from, new THREE.Vector3(this.jitter(-2.5, 2.5), 0, this.jitter(9.8, 11)), this.jitter(0.72, 0.9), this.jitter(80, 200));
        break;
      case "drop":
        shot = solveShot(from, new THREE.Vector3(open * this.jitter(0.5, 2.8), 0, this.jitter(1.5, 2.8)), this.jitter(9, 12), -this.jitter(180, 280), 0.18);
        break;
      case "dropvolley":
        shot = solveShot(from, new THREE.Vector3(open * this.jitter(0.5, 2.5), 0, this.jitter(1.2, 2.4)), this.jitter(6, 9), -this.jitter(150, 250), 0.15);
        break;
      case "smash":
        shot = solveShot(from, new THREE.Vector3(open * this.jitter(1.5, 3.2), 0, this.jitter(6.5, 10)), this.jitter(30, 38), this.jitter(0, 60), 0.1);
        break;
    }
    // now and then an error: long, wide, or into the net
    if (this.rng.chance(type === "rally" || type === "volley" ? L.err : L.err * 1.6)) this.miss(from, shot, speed, top);
    ball.v.copy(shot.v);
    ball.w.copy(shot.w);
    ball.rolling = false;
    // where he goes next: stays in (or comes in) behind an approach or a volley, otherwise back toward the middle
    if (type === "approach" || ((type === "volley" || type === "smash" || type === "dropvolley") && this.atNet) || (type === "rally" && this.atNet)) this.atNet = true;
    else this.atNet = false;
    this.recover.set(THREE.MathUtils.clamp(shot.land.x * 0.22, -1.6, 1.6), 0, type === "approach" ? APPROACH_Z : this.atNet ? NET_Z : HOME_Z);
    return { kind: plan.kind, type, speed: shot.v.length() };
  }

  private miss(from: THREE.Vector3, shot: Shot, speed: number, top: number) {
    if (this.rng.chance(0.5)) {
      const out = shot.land.clone();
      if (this.rng.chance(0.5)) out.z = Math.sign(out.z) * (C.halfL + this.jitter(0.25, 1.1));
      else out.x = (Math.sign(out.x) || 1) * (C.halfS + this.jitter(0.2, 0.8));
      const s = solveShot(from, out, speed, top, 0.3);
      shot.v.copy(s.v);
      shot.w.copy(s.w);
    } else {
      const flat = Math.hypot(shot.v.x, shot.v.z);
      const el = Math.atan2(shot.v.y, flat) - this.jitter(0.07, 0.12);
      const sp = shot.v.length();
      shot.v.set((shot.v.x / flat) * Math.cos(el) * sp, Math.sin(el) * sp, (shot.v.z / flat) * Math.cos(el) * sp);
    }
  }

  // ---------------------------------------------------------------- his serve

  /** His serve: he steps up, bounces into his motion, tosses and serves at tc. */
  startServe(t: number, deuce: boolean, second: boolean) {
    this.placeAt(deuce ? -0.7 : 0.7, -(C.halfL + 0.12));
    const r = this.rng.next();
    const type: ShotType = second ? (r < 0.6 ? "serve-kick" : "serve-slice") : r < 0.45 ? "serve-flat" : r < 0.75 ? "serve-slice" : "serve-kick";
    this.serve = { tc: t + 2.6, deuce, second, tossed: false, type, volley: !second && this.rng.chance(this.level.net * 0.5) };
    this.holdingBall = true;
    this.stroke = { kind: "serve", tc: this.serve.tc, contact: this.anim.contactOffset("serve") };
  }

  get serving() {
    return !!this.serve;
  }

  /** The ball in his left hand (court), while he holds one. */
  ballInHand(out: THREE.Vector3) {
    return this.anim.leftBall(out).add(this.ground);
  }

  private toss(ball: Ball) {
    if (!this.serve) return;
    this.serve.tossed = true;
    this.holdingBall = false;
    const from = this.ballInHand(new THREE.Vector3());
    const C0 = this.anim.contactOffset("serve").add(this.ground);
    const T = -this.anim.tossAt();
    ball.p.copy(from);
    ball.v.set((C0.x - from.x) / T, (C0.y - from.y + 0.5 * GRAVITY * T * T) / T, (C0.z - from.z) / T);
    ball.v.y *= 1.012; // what drag takes on the way
    ball.w.set(0, 0, 0);
    ball.rolling = false;
  }

  private serveHit(ball: Ball, player: THREE.Vector3): HitResult | null {
    const sv = this.serve!;
    this.serve = null;
    const L = this.level;
    const from = ball.p.clone();
    const deuce = sv.deuce;
    const sx = deuce ? 1 : -1; // your deuce court is your right (+x)
    let speed = this.jitter(L.serve[0], L.serve[1]);
    let top = 40;
    let side = 0;
    let target: THREE.Vector3;
    let clear = 0.08;
    const wide = new THREE.Vector3(sx * (C.halfS - 0.45), 0, this.jitter(5.3, 6.0));
    const tee = new THREE.Vector3(sx * 0.4, 0, this.jitter(5.4, 6.0));
    const body = new THREE.Vector3(THREE.MathUtils.clamp(player.x, sx > 0 ? 0.6 : -3.6, sx > 0 ? 3.6 : -0.6), 0, this.jitter(5.0, 5.8));
    switch (sv.type) {
      case "serve-flat":
        target = this.rng.chance(0.55) ? wide : tee;
        top = this.jitter(20, 80);
        break;
      case "serve-slice":
        target = this.rng.chance(0.5) ? body : wide;
        speed *= 0.86;
        top = this.jitter(40, 100);
        side = this.jitter(140, 220); // curves to his left, your right
        break;
      default:
        target = this.rng.chance(0.5) ? body : tee;
        speed *= sv.second ? 0.7 : 0.78;
        top = this.jitter(320, 400);
        side = -this.jitter(40, 90);
        clear = 0.5;
    }
    let shot: Shot;
    if (this.rallyAssist) {
      // into the box, to within reach of where you wait
      const fore = this.rng.chance(0.6) ? 1 : -1;
      const H = new THREE.Vector3(player.x + fore * L.reach * this.jitter(0.75, 1.0), this.jitter(0.95, 1.15), player.z - 0.3);
      shot = aimToReach(from, H, speed * 0.85, top, serveRegion(1, deuce, 0.35), clear).shot;
    } else shot = solveShot(from, target, speed, top, clear, side);
    // faults: long or wide of the box, or into the net
    if (this.rng.chance(sv.second ? L.fault * 0.18 : L.fault)) {
      if (this.rng.chance(0.55)) {
        const out = shot.land.clone();
        if (this.rng.chance(0.6)) out.z = C.service + this.jitter(0.15, 0.7);
        else out.x = sx * (C.halfS + this.jitter(0.15, 0.6));
        shot = solveShot(from, out, speed, top, 0.08, side);
      } else {
        const flat = Math.hypot(shot.v.x, shot.v.z);
        const el = Math.atan2(shot.v.y, flat) - this.jitter(0.05, 0.08);
        const sp = shot.v.length();
        shot.v.set((shot.v.x / flat) * Math.cos(el) * sp, Math.sin(el) * sp, (shot.v.z / flat) * Math.cos(el) * sp);
      }
    }
    ball.v.copy(shot.v);
    ball.w.copy(shot.w);
    ball.rolling = false;
    this.atNet = sv.volley; // serve and volley, now and then
    this.recover.set(deuce ? -0.4 : 0.4, 0, this.atNet ? APPROACH_Z : HOME_Z);
    this.lastShot = sv.type;
    return { kind: "serve", type: sv.type, speed: shot.v.length() };
  }

  // ---------------------------------------------------------------- moving and posing

  /** Once a frame: run, set up, swing, recover; pose the body. ball: court space. */
  update(dt: number, t: number, ball: Ball, ballLive: boolean) {
    this.t = t;
    const plan = this.plan;
    // where to go: the plan's spot (after his reaction), else back toward the middle (or his net position)
    let goal = this.recover;
    if (plan && t >= plan.go) goal = plan.body;
    else if (plan) goal = this.ground;
    if (this.serve) goal = this.ground;
    const to = this.tmp.copy(goal).sub(this.ground).setY(0);
    const dist = to.length();
    const L = this.level;
    // a smooth approach: as fast as he can, slowing to arrive (the last few cm he just settles)
    const top = Math.min(L.speed, this.speedCap);
    const want = dist > 0.02 ? to.multiplyScalar(Math.min(top, Math.sqrt(2 * L.accel * 0.85 * dist)) / dist) : to.set(0, 0, 0);
    const dv = want.sub(this.vel);
    const maxDv = L.accel * dt;
    if (dv.length() > maxDv) dv.setLength(maxDv);
    this.vel.add(dv);
    this.ground.addScaledVector(this.vel, dt);
    this.ground.z = Math.min(this.ground.z, this.greet ? -0.3 : -0.7); // (at the net only to shake your hand)
    // the stroke: started early enough that its contact lands when the ball does
    if (plan && !this.stroke && t >= plan.tc - this.anim.lead(plan.kind)) this.stroke = { kind: plan.kind, tc: plan.tc, contact: new THREE.Vector3() };
    if (this.stroke) {
      if (this.stroke.kind !== "serve" && plan && plan.tc === this.stroke.tc) this.stroke.contact.copy(plan.contact).sub(this.ground);
      if (t > this.stroke.tc + 1.3) this.stroke = null;
    }
    if (this.lookAt) this.look.copy(this.lookAt);
    else this.look.copy(ballLive || this.holdingBall ? ball.p : new THREE.Vector3(0, 1.2, C.halfL));
    this.anim.update({ t, dt, ground: this.ground, vel: this.vel, stroke: this.stroke, split: this.split, look: this.look, holdingBall: this.holdingBall, greet: this.greet });
    this.root.position.copy(this.ground);
    if (this.avatar) {
      this.avatar.pose(t, (local, rootT) => this.anim.apply(local, rootT));
      this.opacity = Math.min(1, this.opacity + Math.max(dt, 1 / 90) / 1.2);
      this.avatar.mesh.opacity = this.opacity;
    }
    this.racket.position.copy(this.anim.racketP);
    this.racket.quaternion.copy(this.anim.racketQ);
    this.shadow.position.set(this.ground.x, 0.005, this.ground.z);
  }

  /** The sweet spot of his racket (court), for checks. */
  sweetSpot(out = new THREE.Vector3()) {
    return out.set(0, RACKET.headC, 0).applyQuaternion(this.racket.quaternion).add(this.racket.position).add(this.ground);
  }

  debug() {
    return {
      ground: this.ground.toArray().map((v) => +v.toFixed(2)),
      vel: +this.vel.length().toFixed(2),
      plan: this.plan ? { kind: this.plan.kind, tc: +(this.plan.tc - this.t).toFixed(2), reachable: this.plan.reachable, contact: this.plan.contact.toArray().map((v) => +v.toFixed(2)) } : null,
      stroke: this.stroke?.kind ?? null,
      atNet: this.atNet,
      serving: this.serving,
      lastShot: this.lastShot,
      rig: !!this.anim.rig,
    };
  }
}
