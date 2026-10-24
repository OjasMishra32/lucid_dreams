import { listDreams } from "@/lib/bridge/dreams";
import { json, preflight } from "@/lib/bridge/http";

/** GET /api/dreams -> every bundle's dream.json, newest first. */
export async function GET() {
  return json(listDreams());
}

export const OPTIONS = preflight;
