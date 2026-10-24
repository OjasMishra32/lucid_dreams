"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export interface KioskSlide {
  id: string;
  name: string;
  line: string;
  preview: string;
  poster: string | null;
}

const HOLD_MS = 8000;
const REFRESH_MS = 5 * 60_000; // new dreams land through the night
const IDLE_MS = 2500;

/**
 * Full-screen previews cycling every 8 s over the whole window (nav and footer included). Only the slide on screen
 * and the next one load; the cursor and the two buttons fade away when nobody touches the laptop; the screen stays
 * awake. Arrow keys step, F toggles full screen.
 */
export default function Kiosk({ slides }: { slides: KioskSlide[] }) {
  const router = useRouter();
  const [i, setI] = useState(0);
  const [awake, setAwake] = useState(true);
  const [full, setFull] = useState(false);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const n = slides.length;
  const at = n ? i % n : 0;
  const next = n ? (at + 1) % n : 0;
  // each slide's 8 seconds start once its video is actually playing, so a slow load never cuts a person short
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const ready = readyAt === at;

  useEffect(() => {
    if (n < 2 || !ready) return;
    const t = setTimeout(() => setI((at + 1) % n), HOLD_MS);
    return () => clearTimeout(t);
  }, [at, n, ready]);

  useEffect(() => {
    const t = setTimeout(() => setReadyAt(at), 4000); // a video that never starts doesn't stall the loop
    return () => clearTimeout(t);
  }, [at]);

  // The slide coming on starts from its first frame; every other one rests.
  useEffect(() => {
    videos.current.forEach((v, k) => {
      if (!v) return;
      if (k === at) {
        v.currentTime = 0;
        v.play().catch(() => {});
      } else v.pause();
    });
  }, [at, slides]);

  useEffect(() => {
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [router]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setAwake(true);
      clearTimeout(t);
      t = setTimeout(() => setAwake(false), IDLE_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      wake();
      if (e.key === "ArrowRight") setI((x) => (x + 1) % Math.max(n, 1));
      else if (e.key === "ArrowLeft") setI((x) => (x - 1 + Math.max(n, 1)) % Math.max(n, 1));
      else if (e.key === "f" || e.key === "F") toggleFull();
    };
    wake();
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", onKey);
    };
  }, [n]);

  // Full screen state, no page scroll underneath, and a screen that doesn't go to sleep on the demo table.
  useEffect(() => {
    const onFull = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFull);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let lock: WakeLockSentinel | null = null;
    const keepAwake = () => {
      if (document.visibilityState === "visible") navigator.wakeLock?.request("screen").then((l) => (lock = l), () => {});
    };
    keepAwake();
    document.addEventListener("visibilitychange", keepAwake);
    return () => {
      document.removeEventListener("fullscreenchange", onFull);
      document.removeEventListener("visibilitychange", keepAwake);
      document.body.style.overflow = overflow;
      lock?.release().catch(() => {});
    };
  }, []);

  return (
    <div className={awake ? "kiosk" : "kiosk asleep"}>
      {n === 0 ? (
        <div className="kiosk-empty">
          <h1 className="section-title">No dreams yet.</h1>
          <Link href="/new" className="btn">Make a dream</Link>
        </div>
      ) : (
        slides.map((s, k) => {
          const live = k === at || k === next;
          return (
            <figure key={s.id} className={k === at ? "kiosk-slide on" : "kiosk-slide"} aria-hidden={k !== at}>
              <video
                ref={(el) => {
                  videos.current[k] = el;
                }}
                src={live ? s.preview : undefined}
                poster={s.poster ?? undefined}
                muted
                loop
                playsInline
                preload={live ? "auto" : "none"}
                aria-label={`${s.name}, walked all the way around`}
                onPlaying={() => k === at && setReadyAt(k)}
              />
              <figcaption className="kiosk-copy">
                <p className="kiosk-name">{s.name}</p>
                <p className="kiosk-line">{s.line}</p>
              </figcaption>
            </figure>
          );
        })
      )}

      <div className="kiosk-foot">
        <span className="kiosk-mark">Lucid Dreams</span>
        {n > 1 && (
          <ol className="kiosk-dots" aria-label={`${at + 1} of ${n}`}>
            {slides.map((s, k) => (
              <li key={s.id} className={k === at ? "on" : ""}>
                {k === at && ready && <span key={`on-${at}`} />}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="kiosk-controls">
        <button className="btn secondary btn-sm" onClick={toggleFull}>{full ? "Exit full screen" : "Full screen"}</button>
        <Link href="/showcase" className="btn secondary btn-sm">Done</Link>
      </div>
    </div>
  );
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}
