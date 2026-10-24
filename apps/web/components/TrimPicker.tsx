"use client";

import { useEffect, useRef, useState } from "react";

const THUMBS = 12;

/**
 * Pick which 5 seconds of a longer clip get rebuilt: a filmstrip with a fixed-length window you drag, like trimming
 * in Photos. Arrow keys nudge it a tenth of a second (Shift: a whole second).
 */
export default function TrimPicker({
  url,
  durationS,
  windowS,
  startS,
  onChange,
}: {
  url: string;
  durationS: number;
  windowS: number;
  startS: number;
  onChange: (startS: number) => void;
}) {
  const usable = Number.isFinite(durationS) && durationS > windowS;
  const strip = useRef<HTMLDivElement>(null);
  const grab = useRef<number | null>(null); // seconds between the pointer and the window's start while dragging
  const [thumbs, setThumbs] = useState<string[]>([]);
  const maxStart = Math.max(0, durationS - windowS);

  useEffect(() => {
    if (!usable) return;
    let alive = true;
    setThumbs([]);
    filmstrip(url, durationS, THUMBS, (src) => alive && setThumbs((t) => [...t, src])).catch(() => {});
    return () => {
      alive = false;
    };
  }, [url, durationS, usable]);

  const clamp = (s: number) => Math.round(Math.min(Math.max(s, 0), maxStart) * 100) / 100;
  const secondsAt = (clientX: number) => {
    const r = strip.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * durationS;
  };

  function down(e: React.PointerEvent) {
    const at = secondsAt(e.clientX);
    const inside = at >= startS && at <= startS + windowS;
    grab.current = inside ? at - startS : windowS / 2; // outside the window: centre it under the pointer
    if (!inside) onChange(clamp(at - windowS / 2));
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    if (grab.current === null) return;
    onChange(clamp(secondsAt(e.clientX) - grab.current));
  }
  function up() {
    grab.current = null;
  }
  function key(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 1 : 0.1;
    const next =
      e.key === "ArrowLeft" || e.key === "ArrowDown" ? startS - step
      : e.key === "ArrowRight" || e.key === "ArrowUp" ? startS + step
      : e.key === "Home" ? 0
      : e.key === "End" ? maxStart
      : null;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next));
  }

  if (!usable) return null;
  const left = (startS / durationS) * 100;
  const width = (windowS / durationS) * 100;
  return (
    <div className="trim">
      <div
        ref={strip}
        className="trim-strip"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <div className="trim-frames" aria-hidden="true">
          {Array.from({ length: THUMBS }, (_, i) => (
            <span key={i} style={thumbs[i] ? { backgroundImage: `url(${thumbs[i]})` } : undefined} />
          ))}
        </div>
        <div className="trim-shade" style={{ left: 0, width: `${left}%` }} />
        <div className="trim-shade" style={{ left: `${left + width}%`, right: 0 }} />
        <div
          className="trim-window"
          style={{ left: `${left}%`, width: `${width}%` }}
          role="slider"
          tabIndex={0}
          aria-label="Which 5 seconds to rebuild"
          aria-valuemin={0}
          aria-valuemax={Math.round(maxStart * 10) / 10}
          aria-valuenow={Math.round(startS * 10) / 10}
          aria-valuetext={`From ${clock(startS)} to ${clock(startS + windowS)}`}
          onKeyDown={key}
        />
      </div>
      <div className="trim-foot num">
        <span>{clock(startS)}</span>
        <span className="muted">Drag to choose 5 seconds</span>
        <span>{clock(Math.min(startS + windowS, durationS))}</span>
      </div>
    </div>
  );
}

function clock(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

/** Evenly spaced frames from the clip, drawn small, handed over one by one as they decode. */
async function filmstrip(url: string, durationS: number, count: number, onThumb: (src: string) => void) {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = url;
  await once(v, "loadeddata");
  const h = 112; // 56 px tall at 2x
  const w = Math.max(1, Math.round((h * v.videoWidth) / v.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  for (let i = 0; i < count; i++) {
    v.currentTime = Math.min(durationS - 0.05, ((i + 0.5) * durationS) / count);
    await once(v, "seeked");
    g.drawImage(v, 0, 0, w, h);
    onThumb(canvas.toDataURL("image/jpeg", 0.75));
  }
  v.removeAttribute("src");
  v.load();
}

function once(el: HTMLElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 8000);
    el.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
  });
}
