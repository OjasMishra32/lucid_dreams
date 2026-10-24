"use client";

import { useEffect, useRef, useState } from "react";

// One anisotropic Gaussian, live. Drag the ends of its two axes: the rotation R and the scales S change, and with them
// the covariance Σ = R S Sᵀ Rᵀ (symmetric, positive semi-definite by construction), its density, its 1σ and 2σ
// contours, the √8σ ellipse where Spark stops drawing it, and the quad the GPU actually shades to draw it.

const K = Math.sqrt(8);
const RANGE = 2.5; // world units shown from the centre to an edge

export default function GaussianPlayground() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [g, setG] = useState({ theta: 0.55, s1: 0.62, s2: 0.24 });
  const drag = useRef<0 | 1 | 2>(0);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const draw = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const W = c.clientWidth;
      const H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const px = Math.min(W, H) / (2 * RANGE); // pixels per unit
      const cx = W / 2;
      const cy = H / 2;
      const { theta, s1, s2 } = g;
      const co = Math.cos(theta);
      const si = Math.sin(theta);
      // Σ = R S S^T R^T, and its inverse for the density
      const a = co * co * s1 * s1 + si * si * s2 * s2;
      const b = co * si * (s1 * s1 - s2 * s2);
      const d = si * si * s1 * s1 + co * co * s2 * s2;
      const det = a * d - b * b;
      const ia = d / det;
      const ib = -b / det;
      const id = a / det;
      // the density, at a quarter of the canvas' pixels
      const q = 4;
      const iw = Math.ceil(c.width / q);
      const ih = Math.ceil(c.height / q);
      const img = ctx.createImageData(iw, ih);
      for (let y = 0; y < ih; y++) {
        for (let x = 0; x < iw; x++) {
          const wx = ((x * q) / dpr - cx) / px;
          const wy = -((y * q) / dpr - cy) / px;
          const m = ia * wx * wx + 2 * ib * wx * wy + id * wy * wy;
          const v = m > K * K ? 0 : Math.exp(-0.5 * m);
          const o = (y * iw + x) * 4;
          // black -> Apple blue -> white
          const t = v;
          img.data[o] = Math.round(255 * Math.max(0, t * 1.6 - 0.6));
          img.data[o + 1] = Math.round(255 * Math.min(1, t * 0.55 + Math.max(0, t * 1.6 - 0.6) * 0.45));
          img.data[o + 2] = Math.round(255 * Math.min(1, t * 1.35));
          img.data[o + 3] = 255;
        }
      }
      const off = document.createElement("canvas");
      off.width = iw;
      off.height = ih;
      off.getContext("2d")!.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, c.width, c.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // the grid
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let u = -3; u <= 3; u++) {
        ctx.beginPath();
        ctx.moveTo(cx + u * px, 0);
        ctx.lineTo(cx + u * px, H);
        ctx.moveTo(0, cy - u * px);
        ctx.lineTo(W, cy - u * px);
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-theta);
      const ellipse = (k: number, style: string, dash: number[] = [], width = 1.25) => {
        ctx.beginPath();
        ctx.setLineDash(dash);
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.ellipse(0, 0, k * s1 * px, k * s2 * px, 0, 0, Math.PI * 2);
        ctx.stroke();
      };
      // the quad Spark shades: ±k sigma along each eigen axis
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(255,159,10,0.75)";
      ctx.lineWidth = 1;
      ctx.strokeRect(-K * s1 * px, -K * s2 * px, 2 * K * s1 * px, 2 * K * s2 * px);
      ellipse(K, "rgba(255,255,255,0.55)", [6, 5]);
      ellipse(2, "rgba(255,255,255,0.7)");
      ellipse(1, "rgba(255,255,255,0.95)", [], 1.5);
      ctx.setLineDash([]);
      ctx.restore();
      // the eigen axes, with their handles
      const e1 = [co * s1 * 2, si * s1 * 2];
      const e2 = [-si * s2 * 2, co * s2 * 2];
      const arrow = (v: number[], label: string, color: string) => {
        const x = cx + v[0] * px;
        const y = cy - v[1] * px;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "italic 600 15px ui-serif, Georgia, serif";
        ctx.fillText(label, x + 12, y - 10);
      };
      arrow(e1, "e₁", "#2997ff");
      arrow(e2, "e₂", "#5ac8fa");
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "italic 600 15px ui-serif, Georgia, serif";
      ctx.fillText("μ", cx + 8, cy + 18);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [g]);

  // dragging a handle: the long axis sets the rotation and σ₁, the short one σ₂ (kept at right angles)
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const world = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      const px = Math.min(r.width, r.height) / (2 * RANGE);
      return [(e.clientX - r.left - r.width / 2) / px, -(e.clientY - r.top - r.height / 2) / px];
    };
    const down = (e: PointerEvent) => {
      const [x, y] = world(e);
      const co = Math.cos(g.theta);
      const si = Math.sin(g.theta);
      const h1 = [co * g.s1 * 2, si * g.s1 * 2];
      const h2 = [-si * g.s2 * 2, co * g.s2 * 2];
      const d1 = Math.hypot(x - h1[0], y - h1[1]);
      const d2 = Math.hypot(x - h2[0], y - h2[1]);
      drag.current = d1 < 0.45 && d1 <= d2 ? 1 : d2 < 0.45 ? 2 : 1;
      c.setPointerCapture(e.pointerId);
      move(e);
    };
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      const [x, y] = world(e);
      setG((p) => {
        if (drag.current === 1) {
          const len = Math.hypot(x, y);
          return { ...p, theta: Math.atan2(y, x), s1: Math.min(1.45, Math.max(0.12, len / 2)) };
        }
        const along = -Math.sin(p.theta) * x + Math.cos(p.theta) * y;
        return { ...p, s2: Math.min(1.45, Math.max(0.06, Math.abs(along) / 2)) };
      });
    };
    const up = () => (drag.current = 0);
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
    };
  }, [g.theta, g.s1, g.s2]);

  const { theta, s1, s2 } = g;
  const co = Math.cos(theta);
  const si = Math.sin(theta);
  const S = [
    [co * co * s1 * s1 + si * si * s2 * s2, co * si * (s1 * s1 - s2 * s2)],
    [co * si * (s1 * s1 - s2 * s2), si * si * s1 * s1 + co * co * s2 * s2],
  ];
  const f = (v: number) => (Math.abs(v) < 0.0005 ? "0.000" : v.toFixed(3));
  const quad = 4 * K * K * s1 * s2;
  const area = Math.PI * K * K * s1 * s2;
  return (
    <div className="gp">
      <canvas ref={canvas} className="gp-canvas" aria-label="An anisotropic Gaussian: drag the ends of its two axes" />
      <div className="gp-read" aria-live="polite">
        <div className="mx-row">
          <span className="mx-name">R</span>
          <Matrix m={[[co, -si], [si, co]]} f={f} />
          <span className="mx-name">S</span>
          <Matrix m={[[s1, 0], [0, s2]]} f={f} />
        </div>
        <div className="mx-row">
          <span className="mx-name">Σ</span>
          <Matrix m={S} f={f} accent />
        </div>
        <dl className="gp-facts">
          <div><dt>θ</dt><dd>{((theta * 180) / Math.PI).toFixed(1)}°</dd></div>
          <div><dt>λ₁, λ₂</dt><dd>{f(s1 * s1)}, {f(s2 * s2)}</dd></div>
          <div><dt>det Σ</dt><dd>{f(s1 * s1 * s2 * s2)}</dd></div>
          <div><dt>anisotropy</dt><dd>{(s1 / s2).toFixed(2)} : 1</dd></div>
          <div><dt>quad shaded</dt><dd>{quad.toFixed(2)} u² <span className="quiet">(4k²σ₁σ₂)</span></dd></div>
          <div><dt>ellipse inside it</dt><dd>{area.toFixed(2)} u² <span className="quiet">({((area / quad) * 100).toFixed(0)}%)</span></dd></div>
        </dl>
        <p className="gp-key">
          <i className="k-1" />1σ <i className="k-2" />2σ <i className="k-k" />√8σ, where it stops <i className="k-q" />the quad the GPU shades
        </p>
      </div>
    </div>
  );
}

function Matrix({ m, f, accent }: { m: number[][]; f: (v: number) => string; accent?: boolean }) {
  return (
    <span className={`mx ${accent ? "mx-accent" : ""}`}>
      <span className="mx-cells">
        {m.flat().map((v, i) => (
          <span key={i}>{f(v)}</span>
        ))}
      </span>
    </span>
  );
}
