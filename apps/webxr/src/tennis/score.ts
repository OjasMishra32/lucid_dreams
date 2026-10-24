// Tennis scoring, as an umpire keeps it: love, 15, 30, 40, deuce and advantage; games; sets to six, won by two, with
// a tiebreak at six all (first to seven, won by two; the first server serves one point, then two each, starting from
// the ad court for each pair); best of three sets, one set, or a short "first to four games". Calls come from the
// server's side of the score, the way they're read out. Side 0 is you, side 1 the opponent.

export type Side = 0 | 1;
export type Format = "best3" | "set" | "fast4";
export const FORMATS: { id: Format; label: string }[] = [
  { id: "best3", label: "Best of 3 sets" },
  { id: "set", label: "One set" },
  { id: "fast4", label: "First to 4 games" },
];

const WORDS = ["Love", "Fifteen", "Thirty", "Forty"];
const NUM = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen"];
const ORD = ["first", "second", "third"];
const num = (n: number) => NUM[n] ?? String(n); // a long tiebreak runs past fifteen

export interface PointOutcome {
  winner: Side;
  game: boolean;
  set: boolean;
  match: boolean;
  tiebreakStarts: boolean;
  call: string; // what the umpire says
}

export class Score {
  sets: [number, number][] = [];
  games: [number, number] = [0, 0];
  points: [number, number] = [0, 0];
  tiebreak = false;
  winner: Side | null = null;
  private played = 0; // games completed in the match (a tiebreak counts as one)
  private tbFirst: Side = 0;

  constructor(
    public format: Format,
    public firstServer: Side,
    public names: [string, string],
  ) {}

  private get target() {
    return this.format === "fast4" ? 4 : 6;
  }
  private get setsToWin() {
    return this.format === "best3" ? 2 : 1;
  }
  setsWon(s: Side) {
    return this.sets.filter((g) => g[s] > g[1 - s]).length;
  }

  /** Who serves this point. */
  server(): Side {
    if (this.tiebreak) {
      const k = this.points[0] + this.points[1];
      return Math.floor((k + 1) / 2) % 2 === 0 ? this.tbFirst : ((1 - this.tbFirst) as Side);
    }
    return ((this.firstServer + this.played) % 2) as Side;
  }

  /** Serve from the deuce court (the server's right) this point. */
  deuce(): boolean {
    return (this.points[0] + this.points[1]) % 2 === 0;
  }

  private name(s: Side) {
    return s === 0 ? "you" : this.names[1];
  }

  /** The score as called, server first ("Thirty fifteen", "Deuce", "Advantage Federer", "Five four, you"). */
  pointCall(): string {
    const s = this.server();
    const a = this.points[s];
    const b = this.points[1 - s];
    if (this.tiebreak) {
      if (a === b) return `${num(a)} all`;
      const lead: Side = this.points[0] > this.points[1] ? 0 : 1;
      const hi = Math.max(a, b);
      const lo = Math.min(a, b);
      return `${num(hi)} ${num(lo).toLowerCase()}, ${this.name(lead)}`;
    }
    if (a >= 3 && b >= 3) {
      if (a === b) return "Deuce";
      const adv = a > b ? s : ((1 - s) as Side);
      return adv === 0 ? "Advantage, you" : `Advantage ${this.name(1)}`;
    }
    if (a === b) return `${WORDS[a]} all`;
    return `${WORDS[a]} ${WORDS[b].toLowerCase()}`;
  }

  /** The games in this set, as called after a game. */
  private gamesCall(): string {
    const [y, o] = this.games;
    if (y === o) return `${num(y)} ${y === 1 ? "game" : "games"} all.`;
    const lead: Side = y > o ? 0 : 1;
    return lead === 0 ? `You lead ${gamesTo(y, o)}.` : `${this.name(1)} leads ${gamesTo(o, y)}.`;
  }

  /** A point to w. */
  pointTo(w: Side): PointOutcome {
    const out: PointOutcome = { winner: w, game: false, set: false, match: false, tiebreakStarts: false, call: "" };
    if (this.winner !== null) return out;
    const l = (1 - w) as Side;
    this.points[w]++;
    let gameWon = false;
    if (this.tiebreak) gameWon = this.points[w] >= 7 && this.points[w] - this.points[l] >= 2;
    else gameWon = this.points[w] >= 4 && this.points[w] - this.points[l] >= 2;
    if (!gameWon) {
      out.call = this.pointCall();
      return out;
    }
    out.game = true;
    const wasTiebreak = this.tiebreak;
    this.games[w]++;
    this.points = [0, 0];
    this.played++;
    this.tiebreak = false;
    const g = this.games;
    const setWon = wasTiebreak || (this.format === "fast4" ? g[w] >= this.target : g[w] >= this.target && g[w] - g[l] >= 2);
    const who = w === 0 ? "you" : this.name(1);
    if (!setWon) {
      if (this.format !== "fast4" && g[0] === this.target && g[1] === this.target) {
        this.tiebreak = true;
        this.tbFirst = this.server(); // whoever's turn it is serves the first point
        out.tiebreakStarts = true;
        out.call = `Game, ${who}. ${num(g[0])} games all. Tiebreak.`;
      } else out.call = `Game, ${who}. ${this.gamesCall()}`;
      return out;
    }
    out.set = true;
    const n = this.sets.length;
    this.sets.push([g[0], g[1]]);
    this.games = [0, 0];
    const score = gamesTo(Math.max(g[0], g[1]), Math.min(g[0], g[1]));
    if (this.setsWon(w) >= this.setsToWin) {
      this.winner = w;
      out.match = true;
      out.call = w === 0 ? `Game, set and match, you. ${capital(score)}. Well played.` : `Game, set and match, ${this.name(1)}. ${capital(score)}.`;
      return out;
    }
    out.call = `Game and ${ORD[n] ?? "next"} set, ${who}. ${capital(score)}.`;
    return out;
  }

  /** The points as the scoreboard shows them ("15", "40", "AD", tiebreak numbers). */
  pointLabel(s: Side): string {
    const a = this.points[s];
    const b = this.points[1 - s];
    if (this.tiebreak) return String(a);
    if (a >= 3 && b >= 3) return a > b ? "AD" : a === b ? "40" : "";
    return ["0", "15", "30", "40"][a];
  }
}

/** "four games to two", "one game to love" */
function gamesTo(hi: number, lo: number) {
  return `${num(hi).toLowerCase()} ${hi === 1 ? "game" : "games"} to ${lo === 0 ? "love" : num(lo).toLowerCase()}`;
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
