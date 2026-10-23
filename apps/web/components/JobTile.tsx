"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { formatEta, type JobStatus } from "@/lib/dream";
import { useJob } from "@/lib/useJob";

export default function JobTile({ id, name, initial }: { id: string; name: string; initial: JobStatus }) {
  const status = useJob(id, initial, 3000) ?? initial;
  const router = useRouter();
  useEffect(() => {
    if (status.status === "done") router.refresh(); // it moves into the library
  }, [status.status, router]);
  const failed = status.status === "failed";
  return (
    <Link href={`/jobs/${encodeURIComponent(id)}`} className="job-tile">
      <h3>{name}</h3>
      <p>{failed ? status.message : status.message || "Waiting for a GPU"}</p>
      <div className={failed ? "bar failed" : "bar"}>
        <span style={{ width: `${Math.max(2, status.progress * 100)}%` }} />
      </div>
      <div className="job-foot">
        <span>{Math.round(status.progress * 100)}%</span>
        <span>{failed ? "Stopped" : formatEta(status.etaS)}</span>
      </div>
    </Link>
  );
}
