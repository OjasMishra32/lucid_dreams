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

export const PERSON: PersonConfig = {
  frames: ["people/synthetic-test.spz"], // swap this line for a real person, e.g. sequence("people/<id>/%06d.spz", 121)
  fps: 25,
  reality: null,
  seenFraction: null,
  label: "Sample person",
};

/** The demo film. Empty until it's uploaded; the hero link stays quiet until then. */
export const DEMO_URL = "";

export const REPO_URL = "https://github.com/OjasMishra32/lucid_dreams";

/** The chess set in the Play section (Poly Haven, CC0; see public/assets/CREDITS.md). */
export const CHESS_SET_URL = "assets/chess_set.glb";
