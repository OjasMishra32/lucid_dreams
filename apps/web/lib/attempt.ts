// "Watch me try" (the web app's own API, not a shared contract): the learner films their try at a lesson, the bridge
// asks Gemini to compare it with the teacher's clip, and the notes come back with times in both. Safe on server and client.

import type { FeedbackNote } from "./dream";

export interface Attempt {
  id: string;
  createdAt: string;
  // working: being prepared or watched; ready: notes (or why there are none); failed: say why; off: no Gemini key
  state: "working" | "ready" | "failed" | "off";
  stage?: "preparing" | "watching";
  message?: string; // failed: what happened, in a sentence
  video: string | null; // where the page plays the try
  lengthS?: number | null;
  notes?: FeedbackNote[]; // the main fix first; teacherS in the bundle's clip time
  good?: string;
  unclear?: string; // the try couldn't be compared, and why
  added?: boolean; // the fix went into the lesson as its last step
}

/**
 * The teacher's side: the clip window the person was built from, cut on the Mac (or, failing that, the orbit render).
 * `scale` is video seconds per lesson second, so a note's teacherS seeks to teacherS * scale.
 */
export type LessonClip =
  | { state: "ready"; src: string; scale: number; orbit: boolean }
  | { state: "working" }
  | { state: "none" };

/** GET /api/dreams/:id/attempts */
export interface Attempts {
  gemini: boolean;
  lesson: LessonClip;
  attempts: Attempt[]; // newest first
}

/** "0:02", to the nearest second */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
