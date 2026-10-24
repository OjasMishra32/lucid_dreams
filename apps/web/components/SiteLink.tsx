"use client";

import { useEffect, useState } from "react";

/** The public showcase site (apps/site, Ojasva's) on :5190 of the same Mac, unless NEXT_PUBLIC_SITE_URL says where. */
export default function SiteLink({ className, children }: { className?: string; children: React.ReactNode }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    setHref(process.env.NEXT_PUBLIC_SITE_URL || `${location.protocol}//${location.hostname}:5190`);
  }, []);
  return (
    <a className={className} href={href ?? undefined} aria-disabled={!href}>
      {children}
    </a>
  );
}
