import { json, preflight } from "@/lib/bridge/http";
import { ensureRealism } from "@/lib/bridge/realism";

/**
 * GET /api/dreams/:id/realism -> { state: ready, realism, candidates? } | { state: working } | { state: failed, message }
 * | { state: off }. `candidates`: the dream and its head-swap bundles ("<id>-head", ...) that have been checked, best
 * first. Never for a private dream.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return json(ensureRealism(id));
}

/** POST /api/dreams/:id/realism : check again (still within the hourly cap). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return json(ensureRealism(id, { force: true }), 202);
}

export const OPTIONS = preflight;
