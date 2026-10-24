import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DREAMS_DIR, REPO, isRunId } from "./dreams";

// Runs this bridge didn't start: lucid_runner.py by hand, or the autopilot. lucid_runner lists every run it submits
// in dreams/.runs.json (a JSON list of run ids); the queue file names the ones Ojasva queued.

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // not there yet, or mid-write
  }
}

/** Every run id lucid_runner.py has submitted from this Mac, oldest first. */
export function submittedRuns(): string[] {
  const ids = readJson(join(DREAMS_DIR, ".runs.json"));
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && isRunId(id)) : [];
}

/** A run's name for people: the queue's name when Ojasva gave one, else the id without its timestamp. */
export function runName(id: string): string {
  const queue = readJson(join(REPO, "pipeline", "runner", "queue.json"));
  if (Array.isArray(queue)) {
    const hit = queue.find((q) => q && q.id === id && typeof q.name === "string");
    if (hit) return hit.name;
  }
  const words = id.replace(/-\d{4}-\d{6}(?:-\d+)?$/, "").split(/[-_.]+/).filter(Boolean);
  return words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : id;
}

/** When a run was submitted, from the -MMDD-HHMMSS that lucid_runner and the bridge put on generated ids; else null. */
export function runSubmittedAt(id: string): number | null {
  const m = /-(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(id);
  if (!m) return null;
  const [mo, d, h, mi, s] = m.slice(1).map(Number);
  const now = new Date();
  const t = new Date(now.getFullYear(), mo - 1, d, h, mi, s).getTime();
  if (Number.isNaN(t)) return null;
  return t > now.getTime() + 86400_000 ? new Date(now.getFullYear() - 1, mo - 1, d, h, mi, s).getTime() : t;
}
