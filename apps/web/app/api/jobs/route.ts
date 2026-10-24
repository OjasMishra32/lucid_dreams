import Busboy from "busboy";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createJob, isKind, newJobId } from "@/lib/bridge";
import { DATA_DIR } from "@/lib/bridge/dreams";
import { json, preflight } from "@/lib/bridge/http";

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const PHOTO = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const MAX_BYTES = 8 * 1024 ** 3;

/** POST /api/jobs, multipart: file, name, kind, optional startS -> { id }. The file streams to disk, never into memory. */
export async function POST(req: Request) {
  if (!req.body || !req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return json({ error: "Send multipart/form-data with file, name and kind." }, 400);
  }

  const dir = join(DATA_DIR, "uploads", randomUUID());
  mkdirSync(dir, { recursive: true });
  const fields: Record<string, string> = {};
  let file: { path: string; name: string; ext: string } | null = null;
  let tooBig = false;
  let broken = false;
  const writes: Promise<void>[] = [];

  try {
    const bb = Busboy({ headers: Object.fromEntries(req.headers), limits: { files: 1, fileSize: MAX_BYTES, fields: 8 } });
    bb.on("field", (k, v) => (fields[k] = v));
    bb.on("file", (field, stream, info) => {
      if (field !== "file" || file) return stream.resume();
      const filename = info.filename ?? "";
      const ext = extname(filename).toLowerCase();
      const path = join(dir, `input${ext}`);
      file = { path, name: filename, ext };
      stream.on("limit", () => (tooBig = true));
      writes.push(pipeline(stream, createWriteStream(path)).catch(() => void (broken = true)));
    });
    await pipeline(Readable.fromWeb(req.body as unknown as NodeReadableStream), bb);
    await Promise.all(writes);
    if (broken) throw new Error("write failed");
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return json({ error: "The upload was interrupted. Try again." }, 400);
  }

  const fail = (error: string) => {
    rmSync(dir, { recursive: true, force: true });
    return json({ error }, 400);
  };
  const f = file as { path: string; name: string; ext: string } | null;
  const name = (fields.name ?? "").trim().slice(0, 80);
  const kind = fields.kind;
  if (!f || statSync(/*turbopackIgnore: true*/ f.path).size === 0) return fail("Add a video or a photo.");
  if (tooBig) return fail("That file is over 8 GB. Trim it to the move you want.");
  if (!VIDEO.has(f.ext) && !PHOTO.has(f.ext)) return fail("Use a video (MP4, MOV) or a photo (JPG, PNG).");
  if (!name) return fail("Give the dream a name.");
  if (!isKind(kind)) return fail('kind must be "replay" or "avatar".');
  if (PHOTO.has(f.ext) && kind === "replay") return fail("A photo can only become an avatar. Replays need a video.");
  if (VIDEO.has(f.ext) && kind === "avatar") return fail("Avatars start from one photo. Use a photo, or make this video a replay.");
  const startS = fields.startS ? Number(fields.startS) : 0;
  if (!Number.isFinite(startS) || startS < 0 || startS > 3600) return fail("startS is where the 5 seconds start, in seconds (0 or more).");

  const job = createJob({ id: newJobId(name), name, kind, file: f.path, fileName: f.name, startS: PHOTO.has(f.ext) ? 0 : startS });
  return json({ id: job.id }, 201);
}

export const OPTIONS = preflight;
