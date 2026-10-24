"use client";

import { useEffect, useState } from "react";

/**
 * A link into the headset app (apps/webxr), e.g. "dream=<id>" or "mode=chess": at /xr/ on this same address, so the
 * public link opens the room too. The room needs a secure page: over plain http from another device on the Wi-Fi it
 * opens the Mac's https server (:5180) instead.
 */
export function ViewerLink({ query, className, children }: { query: string; className?: string; children: React.ReactNode }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const secure = location.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const base = process.env.NEXT_PUBLIC_VIEWER_URL || (secure ? "/xr" : `https://${location.hostname}:5180/xr`);
    setHref(`${base.replace(/\/$/, "")}/?${query}`);
  }, [query]);
  return (
    <a className={className} href={href ?? undefined} aria-disabled={!href}>
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
