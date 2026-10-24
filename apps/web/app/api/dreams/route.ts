import { listDreams, listReady } from "@/lib/bridge/dreams";
import { isPrivate } from "@/lib/dream";
import { tend } from "@/lib/bridge";
import { json, preflight } from "@/lib/bridge/http";

/**
 * GET /api/dreams -> every complete bundle's dream.json, newest first (the Quest library polls this). Private ones
 * (a family's) are included for the headset, carrying `"private": true` so players can keep them out of anything shared.
 */
export async function GET() {
  const dreams = listDreams();
  tend(dreams); // sees half-arrived ones too, to finish them
  return json(listReady(dreams, { withPrivate: true }).map((d) => (isPrivate(d) ? { ...d, private: true } : d)));
}

export const OPTIONS = preflight;
