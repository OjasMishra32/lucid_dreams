"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { STAGE_LABELS } from "@/lib/dream";
import { clock, span, type LivePeek, type LiveReply, type LiveRun, type LiveStage } from "@/lib/live";

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
const SAID: Record<LiveStage["state"], string> = { done: "Done", running: "Now", queued: "Next, waiting for a GPU", failed: "Stopped", waiting: "Still to come" };

/**
 * /live: one run, refreshed in place every few seconds (the stage clocks tick every second in between). With `want`
 * it's that run; without, it follows the newest run still building.
 */
export default function LivePipeline({ initial, want }: { initial: LiveReply; want: string | null }) {
  const [reply, setReply] = useState(initial);
  const [now, setNow] = useState(initial.now);
  const latest = useRef(initial);
  const offset = useRef(0); // the bridge's clock minus this device's: every time on the page is the bridge's

  useEffect(() => {
    offset.current = initial.now - Date.now();
    const t = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(t);
  }, [initial.now]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      if (document.visibilityState === "visible") {
        try {
          const q = new URLSearchParams();
          const id = want ?? latest.current.run?.id;
          if (id) q.set("id", id);
          if (!want) q.set("follow", "1");
          const r = await fetch(`/api/live?${q}`, { cache: "no-store" });
          if (r.ok && alive) {
            const next = (await r.json()) as LiveReply;
            latest.current = next;
            offset.current = next.now - Date.now();
            setReply(next);
            setNow(next.now);
          }
        } catch {
          // the bridge restarting: keep what's on screen and ask again
        }
      }
      if (alive) timer = setTimeout(ask, latest.current.refreshS * 1000);
    };
    timer = setTimeout(ask, initial.refreshS * 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [want, initial.refreshS]);

  // the laptop on the demo table stays awake while this is open
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const keepAwake = () => {
      if (document.visibilityState === "visible") navigator.wakeLock?.request("screen").then((l) => (lock = l), () => {});
    };
    keepAwake();
    document.addEventListener("visibilitychange", keepAwake);
    return () => {
      document.removeEventListener("visibilitychange", keepAwake);
      lock?.release().catch(() => {});
    };
  }, []);

  if (!reply.run) return <Nothing reason={reply.reason} />;
  return <Run run={reply.run} now={now} />;
}

function Run({ run, now }: { run: LiveRun; now: number }) {
  const building = run.state === "running" || run.state === "queued";
  const total = run.startedAt ? (run.endedAt ?? now) - run.startedAt : null;
  const rec = run.stages.find((s) => s.stage === "reconstruct");
  const eyebrow = run.demo ? "Demo run on this Mac" : building ? "Live from HiPerGator" : run.state === "done" ? "Made on HiPerGator" : "On HiPerGator";

  return (
    <div className="wrap live">
      <header className="live-head">
        <div className="live-name">
          <p className="live-eyebrow">
            {building && !run.stale && !run.idle && <span className="live-dot" aria-hidden="true" />}
            {eyebrow}
          </p>
          <h1 className="live-title">{run.name}</h1>
          <p className="live-message" aria-live="polite">
            {run.state === "done" && run.ready ? "They're ready to stand in your room." : run.message}
          </p>
          {run.ready && (
            <Link href={`/library/${encodeURIComponent(run.id)}`} className="btn">Meet them</Link>
          )}
        </div>
        <div className="live-stats">
          {total !== null && (
            <Stat value={clock(total)} label={building ? "so far" : run.state === "done" ? "start to finish" : "before it stopped"} />
          )}
          <GpuStat run={run} rec={rec} />
        </div>
      </header>

      <div className="live-body">
        <ol className="live-stages">
          {run.stages.map((s) => (
            <StageRow key={s.stage} s={s} run={run} now={now} />
          ))}
        </ol>
        <Look run={run} total={rec?.frames?.total ?? null} />
      </div>

      <p className="live-foot">
        <span>{freshness(run, now)}</span>
        <span className="live-id">{run.id}</span>
      </p>
    </div>
  );
}

function Stat({ value, label, sub }: { value: string; label: string; sub?: string[] }) {
  return (
    <div className="live-stat">
      <b className="num">{value}</b>
      <span>{label}</span>
      {sub?.filter(Boolean).map((line) => (
        <span key={line} className="live-stat-sub">{line}</span>
      ))}
    </div>
  );
}

