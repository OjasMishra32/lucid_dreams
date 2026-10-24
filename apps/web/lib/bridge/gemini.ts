import "server-only";
import { FileState, GoogleGenAI, type File as GeminiFile } from "@google/genai";
import {
  DEFECT_KINDS, ENVIRONMENTS, STRENGTHS, type Environment, type Experience, type ExperienceMode, type Realism, type RealismDefect,
  type RealismView, type Strength,
} from "../dream";

// Gemini, the brain of the main goal: one sentence of intent plus the person's clip (or photo) in, experience.json out.
// Models are tried in order, so a renamed or unavailable model never takes the step down.
const MODELS = (process.env.GEMINI_MODEL ?? "gemini-3.8-flash,gemini-3.6-flash,gemini-3-flash-preview").split(",");
const FPS = 15; // frames per second Gemini sees: enough for a jump shot's release (the default is 1)

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

/** What the plan is written from. */
export interface Plan {
  name: string; // what the user called the dream
  intent: string | null; // their sentence, or null
  kind: "replay" | "avatar";
  durationS: number; // the clip's length in the bundle: step times land in [0, durationS]
  video?: { path: string; offsetS: number; orbit: boolean }; // the clip window (orbit: preview.mp4, a 3D render)
  photo?: { path: string; mime: string }; // an avatar's one photo
}

const SYSTEM = `You plan what happens when a person, rebuilt life size in 3D from a video or a photo, stands in \
someone's room. Every plan is one of four modes: teach (a lesson: the move in steps, each slowed down and repeated, \
then the learner's turn), companion (they're simply there with you), watch (plain playback), play (a game of chess \
with them).
Never identify, name or guess who the person is, even if they seem famous, and never speak as them. Tips are read \
aloud by the device in a neutral voice, so write them to the learner as "you": one short sentence each. Describe only \
what is visible.`;

const SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["teach", "companion", "watch", "play"] },
    title: { type: "string", description: "Short and warm, at most 6 words, e.g. 'Down, down-up: a first strum'." },
    summary: { type: "string", description: "One sentence on what they're doing, under 20 words." },
    category: { type: "string", description: "The activity, 1 or 2 words, e.g. 'Guitar', 'Basketball', 'Salsa'." },
    place: {
      type: "string",
      enum: ["facing", "beside", "ahead"],
      description:
        "ahead: moves you follow (dance, sport form, exercise); facing: things you watch hands do (guitar, cooking) and companions; beside: side by side, e.g. 'sit next to me' at a piano.",
    },
    steps: {
      type: "array",
      maxItems: 6,
      description: "teach only: 2 to 6 steps covering the move in order.",
      items: {
        type: "object",
        properties: {
          start: { type: "number", description: "Seconds from the start of the clip, one decimal." },
          end: { type: "number", description: "Seconds from the start of the clip, after start." },
          title: { type: "string", description: "1 to 3 words, e.g. 'Load', 'Step back', 'Release'." },
          tip: { type: "string", description: "One short sentence to the learner, e.g. 'Sink your hips before you rise.'" },
          speed: { type: "number", description: "Playback speed while they watch this step, 0.25 to 1. Slower for fast moves." },
          repeat: { type: "integer", description: "How many times it plays before their turn, 1 to 3." },
        },
        required: ["start", "end", "title", "tip"],
      },
    },
    environment: {
      type: "string",
      enum: [...ENVIRONMENTS],
      description: "Only when the activity clearly has a home: piano or music -> concert-hall, basketball -> court, boxing -> ring, workout -> gym, dance -> studio. Otherwise leave it out.",
    },
    objects: {
      type: "array",
      maxItems: 4,
      items: { type: "string", description: "One lowercase noun, e.g. 'basketball', 'hoop', 'guitar', 'piano', 'bench'." },
      description: "The objects that matter for what the user wants to do, e.g. ['basketball', 'hoop'] for a jump shot, ['piano', 'bench'] for a piano lesson. Empty when none.",
    },
    strength: {
      type: "string",
      enum: [...STRENGTHS],
      description: "play only: from the sentence ('like Carlsen' is carlsen), else club.",
    },
  },
  required: ["mode", "title", "summary", "place"],
};

