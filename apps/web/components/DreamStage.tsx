"use client";

import Image from "next/image";
import { ViewTransition, useEffect, useRef, useState } from "react";
import { afterLoad } from "@/lib/idle";

const SPEEDS: [number, string][] = [[1, "1×"], [0.5, "½×"], [0.25, "¼×"]];

/**
 * The 360 preview, with the speeds you'd use to learn a move, and the person's words when the bundle has captions
 * (captions.vtt, Atina's step). The plan's steps drive this same video (id dream-preview).
 */
export default function DreamStage({
  id,
  src,
  poster,
  name,
  captions = null,
}: {
  id: string;
  src: string | null;
  poster: string | null;
  name: string;
  captions?: string | null;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLTrackElement>(null);
  const [speed, setSpeed] = useState(1);
  const [line, setLine] = useState("");
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed]);

  // the poster paints first; the person starts moving once the page has settled
  useEffect(() => afterLoad(() => video.current?.play().catch(() => {})), [src]);

  // Read the cues ourselves (track mode "hidden") so the words sit above the speed control, in the page's type.
  useEffect(() => {
    const t = track.current?.track;
    if (!t) return;
    t.mode = "hidden";
    const show = () => {
      const cues = Array.from(t.activeCues ?? []) as VTTCue[];
      setLine(cues.map((c) => c.text.replace(/<[^>]+>/g, "")).join("\n"));
    };
    t.addEventListener("cuechange", show);
    return () => t.removeEventListener("cuechange", show);
  }, [captions]);

  // The same element as the library card it was opened from, so the card grows into this stage.
  const frame = (children: React.ReactNode) => (
    <ViewTransition name={`dream-${id}`} share="morph" default="none">
      <div className="person stage-frame">{children}</div>
    </ViewTransition>
  );
  // the poster comes sized to the screen and first in line; the video fades in over it once it plays
  const still = poster && (
    <Image src={poster} alt={src ? "" : name} fill priority sizes="(max-width: 900px) min(92vw, 400px), 480px" />
  );
  if (!src) return frame(still);
  // Speeds and words sit under the preview, never on it: the feet matter as much as the hands when learning a move.
  return (
    <>
      {frame(
        <>
          {still}
          <video
            id="dream-preview"
            ref={video}
            src={src}
            muted
            loop
            playsInline
            className={playing ? "ready" : ""}
            onPlaying={() => setPlaying(true)}
            aria-label={`${name}, life size, the camera moving around them`}
          >
            {captions && <track ref={track} kind="captions" src={captions} srcLang="en" label="Captions" default />}
          </video>
        </>,
      )}
      {captions && (
        <p className="stage-caption" aria-live="polite">
          {line || " "}
        </p>
      )}
      <div className="stage-controls">
        <div className="segmented" role="group" aria-label="Playback speed">
          {SPEEDS.map(([v, label]) => (
            <button key={v} className={speed === v ? "on" : ""} aria-pressed={speed === v} onClick={() => setSpeed(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
