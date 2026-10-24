// How a dream reads to people: its name without pipeline tags, what you do with them, who to credit, and its media at
// an address that changes whenever the bundle is rebuilt in place (new previews, a new head). Safe on server and client.
import { dreamFile, heightM, type Dream, type Experience, type ExperienceMode } from "./dream";
import { chessLabel, legendOf } from "./showcase";

/** Run ids whose dream.json names carry pipeline detail ("(HQ)") or a model's name. */
const NAMES: Record<string, string> = {
  "jump-shot-hq": "Jump shot",
  "jump-shot-2-hq": "Jump shot, take two",
  "lebron-shot": "LeBron’s jump shot",
  "lebron-jumper-hq": "LeBron’s jump shot",
  "lebron-jumper": "LeBron’s jump shot",
  "magnus-carlsen-uika": "Magnus Carlsen",
  "magnus-carlsen-lhm": "Magnus Carlsen",
  "bobby-fischer-lhm": "Bobby Fischer",
};

export function displayName(d: { id: string; name: string }): string {
  const named = NAMES[d.id];
  if (named) return named;
  const clean = d.name
    .replace(/\s*\((hq|turbo|lhm\+*|uika|v\d+)\)\s*$/i, "")
    .replace(/'/g, "’")
    .trim();
  return clean || d.name;
}

/** Footage and photos of public figures are for the live demo only, always credited, never an endorsement. */
export function publicFigure(id: string): boolean {
  return /^(lebron|bobby-fischer|magnus-carlsen|juice-wrld)/i.test(id);
}

/**
 * What you do with them: the plan's mode when Gemini has written one, else the same reading of the sentence the WebXR
 * viewer falls back on (apps/webxr/src/experience.ts, fallbackExperience), so the page and the room agree.
 */
export function modeOf(d: Dream, intent: string | null, e?: Experience | null): ExperienceMode {
  if (e?.mode) return e.mode;
  if (legendOf(d.id)) return "play";
  const said = (intent ?? "").toLowerCase();
  if (/\bchess\b/.test(said)) return "play";
  if (/\b(teach|learn|show me|how (do|to)|practi[cs]e|coach)\b/.test(said)) return "teach";
  if (/\b(be with|sit with|stay with|miss|talk|hug|remember)\b/.test(said)) return "companion";
  return "watch";
}

export const MODE_LABEL: Record<ExperienceMode, string> = {
  teach: "Lesson",
  companion: "Companion",
  play: "Chess",
  watch: "Replay",
};

/** The main button, in the words of what happens. */
export const MODE_ACTION: Record<ExperienceMode, string> = {
  teach: "Start the lesson",
  companion: "Bring them into your room",
  play: "Play chess with them",
  watch: "View in your room",
};

/** "teach me this strum" -> "Teach me this strum." */
export function asSentence(text: string): string {
  const t = text.trim().replace(/[.!?]+$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : "";
}

/** The line under a person's name: their sentence when one was said, else where they came from. */
export function lineOf(d: Dream, intent: string | null): string {
  if (intent) return asSentence(intent);
  return d.kind === "avatar" ? "From a few photos. Life size, in your room." : "From one video. Walk all the way around them.";
}

/** A query for the WebXR viewer (apps/webxr): the chess table for a game, else the dream in your room. */
export function viewerQuery(d: Dream, mode: ExperienceMode, e?: Experience | null): string {
  const id = encodeURIComponent(d.id);
  if (mode !== "play") return `dream=${id}`;
  const strength = legendOf(d.id) ?? e?.play?.strength;
  return `mode=chess&opponent=${id}${strength ? `&strength=${encodeURIComponent(strength)}` : ""}`;
}

/** A bundle file at an address that changes when the bundle is rebuilt in place, so browsers never show a stale preview. */
export function mediaUrl(d: Dream, file: string | null | undefined): string | null {
  if (!file) return null;
  const at = Date.parse(d.updatedAt ?? d.createdAt ?? "");
  return at ? `${dreamFile(d.id, file)}?v=${at.toString(36)}` : dreamFile(d.id, file);
}

/** Where the person came from, credited (demo/credits.md; an avatar's own dream.json says it best). */
const CLIP_CREDITS: [RegExp, string][] = [
  [/^dance-01/, "Clip: Antoni Shkraba on Pexels, Pexels License."],
  [/^golf-01/, "Clip: Be The Observer on Pexels, Pexels License."],
  [/^taichi-01/, "Clip: K (@kelly) on Pexels, Pexels License."],
  [/^guitar-01/, "Clip: Khanh Hoang Minh 2 on Pexels, Pexels License."],
  [/^jump-shot/, "Clip: Pexels, Pexels License."],
  [/^lebron/, "Clip supplied for this non-commercial demo. Not affiliated, no endorsement."],
  [/^piano-han/, "Jason M. C. Han, piano teacher. Wikimedia Commons, CC BY-SA 4.0, rebuilt in 3D."],
];

export function creditOf(d: Dream): string | null {
  const own = (d.source as { credit?: unknown } | null | undefined)?.credit;
  if (typeof own === "string" && own.trim()) return own.trim();
  return CLIP_CREDITS.find(([re]) => re.test(d.id))?.[1] ?? null;
}

/** How they were made, in one sentence, from what the bundle says about itself. */
export function madeWith(d: Dream): string {
  if (d.kind === "replay") {
    const views = d.metrics?.views;
    return `4DAnyone imagined ${views ? `${views} views` : "every angle"} of one video; each frame was rebuilt as 3D Gaussians and checked against real frames held out from training.`;
  }
  const src = (d.source ?? {}) as { model?: unknown; photos?: unknown; head?: { model?: unknown } };
  const model = typeof src.model === "string" ? src.model : "";
  const photos = Array.isArray(src.photos) ? src.photos.length : 0;
  const body = /LHM\+\+/.test(model) ? "LHM++" : /DiGS/i.test(model) ? "DiGS-Avatar" : "an avatar model";
  const head = typeof src.head?.model === "string" && /UIKA/.test(src.head.model) ? ", with a head distilled from UIKA" : "";
  return `Built with ${body} from ${photos > 1 ? `${photos} photos` : "a photo"}${head}, rigged to move like a person.`;
}

/** The label a chess legend carries everywhere they appear (AGENTS.md, Consent), else null. */
export function legendNote(d: { id: string }): string | null {
  const l = legendOf(d.id);
  return l ? chessLabel(l) : null;
}

/** Facts about the person, for the spec rows of a dream page. */
export function personFacts(d: Dream): [string, string][] {
  const out: [string, string][] = [];
  const h = heightM(d);
  if (h) out.push(["Height", `${h.toFixed(2)} m, life size`]);
  if (d.durationS) out.push(["Length", `${d.durationS.toFixed(1)} s, ${d.frameCount} frames at ${d.fps} fps`]);
  if (d.frames?.gaussiansPerFrame) out.push(["Detail", `${d.frames.gaussiansPerFrame.toLocaleString("en-US")} Gaussians per frame`]);
  if (d.metrics?.views) out.push([d.kind === "avatar" ? "Photos" : "Views", d.kind === "avatar" ? `${d.metrics.views}` : `${d.metrics.views} imagined around them`]);
  return out;
}

/** Ranked for a hero: real lessons and replays first (never a test bundle), then the sharpest by held-out PSNR. */
export function heroOrder(dreams: Dream[]): Dream[] {
  const real = dreams.filter((d) => d.preview && !/^(synthetic|test-)/.test(d.id) && d.kind === "replay");
  const score = (d: Dream) => (d.intent ? 100 : 0) + (d.metrics?.psnr ?? 0);
  return [...real].sort((a, b) => score(b) - score(a));
}
