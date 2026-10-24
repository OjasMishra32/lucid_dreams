"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/format";
import { formatEta, type LiveGpus, type LivePeek, type LiveRun, type LiveStage, type LiveState } from "@/lib/dream";

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

const WHAT: Record<string, string> = {
  upload: "Your clip goes to the GPUs.",
  check: "One person, head to toe, camera still.",
  views: "4DAnyone imagines the person from every angle.",
  upscale: "Every view is sharpened.",
  reconstruct: "Gaussians are fitted to those views, frame by frame.",
  export: "The frames become a bundle your headset can play.",
};
const KIND_WORDS: Record<LivePeek["kind"], { title: string; how: string }> = {
  real: {
    title: "The real frame, beside our render",
    how: "Left: the frame from the clip. Right: our 3D render of the same moment, from the same camera.",
  },
  imagined: {
    title: "The imagined views, beside our render",
    how: "In each pair, left: a view 4DAnyone imagined. Right: our render of that view. Five viewpoints around the person.",
  },
};

/**
 * /live: one run as HiPerGator has it, refreshed every few seconds while it works. The stages with real timings, the GPUs
 * it holds, and the newest truth-vs-render strips (the check numbers can't make: you see the difference yourself).
 * Running times tick between refreshes. Calm: one accent colour, no charts.
 */
