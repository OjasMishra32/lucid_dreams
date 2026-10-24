"use client";

import { useEffect, useRef, useState } from "react";
import HeadsetCanvas from "./Headset";

// The headset, right after the opening: the real Quest 3S rendered live (lib/three/headset.ts), pinned while short
// captions pass, ending with what its eyes see.

const CAPS = [
  { from: 0, to: 0.3, title: "Meta Quest 3S", text: "The headset it all runs on." },
  { from: 0.3, to: 0.64, title: "Inside", text: "Snapdragon XR2 Gen 2, 8 GB RAM, 1832 × 1920 per eye behind Fresnel lenses." },
  { from: 0.64, to: 0.8, title: "Hands only", text: "No controllers. 25 tracked joints per hand, and your real room through its cameras." },
  { from: 0.8, to: 1.01, title: "Two eyes, two renders", text: "Each eye gets its own render, 72 times a second. This is who they see." },
];

export default function HeadsetStage({ person }: { person?: string | null }) {
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
        <HeadsetCanvas track={track} person={person} />
        <div className="hs-caps">
          {CAPS.map((c) => (
            <div key={c.title} className={`hs-cap ${p >= c.from && p < c.to ? "on" : ""}`}>
                            <h2>{c.title}</h2>
              <p>{c.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
