// Everything on the site that changes as real people come back from HiPerGator lives here.

export interface PersonConfig {
  /** One URL is a still person; several play in order as a replay. */
  frames: string[];
  fps: number;
  /** The matching "seen vs imagined" frames (the bundle's frames.reality, %06d.reality.spz), same length as frames. */
  reality: string[] | null;
  /** The bundle's metrics.seenFraction (0-1). Null: estimated from which side the camera faced. */
  seenFraction: number | null;
  /** Gaussians in the first frame, when the bundle says (frames.gaussiansPerFrame). */
  gaussians: number | null;
  label: string;
}

/** The committed sample: what the live 3D shows when no bridge is reachable (a static host, a USB stick). */
export const SAMPLE: PersonConfig = {
  frames: ["people/synthetic-test.spz"],
  fps: 25,
  reality: null,
  seenFraction: null,
  gaussians: null,
  label: "Sample person",
};

/**
 * Real people come from the bridge (apps/web on the Mac, :5170). The site's own server proxies /api and /dreams to it
 * (vite.config.ts, dev and preview), so the page asks its own origin first, then the bridge directly on this host's
 * port 5170 (it sends open CORS). VITE_BRIDGE_URL names one explicitly. A file:// copy has no bridge: the sample
 * stands in.
 */
export const BRIDGE_URLS: string[] = (import.meta.env.VITE_BRIDGE_URL as string | undefined)
  ? [(import.meta.env.VITE_BRIDGE_URL as string).replace(/\/$/, "")]
  : location.protocol.startsWith("http")
    ? [location.origin, ...(location.protocol === "http:" ? [`http://${location.hostname}:5170`] : [])]
    : [];

/** The person in the live 3D scenes: a real replay, never a public figure. */
export const HERO_DREAM = "dance-01";

/** Never on the public site: public figures (their footage and photos are for the live demo only) and family dreams. */
export const NOT_ON_SITE = /^(lebron|bobby|magnus|juice-wrld)/;

export const REPO_URL = "https://github.com/OjasMishra32/lucid_dreams";
