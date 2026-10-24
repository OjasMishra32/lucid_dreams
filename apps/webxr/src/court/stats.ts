// The frame log (`?stats`, and the e2e timing pass): per phase, frame intervals, CPU ms of each frame's work and GPU
// ms of each renderer.render (EXT_disjoint_timer_query_webgl2, when the browser has it), as nearest-rank percentiles
// and dropped frames against the display rate. From S6 (court-spikes/s6-quest/spike6/stats.ts, gputimer.ts). On the
// Quest it is read with remote devtools (Q1-Q3); on desktop it is informational only (P15 is a headset number).
// Integrator, T0.

export interface Interval {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  n: number;
}

const round = (v: number, digits = 2) => Number(v.toFixed(digits));

/** Nearest-rank percentiles of a list of milliseconds. */
export function summarize(ms: number[]): Interval {
  if (!ms.length) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0, n: 0 };
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p: number) => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[sorted.length - 1]), mean: round(mean), n: sorted.length };
}

/** Intervals longer than 1.5x the display interval: frames the compositor had to repeat. */
export function dropped(intervals: number[], hz: number): { count: number; pct: number } {
  const limit = (1.5 * 1000) / hz;
  const count = intervals.filter((v) => v > limit).length;
  return { count, pct: intervals.length ? round((100 * count) / intervals.length, 1) : 0 };
}

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

/** GPU time of renderer.render through the disjoint timer query; results come back a few frames later, by tag. */
export class GpuTimer {
  readonly available: boolean;
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  private free: WebGLQuery[] = [];
  private pending: { query: WebGLQuery; tag: string }[] = [];
  private active: { query: WebGLQuery; tag: string } | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    this.available = !!this.ext;
  }

  begin(tag: string): void {
    if (!this.ext || this.active) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { query, tag };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Hands back every finished query as (tag, ms); a disjoint event voids them. */
  poll(done: (tag: string, ms: number) => void): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(p.query);
      if (!disjoint) done(p.tag, ns / 1e6);
    }
    while (this.pending.length > 12) this.free.push(this.pending.shift()!.query);
  }
}

/** Per-phase interval, CPU and GPU lists, summarized on demand. */
export class FrameStats {
  readonly gpu: GpuTimer;
  private readonly hz: number;
  private readonly phases = new Map<string, { intervals: number[]; cpu: number[]; gpu: number[] }>();

  constructor(gl: WebGL2RenderingContext, hz: number) {
    this.gpu = new GpuTimer(gl);
    this.hz = hz;
  }

  private of(phase: string) {
    let p = this.phases.get(phase);
    if (!p) this.phases.set(phase, (p = { intervals: [], cpu: [], gpu: [] }));
    return p;
  }

  /** One frame: its interval since the previous frame and the CPU ms of its work. */
  frame(phase: string, intervalMs: number, cpuMs: number): void {
    const p = this.of(phase);
    if (intervalMs > 0) p.intervals.push(intervalMs);
    p.cpu.push(cpuMs);
    this.gpu.poll((tag, ms) => this.of(tag).gpu.push(ms));
  }

  report(): Record<string, { intervals: Interval; dropped: { count: number; pct: number }; cpu: Interval; gpu: Interval | null }> {
    const out: ReturnType<FrameStats["report"]> = {};
    for (const [phase, p] of this.phases)
      out[phase] = { intervals: summarize(p.intervals), dropped: dropped(p.intervals, this.hz), cpu: summarize(p.cpu), gpu: this.gpu.available ? summarize(p.gpu) : null };
    return out;
  }
}
