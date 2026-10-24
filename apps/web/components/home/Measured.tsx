"use client";

import { useRef, useState } from "react";
import type { MeasuredRow } from "@/lib/scenes";

// The real frame against our render from the same camera, a slider apart; and each replay's measured numbers
// (dream.json metrics.reconstruction), as a plain comparison table.

export function MeasuredTable({ rows }: { rows: MeasuredRow[] }) {
  return (
    <table className="measured">
      <thead>
        <tr>
          <th scope="col">Replay</th>
          <th scope="col">Views PSNR</th>
          <th scope="col">Views SSIM</th>
          <th scope="col">Seen by the camera</th>
          <th scope="col">Gaussians a frame</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <th scope="row">{r.name}</th>
            <td>{r.viewsPsnr != null ? `${r.viewsPsnr.toFixed(1)} dB` : "Not measured"}</td>
            <td>{r.viewsSsim != null ? r.viewsSsim.toFixed(3) : "Not measured"}</td>
            <td>{r.seen != null ? `${Math.round(r.seen * 100)}%` : "Not measured"}</td>
            <td>{r.gaussians != null ? r.gaussians.toLocaleString("en-US") : "Not measured"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TruthSlider({ real, render }: { real: string; render: string }) {
  const [x, setX] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const move = (clientX: number) => {
    const b = box.current?.getBoundingClientRect();
    if (b) setX(Math.min(1, Math.max(0, (clientX - b.left) / b.width)));
  };
  return (
    <div
      ref={box}
      className="truth"
      style={{ ["--x" as string]: x }}
      onPointerDown={(e) => {
        drag.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => drag.current && move(e.clientX)}
      onPointerUp={() => (drag.current = false)}
    >
      <img src={real} alt="The real frame from the clip" draggable={false} />
      <img src={render} alt="Our 3D render from the same camera" className="truth-render" draggable={false} />
      <div className="truth-line" />
      <span className="truth-tag l">Real frame</span>
      <span className="truth-tag r">Our 3D render</span>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(x * 100)}
        onChange={(e) => setX(Number(e.target.value) / 100)}
        aria-label="Compare the real frame and our render"
      />
    </div>
  );
}
