"use client";

import { useEffect, useRef, useState } from "react";

// Real gameplay, recorded from the app itself: one big film at a time, the way apple.com plays its highlights. Each
// tab fills as its clip plays, then the next one starts; tap a tab to jump. Plays only while it's on screen.

export interface PlayClip {
  key: string;
  title: string;
  line: string;
  src: string;
  poster: string | null;
}

export default function PlayReel({ clips }: { clips: PlayClip[] }) {
  const [i, setI] = useState(0);
  const [onScreen, setOnScreen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLSpanElement[]>([]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (onScreen && !still) v.play().catch(() => {});
    else v.pause();
  }, [onScreen, i]);

  // each tab's fill follows its clip's time
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = video.current;
      bar.current.forEach((b, k) => {
        if (!b) return;
        const u = k < i ? 1 : k > i ? 0 : v && v.duration ? v.currentTime / v.duration : 0;
        b.style.transform = `scaleX(${u})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [i]);

  if (!clips.length) return null;
  const c = clips[i];
  return (
    <div className="reel" ref={box}>
      <div className="reel-film">
        <video
          ref={video}
          key={c.key}
          src={c.src}
          poster={c.poster ?? undefined}
          muted
          playsInline
          preload="auto"
          onEnded={() => setI((k) => (k + 1) % clips.length)}
          aria-label={`${c.title}: ${c.line}`}
        />
        <div className="reel-caption" key={`cap-${c.key}`}>
          <h3>{c.title}</h3>
          <p>{c.line}</p>
        </div>
      </div>
      <div className="reel-tabs" role="tablist" aria-label="Scenes">
        {clips.map((k, n) => (
          <button key={k.key} role="tab" aria-selected={n === i} className={n === i ? "on" : ""} onClick={() => setI(n)}>
            <span className="reel-tab-name">{k.title}</span>
            <span className="reel-track"><span ref={(el) => { if (el) bar.current[n] = el; }} /></span>
          </button>
        ))}
      </div>
    </div>
  );
}
