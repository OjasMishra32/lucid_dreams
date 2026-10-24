// Stockfish 19 (lite, single-threaded WASM) as a separate Web Worker, spoken to over UCI.

export interface Strength {
  id: string;
  label: string;
  elo: number | null; // null = full strength
  legend?: string; // whose peak rating this is
  avatar?: string[]; // their avatar dream ids, best first: the first that exists sits across the board
}

export const STRENGTHS: Strength[] = [
  { id: "club", label: "Club", elo: 1400 },
  { id: "expert", label: "Expert", elo: 2000 },
  { id: "master", label: "Master", elo: 2400 },
  { id: "gm", label: "Grandmaster", elo: 2700 },
  // legends: the engine set to the player's peak FIDE rating, with their likeness across the board when we have it
  // (the face-swapped bundle first, then the photo avatar). They never speak, and they're always labelled as the
  // engine: not the person, and never presented as them.
  { id: "fischer", label: "Fischer 2785", elo: 2785, legend: "Bobby Fischer", avatar: ["bobby-fischer-lhm"] },
  { id: "carlsen", label: "Carlsen 2882", elo: 2882, legend: "Magnus Carlsen", avatar: ["magnus-carlsen-lhm"] },
  { id: "max", label: "Engine", elo: null },
];

export class Engine {
  private worker = new Worker("/engine/stockfish-19-lite-single.js");
  private listeners: ((line: string) => void)[] = [];
  private ready: Promise<void>;

  constructor() {
    this.worker.onmessage = (e) => {
      const line = String(e.data);
      for (const l of [...this.listeners]) l(line);
    };
    this.ready = this.until("uciok", "uci").then(() => this.until("readyok", "isready")).then(() => {});
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private until(token: string, cmd?: string): Promise<string> {
    return new Promise((resolve) => {
      const l = (line: string) => {
        if (line.startsWith(token)) {
          this.listeners = this.listeners.filter((x) => x !== l);
          resolve(line);
        }
      };
      this.listeners.push(l);
      if (cmd) this.send(cmd);
    });
  }

  async setStrength(s: Strength) {
    await this.ready;
    if (s.elo === null) {
      this.send("setoption name UCI_LimitStrength value false");
    } else {
      this.send("setoption name UCI_LimitStrength value true");
      // Stockfish's UCI_Elo floor is about 1320
      this.send(`setoption name UCI_Elo value ${Math.max(1320, s.elo)}`);
    }
    await this.until("readyok", "isready");
  }

  /**
   * Best move for a FEN, in UCI notation (e.g. "e2e4", "e7e8q"). Thinks a little longer at higher strengths. onInfo
   * hears each depth's evaluation as the search deepens: centipawns for the side to move (a mate is +-10000), and
   * the move it currently thinks best (UCI), when the line carries one.
   */
  async bestMove(fen: string, s: Strength, onInfo?: (depth: number, cp: number, pv?: string) => void): Promise<string> {
    await this.ready;
    this.send(`position fen ${fen}`);
    const ms = s.elo === null ? 1500 : s.elo >= 2600 ? 1200 : s.elo >= 2200 ? 900 : 600;
    const info = (line: string) => {
      const m = /^info .*?\bdepth (\d+)\b.*?\bscore (cp|mate) (-?\d+)/.exec(line);
      if (!m || / (lower|upper)bound/.test(line)) return;
      const n = Number(m[3]);
      onInfo?.(Number(m[1]), m[2] === "cp" ? n : Math.sign(n || -1) * 10000, / pv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line)?.[1]);
    };
    if (onInfo) this.listeners.push(info);
    try {
      const line = await this.until("bestmove", `go movetime ${ms}`);
      return line.split(/\s+/)[1];
    } finally {
      this.listeners = this.listeners.filter((x) => x !== info);
    }
  }

  newGame() {
    this.send("ucinewgame");
  }

  dispose() {
    this.worker.terminate();
  }
}
