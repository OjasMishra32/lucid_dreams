"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// The tennis ball's flight, from the game's own model (apps/webxr/src/tennis/physics.ts), in the vertical plane of the
// shot: gravity, quadratic drag, Magnus lift from its spin (C_L = min(0.32, 1 / (2 + v / rω))), spin that decays in
// the air, and the grass bounce (restitution falling with impact speed, friction at the contact patch trading pace for
// spin). One fixed step of 1/240 s. Three shots at the same speed and angle: flat, topspin and slice.

const R = 0.0335;
const M = 0.057;
const AREA = Math.PI * R * R;
const RHO = 1.21;
const KD = (0.5 * RHO * 0.55 * AREA) / M;
const KL = (0.5 * RHO * AREA) / M;
const G = 9.81;
const H = 1 / 240;
const MU = 0.42;
const DECAY = 1 / 7;
const HALF = 11.885; // baseline to net
const NET = 0.914;

interface Flight {
  pts: [number, number][];
  bounce: [number, number] | null;
  net: boolean;
}

/** w: spin about the axis across the court, rad/s; negative is topspin for a ball going +x. */
function fly(speed: number, deg: number, rpm: number, spin: "flat" | "top" | "slice"): Flight {
  const a = (deg * Math.PI) / 180;
  let x = -HALF - 0.6;
  let y = 1.0;
  let vx = speed * Math.cos(a);
  let vy = speed * Math.sin(a);
  let w = spin === "flat" ? 0 : ((spin === "top" ? -1 : 1) * rpm * 2 * Math.PI) / 60;
  const pts: [number, number][] = [[x, y]];
  let bounce: [number, number] | null = null;
  let net = false;
  for (let t = 0; t < 4 && x < HALF + 6; t += H) {
    const s = Math.hypot(vx, vy);
    let ax = -KD * s * vx;
    let ay = -G - KD * s * vy;
    if (s > 0.5 && Math.abs(w) > 1) {
      const cl = Math.min(0.32, 1 / (2 + s / (R * Math.abs(w))));
      // (ω ẑ) × v, normalised: perpendicular to the flight, down for topspin
      const sg = Math.sign(w);
      ax += KL * cl * s * s * ((-sg * vy) / s);
      ay += KL * cl * s * s * ((sg * vx) / s);
    }
    vx += ax * H;
    vy += ay * H;
    const px = x;
    x += vx * H;
    y += vy * H;
    w *= 1 - H * DECAY;
    if (px < 0 && x >= 0 && y - R < NET) {
      net = true;
      pts.push([0, y]);
      break;
    }
    if (y < R && vy < 0) {
      y = R;
      const vn = -vy;
      const e = Math.min(0.76, Math.max(0.62, 0.78 - 0.007 * vn));
      vy = vn * e;
      const u = vx + R * w;
      if (Math.abs(u) > 1e-6) {
        const j = Math.min(MU * (1 + e) * vn, 0.4 * Math.abs(u));
        const jx = -Math.sign(u) * j;
        vx += jx;
        w += (1.5 / R) * jx;
      }
      vx *= 0.975;
      if (!bounce) bounce = [x, 0];
      else {
        pts.push([x, y]);
        break;
      }
    }
    pts.push([x, y]);
  }
  return { pts, bounce, net };
}

const SHOTS = [
  { key: "flat", name: "Flat", color: "#f5f5f7" },
  { key: "top", name: "Topspin", color: "#2997ff" },
  { key: "slice", name: "Slice", color: "#ff9f0a" },
] as const;

export default function Trajectories() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [speed, setSpeed] = useState(22);
  const [deg, setDeg] = useState(13);
  const [rpm, setRpm] = useState(1800);
  const flights = useMemo(() => SHOTS.map((s) => ({ ...s, f: fly(speed, deg, rpm, s.key) })), [speed, deg, rpm]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const draw = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const W = c.clientWidth;
      const Hh = c.clientHeight;
      c.width = Math.round(W * dpr);
      c.height = Math.round(Hh * dpr);
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, Hh);
      const x0 = -HALF - 1.5;
      const x1 = HALF + 3;
      const yMax = 4.2;
      const ground = Hh - 28;
      const kx = W / (x1 - x0);
      const ky = (ground - 12) / yMax;
      const X = (x: number) => (x - x0) * kx;
      const Y = (y: number) => ground - y * ky;
      // the court in profile: ground, baselines, service lines, net
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ground);
      ctx.lineTo(W, ground);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "12px -apple-system, system-ui, sans-serif";
      for (const [x, label] of [[-HALF, "baseline"], [-6.4, "service line"], [6.4, "service line"], [HALF, "baseline"]] as const) {
        ctx.fillRect(X(x) - 0.5, ground - 4, 1, 8);
        ctx.fillText(label, X(x) - ctx.measureText(label).width / 2, ground + 18);
      }
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillRect(X(0) - 1.5, Y(NET), 3, ground - Y(NET));
      // the flights
      for (const s of flights) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        s.f.pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
        ctx.stroke();
        if (s.f.bounce) {
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(X(s.f.bounce[0]), ground, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [flights]);

  return (
    <div className="traj">
      <canvas ref={canvas} className="traj-canvas" aria-label="Three tennis shots at the same speed and angle: flat, topspin and slice" />
      <div className="traj-controls">
        <label>Speed <b>{speed} m/s</b><input type="range" min={12} max={45} step={1} value={speed} onChange={(e) => setSpeed(+e.target.value)} /></label>
        <label>Launch <b>{deg}°</b><input type="range" min={-4} max={22} step={0.5} value={deg} onChange={(e) => setDeg(+e.target.value)} /></label>
        <label>Spin <b>{rpm.toLocaleString("en-US")} rpm</b><input type="range" min={0} max={4500} step={100} value={rpm} onChange={(e) => setRpm(+e.target.value)} /></label>
      </div>
      <ul className="traj-legend">
        {flights.map((s) => (
          <li key={s.key}>
            <i style={{ background: s.color }} />
            {s.name}
            <span className="quiet">
              {s.f.net ? "into the net" : s.f.bounce ? `lands ${s.f.bounce[0].toFixed(1)} m past the net${s.f.bounce[0] > HALF ? ", out" : ""}` : "long"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