/** Ask Gemini for the plan and hold it to the contract. Everything it was shown is deleted from Google afterwards. */
export async function writeExperience(p: Plan): Promise<Omit<Experience, "createdAt">> {
  const files: GeminiFile[] = [];
  try {
    const d = p.durationS.toFixed(2);
    const parts: object[] = [];
    let source: Experience["source"] = "intent";
    if (p.video) {
      const f = await upload(p.video.path, "video/mp4", files);
      parts.push({
        fileData: { fileUri: f.uri!, mimeType: f.mimeType ?? "video/mp4" },
        videoMetadata: {
          fps: FPS,
          ...(p.video.offsetS > 0
            ? { startOffset: `${p.video.offsetS.toFixed(2)}s`, endOffset: `${(p.video.offsetS + p.durationS).toFixed(2)}s` }
            : {}),
        },
      });
      source = p.video.orbit ? "preview" : "clip";
    } else if (p.photo) {
      const f = await upload(p.photo.path, p.photo.mime, files);
      parts.push({ fileData: { fileUri: f.uri!, mimeType: f.mimeType ?? p.photo.mime } });
      source = "photo";
    }
    const media = p.video
      ? p.video.orbit
        ? `The video is a 3D render of the person on black: a virtual camera circles them while their ${d}-second motion plays (looping if the video is longer). Times are seconds into the motion, 0 to ${d}.`
        : `The video is the ${d} seconds the person was rebuilt from. Time 0 is its first frame; step times run from 0 to ${d}.`
      : p.photo
        ? `The photo is all there is of this person: they can't perform a move, so the mode is companion, watch or play, with no steps.`
        : `There is no picture to look at: plan from the sentence alone. They can't perform a move, so no steps.`;
    const want = p.intent
      ? `What the user wants to do with this person: "${p.intent}".`
      : `The user didn't say what they want: choose teach if the clip shows a move someone could learn, otherwise watch.`;
    parts.push({ text: `The user calls this dream "${p.name}". ${want}\n${media}` });

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
    return { ...clean(JSON.parse(text), p), source, model };
  } finally {
    for (const f of files) ai().files.delete({ name: f.name! }).catch(() => {}); // don't leave people's clips on Google's side
  }
}

/** Upload and wait until Gemini can read it. It joins `keep` as soon as it exists, so it's always deleted. */
async function upload(path: string, mimeType: string, keep: GeminiFile[]): Promise<GeminiFile> {
  let file = await ai().files.upload({ file: path, config: { mimeType } });
  keep.push(file);
  const until = Date.now() + 180_000;
  while (file.state === FileState.PROCESSING) {
    if (Date.now() > until) throw new Error("Gemini took too long to process the upload");
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai().files.get({ name: file.name! });
  }
  if (file.state === FileState.FAILED || !file.uri) throw new Error("Gemini couldn't read the upload");
  keep[keep.length - 1] = file;
  return file;
}

async function retry<T>(attempts: number, call: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (i >= attempts || !/\b(500|INTERNAL|503|UNAVAILABLE|deadline|ETIMEDOUT|ECONNRESET)\b/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

/** Try each model in turn; move on only when a model is missing or unavailable, not when the request itself is bad. */
async function firstModel<T>(models: string[], call: (model: string) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const model of models.map((m) => m.trim()).filter(Boolean)) {
    try {
      return await call(model);
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/\b(404|NOT_FOUND|not found|not supported|UNAVAILABLE|503|500|INTERNAL|PERMISSION_DENIED|403)\b/i.test(msg)) throw e;
    }
  }
  throw last ?? new Error("no Gemini model configured");
}

