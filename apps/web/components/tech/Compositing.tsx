"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// One pixel, blended the way the GPU does it, in three linked views. On screen: seven Gaussians already projected to
// 2D ellipses, the whole image composited with the same sum, and a pixel you drag. Along its ray: the Gaussians in
// depth order, near to far, each one's alpha at this pixel αᵢ = oᵢ·exp(-½ dᵀΣ'⁻¹d), and the light still left to see
// past it Tᵢ = Πⱼ<ᵢ (1 − αⱼ) as a beam that narrows. The pixel: one bar split into each Gaussian's share αᵢTᵢ, plus
// whatever light is left over, and the color they make, C = Σ cᵢ αᵢ Tᵢ.

interface G2 {
  x: number; // centre on screen, x in [-1, 1], y in [-ASPECT, ASPECT] (y up)
  y: number;
  sx: number; // std devs along its own axes
  sy: number;
  rot: number;
  o: number; // opacity
  z: number; // depth: smaller is nearer
  c: [number, number, number];
  name: string;
}

const ASPECT = 2 / 3;
const SCENE: G2[] = [
  { x: -0.16, y: 0.1, sx: 0.26, sy: 0.1, rot: 0.45, o: 0.8, z: 1, c: [0.95, 0.8, 0.66], name: "cream" },
  { x: 0.14, y: -0.01, sx: 0.34, sy: 0.09, rot: -0.3, o: 0.85, z: 2, c: [0.88, 0.32, 0.27], name: "red" },
  { x: 0.5, y: 0.26, sx: 0.18, sy: 0.13, rot: 0.8, o: 0.85, z: 3, c: [0.98, 0.66, 0.18], name: "orange" },
  { x: 0.0, y: -0.14, sx: 0.32, sy: 0.12, rot: 0.1, o: 0.9, z: 4, c: [0.2, 0.42, 0.85], name: "blue" },
  { x: -0.58, y: 0.32, sx: 0.28, sy: 0.09, rot: -0.3, o: 0.85, z: 5, c: [0.3, 0.68, 0.45], name: "green" },
  { x: 0.58, y: -0.3, sx: 0.2, sy: 0.12, rot: 0.3, o: 0.8, z: 6, c: [0.6, 0.45, 0.85], name: "purple" },
  { x: -0.02, y: 0.02, sx: 0.62, sy: 0.26, rot: 0, o: 0.9, z: 7, c: [0.36, 0.37, 0.42], name: "grey" },
];
const NEAR_TO_FAR = [...SCENE].sort((a, b) => a.z - b.z);

function alphaAt(g: G2, x: number, y: number) {
  const co = Math.cos(g.rot);
  const si = Math.sin(g.rot);
  const dx = x - g.x;
  const dy = y - g.y;
  const u = (co * dx + si * dy) / g.sx;
  const v = (-si * dx + co * dy) / g.sy;
  const m = u * u + v * v;
  return m > 9 ? 0 : g.o * Math.exp(-0.5 * m);
}

/** Front-to-back blending at one pixel: every Gaussian's alpha, the light left in front of it and its share. */
function blend(x: number, y: number) {
  let T = 1;
  const rgb = [0, 0, 0];
  const rows = NEAR_TO_FAR.map((g) => {
    const alpha = alphaAt(g, x, y);
    const share = alpha * T;
    for (let k = 0; k < 3; k++) rgb[k] += g.c[k] * share;
    const row = { g, alpha, T, share };
    T *= 1 - alpha;
    return row;
  });
  return { rows, rgb, T };
}

// where the pixel starts: near the middle, where the most Gaussians each take a clear share
function start(): [number, number] {
  let best: [number, number] = [0, 0];
  let score = -1;
  for (let x = -0.5; x <= 0.5; x += 0.02) {
    for (let y = -0.4; y <= 0.4; y += 0.02) {
      const s = blend(x, y).rows.filter((r) => r.share > 0.1).length - Math.hypot(x, y) * 0.5;
      if (s > score) {
        score = s;
        best = [x, y];
      }
    }
  }
  return best;
}

