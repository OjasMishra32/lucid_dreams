"use client";

import { useEffect, useRef, useState } from "react";
import type { AnatomyInput, AnatomyMode } from "@/lib/three/anatomy";

// The live dancer pinned beside the chapters that take her apart: each chapter's text, as it reaches the middle of
// the screen, sets what the stage shows (lib/three/anatomy.ts).

export interface AtlasStep {
  mode: AnatomyMode;
  label: string;
  body: React.ReactNode;
}

export default function Atlas({ input, steps }: { input: AnatomyInput; steps: AtlasStep[] }) {
  const host = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [pct, setPct] = useState(0);
  const mode = useRef<AnatomyMode>(steps[0]?.mode ?? "splats");
  mode.current = steps[active]?.mode ?? "splats";

  useEffect(() => {
    if (!host.current) return;
    let dispose: (() => void) | null = null;
    let gone = false;
    let started = false;
    // the 4 MB frame loads only once the section is near
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || started) return;
      started = true;
      import("@/lib/three/anatomy")
        .then((m) =>
          m.mountAnatomy(host.current!, input, {
            mode: () => mode.current,
            loading: (f) => !gone && setPct(f),
            ready: () => !gone && setState("ready"),
            failed: () => !gone && setState("failed"),
          }),
        )
        .then((d) => {
          if (gone) d();
          else dispose = d;
        })
        .catch(() => !gone && setState("failed"));
    }, { rootMargin: "60% 0px" });
    io.observe(host.current);
    return () => {
      gone = true;
      io.disconnect();
      dispose?.();
    };
  }, [input]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    items.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [steps.length]);

  return (
    <div className="atlas">
      <div className="atlas-stage">
        <div ref={host} className="atlas-host" />
        <div className="atlas-chips" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.mode} className={i === active ? "on" : ""}>{s.label}</span>
          ))}
        </div>
        {state === "loading" && <p className="atlas-wait">{pct > 0 ? `Loading one frame · ${Math.round(pct * 100)}%` : "Loading one frame"}</p>}
        {state === "failed" && <p className="atlas-wait">The live render needs WebGL 2.</p>}
      </div>
      <div className="atlas-steps">
        {steps.map((s, i) => (
          <section key={s.mode} ref={(el) => { items.current[i] = el; }} data-i={i} className={`atlas-step ${i === active ? "on" : ""}`}>
            {s.body}
          </section>
        ))}
      </div>
    </div>
  );
}
