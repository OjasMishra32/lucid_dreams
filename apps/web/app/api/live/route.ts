import { json, preflight } from "@/lib/bridge/http";
import { liveReply } from "@/lib/bridge/live";

/**
 * GET /api/live?id=<run>[&follow=1] -> LiveReply (lib/live.ts): a run's stages with real timings, the GPUs on it and
 * its latest fitted frame. No id: the newest run still building, else the newest run. follow=1: a finished run gives
 * way to the newest one still building.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  return json(await liveReply(q.get("id") || null, q.get("follow") === "1"));
}

export const OPTIONS = preflight;
