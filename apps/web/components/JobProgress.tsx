"use client";

import Link from "next/link";
import { STAGE_LABELS, STAGES, formatEta, type JobStatus, type Stage } from "@/lib/dream";
import { useJob } from "@/lib/useJob";

const CHECK = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const CROSS = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export default function JobProgress({ id, name, initial }: { id: string; name: string; initial: JobStatus }) {
  const s = useJob(id, initial) ?? initial;
  const done = s.status === "done";
  const failed = s.status === "failed";
  const current = STAGES.indexOf(s.stage);
  // upscale is skipped while the pipeline has it off; only list it once it is actually the stage
  const stages = STAGES.filter((st) => st !== "upscale" || s.stage === "upscale");

  function state(st: Stage): "done" | "now" | "bad" | "" {
    const i = STAGES.indexOf(st);
    if (done || i < current) return "done";
    if (i === current) return failed ? "bad" : s.status === "queued" ? "" : "now";
    return "";
  }

  return (
    <div className="job">
      <p className="eyebrow">{done ? "Ready" : failed ? "Stopped" : "Making a dream"}</p>
      <h1 className="page-title">{name}</h1>
      <p className="job-message" aria-live="polite">
        {done ? "They're ready to stand in your room." : s.message}
      </p>

      <div className={failed ? "bar failed" : "bar"} role="progressbar" aria-valuenow={Math.round(s.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.max(1.5, s.progress * 100)}%` }} />
      </div>
      <div className="job-foot">
        <span>{Math.round(s.progress * 100)}%</span>
        <span>{done || failed ? "" : formatEta(s.etaS)}</span>
      </div>

      <ol className="stages">
        {stages.map((st) => {
          const k = state(st);
          return (
            <li key={st} className={k}>
              <span className="stage-dot">
                {k === "done" ? CHECK : k === "bad" ? CROSS : k === "now" ? <span className="pulse" /> : <span className="idle" />}
              </span>
              {STAGE_LABELS[st]}
            </li>
          );
        })}
      </ol>

      {done ? (
        <div className="job-actions">
          <Link href={`/library/${encodeURIComponent(id)}`} className="btn">Meet them</Link>
        </div>
      ) : failed ? (
        <div className="job-actions">
          <Link href="/new" className="btn">Try another clip</Link>
          <Link href="/library" className="more">Back to the library</Link>
        </div>
      ) : (
        <p className="job-note">
          This takes about half an hour on the GPUs. You can close this page: the dream appears in your library when it's ready.
        </p>
      )}
    </div>
  );
}
