import { readFileSync } from "node:fs";
import { peekPath } from "@/lib/bridge/live";

/** GET /api/live/peek?id=<run>&f=peek-<frame>.jpg: a run's latest fitted frame, once it's been copied from HiPerGator. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const path = peekPath(q.get("id") ?? "", q.get("f") ?? "");
  let body: Buffer;
  try {
    // read whole (a strip is a few hundred KB): a newer strip replaces this one on disk at any moment
    body = path ? readFileSync(path) : Buffer.alloc(0);
  } catch {
    body = Buffer.alloc(0);
  }
  if (!body.length) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(body.length),
      // the page asks with ?v=<when it was written>, so one address is always one picture; a person's views, so no
      // shared caches
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
