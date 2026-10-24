import "server-only";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { Dream, Experience, ExperienceState } from "../dream";
import { DATA_DIR, DREAMS_DIR, listDreams, readDream } from "./dreams";
import { fetching } from "./fetches";
import { humanError, writeExperience, type Plan } from "./gemini";
import { fetchPrepped } from "./hpg";
import { getJob } from "./store";

// The experience step (AGENTS.md, Contracts, "Experience"): when a dream lands, Gemini turns the user's sentence of
// intent and the clip into experience.json, which the players run. Once per dream (this run of it) and intent: a copy
// is cached in .data/experiences/<id>/, so a re-fetched bundle gets its plan back without asking Gemini again.

const run = promisify(execFile);
const CACHE = join(DATA_DIR, "experiences");
const SOURCES = join(DATA_DIR, "sources"); // prepped clips pulled from HiPerGator while their plan is written
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const PHOTO = /\.(jpe?g|png|webp|heic)$/i; // every photo leaves the Mac as a fresh JPEG with no metadata
const MIN_WINDOW_S = 121 / 25; // the pipeline's 5-second window
const RUNNER = process.env.BRIDGE_MODE === "runner";
const RETRY_AFTER_MS = 10 * 60_000;

type Queue = {
  queue: string[];
  working: string | null;
  failed: Map<string, { at: number; message: string }>;
  upgradeTried: Map<string, number>; // when a plan made from the orbit preview last tried for the real clip
};
const g = globalThis as unknown as { __lucidExperiences?: Queue; __lucidExperienceTimer?: ReturnType<typeof setInterval> };
const state: Queue = (g.__lucidExperiences ??= { queue: [], working: null, failed: new Map(), upgradeTried: new Map() });

export const GEMINI_ON = Boolean(process.env.GEMINI_API_KEY);

// Dreams the autopilot brings home get their plan within a minute, whether or not anyone opens a page.
if (GEMINI_ON && !g.__lucidExperienceTimer) {
  g.__lucidExperienceTimer = setInterval(() => sweepExperiences(listDreams()), 60_000);
  g.__lucidExperienceTimer.unref?.();
}

/** What the person is: a mock stand-in borrows a replay sample's files, but the job knows it was a photo. */
function kindOf(d: Dream): Dream["kind"] {
  return getJob(d.id)?.kind ?? d.kind;
}

/** The user's sentence for this dream: dream.json carries it; for a run this bridge started, so does the job. */
export function intentOf(d: Dream): string | null {
  const text = (d.intent ?? getJob(d.id)?.intent ?? "").trim();
  return text || null;
}

/** Where the plan stands for a dream, starting it if it should exist and doesn't yet. */
export function ensureExperience(id: string, opts: { force?: boolean } = {}): ExperienceState {
  const dream = readDream(id);
  if (!dream) return { state: "off" };
  if (!opts.force) {
    const ready = readExperience(dream) ?? restore(dream);
    if (ready) {
      upgrade(dream, ready);
      return { state: "ready", experience: ready };
    }
  }
  if (!GEMINI_ON || !plannable(dream)) return { state: "off" };
  if (opts.force) state.queue = state.queue.filter((q) => q !== id);
  if (state.working === id || state.queue.includes(id)) return { state: "working" };
  // Still being copied back from HiPerGator (dream.json lands before the rest): the fetch starts the plan when done.
  if (fetching(id)) return { state: "working" };
  if (dream.preview && !existsSync(join(DREAMS_DIR, id, dream.preview))) return { state: "off" };
  const failed = state.failed.get(id);
  if (failed && !opts.force && Date.now() - failed.at < RETRY_AFTER_MS) return { state: "failed", message: failed.message };
  state.failed.delete(id);
  state.queue.push(id);
  pump();
  return { state: "working" };
}

/** Plan every real dream that doesn't have one for its current intent (test bundles only on request). */
export function sweepExperiences(dreams: Dream[]) {
  if (!GEMINI_ON) return;
  for (const d of dreams) if (!d.id.startsWith("synthetic")) ensureExperience(d.id);
}

/** The cache key: the sentence, and this run of the dream (a re-run under the same id is a new person). */
function key(d: Dream, intent: string | null): string {
  return createHash("sha1").update(`${intent ?? ""}\n${d.createdAt ?? ""}`).digest("hex").slice(0, 12);
}

/**
 * A plan made from the orbit preview (HiPerGator unreachable, or a clip this Mac couldn't cut) isn't final in runner
 * mode: every so often, try again for one made from the real clip.
 */
function upgrade(d: Dream, e: Experience) {
  if (e.source !== "preview" || !RUNNER || getJob(d.id)?.mode === "mock" || !GEMINI_ON) return;
  if (state.working === d.id || state.queue.includes(d.id) || fetching(d.id)) return;
  if (Date.now() - (state.upgradeTried.get(d.id) ?? 0) < RETRY_AFTER_MS) return;
  state.upgradeTried.set(d.id, Date.now());
  state.queue.push(d.id);
  pump();
}

