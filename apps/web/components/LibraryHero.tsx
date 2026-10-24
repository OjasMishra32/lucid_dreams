"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { afterLoad } from "@/lib/idle";
import { ViewerLink } from "./ViewInRoom";

export interface HeroItem {
  id: string;
  name: string;
  mode: string; // "Lesson"
  line: string; // their sentence, or where they came from
  action: string; // "Start the lesson"
  query: string; // for the WebXR viewer
  credit: string | null; // a public figure's credit, shown with them
  poster: string | null;
  preview: string | null;
}

const HOLD_S = 10;

/**
 * The library's opening: the best few people, one at a time, life size in the dark, cycling every ten seconds. Only
 * the person on screen and the next one load video; the rest wait as posters. Pausable (and paused for reduced motion).
 */
export default function LibraryHero({ items }: { items: HeroItem[] }) {
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);
  const [awake, setAwake] = useState(false); // videos wait for the page to load; the posters stand in until then
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const n = items.length;
  const next = n ? (at + 1) % n : 0;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setPaused(true);
    return afterLoad(() => setAwake(true));
  }, []);

  // The person coming on starts from their first frame; the one leaving rests.
  useEffect(() => {
    videos.current.forEach((v, k) => {
      if (!v) return;
      if (k === at) {
        v.currentTime = 0;
        v.play().catch(() => {});
      } else v.pause();
    });
  }, [at, awake]);

  if (!n) return null;
  const go = (k: number) => setAt(((k % n) + n) % n);

  return (
    <section className="lhero" aria-roledescription="carousel" aria-label="Featured people">
      <div className="wrap lhero-grid">
        <div className="lhero-copy">
          {items.map((it, k) => (
            <div key={it.id} className={k === at ? "lhero-item on" : "lhero-item"} aria-hidden={k !== at} inert={k !== at}>
              <p className="eyebrow">{it.mode}</p>
              <h2 className="lhero-name">{it.name}</h2>
              <p className="said lhero-said">{it.line}</p>
              {it.credit && <p className="lhero-credit">{it.credit}</p>}
              <div className="lhero-actions">
                <ViewerLink query={it.query} className="btn">{it.action}</ViewerLink>
                <Link href={`/library/${encodeURIComponent(it.id)}`} className="more">See the dream</Link>
              </div>
            </div>
          ))}
        </div>

        <div className="lhero-stage">
          <div className="lhero-glow" aria-hidden="true">
            {items.map((it, k) =>
              it.poster ? (
                <Image key={it.id} src={it.poster} alt="" fill sizes="96px" loading={k === 0 ? "eager" : "lazy"} className={k === at ? "on" : ""} />
              ) : null,
            )}
          </div>
          {items.map((it, k) => (
            <Link
              key={it.id}
              href={`/library/${encodeURIComponent(it.id)}`}
              className={k === at ? "lhero-person on" : "lhero-person"}
              aria-hidden={k !== at}
              tabIndex={k === at ? 0 : -1}
              aria-label={`${it.name}: see the dream`}
            >
              {it.poster && (
                <Image src={it.poster} alt="" fill priority={k === 0} sizes="(max-width: 900px) 72vw, 460px" />
              )}
              {awake && it.preview && (k === at || k === next) && (
                <video
                  ref={(el) => {
                    videos.current[k] = el;
                  }}
                  src={it.preview}
                  muted
                  loop
                  playsInline
                  preload={k === at ? "auto" : "metadata"}
                  aria-hidden="true"
                  onPlaying={(e) => e.currentTarget.classList.add("ready")}
                />
              )}
            </Link>
          ))}
          <span className="floor" aria-hidden="true" />
        </div>
      </div>

      {n > 1 && (
        <div className="wrap lhero-nav">
          <ol className="lhero-tabs">
            {items.map((it, k) => (
              <li key={it.id}>
                <button
                  className={k === at ? "on" : ""}
                  aria-current={k === at ? "true" : undefined}
                  onClick={() => go(k)}
                >
                  <span>{it.name}</span>
                  <i aria-hidden="true">
                    {k === at && (
                      <b
                        key={at}
                        style={{ animationDuration: `${HOLD_S}s`, animationPlayState: paused ? "paused" : "running" }}
                        onAnimationEnd={() => go(at + 1)}
                      />
                    )}
                  </i>
                </button>
              </li>
            ))}
          </ol>
          <button className="lhero-pause" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? "Play" : "Pause"}
          </button>
        </div>
      )}
    </section>
  );
}
