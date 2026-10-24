// Checks the legends' famous positions (src/chess/famous-games.ts) before any of them is shown:
//   1. the whole game score replays legally with chess.js (the app's chess library), and the move named in `find` is
//      the move the score has at that point;
//   2. a `coming` line (a game that ended at the famous move) is legal from there and ends in mate;
//   3. the app's own Stockfish 19 (public/engine/stockfish-19-lite-single.js; Node runs the byte-identical copy in
//      node_modules/stockfish, whose package is CommonJS, and the check fails if the two differ) at MultiPV 8, depth 22,
//      has the famous move as its best move (or within 0.3 of the best, or the same mate);
//   4. when it wins, every other move that also wins (+3 or better for the side to move) is listed in alsoWins, and
//      everything listed there wins too (+2 or better, so a line on the edge doesn't flicker between runs).
// Fails on anything else. Prints each position's FEN, the engine's top lines and the verdict.
//   node scripts/check_famous.ts [--depth 22] [--only id,id] [--json out.json]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { FAMOUS, plyOf, sanList } from "../src/chess/famous-games.ts";

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const DEPTH = Number(opt("--depth") ?? 22);
const ONLY = opt("--only")?.split(",");
const WIN = 300; // centipawns for the side to move: "wins"
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(HERE, "../node_modules/stockfish/bin/stockfish-19-lite-single.js");
for (const ext of [".js", ".wasm"]) {
  const app = readFileSync(resolve(HERE, `../public/engine/stockfish-19-lite-single${ext}`));
  if (!app.equals(readFileSync(ENGINE.replace(/\.js$/, ext)))) throw new Error(`public/engine/stockfish-19-lite-single${ext} isn't node_modules/stockfish's: check against the app's engine`);
}

type Line = { move: string; cp: number; mate: number | null; pv: string[] };

function engine() {
  const p = spawn(process.execPath, [ENGINE], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const listeners = new Set<(l: string) => void>();
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      for (const l of [...listeners]) l(line);
    }
  });
  const send = (c: string) => p.stdin.write(c + "\n");
  const until = (tok: string, cmd?: string) =>
    new Promise<string>((res) => {
      const l = (line: string) => {
        if (line.startsWith(tok)) {
          listeners.delete(l);
          res(line);
        }
      };
      listeners.add(l);
      if (cmd) send(cmd);
    });
  const ready = until("uciok", "uci").then(() => until("readyok", "isready"));
  return {
    async analyse(fen: string, multipv: number, depth: number): Promise<Line[]> {
      await ready;
      send("ucinewgame");
      send(`setoption name MultiPV value ${multipv}`);
      await until("readyok", "isready");
      send(`position fen ${fen}`);
      const lines = new Map<number, Line & { depth: number }>();
      const l = (line: string) => {
        if (!line.startsWith("info") || / (lower|upper)bound/.test(line)) return;
        const m = /\bdepth (\d+)\b.*?\bmultipv (\d+)\b.*?\bscore (cp|mate) (-?\d+)\b.*?\bpv (.+)$/.exec(line);
        if (!m) return;
        const n = Number(m[4]);
        const mate = m[3] === "mate" ? n : null;
        const pv = m[5].split(" ");
        lines.set(Number(m[2]), { depth: Number(m[1]), move: pv[0], cp: mate === null ? n : Math.sign(n || -1) * (100000 - Math.abs(n)), mate, pv });
      };
      listeners.add(l);
      await until("bestmove", `go depth ${depth}`);
      listeners.delete(l);
      return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    },
    quit: () => p.kill(),
  };
}

const show = (l: Line) => (l.mate !== null ? `#${l.mate}` : `${l.cp >= 0 ? "+" : ""}${(l.cp / 100).toFixed(2)}`);
const uciToSan = (fen: string, pv: string[], n = 8) => {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, n)) {
    try {
      out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    } catch {
      break;
    }
  }
  return out;
};

