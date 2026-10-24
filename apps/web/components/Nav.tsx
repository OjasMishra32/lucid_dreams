"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// One page, one scroll: the bar takes you to its sections (from anywhere on the site), and into the room.
export default function Nav() {
  const path = usePathname();
  return (
    <nav className={path === "/" ? "nav nav-light" : "nav"}>
      <div className="nav-inner">
        <Link href="/" className="wordmark">Lucid Dreams</Link>
        <a href="/#scenes" className="nav-link">Scenes</a>
        <a href="/#how" className="nav-link nav-how">How it works</a>
        <a href="/#technology" className="nav-link nav-tech">Technology</a>
        <a href="/xr/" className="nav-link nav-room">In your room</a>
        <a href="/#make" className="btn btn-sm">Make one</a>
      </div>
    </nav>
  );
}
