import { BRIDGE_URL, HERO_DREAM, MAX_FRAMES, NOT_ON_SITE, SAMPLE, type PersonConfig } from "./config";

// The real people on the page, from the bridge's library (GET /api/dreams: finished bundles only, nothing held back).

export interface Bundle {
  id: string;
  name: string;
  kind: "replay" | "avatar";
  fps: number;
  frameCount: number;
  frames: { dir: string; spz?: string; reality?: string | null } | null;
  preview: string | null;
  thumb: string | null;
  intent?: string | null;
  private?: boolean;
  metrics?: { psnr?: number | null; seenFraction?: number | null } | null;
  createdAt?: string;
}

let listing: Promise<Bundle[]> | null = null;

/** Every finished dream the bridge has, or none when it can't be reached within a few seconds. */
export function dreams(): Promise<Bundle[]> {
  listing ??= (async () => {
    if (!BRIDGE_URL) return [];
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 4000);
    try {
      const r = await fetch(`${BRIDGE_URL}/api/dreams`, { signal: stop.signal });
      const list = r.ok ? ((await r.json()) as Bundle[]) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  })();
  return listing;
}

/** A file in a dream's bundle, on the bridge. */
export function bundleFile(d: Bundle, file: string): string {
  return `${BRIDGE_URL}/dreams/${encodeURIComponent(d.id)}/${file}`;
}

/** Shown on the public site: real, public people with a preview, never a public figure or a family's private dream. */
export function onSite(d: Bundle): boolean {
  return !d.private && !NOT_ON_SITE.test(d.id) && !/^(synthetic|test)/.test(d.id) && !!d.preview;
}

let hero: Promise<{ moving: PersonConfig; still: PersonConfig }> | null = null;

/**
 * The hero's person: the real replay when the bridge has it, else the committed sample. `moving` plays up to
 * MAX_FRAMES of its frames (every other one of a 121-frame replay); `still` is its first frame alone, for phones and
 * for the sections further down that turn a person in place.
 */
export function heroPerson(): Promise<{ moving: PersonConfig; still: PersonConfig }> {
  hero ??= (async () => {
    const d = (await dreams()).find((x) => x.id === HERO_DREAM);
    if (!d || !onSite(d) || d.kind !== "replay" || !d.frames?.spz || !(d.frameCount > 0)) return { moving: SAMPLE, still: SAMPLE };
    const stride = Math.max(1, Math.ceil(d.frameCount / MAX_FRAMES));
    const picks = Array.from({ length: Math.ceil(d.frameCount / stride) }, (_, i) => i * stride);
    const frame = (pattern: string, i: number) => bundleFile(d, `${d.frames!.dir}/${pattern.replace("%06d", String(i).padStart(6, "0"))}`);
    const reality = d.frames.reality ? picks.map((i) => frame(d.frames!.reality!, i)) : null;
    const moving: PersonConfig = {
      frames: picks.map((i) => frame(d.frames!.spz!, i)),
      fps: (d.fps || 25) / stride,
      reality,
      seenFraction: d.metrics?.seenFraction ?? null,
      label: d.name,
    };
    return { moving, still: { ...moving, frames: moving.frames.slice(0, 1), reality: reality?.slice(0, 1) ?? null } };
  })();
  return hero;
}

/** Phones and small-memory devices hold one frame of a person, not a whole replay. */
export const holdsReplay = () => !matchMedia("(max-width: 760px)").matches && ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) >= 4;