/** How many GPUs are on it now (or, once it's done, how many it ran on at once). Nothing for a demo run. */
function GpuStat({ run, rec }: { run: LiveRun; rec?: LiveStage }) {
  if (run.demo) return null;
  const building = run.state === "running" || run.state === "queued";
  if (building && run.gpus) {
    const n = run.gpus.run.reduce((k, m) => k + m.count, 0);
    return (
      <Stat
        value={String(n)}
        label={`${n === 1 ? "GPU" : "GPUs"} on it ${run.stale ? "when last heard" : "now"}`}
        sub={[
          run.idle ? "Nothing of it is on the GPUs or in the queue" : run.gpus.run.map((m) => `${m.count} ${m.model}`).join(" · "),
          run.gpus.waiting ? `${run.gpus.waiting} more waiting in the queue` : "",
          `${run.gpus.lab} busy across the lab`,
        ]}
      />
    );
  }
  if (run.state === "done" && rec?.gpus) {
    return <Stat value={String(rec.gpus)} label="GPUs at once" sub={["All back with the lab now"]} />;
  }
  return null;
}

function StageRow({ s, run, now }: { s: LiveStage; run: LiveRun; now: number }) {
  let time = "";
  if (s.startedAt !== null) {
    if (s.state === "running" || s.state === "queued") time = clock(now - s.startedAt);
    else if ((s.state === "done" || s.state === "failed") && s.endedAt !== null) time = clock(s.endedAt - s.startedAt);
  }
  const facts = factsOf(s);
  return (
    <li className={`live-stage ${s.state}`}>
      <span className="stage-dot">
        {s.state === "done" ? CHECK : s.state === "failed" ? CROSS : s.state === "running" ? <span className="pulse" /> : s.state === "queued" ? <span className="ring" /> : <span className="idle" />}
      </span>
      <span className="live-stage-text">
        <b>{STAGE_LABELS[s.stage]}</b>
        <span className="sr-only">{SAID[s.state]}. </span>
        <span className="live-what">{whatItIs(s, run)}</span>
        {facts && <span className="live-facts">{facts}</span>}
      </span>
      <span className="live-time num">{time}</span>
    </li>
  );
}

/** What the stage is, for someone who's never seen the pipeline. */
function whatItIs(s: LiveStage, run: LiveRun): string {
  switch (s.stage) {
    case "upload":
      return run.demo ? "The clip, onto this Mac" : "The clip, sent to HiPerGator";
    case "check":
      return "One person, head to toe, a still camera";
    case "views":
      return s.views ? `4DAnyone turns one video into ${s.views} synced views` : "4DAnyone turns one video into views from every side";
    case "upscale":
      return "Every view sharpened";
    case "reconstruct":
      return run.kind === "avatar" ? "DiGS-Avatar: a rigged, photoreal person from one photo" : "4D Gaussians, fitted frame by frame";
    case "export":
      return "Placed, compressed and packed for your room";
  }
}

function factsOf(s: LiveStage): string {
  const parts: string[] = [];
  if (s.state === "queued") parts.push("Waiting for a GPU");
  if (s.frames && s.state === "running") parts.push(`${s.frames.done} of ${s.frames.total} frames`);
  if (s.frames && s.state === "done") parts.push(`${s.frames.total} frames`);
  if (s.gpus) parts.push(s.state === "done" ? `${s.gpus} GPUs at once` : `on ${s.gpus} ${s.gpus === 1 ? "GPU" : "GPUs"}`);
  if (s.waitedS) parts.push(`after ${span(s.waitedS)} in the queue`);
  if (s.state === "failed") parts.push("Stopped here");
  return parts.join(" · ");
}

function freshness(run: LiveRun, now: number): string {
  if (run.demo) return "On HiPerGator a run takes about half an hour; a demo run is sped up.";
  if (run.stale) {
    return run.heardAt ? `HiPerGator isn't answering. This is what it said ${span((now - run.heardAt) / 1000)} ago` : "Reconnecting to HiPerGator";
  }
  return run.heardAt ? `From HiPerGator ${Math.max(0, Math.round((now - run.heardAt) / 1000))} s ago` : "";
}

/** The right-hand side: the latest fitted frame, else an honest stand-in. Never a made-up fit. */
function Look({ run, total }: { run: LiveRun; total: number | null }) {
  if (run.peek) return <Fit peek={run.peek} total={total} />;
  if (run.thumb) {
    return (
      <figure className="live-look">
        <div className="live-thumb">
          <img src={run.thumb} alt={run.demo ? "The sample bundle's thumbnail" : `${run.name}, finished`} />
        </div>
        <figcaption>
          {run.demo
            ? "A demo run walks the real stages on this Mac, without GPUs, and the sample bundle stands in for the result. On HiPerGator, each fitted frame shows here as it's made: 4DAnyone's view beside our 3D render."
            : "The finished dream."}
        </figcaption>
      </figure>
    );
  }
  const text = run.demo
    ? "A demo run walks the real stages on this Mac, without GPUs. On HiPerGator, each fitted frame shows here as it's made."
    : run.kind === "avatar"
      ? "An avatar is built from one photo, so there are no frames to fit one by one."
      : run.state === "done" || run.state === "failed"
        ? "This run kept no fitted frames to show."
        : "The first fitted frame shows here a few minutes after they start being built in 3D.";
  return (
    <div className="live-look">
      <div className="live-blank">
        <p>{text}</p>
      </div>
    </div>
  );
}

