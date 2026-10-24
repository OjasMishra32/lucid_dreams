import "server-only";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { CORS } from "./http";

/** A file on this Mac as a response, honouring Range (Safari and the Quest won't seek a video without it). */
export function sendFile(req: Request, file: string, type: string, cache = "no-store"): Response {
  const size = statSync(file).size;
  const headers: Record<string, string> = { ...CORS, "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cache };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
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
