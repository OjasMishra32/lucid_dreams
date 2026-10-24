// GPU time of each frame's renderer.render (both eyes) through EXT_disjoint_timer_query_webgl2, when the browser exposes
// it. Results arrive a few frames later and are handed back with the tag they were issued under. Spark's own sort
// readback and splat generation run outside render (after the frame) and are not in this number.

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export class GpuTimer {
  readonly available: boolean;
  disjoint = 0;
  dropped = 0;
  private ext: TimerExt | null;
  private free: WebGLQuery[] = [];
  private pending: { query: WebGLQuery; tag: number }[] = [];
  private active: { query: WebGLQuery; tag: number } | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    this.available = !!this.ext;
  }

  begin(tag: number) {
    if (!this.ext || this.active) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { query, tag };
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Hands back every finished query as (tag, ms); a disjoint event (GPU reset, clock change) voids them. */
  poll(done: (tag: number, ms: number) => void) {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(p.query);
      if (disjoint) this.disjoint++;
      else done(p.tag, ns / 1e6);
    }
    // results that never come back (a lost frame) must not pile up
    while (this.pending.length > 12) {
      this.free.push(this.pending.shift()!.query);
      this.dropped++;
    }
  }
}
