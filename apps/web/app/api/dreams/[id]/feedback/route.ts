import Busboy from "busboy";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { DATA_DIR } from "@/lib/bridge/dreams";
import { FeedbackError, MAX_ATTEMPT_BYTES, feedbackState, gate, giveFeedback } from "@/lib/bridge/feedback";
import { json, preflight } from "@/lib/bridge/http";

let uploading = 0; // recordings being received right now: a few at a time, each within two minutes

export const dynamic = "force-dynamic"; // on or off is the running bridge's answer, never baked in at build time

/** GET /api/dreams/:id/feedback -> { state: "ready", feedback } | { state: "none" } | { state: "off" }. Never for a private or held dream. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return json(feedbackState(id));
}

/**
 * POST /api/dreams/:id/feedback, multipart: `attempt` (the recording: WebM, MP4 or MOV), `durationS` (how long it is)
 * -> 200 { state: "ready", feedback } or { error } in a sentence. The recording streams to a temp file, goes to Gemini
 * once, and is gone (here and there) before this answers; only the notes stay.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Another website open on this Wi-Fi can fire a form post here (CORS is open for the headset): only this page may.
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return json({ error: "Record on the dream's own page." }, 403);
  const no = gate(id); // a private or held dream's upload is never even read
  if (no) return json({ error: no.message }, no.status);
  if (Number(req.headers.get("content-length")) > MAX_ATTEMPT_BYTES + 4096) return json({ error: "That recording is too big. Try a shorter one." }, 413);
  if (uploading >= 2) return json({ error: "Other recordings are arriving. Try again in a moment." }, 429);
  if (!req.body || !req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return json({ error: "Send multipart/form-data with attempt and durationS." }, 400);
  }
  const dir = join(DATA_DIR, "tmp", `upload-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  uploading++;
  const path = join(dir, "attempt.bin");
  const fields: Record<string, string> = {};
  let tooBig = false;
  let got = false;
  let broken = false;
  const writes: Promise<void>[] = [];
  try {
    const bb = Busboy({ headers: Object.fromEntries(req.headers), limits: { files: 1, fileSize: MAX_ATTEMPT_BYTES, fields: 4 } });
    bb.on("field", (k, v) => (fields[k] = v));
    bb.on("file", (field, stream) => {
      if (field !== "attempt" || got) return stream.resume();
      got = true;
      stream.on("limit", () => (tooBig = true));
      writes.push(pipeline(stream, createWriteStream(path)).catch(() => void (broken = true)));
    });
    await pipeline(Readable.fromWeb(req.body as unknown as NodeReadableStream), bb, { signal: AbortSignal.timeout(120_000) });
    await Promise.all(writes);
    if (broken) throw new Error("write failed");
    if (!got) return json({ error: "Add your recording." }, 400);
    if (tooBig) return json({ error: "That recording is too big. Try a shorter one." }, 400);
    const feedback = await giveFeedback(id, { path, durationS: Number(fields.durationS) });
    return json({ state: "ready", feedback });
  } catch (e) {
    if (e instanceof FeedbackError) return json({ error: e.message }, e.status);
    return json({ error: "The upload was interrupted. Try again." }, 400);
  } finally {
    uploading--;
    rmSync(dir, { recursive: true, force: true }); // the learner's video never outlives the request
  }
}

export const OPTIONS = preflight;
