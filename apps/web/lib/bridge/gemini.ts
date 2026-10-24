import "server-only";
import { FileState, GoogleGenAI, Modality, type File as GeminiFile } from "@google/genai";
import type { Guide } from "../dream";

// Gemini, the guide: watches the clip, names the move, splits it into timed steps, and talks you through it.
// Models are tried in order, so a renamed or unavailable model never takes the guide down.
const MODELS = (process.env.GEMINI_MODEL ?? "gemini-3.8-flash,gemini-3.6-flash,gemini-3-flash-preview").split(",");
const TTS_MODELS = (process.env.GEMINI_TTS_MODEL ?? "gemini-3.8-flash-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts").split(",");
const VOICE = process.env.GEMINI_VOICE ?? "Sulafat"; // warm, unhurried
const FPS = 15; // frames per second Gemini sees: enough for a jump shot's release (default is 1)

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

/**
 * What Gemini watches. The source footage is best for understanding the move; preview.mp4 is the clock everything
 * plays on (the frames, the headset, the dream page). The pipeline may resample time, so step times are read off the
 * preview whenever there is one.
 */
export interface Watch {
  durationS: number; // the motion's length: step times land in [0, durationS]
  source?: { path: string; offsetS: number }; // the original footage; offsetS is where the window starts in it
  clock?: { path: string }; // preview.mp4
}

const SYSTEM = `You are the movement coach inside Lucid Dreams, an app that turns a short video of a person into a \
life-size 3D person you can walk around and learn from. You watch one short clip of one person doing one move and \
write a calm, precise guide that helps someone learn it.
Speak to the learner as "you". Refer to the person in the clip only as "they". Never identify, name or guess who the \
person is, even if they seem famous, and never speak as them. Describe only what is visible. Use plain, short words, \
like a great coach on the sideline.`;

const SCHEMA = {
  type: "object",
  properties: {
    move: { type: "string", description: "The move's common name, 1 to 4 words, e.g. 'Step-back jumper' or 'Box step'. If it has no common name, a plain description." },
    category: { type: "string", description: "The activity, 1 or 2 words, e.g. 'Basketball', 'Salsa', 'Golf', 'Yoga'." },
    summary: { type: "string", description: "One sentence, under 20 words: what the move is and what makes it work." },
    steps: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          t: { type: "number", description: "When this step begins, in seconds from the start of the video, one decimal." },
          title: { type: "string", description: "1 to 3 words, e.g. 'Load', 'Step back', 'Release'." },
          cue: { type: "string", description: "One coaching cue, under 10 words, in the imperative, e.g. 'Sink the hips, eyes on the rim'." },
        },
        required: ["t", "title", "cue"],
      },
    },
    tips: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", description: "One sentence, under 15 words." } },
    narration: {
      type: "string",
      description: "What the coach says out loud, 60 to 80 words: name the move, walk through the steps in order by their titles, end with the key tip. Plain sentences, no lists, no timestamps, no names.",
    },
  },
  required: ["move", "category", "summary", "steps", "tips", "narration"],
};

/** Upload the video, ask for the guide, validate it. Returns everything but the audio. */
export async function writeGuide(w: Watch): Promise<Omit<Guide, "audio" | "createdAt">> {
  if (!w.source && !w.clock) throw new Error("nothing to watch");
  const files: GeminiFile[] = [];
  try {
    const d = w.durationS.toFixed(2);
    const part = (f: GeminiFile, offsetS = 0) => ({
      fileData: { fileUri: f.uri!, mimeType: f.mimeType ?? "video/mp4" },
      videoMetadata: {
        fps: FPS,
        ...(offsetS > 0 ? { startOffset: `${offsetS.toFixed(2)}s`, endOffset: `${(offsetS + w.durationS + 0.5).toFixed(2)}s` } : {}),
      },
    });
    const task = `Name the move, split it into 3 to 6 steps in the order they happen, each with the second it begins`;
    const rest = `add 2 or 3 tips, and write the narration.`;
    const parts: object[] = [];
    if (w.source && w.clock) {
      await upload(w.source.path, files); // one after the other, each kept for clean-up the moment Google has it
      await upload(w.clock.path, files);
      parts.push(part(files[0], w.source.offsetS), part(files[1]), {
        text:
          `Video 1 is the original footage of the move. Video 2 is the same person rebuilt in 3D on a black background: ` +
          `a virtual camera circles them while the motion plays on its own clock (${d} seconds, looping if the video ` +
          `is longer). Use video 1 to understand the move and video 2 for timing. ${task} on video 2's clock (0 to ${d}), ${rest}`,
      });
    } else if (w.source) {
      await upload(w.source.path, files);
      parts.push(part(files[0], w.source.offsetS), {
        text: `This clip shows the ${d} seconds that were rebuilt in 3D. ${task} (0 to ${d}), ${rest}`,
      });
    } else {
      await upload(w.clock!.path, files);
      parts.push(part(files[0]), {
        text:
          `This video is a 3D reconstruction of a person on a black background: a virtual camera circles them once ` +
          `while their ${d}-second motion plays (it loops if the video is longer). ${task} in the motion (0 to ${d}), ${rest}`,
      });
    }
    const { text, model } = await firstModel(MODELS, (model) =>
      ai().models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: SYSTEM,
          responseMimeType: "application/json",
          responseJsonSchema: SCHEMA,
          httpOptions: { timeout: 180_000 },
        },
      }).then((r) => ({ text: r.text ?? "", model })),
    );
    return { ...clean(JSON.parse(text), w), source: w.source ? "clip" : "preview", model };
  } finally {
    for (const f of files) ai().files.delete({ name: f.name! }).catch(() => {}); // don't leave people's clips on Google's side
  }
}

