"use client";

import { useEffect, useRef, useState } from "react";
import type { PipelineData } from "@/lib/scenes";

// How it works, as one pinned scroll through the real pipeline, on the dancer's real data: her clip dropped in with
// her sentence, the browser's checks, 4DAnyone's 48 views, 12 GPUs fitting her Gaussians (live, a cloud pulling
// together into her), the plan her sentence became, and the bundle going to the headset. Scroll drives everything
// straight in the DOM; React only re-renders when a number or a typed letter changes.

const STAGES = [
  { title: "Drop it in", line: "A video or photos, plus one sentence of what you want." },
  { title: "Check", line: "The browser checks for one person, head to toe, and picks the best 5 seconds." },
  { title: "48 views", line: "4DAnyone generates the same 5 seconds from 48 cameras." },
  { title: "Reconstruct", line: "12 GPUs fit about 290k Gaussians to every frame, about a minute each." },
  { title: "Plan", line: "Your sentence becomes a plan. Here, a 3-step lesson." },
  { title: "In your room", line: "The bundle streams to the Quest. Put it on and they're there." },
];
const N = STAGES.length;
const GPUS = 12;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export default function Pipeline({ data }: { data: PipelineData }) {
  const track = useRef<HTMLElement>(null);
  const layers = useRef<(HTMLDivElement | null)[]>([]);
  const forming = useRef<HTMLDivElement>(null);
  const p = useRef(0);
  const [stage, setStage] = useState(0);
  const [typed, setTyped] = useState(0);
  const [frameN, setFrameN] = useState(0);
  const [lit, setLit] = useState(0);
  const [checks, setChecks] = useState(0);
  const [steps, setSteps] = useState(0);

  // scroll -> progress -> each stage's local time, written straight into the layers' style
  useEffect(() => {
    const root = track.current;
    if (!root) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const last = { stage: -1, typed: -1, frameN: -1, lit: -1, checks: -1, steps: -1 };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const r = root.getBoundingClientRect();
      if (r.bottom < -50 || r.top > innerHeight + 50) return;
      const target = clamp(-r.top / Math.max(1, r.height - innerHeight));
      p.current += (target - p.current) * (still ? 1 : 0.18);
      const x = p.current * N;
      const s = Math.min(N - 1, Math.floor(x));
      root.style.setProperty("--p", p.current.toFixed(4));
      layers.current.forEach((el, i) => {
        if (!el) return;
        const t = clamp(x - i);
        const inn = i === 0 ? 1 : ease(-0.03, 0.07, x - i);
        const out = i === N - 1 ? 1 : 1 - ease(0.93, 1.0, x - i);
        el.style.setProperty("--t", t.toFixed(4));
        el.style.opacity = (inn * out).toFixed(3);
        el.style.visibility = inn * out > 0.002 ? "visible" : "hidden";
      });
      const t = (i: number) => clamp(x - i);
      const next = {
        stage: s,
        typed: Math.round(ease(0.42, 0.82, t(0)) * data.intent.length),
        checks: Math.floor(clamp(t(1) * 1.25) * 4.999),
        frameN: Math.round(ease(0.1, 0.9, t(3)) * data.facts.frames),
        lit: Math.round(ease(0.02, 0.5, t(3)) * GPUS),
        steps: Math.floor(clamp((t(4) - 0.25) * 1.6) * (data.plan.steps.length + 0.999)),
      };
      if (next.stage !== last.stage) setStage((last.stage = next.stage));
      if (next.typed !== last.typed) setTyped((last.typed = next.typed));
      if (next.checks !== last.checks) setChecks((last.checks = next.checks));
      if (next.frameN !== last.frameN) setFrameN((last.frameN = next.frameN));
      if (next.lit !== last.lit) setLit((last.lit = next.lit));
      if (next.steps !== last.steps) setSteps((last.steps = next.steps));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data]);

  // the reconstruction step's live 3D, loaded once the section is near
  useEffect(() => {
    const host = forming.current;
    if (!host || !data.frame) return;
    let dispose: (() => void) | null = null;
    let gone = false;
    let started = false;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || started) return;
      started = true;
      import("@/lib/three/forming")
        .then((m) =>
          m.mountForming(host, data.frame!, {
            amount: () => ease(0.08, 0.85, p.current * N - 3),
            active: () => {
              const x = p.current * N - 3;
              return x > -0.2 && x < 1.2;
            },
            failed: () => {},
          }),
        )
        .then((d) => {
          if (gone) d();
          else dispose = d;
        })
        .catch(() => {});
    }, { rootMargin: "50% 0px" });
    io.observe(host);
    return () => {
      gone = true;
      io.disconnect();
      dispose?.();
    };
  }, [data.frame]);

  const f = data.facts;
  const set = (i: number) => (el: HTMLDivElement | null) => {
    layers.current[i] = el;
  };
  const checkList = ["One person", "Head to toe", `${f.width} × ${f.height} portrait`, `${(f.frames / f.fps).toFixed(1)} s at ${f.fps} fps`];
  const files = [
    ["dream.json", "what it is"],
    [`frames/ × ${f.frames}`, `${f.mb} MB of Gaussians`],
    ["experience.json", "the plan"],
    ["joints.json", "22 joints per frame"],
    ["voice.m4a", "their voice"],
  ];
  return (
    <section ref={track} id="how" className="pipeline" aria-labelledby="pl-title">
      <div className="pl-sticky">
        <h2 id="pl-title" className="pl-head">How it works</h2>
        <ol className="pl-steps">
          {STAGES.map((s, i) => (
            <li key={s.title} className={i === stage ? "on" : i < stage ? "done" : ""}>
              <span className="pl-n">{i + 1}</span>
              <span className="pl-t">{s.title}</span>
            </li>
          ))}
        </ol>

        <div className="pl-view">
          {/* 1. the clip slides into the drop zone, the sentence types itself, Make */}
          <div ref={set(0)} className="pl-layer pl-drop">
            <div className="pl-zone">
              <span>Drop a video or photos</span>
            </div>
            <div className="pl-clip pl-clip-drop">
              <video src={data.clip} poster={data.clipPoster} muted loop playsInline autoPlay preload="none" aria-hidden="true" />
            </div>
            <div className="pl-form">
              <div className="pl-intent">
                <span className="pl-intent-q">What do you want to do with them?</span>
                <span className="pl-intent-a">
                  {data.intent.slice(0, typed)}
                  <i className="pl-caret" />
                </span>
              </div>
              <span className="pl-make">Make</span>
            </div>
          </div>

          {/* 2. the browser's checks tick off; the best 5 seconds are picked */}
          <div ref={set(1)} className="pl-layer pl-check">
            <div className="pl-clip">
              <video src={data.clip} poster={data.clipPoster} muted loop playsInline autoPlay preload="none" aria-hidden="true" />
              <span className="pl-scanline" />
            </div>
            <ul className="pl-checks">
              {checkList.map((c, i) => (
                <li key={c} className={i < checks ? "ok" : ""}>
                  <i aria-hidden="true" />
                  {c}
                </li>
              ))}
            </ul>
            <div className="pl-window">
              <span className="pl-window-bar" />
              <span className="pl-window-pick">best 5 s</span>
            </div>
          </div>

          {/* 3. one clip becomes 48 views */}
          <div ref={set(2)} className="pl-layer pl-views">
            <div className="pl-clip pl-clip-small">
              <video src={data.clip} poster={data.clipPoster} muted loop playsInline autoPlay preload="none" aria-hidden="true" />
            </div>
            <div className="pl-wall">
              <video src={data.wall} poster={data.wallPoster} muted loop playsInline autoPlay preload="none" aria-hidden="true" />
              <div className="pl-cells" aria-hidden="true">
                {Array.from({ length: 48 }, (_, i) => (
                  <i key={i} style={{ ["--s" as string]: (((i % 16) * 3 + Math.floor(i / 16)) / 48).toFixed(3) }} />
                ))}
              </div>
            </div>
            <p className="pl-tag">4DAnyone · {f.views} cameras · 3 rings of 16</p>
          </div>

          {/* 4. the GPUs fit her, frame by frame: live, a cloud of Gaussians pulling into her */}
          <div ref={set(3)} className="pl-layer pl-recon">
            <div ref={forming} className="pl-forming" />
            <div className="pl-gpu">
              <p className="pl-big">
                <b>{frameN}</b>
                <span>/ {f.frames} frames</span>
              </p>
              <div className="pl-chips" aria-hidden="true">
                {Array.from({ length: GPUS }, (_, i) => (
                  <i key={i} className={i < lit ? "on" : ""}>B200</i>
                ))}
              </div>
              <p className="pl-small">{f.gaussians.toLocaleString("en-US")} Gaussians per frame</p>
            </div>
          </div>

          {/* 5. the sentence becomes a plan */}
          <div ref={set(4)} className="pl-layer pl-plan">
            <p className="pl-said">&ldquo;{data.intent}&rdquo;</p>
            <span className="pl-arrow" aria-hidden="true" />
            <div className="pl-card">
              <p className="pl-card-kind">Lesson</p>
              <h3>{data.plan.title || "A lesson"}</h3>
              <ol>
                {data.plan.steps.map((s, i) => (
                  <li key={s.title} className={i < steps ? "in" : ""}>
                    <b>{s.title}</b>
                    <span>
                      {s.start.toFixed(1)}–{s.end.toFixed(1)} s · {s.speed}× · {s.repeat === 2 ? "twice" : `${s.repeat}×`}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {/* 6. the bundle goes to the headset; they're in your room */}
          <div ref={set(5)} className="pl-layer pl-ship">
            <ul className="pl-files">
              {files.map(([name, what], i) => (
                <li key={name} style={{ ["--i" as string]: i }}>
                  <b>{name}</b>
                  <span>{what}</span>
                </li>
              ))}
            </ul>
            <div className="pl-room">
              {data.preview && <video src={data.preview} muted loop playsInline autoPlay preload="none" aria-hidden="true" />}
              <span className="pl-room-tag">Quest 3S</span>
            </div>
          </div>
        </div>

        <p key={stage} className="pl-line" aria-live="polite">{STAGES[stage].line}</p>
      </div>
    </section>
  );
}
