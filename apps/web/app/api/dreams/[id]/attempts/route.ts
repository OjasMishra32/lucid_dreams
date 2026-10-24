import Busboy from "busboy";
import { createWriteStream, statSync } from "node:fs";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { attemptsView, busy, dropAttempt, hiddenDream, lessonOf, newAttempt, startAttempt } from "@/lib/bridge/attempts";
import { readDream } from "@/lib/bridge/dreams";
import { ownJson as json } from "@/lib/bridge/http";

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".webm", ".3gp"]);
const BY_TYPE: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v", "video/webm": ".webm", "video/3gpp": ".3gp" };
const MAX_BYTES = 2 * 1024 ** 3;

type Ctx = { params: Promise<{ id: string }> };

function notALesson(id: string): Response {
  const d = readDream(id);
  return d && !hiddenDream(d)
    ? json({ error: "Watch me try works on lessons, and this dream's plan isn't one (yet)." }, 409)
    : json({ error: "No such dream." }, 404);
}

/**
 * GET /api/dreams/:id/attempts -> { gemini, lesson, attempts }: the lesson clip and every try, newest first. Tries are
 * the learner's own videos, so these replies are for this web app's pages only (no CORS).
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const l = lessonOf(id);
  if (!l) return notALesson(id);
  return json(attemptsView(l.dream, l.experience));
}

/**
 * POST /api/dreams/:id/attempts, multipart: file (the learner's try, a video), optional durationS (as the browser
 * measured it) -> 202 the try, being prepared. The file streams to disk, never into memory.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const l = lessonOf(id);
  if (!l) return notALesson(id);
  if (busy()) return json({ error: "A few tries are already waiting for Gemini. Send this one in a minute." }, 429);
  if (!req.body || !req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return json({ error: "Send multipart/form-data with the video as file." }, 400);
  }

  const { id: tryId, dir } = newAttempt(l.dream.id);
  const fields: Record<string, string> = {};
  let file: { name: string; ext: string } | null = null;
  let tooBig = false;
  let broken = false;
  const writes: Promise<void>[] = [];
  try {
    const bb = Busboy({ headers: Object.fromEntries(req.headers), limits: { files: 1, fileSize: MAX_BYTES, fields: 4 } });
    bb.on("field", (k, v) => (fields[k] = v));
    bb.on("file", (field, stream, info) => {
      if (field !== "file" || file) return stream.resume();
      const ext = extname(info.filename ?? "").toLowerCase() || BY_TYPE[(info.mimeType ?? "").split(";")[0]] || "";
      file = { name: `input${VIDEO.has(ext) ? ext : ".bin"}`, ext };
      stream.on("limit", () => (tooBig = true));
      writes.push(pipeline(stream, createWriteStream(join(dir, file.name))).catch(() => void (broken = true)));
    });
    await pipeline(Readable.fromWeb(req.body as unknown as NodeReadableStream), bb);
    await Promise.all(writes);
    if (broken) throw new Error("write failed");
  } catch {
    dropAttempt(l.dream.id, tryId);
    return json({ error: "The upload was interrupted. Try again." }, 400);
  }

  const fail = (error: string) => {
    dropAttempt(l.dream.id, tryId);
    return json({ error }, 400);
  };
  const f = file as { name: string; ext: string } | null;
  if (!f || statSync(/*turbopackIgnore: true*/ join(dir, f.name)).size === 0) return fail("Add a video of your try.");
  if (tooBig) return fail("That video is over 2 GB. Film just your try: 20 seconds is plenty.");
  if (!VIDEO.has(f.ext)) return fail("Use a video (MP4, MOV or WebM).");
  const hint = Number(fields.durationS);
  return json(startAttempt(l.dream.id, tryId, f.name, Number.isFinite(hint) && hint > 0 ? hint : null), 202);
}
