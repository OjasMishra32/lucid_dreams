import { attemptVideo } from "@/lib/bridge/attempts";
import { CORS, preflight } from "@/lib/bridge/http";
import { sendFile } from "@/lib/bridge/sendFile";

/** GET /api/dreams/:id/attempts/:aid/video : the try as this Mac re-encoded it, with Range. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await ctx.params;
  const v = attemptVideo(id, aid);
  if (!v) return new Response("Not found", { status: 404, headers: CORS });
  return sendFile(req, v.path, v.mime);
}

export const OPTIONS = preflight;
