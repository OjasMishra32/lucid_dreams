"use client";

import { useEffect, useState } from "react";
import type { JobStatus } from "./dream";

/** Polls GET /api/jobs/:id until the job is done or failed. */
export function useJob(id: string, initial: JobStatus | null, everyMs = 2000): JobStatus | null {
  const [status, setStatus] = useState<JobStatus | null>(initial);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (r.ok && alive) {
          const s = (await r.json()) as JobStatus;
          setStatus(s);
          if (s.status === "done" || s.status === "failed") return;
        }
      } catch {
        // the bridge restarting: keep the last state and try again
      }
      if (alive) timer = setTimeout(tick, everyMs);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, everyMs]);
  return status;
}
