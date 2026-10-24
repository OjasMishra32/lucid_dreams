import "server-only";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attempt, Attempts, LessonClip } from "../attempt";
import { dreamFile, type Dream, type Experience, type FeedbackNote } from "../dream";
import { DATA_DIR, DREAMS_DIR, heldIds, isRunId, readDream } from "./dreams";
import { cutWindow, dropPulled, ensureExperience, GEMINI_ON, saveExperience, trim, windowS } from "./experience";
import { compareTry } from "./feedback";
import { humanError } from "./gemini";

// "Watch me try": the learner films their try at a lesson; the bridge re-encodes it on this Mac (avconvert: no location
// metadata, at most MAX_TRY_S), Gemini compares it with the teacher's clip window, and the main fix joins the lesson as
// its last step ("Your fix"), so the headset plays it with them. Everything lives in .data/attempts/<dream>/:
//   lesson.mp4 + lesson.json   the teacher's clip window, cut once per run of the dream
//   <try id>/try.mp4, try.json  one try and its notes (the newest KEEP are kept)

const ROOT = join(DATA_DIR, "attempts");
const MAX_TRY_S = 20;
const MAX_WEBM_BYTES = 200 * 1024 ** 2; // a WebM goes to Gemini as it is: a few seconds of you, not a whole video
const KEEP = 6;
const RETRY_AFTER_MS = 10 * 60_000;
export const FIX = "Your fix";
const ATTEMPT_ID = /^try-[a-z0-9]{6,12}-[a-f0-9]{6}$/;

interface Rec {
  id: string;
  createdAt: string;
  state: Attempt["state"];
  stage?: Attempt["stage"];
  message?: string;
  input?: string; // the upload's file name, until it's re-encoded
  video?: string; // try.mp4 (or the browser's own try.webm, which this Mac can't re-encode)
  mime?: string;
  lengthS?: number | null;
  hintS?: number | null; // the length the browser measured
  notes?: FeedbackNote[];
  good?: string;
  unclear?: string;
  model?: string;
  added?: boolean;
}

type Lesson = { path: string; orbit: boolean; lengthS: number };
type Q = { queue: { dream: string; id: string }[]; working: string | null };
const g = globalThis as unknown as { __lucidTries?: Q; __lucidLessons?: Map<string, Promise<Lesson | null>>; __lucidNoLesson?: Map<string, number> };
const state: Q = (g.__lucidTries ??= { queue: [], working: null });
const cutting = (g.__lucidLessons ??= new Map());
const noLesson = (g.__lucidNoLesson ??= new Map());

export function isAttemptId(id: string): boolean {
  return ATTEMPT_ID.test(id);
}

/**
 * Held back from the library (dreams/.held: its dream page 404s) or private (a family's): no try page, lesson clip or
 * tries for anyone, so the source footage of a dream nobody may see yet never leaves through here.
 */
export function hiddenDream(d: Dream): boolean {
  return heldIds().has(d.id) || (d as Dream & { private?: unknown }).private === true;
}

/** The dream and its plan, when the plan is a lesson. Tries are only ever taken (and fixes only added) for these. */
export function lessonOf(id: string): { dream: Dream; experience: Experience } | null {
  if (!isRunId(id)) return null;
  const dream = readDream(id);
  if (!dream || dream.kind !== "replay" || hiddenDream(dream)) return null;
  const s = ensureExperience(id);
  if (s.state !== "ready" || s.experience.mode !== "teach" || !s.experience.steps?.length) return null;
  return { dream, experience: s.experience };
}

/** The lesson's steps without an earlier "Your fix". */
export function lessonSteps(e: Experience): NonNullable<Experience["steps"]> {
  const steps = e.steps ?? [];
  const i = e.feedback?.step;
  return typeof i === "number" && steps[i]?.title === FIX ? steps.filter((_, j) => j !== i) : steps;
}

function clockOf(d: Dream, e: Experience): number {
  return e.durationS || d.durationS || windowS(d);
}

const dirOf = (dream: string, id: string) => join(ROOT, dream, id);
const busyKey = (dream: string, id: string) => `${dream}/${id}`;
const pending = (dream: string, id: string) =>
  state.working === busyKey(dream, id) || state.queue.some((q) => q.dream === dream && q.id === id);

