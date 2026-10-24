import "server-only";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isPrivate, type Dream } from "../dream";
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
export const DATA_DIR = resolve(/*turbopackIgnore: true*/ process.env.LUCID_DATA_DIR ?? join(process.cwd(), ".data"));

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

/**
 * What players and pages list: whole bundles only, never one still being copied back or held back. Private dreams (a
 * family's, `"private": true` in dream.json) only where asked for: the players, and the library on this Mac itself.
 */
export function listReady(dreams: Dream[] = listDreams(), opts: { withPrivate?: boolean } = {}): Dream[] {
  const held = heldIds();
  return onePerPerson(dreams.filter((d) => !held.has(d.id) && (opts.withPrivate || !isPrivate(d)) && !fetching(d.id) && bundleComplete(d)));
}

// The same person under another run id (a rebuilt head, a cleanup pass, a sharper rerun) is still one person: every
// list shows one of each, the one the demo uses, else the newest.
const PREFERRED = ["magnus-carlsen-uika-360", "bobby-fischer-uika", "roger-federer-uika", "lebron-shot", "jump-shot-hq"];

/** Who a run is, whatever pass made it: "magnus-carlsen-uika-360aa" and "magnus-carlsen-lhm" are both Magnus. */
export function personKey(id: string): string {
  const legend = /^(magnus-carlsen|bobby-fischer|roger-federer|lebron|juice-wrld)/.exec(id);
  if (legend) return legend[1];
  let k = id;
  for (let prev = ""; prev !== k; ) {
    prev = k;
    k = k.replace(/-(uika|lhm\+*|head(-\d+)?|hq|turbo|tuned|360[a-z]*|v\d+|prev)$/, "");
  }
  return k;
}

function onePerPerson(dreams: Dream[]): Dream[] {
  const rank = (d: Dream) => {
    const i = PREFERRED.indexOf(d.id);
    if (i >= 0) return Number.MAX_SAFE_INTEGER - i;
    const t = (d as Dream & { updatedAt?: string }).updatedAt ?? d.createdAt;
    return (t && Date.parse(t)) || 0;
  };
  const best = new Map<string, Dream>();
  for (const d of dreams) {
    const k = personKey(d.id);
    const cur = best.get(k);
    if (!cur || rank(d) > rank(cur)) best.set(k, d);
  }
  return dreams.filter((d) => best.get(personKey(d.id)) === d);
}

/** The dream a page should lead with: newest real person with a 360 preview (test bundles last). */
export function leadDream(dreams: Dream[]): Dream | null {
  const withPreview = dreams.filter((d) => d.preview && existsSync(join(DREAMS_DIR, d.id, d.preview)));
  return withPreview.find((d) => !d.id.startsWith("synthetic")) ?? withPreview[0] ?? null;
}
