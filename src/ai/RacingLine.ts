import type { TrackGeometry } from '../track/TrackGeometry';

export interface RacingLineOptions {
  /** Distance kept from the road edge (m). */
  edgeMargin: number;
  /** Sustainable lateral acceleration (m/s^2). */
  lateralAccel: number;
  /** Braking deceleration used for planning (m/s^2). */
  brakeDecel: number;
  topSpeed: number;
}

/**
 * Computes a racing line as lateral offsets from the centreline by iteratively relaxing
 * points toward the midpoint of their neighbours (which minimises curvature — i.e. it
 * uses the full road width: outside on entry, apex on the inside, outside on exit).
 * A speed profile is then derived from the line's curvature with a backward pass for
 * braking zones.
 */
export class RacingLine {
  /** Lateral offset per track sample. */
  readonly offset: Float32Array;
  /** Target speed per track sample (m/s). */
  readonly speed: Float32Array;
  /** Curvature of the racing line per sample (1/m, unsigned). */
  readonly curvature: Float32Array;

  constructor(readonly track: TrackGeometry, readonly opts: RacingLineOptions) {
    const n = track.count;
    this.offset = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.curvature = new Float32Array(n);

    // Work on a coarse subset of points for speed and smoothness.
    const stride = 4;
    const m = Math.floor(n / stride);
    const off = new Float32Array(m);
    const cx = new Float32Array(m);
    const cz = new Float32Array(m);
    const rx = new Float32Array(m);
    const rz = new Float32Array(m);
    for (let k = 0; k < m; k++) {
      const i = k * stride;
      cx[k] = track.pos[i * 3];
      cz[k] = track.pos[i * 3 + 2];
      rx[k] = track.right[i * 2];
      rz[k] = track.right[i * 2 + 1];
    }
    const limit = track.halfWidth - opts.edgeMargin;
    const px = new Float32Array(m);
    const pz = new Float32Array(m);
    const spans = [6, 4, 3, 2, 1];
    for (const span of spans) {
      for (let iter = 0; iter < 220; iter++) {
        for (let k = 0; k < m; k++) {
          px[k] = cx[k] + rx[k] * off[k];
          pz[k] = cz[k] + rz[k] * off[k];
        }
        for (let k = 0; k < m; k++) {
          const a = (k - span + m) % m;
          const b = (k + span) % m;
          const mx = (px[a] + px[b]) / 2;
          const mz = (pz[a] + pz[b]) / 2;
          const target = (mx - cx[k]) * rx[k] + (mz - cz[k]) * rz[k];
          let o = off[k] + (target - off[k]) * 0.5;
          if (o > limit) o = limit;
          else if (o < -limit) o = -limit;
          off[k] = o;
        }
      }
    }
    // Smooth once more and upsample to every sample.
    const sm = new Float32Array(m);
    for (let k = 0; k < m; k++) sm[k] = (off[(k - 1 + m) % m] + off[k] * 2 + off[(k + 1) % m]) / 4;
    for (let i = 0; i < n; i++) {
      const f = i / stride;
      const k0 = Math.floor(f) % m;
      const k1 = (k0 + 1) % m;
      const t = f - Math.floor(f);
      this.offset[i] = sm[k0] + (sm[k1] - sm[k0]) * t;
    }

    // Curvature of the racing line from circumradius of points ~12 m apart.
    const gap = Math.max(2, Math.round(12 / track.spacing));
    const X = (i: number) => track.pos[i * 3] + track.right[i * 2] * this.offset[i];
    const Z = (i: number) => track.pos[i * 3 + 2] + track.right[i * 2 + 1] * this.offset[i];
    for (let i = 0; i < n; i++) {
      const a = (i - gap + n) % n;
      const b = (i + gap) % n;
      const ax = X(a), az = Z(a), bx = X(i), bz = Z(i), qx = X(b), qz = Z(b);
      const ab = Math.hypot(bx - ax, bz - az);
      const bc = Math.hypot(qx - bx, qz - bz);
      const ca = Math.hypot(qx - ax, qz - az);
      const cross = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
      const area2 = Math.abs(cross);
      this.curvature[i] = ab * bc * ca > 1e-6 ? (2 * area2) / (ab * bc * ca) : 0;
    }
    // Light smoothing of curvature to avoid spiky speed targets.
    const tmp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -4; k <= 4; k++) acc += this.curvature[(i + k + n) % n];
      tmp[i] = acc / 9;
    }
    this.curvature.set(tmp);

    this.computeSpeeds();
  }

  private computeSpeeds(): void {
    const { track, opts } = this;
    const n = track.count;
    for (let i = 0; i < n; i++) {
      const k = Math.max(this.curvature[i], 1e-5);
      this.speed[i] = Math.min(opts.topSpeed, Math.sqrt(opts.lateralAccel / k));
    }
    // Backward pass: the car must be able to brake down to the next corner speed.
    const ds = track.spacing;
    for (let pass = 0; pass < 2; pass++) {
      for (let c = n * 2; c >= 0; c--) {
        const i = c % n;
        const next = (i + 1) % n;
        const vmax = Math.sqrt(this.speed[next] ** 2 + 2 * opts.brakeDecel * ds);
        if (this.speed[i] > vmax) this.speed[i] = vmax;
      }
    }
  }

  offsetAt(s: number): number {
    const t = this.track;
    const f = t.wrapS(s) / t.spacing;
    const i = Math.floor(f) % t.count;
    const j = (i + 1) % t.count;
    const u = f - Math.floor(f);
    return this.offset[i] + (this.offset[j] - this.offset[i]) * u;
  }

  speedAt(s: number): number {
    const t = this.track;
    return this.speed[t.indexAt(s)];
  }
}
