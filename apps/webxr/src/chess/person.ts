// The opponent's habits: how long they think, which way they move a piece, and what they do with themselves between
// moves. All of it is drawn from a seeded random, so a game is varied but plays out the same way for the same seed,
// and nothing a person would notice (an idle pose, a way of reaching) comes twice in a row. seated.ts turns these
// choices into a body.

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** mulberry32: small, fast, good enough for gestures. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  chance(p: number) {
    return this.next() < p;
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
  pick<T>(items: readonly T[], weights?: readonly number[]): T {
    if (!weights) return items[Math.floor(this.next() * items.length) % items.length];
    const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
    let x = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      x -= Math.max(0, weights[i]);
      if (x < 0) return items[i];
    }
    return items[items.length - 1];
  }
}

/** FNV-1a over the parts: a seed from an opponent id, a game number, a move number. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const p of parts)
    for (const ch of `${p}|`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
  return h >>> 0;
}

// ---------------- between moves ----------------

/**
 * What they do with themselves between moves, the way players at a board do: long still stretches of concentration
 * (breathing, eyes moving), the eyes working over the squares that matter, small settles of posture, leaning in and
 * sitting back. The variety is in the head, the eyes and the trunk; the hands stay low and still where they rest
 * (a photo-built avatar's hands are its weakest part, and nobody at a board waves theirs about).
 *
 * still: concentration, nothing but breathing and the eyes. rest: at ease, the head a little freer. scan: the eyes
 * walk the board square by square. leanIn: leaning in over the board. leanBack: sitting back. shift: a settle in the
 * seat, weight to one hip, the shoulders rising and coming down. breath: a deeper breath in, and the shoulders let go.
 * neckRoll / shoulderRoll: a slow, small loosening of the neck or shoulders (rare). ready: while the other hand moves.
 * chin, cheek, clasped, forearms, armsFolded: hands at the face or folded against the body; off (they sank into a
 * photo-built body), kept for avatars whose bodies the clearance guard allows them on.
 */
export type IdleKind =
  | "still" | "rest" | "scan" | "leanIn" | "leanBack" | "shift" | "breath" | "neckRoll" | "shoulderRoll" | "ready"
  | "chin" | "cheek" | "clasped" | "forearms" | "armsFolded";
export type Mode = "think" | "wait" | "move" | "over";

/** Kinds done by one particular hand (or toward one side): each side is checked, and chosen, on its own. */
export const SIDED: IdleKind[] = ["chin", "cheek", "shift"];

const WEIGHTS: Record<Exclude<Mode, "move">, Partial<Record<IdleKind, number>>> = {
  // their own move to find: mostly stillness and the eyes
  think: { still: 3, scan: 2.6, leanIn: 1.2, rest: 0.8, shift: 0.6, breath: 0.6, leanBack: 0.4, shoulderRoll: 0.2, neckRoll: 0.15 },
  // your move: watching, more at ease
  wait: { still: 1.6, leanBack: 1.6, rest: 1.4, scan: 0.8, shift: 0.8, breath: 0.7, leanIn: 0.5, shoulderRoll: 0.35, neckRoll: 0.3 },
  over: { rest: 1, leanBack: 1, breath: 0.5 },
};

/** The next idle pose for this moment: never the one they're coming from, and only one the body allows (ok). */
export function pickIdle(rng: Rng, mode: Mode, last: IdleKind | null, ok: (k: IdleKind) => boolean = () => true): IdleKind {
  const w = WEIGHTS[mode === "move" ? "wait" : mode];
  const kinds = (Object.keys(w) as IdleKind[]).filter((k) => k !== last && (w[k] ?? 0) > 0 && ok(k));
  return kinds.length ? rng.pick(kinds, kinds.map((k) => w[k] ?? 0)) : last === "rest" ? "still" : "rest";
}

/**
 * How long a pose is held before the next one, seconds: concentration lasts, the small settles run their course.
 * pressure (0..1, a short clock) makes everything quicker.
 */
export function holdSeconds(rng: Rng, mode: Mode, kind: IdleKind = "rest", pressure = 0) {
  const k = 1 - 0.5 * clamp(pressure, 0, 1);
  if (kind === "neckRoll") return rng.range(2.9, 3.4);
  if (kind === "shoulderRoll") return rng.range(1.9, 2.4);
  if (kind === "shift" || kind === "breath") return rng.range(1.8, 3.2) * k;
  if (kind === "still") return (mode === "think" ? rng.range(4, 10) : rng.range(4, 9)) * k;
  if (kind === "scan") return rng.range(2.5, 5) * k;
  if (mode === "think") return rng.range(2, 4.5) * k;
  if (mode === "over") return rng.range(5, 10);
  return rng.range(3, 7) * k;
}

// ---------------- a move ----------------