function readRec(dream: string, id: string): Rec | null {
  if (!isRunId(dream) || !isAttemptId(id)) return null;
  try {
    return JSON.parse(readFileSync(join(dirOf(dream, id), "try.json"), "utf8")) as Rec;
  } catch {
    return null;
  }
}

function writeRec(dream: string, r: Rec) {
  const p = join(dirOf(dream, r.id), "try.json");
  writeFileSync(p + ".tmp", JSON.stringify(r, null, 2));
  renameSync(p + ".tmp", p);
}

/** Too many tries already waiting for Gemini. */
export function busy(): boolean {
  return state.queue.length >= 3;
}

/** A folder for a new try; the upload streams straight into it. */
export function newAttempt(dream: string): { id: string; dir: string } {
  const id = `try-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const dir = dirOf(dream, id);
  mkdirSync(dir, { recursive: true });
  return { id, dir };
}

/** An upload that didn't make it. */
export function dropAttempt(dream: string, id: string) {
  if (isRunId(dream) && isAttemptId(id)) rmSync(dirOf(dream, id), { recursive: true, force: true });
}

/** The upload is on disk (`input` in the try's folder): prepare it and ask Gemini, in the background. */
export function startAttempt(dream: string, id: string, input: string, hintS: number | null): Attempt {
  const r: Rec = { id, createdAt: new Date().toISOString(), state: "working", stage: "preparing", input, hintS };
  writeRec(dream, r);
  state.queue.push({ dream, id });
  pump();
  prune(dream);
  return view(dream, r);
}

/** Ask again for a try that failed (or came in while Gemini was off). */
export function retryAttempt(dream: string, id: string): Attempt | null {
  const r = readRec(dream, id);
  if (!r) return null;
  if (r.state === "working" || r.state === "ready") return view(dream, r);
  if (!r.video && !r.input) return view(dream, r);
  Object.assign(r, { state: "working", stage: r.video ? "watching" : "preparing" });
  delete r.message;
  writeRec(dream, r);
  state.queue.push({ dream, id });
  pump();
  return view(dream, r);
}

/** The learner's try and its notes, gone from this Mac: its fix leaves the lesson too, if the lesson's fix is its. */
export function deleteAttempt(dream: string, id: string): boolean {
  if (!readRec(dream, id) || state.working === busyKey(dream, id)) return false;
  state.queue = state.queue.filter((q) => !(q.dream === dream && q.id === id));
  dropFromLesson(dream, id);
  rmSync(dirOf(dream, id), { recursive: true, force: true });
  return true;
}

export function getAttempt(dream: string, id: string): Attempt | null {
  const d = readDream(dream);
  if (!d || hiddenDream(d)) return null;
  const r = readRec(dream, id);
  return r ? view(dream, settle(dream, r), lessonOf(dream)?.experience) : null;
}

/** The try's video on this Mac, for the page to play. */
export function attemptVideo(dream: string, id: string): { path: string; mime: string } | null {
  const d = readDream(dream);
  if (!d || hiddenDream(d)) return null;
  const r = readRec(dream, id);
  if (!r?.video) return null;
  const path = join(dirOf(dream, id), r.video);
  return existsSync(path) ? { path, mime: r.mime ?? "video/mp4" } : null;
}

/** Everything the try page shows: whether Gemini is on, the lesson clip, and the tries (newest first). */
export function attemptsView(d: Dream, e: Experience): Attempts {
  return { gemini: GEMINI_ON, lesson: lessonClip(d, e), attempts: recs(d.id).map((r) => view(d.id, settle(d.id, r), e)) };
}

function recs(dream: string): Rec[] {
  const dir = join(ROOT, dream);
  if (!isRunId(dream) || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isAttemptId)
    .map((id) => readRec(dream, id))
    .filter((r): r is Rec => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A try still marked working that nothing is working on (the bridge restarted): say so instead of spinning. */
function settle(dream: string, r: Rec): Rec {
  if (r.state !== "working" || pending(dream, r.id)) return r;
  const out: Rec = { ...r, state: "failed", message: "This try was interrupted. Send it again." };
  delete out.stage;
  writeRec(dream, out);
  return out;
}

function prune(dream: string) {
  for (const r of recs(dream).slice(KEEP)) if (!pending(dream, r.id)) rmSync(dirOf(dream, r.id), { recursive: true, force: true });
}

/** What the page gets. `added` only while the lesson's fix is still this try's (a later try replaces it). */
function view(dream: string, r: Rec, e?: Experience): Attempt {
  const enc = encodeURIComponent;
  return {
    id: r.id,
    createdAt: r.createdAt,
    state: r.state,
    ...(r.stage ? { stage: r.stage } : {}),
    ...(r.message ? { message: r.message } : {}),
    video: r.video ? `/api/dreams/${enc(dream)}/attempts/${enc(r.id)}/video` : null,
    lengthS: r.lengthS ?? null,
    ...(r.notes ? { notes: r.notes } : {}),
    ...(r.good ? { good: r.good } : {}),
    ...(r.unclear ? { unclear: r.unclear } : {}),
    ...(r.added && (!e || e.feedback?.attempt === r.id) ? { added: true } : {}),
  };
}

/** humanError, worded for a try: nothing asks Gemini again on its own here, the learner does ("Ask again"). */
function tryError(e: unknown): string {
  return humanError(e)
    .replace("It tries again in a few minutes.", "Ask again in a few minutes.")
    .replace("the models the plan needs", "the models the notes need");
}

function pump() {
  if (state.working || !state.queue.length) return;
  const { dream, id } = state.queue.shift()!;
  state.working = busyKey(dream, id);
  work(dream, id)
    .catch((e: Error) => {
      const message = tryError(e);
      console.error(`[try] ${dream}/${id}: ${message}`, e?.message === message ? "" : `(${String(e?.message ?? e).slice(0, 300)})`);
      const r = readRec(dream, id);
      if (r) {
        delete r.stage;
        writeRec(dream, { ...r, state: "failed", message });
      }
    })
    .finally(() => {
      state.working = null;
      pump();
    });
}

async function work(dream: string, id: string) {
  const r = readRec(dream, id);
  if (!r) return; // deleted while it waited
  const dir = dirOf(dream, id);

  // 1. The try, re-encoded on this Mac: at most MAX_TRY_S, H.264, no location metadata (avconvert's default filter).
  if (!r.video) {
    if (!r.input) throw new Error("This try has no video. Film it again.");
    const input = join(dir, r.input);
    const out = join(dir, "try.mp4");
    if (await trim({ path: input, offsetS: 0 }, MAX_TRY_S, out)) {
      Object.assign(r, { video: "try.mp4", mime: "video/mp4", lengthS: mp4Duration(out) ?? r.hintS ?? null });
      rmSync(input, { force: true });
    } else if (/\.webm$/i.test(r.input)) {
      // A browser's own recording (Firefox, or Chrome without MP4 recording): AVFoundation can't read WebM, but a
      // MediaRecorder file carries no location, so it goes as it is. It can't be shortened here, so a long one doesn't go.
      if ((r.hintS ?? 0) > MAX_TRY_S + 1 || statSync(input).size > MAX_WEBM_BYTES) {
        throw new Error(`This Mac can't shorten a WebM video. Send a try under ${MAX_TRY_S} seconds, or an MP4 or MOV.`);
      }
      renameSync(input, join(dir, "try.webm"));
      Object.assign(r, { video: "try.webm", mime: "video/webm", lengthS: r.hintS ? Math.min(r.hintS, MAX_TRY_S) : null });
    } else {
      throw new Error("This Mac couldn't read that video. Film your try here, or use an MP4 or MOV.");
    }
    delete r.input;
  }
  if (!GEMINI_ON) {
    delete r.stage;
    return writeRec(dream, { ...r, state: "off" });
  }
  writeRec(dream, { ...r, stage: "watching" });

  // 2. The lesson it's compared with.
  const l = lessonOf(dream);
  if (!l) throw new Error("This dream isn't a lesson any more, so there's nothing to compare your try with.");
  const lesson = await ensureLesson(l.dream);
  if (!lesson) throw new Error("There's no lesson clip on this Mac to compare your try with.");
  const clockS = clockOf(l.dream, l.experience);
  const scale = scaleOf(lesson, clockS);
  const steps = lessonSteps(l.experience).map((s) => ({ ...s, start: s.start * scale, end: s.end * scale }));

  // 3. Gemini, with both videos; the lesson's times come back in its video's seconds and go into the bundle's clip time.
  const out = await compareTry({
    lesson: { path: lesson.path, mime: "video/mp4", lengthS: clockS * scale, videoS: lesson.lengthS, orbit: lesson.orbit },
    attempt: { path: join(dir, r.video!), mime: r.mime ?? "video/mp4", lengthS: r.lengthS ?? null },
    title: l.experience.title,
    intent: l.experience.intent,
    steps,
  });
  // Real seconds per bundle second: the cut clip is real time (a mock's stand-in runs on a far shorter clock, so
  // bundle times need ms precision); the orbit render plays the bundle's own clock.
  const real = lesson.orbit ? 1 : scale;
  const notes = out.notes.map((n) => {
    let t = n.teacherS / scale;
    if (t > clockS) t = lesson.orbit ? t % clockS : clockS; // the orbit render loops the move
    return { ...n, teacherS: Math.round(t * 1000) / 1000 };
  });
  const added = notes.length > 0 && addToLesson(dream, id, notes, out.good, real);
  delete r.stage;
  writeRec(dream, {
    ...r, state: "ready", notes, model: out.model, added,
    ...(out.good ? { good: out.good } : {}),
    ...(out.unclear ? { unclear: out.unclear } : {}),
  });
}

