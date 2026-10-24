import "server-only";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Dream, Guide, GuideState } from "../dream";
import { DATA_DIR, DREAMS_DIR, readDream } from "./dreams";
import { fetching } from "./fetches";
import { humanError, speak, writeGuide, type Watch } from "./gemini";
import { fetchPrepped } from "./hpg";
import { getJob } from "./store";

// The Gemini guide for each dream, made once by the bridge and kept in the bundle as guide.json + guide.m4a.
// A copy lives in .data/guides/<id>/ so a re-fetched bundle gets its guide back without asking Gemini again.

const run = promisify(execFile);
const CACHE = join(DATA_DIR, "guides");
const SOURCES = join(DATA_DIR, "sources"); // prepped clips pulled from HiPerGator, while their guide is written
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const MIN_WINDOW_S = 121 / 25; // the pipeline's 5-second window
const SOURCE_WINDOW_S = 121 / 25 + 0.5; // what pipeline/lucid/prep_clip.py cuts from startS (a little more at 30+ fps)
const RUNNER = process.env.BRIDGE_MODE === "runner";
const RETRY_AFTER_MS = 10 * 60_000;

type Task = { id: string; audioOnly: boolean };
type Queue = {
  queue: Task[];
  working: string | null;
  workingVoiceOnly: boolean;
  failed: Map<string, { at: number; message: string }>;
  audioTried: Map<string, number>; // when a voice-only retry last ran, per dream
};
const g = globalThis as unknown as { __lucidGuides?: Queue };
const state: Queue = (g.__lucidGuides ??= { queue: [], working: null, workingVoiceOnly: false, failed: new Map(), audioTried: new Map() });

export const GUIDE_ON = Boolean(process.env.GEMINI_API_KEY);

/** Where the guide stands for a dream, starting it if it should exist and doesn't yet. */
export function ensureGuide(id: string, opts: { force?: boolean } = {}): GuideState {
  const dream = readDream(id);
  if (!dream) return { state: "off" };
  if (!opts.force) {
    const ready = readGuide(dream) ?? restore(dream);
    if (ready) {
      if (!ready.audio) retryVoice(id); // one failed text-to-speech call shouldn't leave the headset silent for good
      return { state: "ready", guide: ready };
    }
  }
  if (!GUIDE_ON || !watchable(dream)) return { state: "off" };
  if (opts.force) {
    // a rewrite outranks a voice-only retry: drop a queued one, or line up behind the one running
    state.queue = state.queue.filter((t) => t.id !== id);
    if (state.working === id && state.workingVoiceOnly) {
      state.queue.push({ id, audioOnly: false });
      return { state: "working" };
    }
  }
  if (busy(id)) return { state: "working" };
  // Still being copied back from HiPerGator (dream.json lands before preview.mp4): the fetch starts the guide when done.
  if (fetching(id)) return { state: "working" };
  if (dream.preview && !existsSync(join(DREAMS_DIR, id, dream.preview))) return { state: "off" };
  const failed = state.failed.get(id);
  if (failed && !opts.force && Date.now() - failed.at < RETRY_AFTER_MS) return { state: "failed", message: failed.message };
  state.failed.delete(id);
  state.queue.push({ id, audioOnly: false });
  pump();
  return { state: "working" };
}

/** Queue guides for every real dream that doesn't have one yet (test bundles only on request). */
export function sweepGuides(dreams: Dream[]) {
  if (!GUIDE_ON) return;
  for (const d of dreams) {
    if (d.id.startsWith("synthetic")) continue;
    ensureGuide(d.id);
  }
}

function busy(id: string): boolean {
  return state.working === id || state.queue.some((t) => t.id === id);
}

function retryVoice(id: string) {
  if (!GUIDE_ON || busy(id)) return;
  if (Date.now() - (state.audioTried.get(id) ?? 0) < RETRY_AFTER_MS) return;
  state.audioTried.set(id, Date.now());
  state.queue.push({ id, audioOnly: true });
  pump();
}

function readGuide(d: Dream): Guide | null {
  const p = join(DREAMS_DIR, d.id, "guide.json");
  if (!existsSync(p)) return null;
  try {
    const guide = JSON.parse(readFileSync(p, "utf8")) as Guide;
    if (d.guide !== "guide.json") linkInDream(d.id);
    return guide;
  } catch {
    return null;
  }
}

