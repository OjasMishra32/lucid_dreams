import "server-only";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPrivate, type Dream, type Experience, type Feedback, type FeedbackState } from "../dream";
import { DATA_DIR, heldIds, readDream } from "./dreams";
import { GEMINI_ON, ensureExperience, teacherVideo, trim } from "./experience";
import { cachedFeedback, latestFeedback, saveFeedback } from "./feedbackStore";
import { fetching } from "./fetches";
import { checkAttempt, humanError, type Attempt } from "./gemini";

// "Watch me try" (team/raami.md, MORE 2): the learner records an attempt in the browser, and Gemini compares it with the
// teacher's clip window (the one the plan was made from) and returns timestamped notes. Privacy, in order:
// - never for a private dream (`"private": true`, any `ian-grandma*` id) or a held one (dreams/.held);
// - the recording is a temp file: a location tag makes it unsendable, everything else is re-encoded without metadata
//   where this Mac can (avconvert or ffmpeg); it's deleted from Gemini (gemini.ts) and from this Mac the moment the
//   answer is in, or has failed; only the notes are kept (feedbackStore.ts);
// - Gemini never identifies anyone or speaks as them (the prompt, gemini.ts).
// One at a time, at most FEEDBACK_PER_HOUR an hour. The same recording of the same plan is never sent twice.

export const MAX_ATTEMPT_S = 30;
export const MAX_ATTEMPT_BYTES = 80 * 1024 ** 2;
const PER_HOUR = Math.max(1, Number(process.env.FEEDBACK_PER_HOUR ?? 12));
const HOUR = 3600_000;

/** An answer the page can show as it is: a sentence and the status to send it with. */
export class FeedbackError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const g = globalThis as unknown as { __lucidFeedback?: { working: boolean; started: number[] } };
const state = (g.__lucidFeedback ??= { working: false, started: [] });

/** Everything the work calls out to, so tests run it with no key, no network and no video tools. */
export interface Deps {
  ask: (a: Attempt) => Promise<Omit<Feedback, "createdAt">>;
  teacher: typeof teacherVideo;
  clean: typeof trim;
  now: () => number;
}
const REAL: Deps = { ask: checkAttempt, teacher: teacherVideo, clean: trim, now: Date.now };

// A crash mid-request leaves a temp copy behind: sweep anything a recording left in .data/tmp more than ten minutes ago.
try {
  const tmp = join(DATA_DIR, "tmp");
  for (const f of readdirSync(tmp)) {
    if (/^(attempt|upload)-/.test(f) && Date.now() - statSync(join(tmp, f)).mtimeMs > 600_000) rmSync(join(tmp, f), { recursive: true, force: true });
  }
} catch {
  // no tmp folder yet
}

/**
 * Whether this dream can take an attempt at all, and why not (a sentence for the page) when it can't: never private (by
 * flag, or by an id that starts ian-grandma, in any case: this Mac's folders aren't case-sensitive), never held, a
 * lesson from a video, a Gemini key, a plan with steps.
 */
export function whyNot(d: Dream | null, e: Experience | null, id = d?.id ?? ""): { status: number; message: string } | null {
  if (!d || heldIds().has(d.id) || heldIds().has(id)) return { status: 404, message: "There's no such dream." };
  if (isPrivate(d) || isPrivate({ id })) return { status: 403, message: "Attempts aren't checked for a private dream: nothing of a family's goes to Gemini." };
  if (d.kind !== "replay") return { status: 400, message: "Watch me try needs a lesson from a video." };
  if (!GEMINI_ON) return { status: 503, message: "Watch me try is off: this Mac has no Gemini key." };
  if (!e || e.mode !== "teach" || !e.steps?.length) return { status: 409, message: "There's no lesson to compare with yet." };
  if (fetching(d.id)) return { status: 409, message: "This dream is still arriving. Try again in a minute." };
  return null;
}

/** The gate before anything is read from the learner: the dream and its plan, as giveFeedback will see them. */
export function gate(id: string): { status: number; message: string } | null {
  const d = readDream(id);
  const planned = d ? ensureExperience(id) : null;
  return whyNot(d, planned?.state === "ready" ? planned.experience : null, id);
}

/** Where "Watch me try" stands for a dream: the latest notes, none yet, or off (no key, private, held, no lesson). */
export function feedbackState(id: string): FeedbackState {
  const d = readDream(id);
  const planned = d ? ensureExperience(id) : null;
  const e = planned?.state === "ready" ? planned.experience : null;
  if (whyNot(d, e)) return { state: "off" };
  const fb = e?.feedback ?? latestFeedback(id);
  return fb ? { state: "ready", feedback: fb } : { state: "none" };
}

