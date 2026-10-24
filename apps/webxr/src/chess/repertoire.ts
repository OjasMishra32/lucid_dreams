// The legends' own openings: for the first moves they play lines they were known for, then Stockfish at their peak
// rating takes over. Public knowledge of their repertoires, simplified; a line is SAN moves from the start, both sides.

type Line = { name: string; moves: string; weight?: number };

const FISCHER: Line[] = [
  // with White: 1.e4, "best by test"
  { name: "Sicilian Najdorf, Fischer-Sozin", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bc4 e6 Bb3", weight: 3 },
  { name: "Sicilian, Fischer-Sozin", moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 d6 Bc4" },
  { name: "Ruy Lopez, Exchange", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6 d4", weight: 3 },
  { name: "Ruy Lopez", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3" },
  { name: "French Winawer", moves: "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3" },
  { name: "Caro-Kann, Two Knights", moves: "e4 c6 Nc3 d5 Nf3 Bg4 h3 Bxf3 Qxf3" },
  { name: "Pirc, Austrian Attack", moves: "e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3" },
  { name: "Queen's Gambit, Tartakower (1972, game 6)", moves: "c4 e6 Nf3 d5 d4 Nf6 Nc3 Be7 Bg5 O-O e3 h6 Bh4 b6", weight: 0.3 },
  // with Black: the Najdorf against 1.e4, the King's Indian and Grünfeld against 1.d4
  { name: "Sicilian Najdorf", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5", weight: 3 },
  { name: "Sicilian Najdorf, Poisoned Pawn", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4 Qb6" },
  { name: "Sicilian Najdorf", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5" },
  { name: "Sicilian Najdorf", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bc4 e6" },
  { name: "Alekhine (1972, game 13)", moves: "e4 Nf6 e5 Nd5 d4 d6 Nf3 g6", weight: 0.3 },
  { name: "King's Indian", moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5", weight: 3 },
  { name: "Grünfeld", moves: "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7" },
  { name: "King's Indian", moves: "d4 Nf6 c4 g6 g3 Bg7 Bg2 O-O Nc3 d6" },
  { name: "King's Indian", moves: "d4 Nf6 Nf3 g6 c4 Bg7 Nc3 O-O e4 d6" },
  { name: "English, Symmetrical", moves: "c4 Nf6 Nc3 g6 g3 Bg7 Bg2 O-O" },
  { name: "Réti", moves: "Nf3 Nf6 c4 g6 Nc3 Bg7" },
];

const CARLSEN: Line[] = [
  // with White: everything, but most of all the quiet Ruy and the Catalan
  { name: "Ruy Lopez, anti-Berlin", moves: "e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Bc5 c3 O-O O-O d6", weight: 3 },
  { name: "Ruy Lopez", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 d3 b5 Bb3 d6 a4" },
  { name: "Sicilian, Rossolimo", moves: "e4 c5 Nf3 Nc6 Bb5 g6 Bxc6 dxc6 d3 Bg7 h3", weight: 2 },
  { name: "Sicilian, Moscow", moves: "e4 c5 Nf3 d6 Bb5+ Bd7 Bxd7+ Qxd7 c4" },
  { name: "Sicilian, Rossolimo", moves: "e4 c5 Nf3 e6 c3 d5 exd5 exd5 d4" },
  { name: "Caro-Kann, Advance", moves: "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2" },
  { name: "French, Tarrasch", moves: "e4 e6 d4 d5 Nd2 c5 exd5 Qxd5 Ngf3" },
  { name: "Catalan", moves: "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6", weight: 3 },
  { name: "Queen's Gambit Declined", moves: "d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5 Be7 e3" },
  { name: "London", moves: "d4 Nf6 Bf4 d5 e3 c5 Nd2 Nc6 c3", weight: 0.6 },
  { name: "Réti", moves: "Nf3 d5 g3 Nf6 Bg2 c6 O-O Bg4 c4", weight: 0.6 },
  // with Black: the Sveshnikov and Berlin against 1.e4; Queen's Gambit Declined and Nimzo against 1.d4
  { name: "Sicilian Sveshnikov (2018 match)", moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Nd5 Nxd5 exd5 Nb8", weight: 3 },
  { name: "Sicilian Sveshnikov", moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5" },
  { name: "Berlin Defence", moves: "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5", weight: 2 },
  { name: "Sicilian", moves: "e4 c5 Nf3 Nc6 Bb5 g6 O-O Bg7 Re1 e5" },
  { name: "Caro-Kann", moves: "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6", weight: 0.6 },
  { name: "Nimzo-Indian", moves: "d4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 d5", weight: 2 },
  { name: "Queen's Gambit Declined", moves: "d4 Nf6 c4 e6 Nf3 d5 Nc3 Be7 Bf4 O-O e3 c5", weight: 2 },
  { name: "Queen's Gambit Declined", moves: "d4 d5 c4 e6 Nc3 Be7 cxd5 exd5 Bf4 c6" },
  { name: "English, Reversed Sicilian", moves: "c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2 Nb6" },
  { name: "Réti", moves: "Nf3 d5 g3 Nf6 Bg2 c6 O-O Bf5" },
];

const BOOKS: Record<string, Line[]> = { fischer: FISCHER, carlsen: CARLSEN };

/** The legend's book move after `history` (SAN, both sides, from the start), and the line's name; null when out of
 * book. Lines are chosen by weight among those that match, with a seeded random, so a game is varied but repeatable. */
export function bookMove(id: string, history: string[], random: () => number = Math.random): { san: string; name: string } | null {
  const lines = BOOKS[id];
  if (!lines) return null;
  const ply = history.length;
  const matches = lines
    .map((l) => ({ ...l, split: l.moves.split(" ") }))
    .filter((l) => l.split.length > ply && history.every((m, i) => l.split[i] === m));
  if (!matches.length) return null;
  const total = matches.reduce((s, l) => s + (l.weight ?? 1), 0);
  let r = random() * total;
  for (const l of matches) {
    r -= l.weight ?? 1;
    if (r <= 0) return { san: l.split[ply], name: l.name };
  }
  const last = matches[matches.length - 1];
  return { san: last.split[ply], name: last.name };
}
