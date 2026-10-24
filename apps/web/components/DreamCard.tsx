"use client";

import Image from "next/image";
import Link from "next/link";
import { ViewTransition, useEffect, useRef, useState } from "react";

export interface CardDream {
  id: string;
  name: string;
  line: string; // their sentence, or where they came from
  note: string | null; // a legend's engine label
  badge: string | null; // "Private"
  poster: string | null;
  preview: string | null;
}

/**
 * A person, whole, head to toe on black (9:16, never cropped). Hover, or on a touch screen scroll them into view, and
 * they come to life: the preview fades in over the poster. The media morphs into the dream page's stage on open.
 */
export default function DreamCard({ d }: { d: CardDream }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [want, setWant] = useState(false); // play now
  const [loaded, setLoaded] = useState(false); // the video element exists (only once someone asked for it)
  const [shown, setShown] = useState(false);

  // No hover on a touch screen: whoever is well in view plays (never with reduced motion).
  useEffect(() => {
    const el = box.current;
    if (!el || !d.preview) return;
    if (!matchMedia("(hover: none)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => setWant(e.intersectionRatio >= 0.75), { threshold: [0, 0.75, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, [d.preview]);

  useEffect(() => {
    if (want) setLoaded(true);
    const v = video.current;
    if (!v) return;
    if (want) v.play().catch(() => {});
    else {
      v.pause();
      setShown(false);
    }
  }, [want, loaded]);

  const hover = (on: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") setWant(on);
  };

  return (
    <Link
      href={`/library/${encodeURIComponent(d.id)}`}
      className="card"
      onPointerEnter={hover(true)}
      onPointerLeave={hover(false)}
      onFocus={() => setWant(true)}
      onBlur={() => setWant(false)}
    >
      <ViewTransition name={`dream-${d.id}`} share="morph" default="none">
        <div className="person card-media" ref={box}>
          {d.poster && (
            <Image
              src={d.poster}
              alt=""
              fill
              sizes="(max-width: 600px) 46vw, (max-width: 900px) 30vw, 280px"
            />
          )}
          {loaded && d.preview && (
            <video
              ref={video}
              src={d.preview}
              muted
              loop
              playsInline
              preload="auto"
              aria-hidden="true" // the card names the person; the moving preview adds nothing to read
              className={shown ? "ready" : ""}
              onPlaying={() => setShown(true)}
            />
          )}
          {d.badge && <span className="badge">{d.badge}</span>}
        </div>
      </ViewTransition>
      <div className="card-copy">
        <h3>{d.name}</h3>
        <p className="said card-said">{d.line}</p>
        {d.note && <p className="card-note">{d.note}</p>}
      </div>
    </Link>
  );
}