/** The narration as 16-bit mono WAV. */
export async function speak(narration: string): Promise<Buffer> {
  // TTS models now and then answer with text or nothing (a 500, or no audio part): try again before giving up
  const { b64, mime } = await retry(3, () => firstModel(TTS_MODELS, (model) =>
    ai().models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: `Say this like a calm, encouraging coach, unhurried and warm:\n\n${narration}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        httpOptions: { timeout: 120_000 },
      },
    }).then((r) => {
      const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new Error("no audio in the reply");
      return { b64: part.inlineData.data, mime: part.inlineData.mimeType ?? "" };
    }),
  ));
  const audio = Buffer.from(b64, "base64");
  if (audio.subarray(0, 4).toString("ascii") === "RIFF") return audio; // already a WAV
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000); // raw 16-bit PCM, e.g. audio/L16;codec=pcm;rate=24000
  return wav(audio, rate);
}

/** Upload a video and wait until Gemini can watch it. It joins `keep` as soon as it exists, so it's always deleted. */
async function upload(path: string, keep: GeminiFile[]): Promise<GeminiFile> {
  let file = await ai().files.upload({ file: path, config: { mimeType: "video/mp4" } });
  keep.push(file);
  const until = Date.now() + 180_000;
  while (file.state === FileState.PROCESSING) {
    if (Date.now() > until) throw new Error("Gemini took too long to process the video");
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai().files.get({ name: file.name! });
  }
  if (file.state === FileState.FAILED || !file.uri) throw new Error("Gemini couldn't read the video");
  keep[keep.length - 1] = file;
  return file;
}

async function retry<T>(attempts: number, call: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (i >= attempts || /API_KEY_INVALID|PERMISSION_DENIED|INVALID_ARGUMENT/.test(msg)) throw e;
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
      if (!/\b(404|NOT_FOUND|not found|not supported|UNAVAILABLE|503|500|INTERNAL|PERMISSION_DENIED|403)\b|no audio/i.test(msg)) throw e;
    }
  }
  throw last ?? new Error("no Gemini model configured");
}

/** Keep the guide inside the motion's clock and the copy inside the design, whatever the model returned. */
function clean(raw: Record<string, unknown>, w: Watch): Omit<Guide, "audio" | "createdAt" | "source" | "model"> {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  let steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s: Record<string, unknown>) => ({ t: Number(s?.t), title: str(s?.title), cue: str(s?.cue) }))
    .filter((s) => Number.isFinite(s.t) && s.title);
  // Timed off an untrimmed source? A model that answers in the file's own clock gets moved back into the window.
  const offset = !w.clock && w.source ? w.source.offsetS : 0;
  if (offset > 0 && steps.length && steps.every((s) => s.t >= offset - 0.5) && steps.some((s) => s.t > w.durationS + 0.5)) {
    steps = steps.map((s) => ({ ...s, t: s.t - offset }));
  }
  steps = steps
    .map((s) => ({ ...s, t: Math.round(Math.min(Math.max(s.t, 0), Math.max(w.durationS - 0.05, 0)) * 10) / 10 }))
    .sort((a, b) => a.t - b.t)
    .slice(0, 6);
  const tips = (Array.isArray(raw.tips) ? raw.tips : []).map(str).filter(Boolean).slice(0, 3);
  const move = str(raw.move);
  const narration = str(raw.narration);
  if (!move || steps.length < 2 || !narration) throw new Error("Gemini's guide was incomplete");
  return { move, category: str(raw.category), summary: str(raw.summary), steps, tips, narration };
}

/** Gemini's errors arrive as JSON blobs: say what happened in a sentence instead. */
export function humanError(e: unknown): string {
  const raw = String((e as Error)?.message ?? e);
  if (/API_KEY_INVALID|API key not valid/i.test(raw)) return "The Gemini key isn't valid. Check GEMINI_API_KEY in apps/web/.env.local.";
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(raw)) return "Gemini's quota is used up for now. The guide tries again in a few minutes.";
  if (/PERMISSION_DENIED|\b403\b/i.test(raw)) return "This Gemini key can't use the guide's models.";
  if (/timed? ?out|ETIMEDOUT|deadline/i.test(raw)) return "Gemini took too long. The guide tries again in a few minutes.";
  const msg = /"message":\s*"([^"]+)"/.exec(raw)?.[1] ?? raw;
  return msg.length > 200 ? msg.slice(0, 197) + "..." : msg;
}

function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
