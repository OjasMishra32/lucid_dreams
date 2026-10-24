import "server-only";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFamily, isPrivate, type Dream, type RankedCandidate, type Realism, type RealismState, type RealismView } from "../dream";
import { DATA_DIR, DREAMS_DIR, listDreams, readDream } from "./dreams";
import { GEMINI_ON, cleanPhoto, clipOf, photoOf, trim } from "./experience";
import { fetching } from "./fetches";
import { checkLikeness, humanError, type Likeness } from "./gemini";
import { getJob } from "./store";

// The realism check: does the rebuilt person look like the source, and what gives the render away? When a dream lands,
// Gemini compares three views of its render with the source photo (or the clip window, for a replay). There are no
// stills on this Mac (no ffmpeg; avconvert can't extract frames), so it gets preview.mp4 itself with the moments named:
// the orbit turns 2*pi over the video, so the front is t = 0, three-quarter T/8 and the profile T/4.
// Head-swap candidates ("<id>-head", "<id>-head-2", ...: one per face photo) are compared with their base dream's photo
// and ranked by the same score; the highest same-person confidence is the one to ship.
// One at a time, at most REALISM_PER_HOUR an hour, cached per version of the dream (updatedAt, else createdAt).

const CACHE = join(DATA_DIR, "realism");
const PER_HOUR = Math.max(1, Number(process.env.REALISM_PER_HOUR ?? 20));
const RETRY_AFTER_MS = 10 * 60_000;
const HOUR = 3600_000;

type Queue = {
  queue: string[];
  working: string | null;
  failed: Map<string, { at: number; message: string }>;
  started: number[]; // when each check in the last hour began
  wake: ReturnType<typeof setTimeout> | null;
};
const g = globalThis as unknown as { __lucidRealism?: Queue };
const state: Queue = (g.__lucidRealism ??= { queue: [], working: null, failed: new Map(), started: [], wake: null });

/** The dream a head-swap candidate was made for: "x-head" and "x-head-2" belong to "x". */
function baseOf(id: string): string | null {
  return /^(.+)-head(?:-\d+)?$/.exec(id)?.[1] ?? null;
}

type Source = { photo: string } | { clip: { path: string; offsetS: number } };

/** What the render is compared with: the dream's own photo or clip on this Mac, else its base dream's (a candidate head). */
function sourceOf(d: Dream, depth = 0): Source | null {
  const photo = d.kind === "avatar" ? photoOf(d) : null;
  if (photo) return { photo };
  const clip = d.kind === "replay" ? clipOf(d) : null;
  if (clip) return { clip };
  const base = depth < 2 ? baseOf(d.id) : null;
  const b = base ? readDream(base) : null;
  return b ? sourceOf(b, depth + 1) : null;
}

/** Real, public dreams with a render and something to compare it with. Never a family's private dream. */
function checkable(d: Dream): boolean {
  if (isPrivate(d) || isFamily(d.id) || d.id.startsWith("synthetic") || getJob(d.id)?.mode === "mock") return false;
  if (!d.preview || !existsSync(join(DREAMS_DIR, d.id, d.preview))) return false;
  return sourceOf(d) !== null;
}

function cacheFile(d: Dream): string {
  const version = createHash("sha1").update(d.updatedAt ?? d.createdAt ?? "").digest("hex").slice(0, 12);
  return join(CACHE, d.id, `${version}.json`);
}

function cached(d: Dream): Realism | null {
  try {
    return JSON.parse(readFileSync(cacheFile(d), "utf8")) as Realism;
  } catch {
    return null;
  }
}

/** Where the check stands for a dream, starting it if it should exist and doesn't yet. */
export function ensureRealism(id: string, opts: { force?: boolean } = {}): RealismState {
  const d = readDream(id);
  if (!d || !checkable(d)) return { state: "off" };
  const done = opts.force ? null : cached(d);
  if (done) {
    const candidates = rankCandidates(id);
    return { state: "ready", realism: done, ...(candidates.length > 1 ? { candidates } : {}) };
  }
  if (!GEMINI_ON) return { state: "off" };
  if (state.working === id || state.queue.includes(id) || fetching(id)) return { state: "working" };
  const failed = state.failed.get(id);
  if (failed && !opts.force && Date.now() - failed.at < RETRY_AFTER_MS) return { state: "failed", message: failed.message };
  state.failed.delete(id);
  state.queue.push(id);
  pump();
  return { state: "working" };
}

