"use client";

import { useEffect, useRef, useState } from "react";
import { ViewerLink } from "@/components/ViewInRoom";
import type { SceneCard, SceneGroup } from "@/lib/scenes";

// Every scene, once each, the way apple.com shows a product's features: a full-bleed banner with a centred headline
// for each group, a short paragraph, then a gallery of rounded cards (a bold lead-in caption under each) that scrolls
// sideways, with paddles. A card's 360 orbit plays only while it's on screen.

export interface GroupCopy {
  key: SceneGroup;
  eyebrow: string;
  headline: string;
  intro: string;
  banner: { video?: string | null; image?: string | null } | null;
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
  return (
    <>
      {groups.map((g) => {
        const list = cards.filter((c) => c.group === g.key);
        if (!list.length) return null;
        return (
          <section key={g.key} className={`group group-${g.key}`} aria-labelledby={`g-${g.key}`}>
            {g.banner ? (
              <div className="banner">
                <Media className="banner-media" video={g.banner.video} image={g.banner.image} />
                <div className="banner-copy">
                  <p className="eyebrow-x">{g.eyebrow}</p>
                  <h2 id={`g-${g.key}`}>{g.headline}</h2>
                </div>
              </div>
            ) : (
              <header className="group-head">
                <p className="eyebrow-x">{g.eyebrow}</p>
                <h2 id={`g-${g.key}`}>{g.headline}</h2>
              </header>
            )}
            <div className="group-body">
              <p className="group-intro">{g.intro}</p>
              {list.length > 1 ? <Gallery cards={list} /> : <Single s={list[0]} />}
            </div>
          </section>
        );
      })}
    </>
  );
}
