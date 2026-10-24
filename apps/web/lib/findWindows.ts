// The old footage picker: the best 5-second stretches of a long clip (a film, an hour of home video) for a replay,
// found in the browser before anything is uploaded. Same rules and weights as pipeline/lucid/find_windows.py (one
// person in every sample, tall in the frame, feet inside it, no cut or pan), with MediaPipe's pose model instead of
// YOLO, so it also knows where the feet and head are rather than guessing from a box.

import { landmarker, look, type Look } from "./personCheck";

export interface FoundWindow {
  startS: number;
  endS: number;
  score: number;
  thumb: string; // a frame from the middle, as a small JPEG
}

const SECONDS = 5.2; // find_windows' default: a replay is 121 frames at 25 fps, plus a little slack
const MAX_SAMPLES = 600;

/**
 * The best non-overlapping windows, best first; [] when nothing qualifies, null when the pose model can't load.
 * Calls onProgress(0-1) as it samples; stops early (resolving null) when the signal aborts.
 */
export async function findWindows(
  url: string,
  durationS: number,
  opts: { top?: number; onProgress?: (p: number) => void; signal?: AbortSignal } = {},
): Promise<FoundWindow[] | null> {
  let model;
  try {
    model = await landmarker();
  } catch {
    return null;
  }
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = url;
  try {
    await once(v, "loadeddata");
    // a few samples a second for short clips, sparser for an hour of film (still 3+ per window)
    const every = Math.min(1.7, Math.max(0.4, durationS / MAX_SAMPLES));
    const times: number[] = [];
    for (let t = 0; t < durationS - 0.05; t += every) times.push(t);
    const looks: Look[] = [];
    for (let i = 0; i < times.length; i++) {
      if (opts.signal?.aborted) return null;
      v.currentTime = times[i];
      await once(v, "seeked");
      looks.push(look(model, v));
      if (i % 4 === 0) opts.onProgress?.(i / times.length);
    }
    opts.onProgress?.(1);

    const aspect = v.videoWidth / Math.max(v.videoHeight, 1);
    const best = score(times, looks, aspect, every).slice(0, opts.top ?? 5);
    for (const w of best) {
      if (opts.signal?.aborted) return null;
      v.currentTime = (w.startS + w.endS) / 2;
      await once(v, "seeked");
      w.thumb = snapshot(v);
    }
    return best;
  } catch {
    return null; // a file this browser can't decode: the other checks already say so
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

function score(times: number[], looks: Look[], aspect: number, every: number): FoundWindow[] {
  const perStep = 0.4 / every; // find_windows samples every 0.4 s: judge movement at that pace, however sparse we sample
  const out: FoundWindow[] = [];
  for (let i = 0; i < times.length; i++) {
    const t0 = times[i];
    let j = i;
    while (j < times.length && times[j] < t0 + SECONDS) j++;
    if (j >= times.length || times[j - 1] - t0 < SECONDS * 0.75) break;
    const win = looks.slice(i, j);
    if (win.some((l) => l.people !== 1)) continue; // exactly one person, every sample
    const heights = win.map((l) => l.height);
    const feetIn = win.filter((l) => l.feet).length / win.length;
    const jumps = win.slice(1).map((l, k) => {
      const dx = (l.centre[0] - win[k].centre[0]) * aspect; // in frame heights, like find_windows
      const dy = l.centre[1] - win[k].centre[1];
      return Math.hypot(dx, dy) * perStep;
    });
    // nose to heel is about 0.88 of a person's height, so 0.4 here is find_windows' 0.45 on a full-body box
    if (Math.min(...heights) < 0.4 || feetIn < 0.8 || (jumps.length && Math.max(...jumps) > 0.25)) continue;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
    const s = mean(heights) * 0.6 + mean(win.map((l) => l.confidence)) * 0.25 + feetIn * 0.15 - (jumps.length ? mean(jumps) : 0);
    out.push({ startS: Math.round(t0 * 100) / 100, endS: Math.round((t0 + SECONDS) * 100) / 100, score: s, thumb: "" });
  }
  out.sort((a, b) => b.score - a.score);
  const picked: FoundWindow[] = [];
  for (const w of out) if (picked.every((p) => w.endS <= p.startS || w.startS >= p.endS)) picked.push(w); // never overlapping
  return picked;
}

function snapshot(v: HTMLVideoElement): string {
  const h = 160;
  const w = Math.max(1, Math.round((h * v.videoWidth) / Math.max(v.videoHeight, 1)));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(v, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.75);
}

function once(el: HTMLElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 8000);
    el.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
  });
}