const CONTAINERS: [string, (b: Buffer) => boolean][] = [
  ["video/webm", (b) => b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3],
  ["video/quicktime", (b) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp" && b.toString("latin1", 8, 12) === "qt  "],
  ["video/mp4", (b) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp"],
];
/** What the recording is, from its first bytes (the browser's MediaRecorder makes WebM or MP4; a phone camera, MP4 or MOV). */
export function sniff(b: Buffer): string | null {
  return CONTAINERS.find(([, is]) => is(b))?.[0] ?? null;
}

const LOCATION_TAGS = [Buffer.from([0xa9, 0x78, 0x79, 0x7a]), Buffer.from("com.apple.quicktime.location"), Buffer.from("ISO6709"), Buffer.from("GPSLatitude")];
/** A phone's camera app writes where the video was taken; a browser's MediaRecorder never does. */
export function hasLocation(b: Buffer): boolean {
  return LOCATION_TAGS.some((t) => b.includes(t));
}

/**
 * The learner's attempt, in `up.path` (a temp file the caller deletes), against the dream's lesson. Returns the notes.
 * Throws FeedbackError for anything the learner can act on.
 */
export async function giveFeedback(id: string, up: { path: string; durationS: number }, deps: Partial<Deps> = {}): Promise<Feedback> {
  const dep = { ...REAL, ...deps };
  const d = readDream(id);
  const planned = d ? ensureExperience(id) : null;
  const e = planned?.state === "ready" ? planned.experience : null;
  const no = whyNot(d, e, id);
  if (no) throw new FeedbackError(no.message, no.status);
  if (!d || !e?.steps) throw new FeedbackError("There's no lesson to compare with yet.", 409); // (narrowing: whyNot said so)

  const durationS = Number(up.durationS);
  if (!Number.isFinite(durationS) || durationS < 1) throw new FeedbackError("That recording is too short to judge. Try at least a second.", 400);
  if (durationS > MAX_ATTEMPT_S) throw new FeedbackError(`Record at most ${MAX_ATTEMPT_S} seconds: just the move.`, 400);
  const bytes = readFileSync(/*turbopackIgnore: true*/ up.path);
  if (bytes.length === 0 || bytes.length > MAX_ATTEMPT_BYTES) throw new FeedbackError("That recording is empty or too big. Try a shorter one.", 400);
  const mime = sniff(bytes);
  if (!mime) throw new FeedbackError("That isn't a video this Mac can read. Record again in the browser.", 400);

  const hash = createHash("sha1").update(bytes).update(e.createdAt ?? "").update(e.title).digest("hex").slice(0, 16);
  const again = cachedFeedback(id, hash);
  if (again) {
    saveFeedback(id, hash, again); // it's the latest again
    return again;
  }

  if (state.working) throw new FeedbackError("Someone else's attempt is being checked. Try again in a moment.", 429);
  const now = dep.now();
  state.started = state.started.filter((t) => now - t < HOUR);
  if (state.started.length >= PER_HOUR) throw new FeedbackError("That's a lot of attempts for one hour. Try again in a little while.", 429);
  state.working = true;
  state.started.push(now);

  const tmp = join(DATA_DIR, "tmp", `attempt-${hash}-${now}`);
  try {
    mkdirSync(tmp, { recursive: true });
    // re-encoded with no metadata where possible; failing that it goes as recorded, unless it carries a location
    const cleaned = await dep.clean({ path: up.path, offsetS: 0 }, Math.min(durationS + 1, MAX_ATTEMPT_S + 1), join(tmp, "attempt.mp4"));
    if (!cleaned && hasLocation(bytes)) {
      throw new FeedbackError("That video carries where it was filmed, and this Mac can't remove it. Record it in the browser instead.", 400);
    }
    const teacherS = e.durationS || d.durationS;
    const teacher = await dep.teacher(d, teacherS, tmp);
    // a minute or more has passed: a dream held or made private meanwhile is checked again before anything leaves
    const gone = whyNot(readDream(id), e, id);
    if (gone) throw new FeedbackError(gone.message, gone.status);
    const answer = await dep.ask({
      title: e.title,
      intent: e.intent,
      steps: e.steps,
      teacher: { path: teacher.path, orbit: teacher.orbit },
      teacherS,
      attempt: { path: cleaned ?? up.path, mime: cleaned ? "video/mp4" : mime, durationS },
    });
    const feedback: Feedback = { ...answer, createdAt: new Date(dep.now()).toISOString() };
    saveFeedback(id, hash, feedback);
    console.log(`[feedback] ${id}: ${feedback.notes.length} notes`);
    return feedback;
  } catch (err) {
    if (err instanceof FeedbackError) throw err;
    const message = humanError(err);
    console.error(`[feedback] ${id}: ${message}`, String((err as Error)?.message ?? err).slice(0, 300));
    throw new FeedbackError(message, 502);
  } finally {
    state.working = false;
    rmSync(tmp, { recursive: true, force: true }); // the re-encoded copy; the original is the caller's to delete
  }
}
