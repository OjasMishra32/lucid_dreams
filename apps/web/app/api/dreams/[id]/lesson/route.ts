import { lessonFile, lessonOf } from "@/lib/bridge/attempts";
import { CORS, preflight } from "@/lib/bridge/http";
import { sendFile } from "@/lib/bridge/sendFile";

/**
 * GET /api/dreams/:id/lesson : a lesson's teacher clip, the window the person was built from (cut on this Mac, no
 * location metadata), for "watch me try". Only for dreams whose plan is a lesson.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const l = lessonOf(id);
  const file = l && lessonFile(l.dream);
  if (!file) return new Response("Not found", { status: 404, headers: CORS });
  return sendFile(req, file, "video/mp4", "private, max-age=3600");
}

export const OPTIONS = preflight;
