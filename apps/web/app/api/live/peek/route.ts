import { readFileSync } from "node:fs";
import { CORS, preflight } from "@/lib/bridge/http";
import { peekFile } from "@/lib/bridge/liveRun";

export const dynamic = "force-dynamic";

/**
 * GET /api/live/peek?run=<id>&name=peek-000011.jpg&at=<seconds> : one truth-vs-render strip of a run (the real or imagined
 * view beside our render of it), fetched from HiPerGator the first time it's asked for and kept on this Mac. Its time
 * is in the address, so a newer strip is a new image and these never change. Never a private or held run.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const file = await peekFile(q.get("run") ?? "", q.get("name") ?? "", Number(q.get("at")));
  if (!file) return new Response("Not found", { status: 404, headers: CORS });
  return new Response(new Uint8Array(readFileSync(file)), {
    headers: { ...CORS, "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400, immutable" },
  });
}

export const OPTIONS = preflight;
