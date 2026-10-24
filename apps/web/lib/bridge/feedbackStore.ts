import "server-only";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Experience, Feedback } from "../dream";
import { DATA_DIR, DREAMS_DIR } from "./dreams";

// "Watch me try" keeps notes, never video. They live in the bundle's experience.json (`feedback`, beside `steps`) and
// in a copy under .data/feedback/<id>/, so a bundle fetched again from HiPerGator gets its notes back with its plan.
// <attempt hash>.json answers the same recording twice without asking Gemini again; latest.json is the one on show.

const DIR = (id: string) => join(DATA_DIR, "feedback", id);

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, body: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(body, null, 2));
  renameSync(path + ".tmp", path);
}

/** The notes already made for exactly this recording (its SHA-1) of this plan, if any. */
export function cachedFeedback(id: string, hash: string): Feedback | null {
  return readJson<Feedback>(join(DIR(id), `${hash}.json`));
}

/** The latest attempt's notes: from the bundle's plan, else the cache. */
export function latestFeedback(id: string): Feedback | null {
  return readJson<Experience>(join(DREAMS_DIR, id, "experience.json"))?.feedback ?? readJson<Feedback>(join(DIR(id), "latest.json"));
}

/** Keep the notes: cache them, and put them in the bundle's experience.json (the plan must exist). */
export function saveFeedback(id: string, hash: string, fb: Feedback): void {
  mkdirSync(DIR(id), { recursive: true });
  writeJson(join(DIR(id), `${hash}.json`), fb);
  writeJson(join(DIR(id), "latest.json"), fb);
  mergeFeedback(id, fb);
}

/** experience.json plus `feedback`, written in one move. Quiet when the bundle has no plan (mid-fetch). */
export function mergeFeedback(id: string, fb: Feedback | null = readJson<Feedback>(join(DIR(id), "latest.json"))): void {
  const p = join(DREAMS_DIR, id, "experience.json");
  if (!fb || !existsSync(p)) return;
  const e = readJson<Experience>(p);
  if (!e) return;
  writeJson(p, { ...e, feedback: fb });
}
