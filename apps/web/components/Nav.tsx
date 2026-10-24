"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ViewerLink } from "./ViewInRoom";

export default function Nav() {
  const path = usePathname();
  const on = (href: string) => (path === href || path.startsWith(href + "/") ? "nav-link on" : "nav-link");
  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link href="/" className="wordmark">Lucid Dreams</Link>
        <Link href="/showcase" className={`${on("/showcase")} nav-showcase`}>Showcase</Link>
        <Link href="/library" className={on("/library")}>Library</Link>
        <Link href="/live" className={`${on("/live")} nav-live`}>Live</Link>
        <ViewerLink query="mode=chess" className="nav-link nav-chess">Chess</ViewerLink>
        <Link href="/new" className="btn btn-sm">Make a dream</Link>
      </div>
    </nav>
  );
}