/** A way of moving a piece. Every number scales or offsets the hand's path; none is used twice in a row. */
export interface Style {
  id: "brisk" | "careful" | "casual" | "decisive";
  speed: number; // 1 = the base timing; durations divide by it
  hover: number; // meters above the piece's grip before the fingers come down
  lift: number; // how high the piece travels, relative
  bow: number; // how far the hand's path arcs sideways, relative
  skew: number; // easing skew: > 0 accelerates early and settles long, like a real reach
  beta: number; // radians the fingers point below horizontal at a piece
  roll: number; // radians the thumb side lifts
  open: number; // finger curl on the way in (< 0: spread a little; kept small, a hand's Gaussians stretch when it bends)
  settle: number; // seconds the hand lingers lifting off a placed piece
  overshoot: number; // meters past the square before settling onto it
  adjust: number; // added chance of re-centring the piece after setting it down
  lean: number; // extra lean toward far squares, radians
}

export const STYLES: Style[] = [
  { id: "brisk", speed: 1.12, hover: 0.026, lift: 0.75, bow: 0.6, skew: 0.25, beta: 0.86, roll: 0.3, open: -0.08, settle: 0.14, overshoot: 0, adjust: 0, lean: 0.05 },
  { id: "careful", speed: 0.8, hover: 0.04, lift: 1.0, bow: 0.35, skew: 0.06, beta: 1.0, roll: 0.42, open: -0.1, settle: 0.24, overshoot: 0, adjust: 0.15, lean: 0.12 },
  { id: "casual", speed: 0.95, hover: 0.032, lift: 0.6, bow: 1.0, skew: 0.16, beta: 0.76, roll: 0.22, open: -0.05, settle: 0.18, overshoot: 0.008, adjust: 0.05, lean: 0.0 },
  { id: "decisive", speed: 1.2, hover: 0.024, lift: 0.85, bow: 0.45, skew: 0.36, beta: 0.95, roll: 0.36, open: -0.08, settle: 0.1, overshoot: 0, adjust: 0, lean: 0.07 },
];

/** Hard positions bring out the careful hand, easy ones the decisive one; never last move's style. */
export function pickStyle(rng: Rng, last: string | null, hardness: number): Style {
  const h = clamp(hardness, 0, 1);
  const w: Record<Style["id"], number> = { brisk: 1, careful: 0.5 + 1.8 * h, casual: 1.1 - 0.6 * h, decisive: 1.3 - 1.0 * h };
  const options = STYLES.filter((s) => s.id !== last);
  return rng.pick(options, options.map((s) => w[s.id]));
}

/** A second thought on the way to the piece: the hand stops a moment just above it before coming down. */
export type Hesitation = "hover";

export function pickHesitation(rng: Rng, last: Hesitation | null, hardness: number): Hesitation | null {
  if (last || !rng.chance(0.05 + 0.4 * clamp(hardness, 0, 1))) return null; // never twice running
  return "hover";
}

// ---------------- thinking ----------------

/** What the position looks like to someone sitting at it, from the board and the engine's search. */
export interface Position {
  ply: number; // half-moves played
  legal: number; // legal moves for them
  inCheck: boolean;
  swing: number; // centipawns: how much your last move changed their view of the game
  bestChanges: number; // how often the engine changed its mind about the best move as it searched deeper
  evalCp: number; // their evaluation now
  recapture: boolean; // the move takes back on the square you just took on
  clockS: number; // seconds left on their clock
}

/**
 * How long they sit with the position before reaching, in milliseconds, and how hard it was (0..1, which also
 * shapes the reach). Openings and forced moves come quickly, sharp positions slowly, and a short clock hurries them.
 */
export function thinkTime(rng: Rng, p: Position): { ms: number; hardness: number } {
  if (p.legal <= 1) return { ms: rng.range(600, 1100), hardness: 0 };
  let h =
    0.35 * clamp(p.bestChanges / 3, 0, 1) +
    0.25 * clamp(Math.abs(p.swing) / 180, 0, 1) +
    (p.inCheck ? 0.12 : 0) +
    0.12 * clamp((p.legal - 18) / 22, 0, 1) +
    (Math.abs(p.evalCp) < 60 ? 0.08 : 0) +
    rng.range(-0.08, 0.12);
  if (p.recapture) h *= 0.4;
  if (p.ply < 8) h *= 0.6; // the opening is familiar ground
  h = clamp(h, 0, 1);
  let s = p.ply < 8 ? rng.range(0.9, 2.0) + 1.5 * h : (1.6 + 0.035 * p.legal + 4.8 * h) * Math.exp(rng.range(-0.25, 0.3));
  if (p.recapture) s = Math.min(s, rng.range(0.9, 1.7));
  s *= clamp(p.clockS / 90, 0.35, 1);
  return { ms: clamp(s, 0.7, 9.5) * 1000, hardness: h };
}
