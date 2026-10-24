// The shared contracts from AGENTS.md: the dream bundle and the job API. Safe to import on server and client.

export type Vec3 = [number, number, number];

export interface Dream {
  id: string;
  name: string;
  kind: "replay" | "avatar";
  fps: number;
  frameCount: number;
  durationS: number;
  units: "meters";
  upAxis: "+Y";
  bounds: { min: Vec3; max: Vec3 } | null;
  frames: {
    dir: string;
    pattern: string;
    spz?: string;
    reality?: string | null;
    gaussiansPerFrame?: number;
    spzBytesTotal?: number;
  } | null;
  avatar: { file: string; rig: string; motion: string; skin?: string; skeleton?: string } | null;
  audio: string | null;
  voice?: string | null; // "voice.m4a": the speaking voice alone, separated from music and noise
  preview: string | null;
  thumb: string | null;
  source?: { clip: string; width: number; height: number } | null;
  metrics?: {
    psnr: number | null;
    ssim: number | null;
    lpips: number | null;
    views: number | null;
    seenFraction?: number | null;
  } | null;
  intent?: string | null; // what the user wants to do with this person ("teach me this strum")
  experience?: string | null; // "experience.json": the plan written from the intent (see Experience below)
  captions?: string | null; // "captions.vtt": WebVTT of what the person says, on the clip's own clock
  private?: boolean; // a family's dream: never in the kiosk, the showcase or a share link; the library shows it on this Mac only
  updatedAt?: string; // set when a bundle is rebuilt in place (a new head, say); the realism check is redone then
  createdAt?: string;
}

