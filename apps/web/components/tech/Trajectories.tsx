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

const SLOW = 0.55; // the flights play at a bit over half speed
const HOLD = 1.4; // seconds to rest on the landings before they fly again

function where(f: Flight): string {
  if (f.net) return "into the net";
  if (!f.bounce) return "long";
  const d = f.bounce[0];
  if (d < 0) return "short";
  return d > HALF ? "out" : `${d.toFixed(1)} m`;
}

export default function Trajectories() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [speed, setSpeed] = useState(22);
  const [deg, setDeg] = useState(13);
  const [rpm, setRpm] = useState(1800);
  const flights = useMemo(() => SHOTS.map((s) => ({ ...s, f: fly(speed, deg, rpm, s.key) })), [speed, deg, rpm]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = c.getContext("2d")!;
    const longest = Math.max(...flights.map((s) => s.f.pts.length)) * H;
    const cycle = longest / SLOW + HOLD;
    let W = 0;
    let Hh = 0;
    let visible = false;
    let raf = 0;
    const t0 = performance.now();

    const size = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      W = c.clientWidth;
      Hh = c.clientHeight;
      c.width = Math.round(W * dpr);
      c.height = Math.round(Hh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const paint = (now: number) => {
      const small = W < 560;
      const band = small ? 58 : 64; // the grass under the court line, where the labels go
      const ground = Hh - band;
      const x0 = -HALF - 1.2;
      const x1 = HALF + 2.2;
      const yMax = 4.1;
      const kx = W / (x1 - x0);
      const ky = (ground - 16) / yMax;
      const X = (x: number) => (x - x0) * kx;
      const Y = (y: number) => ground - y * ky;
      const t = still ? longest : ((now - t0) / 1000) % cycle * SLOW; // flight time shown, in seconds

      ctx.clearRect(0, 0, W, Hh);
      // the air, then the grass
      const air = ctx.createLinearGradient(0, 0, 0, ground);
      air.addColorStop(0, "#0a0b0d");
      air.addColorStop(1, "#0b120d");
      ctx.fillStyle = air;
      ctx.fillRect(0, 0, W, ground);
      const grass = ctx.createLinearGradient(0, ground, 0, Hh);
      grass.addColorStop(0, "#143820");
      grass.addColorStop(1, "#0a1a10");
      ctx.fillStyle = grass;
      ctx.fillRect(0, ground, W, band);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(X(-HALF), ground - 1, X(HALF) - X(-HALF), 2); // the court, baseline to baseline
      // the lines across the court
      ctx.font = `${small ? 11 : 12}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center";
      for (const [x, label] of [[-HALF, "baseline"], [-6.4, "service line"], [6.4, "service line"], [HALF, "baseline"]] as const) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillRect(X(x) - 1.5, ground - 1, 3, 7);
        if (!small) {
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.fillText(label, X(x), ground + 22);
        }
      }
      // the net in profile: post, mesh, tape
      const nx = X(0);
      ctx.fillStyle = "#8e8e93";
      ctx.fillRect(nx - 1.5, Y(1.07), 3, ground - Y(1.07));
      ctx.save();
      ctx.beginPath();
      ctx.rect(nx - 5, Y(NET), 10, ground - Y(NET));
      ctx.clip();
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      for (let y = Y(NET) - 10; y < ground + 10; y += 5) {
        ctx.beginPath();
        ctx.moveTo(nx - 6, y);
        ctx.lineTo(nx + 6, y + 6);
        ctx.moveTo(nx + 6, y);
        ctx.lineTo(nx - 6, y + 6);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = "#f5f5f7";
      ctx.fillRect(nx - 6, Y(NET) - 2, 12, 3);

      // the flights: where each will go, faint; where it has been, bright; the ball and its shadow
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, ground + 1);
      ctx.clip();
      for (const s of flights) {
        const pts = s.f.pts;
        const n = Math.min(pts.length - 1, Math.floor(t / H));
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = s.color;
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
        ctx.stroke();
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        for (let i = 0; i <= n; i++) (i ? ctx.lineTo(X(pts[i][0]), Y(pts[i][1])) : ctx.moveTo(X(pts[i][0]), Y(pts[i][1])));
        ctx.stroke();
        ctx.globalAlpha = 1;
        const [bx, by] = pts[n];
        if (X(bx) < W) {
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.beginPath();
          ctx.ellipse(X(bx), ground + 1, Math.max(2, 7 - by), 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowColor = s.color;
          ctx.shadowBlur = 14;
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(X(bx), Y(by), small ? 4.5 : 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
      ctx.restore();

      // where each one lands, once it has: a ring on the court and its name in the grass, stacked when they're close
      const placed: { x: number; row: number }[] = [];
      ctx.font = `600 ${small ? 12 : 13}px -apple-system, system-ui, sans-serif`;
      for (const s of flights) {
        const f = s.f;
        const at = f.net ? [0, NET] : f.bounce;
        if (!at) continue;
        const landedAt = f.pts.findIndex(([x]) => x >= at[0]) * H;
        if (t < landedAt) continue;
        const x = Math.min(W - 6, X(at[0]));
        if (!f.net) {
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(x, ground, 7, 2.6, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        const label = `${s.name} ${where(f)}`;
        const w = ctx.measureText(label).width;
        let row = 0;
        while (placed.some((p) => p.row === row && Math.abs(p.x - x) < w + 12)) row++;
        placed.push({ x, row });
        const lx = Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, x));
        const ly = ground + (small ? 22 : 40) + row * 17;
        ctx.fillStyle = s.color;
        ctx.textAlign = "center";
        ctx.fillText(label, lx, Math.min(Hh - 6, ly));
      }

    };
    const loop = (now: number) => {
      paint(now);
      if (visible && !still) raf = requestAnimationFrame(loop);
    };

    size();
    paint(performance.now());
    const ro = new ResizeObserver(() => {
      size();
      paint(performance.now());
    });
    ro.observe(c);
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      cancelAnimationFrame(raf);
      if (visible) raf = requestAnimationFrame(loop);
    });
    io.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [flights]);

  return (
    <div className="traj">
      <div className="traj-card">
        <ul className="traj-key" aria-hidden="true">
          {SHOTS.map((s) => (
            <li key={s.key}><i style={{ background: s.color }} />{s.name}</li>
          ))}
        </ul>
        <canvas
          ref={canvas}
          className="traj-canvas"
          aria-label={`Three tennis shots at ${speed} m/s and ${deg} degrees: ${flights.map((s) => `${s.name.toLowerCase()} ${where(s.f)}`).join(", ")}`}
        />
      </div>
      <p className="traj-cap">Same speed and angle, three spins. Each label is where that ball lands, in metres past the net.</p>
      <div className="traj-controls">
        <label>Speed <b>{speed} m/s</b><input type="range" min={12} max={45} step={1} value={speed} onChange={(e) => setSpeed(+e.target.value)} /></label>
        <label>Launch <b>{deg}°</b><input type="range" min={-4} max={22} step={0.5} value={deg} onChange={(e) => setDeg(+e.target.value)} /></label>
        <label>Spin <b>{rpm.toLocaleString("en-US")} rpm</b><input type="range" min={0} max={4500} step={100} value={rpm} onChange={(e) => setRpm(+e.target.value)} /></label>
      </div>
    </div>
  );
}