const sf = engine();
const report: Record<string, unknown>[] = [];
let failed = 0;
for (const g of FAMOUS) {
  if (ONLY && !ONLY.includes(g.id)) continue;
  const problems: string[] = [];
  const sans = sanList(g.moves);
  const c = new Chess();
  let fen = "";
  const { ply, san } = plyOf(g.find);
  for (const [i, m] of sans.entries()) {
    if (i === ply) fen = c.fen();
    try {
      c.move(m);
    } catch {
      problems.push(`illegal move ${m} at ply ${i + 1}`);
      break;
    }
  }
  const replayed = c.history().length;
  if (replayed === sans.length && sans[ply] !== san) problems.push(`the score has ${sans[ply]} at ${g.find}, not ${san}`);
  if (ply + 1 + g.play > sans.length) problems.push(`play ${g.play} runs past the score`);
  // the coming line and the claims, from where the shown moves end
  const end = new Chess(fen || undefined);
  if (fen) for (const m of sans.slice(ply, ply + 1 + g.play)) end.move(m);
  if (g.coming) {
    const t = new Chess(end.fen());
    try {
      for (const m of sanList(g.coming)) t.move(m);
      if (!t.isCheckmate()) problems.push(`coming "${g.coming}" doesn't end in mate`);
    } catch {
      problems.push(`coming "${g.coming}" isn't legal`);
    }
  }
  let verdict = "";
  let top: Line[] = [];
  if (fen && !problems.length) {
    const pos = new Chess(fen);
    const want = pos.move(san);
    const wantUci = want.from + want.to + (want.promotion ?? "");
    top = await sf.analyse(fen, 8, DEPTH);
    const best = top[0];
    const mine = top.find((l) => l.move === wantUci);
    const next = top.find((l) => l.move !== wantUci);
    if (!mine) problems.push(`Stockfish doesn't have ${san} in its top 8`);
    else {
      const isBest = mine === best || (mine.mate !== null && mine.mate === best.mate) || best.cp - mine.cp <= 30;
      const wins = mine.cp >= WIN;
      if (!isBest) problems.push(`${san} is ${show(mine)}, best is ${uciToSan(fen, [best.move])[0]} ${show(best)}`);
      verdict = `${san} ${show(mine)}${mine === best ? ", Stockfish's first choice" : ", level with the best"}${wins ? ", winning" : ""}${next ? `; best other move ${uciToSan(fen, [next.move])[0]} ${show(next)}` : ""}`;
    }
    const sanOf = (l: Line) => uciToSan(fen, [l.move])[0];
    const listed = g.alsoWins ?? [];
    if (mine && mine.cp >= WIN)
      for (const l of top) if (l.move !== wantUci && l.cp >= WIN && !listed.includes(sanOf(l))) problems.push(`${sanOf(l)} also wins (${show(l)}) but isn't in alsoWins`);
    for (const a of listed) {
      const l = top.find((x) => sanOf(x) === a);
      if (!l || l.cp < WIN - 100) problems.push(`alsoWins lists ${a}, which Stockfish doesn't find winning${l ? ` (${show(l)})` : ""}`);
    }
  }
  const ok = !problems.length;
  if (!ok) failed++;
  console.log(`\n${ok ? "ok  " : "FAIL"} ${g.id}: ${g.white} vs ${g.black}, ${g.where}  (${g.find})`);
  console.log(`     score: ${replayed}/${sans.length} moves replayed legally${g.coming ? `; coming ${g.coming}` : ""}`);
  if (fen) console.log(`     fen:   ${fen}`);
  if (verdict) console.log(`     engine (depth ${DEPTH}): ${verdict}`);
  top.slice(0, 3).forEach((l, i) => console.log(`       ${i + 1}. ${show(l).padStart(7)}  ${uciToSan(fen, l.pv).join(" ")}`));
  if (g.alsoWins?.length) console.log(`     also wins (not a miss): ${g.alsoWins.join(", ")}`);
  for (const p of problems) console.log(`     ! ${p}`);
  report.push({ id: g.id, ok, fen, find: g.find, replayed, total: sans.length, verdict, problems, top: top.map((l) => ({ eval: show(l), line: uciToSan(fen, l.pv).join(" ") })) });
}
sf.quit();
const json = opt("--json");
if (json) writeFileSync(json, JSON.stringify(report, null, 2));
console.log(`\n${failed ? `${failed} FAILED` : "all ok"} (${report.length} positions)`);
process.exit(failed ? 1 : 0);