export type ExperienceMode = "teach" | "companion" | "watch" | "play";
export const STRENGTHS = ["club", "expert", "master", "gm", "fischer", "carlsen", "max"] as const;
export type Strength = (typeof STRENGTHS)[number];
// Places around the person instead of your room (AGENTS.md, Experience, "environment"); "room" is your own room.
export const ENVIRONMENTS = ["concert-hall", "court", "gym", "ring", "studio", "mountains", "room"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * experience.json (AGENTS.md, Contracts, "Experience"): what happens when they're in your room. Written by the bridge
 * with Gemini from the intent and the clip; the WebXR viewer and the Quest app run it. Step times are seconds in the
 * bundle's own clip time (0 = its first frame). Fields after `play` are extras for the web page; players ignore them.
 */
export interface Experience {
  intent: string | null;
  mode: ExperienceMode;
  title: string;
  summary: string;
  place: "facing" | "beside" | "ahead";
  steps?: { start: number; end: number; title: string; tip?: string; speed?: number; repeat?: number }[];
  play?: { game: "chess"; strength: Strength };
  environment?: Environment; // only when the activity clearly has a home (piano: concert hall, basketball: court)
  objects?: string[]; // the objects that matter for the intent ("basketball", "hoop"); the pipeline's props.json builds them
  category?: string;
  feedback?: Feedback; // "Watch me try": Gemini's notes on the learner's latest attempt (the video itself is never kept)
  durationS?: number; // the clip length the steps are timed on
  source?: "clip" | "preview" | "photo" | "intent"; // what Gemini looked at
  model?: string;
  createdAt?: string;
}

/**
 * "Watch me try" (the learner records an attempt in the browser, Gemini compares it with the teacher's clip). Only these
 * notes are kept: the attempt's video is deleted from Gemini and from the Mac as soon as the answer is in. Additive: it
 * sits beside `steps` in experience.json, so players that don't know it run the lesson exactly as before.
 */
export interface FeedbackNote {
  attemptT: number; // seconds into the learner's recording
  teacherT: number | null; // seconds into the teacher's clip (the bundle's clock), when the note is about a moment there
  tone: "good" | "fix";
  title: string; // 1 to 4 words
  note: string; // one sentence to the learner, read in the device's voice
}
export interface Feedback {
  summary: string; // one plain sentence on the attempt as a whole
  seen: boolean; // false: Gemini couldn't see the whole move (out of frame, too dark), and the summary says what to change
  notes: FeedbackNote[];
  attemptS: number; // how long the recording was
  source: "clip" | "preview"; // what Gemini compared it with: the real clip, or the 3D person's orbit render
  model?: string;
  createdAt: string;
}
export type FeedbackState =
  | { state: "ready"; feedback: Feedback }
  | { state: "none" } // available, nothing recorded yet
  | { state: "off" }; // no Gemini key, a private or held dream, or not a lesson

export type ExperienceState =
  | { state: "ready"; experience: Experience }
  | { state: "working" }
  | { state: "failed"; message: string }
  | { state: "off" }; // no Gemini key, or nothing to plan from

/** The realism check: does the rebuilt person look like the source, and what gives the render away (Gemini). */
export type RealismView = "front" | "three-quarter" | "profile";
export const DEFECT_KINDS = ["eyes", "skin-tone", "hairline", "hands", "seams", "floaters", "face-shape", "teeth", "clothing", "other"] as const;
export interface RealismDefect {
  kind: (typeof DEFECT_KINDS)[number];
  view: RealismView;
  where: string; // "left eye, inner corner"
  severity: "minor" | "noticeable" | "severe";
  note: string;
}
export interface Realism {
  samePerson: boolean;
  confidence: number; // 0-1: how sure Gemini is of samePerson
  summary: string;
  defects: RealismDefect[];
  source: "photo" | "clip"; // what the render was compared with
  moments: Record<RealismView, number>; // seconds in preview.mp4 that were judged
  model?: string;
  createdAt: string;
}
/** A candidate (the dream itself, or a head-swap bundle "<id>-head..."), ranked by same-person confidence. */
export interface RankedCandidate {
  id: string;
  name: string;
  samePerson: boolean;
  confidence: number;
}
export type RealismState =
  | { state: "ready"; realism: Realism; candidates?: RankedCandidate[] }
  | { state: "working" }
  | { state: "failed"; message: string }
  | { state: "off" }; // no Gemini key, a private or test dream, or nothing on this Mac to compare with

export type JobKind = "replay" | "avatar";
export type JobState = "queued" | "running" | "done" | "failed";
export type Stage = "upload" | "check" | "views" | "upscale" | "reconstruct" | "export";

export const STAGES: Stage[] = ["upload", "check", "views", "upscale", "reconstruct", "export"];

/** GET /api/jobs/:id */
export interface JobStatus {
  id: string;
  status: JobState;
  stage: Stage;
  progress: number;
  etaS: number | null;
  message: string;
}

/**
 * /live, for the judges: one run as it is on HiPerGator right now (GET /api/live/run). Times are seconds; `source` says
 * what it was read from: the runner's SSH link ("hpg": timings, GPUs and strips are real) or only the job API ("job":
 * the stage and progress, nothing else).
 */
export interface LiveStage {
  stage: Stage;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  durationS: number | null; // done: how long it took; running: how long so far; else null
}
export interface LiveGpus {
  stage: Stage;
  label: string;
  type: string; // "B200", "RTX PRO 6000", "L4", or the partition's own name
  running: number; // GPUs working on this stage right now
  waiting: number; // GPUs this stage has asked for and not got yet
}
export interface LivePeek {
  kind: "real" | "imagined"; // real: the source frame; imagined: the generated views
  name: string; // peek-000011.jpg, peek-source-000011.jpg
  at: number; // when it was written, seconds (part of its address: a new one is a new image)
  frame: number; // the frame it is of
  url: string;
}
export interface LiveRun {
  id: string;
  name: string;
  kind: JobKind;
  status: JobStatus;
  stages: LiveStage[];
  elapsedS: number | null; // since it was submitted
  frames: { done: number; total: number } | null; // reconstruction, once it has started
  gpus: LiveGpus[];
  peeks: LivePeek[]; // newest of each kind
  source: "hpg" | "job";
  at: number; // when this was read, ms since the epoch on the bridge
}
export interface LiveChoice {
  id: string;
  name: string;
  live: boolean; // still running
}
export interface LiveState {
  run: LiveRun | null; // null: nothing to show (no runs, or none that may be shown)
  choices: LiveChoice[];
}

/** How each stage reads to people. Upscale only shows while the pipeline actually runs it. */
export const STAGE_LABELS: Record<Stage, string> = {
  upload: "Upload",
  check: "Check the clip",
  views: "Imagine every angle",
  upscale: "Sharpen every view",
  reconstruct: "Build them in 3D",
  export: "Get them ready",
};

/**
 * A family's dream, shown only on the bridge Mac and never shared: dream.json's `"private": true`, or any of Ian's
 * grandma's runs (any id starting ian-grandma) unless its dream.json says `"private": false` (the family agreed to her
 * being shown: Ojasva, Sat Oct 24).
 */
export function isPrivate(d: { id: string; private?: boolean | null }): boolean {
  return d.private === true || (isFamily(d.id) && d.private !== false);
}

/** A family's own (any of Ian's grandma's runs): shown or not, their clip and photos never go to Gemini. */
export function isFamily(id: string): boolean {
  return /^ian-grandma/i.test(id);
}

export function dreamFile(id: string, file: string): string {
  return `/dreams/${encodeURIComponent(id)}/${file}`;
}

export function heightM(d: Dream): number | null {
  if (!d.bounds) return null;
  const h = d.bounds.max[1] - d.bounds.min[1];
  return h > 0.3 && h < 3 ? h : null;
}

export function formatCount(n?: number | null): string {
  if (!n) return "";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`;
}

export function formatEta(s: number | null | undefined): string {
  if (s == null) return "";
  if (s < 45) return "Less than a minute left";
  const m = Math.round(s / 60);
  if (m < 60) return `About ${m} minute${m === 1 ? "" : "s"} left`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `About ${h} h ${rest} min left`;
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "dream"
  );
}