/** Check every dream that lands (the library and /api/dreams call this), within the hourly cap. */
export function sweepRealism(dreams: Dream[]) {
  if (!GEMINI_ON) return;
  for (const d of dreams) if (checkable(d) && !cached(d)) ensureRealism(d.id); // a failed one waits out its retry
}

/**
 * The dream and its head-swap candidates that have been checked, best first: same person before not, then by
 * confidence. Any list works: whatever bundles share the base id.
 */
export function rankCandidates(id: string): RankedCandidate[] {
  const base = baseOf(id) ?? id;
  const ids = new Set([base, ...listDreams().filter((d) => baseOf(d.id) === base).map((d) => d.id)]);
  const out: RankedCandidate[] = [];
  for (const cid of ids) {
    const d = readDream(cid);
    const r = d && cached(d);
    if (d && r) out.push({ id: cid, name: d.name, samePerson: r.samePerson, confidence: r.confidence });
  }
  return out.sort((a, b) => Number(b.samePerson) - Number(a.samePerson) || b.confidence - a.confidence);
}

function pump() {
  if (state.working || !state.queue.length) return;
  const now = Date.now();
  state.started = state.started.filter((t) => now - t < HOUR);
  if (state.started.length >= PER_HOUR) {
    // the hour's checks are spent: pick up again when the oldest one is an hour old
    if (!state.wake) state.wake = setTimeout(() => ((state.wake = null), pump()), state.started[0] + HOUR - now + 1000);
    return;
  }
  const id = state.queue.shift()!;
  state.working = id;
  state.started.push(now);
  make(id)
    .then(() => console.log(`[realism] ${id}: checked`))
    .catch((e: Error) => {
      const message = humanError(e);
      console.error(`[realism] ${id}: ${message}`);
      state.failed.set(id, { at: Date.now(), message });
    })
    .finally(() => {
      state.working = null;
      pump();
    });
}

async function make(id: string) {
  const d = readDream(id);
  if (!d?.preview) throw new Error("no such dream");
  const src = sourceOf(d);
  if (!src) throw new Error("There's nothing on this Mac to compare the render with.");
  const preview = join(DREAMS_DIR, id, d.preview);
  const T = mp4Duration(preview);
  if (!T) throw new Error("The render's length couldn't be read.");
  const at = (t: number) => Math.round(t * 100) / 100;
  const moments: Record<RealismView, number> = { front: 0, "three-quarter": at(T / 8), profile: at(T / 4) };

  const tmp = join(DATA_DIR, "tmp", `realism-${id}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    let source: Likeness["source"];
    if ("photo" in src) source = { photo: await cleanPhoto(src.photo, tmp) }; // upright, every metadata block gone
    else {
      const cut = await trim(src.clip, Math.max(d.durationS || 0, 0.5), join(tmp, "window.mp4"));
      if (!cut) throw new Error("The clip couldn't be cut on this Mac.");
      source = { clip: cut };
    }
    const result = await checkLikeness({ source, preview, moments });
    const out = cacheFile(d);
    mkdirSync(join(CACHE, id), { recursive: true });
    writeFileSync(out + ".tmp", JSON.stringify({ ...result, createdAt: new Date().toISOString() } satisfies Realism, null, 2));
    renameSync(out + ".tmp", out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** An MP4's length in seconds, from its movie header (mvhd): timescale and duration, version 0 or 1. */
function mp4Duration(path: string): number | null {
  const b = readFileSync(path);
  const i = b.indexOf("mvhd");
  if (i < 4 || i + 32 > b.length) return null;
  const v1 = b[i + 4] === 1;
  const timescale = b.readUInt32BE(i + (v1 ? 24 : 16));
  const duration = v1 ? Number(b.readBigUInt64BE(i + 28)) : b.readUInt32BE(i + 20);
  return timescale > 0 && duration > 0 ? duration / timescale : null;
}
