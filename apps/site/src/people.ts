import { BRIDGE_URLS, HERO_DREAM, NOT_ON_SITE, SAMPLE, type PersonConfig } from "./config";

// The real person in the live 3D scenes, from the bridge's library (GET /api/dreams: finished, unheld bundles only).

export interface Bundle {
  id: string;
  name: string;
  kind: "replay" | "avatar";
  fps: number;
  frameCount: number;
  frames: { dir: string; spz?: string; reality?: string | null; gaussiansPerFrame?: number } | null;
  private?: boolean;
  metrics?: { psnr?: number | null; seenFraction?: number | null } | null;
}

let listing: Promise<Bundle[]> | null = null;
/** The bridge that answered, so a bundle's files come from the same place. */
let bridge = "";

async function ask(base: string): Promise<Bundle[] | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5000);
  try {
    const r = await fetch(`${base}/api/dreams`, { signal: stop.signal });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    const list = (await r.json()) as Bundle[];
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Every finished dream the bridge has, or none when it can't be reached within a few seconds. */
export function dreams(): Promise<Bundle[]> {
  listing ??= (async () => {
    for (const base of BRIDGE_URLS) {
      const list = await ask(base);
      if (list) {
        bridge = base;
        return list;
      }
    }
    return [];
  })();
  return listing;
}

/** Shown on the public site: never a public figure, a family's private dream or a test bundle. */
export const onSite = (d: Bundle) => !d.private && !NOT_ON_SITE.test(d.id) && !/^(synthetic|test)/.test(d.id);

const file = (d: Bundle, path: string) => `${bridge}/dreams/${encodeURIComponent(d.id)}/${path}`;

let person: Promise<PersonConfig> | null = null;

/** One frame of the hero's replay (with its reality-check twin), or the committed sample without a bridge. */
export function livePerson(): Promise<PersonConfig> {
  person ??= (async () => {
    const d = (await dreams()).find((x) => x.id === HERO_DREAM);
    if (!d || !onSite(d) || d.kind !== "replay" || !d.frames?.spz) return SAMPLE;
    const f = d.frames;
    const at = (pattern: string) => file(d, `${f.dir}/${pattern.replace("%06d", "000000")}`);
    return {
      frames: [at(f.spz!)],
      fps: d.fps || 25,
      reality: f.reality ? [at(f.reality)] : null,
      seenFraction: d.metrics?.seenFraction ?? null,
      gaussians: f.gaussiansPerFrame ?? null,
      label: d.name,
    };
  })();
  return person;
}