/** The bundle lost its guide (fetched again from HiPerGator): put the cached one back. */
function restore(d: Dream): Guide | null {
  if (fetching(d.id)) return null; // rsync --delete-after would sweep it away again
  const cached = join(CACHE, d.id);
  try {
    const guide = JSON.parse(readFileSync(join(cached, "guide.json"), "utf8")) as Guide;
    for (const f of ["guide.json", guide.audio].filter(Boolean) as string[]) {
      if (existsSync(join(cached, f))) copyFileSync(join(cached, f), join(DREAMS_DIR, d.id, f));
    }
    linkInDream(d.id);
    return guide;
  } catch {
    return null;
  }
}

/** Guides are for replays: a person doing a real move. Avatars from a photo have nothing to learn from yet. */
function watchable(d: Dream): boolean {
  return d.kind === "replay" && Boolean(localSource(d) || d.preview || (RUNNER && getJob(d.id)?.mode !== "mock"));
}

/** The original footage on this Mac, if any: the upload, a clip dropped for the autopilot, or a pulled prepped.mp4. */
function localSource(d: Dream): Watch["source"] | null {
  const job = getJob(d.id);
  if (job && VIDEO.test(job.file) && existsSync(job.file)) return { path: job.file, offsetS: job.startS ?? 0 };
  const dropped = autopilotClip(d.id);
  if (dropped) return { path: dropped, offsetS: 0 };
  const pulled = join(SOURCES, `${d.id}.mp4`);
  return existsSync(pulled) ? { path: pulled, offsetS: 0 } : null;
}

/** preview.mp4, the clock the motion plays on; not for a mock job, whose preview belongs to the sample it stands in with. */
function clock(d: Dream): Watch["clock"] | null {
  if (getJob(d.id)?.mode === "mock" || !d.preview) return null;
  const p = join(DREAMS_DIR, d.id, d.preview);
  return existsSync(p) ? { path: p } : null;
}

/** Clips dropped in ~/Downloads/lucid-clips are remembered by Ojasva's autopilot in dreams/.autopilot.json. */
function autopilotClip(id: string): string | null {
  try {
    const s = JSON.parse(readFileSync(join(DREAMS_DIR, ".autopilot.json"), "utf8"));
    const clip = s?.submitted?.[id]?.clip;
    return typeof clip === "string" && VIDEO.test(clip) && existsSync(clip) ? clip : null;
  } catch {
    return null;
  }
}

function pump() {
  if (state.working || !state.queue.length) return;
  const task = state.queue.shift()!;
  state.working = task.id;
  state.workingVoiceOnly = task.audioOnly;
  (task.audioOnly ? revoice(task.id) : make(task.id))
    .then(() => console.log(`[guide] ${task.id}: ${task.audioOnly ? "voice" : "guide"} ready`))
    .catch((e: Error) => {
      const message = humanError(e);
      console.error(`[guide] ${task.id}: ${message}`, e?.message === message ? "" : `(${String(e?.message ?? e).slice(0, 300)})`);
      if (!task.audioOnly) state.failed.set(task.id, { at: Date.now(), message });
    })
    .finally(() => {
      state.working = null;
      pump();
    });
}

