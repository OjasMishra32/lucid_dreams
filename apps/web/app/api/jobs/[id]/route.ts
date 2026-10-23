import { jobStatus } from "@/lib/bridge";
import { json, preflight } from "@/lib/bridge/http";

/** GET /api/jobs/:id -> { id, status, stage, progress, etaS, message } */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const status = await jobStatus(id);
  if (!status) return json({ error: `No job called ${id}` }, 404);
  return json(status);
}

export const OPTIONS = preflight;
