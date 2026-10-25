import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
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
/** A family's dream: one whose dream.json says "private": true, or an ian-grandma* run not marked "private": false. */
function privateId(id: string): boolean {
  const meta = resolve(DREAMS_DIR, id, "dream.json");
  let flag: boolean | null = null;
  try {
    const v = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")).private : null;
    flag = typeof v === "boolean" ? v : null;
  } catch {
    flag = true; // unreadable: assume the worst
  }
  return isPrivate({ id, private: flag });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  // a private dream is never served over HTTP, not its files, not even its name in the index: this bridge can be
  // reached through a tunnel (and Next marks every request as forwarded, so local can't be told apart). The headset
  // gets a family's dream over USB (adb push, team/ian.md)
  if (path.length === 1 && path[0] === "index.json") {
    return json(listReady(undefined, { withPrivate: false })); // for players
  }
  if (privateId(path[0] ?? "")) return new Response("Not found", { status: 404, headers: CORS });
  // in the cloud the bundles' files live on a static host (LUCID_DREAMS_REMOTE, e.g. https://x.pages.dev/xr/dreams);
  // only their dream.json and plans are deployed with the site
  const remote = process.env.LUCID_DREAMS_REMOTE;
  if (remote && !/\.json$/.test(path[path.length - 1] ?? "")) {
    return new Response(null, {
      status: 302,
      headers: { ...CORS, Location: `${remote}/${path.map(encodeURIComponent).join("/")}${new URL(req.url).search}` },
    });
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
    // files that change in place (the plan is added later and can be rewritten; captions arrive late): never cache.
    // The pages ask for media with ?v=<when the bundle was last rebuilt>, so those addresses never go stale.
    "Cache-Control": /(^|\/)(dream|experience|captions)\.[a-z0-9]+$/.test(file)
      ? "no-store"
      : new URL(req.url).searchParams.has("v")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
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
    // a piece of a file is never cached: Safari opens every video by asking for bytes 0-1, and the public link's edge
    // cache once kept that 2-byte piece and handed it to everyone as the whole preview
    return new Response(stream(file, start, end), {
      status: 206,
      headers: {
        ...headers,
        "Cache-Control": "no-store",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(stream(file, 0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
}

function stream(file: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
}

export const OPTIONS = preflight;
