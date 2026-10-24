// The legends' famous moves: positions from their real games, the moment before the move they're remembered for.
// Each game's score is its main line as published by chessgames.com (the game's own page, cited in `source`), checked
// by scripts/check_famous.ts: every move replayed legally by chess.js, the famous move found by the app's own
// Stockfish 19 (lite) as its best move (MultiPV 8, depth 22), and every other move that also wins (+3 or better for
// the side to move) listed in alsoWins, so finding one of those is never called a miss. No imports: the checker runs
// this file under plain Node.

export interface FamousGame {
  id: string;
  legend: "fischer" | "carlsen";
  white: string; // as the card names them
  black: string;
  where: string; // event, place and year
  nickname?: string;
  source: string; // where the score comes from
  /** The game from move 1, SAN with move numbers, up to the end (or as far as it plays out here). */
  moves: string;
  /** The famous move as numbered SAN ("17...Be6"): the position is the moment before it. */
  find: string;
  /** Plies of the real game that play out after it (both sides). */
  play: number;
  /** When the game ended at the famous move: the forced line that was coming (engine-checked), shown as such. */
  coming?: string;
  /** Said once it's played (or shown): what happened next. */
  after: string;
  /** Other moves (SAN) that also win in that position: told so, never counted as a miss. */
  alsoWins?: string[];
}

