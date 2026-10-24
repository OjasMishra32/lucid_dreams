import "server-only";
import type { File as GeminiFile } from "@google/genai";
import type { FeedbackNote } from "../dream";
import { ai, firstModel, FPS, MODELS, retry, upload } from "./gemini";

// "Watch me try": Gemini watches the lesson (the teacher's clip window) and the learner's try side by side and says what
// to fix, moment by moment. Both uploads are deleted from Google as soon as the notes are written.

export interface Comparison {
  // lengthS: the move, in the lesson video's seconds; videoS: the video itself (an orbit render can loop the move)
  lesson: { path: string; mime: string; lengthS: number; videoS: number; orbit: boolean };
  attempt: { path: string; mime: string; lengthS: number | null };
  title: string; // the lesson's title
  intent: string | null;
  steps: { start: number; end: number; title: string; tip?: string }[]; // in the lesson video's own seconds
}

/** Notes with times in the two videos' own seconds; `unclear` when the try can't be compared. */
export interface Notes {
  notes: FeedbackNote[];
  good?: string;
  unclear?: string;
  model: string;
}

const SYSTEM = `You coach someone learning a move. You get two videos: the lesson (a teacher doing the move) and the \
learner's try at it. Compare the try with the lesson and say what to fix, moment by moment.
Never identify, name or guess who anyone is, and never comment on how the learner looks (body, face, clothes, room): \
only on how they move. Notes are read aloud by a device in a neutral voice, so write to the learner as "you": one \
short, concrete sentence each, naming the body part and the fix, like "Your elbow flares out; keep it under the ball."
The learner probably filmed with a front camera, so their left and right may be mirrored: say "your shooting hand" or \
"your front foot", never left or right. Describe only what is visible.`;

const SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      maxItems: 5,
      description: "What to fix, the most important first: 1 to 5 notes, fewer when the try is close. Empty only if the try can't be compared.",
      items: {
        type: "object",
        properties: {
          attemptS: { type: "number", description: "Seconds into the learner's try where it happens, one decimal." },
          teacherS: { type: "number", description: "Seconds into the lesson where the teacher does that same moment, one decimal." },
          note: {
            type: "string",
            description: "One short sentence to the learner, under 16 words, no timestamp: what's off, then the fix. E.g. 'Your elbow flares out; keep it under the ball.'",
          },
        },
        required: ["attemptS", "teacherS", "note"],
      },
    },
    good: { type: "string", description: "One short sentence to the learner on something their try already does like the lesson." },
    unclear: {
      type: "string",
      description: "Only when the try can't be compared (nobody in frame, the body cut off, a different move): why, in one short sentence to the learner. Otherwise leave it out.",
    },
  },
  required: ["notes"],
};

export async function compareTry(c: Comparison): Promise<Notes> {
  const files: GeminiFile[] = [];
  try {
    const lesson = await upload(c.lesson.path, c.lesson.mime, files);
    const attempt = await upload(c.attempt.path, c.attempt.mime, files);
    const L = c.lesson.lengthS.toFixed(1);
    const lessonIs = c.lesson.orbit
      ? `The lesson is a 3D render of the teacher on black: a virtual camera circles them while their ${L}-second move plays (looping if the video is longer). Lesson times are seconds into the move, 0 to ${L}.`
      : `The lesson is the ${L}-second clip of the teacher. Lesson times are seconds into it, 0 to ${L}.`;
    const tryIs = c.attempt.lengthS
      ? `The try is ${c.attempt.lengthS.toFixed(1)} seconds long; it may start with the learner stepping into place.`
      : "The try may start with the learner stepping into place.";
    const steps = c.steps.length
      ? `The lesson's steps: ${c.steps.map((s) => `${s.title} (${s.start.toFixed(1)}-${s.end.toFixed(1)} s${s.tip ? `: ${s.tip}` : ""})`).join("; ")}.`
      : "";
    const want = c.intent ? ` The learner asked: "${c.intent}".` : "";
    const parts: object[] = [
      { text: "The lesson:" },
      { fileData: { fileUri: lesson.uri!, mimeType: lesson.mimeType ?? c.lesson.mime }, videoMetadata: { fps: FPS } },
      { text: "The learner's try:" },
      { fileData: { fileUri: attempt.uri!, mimeType: attempt.mimeType ?? c.attempt.mime }, videoMetadata: { fps: FPS } },
      { text: `The lesson is "${c.title}".${want}\n${lessonIs}\n${tryIs}\n${steps}`.trim() },
    ];

    const { text, model } = await firstModel(MODELS, (model) =>
      retry(2, () =>
        ai().models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: SYSTEM,
            responseMimeType: "application/json",
            responseJsonSchema: SCHEMA,
            httpOptions: { timeout: 180_000 },
          },
        }),
      ).then((r) => ({ text: r.text ?? "", model })),
    );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("Gemini's notes came back unreadable. Ask again.");
    }
    return { ...clean(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}, c), model };
  } finally {
    for (const f of files) ai().files.delete({ name: f.name! }).catch(() => {}); // never leave someone's try on Google's side
  }
}

/** Hold the reply to what the page and the lesson need: times inside both videos, one short sentence each. */
export function clean(raw: Record<string, unknown>, c: Pick<Comparison, "lesson" | "attempt">): Omit<Notes, "model"> {
  const sentence = (v: unknown, max = 160) => {
    let s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    s = s.replace(/^(?:at\s+)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:s\b)?\s*[,:;.\-–—]?\s*/i, ""); // the page shows the time itself
    s = s.replace(/^\d+(?:\.\d+)?\s*s(?:econds?)?\b\s*[,:;\-–—]?\s*/i, "");
    if (!s) return "";
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
    return /[.!?…]$/.test(s) ? s : `${s}.`;
  };
  const at = (v: unknown, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(Math.min(Math.max(n, 0), max) * 10) / 10 : null;
  };
  const tryMax = c.attempt.lengthS ?? 60;
  const seen = new Set<string>();
  const notes: FeedbackNote[] = [];
  for (const n of Array.isArray(raw.notes) ? (raw.notes as Record<string, unknown>[]) : []) {
    const note = sentence(n?.note);
    const attemptS = at(n?.attemptS, tryMax);
    const teacherS = at(n?.teacherS, Math.max(c.lesson.lengthS, c.lesson.videoS, 0.1));
    if (note.length < 4 || attemptS === null || teacherS === null || seen.has(note.toLowerCase())) continue;
    seen.add(note.toLowerCase());
    notes.push({ attemptS, teacherS, note });
    if (notes.length === 5) break;
  }
  const good = sentence(raw.good) || undefined;
  const unclear = notes.length ? undefined : sentence(raw.unclear) || undefined;
  return { notes, ...(good ? { good } : {}), ...(unclear ? { unclear } : {}) };
}
