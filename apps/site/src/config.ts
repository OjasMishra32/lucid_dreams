// Everything on the site that changes as real people come back from HiPerGator lives here.

/** "people/curry/%06d.spz" -> ["people/curry/000000.spz", ...], for a replay's frames. */
export function sequence(pattern: string, count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, i) => pattern.replace("%06d", String(start + i).padStart(6, "0")));
}

export interface PersonConfig {
  /** One URL is a still person; several play in order as a replay. Paths are relative to the site root. */
  frames: string[];
  fps: number;
  /** The matching "seen vs imagined" frames (the bundle's frames.reality, %06d.reality.spz), same length as frames. */
  reality: string[] | null;
  /** The bundle's metrics.seenFraction (0-1). Null: estimated from which side the camera faced. */
  seenFraction: number | null;
  /** Shown under the person in the hero. */
  label: string;
}

/** The committed sample: what the page shows when no bridge is reachable (a static host, a USB stick). */
export const SAMPLE: PersonConfig = {
  frames: ["people/synthetic-test.spz"],
  fps: 25,
  reality: null,
  seenFraction: null,
  label: "Sample person",
};

/**
 * Real people come from the bridge (apps/web on the Mac, :5170): it serves every finished dream bundle with open CORS,
 * so the site reads them at runtime and no Gaussian file is ever committed. VITE_BRIDGE_URL overrides the default
 * (this page's host on port 5170, for a page served over plain http on the Mac or its Wi-Fi). A file:// copy or an
 * https host has no bridge to reach, so the sample stands in and the reel stays hidden.
 */
export const BRIDGE_URL: string | null =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined)?.replace(/\/$/, "") ||
  (location.protocol === "http:" && location.hostname ? `http://${location.hostname}:5170` : null);

/** The person in the hero: a real replay, and never a public figure. */
export const HERO_DREAM = "jump-shot";

/** At most this many frames of a replay play in the hero (every other frame of 121): ~285k Gaussians each. */
export const MAX_FRAMES = 61;

/** Never on the public site: public figures, whose footage and photos are for the live demo only. */
export const NOT_ON_SITE = /^(lebron|bobby-fischer|magnus-carlsen|juice-wrld)/;

/** Credits for the real people the reel can show (demo/credits.md). */
export const CREDITS: Record<string, string> = {
  "piano-han": "Jason Han, piano teacher. Wikimedia Commons, CC BY-SA 4.0.",
  "jump-shot": "Clip from Pexels.",
  "jump-shot-2": "Clip from Pexels.",
};

/** The demo film. Empty until it's uploaded; the hero link stays quiet until then. */
export const DEMO_URL = "";

export const REPO_URL = "https://github.com/OjasMishra32/lucid_dreams";

/** The chess set in the Play section (Poly Haven, CC0; see public/assets/CREDITS.md). */
export const CHESS_SET_URL = "assets/chess_set.glb";
