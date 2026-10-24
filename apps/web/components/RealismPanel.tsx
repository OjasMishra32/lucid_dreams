"use client";

import { useEffect, useState } from "react";
import type { RealismDefect, RealismState, RealismView } from "@/lib/dream";

const KIND: Record<RealismDefect["kind"], string> = {
  eyes: "Eyes", "skin-tone": "Skin tone", hairline: "Hairline", hands: "Hands", seams: "Seam", floaters: "Floaters",
  "face-shape": "Face shape", teeth: "Teeth", clothing: "Clothing", other: "Other",
};
const VIEW: Record<RealismView, string> = { front: "front", "three-quarter": "three-quarter", profile: "profile" };
const SEVERITY: Record<RealismDefect["severity"], string> = { minor: "Minor", noticeable: "Noticeable", severe: "Severe" };

/**
 * The honest answer to "does it look like them?": Gemini compares three views of the render with the source photo
 * (lib/bridge/realism.ts). A defect jumps the preview (id dream-preview) to the view it was seen in.
 */
export default function RealismPanel({ id, initial }: { id: string; initial: RealismState }) {
  const [s, setS] = useState<RealismState>(initial);

  useEffect(() => {
    if (s.state !== "working") return;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/dreams/${encodeURIComponent(id)}/realism`, { cache: "no-store" });
        setS(r.ok ? await r.json() : { ...s });
      } catch {
        setS({ ...s });
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [s, id]);

  if (s.state === "off") return null;

  function show(t: number) {
    const v = document.getElementById("dream-preview") as HTMLVideoElement | null;
    if (!v) return;
    v.pause();
    v.currentTime = Math.min(t, Math.max(0, (v.duration || t) - 0.05));
    const r = v.getBoundingClientRect();
    if (Math.min(r.bottom, innerHeight) - Math.max(r.top, 48) < r.height / 2) v.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <section className="realism" aria-labelledby="realism-title" aria-live="polite">
      <h2 id="realism-title">Realism check</h2>
      {s.state === "working" && (
        <div className="plan-working">
          <span className="pulse" />
          <p>Gemini is comparing the render with the photo, from the front, three-quarter and side.</p>
        </div>
      )}
      {s.state === "failed" && <p className="note">{s.message}</p>}
      {s.state === "ready" && (
        <>
          <div className={`realism-verdict ${tone(s.realism.samePerson, s.realism.confidence)}`}>
            <span className="realism-dot" aria-hidden="true" />
            <div>
              <b>{s.realism.samePerson ? "Looks like the same person" : "Doesn’t look like them yet"}</b>
              <span className="num">
                {Math.round(s.realism.confidence * 100)}% sure, from three views against the {s.realism.source === "photo" ? "photo" : "clip"}
              </span>
            </div>
          </div>
          {s.realism.summary && <p className="realism-summary">{s.realism.summary}</p>}

          {s.realism.defects.length > 0 ? (
            <ul className="realism-defects">
              {s.realism.defects.map((d, i) => (
                <li key={i}>
                  <button onClick={() => show(s.realism.moments[d.view])} aria-label={`${KIND[d.kind]}, ${d.where}: show the ${VIEW[d.view]} view`}>
                    <span className={`realism-sev ${d.severity}`}>{SEVERITY[d.severity]}</span>
                    <span>
                      <b>{KIND[d.kind]}</b>
                      <span className="realism-where">{d.where ? `${d.where} · ` : ""}{VIEW[d.view]} view</span>
                      <span className="realism-note">{d.note}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">Nothing stood out in the three views.</p>
          )}

          {s.candidates && (
            <>
              <h3 className="realism-sub">Faces tried</h3>
              <ol className="realism-candidates">
                {s.candidates.map((c, i) => (
                  <li key={c.id} className={i === 0 ? "best" : undefined}>
                    <span>{c.name}</span>
                    <span className="num">
                      {c.samePerson ? "" : "Not them · "}
                      {Math.round(c.confidence * 100)}%{i === 0 ? " · ships" : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
          <p className="note">
            Checked by Gemini, which compares the render with the {s.realism.source === "photo" ? "photo" : "clip"} and never
            identifies anyone. Parts the camera never saw were imagined; they&apos;re judged for realism alone.
          </p>
        </>
      )}
    </section>
  );
}

function tone(same: boolean, confidence: number): string {
  return !same ? "bad" : confidence >= 0.7 ? "ok" : "warn";
}
