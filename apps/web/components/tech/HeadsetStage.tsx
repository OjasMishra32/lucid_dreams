"use client";

import { useEffect, useRef, useState } from "react";
import HeadsetCanvas from "./Headset";

// The headset chapter: the Quest 3S rendered live (lib/three/headset.ts) pinned while three captions pass, from the
// device itself to passthrough to the two renders every frame needs.

const CAPS = [
  {
    from: 0,
    to: 0.32,
    title: "Meta Quest 3S.",
    text: "A standalone headset: a Snapdragon XR2 Gen 2, 8 GB of memory, and a 1832 × 1920 display for each eye behind Fresnel lenses, 96° across.",
  },
  {
    from: 0.32,
    to: 0.62,
    title: "Your room, through its cameras.",
    text: "The browser opens an immersive-ar WebXR session in a local-floor reference space: y = 0 is your real floor, every person stands life size on it, pinned by a spatial anchor, and your tracked hands (25 joints each) serve, shake hands and move pieces.",
  },
  {
    from: 0.62,
    to: 1.01,
    title: "Two eyes, two renders.",
    text: "Every frame is drawn twice, once from each eye, 63 mm apart, inside 13.9 ms at 72 Hz. Miss it and the compositor reprojects the last frame, and the person in front of you judders.",
  },
];

export default function HeadsetStage() {
  const track = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = track.current;
      if (t) {
        const r = t.getBoundingClientRect();
        setP(Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - innerHeight))));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={track} className="hs-track">
      <div className="hs-stage">
        <HeadsetCanvas track={track} />
        <div className="hs-caps">
          {CAPS.map((c) => (
            <div key={c.title} className={`hs-cap ${p >= c.from && p < c.to ? "on" : ""}`}>
              <p className="t-num">07</p>
              <h2>{c.title}</h2>
              <p>{c.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
