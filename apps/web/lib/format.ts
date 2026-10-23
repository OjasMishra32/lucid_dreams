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

export function formatDate(iso?: string): string {
  const t = Date.parse(iso ?? "");
  if (!t) return "";
  return new Date(t).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}
