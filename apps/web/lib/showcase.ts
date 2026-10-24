// The five demo moments (demo/showcase.md): what judges see first on the laptop, at /showcase and on the kiosk.
// Each lists the dreams that can play it, best first; the first one that's ready in the library is shown.

export interface Moment {
  title: string;
  line: string; // what happens, one sentence
  intent: string; // the sentence said to them (a dream's own intent wins when it has one)
  where: string;
  ids: string[];
  sentence?: string; // else any dream whose intent matches this (a regex, any case)
  action: string; // the button, once a dream is ready
  chess?: Record<string, string>; // opens the chess table instead: avatar id -> engine strength (AGENTS.md, play)
  credit?: string; // source and licence, shown small
}

export const MOMENTS: Moment[] = [
  {
    title: "Piano lesson, side by side",
    line: "A piano teacher sits at your side and plays the piece in steps, slowed down, with your turn after each.",
    intent: "Sit next to me and teach me this piece",
    where: "Your room, or a concert hall",
    ids: ["piano-han-hq", "piano-han"],
    action: "Start the lesson",
    credit: "Jason Han, piano teacher. Wikimedia Commons, CC BY-SA 4.0.",
  },
  {
    title: "LeBron in your driveway",
    line: "His jump shot, life size, with the real ball in his hands and a regulation hoop where he aims.",
    intent: "Teach me this jump shot",
    where: "Your room, or a court",
    ids: ["lebron-jumper-hq", "lebron-jumper"],
    action: "Start the lesson",
    credit: "Clip supplied for this non-commercial demo. Not affiliated.",
  },
  {
    title: "Chess with the legends",
    line: "Seated across a real-size board on your table, moving their own pieces, with a clock at your side. They never speak.",
    intent: "Play chess with me",
    where: "Your table",
    // the opponents the WebXR chess table seats (apps/webxr/src/chess/engine.ts), then older builds
    ids: ["bobby-fischer-lhm", "magnus-carlsen-uika", "magnus-carlsen-lhm", "bobby-fischer-head", "bobby-fischer", "magnus-carlsen-head", "magnus-carlsen"],
    action: "Play chess with them",
    chess: {
      "bobby-fischer-lhm": "fischer",
      "bobby-fischer-head": "fischer",
      "bobby-fischer": "fischer",
      "magnus-carlsen-uika": "carlsen",
      "magnus-carlsen-lhm": "carlsen",
      "magnus-carlsen-head": "carlsen",
      "magnus-carlsen": "carlsen",
    },
    credit: "Fischer: 1966 AP portrait, public domain, and Anefo / Nationaal Archief photos, CC0. Carlsen: Ralf Roletschek, CC BY-SA 3.0.",
  },
  {
    title: "Someone you’ve lost",
    line: "From a family photo or home video, someone you miss, simply sitting with you.",
    intent: "I just want to sit with her",
    where: "Your living room",
    ids: ["ian-grandma"], // private unless her family agrees to showing; a private dream is never shown here
    sentence: "\\bsit with (her|him)\\b",
    action: "Bring them into your room",
    credit: "Shown with the family’s written consent.",
  },
  {
    title: "You, perfected",
    line: "Your own body, from one photo, doing his shot.",
    intent: "Show me doing it",
    where: "A court",
    ids: ["vishal-jumper"],
    action: "See yourself do it",
  },
];

const LEGEND: Record<string, string> = { fischer: "Fischer", carlsen: "Carlsen" };

/** "Fischer" for strength fischer: how a legend is named next to a button. */
export function legendName(strength: string): string {
  return LEGEND[strength] ?? strength;
}

/** The label every chess legend carries (AGENTS.md, Consent): an engine rating, never the person. */
export function chessLabel(strength: string): string {
  const who = LEGEND[strength];
  return who ? `Stockfish at ${who}’s peak rating. Not affiliated.` : "A real chess engine. Not affiliated with any player.";
}

/**
 * The engine strength a legend's dream plays at ("fischer" for bobby-fischer, bobby-fischer-lhm, ...), else null. Any
 * build of a legend counts, so a new one can never show up without its label.
 */
export function legendOf(id: string): string | null {
  for (const m of MOMENTS) if (m.chess?.[id]) return m.chess[id];
  if (/^bobby-fischer/i.test(id)) return "fischer";
  if (/^magnus-carlsen/i.test(id)) return "carlsen";
  return null;
}

/** Every showcase dream id, in moment order: the kiosk leads with these. */
export const SHOWCASE_IDS = MOMENTS.flatMap((m) => m.ids);