/**
 * The main fix joins the lesson as its last step: the teacher's segment it's about (the plan's step there, else a
 * moment around it), slowed down, with the fix as the tip; the notes go in "feedback". It replaces an earlier fix, and
 * only ever goes into a plan that is (still) a lesson.
 */
function addToLesson(dream: string, attempt: string, notes: FeedbackNote[], good: string | undefined, real: number): boolean {
  const l = lessonOf(dream);
  if (!l) return false;
  const { dream: d, experience: e } = l;
  const D = clockOf(d, e);
  const steps = lessonSteps(e);
  const t = notes[0].teacherS;
  const secs = (x: number) => x / (real > 0 ? real : 1); // x real seconds, on the bundle's clock
  const at = steps.find((s) => t >= s.start - secs(0.05) && t <= s.end + secs(0.05));
  let start = at?.start ?? Math.max(0, t - secs(0.8));
  let end = at?.end ?? Math.min(D, t + secs(0.8));
  if (end - start < secs(0.4)) {
    start = Math.max(0, Math.min(start, D - secs(0.4)));
    end = Math.min(D, start + secs(0.4));
  }
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const fix = { start: r(start), end: r(end), title: FIX, tip: notes[0].note, speed: 0.5, repeat: 2 };
  saveExperience(d, {
    ...e,
    steps: [...steps, fix],
    feedback: { createdAt: new Date().toISOString(), notes, ...(good ? { good } : {}), attempt, step: steps.length },
  });
  return true;
}

