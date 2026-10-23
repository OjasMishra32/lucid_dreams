"use client";

import { useEffect, useState } from "react";

/** "View in your room" opens Ojasva's WebXR viewer (apps/webxr, https on :5180) on the same Mac. */
export default function ViewInRoom({ id, className = "btn" }: { id: string; className?: string }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_VIEWER_URL || `https://${location.hostname}:5180`;
    setHref(`${base.replace(/\/$/, "")}/?dream=${encodeURIComponent(id)}`);
  }, [id]);
  return (
    <a className={className} href={href ?? undefined} target="_blank" rel="noreferrer" aria-disabled={!href}>
      View in your room
    </a>
  );
}