/** The bundle's experience.json, if it was written for the dream's current intent. */
function readExperience(d: Dream): Experience | null {
  const p = join(DREAMS_DIR, d.id, "experience.json");
  if (!existsSync(p)) return null;
  try {
    const e = JSON.parse(readFileSync(p, "utf8")) as Experience;
    if ((e.intent ?? null) !== intentOf(d)) return null; // the sentence changed: plan again
    if (d.experience !== "experience.json") linkInDream(d.id, intentOf(d));
    return e;
  } catch {
    return null;
  }
}

/** The bundle lost its plan (fetched again from HiPerGator): put the cached one for this intent back. */
function restore(d: Dream): Experience | null {
  if (fetching(d.id)) return null; // rsync --delete-after would sweep it away again
  const cached = join(CACHE, d.id, `${key(d, intentOf(d))}.json`);
  try {
    const e = JSON.parse(readFileSync(cached, "utf8")) as Experience;
    copyFileSync(cached, join(DREAMS_DIR, d.id, "experience.json"));
    linkInDream(d.id, intentOf(d));
    return e;
  } catch {
    return null;
  }
}

/** Something to plan from: a replay's clip or preview, an avatar's photo, or at least a sentence. */
function plannable(d: Dream): boolean {
  if (kindOf(d) === "avatar") return Boolean(photoOf(d) || intentOf(d));
  return Boolean(clipOf(d) || d.preview || (RUNNER && getJob(d.id)?.mode !== "mock"));
}

/** The original footage on this Mac: the upload, a clip dropped for the autopilot, or a pulled prepped.mp4. */
export function clipOf(d: Dream): { path: string; offsetS: number } | null {
  const job = getJob(d.id);
  if (job && VIDEO.test(job.file) && existsSync(job.file)) return { path: job.file, offsetS: job.startS ?? 0 };
  const dropped = dropped_(d.id, VIDEO);
  if (dropped) return { path: dropped, offsetS: 0 };
  const pulled = join(SOURCES, `${d.id}.mp4`);
  return existsSync(pulled) ? { path: pulled, offsetS: 0 } : null;
}

/** An avatar's photo on this Mac: the upload, or one dropped for the autopilot (it keeps HEICs as JPEGs in dreams/.photos). */
export function photoOf(d: Dream): string | null {
  const file = getJob(d.id)?.file;
  if (file && PHOTO.test(file) && existsSync(file)) return file;
  const dropped = dropped_(d.id, PHOTO);
  if (dropped && /\.heic$/i.test(dropped)) {
    const jpg = join(DREAMS_DIR, ".photos", `${basename(dropped, extname(dropped))}.jpg`);
    if (existsSync(jpg)) return jpg;
  }
  return dropped;
}

/** Files dropped in ~/Downloads/lucid-clips are remembered by Ojasva's autopilot in dreams/.autopilot.json. */
function dropped_(id: string, kind: RegExp): string | null {
  try {
    const s = JSON.parse(readFileSync(join(DREAMS_DIR, ".autopilot.json"), "utf8"));
    const clip = s?.submitted?.[id]?.clip;
    return typeof clip === "string" && kind.test(clip) && existsSync(clip) ? clip : null;
  } catch {
    return null;
  }
}

function pump() {
  if (state.working || !state.queue.length) return;
  const id = state.queue.shift()!;
  state.working = id;
  make(id)
    .then(() => console.log(`[experience] ${id}: ready`))
    .catch((e: Error) => {
      const message = humanError(e);
      console.error(`[experience] ${id}: ${message}`, e?.message === message ? "" : `(${String(e?.message ?? e).slice(0, 300)})`);
      state.failed.set(id, { at: Date.now(), message });
    })
    .finally(() => {
      state.working = null;
      pump();
    });
}

