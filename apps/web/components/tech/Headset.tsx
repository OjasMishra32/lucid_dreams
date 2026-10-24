"use client";

import { useEffect, useRef, type RefObject } from "react";
import "./headset.css";

// The headset, live in 3D (lib/three/headset.ts), driven by how far `track` has scrolled through the viewport: it
// assembles, turns, explodes, shows its lenses, then its eyes beam out to `person`. If WebGL 2 is missing the host
// simply stays empty.

export default function HeadsetCanvas({ track, person }: { track: RefObject<HTMLElement | null>; person?: string | null }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    let dispose: (() => void) | null = null;
    let gone = false;
    const progress = () => {
      const t = track.current;
      if (!t) return 0;
      const b = t.getBoundingClientRect();
      return Math.min(1, Math.max(0, -b.top / Math.max(1, b.height - innerHeight)));
    };
    const failed = () => {
      if (!gone && host.current) host.current.dataset.failed = "";
    };
    import("@/lib/three/headset")
      .then((m) => m.mountHeadset(host.current!, { progress, failed, person }))
      .then((d) => {
        if (gone) d();
        else dispose = d;
      })
      .catch(failed);
    return () => {
      gone = true;
      dispose?.();
    };
  }, [track, person]);

  return <div ref={host} className="headset-host" aria-hidden="true" />;
}
