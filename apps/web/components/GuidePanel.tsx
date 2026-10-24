"use client";

import { useEffect, useRef, useState } from "react";
import { dreamFile, type GuideState } from "@/lib/dream";

/**
 * The Gemini guide: the move, its steps in time with the preview (tap one to jump there), and the spoken version.
 * Step times are seconds into the motion, the same clock as the preview video, which loops every durationS.
 */
/** Video seconds per guide second: 1, unless the video is shorter than the clock the steps were timed on. */
function span(v: HTMLVideoElement, clockS: number): number {
  return v.duration && v.duration < clockS - 0.05 ? v.duration / clockS : 1;
}

export default function GuidePanel({ id, durationS, initial }: { id: string; durationS: number; initial: GuideState }) {
  const [s, setS] = useState<GuideState>(initial);
  const [active, setActive] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);

  // While Gemini works, check back every few seconds.
  useEffect(() => {
    if (s.state !== "working") return;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/dreams/${encodeURIComponent(id)}/guide`, { cache: "no-store" });
        setS(r.ok ? await r.json() : { ...s }); // a hiccup (the dev server recompiling): just ask again
      } catch {
        setS({ ...s });
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [s, id]);

  // Follow the preview: highlight the step the motion is in.
  const steps = s.state === "ready" ? s.guide.steps : null;
  const clockS = (s.state === "ready" && s.guide.durationS) || durationS; // the clock the steps were timed on
  useEffect(() => {
    if (!steps?.length) return;
    let raf = 0;
    const tick = () => {
      const v = document.getElementById("dream-preview") as HTMLVideoElement | null;
      if (v && clockS > 0) {
        const t = (v.currentTime / span(v, clockS)) % clockS;
        let i = -1;
        for (let k = 0; k < steps.length; k++) if (steps[k].t <= t + 0.02) i = k;
        setActive(i);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [steps, clockS]);

  if (s.state === "off" || s.state === "failed") return null;
  if (s.state === "working") {
    return (
      <section className="guide guide-working" aria-live="polite">
        <span className="pulse" />
        <p>Gemini is watching the clip to write a guide to this move.</p>
      </section>
    );
  }

  const g = s.guide;
  function jump(t: number) {
    const v = document.getElementById("dream-preview") as HTMLVideoElement | null;
    if (!v) return;
    v.currentTime = t * span(v, clockS);
    v.play().catch(() => {});
    // one column on phones: the preview sits above the steps, so bring it into view
    const r = v.getBoundingClientRect();
    const showing = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 48); // below the 48px nav
    if (showing < r.height / 2) v.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function listen() {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  return (
    <section className="guide" aria-label="Guide">
      <div className="guide-head">
        <div>
          {g.category && <p className="guide-category">{g.category}</p>}
          <h2>{g.move}</h2>
        </div>
        {g.audio && (
          <>
            <button className="btn secondary btn-listen" onClick={listen}>
              {playing ? (
                <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3" width="3" height="10" rx="1" /><rect x="9.5" y="3" width="3" height="10" rx="1" /></svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" /></svg>
              )}
              {playing ? "Pause" : "Listen"}
            </button>
            <audio
              ref={audio}
              src={`${dreamFile(id, g.audio)}?v=${encodeURIComponent(g.createdAt)}`} // a rewritten guide is a new file
              preload="none"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
            />
          </>
        )}
      </div>
      {g.summary && <p className="guide-summary">{g.summary}</p>}

      <ol className="guide-steps">
        {g.steps.map((st, i) => (
          <li key={i}>
            <button className={i === active ? "on" : ""} onClick={() => jump(st.t)} aria-current={i === active ? "step" : undefined}>
              <span className="guide-t num">{st.t.toFixed(1)} s</span>
              <span>
                <b>{st.title}</b>
                <span>{st.cue}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {g.tips.length > 0 && (
        <ul className="guide-tips">
          {g.tips.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
      <p className="note">
        Coaching by Gemini, written from {g.source === "clip" ? "the original clip" : "the 3D person"}. Tap a step to see it.
      </p>
    </section>
  );
}