async function make(id: string) {
  const dream = readDream(id);
  if (!dream) throw new Error("no such dream");

  // The jump shots and other clips that only live on HiPerGator: pull the run's prepped clip (runner mode only).
  let src = localSource(dream);
  const pulled = join(SOURCES, `${id}.mp4`);
  if (!src && RUNNER && getJob(id)?.mode !== "mock") {
    mkdirSync(SOURCES, { recursive: true });
    if (await fetchPrepped(id, pulled)) src = { path: pulled, offsetS: 0 };
  }
  const clk = clock(dream);
  const durationS = clk ? dream.durationS : Math.max(dream.durationS || 0, MIN_WINDOW_S);

  const tmp = join(DATA_DIR, "tmp", id);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    // Only ever send the trimmed window: if it can't be cut on this Mac, Gemini watches the 3D preview alone.
    const source = src ? ((await trim(src, join(tmp, "source.mp4"))) ?? undefined) : undefined;
    if (!source && !clk) throw new Error("nothing Gemini can watch: the clip couldn't be trimmed and there's no preview");
    const written = await writeGuide({ durationS, source, clock: clk ?? undefined });
    const audio = await voice(written.narration, tmp, id);
    const guide: Guide = { ...written, durationS, audio, createdAt: new Date().toISOString() };
    save(id, guide, tmp);
    rmSync(pulled, { force: true }); // the guide is cached; pull it again only if someone asks for a rewrite
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A guide whose narration never got spoken: try the voice alone, without watching the clip again. */
async function revoice(id: string) {
  const dream = readDream(id);
  const guide = dream && readGuide(dream);
  if (!guide || guide.audio) return;
  const tmp = join(DATA_DIR, "tmp", `${id}-voice`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const audio = await voice(guide.narration, tmp, id);
    if (!audio) throw new Error("text-to-speech failed again");
    save(id, { ...guide, audio }, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The narration, spoken, as guide.m4a (or guide.wav without a converter) in `dir`. Null when TTS fails. */
async function voice(narration: string, dir: string, id: string): Promise<string | null> {
  try {
    const wavPath = join(dir, "guide.wav");
    writeFileSync(wavPath, await speak(narration));
    return (await toM4a(wavPath, join(dir, "guide.m4a"))) ? "guide.m4a" : "guide.wav";
  } catch (e) {
    console.error(`[guide] ${id}: no voice yet (${humanError(e)})`); // the written guide still ships
    return null;
  }
}

/** guide.json (+ its audio) from `dir` into the bundle and the cache, linked from dream.json. */
function save(id: string, guide: Guide, dir: string) {
  const cached = join(CACHE, id);
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(dir, "guide.json"), JSON.stringify(guide, null, 2));
  for (const f of ["guide.json", guide.audio].filter(Boolean) as string[]) {
    copyFileSync(join(dir, f), join(cached, f));
    copyFileSync(join(dir, f), join(DREAMS_DIR, id, f));
  }
  linkInDream(id);
}

/**
 * Cut the footage down to the window that was rebuilt, at most 1080p, before it leaves the Mac: a small upload and
 * no location metadata. Null when neither avconvert nor ffmpeg can (the whole clip is never sent instead).
 */
async function trim(src: NonNullable<Watch["source"]>, out: string): Promise<NonNullable<Watch["source"]> | null> {
  const start = src.offsetS.toFixed(3);
  const length = SOURCE_WINDOW_S.toFixed(3);
  try {
    await run("avconvert", ["--source", src.path, "--output", out, "--preset", "Preset1920x1080",
      "--start", start, "--duration", length, "--replace"], { timeout: 120_000 });
    if (existsSync(out)) return { path: out, offsetS: 0 };
  } catch {
    // not a Mac, or a format AVFoundation can't read (MKV, WebM): try ffmpeg
  }
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", start, "-t", length, "-i", src.path,
      "-vf", "scale=-2:'min(1920,ih)'", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-map_metadata", "-1", out], { timeout: 120_000 });
    if (existsSync(out)) return { path: out, offsetS: 0 };
  } catch {
    // no ffmpeg either
  }
  return null;
}

/** AAC in .m4a plays in browsers, Unity and the Quest. afconvert ships with macOS; ffmpeg elsewhere. */
async function toM4a(wavPath: string, out: string): Promise<boolean> {
  for (const [cmd, args] of [
    ["afconvert", ["-f", "m4af", "-d", "aac", wavPath, out]],
    ["ffmpeg", ["-y", "-loglevel", "error", "-i", wavPath, "-c:a", "aac", "-b:a", "96k", out]],
  ] as const) {
    try {
      await run(cmd, [...args], { timeout: 60_000 });
      if (existsSync(out)) return true;
    } catch {
      // try the next one
    }
  }
  return false; // the WAV itself ships instead
}

/** Add "guide": "guide.json" to the bundle's dream.json (additive; players that don't know it ignore it). */
function linkInDream(id: string) {
  const p = join(DREAMS_DIR, id, "dream.json");
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    if (d.guide === "guide.json") return;
    d.guide = "guide.json";
    writeFileSync(p + ".tmp", JSON.stringify(d, null, 2));
    renameSync(p + ".tmp", p);
  } catch {
    // the bundle is mid-fetch; the next read links it
  }
}
