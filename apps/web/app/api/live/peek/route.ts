import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { peekPath } from "@/lib/bridge/live";

/** GET /api/live/peek?id=<run>&f=peek-<frame>.jpg: a run's latest fitted frame, once it's been copied from HiPerGator. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const path = peekPath(q.get("id") ?? "", q.get("f") ?? "");
  if (!path) return new Response("Not found", { status: 404 });
  return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(statSync(path).size),
      // the page asks with ?v=<when it was written>, so one address is always one picture
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}
