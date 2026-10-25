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
const MAX_PHOTOS = 10;

/**
 * POST /api/jobs, multipart: file, name, kind, optional startS and intent -> { id }. Files stream to disk, never into
 * memory. An avatar may send up to ten photos of one person as repeated `file` fields: the first builds the body, the
 * rest go to the face model, saved in faces/ beside it (.data/uploads/<uuid>/faces/face-01.jpg, ...).
 */
export async function POST(req: Request) {
  // the website in the cloud (~/LucidDreams-held/cloud-web.sh) has no connection to HiPerGator
  if (process.env.LUCID_CLOUD) {
    return json({ error: "Making a new dream needs our HiPerGator connection, and it isn't on right now." }, 503);
  }
  if (!req.body || !req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return json({ error: "Send multipart/form-data with file, name and kind." }, 400);
  }

  const dir = join(DATA_DIR, "uploads", randomUUID());
  mkdirSync(dir, { recursive: true });
  const fields: Record<string, string> = {};
  const files: { path: string; name: string; ext: string }[] = [];
  let tooBig = false;
  let tooMany = false;
  let broken = false;
  const writes: Promise<void>[] = [];

  try {
    const bb = Busboy({ headers: Object.fromEntries(req.headers), limits: { files: MAX_PHOTOS, fileSize: MAX_BYTES, fields: 8 } });
    bb.on("field", (k, v) => (fields[k] = v));
    bb.on("filesLimit", () => (tooMany = true));
    bb.on("file", (field, stream, info) => {
      if (field !== "file") return stream.resume();
      const filename = info.filename ?? "";
      // the extension only from a known list: it becomes part of a path on this Mac
      const raw = extname(filename).toLowerCase();
      const ext = VIDEO.has(raw) || PHOTO.has(raw) ? raw : ".bin";
      const n = files.length;
      if (n === 1) mkdirSync(join(dir, "faces"));
      const path = n === 0 ? join(dir, `input${ext}`) : join(dir, "faces", `face-${String(n).padStart(2, "0")}${ext}`);
      files.push({ path, name: filename, ext: raw });
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
  const [f, ...faces] = files;
  const name = (fields.name ?? "").trim().slice(0, 80);
  const kind = fields.kind;
  if (tooMany) return fail(`Up to ${MAX_PHOTOS} photos of one person.`); // first: busboy stops reading at the limit
  if (!f || statSync(/*turbopackIgnore: true*/ f.path).size === 0) return fail("Add a video or a photo.");
  if (tooBig) return fail("That file is over 8 GB. Trim it to the move you want.");
  if (!VIDEO.has(f.ext) && !PHOTO.has(f.ext)) return fail("Use a video (MP4, MOV) or a photo (JPG, PNG).");
  if (!name) return fail("Give the dream a name.");
  if (!isKind(kind)) return fail('kind must be "replay" or "avatar".');
  if (PHOTO.has(f.ext) && kind === "replay") return fail("A photo can only become an avatar. Replays need a video.");
  if (VIDEO.has(f.ext) && kind === "avatar") return fail("Avatars start from photos. Use a photo, or make this video a replay.");
  if (faces.length && kind === "replay") return fail("A replay starts from one video.");
  if (faces.some((x) => !PHOTO.has(x.ext) || statSync(/*turbopackIgnore: true*/ x.path).size === 0)) {
    return fail("Every extra file has to be a photo of the same person (JPG, PNG, HEIC).");
  }
  const startS = fields.startS ? Number(fields.startS) : 0;
  // films and long home videos are welcome: the window can start anywhere in the first six hours
  if (!Number.isFinite(startS) || startS < 0) return fail("startS is where the 5 seconds start, in seconds from the beginning of the clip.");
  if (startS > 6 * 3600) return fail("Choose 5 seconds within the first six hours of the clip.");

  const intent = (fields.intent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const job = createJob({
    id: newJobId(name), name, kind, file: f.path, fileName: f.name, startS: PHOTO.has(f.ext) ? 0 : startS,
    ...(intent ? { intent } : {}),
    ...(faces.length ? { faces: faces.map((x) => x.path) } : {}),
  });
  return json({ id: job.id }, 201);
}

export const OPTIONS = preflight;