/** Hold whatever the model returned to the contract: modes, places, steps inside the clip, sane speeds and repeats. */
function clean(raw: Record<string, unknown>, p: Plan): Omit<Experience, "createdAt" | "source" | "model"> {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const D = Math.max(p.durationS, 0.1);
  let mode = (["teach", "companion", "watch", "play"].includes(str(raw.mode)) ? str(raw.mode) : "watch") as ExperienceMode;
  const place = (["facing", "beside", "ahead"].includes(str(raw.place)) ? str(raw.place) : "facing") as Experience["place"];

  let steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s: Record<string, unknown>) => {
      const start = Math.round(Math.min(Math.max(Number(s?.start), 0), D) * 10) / 10;
      const end = Math.round(Math.min(Math.max(Number(s?.end), 0), D) * 10) / 10;
      const speed = Number(s?.speed);
      const repeat = Math.round(Number(s?.repeat));
      return {
        start,
        end,
        title: str(s?.title),
        tip: str(s?.tip) || undefined,
        speed: Number.isFinite(speed) ? Math.min(Math.max(speed, 0.25), 1) : 0.5,
        repeat: Number.isFinite(repeat) ? Math.min(Math.max(repeat, 1), 3) : 2,
      };
    })
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= 0.2 && s.title)
    .sort((a, b) => a.start - b.start)
    .slice(0, 6);
  for (let i = 0; i + 1 < steps.length; i++) steps[i].end = Math.min(steps[i].end, steps[i + 1].start); // no overlaps
  steps = steps.filter((s) => s.end - s.start >= 0.2);

  const still = !p.video; // a photo, or nothing: they can't perform a move
  if (mode === "teach" && (still || steps.length < 2)) mode = still ? "companion" : "watch";
  if (mode === "play" && p.kind !== "avatar") mode = "watch"; // chess needs a rigged avatar across the board
  const strength = (STRENGTHS as readonly string[]).includes(str(raw.strength)) ? (str(raw.strength) as Strength) : "club";
  const environment = (ENVIRONMENTS as readonly string[]).includes(str(raw.environment)) ? (str(raw.environment) as Environment) : undefined;
  const objects = [...new Set((Array.isArray(raw.objects) ? raw.objects : []).map((o) => str(o).toLowerCase()).filter((o) => /^[a-z][a-z -]{1,30}$/.test(o)))].slice(0, 4);

  return {
    intent: p.intent,
    mode,
    title: str(raw.title) || p.name,
    summary: str(raw.summary),
    place,
    ...(mode === "teach" ? { steps } : {}),
    ...(mode === "play" ? { play: { game: "chess" as const, strength } } : {}),
    ...(environment ? { environment } : {}),
    ...(objects.length ? { objects } : {}),
    category: str(raw.category) || undefined,
    durationS: p.durationS,
  };
}

/** What the realism check compares: the source (one photo, or the clip window) and the render of the rebuilt person. */
export interface Likeness {
  source: { photo: string } | { clip: string }; // a cleaned JPEG, or the trimmed clip the person was built from
  preview: string; // preview.mp4: the camera circles them once over its length
  moments: Record<RealismView, number>; // seconds in preview.mp4: front, three-quarter, profile
}

const REALISM_SYSTEM = `You review how real a 3D reconstruction of a person looks, for the team that built it. You \
compare the render with the source picture and list what gives the render away, so they can fix it.
Never identify, name or guess who the person is, even if they seem famous: judge likeness and render quality only. \
Parts of the person the source never showed (their back, the far side) were imagined by a model: judge those for \
realism, not for likeness. Be concrete and honest; don't soften a bad result.`;

const VIEWS = ["front", "three-quarter", "profile"] as const;
const REALISM_SCHEMA = {
  type: "object",
  properties: {
    samePerson: { type: "boolean", description: "Would someone who knows the person in the source say the render is them?" },
    confidence: { type: "number", description: "How sure you are of samePerson, 0 to 1." },
    summary: { type: "string", description: "One plain sentence on how real and how like them it looks, under 25 words." },
    defects: {
      type: "array",
      maxItems: 10,
      description: "Concrete defects, worst first. Empty when there are none.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...DEFECT_KINDS] },
          view: { type: "string", enum: [...VIEWS] },
          where: { type: "string", description: "Exactly where, from the person's point of view, e.g. 'left eye, inner corner', 'right hand, fingers', 'neck, collar line'." },
          severity: { type: "string", enum: ["minor", "noticeable", "severe"] },
          note: { type: "string", description: "One short sentence: what's wrong, e.g. 'Iris is grey and flat; the source shows brown eyes.'" },
        },
        required: ["kind", "view", "where", "severity", "note"],
      },
    },
  },
  required: ["samePerson", "confidence", "summary", "defects"],
};

