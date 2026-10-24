// The dream bundle contract (AGENTS.md, "Dream bundle").

export interface Dream {
  id: string;
  name: string;
  kind: "replay" | "avatar";
  fps: number;
  frameCount: number;
  durationS: number;
  units: "meters";
  upAxis: "+Y";
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  frames: { dir: string; pattern: string; spz?: string; reality?: string | null; gaussiansPerFrame?: number; spzBytesTotal?: number } | null;
  avatar: { file: string; rig: string; motion: string; skin?: string; skeleton?: string; reality?: string } | null;
  audio: string | null;
  voice?: string | null; // the speaking voice, separated from background noise and music
  captions?: string | null; // WebVTT of what the person says, in the clip's own time
  intent?: string | null; // what the user wants to do with this person ("teach me this strum")
  talk?: { who: string } | null; // they can be talked to (apps/talk; their own consent, their cloned voice)
  experience?: string | null; // experience.json: the plan written from the intent
  createdAt?: string;
  updatedAt?: string; // set when a bundle is changed in place (recoloured, re-exported)
  props?: string | null; // props.json: the objects around the person (a ball and its track, a hoop)
  joints?: string | null; // joints.json: the clip's body joints per frame, in bundle space (Follow along)
  beats?: string | null; // beats.json: the clip's beat ({ bpm, times }, clip seconds), for the floor pulse
  preview: string | null;
  thumb: string | null;
  metrics?: { psnr: number | null; ssim: number | null; lpips: number | null; views: number | null; seenFraction?: number | null };
}

export const DREAMS_BASE = new URLSearchParams(location.search).get("base") ?? "/dreams";

export function dreamUrl(id: string, file: string): string {
  return `${DREAMS_BASE}/${encodeURIComponent(id)}/${file}`;
}

export function framePath(d: Dream, i: number, reality = false): string {
  const pattern = (reality ? d.frames?.reality : null) ?? d.frames?.spz ?? d.frames?.pattern ?? "%06d.spz";
  const name = pattern.replace(/%0(\d+)d/, (_, w) => String(i).padStart(Number(w), "0"));
  return `${d.frames?.dir ?? "frames"}/${name}`;
}

export async function listDreams(): Promise<Dream[]> {
  const r = await fetch(`${DREAMS_BASE}/index.json`, { cache: "no-store" });
  if (!r.ok) return [];
  return r.json();
}

export async function loadDream(id: string): Promise<Dream> {
  const r = await fetch(dreamUrl(id, "dream.json"), { cache: "no-store" });
  if (!r.ok) throw new Error(`No dream called ${id}`);
  return r.json();
}

export function formatCount(n?: number): string {
  if (!n) return "";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`;
}
