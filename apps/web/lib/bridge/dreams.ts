import "server-only";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Dream } from "../dream";
import { fetching } from "./fetches";

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

/**
 * Run and dream ids as the bridge and lucid_runner.py make them (a slug and a timestamp, or a queue id like
 * "jump-shot"). Anything else never reaches the filesystem or the runner: lucid_runner passes ids into an SSH command.
 */
export function isRunId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id);
}

export function readDream(id: string): Dream | null {
  if (!isRunId(id)) return null;
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

/** An avatar has its avatar.ply, which a plain fetch leaves out (the autopilot fetches every run without PLYs). */
export function avatarComplete(d: Dream): boolean {
  return d.kind !== "avatar" || !d.avatar?.file || existsSync(join(DREAMS_DIR, d.id, d.avatar.file));
}

/**
 * The whole bundle is here, not just the dream.json a fetch lands first: preview, thumb, every SPZ frame and (for an
 * avatar) its PLY. Players and the job status only treat a dream as there once this holds.
 */
export function bundleComplete(d: Dream): boolean {
  const has = (f?: string | null) => !f || existsSync(join(DREAMS_DIR, d.id, f));
  if (!avatarComplete(d) || !has(d.preview) || !has(d.thumb)) return false;
  if (d.frames?.spz && d.frameCount > 0) {
    const dir = join(DREAMS_DIR, d.id, d.frames.dir);
    if (!existsSync(dir)) return false;
    return readdirSync(dir).filter((f) => f.endsWith(".spz") && !f.includes(".reality.")).length >= d.frameCount;
  }
  return true;
}

/** Dreams held back from the library until they're good enough to show (dreams/.held, one id per line; Ojasva's). */
export function heldIds(): Set<string> {
  try {
    return new Set(readFileSync(join(DREAMS_DIR, ".held"), "utf8").split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** What players and pages list: whole bundles only, never one still being copied back or held back. */
export function listReady(dreams: Dream[] = listDreams()): Dream[] {
  const held = heldIds();
  return dreams.filter((d) => !held.has(d.id) && !fetching(d.id) && bundleComplete(d));
}

/** The dream a page should lead with: newest real person with a 360 preview (test bundles last). */
export function leadDream(dreams: Dream[]): Dream | null {
  const withPreview = dreams.filter((d) => d.preview && existsSync(join(DREAMS_DIR, d.id, d.preview)));
  return withPreview.find((d) => !d.id.startsWith("synthetic")) ?? withPreview[0] ?? null;
}