/** A deleted try's fix and notes come out of the lesson (only while the lesson's fix is that try's). */
function dropFromLesson(dream: string, attempt: string) {
  const l = lessonOf(dream);
  if (!l || l.experience.feedback?.attempt !== attempt) return;
  const e: Experience = { ...l.experience, steps: lessonSteps(l.experience) };
  delete e.feedback;
  saveExperience(l.dream, e);
}

// ---------- the lesson clip ----------

/** Video seconds per lesson second: about 1 for the real clip; a mock's stand-in or a short orbit render differ. */
function scaleOf(l: Lesson, clockS: number): number {
  if (clockS <= 0) return 1;
  if (l.orbit) return l.lengthS < clockS - 0.05 ? l.lengthS / clockS : 1; // a longer orbit render loops the move
  return Math.abs(l.lengthS - clockS) < 0.25 ? 1 : l.lengthS / clockS;
}

interface LessonMeta {
  for: string; // the dream's createdAt: a re-run under the same id is a new person
  orbit: boolean;
  lengthS: number;
  at: number;
}

/** The lesson clip already on hand: cut for this run of the dream, or the orbit render standing in. */
function lessonReady(d: Dream): (Lesson & { stale: boolean }) | null {
  try {
    const m = JSON.parse(readFileSync(join(ROOT, d.id, "lesson.json"), "utf8")) as LessonMeta;
    if (m.for !== (d.createdAt ?? "")) return null;
    const path = m.orbit ? (d.preview ? join(DREAMS_DIR, d.id, d.preview) : null) : join(ROOT, d.id, "lesson.mp4");
    if (!path || !existsSync(path)) return null;
    // the orbit render stands in until the real clip can be cut: try again every so often
    return { path, orbit: m.orbit, lengthS: m.lengthS, stale: m.orbit && Date.now() - m.at > RETRY_AFTER_MS };
  } catch {
    return null;
  }
}

