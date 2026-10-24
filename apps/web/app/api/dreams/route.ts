import { listDreams, listReady } from "@/lib/bridge/dreams";
import { tend } from "@/lib/bridge";
import { json, preflight } from "@/lib/bridge/http";

/** GET /api/dreams -> every complete bundle's dream.json, newest first (the Quest library polls this). */
export async function GET() {
  const dreams = listDreams();
  tend(dreams); // sees half-arrived ones too, to finish them
  return json(listReady(dreams));
}

export const OPTIONS = preflight;
