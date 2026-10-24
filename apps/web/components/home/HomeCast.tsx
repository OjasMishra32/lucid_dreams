"use client";

import { useEffect, useRef, useState } from "react";

// Everyone in the library standing in one line, live in 3D (lib/three/cast.ts). Pinned while you scroll: the whole line
// first, then the camera walks along it, and each person's name and sentence come up as it reaches them.

export interface CastCard {
  id: string;
  frame: string;
  name: string;
  said: string;
  what: string;
}

export default function HomeCast({ cast }: { cast: CastCard[] }) {
  const track = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(-1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!host.current || !cast.length) return;
    let dispose: (() => void) | null = null;
    let gone = false;
    const progress = () => {
      const t = track.current;
      if (!t) return 0;
      const b = t.getBoundingClientRect();
      return Math.min(1, Math.max(0, -b.top / Math.max(1, b.height - innerHeight)));
    };
    import("@/lib/three/cast")
      .then((m) => m.mountCast(host.current!, cast.map((c) => ({ id: c.id, frame: c.frame })), { progress, focus: (i) => !gone && setFocus(i), failed: () => !gone && setFailed(true) }))
      .then((d) => {
        if (gone) d();
        else dispose = d;
      })
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
      dispose?.();
    };
  }, [cast]);

  if (!cast.length) return null;
  return (
    <section ref={track} className="cast" style={{ ["--n" as string]: cast.length }} aria-labelledby="cast-title">
      <div className="cast-stage">
        <div ref={host} className="cast-host" />
        <div className={`cast-head ${focus === -1 ? "on" : ""}`}>
          <p className="eyebrow-x">The cast</p>
          <h2 id="cast-title">Every one of them, from one video.</h2>
          <p className="cast-sub">{cast.length} people, each rebuilt in 3D and rendered live right here. Scroll to walk the line.</p>
        </div>
        {cast.map((c, i) => (
          <div key={c.id} className={`cast-card ${focus === i ? "on" : ""}`} aria-hidden={focus !== i}>
            <p className="cast-count">{i + 1} of {cast.length}</p>
            <h3>{c.name}</h3>
            <p className="cast-said">&ldquo;{c.said}&rdquo;</p>
            <p className="cast-what">{c.what}</p>
          </div>
        ))}
        {failed && <p className="cast-fallback">Live 3D needs WebGL 2. Every scene is below.</p>}
      </div>
    </section>
  );
}
