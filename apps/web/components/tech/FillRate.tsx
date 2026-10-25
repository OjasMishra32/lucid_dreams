"use client";

import { useEffect, useRef, useState } from "react";
import meta from "./overdraw.json";

// What a person costs the headset's GPU, as a picture. Spark draws every Gaussian as a quad out to k standard
// deviations, whatever its opacity, so the work is how many quads land on each pixel. overdraw.bin holds, for one real
// frame of each person seen face on from 1.8 m, how many quads cover each centimetre of them (scripts/overdraw.py), in
// three states: every Gaussian as Spark draws it by default, what the headset draws (the 160k that add most, 70%
// resolution) and the governor's lowest step. Cells are 255·log1p(layers)/log1p(top).

type Who = keyof typeof meta.people;
type StateKey = "all" | "headset" | "load";

const PEOPLE: { key: Who; name: string }[] = [
  { key: "jump", name: "Jump shot" },
  { key: "dancer", name: "Dancer" },
];
const STATES: { key: StateKey; name: string; line: (n: number) => string }[] = [
  { key: "all", name: "Every Gaussian", line: (n) => `All ${n.toLocaleString("en-US")} Gaussians, each quad out to 2.8σ, at 80% resolution.` },
  { key: "headset", name: "On the headset", line: () => "The 160,000 that add the most, at 70% resolution." },
  { key: "load", name: "Under load", line: () => "The governor's lowest step: quads cut to 1.9σ, faint ones (α under 0.03) skipped." },
];

// black, deep blue, the site's blue, light blue, white
const STOPS: [number, [number, number, number]][] = [
  [0, [6, 8, 14]],
  [0.18, [10, 28, 74]],
  [0.42, [20, 82, 184]],
  [0.64, [41, 151, 255]],
  [0.84, [140, 200, 255]],
  [1, [255, 255, 255]],
];
const RAMP = (() => {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < STOPS.length - 1 && STOPS[k][0] < t) k++;
    const [t0, c0] = STOPS[k - 1];
    const [t1, c1] = STOPS[k];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    for (let j = 0; j < 3; j++) out[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
  }
  return out;
})();
const rampCss = `linear-gradient(90deg, ${STOPS.map(([t, c]) => `rgb(${c.join(",")}) ${t * 100}%`).join(", ")})`;

let data: Promise<Uint8Array> | null = null;
const load = () => (data ??= fetch("/media/overdraw.bin").then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)));

export default function FillRate() {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [who, setWho] = useState<Who>("jump");
  const [state, setState] = useState<StateKey>("headset");
  const [bin, setBin] = useState<Uint8Array | null>(null);
  const shown = useRef<Float32Array | null>(null); // the grid on screen, eased toward the chosen one

  const p = meta.people[who];
  const st = p.states.find((s) => s.key === state)!;
  const most = Math.max(...p.states.map((s) => s.pixels));

  // fetch the maps once the section is near
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        load().then(setBin).catch(() => {});
      },
      { rootMargin: "50% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // draw the chosen map, easing from the one before so the change reads as quads appearing or going away
  useEffect(() => {
    const c = canvas.current;
    if (!c || !bin) return;
    const { w, h } = p;
    const target = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) target[i] = bin[st.offset + i];
    const from = shown.current && shown.current.length === target.length ? shown.current.slice() : target.slice();
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    const now = new Float32Array(w * h);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0;
    const frame = () => {
      const u = still ? 1 : Math.min(1, (performance.now() - t0) / 450);
      const e = u * u * (3 - 2 * u);
      for (let i = 0; i < w * h; i++) {
        const q = from[i] + (target[i] - from[i]) * e;
        now[i] = q;
        const k = Math.round(q) * 3;
        img.data[i * 4] = RAMP[k];
        img.data[i * 4 + 1] = RAMP[k + 1];
        img.data[i * 4 + 2] = RAMP[k + 2];
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      shown.current = now;
      if (u < 1) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [bin, p, st]);

  // the legend's ticks: where 1, 10, 100 and 1,000 quads sit on the log scale
  const at = (v: number) => (Math.log1p(v) / Math.log1p(p.top)) * 100;
  const ticks = [1, 10, 100, 1000].filter((v) => v < p.top);

  return (
    <div className="fill" ref={host}>
      <div className="fill-map">
        <canvas ref={canvas} aria-label={`How many quads the GPU draws on each spot of the ${PEOPLE.find((x) => x.key === who)!.name.toLowerCase()}: ${STATES.find((x) => x.key === state)!.name.toLowerCase()}`} />
        {!bin && <span className="fill-wait">Loading the map</span>}
      </div>

      <div className="fill-side">
        <div className="seg" role="group" aria-label="Whose frame">
          {PEOPLE.map((x) => (
            <button key={x.key} className={who === x.key ? "on" : ""} onClick={() => setWho(x.key)}>
              {x.name}
            </button>
          ))}
        </div>

        <p className="fill-big">
          <b>{Math.round(st.pixels / 1e6)} million</b>
          <span>pixels shaded per eye, every frame</span>
        </p>
        <p className="fill-line">
          That&apos;s {Math.round(st.pixels / st.eyePixels)}× the eye&apos;s own {(st.eyePixels / 1e6).toFixed(1)} million. The
          busiest spots get about {(Math.round(st.peak / 100) * 100).toLocaleString("en-US")} quads stacked on them.
        </p>

        <div className="fill-states" role="group" aria-label="What gets drawn">
          {STATES.map((x) => {
            const s = p.states.find((y) => y.key === x.key)!;
            return (
              <button key={x.key} className={state === x.key ? "on" : ""} onClick={() => setState(x.key)} aria-pressed={state === x.key}>
                <span className="fill-name">{x.name}</span>
                <span className="fill-num">{Math.round(s.pixels / 1e6)} M</span>
                <i style={{ width: `${(s.pixels / most) * 100}%` }} />
              </button>
            );
          })}
        </div>
        <p className="fill-note">{STATES.find((x) => x.key === state)!.line(p.n)}</p>

        <div className="fill-legend" aria-hidden="true">
          <i style={{ background: rampCss }} />
          <div>
            {ticks.map((v) => (
              <span key={v} style={{ left: `${at(v)}%` }}>{v.toLocaleString("en-US")}</span>
            ))}
          </div>
          <p>quads on that spot</p>
        </div>
      </div>
    </div>
  );
}
