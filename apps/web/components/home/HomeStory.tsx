"use client";

import { useEffect, useRef, useState } from "react";
import type { RigCamera } from "@/lib/three/story";

// The opening: a tall scroll track with one sticky stage. It starts as a product shot on light grey (the live 3D person,
// the wordmark, two buttons) and darkens into four beats, a headline each, centred above her. The 3D
// (lib/three/story.ts) reads the track's progress every frame; the beat and the stage's shade are set straight in the
// DOM, never by re-rendering.

const BEATS: [number, number][] = [
  [0, 0.08],
  [0.1, 0.27],
  [0.29, 0.44],
  [0.46, 0.65],
  [0.67, 0.84],
  [0.86, 1.01],
];

export interface HomeStoryProps {
  frame: string | null;
  reality: string | null;
  cameras: RigCamera[];
  seen: number | null;
  views: number | null;
  poster: string;
}

export default function HomeStory(p: HomeStoryProps) {
  const track = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">(p.frame ? "loading" : "failed");
  const [height, setHeight] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const seen = p.seen != null ? Math.round(p.seen * 100) : null;

  useEffect(() => {
    if (!p.frame || !host.current) return;
    let dispose: (() => void) | null = null;
    let gone = false;
    const progress = () => {
      const t = track.current;
      if (!t) return 0;
      const b = t.getBoundingClientRect();
      return Math.min(1, Math.max(0, -b.top / Math.max(1, b.height - innerHeight)));
    };
    let beat = -1;
    let shade = -1;
    import("@/lib/three/story")
      .then((m) =>
        m.mountStory(host.current!, { frame: p.frame!, reality: p.reality, cameras: p.cameras }, {
          progress,
          loading: () => {},
          ready: (info) => {
            if (gone) return;
            setHeight(info.height);
            setCount(info.count);
            setState("ready");
          },
          failed: () => !gone && setState("failed"),
          hud: () => {
            const pr = progress();
            const b = BEATS.findIndex(([a, z]) => pr >= a && pr < z);
            if (b !== beat) {
              beat = b;
              stage.current?.setAttribute("data-beat", String(b));
            }
            // light grey to black as the product shot gives way to the story
            const k = Math.min(1, Math.max(0, (pr - 0.05) / 0.06));
            const s = Math.round(k * 100) / 100;
            if (s !== shade) {
              shade = s;
              stage.current?.style.setProperty("--dark", String(s));
            }
          },
        }),
      )
      .then((d) => {
        if (gone) d();
        else dispose = d;
      })
      .catch(() => !gone && setState("failed"));
    return () => {
      gone = true;
      dispose?.();
    };
  }, [p.frame, p.reality, p.cameras]);

  return (
    <section ref={track} className="story" aria-label="One video becomes a person in your room">
      <div ref={stage} className={`story-stage ${state}`} data-beat="0">
        <div ref={host} className="story-host" />
        {state === "failed" && <img className="story-poster" src={p.poster} alt="A dancer rebuilt in 3D from one video" />}

        <div className="story-hero">
          <div>
            <h1 className="story-wordmark">Lucid Dreams</h1>
            <p className="story-tagline">Anyone from any video, standing in your room.</p>
          </div>
          <div className="story-buttons">
            <a href="#scenes" className="pill pill-quiet">See the scenes</a>
            <a href="#make" className="pill">Make a dream</a>
          </div>
        </div>
        <p className="story-caption">Live 3D, rendered in your browser. Drag to turn her.</p>

        <div className="story-beat beat-1">
          <p className="eyebrow-x">Live 3D</p>
          <h2>A real person, rebuilt in 3D from one clip.</h2>
        </div>
        <div className="story-beat beat-2">
          <p className="eyebrow-x">What she&rsquo;s made of</p>
          <h2>{count ? `${count.toLocaleString("en-US")} Gaussians in this frame.` : "Hundreds of thousands of Gaussians."}</h2>
          <p className="story-sub">Tiny translucent blobs of colour, each one placed by a GPU to match every view of her.</p>
        </div>
        <div className="story-beat beat-3">
          <p className="eyebrow-x">4DAnyone</p>
          <h2>{p.views ?? 48} cameras, imagined.</h2>
          <p className="story-sub">From one phone video, 4DAnyone films her from a dome of cameras that exist only in software. Every frame, every angle.</p>
        </div>
        <div className="story-beat beat-4">
          <p className="eyebrow-x">Reality check</p>
          <h2>See exactly what was imagined.</h2>
          <p className="story-sub">{seen != null ? `The camera saw ${seen}% of her. ` : ""}Everything else turns blue, whenever you ask.</p>
        </div>
        <div className="story-beat beat-5">
          <p className="eyebrow-x">Life size</p>
          <h2>{height ? `${height.toFixed(2)} metres tall.` : "Real size."} On your floor.</h2>
          <p className="story-sub">In Meta Quest 3S passthrough, with nothing but your hands.</p>
        </div>
      </div>
    </section>
  );
}
