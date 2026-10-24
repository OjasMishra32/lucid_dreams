"use client";

import { useState } from "react";

// What a person costs the headset's GPU, from their own Gaussians. Spark draws every Gaussian as a quad out to k
// standard deviations along its two longest axes, whatever its opacity, so the pixels shaded per eye are
// Σᵢ 4k²·σ₁ᵢσ₂ᵢ·(f/z)² (face on; the sum measured over one real frame of each person, by the budget the headset keeps
// and the faintest opacity it still draws). f is the eye's focal length in pixels: W / (2·tan(FOV/2)).

// Σ σ₁σ₂ in m², by budget (Gaussians kept, the ones adding most to the picture first) and by the opacity floor
const SUMS: Record<string, { n: number; budgets: Record<string, Record<string, number>> }> = {
  lebron: { n: 293718, budgets: { "293718": { "0.002": 42.503, "0.01": 40.995, "0.018": 39.503, "0.025": 38.159, "0.03": 37.382 }, "220000": { "0.002": 41.571, "0.01": 40.322, "0.018": 39.042, "0.025": 37.863, "0.03": 37.145 }, "160000": { "0.002": 39.294, "0.01": 38.593, "0.018": 37.689, "0.025": 36.789, "0.03": 36.195 }, "120000": { "0.002": 36.189, "0.01": 35.951, "0.018": 35.457, "0.025": 34.889, "0.03": 34.459 }, "80000": { "0.002": 30.824, "0.01": 30.815, "0.018": 30.713, "0.025": 30.528, "0.03": 30.347 } } },
  dancer: { n: 293516, budgets: { "293516": { "0.002": 34.145, "0.01": 32.423, "0.018": 30.559, "0.025": 28.691, "0.03": 27.697 }, "220000": { "0.002": 33.489, "0.01": 31.942, "0.018": 30.3, "0.025": 28.56, "0.03": 27.605 }, "160000": { "0.002": 32.176, "0.01": 30.873, "0.018": 29.497, "0.025": 28.018, "0.03": 27.168 }, "120000": { "0.002": 30.576, "0.01": 29.58, "0.018": 28.431, "0.025": 27.177, "0.03": 26.432 }, "80000": { "0.002": 27.773, "0.01": 27.189, "0.018": 26.409, "0.025": 25.477, "0.03": 24.902 } } },
};
const ALPHAS = ["0.002", "0.01", "0.018", "0.025", "0.03"];
const EYE_W = 1832; // Quest 3S, per eye
const EYE_H = 1920;
const FOV = 96; // degrees, horizontal
const HZ = 72;

// the governor's levels (apps/webxr/src/xr/quality.ts), sharpest first
const LEVELS = [
  { k: 2.83, alpha: 0, fov: 0.3 },
  { k: 2.5, alpha: 1, fov: 0.5 },
  { k: 2.3, alpha: 2, fov: 0.7 },
  { k: 2.1, alpha: 3, fov: 1 },
  { k: 1.9, alpha: 4, fov: 1 },
];

export default function FillRate() {
  const [who, setWho] = useState<"lebron" | "dancer">("lebron");
  const [z, setZ] = useState(1.8);
  const [res, setRes] = useState(0.7);
  const [budget, setBudget] = useState(2); // index into the budgets: 160,000, what the headset keeps
  const [level, setLevel] = useState(1);
  const p = SUMS[who];
  const budgets = Object.keys(p.budgets).sort((a, b) => +b - +a);
  const L = LEVELS[level];
  const S = p.budgets[budgets[budget]][ALPHAS[L.alpha]];
  const w = EYE_W * res;
  const h = EYE_H * res;
  const f = w / (2 * Math.tan(((FOV / 2) * Math.PI) / 180));
  const perEye = 4 * L.k * L.k * S * (f / z) ** 2; // pixels shaded per eye, per frame
  const screen = w * h;
  const perSecond = perEye * 2 * HZ;
  const full = 4 * 8 * p.budgets[budgets[0]][ALPHAS[0]] * ((EYE_W * 0.8) / (2 * Math.tan(((FOV / 2) * Math.PI) / 180)) / z) ** 2;
  const share = perEye / full;
  return (
    <div className="fill">
      <div className="fill-controls">
        <div className="seg" role="group" aria-label="Whose frame">
          <button className={who === "lebron" ? "on" : ""} onClick={() => setWho("lebron")}>Jump shot</button>
          <button className={who === "dancer" ? "on" : ""} onClick={() => setWho("dancer")}>Dancer</button>
        </div>
        <label>Distance <b>{z.toFixed(1)} m</b><input type="range" min={0.6} max={4} step={0.1} value={z} onChange={(e) => setZ(+e.target.value)} /></label>
        <label>Resolution <b>{Math.round(res * 100)}%</b><input type="range" min={0.5} max={1} step={0.05} value={res} onChange={(e) => setRes(+e.target.value)} /></label>
        <label>Budget <b>{(+budgets[budget]).toLocaleString("en-US")} Gaussians</b><input type="range" min={0} max={budgets.length - 1} step={1} value={budget} onChange={(e) => setBudget(+e.target.value)} /></label>
        <label>Governor level <b>{level} · k = {L.k} · α ≥ {ALPHAS[L.alpha]} · foveation {L.fov}</b><input type="range" min={0} max={LEVELS.length - 1} step={1} value={level} onChange={(e) => setLevel(+e.target.value)} /></label>
      </div>
      <div className="fill-out">
        <div className="fill-big">
          <b>{(perEye / 1e6).toFixed(0)}</b>
          <span>million pixels shaded per eye, per frame</span>
        </div>
        <div className="fill-bar" aria-hidden="true">
          <i style={{ width: `${Math.min(100, share * 100)}%` }} />
        </div>
        <p className="quiet fill-cap">{Math.round(share * 100)}% of the same frame drawn untrimmed at 80% resolution and k = √8.</p>
        <dl className="fill-facts">
          <div><dt>the eye&apos;s own pixels</dt><dd>{(screen / 1e6).toFixed(2)} M ({Math.round(w)} × {Math.round(h)})</dd></div>
          <div><dt>overdraw</dt><dd>{(perEye / screen).toFixed(0)}× the whole eye</dd></div>
          <div><dt>blended fragments</dt><dd>{(perSecond / 1e9).toFixed(1)} billion a second (2 eyes × {HZ} Hz)</dd></div>
          <div><dt>focal length</dt><dd>{f.toFixed(0)} px ({FOV}° across)</dd></div>
          <div><dt>Σ σ₁σ₂</dt><dd>{S.toFixed(1)} m² of Gaussian cross-section</dd></div>
        </dl>
      </div>
    </div>
  );
}
