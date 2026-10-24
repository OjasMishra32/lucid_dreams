"use client";

import Link from "next/link";
import { STAGE_LABELS, STAGES, formatEta, type JobKind, type JobStatus, type Stage } from "@/lib/dream";
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

/** What to do when a run stops: by what went wrong, so it never contradicts the runner's message shown above it. */
function nextStep(s: JobStatus): { text: string; again: boolean } {
  const m = s.message.toLowerCase();
  if (m.includes("copied back")) {
    return { text: "Nothing is lost: the dream is finished on HiPerGator and appears in your library once it's copied over.", again: false };
  }
  if (m.includes("cut off") || m.includes("never sent")) return { text: "Nothing reached the GPUs, so nothing is lost. Make it again.", again: true };
  if (s.stage === "upload") return { text: "The clip never reached the GPUs. Once HiPerGator is back, make it again.", again: true };
  if (s.stage === "check") return { text: "The clip didn't pass the checks: one person, head to toe, camera still, at least 5 seconds.", again: true };
  if (m.includes("on it")) return { text: "Ojasva has the logs. If it was the clip, one person, full body and a still camera work best.", again: true };
  if (s.stage === "views") {
    return { text: "4DAnyone couldn't imagine the other angles. One person, full body, a plain background and a still camera work best.", again: true };
  }
  return { text: "Something broke on the GPUs, not in your clip. Try again in a few minutes.", again: true };
}

export default function JobProgress({ id, name, kind, initial }: { id: string; name: string; kind: JobKind; initial: JobStatus }) {
  const s = useJob(id, initial) ?? initial;
  const done = s.status === "done";
  const failed = s.status === "failed";
  const current = STAGES.indexOf(s.stage);
  // upscale is skipped while the pipeline has it off (listed only once it is actually the stage);
  // avatars come from one photo, so there are no other angles to imagine
  const stages = STAGES.filter((st) => (st !== "upscale" || s.stage === "upscale") && !(kind === "avatar" && st === "views"));

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
      {failed && <p className="job-next">{nextStep(s).text}</p>}

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
          {nextStep(s).again && <Link href="/new" className="btn">Make it again</Link>}
          <Link href="/library" className={nextStep(s).again ? "more" : "btn"}>Back to the library</Link>
        </div>
      ) : (
        <p className="job-note">
          {kind === "avatar" ? "This takes a few minutes on the GPUs." : "This takes about half an hour on the GPUs."} You can
          close this page: the dream appears in your library when it&apos;s ready.{" "}
          <Link href={`/live?id=${encodeURIComponent(id)}`} className="more">Watch it on the GPUs</Link>
        </p>
      )}
    </div>
  );
}