export default function LiveBoard({ initial, pinned }: { initial: LiveState; pinned: boolean }) {
  const [s, setS] = useState<LiveState>(initial);
  const [pin, setPin] = useState<string | null>(pinned ? (initial.run?.id ?? null) : null);
  const [now, setNow] = useState(() => Date.now());
  const [lost, setLost] = useState(false);
  const run = s.run;
  const working = !!run && (run.status.status === "running" || run.status.status === "queued");
  const current = useRef<string | null>(null);
  current.current = pin ?? run?.id ?? null;

  // Ask again every few seconds while it works, a little less often once it's over (a new run may start).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const q = new URLSearchParams();
        if (current.current) q.set("run", current.current);
        if (!pin) q.set("auto", "1");
        const r = await fetch(`/api/live/run?${q}`, { cache: "no-store" });
        if (r.ok && alive) {
          setS((await r.json()) as LiveState);
          setNow(Date.now());
          setLost(false);
        }
      } catch {
        if (alive) setLost(true); // the bridge restarting: keep what's on screen
      }
      if (alive) timer = setTimeout(tick, working ? 5000 : 15000);
    };
    timer = setTimeout(tick, pin ? 0 : working ? 5000 : 15000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pin, working]);

  // Running times tick every second between refreshes.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  function choose(id: string) {
    setPin(id);
    history.replaceState(null, "", `/live?run=${encodeURIComponent(id)}`);
  }

  if (!run) {
    return (
      <div className="wrap live">
        <header className="live-head">
          <p className="eyebrow">Live</p>
          <h1 className="page-title">Nothing is being made right now.</h1>
          <p className="live-message">Make a dream and watch it happen here: the stages, the GPUs and the real frame beside our render of it.</p>
        </header>
        <div className="job-actions">
          <a href="/#make" className="btn">Make a dream</a>
          <a href="/#scenes" className="more">Every scene</a>
        </div>
      </div>
    );
  }

  const sinceRead = working ? Math.max(0, (now - run.at) / 1000) : 0;
  const failed = run.status.status === "failed";
  const done = run.status.status === "done";
  const pct = Math.round(run.status.progress * 100);

  return (
    <div className="wrap live">
      <header className="live-head">
        <p className="eyebrow">
          {working ? <><span className="pulse" aria-hidden="true" /> Live from HiPerGator</> : done ? "Finished on HiPerGator" : failed ? "Stopped on HiPerGator" : "HiPerGator"}
        </p>
        <h1 className="page-title">{run.name}</h1>
        <p className="live-message" aria-live="polite">{failed ? run.status.message : done ? "They're ready to stand in your room." : run.status.message}</p>

        <div className={failed ? "bar failed" : "bar"} role="progressbar" aria-label="Progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.max(1.5, run.status.progress * 100)}%` }} />
        </div>
        <div className="job-foot">
          <span>{pct}%{run.elapsedS != null ? ` · ${formatDuration(run.elapsedS + sinceRead)} so far` : ""}</span>
          <span>{working ? formatEta(run.status.etaS) : ""}</span>
        </div>
        {lost && <p className="note" role="status">Reconnecting to the bridge. Showing the last thing it said.</p>}

        {s.choices.length > 1 && (
          <label className="live-pick">
            <span>Run</span>
            <select value={run.id} onChange={(e) => choose(e.target.value)}>
              {s.choices.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.live ? " (working)" : ""}</option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="live-grid">
        <section aria-labelledby="live-stages">
          <h2 id="live-stages" className="row-title">The stages</h2>
          <ol className="live-stages">
            {run.stages.map((st) => (
              <StageRow key={st.stage} st={st} run={run} extra={sinceRead} />
            ))}
          </ol>
        </section>

        <section aria-labelledby="live-gpus">
          <h2 id="live-gpus" className="row-title">The GPUs</h2>
          <Gpus run={run} />
        </section>
      </div>

      <section aria-labelledby="live-strips" className="live-strips">
        <h2 id="live-strips" className="row-title">Truth beside render</h2>
        {run.peeks.length > 0 ? (
          run.peeks.map((p) => <Strip key={p.url} p={p} />)
        ) : (
          <p className="note">
            {run.source === "hpg"
              ? run.kind === "avatar"
                ? "A photo has no other frames to compare with, so there are no strips for this one."
                : "The first strip appears once the reconstruction has fitted its first frame."
              : "This page isn't connected to HiPerGator, so it can show the stage and progress only."}
          </p>
        )}
      </section>

      <p className="live-foot">
        {run.source === "hpg"
          ? "Read from HiPerGator every few seconds: the real job, the real GPUs and the real renders. Nothing here is staged."
          : "Showing the job's own progress. Timings, GPUs and strips come from HiPerGator when the bridge is connected to it."}
      </p>
    </div>
  );
}

function StageRow({ st, run, extra }: { st: LiveStage; run: LiveRun; extra: number }) {
  const k = st.state === "done" ? "done" : st.state === "failed" ? "bad" : st.state === "running" ? "now" : "";
  const gpus = run.gpus.find((g) => g.stage === st.stage);
  const secs = st.durationS == null ? null : st.state === "running" ? st.durationS + extra : st.durationS;
  const frames = st.stage === "reconstruct" && run.frames && st.state !== "pending" ? run.frames : null;
  const detail = [
    st.state === "running" ? WHAT[st.stage] : null,
    frames ? `Frame ${frames.done} of ${frames.total}` : null,
    gpus && st.state === "running" && gpus.running > 0 ? `${gpus.running} ${gpus.type} GPU${gpus.running === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return (
    <li className={k} aria-current={st.state === "running" ? "step" : undefined}>
      <span className="stage-dot">
        {k === "done" ? CHECK : k === "bad" ? CROSS : k === "now" ? <span className="pulse" /> : <span className="idle" />}
      </span>
      <span className="live-stage-main">
        <b>{st.label}</b>
        {detail.length > 0 && <span>{detail.join(" · ")}</span>}
        {frames && (
          <span
            className="live-frames"
            role="progressbar"
            aria-label="Frames reconstructed"
            aria-valuenow={frames.done}
            aria-valuemin={0}
            aria-valuemax={frames.total}
          >
            <span style={{ width: `${(frames.done / frames.total) * 100}%` }} />
          </span>
        )}
      </span>
      <span className="live-time num">
        <span className="sr-only">{st.state === "pending" ? "Not started" : st.state === "running" ? "So far " : st.state === "failed" ? "Failed after " : "Took "}</span>
        {secs != null ? formatDuration(secs) : st.state === "pending" ? "" : st.state === "done" ? "Done" : ""}
      </span>
    </li>
  );
}

function Gpus({ run }: { run: LiveRun }) {
  if (run.source !== "hpg") return <p className="note">Which GPUs a run holds comes from HiPerGator, which this page isn&apos;t connected to.</p>;
  const running = run.gpus.reduce((n, g) => n + g.running, 0);
  const waiting = run.gpus.reduce((n, g) => n + g.waiting, 0);
  if (running + waiting === 0) {
    return <p className="note">{run.status.status === "done" ? "Every GPU has been given back." : "No GPU is held right now."}</p>;
  }
  const types = [...new Set(run.gpus.filter((g) => g.running > 0).map((g) => g.type))];
  return (
    <>
      <div className="facts live-facts">
        <div className="fact">
          <b className="num">{running}</b>
          <span>{running === 1 ? "GPU working" : "GPUs working"}{types.length ? ` · ${types.join(", ")}` : ""}</span>
        </div>
        <div className="fact">
          <b className="num">{waiting}</b>
          <span>waiting their turn</span>
        </div>
      </div>
      <ul className="live-gpu-list">
        {run.gpus.map((g) => (
          <GpuLine key={g.stage} g={g} />
        ))}
      </ul>
    </>
  );
}

function GpuLine({ g }: { g: LiveGpus }) {
  return (
    <li>
      <b>{g.label}</b>
      <span>
        {g.running > 0 ? `${g.running} working on ${g.type}` : ""}
        {g.running > 0 && g.waiting > 0 ? ", " : ""}
        {g.waiting > 0 ? `${g.waiting} waiting` : ""}
      </span>
    </li>
  );
}

function Strip({ p }: { p: LivePeek }) {
  const w = KIND_WORDS[p.kind];
  return (
    <figure className="live-strip">
      <figcaption>
        <b>{w.title}</b>
        <span>{w.how} Frame {p.frame}.</span>
      </figcaption>
      <div className={`live-strip-scroll ${p.kind}`} role="group" aria-label={`${w.title}, scrolls sideways`} tabIndex={0}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={p.url} alt={`${w.how} Frame ${p.frame}.`} loading="lazy" decoding="async" />
      </div>
    </figure>
  );
}
