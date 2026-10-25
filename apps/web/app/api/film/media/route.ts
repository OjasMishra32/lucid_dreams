import { createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";

// The film's raw material for the page that renders it (app/film): a clip, a select or a source photo from
// ~/Downloads/lucid-video, by path inside it (?p=selects/guitar-appear.mp4), with byte ranges so a video can be seeked
// frame by frame. Development only: the live site serves nothing from this folder.

export const dynamic = "force-dynamic";

const ROOT = join(homedir(), "Downloads", "lucid-video");
const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });
  const p = new URL(req.url).searchParams.get("p") ?? "";
  const file = normalize(join(ROOT, p));
  const type = TYPES[extname(file).toLowerCase()];
  if (!type || !file.startsWith(ROOT + sep)) return new Response("not here", { status: 404 });
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return new Response("not here", { status: 404 });
  }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  if (!range) {
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, { headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: { "Content-Type": type, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" },
  });
}
