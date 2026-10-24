import { ensureGuide } from "@/lib/bridge/guide";
import { json, preflight } from "@/lib/bridge/http";

/** GET /api/dreams/:id/guide -> { state: ready, guide } | { state: working } | { state: failed, message } | { state: off } */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return json(ensureGuide(id));
}

/** POST /api/dreams/:id/guide : write it again (after a prompt change, say). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return json(ensureGuide(id, { force: true }), 202);
}

export const OPTIONS = preflight;
