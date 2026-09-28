/**
 * Measures GPU time per frame with EXT_disjoint_timer_query_webgl2. Queries resolve a few
 * frames later, so results are read asynchronously from a small pool.
 */
export class GpuTimer {
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private free: WebGLQuery[] = [];
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** Most recent GPU frame time in ms (NaN until the first result arrives). */
  lastMs = NaN;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get available(): boolean {
    return !!this.ext;
  }

  begin(): void {
    if (!this.ext || this.active) return;
    // Collect finished results first; otherwise a full queue would block measuring forever.
    this.poll();
    if (this.pending.length > 6) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  private poll(): void {
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext!.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(q);
      if (!disjoint) this.lastMs = ns / 1e6;
    }
  }
}
