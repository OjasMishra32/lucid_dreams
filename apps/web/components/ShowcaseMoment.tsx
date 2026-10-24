"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { chessLabel, legendName, type Moment } from "@/lib/showcase";
import { ViewerLink } from "./ViewInRoom";

export interface MomentDream {
  id: string;
  name: string;
  intent: string | null;
  preview: string | null;
  poster: string | null;
}

/**
 * One showcase moment: the dream's 360 preview, big and quiet, beside its sentence. The preview only plays while it's
 * on screen, so five of them never fight for the laptop. Opens the viewer, or the chess table for the legends.
 */
export default function ShowcaseMoment({
  n,
  moment,
  dream,
  alt = null,
  kept = false,
}: {
  n: number;
  moment: Moment;
  dream: MomentDream | null;
  alt?: string | null; // chess: the other legend's dream, when theirs is ready too
  kept?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? v.play().catch(() => {}) : v.pause()), { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, [dream?.preview]);

  const strength = moment.chess ? (dream && moment.chess[dream.id]) || Object.values(moment.chess)[0] : null;
  const query = strength
    ? `mode=chess&strength=${strength}${dream ? `&opponent=${encodeURIComponent(dream.id)}` : ""}`
    : dream
      ? `dream=${encodeURIComponent(dream.id)}`
      : null;
  const said = sentence(dream?.intent || moment.intent);

  const media = dream?.preview ? (
    <video ref={video} src={dream.preview} poster={dream.poster ?? undefined} muted loop playsInline preload="metadata" aria-label={`${dream.name}, walked all the way around`} />
  ) : dream?.poster ? (
    <img src={dream.poster} alt={dream.name} />
  ) : (
    <span className="moment-empty">
      <b className="num">{n}</b>
      <span>
        {kept
          ? "Private. Shown only with her family’s permission."
          : strength
            ? "The board is ready. They take their seats once they pass the side-by-side with their photos."
            : "Not in the library yet."}
      </span>
    </span>
  );

  return (
    <article className="moment" aria-labelledby={`moment-${n}`}>
      {query ? (
        <ViewerLink query={query} className="frame moment-media">{media}</ViewerLink>
      ) : (
        <div className="frame moment-media">{media}</div>
      )}

      <div className="moment-copy">
        <p className="moment-n num">{n}</p>
        <h2 className="section-title" id={`moment-${n}`}>{moment.title}</h2>
        <p className="moment-said">&ldquo;{said}&rdquo;</p>
        <p className="moment-line">{moment.line}</p>
        <p className="moment-where">
          {moment.where}
          {dream && <> · {dream.name}</>}
        </p>
        <div className="moment-actions">
          {query ? (
            <ViewerLink query={query} className="btn">{dream || !strength ? moment.action : "Play chess"}</ViewerLink>
          ) : (
            <span className="moment-wait">{kept ? "Private to the family" : "Ready once it’s made"}</span>
          )}
          {alt && moment.chess?.[alt] && (
            <ViewerLink query={`mode=chess&strength=${moment.chess[alt]}&opponent=${encodeURIComponent(alt)}`} className="more">
              Or {legendName(moment.chess[alt])}
            </ViewerLink>
          )}
          {dream && !alt && <Link href={`/library/${encodeURIComponent(dream.id)}`} className="more">The dream</Link>}
        </div>
        {strength && (
          <p className="moment-credit">
            {chessLabel(strength)}
            {alt && moment.chess?.[alt] ? ` ${chessLabel(moment.chess[alt])}` : ""}
          </p>
        )}
        {dream && moment.credit && <p className="moment-credit">{moment.credit}</p>}
      </div>
    </article>
  );
}

function sentence(text: string): string {
  const t = text.trim().replace(/[.!]+$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
