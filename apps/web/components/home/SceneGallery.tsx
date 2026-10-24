"use client";

import { useEffect, useRef, useState } from "react";
import { ViewerLink } from "@/components/ViewInRoom";
import type { SceneCard, SceneGroup } from "@/lib/scenes";

// Every scene, once each: one gallery of rounded cards that scrolls sideways (with paddles), switched between the
// kinds of scene by tabs. A card's 360 orbit plays only while it's on screen.

export interface GroupCopy {
  key: SceneGroup;
  eyebrow: string; // the tab
  intro: string; // one line under the tabs
}

function useInView<T extends HTMLElement>(onChange: (inView: boolean) => void) {
  const ref = useRef<T>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => cb.current(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

function Media({ video, image, poster, className }: { video?: string | null; image?: string | null; poster?: string | null; className?: string }) {
  const v = useRef<HTMLVideoElement>(null);
  const ref = useInView<HTMLDivElement>((on) => {
    const el = v.current;
    if (!el) return;
    if (on && !matchMedia("(prefers-reduced-motion: reduce)").matches) el.play().catch(() => {});
    else el.pause();
  });
  return (
    <div ref={ref} className={className}>
      {video ? (
        <video ref={v} src={video} poster={poster ?? undefined} muted loop playsInline preload="none" aria-hidden="true" />
      ) : image || poster ? (
        <img src={(image ?? poster)!} alt="" loading="lazy" />
      ) : null}
    </div>
  );
}

function Card({ s }: { s: SceneCard }) {
  return (
    <article className={`g-card ${s.image ? "g-world" : "g-person"}`}>
      <Media className="g-media" video={s.video} image={s.image} poster={s.poster} />
      <p className="g-caption">
        <b>{s.title}.</b> &ldquo;{s.said}&rdquo; {s.what}
      </p>
      {s.label && <p className="g-label">{s.label}</p>}
      <ViewerLink query={s.open} className="g-link">Open in your room</ViewerLink>
    </article>
  );
}

function Gallery({ cards }: { cards: SceneCard[] }) {
  const row = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: false });
  const update = () => {
    const el = row.current;
    if (!el) return;
    setEnds({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  };
  useEffect(() => {
    update();
    addEventListener("resize", update);
    return () => removeEventListener("resize", update);
  }, []);
  const go = (dir: number) => {
    const el = row.current;
    const card = el?.querySelector<HTMLElement>(".g-card");
    if (!el || !card) return;
    el.scrollBy({ left: dir * (card.offsetWidth + 20), behavior: "smooth" });
  };
  return (
    <div className="gallery">
      <div ref={row} className="g-row" onScroll={update}>
        {cards.map((s) => <Card key={s.key} s={s} />)}
      </div>
      {cards.length > 1 && (
        <div className="paddles">
          <button type="button" aria-label="Previous" disabled={ends.start} onClick={() => go(-1)}>
            <svg viewBox="0 0 36 36" aria-hidden="true"><path d="M20.5 11.5 14 18l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" aria-label="Next" disabled={ends.end} onClick={() => go(1)}>
            <svg viewBox="0 0 36 36" aria-hidden="true"><path d="M15.5 11.5 22 18l-6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

function Single({ s }: { s: SceneCard }) {
  return (
    <div className="single">
      <Media className="single-media" video={s.video} image={s.image} poster={s.poster} />
      <div className="single-copy">
        <h3>{s.title}</h3>
        <p className="single-said">&ldquo;{s.said}&rdquo;</p>
        <p>{s.what}</p>
        {s.label && <p className="g-label">{s.label}</p>}
        <ViewerLink query={s.open} className="g-link">Open in your room</ViewerLink>
      </div>
    </div>
  );
}

export default function SceneGallery({ groups, cards }: { groups: GroupCopy[]; cards: SceneCard[] }) {
  const present = groups.filter((g) => cards.some((c) => c.group === g.key));
  const [tab, setTab] = useState<SceneGroup | null>(present[0]?.key ?? null);
  const g = present.find((x) => x.key === tab) ?? present[0];
  if (!g) return null;
  const list = cards.filter((c) => c.group === g.key);
  return (
    <section className="scenes-x" aria-labelledby="scenes-title">
      <h2 id="scenes-title" className="section-head">Scenes</h2>
      <div className="tabs" role="tablist" aria-label="Kinds of scene">
        {present.map((x) => (
          <button key={x.key} role="tab" aria-selected={x.key === g.key} className={x.key === g.key ? "on" : ""} onClick={() => setTab(x.key)}>
            {x.eyebrow}
          </button>
        ))}
      </div>
      <p className="scenes-intro">{g.intro}</p>
      {list.length > 1 ? <Gallery key={g.key} cards={list} /> : <Single key={g.key} s={list[0]} />}
    </section>
  );
}
