import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { DREAMS_DIR, listReady } from "@/lib/bridge/dreams";
import { isPrivate } from "@/lib/dream";
import { CORS, json, preflight } from "@/lib/bridge/http";

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".vtt": "text/vtt; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".spz": "application/octet-stream",
  ".ply": "application/octet-stream",
};

/**
 * GET /dreams/<id>/... : the bundle's files, static. Honours Range so previews seek on Safari and the Quest, and big
 * frame files can resume. /dreams/index.json mirrors the WebXR viewer's index, so it can point ?base= here too.
 */
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path.length === 1 && path[0] === "index.json") {
    return json(listReady(undefined, { withPrivate: true }).map((d) => (isPrivate(d) ? { ...d, private: true } : d))); // for players
  }

  const file = resolve(DREAMS_DIR, ...path);
  if (!file.startsWith(DREAMS_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return new Response("Not found", { status: 404, headers: CORS });
  }

  const size = statSync(file).size;
  const headers: Record<string, string> = {
    ...CORS,
    "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    // files that change in place (the plan is added later and can be rewritten; captions arrive late): never cache
    "Cache-Control": /(^|\/)(dream|experience|captions)\.[a-z0-9]+$/.test(file) ? "no-store" : "public, max-age=3600",
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    return new Response(stream(file, start, end), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(stream(file, 0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
}

function stream(file: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
}

export const OPTIONS = preflight;
