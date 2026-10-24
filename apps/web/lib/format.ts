import { formatCount, heightM, type Dream } from "./dream";

export function dreamMeta(d: Dream): string {
  const h = heightM(d);
  return [
    d.durationS ? `${d.durationS.toFixed(1)} s` : "",
    h ? `${h.toFixed(2)} m tall` : "",
    d.frames?.gaussiansPerFrame ? `${formatCount(d.frames.gaussiansPerFrame)} Gaussians` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function seenPercent(d: Dream): number | null {
  const s = d.metrics?.seenFraction;
  return typeof s === "number" && s > 0 ? Math.round(s * 100) : null;
}

/** "42 s", "6 min 12 s", "1 h 05 min": how long a stage took, for people. */
export function formatDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return "";
  const t = Math.round(s);
  if (t < 60) return `${t} s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m} min ${String(t % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function formatDate(iso?: string): string {
  const t = Date.parse(iso ?? "");
  if (!t) return "";
  return new Date(t).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}
