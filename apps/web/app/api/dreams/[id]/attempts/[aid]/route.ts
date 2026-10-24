import { busy, deleteAttempt, getAttempt, lessonOf, retryAttempt } from "@/lib/bridge/attempts";
import { json, preflight } from "@/lib/bridge/http";

type Ctx = { params: Promise<{ id: string; aid: string }> };

/** GET /api/dreams/:id/attempts/:aid -> the try: working (preparing, watching), ready with notes, failed, or off. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id, aid } = await ctx.params;
  const a = getAttempt(id, aid);
  return a ? json(a) : json({ error: "No such try." }, 404);
}

/** POST /api/dreams/:id/attempts/:aid : ask Gemini again (after a failure, or once a key is in). */
export async function POST(_req: Request, ctx: Ctx) {
  const { id, aid } = await ctx.params;
  if (!lessonOf(id)) return json({ error: "This dream isn't a lesson any more." }, 409);
  if (busy()) return json({ error: "A few tries are already waiting for Gemini. Ask again in a minute." }, 429);
  const a = retryAttempt(id, aid);
  return a ? json(a, 202) : json({ error: "No such try." }, 404);
}

/** DELETE /api/dreams/:id/attempts/:aid : the try's video and notes, gone from this Mac. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, aid } = await ctx.params;
  if (deleteAttempt(id, aid)) return new Response(null, { status: 204 });
  return getAttempt(id, aid)
    ? json({ error: "Gemini is watching this try right now. Delete it in a moment." }, 409)
    : json({ error: "No such try." }, 404);
}

export const OPTIONS = preflight;