async function make(id: string) {
  const dream = readDream(id);
  if (!dream) throw new Error("no such dream");
  const intent = intentOf(dream);
  const mock = getJob(id)?.mode === "mock";
  // the clip length the steps are timed on; a mock stand-in borrows the sample's frames, so use the real window
  const durationS = mock ? MIN_WINDOW_S : Math.max(dream.durationS || 0, 0.5);
  const plan: Plan = { name: dream.name, intent, kind: kindOf(dream), durationS };

  const tmp = join(DATA_DIR, "tmp", id);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const pulled = join(SOURCES, `${id}.mp4`);
  try {
    if (plan.kind === "replay") {
      // The clip window the person was built from: the local footage, cut on this Mac; failing that (a clip that only
      // lives on HiPerGator, or one this Mac can't read), the run's prepped.mp4.
      const src = clipOf(dream);
      let cut = src ? await trim(src, durationS, join(tmp, "window.mp4")) : null;
      if (!cut && RUNNER && !mock) {
        mkdirSync(SOURCES, { recursive: true });
        if (existsSync(pulled) || (await fetchPrepped(id, pulled))) cut = await trim({ path: pulled, offsetS: 0 }, durationS, join(tmp, "window.mp4"));
      }
      if (cut) plan.video = { path: cut, offsetS: 0, orbit: false };
      else if (dream.preview && !mock && existsSync(join(DREAMS_DIR, id, dream.preview))) {
        plan.video = { path: join(DREAMS_DIR, id, dream.preview), offsetS: 0, orbit: true }; // last resort: the orbit render
      } else throw new Error("nothing Gemini can watch: the clip couldn't be cut and there's no preview");
    } else {
      const photo = photoOf(dream);
      if (photo) plan.photo = { path: await cleanPhoto(photo, tmp), mime: "image/jpeg" };
    }

    const written = await writeExperience(plan);
    let experience: Experience = { ...written, createdAt: new Date().toISOString() };
    if (mock && experience.steps?.length && dream.durationS > 0) {
      // a stand-in plays the sample's frames: put the steps on its clock, which is what the players run on
      const k = dream.durationS / durationS;
      const r = (t: number) => Math.round(t * k * 1000) / 1000;
      experience = { ...experience, durationS: dream.durationS, steps: experience.steps.map((st) => ({ ...st, start: r(st.start), end: r(st.end) })) };
    }
    // a plan from the orbit preview goes in the bundle (better than none) but isn't cached as final in runner mode
    save(dream, intent, experience, !(RUNNER && experience.source === "preview"));
    rmSync(pulled, { force: true }); // the plan is cached; pull it again only if someone asks for a rewrite
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** experience.json into the bundle (and, when final, the cache), linked with the intent from dream.json. */
function save(d: Dream, intent: string | null, e: Experience, cache: boolean) {
  const id = d.id;
  const body = JSON.stringify(e, null, 2);
  if (cache) {
    const dir = join(CACHE, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key(d, intent)}.json`), body);
  }
  const out = join(DREAMS_DIR, id, "experience.json");
  writeFileSync(out + ".tmp", body);
  renameSync(out + ".tmp", out);
  linkInDream(id, intent);
}

/**
 * Cut the footage to the window the person was built from, [startS, startS + durationS], at most 1080p, before it
 * leaves the Mac: a small upload and no location metadata. Null when neither avconvert nor ffmpeg can (the whole clip
 * is never sent instead).
 */
export async function trim(src: { path: string; offsetS: number }, lengthS: number, out: string): Promise<string | null> {
  const start = src.offsetS.toFixed(3);
  const length = lengthS.toFixed(3);
  try {
    await run("avconvert", ["--source", src.path, "--output", out, "--preset", "Preset1920x1080",
      "--start", start, "--duration", length, "--replace"], { timeout: 120_000 });
    if (existsSync(out)) return out;
  } catch {
    // not a Mac, or a format AVFoundation can't read (MKV, WebM): try ffmpeg
  }
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", start, "-t", length, "-i", src.path,
      "-vf", "scale=-2:'min(1920,ih)'", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-map_metadata", "-1", out], { timeout: 120_000 });
    if (existsSync(out)) return out;
  } catch {
    // no ffmpeg either
  }
  return null;
}

/**
 * The photo as Gemini gets it: a fresh JPEG, turned upright, with every metadata block dropped (an iPhone photo's
 * EXIF holds where it was taken, and sips keeps it when converting).
 */
export async function cleanPhoto(src: string, dir: string): Promise<string> {
  const out = join(dir, "photo.jpg");
  let turn = 0;
  try {
    const { stdout } = await run("sips", ["-g", "orientation", src], { timeout: 30_000 });
    const o = Number(/orientation:\s*(\d)/.exec(stdout)?.[1] ?? 1);
    turn = ({ 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 } as Record<number, number>)[o] ?? 0; // EXIF orientation, clockwise
    await run("sips", ["-s", "format", "jpeg", ...(turn ? ["--rotate", String(turn)] : []), src, "--out", out], { timeout: 60_000 });
  } catch {
    // not a Mac: a JPEG can still go, minus its metadata
  }
  const bytes = existsSync(out) ? readFileSync(out) : readFileSync(src);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("this photo couldn't be prepared on this Mac");
  writeFileSync(out, withoutMetadata(bytes));
  return out;
}

/** A JPEG without its APP1 (EXIF, XMP: GPS lives here) and APP13 (IPTC) blocks; the image data is untouched. */
function withoutMetadata(b: Buffer): Buffer {
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) break; // start of scan: everything after is image data
    const len = b.readUInt16BE(i + 2);
    if (marker !== 0xe1 && marker !== 0xed) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  return Buffer.concat(parts);
}

/** Add "experience": "experience.json" (and the intent, if dream.json lacks it) to the bundle's dream.json. */
function linkInDream(id: string, intent: string | null) {
  const p = join(DREAMS_DIR, id, "dream.json");
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    if (d.experience === "experience.json" && (d.intent ?? null) === intent) return;
    d.experience = "experience.json";
    if (intent && !d.intent) d.intent = intent;
    writeFileSync(p + ".tmp", JSON.stringify(d, null, 2));
    renameSync(p + ".tmp", p);
  } catch {
    // the bundle is mid-fetch; the next read links it
  }
}
