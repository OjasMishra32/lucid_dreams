// Your record against whoever sits across the board, kept in this browser (localStorage): wins, draws and losses; the
// level they play you at next (one up after you beat them, one down after two losses in a row); and a few lines about
// your last games (when, the result, how long, your colour, your biggest mistake if the engine saw one), which Talk
// passes along so they can bring up real games. Nothing here is ever invented: it's only what happened at this board.

export interface GameNote {
  date: string; // YYYY-MM-DD
  result: "win" | "draw" | "loss"; // yours
  moves: number; // full moves played
  color: "white" | "black"; // yours
  mistake: string | null; // "18. Qxe5" (move number and SAN) where the engine's view swung most against you
}

export interface Tally {
  w: number;
  d: number;
  l: number;
  lostRow: number; // your losses in a row
  level: string | null; // the strength id they play you at next
  games: GameNote[]; // newest last, the last five
}

const KEY = "lucid.chess.record";

function all(): Record<string, Tally> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** Your record against them (empty the first time). */
export function tally(id: string): Tally {
  const empty: Tally = { w: 0, d: 0, l: 0, lostRow: 0, level: null, games: [] };
  return { ...empty, ...all()[id] };
}

/** A game finished: counted, their next level set from `levels` (weakest first), the note kept. Returns the new record. */
export function addGame(id: string, note: GameNote, levels: string[], level: string): Tally {
  const t = tally(id);
  if (note.result === "win") t.w++;
  else if (note.result === "draw") t.d++;
  else t.l++;
  t.lostRow = note.result === "loss" ? t.lostRow + 1 : 0;
  const i = Math.max(0, levels.indexOf(level));
  let next = i;
  if (note.result === "win") next = Math.min(levels.length - 1, i + 1);
  else if (t.lostRow >= 2) {
    next = Math.max(0, i - 1);
    t.lostRow = 0;
  }
  t.level = levels[next];
  t.games = [...t.games, note].slice(-5);
  try {
    const every = all();
    every[id] = t;
    localStorage.setItem(KEY, JSON.stringify(every));
  } catch {
    // no storage: counted for this visit only
  }
  return t;
}

/** "You 2 · Vishal 1 · 1 drawn" */
export function tallyLine(t: Tally, name: string): string {
  return `You ${t.w} · ${name} ${t.l}${t.d ? ` · ${t.d} drawn` : ""}`;
}
