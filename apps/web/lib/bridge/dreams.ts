import "server-only";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Dream } from "../dream";

/** The repo root: the nearest folder above apps/web that holds AGENTS.md. */
function findRepo(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "AGENTS.md"))) return dir;
    dir = dirname(dir);
  }
  return resolve(process.cwd(), "../..");
}

export const REPO = findRepo();
// Shared with pipeline/runner (fetch writes here) and apps/webxr (serves it on :5180).
export const DREAMS_DIR = resolve(/*turbopackIgnore: true*/ process.env.LUCID_DREAMS_DIR ?? join(REPO, "dreams"));
// The bridge's own state: uploads and jobs. Ignored by git.
export const DATA_DIR = resolve(process.cwd(), ".data");

export function readDream(id: string): Dream | null {
  if (!/^[\w.-]+$/.test(id)) return null;
  const p = join(DREAMS_DIR, id, "dream.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Dream;
  } catch {
    return null;
  }
}

/** Every bundle's dream.json, newest first. */
export function listDreams(): Dream[] {
  if (!existsSync(/*turbopackIgnore: true*/ DREAMS_DIR)) return [];
  return readdirSync(/*turbopackIgnore: true*/ DREAMS_DIR)
    .filter((id) => !id.startsWith("."))
    .map((id) => {
      const d = readDream(id);
      if (!d) return null;
      const when = Date.parse(d.createdAt ?? "") || statSync(join(DREAMS_DIR, id, "dream.json")).mtimeMs;
      return { d, when };
    })
    .filter((x): x is { d: Dream; when: number } => x !== null)
    .sort((a, b) => b.when - a.when)
    .map((x) => x.d);
}

/** The dream a page should lead with: newest real person with a 360 preview (test bundles last). */
export function leadDream(dreams: Dream[]): Dream | null {
  const withPreview = dreams.filter((d) => d.preview && existsSync(join(DREAMS_DIR, d.id, d.preview)));
  return withPreview.find((d) => !d.id.startsWith("synthetic")) ?? withPreview[0] ?? null;
}
