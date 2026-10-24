import "server-only";

// Bundles being copied back from HiPerGator right now. Shared by the runner (which starts the copies) and the guide
// (which must not start on a half-arrived bundle): rsync lands dream.json first and preview.mp4 after it.
export type Fetch = { state: "running" | "failed"; tries: number; at?: number; error?: string };

const g = globalThis as unknown as { __lucidFetches?: Map<string, Fetch> };
export const fetches: Map<string, Fetch> = (g.__lucidFetches ??= new Map());

export function fetching(id: string): boolean {
  return fetches.get(id)?.state === "running";
}
