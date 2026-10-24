"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ExperienceState } from "@/lib/dream";
import ShareButton from "./ShareButton";
import { ViewerLink } from "./ViewInRoom";

const MODE: Record<string, string> = { teach: "Lesson", companion: "Companion", watch: "Watch", play: "Play" };
const PLACE: Record<string, string> = {
  "concert-hall": "In a concert hall", court: "On a court", gym: "In a gym", ring: "In a boxing ring",
  studio: "In a studio", mountains: "In the mountains", room: "In your room",
};

/** Video seconds per plan second: 1, unless the video is shorter than the clip the steps were timed on (a mock stand-in). */
function span(v: HTMLVideoElement, clockS: number): number {
  return v.duration && v.duration < clockS - 0.05 ? v.duration / clockS : 1;
}

/**
 * What you came to do with them (experience.json, planned by Gemini from your sentence and the clip): the main action,
 * named by the plan, and the plan itself. A lesson's steps follow the preview (id dream-preview); tap one to see it.
 */
export default function DreamExperience({
  id,
  kind,
  name,
  durationS,
  shareUrl,
  initial,
}: {
  id: string;
  kind: "replay" | "avatar";
  name: string;
  durationS: number;
  shareUrl: string;
  initial: ExperienceState;
}) {
  const [s, setS] = useState<ExperienceState>(initial);
  const [active, setActive] = useState(-1);

  // While Gemini plans, check back every few seconds.
  useEffect(() => {
    if (s.state !== "working") return;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/dreams/${encodeURIComponent(id)}/experience`, { cache: "no-store" });
        setS(r.ok ? await r.json() : { ...s }); // a hiccup (the dev server recompiling): just ask again
      } catch {
        setS({ ...s });
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [s, id]);

  const e = s.state === "ready" ? s.experience : null;
  const steps = e?.mode === "teach" ? (e.steps ?? []) : null;
  const clockS = e?.durationS || durationS;

  // Follow the preview: highlight the step the motion is in.
  useEffect(() => {
    if (!steps?.length) return;
    let raf = 0;
    const tick = () => {
      const v = document.getElementById("dream-preview") as HTMLVideoElement | null;
      if (v && clockS > 0) {
        const t = (v.currentTime / span(v, clockS)) % clockS;
        setActive(steps.findIndex((st) => t >= st.start - 0.02 && t < st.end));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [steps, clockS]);

  function jump(t: number) {
    const v = document.getElementById("dream-preview") as HTMLVideoElement | null;
    if (!v) return;
    v.currentTime = t * span(v, clockS);
    v.play().catch(() => {});
    // one column on phones: the preview sits above the steps, so bring it into view
    const r = v.getBoundingClientRect();
    const showing = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 48);
    if (showing < r.height / 2) v.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const room = `dream=${encodeURIComponent(id)}`;
  const chess = `mode=chess&opponent=${encodeURIComponent(id)}${e?.play ? `&strength=${encodeURIComponent(e.play.strength)}` : ""}`;
  const primary =
    e?.mode === "play" ? null
    : e?.mode === "teach" ? "Start the lesson in your room"
    : e?.mode === "companion" ? "Bring them into your room"
    : "View in your room";

  return (
    <>
      <div className="detail-actions">
        {e?.mode === "play" ? (
          <>
            <ViewerLink query={chess} className="btn">Play chess with them</ViewerLink>
            <ViewerLink query={room} className="btn secondary">View in your room</ViewerLink>
          </>
        ) : (
          <>
            <ViewerLink query={room} className="btn">{primary}</ViewerLink>
            {kind === "avatar" && <ViewerLink query={chess} className="btn secondary">Play chess with them</ViewerLink>}
          </>
        )}
        <ShareButton title={name} url={shareUrl} />
      </div>

      {s.state === "working" && (
        <section className="plan plan-working" aria-live="polite">
          <span className="pulse" />
          <p>Gemini is planning what you&apos;ll do together.</p>
        </section>
      )}

      {e && (
        <section className="plan" aria-label="The plan">
          <p className="plan-eyebrow">{[e.category, MODE[e.mode]].filter(Boolean).join(" · ")}</p>
          <h2>{e.title}</h2>
          {e.summary && <p className="plan-summary">{e.summary}</p>}
          {e.intent && <p className="plan-intent">&ldquo;{e.intent}&rdquo;</p>}
          {(e.environment || e.objects?.length) && (
            <ul className="plan-chips" aria-label="Around them">
              {e.environment && <li className="place">{PLACE[e.environment] ?? e.environment}</li>}
              {e.objects?.map((o) => <li key={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</li>)}
            </ul>
          )}

          {steps && steps.length > 0 && (
            <ol className="plan-steps">
              {steps.map((st, i) => (
                <li key={i}>
                  <button className={i === active ? "on" : ""} onClick={() => jump(st.start)} aria-current={i === active ? "step" : undefined}>
                    <span className="plan-t num">{st.start.toFixed(1)}–{st.end.toFixed(1)} s</span>
                    <span>
                      <b>{st.title}</b>
                      {st.tip && <span>{st.tip}</span>}
                    </span>
                    <span className="plan-pace num" aria-label={`${speedLabel(st.speed)} speed, ${times(st.repeat ?? 2)}`}>
                      {speedLabel(st.speed)} · {times(st.repeat ?? 2)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className="note">
            {e.mode === "teach"
              ? "In your room each step plays slowed down, then they pause for your turn. Tap a step to see it here."
              : e.mode === "play"
                ? `A real chess engine plays at ${e.play?.strength ?? "club"} strength. Not affiliated with any player.`
                : plannedFrom(e.source, e.intent)}
          </p>
          {steps && steps.length > 0 && kind === "replay" && (
            <Link href={`/library/${encodeURIComponent(id)}/try`} className="more plan-try">Watch me try</Link>
          )}
        </section>
      )}
    </>
  );
}

/** Say exactly what Gemini had to go on. */
function plannedFrom(source: string | undefined, intent: string | null): string {
  const seen = source === "photo" ? "the photo" : source === "clip" ? "the clip" : source === "preview" ? "the 3D person" : null;
  const parts = [intent ? "your sentence" : null, seen].filter(Boolean);
  return parts.length ? `Planned by Gemini from ${parts.join(" and ")}.` : "Planned by Gemini.";
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function speedLabel(speed?: number): string {
  const v = speed ?? 0.5;
  return v >= 0.99 ? "1×" : v === 0.5 ? "½×" : v === 0.25 ? "¼×" : `${v.toFixed(2).replace(/0+$/, "")}×`;
}
