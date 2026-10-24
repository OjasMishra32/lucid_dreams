"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { dreamFile, type Dream } from "@/lib/dream";
import { dreamMeta } from "@/lib/format";

/** A 9:16 card: the thumbnail, and the 360 preview fading in on hover. */
export default function DreamCard({ dream }: { dream: Dream }) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const thumb = dream.thumb ? dreamFile(dream.id, dream.thumb) : null;
  const preview = dream.preview ? dreamFile(dream.id, dream.preview) : null;
  return (
    <Link
      href={`/library/${encodeURIComponent(dream.id)}`}
      className="card"
      onMouseEnter={() => video.current?.play().catch(() => {})}
      onMouseLeave={() => video.current?.pause()}
    >
      <div className="thumb">
        {(dream.kind === "avatar" || dream.private) && (
          <span className="badge">{[dream.kind === "avatar" && "Avatar", dream.private && "Private"].filter(Boolean).join(" · ")}</span>
        )}
        {thumb && <img src={thumb} alt="" loading="lazy" />}
        {preview && (
          <video
            ref={video}
            src={preview}
            muted
            loop
            playsInline
            // without a thumbnail, the preview's first frame stands in for it
            preload={thumb ? "none" : "metadata"}
            className={ready ? "ready" : ""}
            style={thumb ? undefined : { opacity: 1 }}
            onPlaying={() => setReady(true)}
          />
        )}
      </div>
      <h3>{dream.name}</h3>
      <p className="meta">{dreamMeta(dream)}</p>
    </Link>
  );
}
