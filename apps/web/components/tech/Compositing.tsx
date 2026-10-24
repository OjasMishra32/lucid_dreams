"use client";

import { useEffect, useRef, useState } from "react";

// One pixel's ray through a slice of Gaussians, computed the way the GPU does it. Seen from above: the camera at the
// bottom, depth going up, nine 2D Gaussians in the slice. Each projects onto the image line as a 1D Gaussian of
// variance Σ'ₓₓ; along the pixel's ray, sorted near to far, each one's alpha is αᵢ = oᵢ·exp(-½ dᵢ²/Σ'ₓₓ) and what is
// left to see behind it is Tᵢ = Πⱼ<ᵢ (1 − αⱼ). The pixel is C = Σ cᵢ αᵢ Tᵢ. Under it, the whole image row from the
// same sum. Drag along the image to move the pixel.

interface G2 {
  x: number;
  z: number;
  sx: number; // projected std dev along the image line
  sz: number;
  rot: number;
  o: number;
  c: [number, number, number];
}

const SLICE: G2[] = [
  { x: -0.55, z: 0.9, sx: 0.26, sz: 0.12, rot: 0.3, o: 0.55, c: [0.93, 0.78, 0.62] },
  { x: -0.15, z: 1.25, sx: 0.32, sz: 0.1, rot: -0.2, o: 0.8, c: [0.85, 0.36, 0.3] },
  { x: 0.35, z: 0.75, sx: 0.18, sz: 0.16, rot: 0.6, o: 0.35, c: [0.98, 0.94, 0.86] },
  { x: 0.1, z: 1.7, sx: 0.4, sz: 0.14, rot: 0.1, o: 0.9, c: [0.16, 0.36, 0.72] },
  { x: 0.62, z: 1.45, sx: 0.22, sz: 0.2, rot: -0.5, o: 0.7, c: [0.95, 0.66, 0.2] },
  { x: -0.7, z: 1.9, sx: 0.3, sz: 0.11, rot: 0.25, o: 0.85, c: [0.32, 0.62, 0.42] },
  { x: -0.3, z: 0.55, sx: 0.12, sz: 0.09, rot: 0, o: 0.25, c: [1, 1, 1] },
  { x: 0.85, z: 0.95, sx: 0.15, sz: 0.24, rot: 0.9, o: 0.6, c: [0.55, 0.42, 0.8] },
  { x: -0.05, z: 2.2, sx: 0.55, sz: 0.18, rot: 0, o: 0.95, c: [0.12, 0.13, 0.16] },
];

function along(xp: number) {
  const hits = SLICE.map((g, i) => {
    // the variance its footprint has along the image line, from its rotated 2D covariance
    const co = Math.cos(g.rot);
    const si = Math.sin(g.rot);
    const vxx = co * co * g.sx * g.sx + si * si * g.sz * g.sz;
    const d = xp - g.x;
    const m = (d * d) / vxx;
    const alpha = m > 8 ? 0 : g.o * Math.exp(-0.5 * m);
    return { i, g, alpha };
  }).sort((a, b) => a.g.z - b.g.z);
  let T = 1;
  const rgb = [0, 0, 0];
  const rows = hits.map((h) => {
    const w = h.alpha * T;
    for (let k = 0; k < 3; k++) rgb[k] += h.g.c[k] * w;
    const row = { ...h, T, w };
    T *= 1 - h.alpha;
    return row;
  });
  return { rows, rgb, T };
}

export default function Compositing() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [xp, setXp] = useState(0.18);
  const r = along(xp);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const draw = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const W = c.clientWidth;
      const H = c.clientHeight;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const rowH = 34;
      const top = 14;
      const plotH = H - rowH - 40;
      const sx = (x: number) => W / 2 + x * (W * 0.42);
      const sz = (z: number) => top + plotH - (z / 2.6) * plotH;
      // the Gaussians in the slice
      for (const g of SLICE) {
        ctx.save();
        ctx.translate(sx(g.x), sz(g.z));
        ctx.rotate(-g.rot);
        const rx = g.sx * W * 0.42;
        const rz = (g.sz / 2.6) * plotH;
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        const [cr, cg, cb] = g.c.map((v) => Math.round(v * 255));
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},${g.o})`);
        grad.addColorStop(0.5, `rgba(${cr},${cg},${cb},${g.o * 0.6})`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.scale(rx * 2.2, rz * 2.2);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // the camera and its ray
      const camY = top + plotH + 6;
      ctx.strokeStyle = "rgba(41,151,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sx(xp), camY);
      ctx.lineTo(sx(xp), top);
      ctx.stroke();
      ctx.setLineDash([]);
      // the weight each one gives this pixel, where the ray meets it
      for (const h of r.rows) {
        if (h.w < 0.004) continue;
        const y = sz(h.g.z);
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(sx(xp), y, 2 + 9 * Math.sqrt(h.w), 0, Math.PI * 2);
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // the whole row, from the same sum at every pixel
      const y0 = H - rowH;
      const n = Math.round(W / 2);
      for (let k = 0; k < n; k++) {
        const x = (k / n - 0.5) / 0.42;
        const { rgb } = along(x);
        ctx.fillStyle = `rgb(${rgb.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`;
        ctx.fillRect((k / n) * W, y0, W / n + 1, rowH - 8);
      }
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx(xp) - 4, y0 - 3, 8, rowH - 2);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [xp, r]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let on = false;
    const set = (e: PointerEvent) => {
      const b = c.getBoundingClientRect();
      setXp(Math.max(-1.15, Math.min(1.15, ((e.clientX - b.left) / b.width - 0.5) / 0.42)));
    };
    const down = (e: PointerEvent) => {
      on = true;
      c.setPointerCapture(e.pointerId);
      set(e);
    };
    const move = (e: PointerEvent) => on && set(e);
    const up = () => (on = false);
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
    };
  }, []);

  const shown = r.rows.filter((h) => h.alpha > 0.002);
  const hex = (v: number[]) => `rgb(${v.map((x) => Math.round(Math.min(1, x) * 255)).join(",")})`;
  return (
    <div className="comp">
      <canvas ref={canvas} className="comp-canvas" aria-label="One pixel's ray through a slice of Gaussians: drag to move the pixel" />
      <div className="comp-side">
        <table className="comp-table">
          <thead>
            <tr><th>i</th><th>αᵢ</th><th>Tᵢ</th><th>αᵢTᵢ</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((h, k) => (
              <tr key={h.i}>
                <td>{k + 1}</td>
                <td>{h.alpha.toFixed(3)}</td>
                <td>{h.T.toFixed(3)}</td>
                <td>{h.w.toFixed(3)}</td>
                <td><i className="swatch" style={{ background: hex(h.g.c) }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="comp-result">
          <i className="swatch big" style={{ background: hex(r.rgb) }} />
          <div>
            <p>C = Σ cᵢαᵢTᵢ</p>
            <p className="quiet">left over T = {r.T.toFixed(3)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