/**
 * recon.py's strip is one JPEG of pairs side by side (4DAnyone's view | our render, per camera). Each pair is cropped
 * out of it with CSS; the large one cycles through them slowly. A new strip replaces the old one only once it has
 * loaded, so the picture never blanks.
 */
function Fit({ peek, total }: { peek: LivePeek; total: number | null }) {
  const [shown, setShown] = useState(peek);
  const [pick, setPick] = useState(0);
  const [chosen, setChosen] = useState(false);

  useEffect(() => {
    if (peek.url === shown.url) return;
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setShown(peek);
    img.src = peek.url;
    return () => {
      alive = false;
    };
  }, [peek, shown.url]);

  const n = Math.max(1, Math.round(shown.pairs));
  const looksRight = shown.width / n / shown.height > 0.2 && shown.width / n / shown.height < 5;
  const pairs = looksRight ? n : 1; // a strip that doesn't split evenly is shown whole
  const aspect = shown.width / pairs / shown.height;

  useEffect(() => {
    if (chosen || pairs < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setPick((p) => (p + 1) % pairs), 5000);
    return () => clearInterval(t);
  }, [chosen, pairs]);

  const at = Math.min(pick, pairs - 1);
  const crop = (i: number): CSSProperties => ({
    backgroundImage: `url("${shown.url}")`,
    backgroundSize: `${pairs * 100}% 100%`,
    backgroundPosition: `${pairs > 1 ? (i / (pairs - 1)) * 100 : 0}% 0`,
  });
  const width = `min(100%, calc(56vh * ${aspect.toFixed(4)}))`;
  const frame = total ? `Frame ${shown.frame + 1} of ${total}` : `Frame ${shown.frame + 1}`;

  return (
    <figure className="live-look">
      <div
        className="live-pair"
        style={{ aspectRatio: aspect.toFixed(4), width }}
        role="img"
        aria-label={`${frame}, view ${at + 1} of ${pairs}: 4DAnyone's view on the left, our 3D render on the right`}
      >
        {Array.from({ length: pairs }, (_, i) => (
          <span key={i} className={i === at ? "on" : ""} style={crop(i)} />
        ))}
      </div>
      <div className="live-pair-labels" style={{ width }} aria-hidden="true">
        <span>4DAnyone&apos;s view</span>
        <span>Our 3D render</span>
      </div>
      {pairs > 1 && (
        <div className="live-pairs" role="group" aria-label="Views">
          {Array.from({ length: pairs }, (_, i) => (
            <button
              key={i}
              type="button"
              className={i === at ? "on" : ""}
              style={{ ...crop(i), aspectRatio: aspect.toFixed(4) }}
              aria-label={`View ${i + 1} of ${pairs}`}
              aria-pressed={i === at}
              onClick={() => {
                setPick(i);
                setChosen(true);
              }}
            />
          ))}
        </div>
      )}
      <figcaption>
        <b>{frame}, as it was fitted.</b> Left of each pair, the view 4DAnyone generated for that camera, which the 3D
        person is fitted to; right, our Gaussians rendered from the same camera.
        {shown.of && pairs > 1 ? ` ${pairs} of its ${shown.of} views.` : ""}
      </figcaption>
    </figure>
  );
}

function Nothing({ reason }: { reason?: LiveReply["reason"] }) {
  const [title, line] = {
    none: ["Nothing is being made right now.", "Make a dream and watch every stage of it here, live from the GPUs."],
    unknown: ["No run by that name.", "It may have another id, or it never reached the GPUs."],
    offline: ["That run lives on HiPerGator.", "This bridge is in demo mode. On the demo Mac (npm run demo), this page shows it live."],
    connecting: ["Asking HiPerGator.", "The first answer can take a few seconds."],
  }[reason ?? "none"];
  return (
    <div className="empty live-nothing">
      <h1>{title}</h1>
      <p>{line}</p>
      {reason === "connecting" ? (
        <span className="pulse" aria-hidden="true" />
      ) : reason === "none" ? (
        <Link href="/new" className="btn">Make a dream</Link>
      ) : (
        <Link href="/live" className="btn">See the newest run</Link>
      )}
    </div>
  );
}
