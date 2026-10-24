import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENVIRONMENTS, STRENGTHS, type Environment, type Experience, type ExperienceMode, type Strength } from "../lib/dream";

// The forty sentences in tests/intents.json: loading them (with every problem in the file named at once), and
// comparing a plan with what a sentence should become. Used by scripts/check-intents.ts and tests/plan.test.ts.

export const CASES_FILE = join(__dirname, "intents.json");
export const MODES: ExperienceMode[] = ["teach", "companion", "watch", "play"];
const PLACES = ["facing", "beside", "ahead"];
const NOUN = /^[a-z][a-z -]{1,30}$/; // what clean() lets through as an object
const PER_MODE = 10;

export interface Expect {
  mode: ExperienceMode;
  place: Experience["place"];
  environment: Environment | null; // null: leave it out (the user's own room)
  objects: string[]; // nouns that must be there; "a|b" takes either
  strength?: Strength; // play only
}

export interface IntentCase {
  id: string;
  name: string;
  sentence: string;
  kind: "replay" | "avatar";
  expect: Expect;
  showcase?: number; // the moment in demo/showcase.md
  why: string;
}

/** The fields a plan is judged on, from clean()'s output or from the model's own JSON. */
export interface Judged {
  mode?: string;
  place?: string;
  environment?: string | null;
  objects?: string[];
  strength?: string;
}

export function loadCases(file = CASES_FILE): IntentCase[] {
  const data = JSON.parse(readFileSync(file, "utf8")) as { cases?: unknown };
  const cases = (Array.isArray(data.cases) ? data.cases : []) as IntentCase[];
  const problems: string[] = [];
  const ids = new Set<string>();
  const showcase = new Set<number>();
  cases.forEach((c, i) => {
    const at = `case ${i + 1}${typeof c?.id === "string" ? ` (${c.id})` : ""}`;
    const bad = (what: string) => problems.push(`${at}: ${what}`);
    if (typeof c?.id !== "string" || !/^[a-z0-9-]+$/.test(c.id)) bad("id must be lowercase words joined by hyphens");
    else if (ids.has(c.id)) bad("id is used twice");
    else ids.add(c.id);
    if (typeof c?.sentence !== "string" || !c.sentence.trim()) bad("sentence is missing");
    if (typeof c?.name !== "string" || !c.name.trim()) bad("name is missing");
    if (typeof c?.why !== "string" || !c.why.trim()) bad("why is missing");
    const e = c?.expect;
    if (!e || typeof e !== "object") return bad("expect is missing");
    if (!MODES.includes(e.mode)) bad(`mode "${e.mode}" isn't one of ${MODES.join(", ")}`);
    if (!PLACES.includes(e.place)) bad(`place "${e.place}" isn't one of ${PLACES.join(", ")}`);
    if (e.environment !== null && !(ENVIRONMENTS as readonly string[]).includes(e.environment)) bad(`environment "${e.environment}" isn't a place id or null`);
    if (!Array.isArray(e.objects)) bad("objects must be a list (empty when nothing must be there)");
    else for (const o of e.objects) if (typeof o !== "string" || !o.split("|").every((a) => NOUN.test(a))) bad(`object "${o}" isn't a lowercase noun`);
    if (c.kind !== (e.mode === "play" ? "avatar" : "replay")) bad(`kind must be ${e.mode === "play" ? "avatar (chess needs one)" : "replay"}`);
    if (e.mode === "play" && !(STRENGTHS as readonly string[]).includes(e.strength as string)) bad(`play needs a strength, one of ${STRENGTHS.join(", ")}`);
    if (e.mode !== "play" && e.strength !== undefined) bad("strength is only for play");
    if (c.showcase !== undefined) {
      if (!Number.isInteger(c.showcase) || c.showcase < 1 || c.showcase > 5) bad("showcase must be 1 to 5");
      else if (showcase.has(c.showcase)) bad(`showcase ${c.showcase} is used twice`);
      else showcase.add(c.showcase);
    }
  });
  for (const m of MODES) {
    const n = cases.filter((c) => c?.expect?.mode === m).length;
    if (n !== PER_MODE) problems.push(`${m}: ${n} sentences, wants ${PER_MODE}`);
  }
  for (let s = 1; s <= 5; s++) if (!showcase.has(s)) problems.push(`showcase moment ${s} (demo/showcase.md) has no sentence`);
  if (problems.length) throw new Error(`${file} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  return cases;
}

export function fromExperience(e: Omit<Experience, "createdAt">): Judged {
  return { mode: e.mode, place: e.place, environment: e.environment ?? null, objects: e.objects ?? [], strength: e.play?.strength };
}

/** The model's own JSON, before clean(): objects only lowercased, strength defaulting to club as clean() does. */
export function fromRaw(raw: Record<string, unknown>): Judged {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const objects = Array.isArray(raw.objects) ? raw.objects.filter((o): o is string => typeof o === "string").map((o) => o.trim().toLowerCase()) : [];
  return { mode: s(raw.mode), place: s(raw.place), environment: s(raw.environment) ?? null, objects, strength: s(raw.strength) ?? "club" };
}

/** What doesn't match, one line per field; empty when the plan is right. */
export function compare(want: Expect, got: Judged): string[] {
  const out: string[] = [];
  if (got.mode !== want.mode) out.push(`mode: wanted ${want.mode}, got ${got.mode ?? "none"}`);
  if (got.place !== want.place) out.push(`place: wanted ${want.place}, got ${got.place ?? "none"}`);
  const room = (v: string | null | undefined) => v || "room"; // left out = the user's own room
  if (room(got.environment) !== room(want.environment)) {
    out.push(`environment: wanted ${want.environment ?? "none (your room)"}, got ${got.environment ?? "none"}`);
  }
  const have = got.objects ?? [];
  const missing = want.objects.filter((o) => !o.split("|").some((a) => have.includes(a)));
  if (missing.length) out.push(`objects: missing ${missing.join(", ")} (got ${have.length ? have.join(", ") : "none"})`);
  if (want.mode === "play" && got.mode === "play" && (got.strength ?? "club") !== want.strength) {
    out.push(`strength: wanted ${want.strength}, got ${got.strength ?? "club"}`);
  }
  return out;
}
