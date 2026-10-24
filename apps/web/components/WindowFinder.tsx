"use client";

import { useEffect, useRef, useState } from "react";
import { findWindows, type FoundWindow } from "@/lib/findWindows";

type State =
  | { phase: "idle" }
  | { phase: "looking"; progress: number }
  | { phase: "done"; windows: FoundWindow[] }
  | { phase: "off" }; // the pose model couldn't load: the filmstrip still works

/**
 * For long footage (a film, an hour of home video): looks through the whole clip for the stretches that make good
 * replays and shows them as moments to tap. Starts on its own past a minute; a tap sets where the 5 seconds start.
 */
export default function WindowFinder({
  url,
  durationS,
  startS,
  onPick,
  disabled = false,
}: {
  url: string;
  durationS: number;
  startS: number;
  onPick: (startS: number) => void;
  disabled?: boolean; // while uploading: the window is settled
}) {
  const [s, setS] = useState<State>({ phase: "idle" });
  const abort = useRef<AbortController | null>(null);
  const now = useRef({ startS, disabled });
  now.current = { startS, disabled };

  function start() {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setS({ phase: "looking", progress: 0 });
    const from = now.current.startS;
    findWindows(url, durationS, { signal: ctrl.signal, onProgress: (progress) => !ctrl.signal.aborted && setS({ phase: "looking", progress }) })
      .then((windows) => {
        if (ctrl.signal.aborted) return;
        setS(windows ? { phase: "done", windows } : { phase: "off" });
        // jump to the best moment only if they haven't chosen one themselves meanwhile, and never mid-upload
        if (windows?.length && !now.current.disabled && Math.abs(now.current.startS - from) < 0.01) onPick(windows[0].startS);
      })
      .catch(() => !ctrl.signal.aborted && setS({ phase: "off" }));
  }

  // a new clip: start over (on its own when it's long enough that dragging through it would be a chore)
  useEffect(() => {
    setS({ phase: "idle" });
    if (durationS > 60) start();
    return () => abort.current?.abort();
  }, [url, durationS]); // start() is stable enough: it only reads these two

  if (s.phase === "off") return null;
  if (s.phase === "idle") {
    return (
      <div className="finder">
        <button type="button" className="btn secondary btn-sm finder-go" onClick={start} disabled={disabled}>
          Find the best 5 seconds
        </button>
        <span className="muted">One person, head to toe, camera still.</span>
      </div>
    );
  }
  if (s.phase === "looking") {
    return (
      <div className="finder" aria-live="polite">
        <div className="bar finder-bar">
          <span style={{ width: `${Math.max(3, s.progress * 100)}%` }} />
        </div>
        <span className="muted num">Looking through {clock(durationS)} of footage for the best moments…</span>
      </div>
    );
  }
  if (!s.windows.length) {
    return (
      <p className="finder-none muted">
        No stretch with one person, head to toe and a still camera. Drag the window to the best part yourself.
      </p>
    );
  }
  return (
    <div className="finder-found">
      <p className="finder-title">Best moments</p>
      <ul className="finder-tiles">
        {s.windows.map((w, i) => {
          const on = Math.abs(w.startS - startS) < 0.3;
          return (
            <li key={w.startS}>
              <button type="button" className={on ? "on" : ""} onClick={() => onPick(w.startS)} aria-pressed={on} disabled={disabled}
                aria-label={`${i === 0 ? "Best moment" : "Moment"} at ${clock(w.startS)}`}>
                <img src={w.thumb} alt="" />
                <span className="num">{clock(w.startS)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function clock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