/** The lesson clip for a dream, cut once (deduplicated while it runs). Null when there's nothing to compare with. */
export function ensureLesson(d: Dream): Promise<Lesson | null> {
  const ready = lessonReady(d);
  if (ready && !ready.stale) return Promise.resolve(ready);
  let p = cutting.get(d.id);
  if (!p) {
    p = cutLesson(d).finally(() => cutting.delete(d.id));
    cutting.set(d.id, p);
  }
  return ready ? Promise.resolve(ready) : p;
}

async function cutLesson(d: Dream): Promise<Lesson | null> {
  const dir = join(ROOT, d.id);
  const tmp = join(dir, `lesson-${randomBytes(4).toString("hex")}.mp4`);
  try {
    mkdirSync(dir, { recursive: true });
    const v = await cutWindow(d, tmp);
    if (!v) {
      noLesson.set(d.id, Date.now());
      return null;
    }
    noLesson.delete(d.id);
    const lengthS = mp4Duration(v.path) ?? windowS(d);
    const path = v.orbit ? v.path : join(dir, "lesson.mp4");
    if (!v.orbit) {
      renameSync(tmp, path);
      dropPulled(d.id);
    }
    const meta: LessonMeta = { for: d.createdAt ?? "", orbit: v.orbit, lengthS, at: Date.now() };
    writeFileSync(join(dir, "lesson.json"), JSON.stringify(meta, null, 2));
    return { path, orbit: v.orbit, lengthS };
  } catch (e) {
    console.error(`[try] ${d.id}: the lesson clip couldn't be cut (${String((e as Error)?.message ?? e).slice(0, 200)})`);
    noLesson.set(d.id, Date.now());
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** What the page plays on the teacher's side, starting the cut if it isn't there yet. */
function lessonClip(d: Dream, e: Experience): LessonClip {
  const ready = lessonReady(d);
  if (!ready) {
    if (Date.now() - (noLesson.get(d.id) ?? 0) < RETRY_AFTER_MS) return { state: "none" };
    void ensureLesson(d);
    return { state: "working" };
  }
  if (ready.stale) void ensureLesson(d);
  const src = ready.orbit
    ? dreamFile(d.id, d.preview!)
    : `/api/dreams/${encodeURIComponent(d.id)}/lesson?v=${encodeURIComponent(d.createdAt ?? "")}`;
  return { state: "ready", src, scale: scaleOf(ready, clockOf(d, e)), orbit: ready.orbit };
}

/** The cut lesson clip's file, for its route (the orbit render is served with the bundle). */
export function lessonFile(d: Dream): string | null {
  const ready = lessonReady(d);
  return ready && !ready.orbit ? ready.path : null;
}

/** Seconds of an MP4 or MOV, from its movie header (there's no ffprobe on the Mac). Null when it isn't one. */
export function mp4Duration(path: string): number | null {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const read = (pos: number, n: number) => {
      const b = Buffer.alloc(n);
      readSync(fd, b, 0, n, pos);
      return b;
    };
    const find = (from: number, to: number, type: string): [number, number] | null => {
      for (let i = from; i + 8 <= to; ) {
        const h = read(i, 16);
        let len = h.readUInt32BE(0);
        let head = 8;
        if (len === 1) {
          len = Number(h.readBigUInt64BE(8));
          head = 16;
        } else if (len === 0) len = to - i;
        if (len < head) return null;
        if (h.toString("latin1", 4, 8) === type) return [i + head, i + len];
        i += len;
      }
      return null;
    };
    const moov = find(0, size, "moov");
    const mvhd = moov && find(moov[0], moov[1], "mvhd");
    if (!mvhd) return null;
    const b = read(mvhd[0], 32);
    const [scale, dur] = b[0] === 1 ? [b.readUInt32BE(20), Number(b.readBigUInt64BE(24))] : [b.readUInt32BE(12), b.readUInt32BE(16)];
    return scale > 0 && dur > 0 ? dur / scale : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}
