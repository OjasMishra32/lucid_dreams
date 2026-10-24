"use client";

import { useEffect, useRef, useState } from "react";

const SPEEDS: [number, string][] = [[1, "1×"], [0.5, "½×"], [0.25, "¼×"]];

/**
 * The 360 preview, with the speeds you'd use to learn a move, and the person's words when the bundle has captions
 * (captions.vtt, Atina's step). The plan's steps drive this same video (id dream-preview).
 */
export default function DreamStage({
  src,
  poster,
  name,
  captions = null,
}: {
  src: string | null;
  poster: string | null;
  name: string;
  captions?: string | null;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLTrackElement>(null);
  const [speed, setSpeed] = useState(1);
  const [line, setLine] = useState("");

  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed]);

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

  if (!src) return <div className="frame">{poster && <img src={poster} alt={name} />}</div>;
  // Speeds and words sit under the preview, never on it: the feet matter as much as the hands when learning a move.
  return (
    <>
      <div className="frame">
        <video id="dream-preview" ref={video} src={src} poster={poster ?? undefined} autoPlay muted loop playsInline aria-label={`${name}, walked all the way around`}>
          {captions && <track ref={track} kind="captions" src={captions} srcLang="en" label="Captions" default />}
        </video>
      </div>
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