const rgbCss = (c: number[]) => `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(",")})`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export default function Compositing() {
  const front = useRef<HTMLCanvasElement>(null);
  const rayBox = useRef<HTMLDivElement>(null);
  const [p, setP] = useState<[number, number]>(() => start());
  const [w, setW] = useState(640);
  // the ray view is drawn only in the browser: its numbers come from exp(), which differs from the server's in the
  // last digit, and React won't hydrate an attribute that differs
  const [live, setLive] = useState(false);
  const r = useMemo(() => blend(p[0], p[1]), [p]);

  // the whole screen, composited with the same sum (drawn once per size)
  useEffect(() => {
    const c = front.current;
    if (!c) return;
    const draw = () => {
      const W = c.clientWidth;
      const H = c.clientHeight;
      const s = 0.5 * Math.min(devicePixelRatio || 1, 2);
      const w2 = Math.max(1, Math.round(W * s));
      const h2 = Math.max(1, Math.round(H * s));
      c.width = w2;
      c.height = h2;
      const ctx = c.getContext("2d")!;
      const img = ctx.createImageData(w2, h2);
      for (let j = 0; j < h2; j++) {
        const y = (0.5 - (j + 0.5) / h2) * 2 * ASPECT;
        for (let i = 0; i < w2; i++) {
          const x = ((i + 0.5) / w2 - 0.5) * 2;
          const { rgb } = blend(x, y);
          const o = (j * w2 + i) * 4;
          img.data[o] = Math.min(255, rgb[0] * 255 + 10);
          img.data[o + 1] = Math.min(255, rgb[1] * 255 + 10);
          img.data[o + 2] = Math.min(255, rgb[2] * 255 + 12);
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  // drag the pixel anywhere on the screen
  useEffect(() => {
    const c = front.current;
    if (!c) return;
    let on = false;
    const set = (e: PointerEvent) => {
      const b = c.getBoundingClientRect();
      const x = ((e.clientX - b.left) / b.width - 0.5) * 2;
      const y = (0.5 - (e.clientY - b.top) / b.height) * 2 * ASPECT;
      setP([Math.max(-0.97, Math.min(0.97, x)), Math.max(-ASPECT + 0.03, Math.min(ASPECT - 0.03, y))]);
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
    c.addEventListener("pointercancel", up);
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
    };
  }, []);

  // the side view is drawn in its own pixels, so its labels stay readable on a phone
  useEffect(() => {
    const el = rayBox.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(300, el.clientWidth)));
    ro.observe(el);
    setLive(true);
    return () => ro.disconnect();
  }, []);

  const small = w < 520;
  const H = small ? 300 : 330;
  const eyeX = small ? 22 : 34;
  const x0 = small ? 54 : 84;
  const x1 = w - (small ? 8 : 16);
  const rayY = small ? 112 : 124;
  const beam = small ? 34 : 42; // half the beam's height while all the light is left
  const ry = small ? 50 : 60;
  const step = (x1 - x0) / NEAR_TO_FAR.length;
  const at = (k: number) => x0 + (k + 0.5) * step;
  const barY = H - (small ? 66 : 70);
  const barH = small ? 22 : 26;
  const sw = small ? 46 : 64; // the pixel's swatch
  const barX1 = x1 - sw - (small ? 22 : 30);
  const barW = barX1 - x0;
  const font = small ? 11 : 13;

  // the beam: full height at the eye, narrowing by (1 − α) at every Gaussian it passes
  let path = `M ${eyeX + 12} ${rayY - beam}`;
  r.rows.forEach((row, k) => {
    const xk = at(k);
    path += ` L ${xk} ${rayY - beam * row.T} L ${xk} ${rayY - beam * row.T * (1 - row.alpha)}`;
  });
  path += ` L ${x1} ${rayY - beam * r.T} L ${x1} ${rayY + beam * r.T}`;
  for (let k = r.rows.length - 1; k >= 0; k--) {
    const row = r.rows[k];
    const xk = at(k);
    path += ` L ${xk} ${rayY + beam * row.T * (1 - row.alpha)} L ${xk} ${rayY + beam * row.T}`;
  }
  path += ` L ${eyeX + 12} ${rayY + beam} Z`;

  // each Gaussian's share of the pixel, laid end to end, near first; then the light nothing took
  let cursor = x0;
  const segs = r.rows.map((row, k) => {
    const s = { k, row, x: cursor, w: row.share * barW };
    cursor += s.w;
    return s;
  });
  const left = { x: cursor, w: r.T * barW };

  const sx = ((p[0] + 1) / 2) * 100;
  const sy = (0.5 - p[1] / (2 * ASPECT)) * 100;

  return (
    <div className="comp">
      <figure className="comp-front">
        <figcaption>On screen</figcaption>
        <div className="comp-screen">
          <canvas ref={front} aria-label="Seven Gaussians on screen: drag to move the pixel" />
          <span className="comp-pin" style={{ left: `${sx}%`, top: `${sy}%` }} aria-hidden="true" />
        </div>
        <p className="comp-hint">Drag the pixel.</p>
      </figure>

      <figure className="comp-ray" ref={rayBox}>
        <figcaption>Along its ray, near to far</figcaption>
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label="The pixel's ray through the Gaussians, and the share of the pixel each one takes">
          {live && (
            <>
              {/* the eye */}
              <g transform={`translate(${eyeX} ${rayY})`}>
                <path d="M -12 0 Q 0 -10 12 0 Q 0 10 -12 0 Z" fill="none" stroke="#f5f5f7" strokeWidth="1.5" />
                <circle r="3.6" fill="#f5f5f7" />
              </g>
              <text x={eyeX} y={rayY + (small ? 30 : 36)} className="comp-t dim" textAnchor="middle" fontSize={font}>eye</text>

              {/* the light still left to see, narrowing at each Gaussian */}
              <path d={path} fill="rgba(255,255,255,0.13)" stroke="rgba(255,255,255,0.45)" strokeWidth="1" />

              {/* the Gaussians in depth order; the ones this ray misses stay faint */}
              {r.rows.map((row, k) => {
                const hit = row.share > 0.02;
                return (
                  <g key={row.g.name}>
                    <ellipse
                      cx={at(k)}
                      cy={rayY}
                      rx={small ? 6 : 8}
                      ry={ry}
                      fill={rgbCss(row.g.c)}
                      fillOpacity={Math.max(0.07, row.alpha)}
                      stroke={rgbCss(row.g.c)}
                      strokeOpacity={hit ? 0.9 : 0.25}
                    />
                    {hit && (
                      <>
                        <text x={at(k)} y={rayY - ry - 10} textAnchor="middle" className="comp-t" fontSize={font}>
                          α {small ? row.alpha.toFixed(2).replace(/^0/, "") : row.alpha.toFixed(2)}
                        </text>
                        <path
                          d={`M ${at(k)} ${rayY + ry + 4} C ${at(k)} ${barY - 26}, ${segs[k].x + segs[k].w / 2} ${rayY + ry + 24}, ${segs[k].x + segs[k].w / 2} ${barY - 3}`}
                          fill="none"
                          stroke={rgbCss(row.g.c)}
                          strokeOpacity="0.75"
                          strokeWidth="1.5"
                        />
                      </>
                    )}
                  </g>
                );
              })}

              {/* T: how much light is left in each gap */}
              {r.rows.map((row, k) => {
                const xa = k === 0 ? eyeX + 14 : at(k - 1);
                const room = at(k) - xa;
                if (row.T < 0.005 || room < (small ? 30 : 40)) return null;
                return (
                  <text key={`t${k}`} x={(xa + at(k)) / 2} y={rayY + 4} textAnchor="middle" className="comp-t light" fontSize={font - 1}>
                    {pct(row.T)}
                  </text>
                );
              })}

              {/* the pixel: each Gaussian's share, then what's left over */}
              {segs.map((s) =>
                s.w > 0.4 ? (
                  <rect key={s.k} x={s.x} y={barY} width={s.w} height={barH} fill={rgbCss(s.row.g.c)} />
                ) : null,
              )}
              {left.w > 0.4 && <rect x={left.x} y={barY} width={left.w} height={barH} fill="#1d1d1f" />}
              <rect x={x0} y={barY} width={barW} height={barH} fill="none" stroke="rgba(255,255,255,0.25)" rx="3" />
              {segs.map((s) =>
                s.w > (small ? 26 : 34) ? (
                  <text
                    key={`p${s.k}`}
                    x={s.x + s.w / 2}
                    y={barY + barH / 2 + (font - 1) * 0.36}
                    textAnchor="middle"
                    fontSize={font - 1}
                    fontWeight={600}
                    fill={luma(s.row.g.c) > 0.55 ? "#1d1d1f" : "#fff"}
                  >
                    {pct(s.row.share)}
                  </text>
                ) : null,
              )}
              {left.w > (small ? 26 : 34) && (
                <text x={left.x + left.w / 2} y={barY + barH / 2 + (font - 1) * 0.36} textAnchor="middle" className="comp-t dim" fontSize={font - 1}>
                  {pct(r.T)}
                </text>
              )}
              <text x={x0} y={barY + barH + (small ? 15 : 18)} className="comp-t dim" fontSize={font - 1}>
                each one&apos;s share, αT{left.w > 0.4 ? ", then the light left over" : ""}
              </text>

              <text x={barX1 + (x1 - sw - barX1) / 2} y={barY + barH / 2 + 6} textAnchor="middle" className="comp-t" fontSize={font + 5}>=</text>
              <rect x={x1 - sw} y={barY - (sw - barH) / 2} width={sw} height={sw} rx={small ? 10 : 14} fill={rgbCss(r.rgb)} stroke="rgba(255,255,255,0.2)" />
              <text x={x1 - sw / 2} y={barY + (sw + barH) / 2 + (small ? 15 : 18)} textAnchor="middle" className="comp-t dim" fontSize={font - 1}>
                the pixel
              </text>
            </>
          )}
        </svg>
        <p className="comp-hint">The band is the light left, T. Each Gaussian takes α of it.</p>
      </figure>
    </div>
  );
}