/** Ask Gemini whether the render looks like the source, and what's wrong with it. Uploads are deleted afterwards. */
export async function checkLikeness(l: Likeness): Promise<Omit<Realism, "createdAt">> {
  const files: GeminiFile[] = [];
  try {
    const photo = "photo" in l.source;
    const src = photo
      ? await upload((l.source as { photo: string }).photo, "image/jpeg", files)
      : await upload((l.source as { clip: string }).clip, "video/mp4", files);
    const render = await upload(l.preview, "video/mp4", files);
    const t = (v: number) => `${v.toFixed(2)} s`;
    const parts: object[] = [
      { text: photo ? "The source: a photo of the person." : "The source: the video the person was rebuilt from." },
      { fileData: { fileUri: src.uri!, mimeType: src.mimeType ?? (photo ? "image/jpeg" : "video/mp4") } },
      { text: "The render: the rebuilt 3D person on black, while a virtual camera circles them once over the video." },
      { fileData: { fileUri: render.uri!, mimeType: render.mimeType ?? "video/mp4" }, videoMetadata: { fps: 4 } },
      {
        text:
          `Judge the render at three moments: the front view at ${t(l.moments.front)}, the three-quarter view at ` +
          `${t(l.moments["three-quarter"])} and the profile at ${t(l.moments.profile)}. Is it the same person as the ` +
          `source, and how sure are you? Then list the defects that make it look less real or less like them: eyes ` +
          `(glassy, misaligned, wrong colour), skin tone (shifted, patchy, not the source's), hairline, hands, seams ` +
          `(where parts meet, e.g. a line at the neck), floaters (stray blobs around the body), face shape, teeth, ` +
          `clothing. For each: the view, exactly where, how bad, and a short note.`,
      },
    ];
    const { text, model } = await firstModel(MODELS, (model) =>
      retry(2, () =>
        ai().models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: REALISM_SYSTEM,
            responseMimeType: "application/json",
            responseJsonSchema: REALISM_SCHEMA,
            httpOptions: { timeout: 180_000 },
          },
        }),
      ).then((r) => ({ text: r.text ?? "", model })),
    );
    return { ...cleanLikeness(JSON.parse(text)), source: photo ? "photo" : "clip", moments: l.moments, model };
  } finally {
    for (const f of files) ai().files.delete({ name: f.name! }).catch(() => {}); // nobody's photo stays on Google's side
  }
}

function cleanLikeness(raw: Record<string, unknown>): Pick<Realism, "samePerson" | "confidence" | "summary" | "defects"> {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const one = <T extends string>(v: unknown, of: readonly T[], or: T): T => ((of as readonly string[]).includes(str(v)) ? (str(v) as T) : or);
  const confidence = Number(raw.confidence);
  const defects: RealismDefect[] = (Array.isArray(raw.defects) ? raw.defects : [])
    .map((d: Record<string, unknown>) => ({
      kind: one(d?.kind, DEFECT_KINDS, "other"),
      view: one(d?.view, VIEWS, "front"),
      where: str(d?.where).slice(0, 80),
      severity: one(d?.severity, ["minor", "noticeable", "severe"] as const, "noticeable"),
      note: str(d?.note).slice(0, 200),
    }))
    .filter((d) => d.note)
    .slice(0, 10);
  return {
    samePerson: raw.samePerson === true,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
    summary: str(raw.summary).slice(0, 240),
    defects,
  };
}

/** Gemini's errors arrive as JSON blobs: say what happened in a sentence instead. */
export function humanError(e: unknown): string {
  const raw = String((e as Error)?.message ?? e);
  if (/API_KEY_INVALID|API key not valid/i.test(raw)) return "The Gemini key isn't valid. Check GEMINI_API_KEY in apps/web/.env.local.";
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(raw)) return "Gemini's quota is used up for now. It tries again in a few minutes.";
  if (/PERMISSION_DENIED|\b403\b/i.test(raw)) return "This Gemini key can't use the models the plan needs.";
  if (/timed? ?out|ETIMEDOUT|deadline/i.test(raw)) return "Gemini took too long. It tries again in a few minutes.";
  const msg = /"message":\s*"([^"]+)"/.exec(raw)?.[1] ?? raw;
  return msg.length > 200 ? msg.slice(0, 197) + "..." : msg;
}
