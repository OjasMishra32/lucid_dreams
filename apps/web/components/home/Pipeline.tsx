"use client";

import { useEffect, useRef, useState } from "react";
import type { VishalPipeline } from "@/lib/scenes";

// How it works, start to finish, followed through one real person: Vishal. His video picked from a phone's camera
// roll, one sentence typed, the 14 frames picked from it, his 3D body forming live (his avatar's own Gaussians), his
// voice memo, then him in your room answering in his own voice. One pinned scroll; the scroll drives everything
// straight in the DOM, and React only re-renders when a number, a letter or a lit item changes.

const STAGES = [
  { title: "Pick a video", line: "Any video from your camera roll. Here, Vishal turning around once." },
  { title: "Say what you want", line: "One sentence. He wants to hang out and talk." },
  { title: "Best frames", line: "We pick the 14 sharpest frames, from every side." },
  { title: "3D body and face", line: "LHM++ builds a rigged 3D body from those frames. UIKA sharpens the face." },
  { title: "His voice", line: "A 50-second voice memo is enough to clone his voice." },
  { title: "In your room", line: "He stands in your room at his real height. Ask him anything and he answers out loud." },
];
const N = STAGES.length;

// the roll's other videos show their real lengths; stills from the app are photos
const LENGTH: Record<string, string> = { v108: "0:16", v109: "0:40", dance: "0:05" };
const length = (src: string) => LENGTH[src.split("/").pop()!.replace(/(-\d+)?\.jpg$/, "")];

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export default function Pipeline({ data }: { data: VishalPipeline }) {
  const track = useRef<HTMLElement>(null);
  const layers = useRef<(HTMLDivElement | null)[]>([]);
  const forming = useRef<HTMLDivElement>(null);
  const p = useRef(0);
  const [stage, setStage] = useState(0);
  const [typed, setTyped] = useState(0);
  const [picked, setPicked] = useState(0);
  const [bars, setBars] = useState(0);

  useEffect(() => {
    const root = track.current;
    if (!root) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const last = { stage: -1, typed: -1, picked: -1, bars: -1 };
    const env = data.voice.env.length || 1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const r = root.getBoundingClientRect();
      if (r.bottom < -50 || r.top > innerHeight + 50) return;
      const target = clamp(-r.top / Math.max(1, r.height - innerHeight));
      p.current += (target - p.current) * (still ? 1 : 0.18);
      const x = p.current * N;
      layers.current.forEach((el, i) => {
        if (!el) return;
        const inn = i === 0 ? 1 : ease(-0.03, 0.07, x - i);
        const out = i === N - 1 ? 1 : 1 - ease(0.93, 1.0, x - i);
        el.style.setProperty("--t", clamp(x - i).toFixed(4));
        el.style.opacity = (inn * out).toFixed(3);
        el.style.visibility = inn * out > 0.002 ? "visible" : "hidden";
      });
      const t = (i: number) => clamp(x - i);
      const next = {
        stage: Math.min(N - 1, Math.floor(x)),
        typed: Math.round(ease(0.2, 0.7, t(1)) * data.intent.length),
        picked: Math.round(ease(0.1, 0.85, t(2)) * data.frames.length),
        bars: Math.round(ease(0.05, 0.9, t(4)) * env),
      };
      if (next.stage !== last.stage) setStage((last.stage = next.stage));
      if (next.typed !== last.typed) setTyped((last.typed = next.typed));
      if (next.picked !== last.picked) setPicked((last.picked = next.picked));
      if (next.bars !== last.bars) setBars((last.bars = next.bars));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data]);

  // his body forming live: his avatar's own Gaussians pulling together, loaded once the section is near
  useEffect(() => {
    const host = forming.current;
    if (!host) return;
    let dispose: (() => void) | null = null;
    let gone = false;
    let started = false;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || started) return;
      started = true;
      import("@/lib/three/forming")
        .then((m) =>
          m.mountForming(host, data.avatar, {
            amount: () => ease(0.1, 0.8, p.current * N - 3),
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
    }, { rootMargin: "60% 0px" });
    io.observe(host);
    return () => {
      gone = true;
      io.disconnect();
      dispose?.();
    };
  }, [data.avatar]);

  const set = (i: number) => (el: HTMLDivElement | null) => {
    layers.current[i] = el;
  };
  const f = data.facts;
  const env = data.voice.env;
  const tk = data.talk;
  const sec = (s: number) => `${s.toFixed(1)} s`;
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
          {/* 1. a phone's camera roll; a tap on his video opens it */}
          <div ref={set(0)} className="pl-layer pl-center">
            <div className="ph">
              <div className="ph-screen">
                <p className="ph-title">Recents</p>
                <div className="ph-grid">
                  {data.roll.map((src, i) => (
                    <span key={i} className={i === 4 ? "ph-tile ph-pick" : "ph-tile"} style={{ backgroundImage: `url(${src})` }}>
                      {length(src) && <em>{length(src)}</em>}
                    </span>
                  ))}
                </div>
                <span className="ph-tap" aria-hidden="true" />
                <div className="ph-full">
                  <video src={data.clip} poster={data.poster} muted loop playsInline autoPlay preload="none" aria-hidden="true" />
                </div>
              </div>
            </div>
          </div>

          {/* 2. the app: his video attached, one sentence, Make */}
          <div ref={set(1)} className="pl-layer pl-center">
            <div className="ph">
              <div className="ph-screen ph-app">
                <p className="ph-brand">Lucid Dreams</p>
                <p className="ph-h">Make your own</p>
                <div className="ph-attach">
                  <video src={data.clip} poster={data.poster} muted loop playsInline autoPlay preload="none" aria-hidden="true" />
                  <span><b>IMG_0108.MOV</b>Video · 0:16</span>
                </div>
                <p className="ph-q">What do you want to do with them?</p>
                <p className="ph-field">
                  {data.intent.slice(0, typed)}
                  <i className="pl-caret" />
                </p>
                <span className="ph-make">Make</span>
              </div>
            </div>
          </div>

          {/* 3. the 14 sharpest frames, out of the video */}
          <div ref={set(2)} className="pl-layer pl-frames">
            <div className="ph ph-small">
              <div className="ph-screen">
                <video src={data.clip} poster={data.poster} muted loop playsInline autoPlay preload="none" aria-hidden="true" />
              </div>
            </div>
            <div className="fr-side">
              <div className="fr-grid">
                {data.frames.map((src, i) => (
                  <img key={src} src={src} alt="" loading="lazy" className={i < picked ? "in" : ""} />
                ))}
              </div>
              <p className="pl-count">
                <b>{picked}</b> / {data.frames.length} frames
              </p>
            </div>
          </div>

          {/* 4. his 3D body forming from the frames, live */}
          <div ref={set(3)} className="pl-layer pl-body">
            <div ref={forming} className="pl-forming" />
            <ul className="bd-facts">
              <li><b>{f.gaussians.toLocaleString("en-US")}</b> Gaussians</li>
              <li><b>{f.height.toFixed(2)} m</b> tall, real size</li>
              <li><b>55</b> joints (SMPL-X rig)</li>
            </ul>
          </div>

          {/* 5. his voice memo becomes his voice */}
          <div ref={set(4)} className="pl-layer pl-voice">
            <p className="vc-file">New Recording · 0:{String(Math.round(data.voice.seconds)).padStart(2, "0")}</p>
            <div className="vc-wave" aria-hidden="true">
              {env.map((v, i) => (
                <i key={i} className={i < bars ? "on" : ""} style={{ height: `${8 + v * 92}%` }} />
              ))}
            </div>
            <p className="vc-out">Cloned voice: <b>Vishal</b></p>
          </div>

          {/* 6. him in your room, answering */}
          <div ref={set(5)} className="pl-layer pl-room-l">
            <div className="pl-room">
              {data.preview && <video src={data.preview} muted loop playsInline autoPlay preload="none" aria-hidden="true" />}
              <span className="pl-talk">Talk</span>
            </div>
            <div className="tk-side">
              {tk && (
                <ol className="tk-steps">
                  <li><b>You ask</b><span>press Talk on your palm and speak</span></li>
                  <li><b>Heard</b><span>{sec(tk.heard)} · speech to text</span></li>
                  <li><b>Reply</b><span>{sec(tk.wrote)} · a language model writes it as him</span></li>
                  <li><b>Spoken</b><span>{sec(tk.spoke)} · in his cloned voice</span></li>
                  <li className="tk-total"><b>{sec(tk.total)}</b><span>question to answer, median of {tk.n} tries</span></li>
                </ol>
              )}
              <a className="tk-try" href="/xr/?dream=vishal">Open him in your room</a>
            </div>
          </div>
        </div>

        <p key={stage} className="pl-line" aria-live="polite">{STAGES[stage].line}</p>
      </div>
    </section>
  );
}
