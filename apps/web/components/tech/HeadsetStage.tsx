"use client";

import { useEffect, useRef, useState } from "react";
import HeadsetCanvas from "./Headset";

// The headset chapter: the real Quest 3S model rendered live (lib/three/headset.ts), pinned while three captions pass.

const CAPS = [
  {
    from: 0,
    to: 0.32,
    title: "Meta Quest 3S",
    text: "Snapdragon XR2 Gen 2, 8 GB RAM, 1832 × 1920 per eye, 96° field of view.",
  },
  {
    from: 0.32,
    to: 0.62,
    title: "Passthrough",
    text: "WebXR immersive-ar in a local-floor space, so y = 0 is your floor. People are pinned with spatial anchors. Hand tracking gives 25 joints per hand.",
  },
  {
    from: 0.62,
    to: 1.01,
    title: "Two renders per frame",
    text: "One per eye, 63 mm apart, inside 13.9 ms at 72 Hz. Miss it and the frame judders.",
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
