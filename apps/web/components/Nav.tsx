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
        <Link href="/library" className={on("/library")}>Library</Link>
        <ViewerLink query="mode=chess" className="nav-link nav-chess">Chess</ViewerLink>
        <Link href="/new" className="btn btn-sm">Make a dream</Link>
      </div>
    </nav>
  );
}
