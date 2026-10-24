import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";
import type { Experience } from "../dream";
import { DREAMS_DIR, isRunId } from "./dreams";
import { humanError } from "./gemini";

// The coach in the lesson (Gemini Live). The WebXR viewer talks to Gemini directly over a WebSocket, so the key never
// leaves this Mac: the bridge mints a short-lived, single-use ephemeral token locked to one Live model and one config,
// with the step on screen written into its system instruction. The viewer only ever sees that token.

// Live models in order of preference; a model Google doesn't know is skipped here, one that can't reply in text there.
const MODELS = (process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live,gemini-3.1-flash-live-preview")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
// Text replies, read by the device's own voice. A model that only speaks gets audio + its transcript, and the viewer
// reads the transcript and drops the audio: answers are never heard in any voice but the device's.
const REPLIES = [Modality.TEXT, Modality.AUDIO] as const;
export const ATTEMPTS = MODELS.length * REPLIES.length;
const SESSION_MS = 5 * 60_000; // messages in a session are refused after this
const CONNECT_MS = 60_000; // the token has to open its session within a minute

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  // ephemeral tokens exist in v1alpha only
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1alpha" } });
  return client;
}

/** What the learner is looking at when they press Ask. */
export interface CoachContext {
  dream: string | null;
  plan: { title: string; intent: string; category: string };
  step: { index: number; count: number; title: string; tip: string; start: number; end: number; speed: number | null };
  at: number | null; // where in the clip the teacher was paused when they asked
}

export interface LiveToken {
  token: string;
  model: string;
  reply: "text" | "audio";
  attempt: number;
  attempts: number;
  expiresAt: string;
}

/**
 * The request body as the coach's context, or null when it doesn't name a step. Everything is trimmed and bounded;
 * when the dream's own experience.json has this step, its words are used instead of the viewer's.
 */
export function readContext(body: unknown): CoachContext | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const plan = (b.plan && typeof b.plan === "object" ? b.plan : {}) as Record<string, unknown>;
  const index = Math.round(num(b.index, 0, 49) ?? -1);
  const count = Math.round(num(b.count, 1, 50) ?? 0);
  const start = num(b.start, 0, 3600);
  const end = num(b.end, 0, 3600);
  const title = text(b.title, 80);
  if (index < 0 || index >= count || start == null || end == null || end <= start || !title) return null;
  const dream = typeof b.dream === "string" && isRunId(b.dream) ? b.dream : null;
  const ctx: CoachContext = {
    dream,
    plan: { title: text(plan.title, 80), intent: text(plan.intent, 200), category: "" },
    step: { index, count, title, tip: text(b.tip, 240), start, end, speed: num(b.speed, 0.1, 2) },
    at: num(b.at, 0, 3600),
  };
  const planned = dream ? readPlan(dream) : null;
  const step = planned?.steps?.[index];
  if (planned && step && text(step.title, 80) === title) {
    // the bridge's own plan for this dream: the viewer only chose which step
    ctx.plan = { title: text(planned.title, 80), intent: text(planned.intent, 200), category: text(planned.category, 40) };
    ctx.step = { ...ctx.step, tip: text(step.tip, 240), start: step.start, end: step.end, speed: step.speed ?? ctx.step.speed };
  }
  return ctx;
}

function readPlan(id: string): Experience | null {
  const p = join(DREAMS_DIR, id, "experience.json");
  if (!existsSync(p)) return null;
  try {
    const e = JSON.parse(readFileSync(p, "utf8")) as Experience;
    return e?.mode === "teach" && Array.isArray(e.steps) ? e : null;
  } catch {
    return null;
  }
}

/** What the coach knows and how it talks. Written here, locked into the token: the viewer can't change it. */
export function instruction(c: CoachContext): string {
  const s = (t: number) => `${Number(t.toFixed(2))} s`; // 1.6 s, 0.08 s
  const { plan, step } = c;
  const lesson = [
    plan.title ? `The lesson is ${quote(plan.title)}` : "This is a movement lesson",
    plan.intent ? `, from what the learner asked for: ${quote(plan.intent)}` : "",
    plan.category ? ` (${plan.category})` : "",
    ".",
  ].join("");
  const onScreen = [
    `On screen now: step ${step.index + 1} of ${step.count}, ${quote(step.title)}, the part of the clip from ${s(step.start)} to ${s(step.end)}`,
    step.speed && step.speed < 1 ? `, played at ${step.speed}x speed` : "",
    ".",
    step.tip ? ` Its tip: ${quote(/[.!?]$/.test(step.tip) ? step.tip : `${step.tip}.`)}` : "",
    c.at != null ? ` The learner paused the teacher at ${s(c.at)} to ask.` : "",
  ].join("");
  return [
    "You are the coach inside a lesson. A teacher, rebuilt life size in 3D from a video, stands in the learner's room and plays a move slowed down, one step at a time; after each step it's the learner's turn to copy it.",
    lesson,
    onScreen,
    'The learner asks you questions out loud about this step. Answer about this step and this moment of the move, in one to three short sentences to them as "you", with one concrete body cue: where the weight, the joint or the hand goes, and what it should feel like.',
    "Your words are read aloud by the device's own voice: plain spoken sentences only, no lists, no markdown, no emoji.",
    "If you didn't catch the question, ask them to say it again in a few words. If it isn't about the lesson, answer in one sentence and bring them back to the step.",
    "You can't see the learner, so never say you can; if they ask how they look, tell them what to check.",
    "Never identify, name or guess who the teacher is, even if they seem famous, and never speak as them or say you are them.",
    "If they mention pain, dizziness or an injury, tell them to stop and rest, and to see a professional if it doesn't pass.",
  ].join("\n");
}

