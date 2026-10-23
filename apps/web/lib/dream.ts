// The shared contracts from AGENTS.md: the dream bundle and the job API. Safe to import on server and client.

export type Vec3 = [number, number, number];

export interface Dream {
  id: string;
  name: string;
  kind: "replay" | "avatar";
  fps: number;
  frameCount: number;
  durationS: number;
  units: "meters";
  upAxis: "+Y";
  bounds: { min: Vec3; max: Vec3 } | null;
  frames: {
    dir: string;
    pattern: string;
    spz?: string;
    reality?: string | null;
    gaussiansPerFrame?: number;
    spzBytesTotal?: number;
  } | null;
  avatar: { file: string; rig: string; motion: string } | null;
  audio: string | null;
  preview: string | null;
  thumb: string | null;
  source?: { clip: string; width: number; height: number } | null;
  metrics?: {
    psnr: number | null;
    ssim: number | null;
    lpips: number | null;
    views: number | null;
    seenFraction?: number | null;
  } | null;
  createdAt?: string;
}

export type JobKind = "replay" | "avatar";
export type JobState = "queued" | "running" | "done" | "failed";
export type Stage = "upload" | "check" | "views" | "upscale" | "reconstruct" | "export";

export const STAGES: Stage[] = ["upload", "check", "views", "upscale", "reconstruct", "export"];

/** GET /api/jobs/:id */
export interface JobStatus {
  id: string;
  status: JobState;
  stage: Stage;
  progress: number;
  etaS: number | null;
  message: string;
}

/** How each stage reads to people. Upscale only shows while the pipeline actually runs it. */
export const STAGE_LABELS: Record<Stage, string> = {
  upload: "Upload",
  check: "Check the clip",
  views: "Imagine every angle",
  upscale: "Sharpen every view",
  reconstruct: "Build them in 3D",
  export: "Get them ready",
};

export function dreamFile(id: string, file: string): string {
  return `/dreams/${encodeURIComponent(id)}/${file}`;
}

export function heightM(d: Dream): number | null {
  if (!d.bounds) return null;
  const h = d.bounds.max[1] - d.bounds.min[1];
  return h > 0.3 && h < 3 ? h : null;
}

export function formatCount(n?: number | null): string {
  if (!n) return "";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`;
}

export function formatEta(s: number | null | undefined): string {
  if (s == null) return "";
  if (s < 45) return "Less than a minute left";
  const m = Math.round(s / 60);
  if (m < 60) return `About ${m} minute${m === 1 ? "" : "s"} left`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `About ${h} h ${rest} min left`;
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "dream"
  );
}
