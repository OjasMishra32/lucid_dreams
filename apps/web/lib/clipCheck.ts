// Checks a clip or photo in the browser against "Clips that work" in AGENTS.md, before anything is uploaded.
// Each check says what we measured and, when it falls short, exactly what to fix.

export type Level = "ok" | "warn" | "bad" | "wait"; // wait: still being checked
export interface Check {
  level: Level;
  title: string;
  detail: string;
}
export interface Inspected {
  media: "video" | "photo";
  url: string;
  width: number;
  height: number;
  durationS: number | null;
  readable: boolean;
  checks: Check[];
}

// The pipeline rebuilds 121 frames at 25 fps from where the window starts (startS; pipeline/runner/lucid_runner.py).
export const WINDOW_S = 121 / 25;
const MIN_S = WINDOW_S;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const PHOTO_EXT = /\.(jpe?g|png|webp|heic)$/i;

export function mediaOf(file: File): "video" | "photo" | null {
  if (file.type.startsWith("video/") || VIDEO_EXT.test(file.name)) return "video";
  if (file.type.startsWith("image/") || PHOTO_EXT.test(file.name)) return "photo";
  return null;
}

export async function inspect(file: File): Promise<Inspected> {
  const media = mediaOf(file);
  if (!media) throw new Error("Use a video (MP4, MOV) or a photo (JPG, PNG).");
  const url = URL.createObjectURL(file);
  const meta = media === "video" ? await videoMeta(url) : await photoMeta(url);
  if (!meta) {
    return {
      media, url, width: 0, height: 0, durationS: null, readable: false,
      checks: [{
        level: "warn",
        title: media === "video" ? "We couldn't read this clip here" : "We couldn't preview this photo here",
        detail: media === "video"
          ? "This browser can't decode it, so we can't check it. The GPUs probably can: you can still make the dream."
          : "This browser can't open it (HEIC often does this). Export it as a JPG to check it first, or go ahead anyway.",
      }],
    };
  }
  const checks = media === "video" ? videoChecks(meta) : photoChecks(meta);
  return { media, url, ...meta, readable: true, checks };
}

type Meta = { width: number; height: number; durationS: number | null };

function videoMeta(url: string): Promise<Meta | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const timer = setTimeout(() => resolve(null), 10000);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve(v.videoWidth ? { width: v.videoWidth, height: v.videoHeight, durationS: v.duration } : null);
    };
    v.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    v.src = url;
  });
}

function photoMeta(url: string): Promise<Meta | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, durationS: null });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function videoChecks({ width, height, durationS }: Meta): Check[] {
  const checks: Check[] = [];
  const short = Math.min(width, height);

  if (short >= 2160) {
    checks.push({ level: "ok", title: "4K", detail: `${width} × ${height}. The sharpest result there is.` });
  } else if (short >= 1080) {
    checks.push({ level: "ok", title: `${short}p`, detail: `${width} × ${height}. Works well; 4K comes out sharper still.` });
  } else {
    checks.push({
      level: "bad",
      title: `${short}p is too soft`,
      detail: `${width} × ${height}. Use at least 1080p: every pixel shows up when they stand life size in front of you.`,
    });
  }

  const aspect = width / height;
  if (height > width && Math.abs(aspect - 9 / 16) < 0.03) {
    checks.push({ level: "ok", title: "Portrait 9:16", detail: "Exactly what the pipeline wants." });
  } else if (height > width) {
    checks.push({
      level: "warn",
      title: `Portrait, ${ratio(width, height)}`,
      detail: "The pipeline is tuned for 9:16. Crop to 9:16 around the person for the best result.",
    });
  } else {
    checks.push({ level: "ok", title: "Landscape", detail: "We'll frame them for you." });
  }

  if (durationS != null && Number.isFinite(durationS)) {
    if (durationS < MIN_S) {
      checks.push({
        level: "bad",
        title: `Only ${durationS.toFixed(1)} seconds`,
        detail: "We need at least 5 seconds (121 frames). Record a little longer.",
      });
    } else {
      checks.push({
        level: "ok",
        title: `${durationS.toFixed(1)} seconds`,
        detail: durationS > MIN_S + 0.3 ? "Choose the 5 seconds we rebuild below the preview." : "Just enough. We use all 5 seconds.",
      });
    }
  }
  return checks;
}

function photoChecks({ width, height }: Meta): Check[] {
  const checks: Check[] = [];
  const short = Math.min(width, height);
  if (short >= 1024) {
    checks.push({ level: "ok", title: "Sharp enough", detail: `${width} × ${height}.` });
  } else if (short >= 512) {
    checks.push({ level: "warn", title: "A little soft", detail: `${width} × ${height}. A larger original gives a sharper person.` });
  } else {
    checks.push({ level: "bad", title: "Too small", detail: `${width} × ${height}. Use a photo at least 1024 pixels on its short side.` });
  }
  if (width > height) {
    checks.push({ level: "warn", title: "Landscape", detail: "Crop so the person fills the frame, head to toe." });
  } else {
    checks.push({ level: "ok", title: "Portrait", detail: "The person can fill the frame." });
  }
  return checks;
}

function ratio(w: number, h: number): string {
  const known: [number, number][] = [[9, 16], [3, 4], [2, 3], [4, 5], [1, 1]];
  const hit = known.find(([a, b]) => Math.abs(w / h - a / b) < 0.02);
  return hit ? `${hit[0]}:${hit[1]}` : `${w} × ${h}`;
}

/** A starting name from the file name; camera-style names (IMG_1234) start empty instead. */
export function nameFromFile(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, "");
  if (/^(img|vid|pxl|dsc|mvi|gopr|dji|screen|movie|video)[\s_-]?\d/i.test(base) || /^[\d\s_-]+$/.test(base)) return "";
  const words = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
