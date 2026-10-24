"use client";

import { useEffect } from "react";

// The page's scroll motion, in one place and straight in the DOM (never a re-render): `.reveal` elements rise in once
// as they come on screen; `[data-count]` numbers count up to their value; `[data-scrub]` elements get their scroll
// progress as --p every frame ("track": through a tall sticky track; "pass": as it crosses the screen), which the CSS
// turns into motion. With reduced motion everything simply shows, finished.

const clamp = (x: number) => Math.min(1, Math.max(0, x));

function countUp(el: HTMLElement) {
  const to = Number(el.dataset.count);
  if (!Number.isFinite(to)) return;
  const dec = Number(el.dataset.decimals ?? 0);
  const t0 = performance.now();
  const dur = 1500;
  const step = (now: number) => {
    const u = clamp((now - t0) / dur);
    const e = 1 - Math.pow(1 - u, 4);
    el.textContent = (to * e).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    if (u < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The bar takes the colour of what scrolls under it: dark over the dark sections, light over the light ones. */
function navOverDark() {
  const nav = document.querySelector<HTMLElement>(".nav");
  if (!nav) return () => {};
  let raf = 0;
  const check = () => {
    raf = 0;
    const y = nav.getBoundingClientRect().bottom + 2;
    let el = document.elementsFromPoint(innerWidth / 2, y).find((e) => !nav.contains(e)) as HTMLElement | undefined;
    let dark = false;
    for (; el && el !== document.body; el = el.parentElement ?? undefined) {
      const css = getComputedStyle(el).backgroundColor;
      const m = css.match(/[\d.]+/g);
      if (!m) continue;
      // rgb(0-255) or, from color-mix, color(srgb 0-1)
      const k = css.startsWith("color(") ? 255 : 1;
      const [r, g, b, a = "1"] = m;
      if (Number(a) < 0.5) continue;
      dark = k * (0.2126 * Number(r) + 0.7152 * Number(g) + 0.0722 * Number(b)) < 110;
      break;
    }
    nav.classList.toggle("nav-over-dark", dark);
  };
  const ask = () => {
    if (!raf) raf = requestAnimationFrame(check);
  };
  addEventListener("scroll", ask, { passive: true });
  addEventListener("resize", ask);
  check();
  return () => {
    removeEventListener("scroll", ask);
    removeEventListener("resize", ask);
    if (raf) cancelAnimationFrame(raf);
    nav.classList.remove("nav-over-dark");
  };
}

export default function HomeMotion() {
  useEffect(() => navOverDark(), []);
  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.documentElement.classList.add("motion");
    const reveals = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    const counts = Array.from(document.querySelectorAll<HTMLElement>("[data-count]"));
    const scrubs = Array.from(document.querySelectorAll<HTMLElement>("[data-scrub]"));
    if (still) {
      reveals.forEach((el) => el.classList.add("in"));
      scrubs.forEach((el) => el.style.setProperty("--p", el.dataset.scrub === "track" ? "1" : "0.5"));
      return;
    }
    const rio = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), rio.unobserve(e.target))),
      { rootMargin: "0px 0px -10% 0px" },
    );
    reveals.forEach((el) => rio.observe(el));
    const cio = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && (cio.unobserve(e.target), countUp(e.target as HTMLElement))),
      { threshold: 0.6 },
    );
    counts.forEach((el) => {
      el.textContent = "0";
      cio.observe(el);
    });
    let raf = 0;
    const last = new Map<HTMLElement, string>();
    const tick = () => {
      const vh = innerHeight;
      for (const el of scrubs) {
        const r = el.getBoundingClientRect();
        if (r.bottom < -vh || r.top > 2 * vh) continue;
        const p = el.dataset.scrub === "track" ? clamp(-r.top / Math.max(1, r.height - vh)) : clamp((vh - r.top) / (vh + r.height));
        const v = p.toFixed(4);
        if (last.get(el) !== v) {
          last.set(el, v);
          el.style.setProperty("--p", v);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      document.documentElement.classList.remove("motion");
      rio.disconnect();
      cio.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}