/**
 * One ephemeral token for one coach session, starting at `attempt` on the ladder (model x reply mode). Models Google
 * doesn't know are skipped here; the viewer moves down the ladder itself when a model won't take the reply mode.
 */
export async function mintToken(ctx: CoachContext, attempt: number): Promise<LiveToken> {
  let last: unknown = null;
  for (let a = Math.max(0, Math.min(attempt, ATTEMPTS - 1)); a < ATTEMPTS; a += REPLIES.length) {
    const model = MODELS[Math.floor(a / REPLIES.length)];
    const reply = REPLIES[a % REPLIES.length];
    const config: LiveConnectConfig = {
      responseModalities: [reply],
      systemInstruction: instruction(ctx),
      temperature: 0.5,
      inputAudioTranscription: {}, // the viewer shows what it heard
      ...(reply === Modality.AUDIO ? { outputAudioTranscription: {} } : {}),
      // a learner thinks mid-sentence ("how should my wrist... be here?"): don't answer at the first pause
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 800 } },
    };
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_MS).toISOString();
    try {
      const token = await ai().authTokens.create({
        config: {
          uses: 1,
          expireTime: expiresAt,
          newSessionExpireTime: new Date(now + CONNECT_MS).toISOString(),
          // no lockAdditionalFields: every field of the session is the one set here, whatever the viewer sends
          liveConnectConstraints: { model, config },
          httpOptions: { timeout: 15_000 },
        },
      });
      if (!token.name) throw new Error("Gemini didn't return a token");
      return { token: token.name, model, reply: reply === Modality.TEXT ? "text" : "audio", attempt: a, attempts: ATTEMPTS, expiresAt };
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/\b(404|NOT_FOUND|not found|not supported)\b/i.test(msg)) throw e; // a bad key or quota: no other model helps
    }
  }
  throw last ?? new Error("no Gemini Live model configured");
}

/** Gemini's error as one sentence for the learner's screen. */
export function coachError(e: unknown): string {
  const msg = humanError(e);
  return /\b(404|NOT_FOUND|not found)\b/i.test(msg) ? "None of the Gemini Live models answered. Set GEMINI_LIVE_MODEL on the bridge." : msg;
}

// ---------------- rate limit: a few sessions a minute per device, a ceiling per hour for the Mac ----------------

const PER_DEVICE = { n: 8, ms: 60_000 }; // one question plus a fallback or two, several times a minute
const PER_HOUR = { n: 120, ms: 3600_000 };
type Hits = { device: Map<string, number[]>; all: number[] };
const g = globalThis as unknown as { __lucidLiveHits?: Hits };
const hits: Hits = (g.__lucidLiveHits ??= { device: new Map(), all: [] });

/** Counts one token for `who`; says how long to wait when it's one too many. */
export function allow(who: string, now = Date.now()): { ok: true } | { ok: false; retryS: number } {
  for (const [k, v] of hits.device) {
    const kept = v.filter((t) => now - t < PER_DEVICE.ms);
    if (kept.length) hits.device.set(k, kept);
    else hits.device.delete(k);
  }
  hits.all = hits.all.filter((t) => now - t < PER_HOUR.ms);
  const mine = hits.device.get(who) ?? [];
  if (mine.length >= PER_DEVICE.n) return { ok: false, retryS: Math.ceil((PER_DEVICE.ms - (now - mine[0])) / 1000) };
  if (hits.all.length >= PER_HOUR.n) return { ok: false, retryS: Math.ceil((PER_HOUR.ms - (now - hits.all[0])) / 1000) };
  mine.push(now);
  hits.device.set(who, mine);
  hits.all.push(now);
  return { ok: true };
}

function text(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : null;
}

function quote(s: string): string {
  return `"${s.replace(/"/g, "'")}"`;
}
