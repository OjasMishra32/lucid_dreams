import { ensureExperience } from "@/lib/bridge/experience";
import { json, preflight } from "@/lib/bridge/http";

/** GET /api/dreams/:id/experience -> { state: ready, experience } | { state: working } | { state: failed, message } | { state: off } */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return json(ensureExperience(id));
}

/** POST /api/dreams/:id/experience : write the plan again (after a prompt change, say). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return json(ensureExperience(id, { force: true }), 202);
}

export const OPTIONS = preflight;
