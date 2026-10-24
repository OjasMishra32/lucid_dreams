export type Interval = { p50: number; p95: number; p99: number; max: number; mean: number };

const round = (v: number, digits = 2) => Number(v.toFixed(digits));

/** Nearest-rank percentiles of frame intervals (ms). */
export function summarize(intervals: number[]): Interval {
  if (!intervals.length) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (p: number) => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[sorted.length - 1]), mean: round(mean) };
}

/** Intervals longer than 1.5x the target interval: the frames the compositor had to repeat. */
export function dropped(intervals: number[], targetHz: number) {
  const limitMs = (1.5 * 1000) / targetHz;
  const count = intervals.filter((v) => v > limitMs).length;
  return { count, pct: intervals.length ? round((100 * count) / intervals.length, 1) : 0, limitMs: round(limitMs) };
}

/** The display rates a Quest runs at; used only when the session does not report its rate. */
export function snapRate(medianMs: number): number {
  const hz = 1000 / medianMs;
  return [60, 72, 80, 90, 120].reduce((best, r) => (Math.abs(r - hz) < Math.abs(best - hz) ? r : best));
}

export function heapMB(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? round(memory.usedJSHeapSize / 1e6, 1) : null;
}