export const FAMOUS: FamousGame[] = [
  // ---------------- Bobby Fischer ----------------
  {
    id: "byrne-fischer-1956",
    legend: "fischer",
    white: "D. Byrne",
    black: "Fischer",
    where: "Rosenwald Memorial, New York 1956",
    nickname: "The Game of the Century",
    source: "chessgames.com, game 1008361",
    moves: `1.Nf3 Nf6 2.c4 g6 3.Nc3 Bg7 4.d4 O-O 5.Bf4 d5 6.Qb3 dxc4 7.Qxc4 c6 8.e4 Nbd7 9.Rd1 Nb6 10.Qc5 Bg4 11.Bg5
      Na4 12.Qa3 Nxc3 13.bxc3 Nxe4 14.Bxe7 Qb6 15.Bc4 Nxc3 16.Bc5 Rfe8+ 17.Kf1 Be6 18.Bxb6 Bxc4+ 19.Kg1 Ne2+
      20.Kf1 Nxd4+ 21.Kg1 Ne2+ 22.Kf1 Nc3+ 23.Kg1 axb6 24.Qb4 Ra4 25.Qxb6 Nxd1 26.h3 Rxa2 27.Kh2 Nxf2 28.Re1
      Rxe1 29.Qd8+ Bf8 30.Nxe1 Bd5 31.Nf3 Ne4 32.Qb8 b5 33.h4 h5 34.Ne5 Kg7 35.Kg1 Bc5+ 36.Kf1 Ng3+ 37.Ke1
      Bb4+ 38.Kd1 Bb3+ 39.Kc1 Ne2+ 40.Kb1 Nc3+ 41.Kc1 Rc2#`,
    find: "17...Be6",
    play: 6,
    after: "He gave up his queen. The windmill of checks took back more than it cost, and mate came on move 41.",
  },
  {
    id: "fischer-reshevsky-1958",
    legend: "fischer",
    white: "Fischer",
    black: "Reshevsky",
    where: "US Championship, New York 1958",
    source: "chessgames.com, game 1008376",
    moves: `1.e4 c5 2.Nf3 Nc6 3.d4 cxd4 4.Nxd4 g6 5.Be3 Bg7 6.Nc3 Nf6 7.Bc4 O-O 8.Bb3 Na5 9.e5 Ne8 10.Bxf7+ Kxf7
      11.Ne6 dxe6 12.Qxd8 Nc6 13.Qd2 Bxe5 14.O-O Nd6 15.Bf4 Nc4 16.Qe2 Bxf4 17.Qxc4 Kg7 18.Ne4 Bc7 19.Nc5 Rf6
      20.c3 e5 21.Rad1 Nd8 22.Nd7 Rc6 23.Qh4 Re6 24.Nc5 Rf6 25.Ne4 Rf4 26.Qxe7+ Rf7 27.Qa3 Nc6 28.Nd6 Bxd6
      29.Rxd6 Bf5 30.b4 Rff8 31.b5 Nd8 32.Rd5 Nf7 33.Rc5 a6 34.b6 Be4 35.Re1 Bc6 36.Rxc6 bxc6 37.b7 Rab8
      38.Qxa6 Nd8 39.Rb1 Rf7 40.h3 Rfxb7 41.Rxb7+ Rxb7 42.Qa8`,
    find: "10.Bxf7+",
    play: 4,
    after: "11.Ne6 wins the queen. Reshevsky fought on until move 42.",
  },
  {
    id: "fischer-fine-1963",
    legend: "fischer",
    white: "Fischer",
    black: "Fine",
    where: "New York 1963, an offhand game",
    source: "chessgames.com, game 1043992",
    moves: `1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.b4 Bxb4 5.c3 Ba5 6.d4 exd4 7.O-O dxc3 8.Qb3 Qe7 9.Nxc3 Nf6 10.Nd5 Nxd5
      11.exd5 Ne5 12.Nxe5 Qxe5 13.Bb2 Qg5 14.h4 Qxh4 15.Bxg7 Rg8 16.Rfe1+ Kd8 17.Qg3`,
    find: "17.Qg3",
    play: 0,
    after: "Fine resigned: mate is coming.",
    alsoWins: ["Qb2"],
  },
  {
    id: "rbyrne-fischer-1963",
    legend: "fischer",
    white: "R. Byrne",
    black: "Fischer",
    where: "US Championship, New York 1963",
    source: "chessgames.com, game 1008419",
    moves: `1.d4 Nf6 2.c4 g6 3.g3 c6 4.Bg2 d5 5.cxd5 cxd5 6.Nc3 Bg7 7.e3 O-O 8.Nge2 Nc6 9.O-O b6 10.b3 Ba6 11.Ba3
      Re8 12.Qd2 e5 13.dxe5 Nxe5 14.Rfd1 Nd3 15.Qc2 Nxf2 16.Kxf2 Ng4+ 17.Kg1 Nxe3 18.Qd2 Nxg2 19.Kxg2 d4
      20.Nxd4 Bb7+ 21.Kf1 Qd7`,
    find: "15...Nxf2",
    play: 6,
    after: "Byrne resigned after 21...Qd7, while grandmasters in the analysis room still thought he stood better.",
  },
  {
    id: "fischer-benko-1963",
    legend: "fischer",
    white: "Fischer",
    black: "Benko",
    where: "US Championship, New York 1963",
    source: "chessgames.com, game 1008421",
    moves: `1.e4 g6 2.d4 Bg7 3.Nc3 d6 4.f4 Nf6 5.Nf3 O-O 6.Bd3 Bg4 7.h3 Bxf3 8.Qxf3 Nc6 9.Be3 e5 10.dxe5 dxe5 11.f5
      gxf5 12.Qxf5 Nd4 13.Qf2 Ne8 14.O-O Nd6 15.Qg3 Kh8 16.Qg4 c6 17.Qh5 Qe8 18.Bxd4 exd4 19.Rf6 Kg8 20.e5 h6
      21.Ne2`,
    find: "19.Rf6",
    play: 4,
    after: "Benko resigned two moves later. Fischer won the championship 11 out of 11.",
  },
  {
    id: "fischer-myagmarsuren-1967",
    legend: "fischer",
    white: "Fischer",
    black: "Myagmarsuren",
    where: "Sousse Interzonal 1967",
    source: "chessgames.com, game 1044267",
    moves: `1.e4 e6 2.d3 d5 3.Nd2 Nf6 4.g3 c5 5.Bg2 Nc6 6.Ngf3 Be7 7.O-O O-O 8.e5 Nd7 9.Re1 b5 10.Nf1 b4 11.h4 a5
      12.Bf4 a4 13.a3 bxa3 14.bxa3 Na5 15.Ne3 Ba6 16.Bh3 d4 17.Nf1 Nb6 18.Ng5 Nd5 19.Bd2 Bxg5 20.Bxg5 Qd7
      21.Qh5 Rfc8 22.Nd2 Nc3 23.Bf6 Qe8 24.Ne4 g6 25.Qg5 Nxe4 26.Rxe4 c4 27.h5 cxd3 28.Rh4 Ra7 29.Bg2 dxc2
      30.Qh6 Qf8 31.Qxh7+`,
    find: "31.Qxh7+",
    play: 0,
    coming: "31...Kxh7 32.hxg6+ Kxg6 33.Be4#",
    after: "Myagmarsuren resigned rather than face it.",
  },
  // ---------------- Magnus Carlsen ----------------
  {
    id: "carlsen-ernst-2004",
    legend: "carlsen",
    white: "Carlsen",
    black: "Ernst",
    where: "Corus C, Wijk aan Zee 2004",
    nickname: "He was 13",
    source: "chessgames.com, game 1272702",
    moves: `1.e4 c6 2.d4 d5 3.Nc3 dxe4 4.Nxe4 Bf5 5.Ng3 Bg6 6.h4 h6 7.Nf3 Nd7 8.h5 Bh7 9.Bd3 Bxd3 10.Qxd3 e6 11.Bf4
      Ngf6 12.O-O-O Be7 13.Ne4 Qa5 14.Kb1 O-O 15.Nxf6+ Nxf6 16.Ne5 Rad8 17.Qe2 c5 18.Ng6 fxg6 19.Qxe6+ Kh8
      20.hxg6 Ng8 21.Bxh6 gxh6 22.Rxh6+ Nxh6 23.Qxe7 Nf7 24.gxf7 Kg7 25.Rd3 Rd6 26.Rg3+ Rg6 27.Qe5+ Kxf7
      28.Qf5+ Rf6 29.Qd7#`,
    find: "18.Ng6",
    play: 6,
    after: "Then the bishop went on h6 too, and it was mate on move 29.",
  },
  {
    id: "anand-carlsen-2013",
    legend: "carlsen",
    white: "Anand",
    black: "Carlsen",
    where: "World Championship, Chennai 2013, game 9",
    source: "chessgames.com, game 1737896",
    moves: `1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 4.f3 d5 5.a3 Bxc3+ 6.bxc3 c5 7.cxd5 exd5 8.e3 c4 9.Ne2 Nc6 10.g4 O-O 11.Bg2
      Na5 12.O-O Nb3 13.Ra2 b5 14.Ng3 a5 15.g5 Ne8 16.e4 Nxc1 17.Qxc1 Ra6 18.e5 Nc7 19.f4 b4 20.axb4 axb4
      21.Rxa6 Nxa6 22.f5 b3 23.Qf4 Nc7 24.f6 g6 25.Qh4 Ne8 26.Qh6 b2 27.Rf4 b1=Q+ 28.Nf1 Qe1`,
    find: "28...Qe1",
    play: 0,
    after: "The queen stops Rh4 and White's attack is over. Anand resigned, and a draw later made Carlsen world champion.",
  },
  {
    id: "carlsen-anand-2014",
    legend: "carlsen",
    white: "Carlsen",
    black: "Anand",
    where: "World Championship, Sochi 2014, game 2",
    source: "chessgames.com, game 1778628",
    moves: `1.e4 e5 2.Nf3 Nc6 3.Bb5 Nf6 4.d3 Bc5 5.O-O d6 6.Re1 O-O 7.Bxc6 bxc6 8.h3 Re8 9.Nbd2 Nd7 10.Nc4 Bb6 11.a4
      a5 12.Nxb6 cxb6 13.d4 Qc7 14.Ra3 Nf8 15.dxe5 dxe5 16.Nh4 Rd8 17.Qh5 f6 18.Nf5 Be6 19.Rg3 Ng6 20.h4 Bxf5
      21.exf5 Nf4 22.Bxf4 exf4 23.Rc3 c5 24.Re6 Rab8 25.Rc4 Qd7 26.Kh2 Rf8 27.Rce4 Rb7 28.Qe2 b5 29.b3 bxa4
      30.bxa4 Rb4 31.Re7 Qd6 32.Qf3 Rxe4 33.Qxe4 f3+ 34.g3 h5 35.Qb7`,
    find: "35.Qb7",
    play: 0,
    after: "Anand resigned. It was the match's first decisive game.",
    alsoWins: ["c3", "Ra7"],
  },
  {
    id: "carlsen-karjakin-2016",
    legend: "carlsen",
    white: "Carlsen",
    black: "Karjakin",
    where: "World Championship tiebreak, New York 2016",
    source: "chessgames.com, game 1848607",
    moves: `1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.f3 e5 6.Nb3 Be7 7.c4 a5 8.Be3 a4 9.Nc1 O-O 10.Nc3 Qa5 11.Qd2 Na6
      12.Be2 Nc5 13.O-O Bd7 14.Rb1 Rfc8 15.b4 axb3 16.axb3 Qd8 17.Nd3 Ne6 18.Nb4 Bc6 19.Rfd1 h5 20.Bf1 h4
      21.Qf2 Nd7 22.g3 Ra3 23.Bh3 Rca8 24.Nc2 R3a6 25.Nb4 Ra5 26.Nc2 b6 27.Rd2 Qc7 28.Rbd1 Bf8 29.gxh4 Nf4
      30.Bxf4 exf4 31.Bxd7 Qxd7 32.Nb4 Ra3 33.Nxc6 Qxc6 34.Nb5 Rxb3 35.Nd4 Qxc4 36.Nxb3 Qxb3 37.Qe2 Be7 38.Kg2
      Qe6 39.h5 Ra3 40.Rd3 Ra2 41.R3d2 Ra3 42.Rd3 Ra7 43.Rd5 Rc7 44.Qd2 Qf6 45.Rf5 Qh4 46.Rc1 Ra7 47.Qxf4 Ra2+
      48.Kh1 Qf2 49.Rc8+ Kh7 50.Qh6+`,
    find: "50.Qh6+",
    play: 0,
    coming: "50...Kxh6 51.Rh8#",
    after: "Karjakin resigned, and Carlsen kept his title.",
  },
  {
    id: "nepomniachtchi-carlsen-2021",
    legend: "carlsen",
    white: "Nepomniachtchi",
    black: "Carlsen",
    where: "World Championship, Dubai 2021, game 9",
    source: "chessgames.com, game 2135792",
    moves: `1.c4 e6 2.g3 d5 3.Bg2 d4 4.Nf3 Nc6 5.O-O Bc5 6.d3 Nf6 7.Nbd2 a5 8.Nb3 Be7 9.e3 dxe3 10.Bxe3 Ng4 11.Bc5
      O-O 12.d4 a4 13.Bxe7 Qxe7 14.Nc5 a3 15.bxa3 Rd8 16.Nb3 Nf6 17.Re1 Qxa3 18.Qe2 h6 19.h4 Bd7 20.Ne5 Be8
      21.Qe3 Qb4 22.Reb1 Nxe5 23.dxe5 Ng4 24.Qe1 Qxe1+ 25.Rxe1 h5 26.Bxb7 Ra4 27.c5 c6 28.f3 Nh6 29.Re4 Ra7
      30.Rb4 Rb8 31.a4 Raxb7 32.Rb6 Rxb6 33.cxb6 Rxb6 34.Nc5 Nf5 35.a5 Rb8 36.a6 Nxg3 37.Na4 c5 38.a7 Rd8
      39.Nxc5 Ra8`,
    find: "27...c6",
    play: 8,
    after: "The bishop on b7 never got out. Carlsen won on move 39.",
  },
];

/** A game's moves as plain SAN, move numbers stripped. */
export function sanList(moves: string): string[] {
  return moves.split(/\s+/).map((t) => t.replace(/^\d+\.(\.\.)?/, "")).filter(Boolean);
}

/** The ply (0-based) of a numbered move ("17...Be6" -> 33) and its SAN. */
export function plyOf(find: string): { ply: number; san: string } {
  const m = /^(\d+)\.(\.\.)?(.+)$/.exec(find);
  if (!m) throw new Error(`bad move label ${find}`);
  return { ply: (Number(m[1]) - 1) * 2 + (m[2] ? 1 : 0), san: m[3] };
}
