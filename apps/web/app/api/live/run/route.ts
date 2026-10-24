import { json, preflight } from "@/lib/bridge/http";
import { liveState } from "@/lib/bridge/liveRun";

export const dynamic = "force-dynamic";

/**
 * GET /api/live/run?run=<id>&auto=1 -> { run: LiveRun | null, choices: [{ id, name, live }] }: one run's stages, timings,
 * GPUs and latest truth-vs-render strips, as HiPerGator has them now. Without `run`, the one working now (else the
 * newest); with `auto`, a finished `run` gives way to one that has started since. Never a private or held run.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  return json(await liveState(q.get("run"), q.get("auto") === "1"));
}

export const OPTIONS = preflight;
