"use client";

import { useEffect, useState } from "react";

/** A link into Ojasva's WebXR viewer (apps/webxr, https on :5180) on the same Mac, e.g. "dream=<id>" or "mode=chess". */
export function ViewerLink({ query, className, children }: { query: string; className?: string; children: React.ReactNode }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_VIEWER_URL || `https://${location.hostname}:5180`;
    setHref(`${base.replace(/\/$/, "")}/?${query}`);
  }, [query]);
  return (
    <a className={className} href={href ?? undefined} target="_blank" rel="noreferrer" aria-disabled={!href}>
      {children}
    </a>
  );
}

/** "View in your room": the dream, life size, in the viewer (avatars move live there too). */
export default function ViewInRoom({ id, className = "btn" }: { id: string; className?: string }) {
  return (
    <ViewerLink query={`dream=${encodeURIComponent(id)}`} className={className}>
      View in your room
    </ViewerLink>
  );
}
